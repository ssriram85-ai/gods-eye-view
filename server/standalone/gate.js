/**
 * Login gate for a hosted GEV. Off unless GEV_GATE_PASSWORD (or
 * GEV_GATE_USERS) is set, so a laptop checkout behaves as before. Install
 * first: every request except the login page needs a signed session cookie,
 * or a bearer token for machines (the alert service pulling feeds).
 *
 *   GEV_GATE_PASSWORD   one shared password (the simplest setup)
 *   GEV_GATE_USERS      "alice:pw1,bob:pw2" — named logins, revocable one at a time
 *   GEV_GATE_SECRET     cookie signing key; derived from the passwords when unset
 *   GEV_GATE_DAYS       session length in days (30)
 *   GEV_GATE_REQUIRED   "1" on a hosted copy: refuse every request with 503
 *                       until a password is configured, instead of serving
 *                       the map open to the internet
 *
 * The gate never stores passwords hashed in a file; they live in the host's
 * environment, which is the only place a self-hoster edits anyway.
 */
import {
  createHmac,
  createHash,
  timingSafeEqual,
  randomBytes,
} from 'node:crypto';

const COOKIE = 'gev_session';
const LOGIN_PATH = '/gate/login';
const LOGOUT_PATH = '/gate/logout';
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Parse the user table from the environment: a shared password, named users, or both. */
export function parseGateUsers(env = process.env) {
  const users = new Map();
  const shared = String(env.GEV_GATE_PASSWORD || '').trim();
  if (shared) users.set('', shared);
  for (const pair of String(env.GEV_GATE_USERS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim().toLowerCase(),
      password = pair.slice(i + 1).trim();
    if (name && password) users.set(name, password);
  }
  return users;
}

export function createGate({ env = process.env, now = () => Date.now() } = {}) {
  const users = parseGateUsers(env);
  if (!users.size) {
    if (!/^(1|true|yes)$/i.test(String(env.GEV_GATE_REQUIRED || '').trim()))
      return null;
    // Hosted and unconfigured: fail closed rather than open.
    return {
      users: [],
      required: true,
      async middleware(_req, res) {
        res.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'Retry-After': '600',
        });
        res.end(
          "This God's Eye View is not open yet: its operator has not set a login password (GEV_GATE_PASSWORD).",
        );
      },
    };
  }
  const secret =
    String(env.GEV_GATE_SECRET || '').trim() ||
    createHash('sha256')
      .update(['gev-gate', ...[...users.entries()].flat()].join('\u0000'))
      .digest('hex');
  const days = Math.min(365, Math.max(1, Number(env.GEV_GATE_DAYS) || 30));
  const failures = new Map(); // ip -> [timestamps]

  const sign = (payload) =>
    createHmac('sha256', secret).update(payload).digest('base64url');
  const issue = (name) => {
    const exp = now() + days * 86_400_000;
    const payload = `${Buffer.from(name).toString('base64url')}.${exp}.${randomBytes(6).toString('base64url')}`;
    return `${payload}.${sign(payload)}`;
  };
  const verify = (token) => {
    const parts = String(token || '').split('.');
    if (parts.length !== 4) return null;
    const payload = parts.slice(0, 3).join('.');
    if (!safeEqual(sign(payload), parts[3])) return null;
    const exp = Number(parts[1]);
    if (!Number.isFinite(exp) || exp < now()) return null;
    return {
      name: Buffer.from(parts[0], 'base64url').toString() || 'shared',
      exp,
    };
  };
  const cookieOf = (req) => {
    const m = String(req.headers.cookie || '').match(
      new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`),
    );
    return m ? m[1] : null;
  };
  const bearerOf = (req) => {
    const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''));
    return m ? m[1].trim() : null;
  };
  const ipOf = (req) =>
    String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() ||
    req.socket?.remoteAddress ||
    '?';
  const secure = (req) =>
    req.socket?.encrypted ||
    String(req.headers['x-forwarded-proto'] || '').startsWith('https');

  const tooManyFailures = (ip) => {
    const recent = (failures.get(ip) || []).filter(
      (t) => now() - t < FAILURE_WINDOW_MS,
    );
    failures.set(ip, recent);
    return recent.length >= MAX_FAILURES;
  };
  const recordFailure = (ip) =>
    failures.set(ip, [...(failures.get(ip) || []), now()]);

  /** Does this password belong to any login? Returns the login name or null. */
  const authenticate = (name, password) => {
    const key = String(name || '')
      .trim()
      .toLowerCase();
    if (key)
      return users.has(key) && safeEqual(users.get(key), password) ? key : null;
    // No name typed: the shared password, or any named user's (a convenience for a single-user gate).
    for (const [n, p] of users)
      if (safeEqual(p, password)) return n || 'shared';
    return null;
  };

  const loginPage = ({
    next = '/',
    error = '',
    named = users.size > 1 || !users.has(''),
  }) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>God's Eye View · sign in</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
form{width:min(92vw,340px);background:#121821;border:1px solid #1f2a38;border-radius:10px;padding:22px}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 14px;color:#9aa4b2}
label{display:block;font-size:13px;color:#9aa4b2;margin:10px 0 4px}input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:6px;border:1px solid #2a3646;background:#0b0f14;color:#e6edf3;font-size:15px}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:6px;background:#52d4ff;color:#03202b;font-weight:600;font-size:15px}.err{color:#ff7a8a;margin:10px 0 0}</style></head>
<body><form method="post" action="${LOGIN_PATH}"><h1>God's Eye View</h1><p>This map is private. Sign in to continue.</p>
<input type="hidden" name="next" value="${esc(next)}">
${named ? `<label>Name</label><input name="name" autocomplete="username" autocapitalize="none">` : ''}
<label>Password</label><input type="password" name="password" autocomplete="current-password" autofocus>
${error ? `<p class="err">${esc(error)}</p>` : ''}<button>Sign in</button></form></body></html>`;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  };
  const setCookie = (req, value, maxAge) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;
  const safeNext = (value) =>
    /^\/(?!\/)[^\s]*$/.test(String(value || '')) ? String(value) : '/';

  async function readForm(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) throw new Error('form too large');
    }
    return Object.fromEntries(new URLSearchParams(body));
  }

  /** Connect-style middleware. */
  async function middleware(req, res, next) {
    const url = new URL(req.url, 'http://gate');
    if (url.pathname === LOGIN_PATH) {
      if (req.method === 'GET')
        return send(
          res,
          200,
          loginPage({ next: safeNext(url.searchParams.get('next')) }),
        );
      if (req.method !== 'POST') return send(res, 405, 'method not allowed');
      const ip = ipOf(req);
      if (tooManyFailures(ip))
        return send(
          res,
          429,
          loginPage({
            error: 'Too many attempts. Try again in fifteen minutes.',
          }),
        );
      let form;
      try {
        form = await readForm(req);
      } catch {
        return send(res, 400, loginPage({ error: 'Bad request.' }));
      }
      const who = authenticate(form.name, form.password || '');
      if (!who) {
        recordFailure(ip);
        return send(
          res,
          401,
          loginPage({
            next: safeNext(form.next),
            error: 'That password is not right.',
          }),
        );
      }
      console.log(`[gate] ${who} signed in from ${ip}`);
      return send(res, 303, '', {
        'Set-Cookie': setCookie(
          req,
          issue(who === 'shared' ? '' : who),
          days * 86_400,
        ),
        Location: safeNext(form.next),
      });
    }
    if (url.pathname === LOGOUT_PATH)
      return send(res, 303, '', {
        'Set-Cookie': setCookie(req, '', 0),
        Location: LOGIN_PATH,
      });

    const bearer = bearerOf(req);
    if (bearer && authenticate('', bearer)) return next();
    if (verify(cookieOf(req))) return next();

    const wantsHtml =
      req.method === 'GET' &&
      /text\/html/.test(String(req.headers.accept || ''));
    if (wantsHtml)
      return send(res, 303, '', {
        Location: `${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`,
      });
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'sign in required', login: LOGIN_PATH }));
  }

  return {
    middleware,
    issue,
    verify,
    authenticate,
    users: [...users.keys()].map((n) => n || 'shared'),
  };
}

/** Vite plugin: gate every request on the dev and preview servers when configured. Install first. */
export function gatePlugin(options = {}) {
  const install = (server) => {
    const gate = createGate(options);
    if (!gate) return;
    console.log(
      `[gate] login required · ${gate.users.length} login(s): ${gate.users.join(', ')}`,
    );
    server.middlewares.use((req, res, next) => {
      gate.middleware(req, res, next).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`gate error: ${error.message}`);
      });
    });
  };
  return {
    name: 'gev-gate',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
  };
}
