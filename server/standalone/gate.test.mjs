import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, parseGateUsers } from './gate.js';

const req = ({ method = 'GET', url = '/', headers = {}, body = '' } = {}) => {
  const r = { method, url, headers, socket: { remoteAddress: '10.0.0.1' } };
  r[Symbol.asyncIterator] = async function* () {
    if (body) yield body;
  };
  return r;
};
const res = () => {
  const r = { status: 0, headers: {}, body: '' };
  r.writeHead = (s, h) => ((r.status = s), (r.headers = h || {}));
  r.end = (b) => (r.body += b || '');
  return r;
};
const run = async (gate, request) => {
  const response = res();
  let passed = false;
  await gate.middleware(request, response, () => (passed = true));
  return { response, passed };
};
const cookieFrom = (response) => response.headers['Set-Cookie'].split(';')[0];

test('gate is off without any password', () => {
  assert.equal(createGate({ env: {} }), null);
  assert.deepEqual([...parseGateUsers({ GEV_GATE_USERS: 'Alice:pw1, bob:pw2,bad' }).keys()], ['alice', 'bob']);
});

test('anonymous browser is sent to the login page; API calls get 401 JSON', async () => {
  const gate = createGate({ env: { GEV_GATE_PASSWORD: 'open-sesame' } });
  const html = await run(gate, req({ url: '/?x=1', headers: { accept: 'text/html,*/*' } }));
  assert.equal(html.passed, false);
  assert.equal(html.response.status, 303);
  assert.equal(html.response.headers.Location, '/gate/login?next=%2F%3Fx%3D1');
  const api = await run(gate, req({ url: '/api/sachet', headers: { accept: 'application/json' } }));
  assert.equal(api.response.status, 401);
  assert.match(api.response.body, /sign in required/);
});

test('login sets a signed cookie that then passes; logout clears it', async () => {
  const gate = createGate({ env: { GEV_GATE_PASSWORD: 'open-sesame' } });
  const bad = await run(gate, req({ method: 'POST', url: '/gate/login', body: 'password=nope&next=%2Fmap' }));
  assert.equal(bad.response.status, 401);
  const ok = await run(gate, req({ method: 'POST', url: '/gate/login', body: 'password=open-sesame&next=%2Fmap' }));
  assert.equal(ok.response.status, 303);
  assert.equal(ok.response.headers.Location, '/map');
  assert.match(ok.response.headers['Set-Cookie'], /HttpOnly; SameSite=Lax/);
  const cookie = cookieFrom(ok.response);
  const inside = await run(gate, req({ url: '/api/sachet', headers: { cookie: `other=1; ${cookie}` } }));
  assert.equal(inside.passed, true);
  const out = await run(gate, req({ url: '/gate/logout' }));
  assert.match(out.response.headers['Set-Cookie'], /Max-Age=0/);
  const tampered = await run(gate, req({ url: '/', headers: { cookie: cookie.slice(0, -2) + 'zz' } }));
  assert.equal(tampered.passed, false);
});

test('open redirects are refused; sessions expire; bearer token serves machines', async () => {
  let t = 1_000_000;
  const gate = createGate({ env: { GEV_GATE_PASSWORD: 'open-sesame', GEV_GATE_DAYS: '1' }, now: () => t });
  const ok = await run(gate, req({ method: 'POST', url: '/gate/login', body: 'password=open-sesame&next=https%3A%2F%2Fevil.example' }));
  assert.equal(ok.response.headers.Location, '/');
  const cookie = cookieFrom(ok.response);
  t += 2 * 86_400_000;
  const expired = await run(gate, req({ url: '/', headers: { cookie } }));
  assert.equal(expired.passed, false);
  const machine = await run(gate, req({ url: '/api/jtwc', headers: { authorization: 'Bearer open-sesame' } }));
  assert.equal(machine.passed, true);
  const wrong = await run(gate, req({ url: '/api/jtwc', headers: { authorization: 'Bearer nope' } }));
  assert.equal(wrong.passed, false);
});

test('named users sign in with their own password and are throttled after repeated failures', async () => {
  const gate = createGate({ env: { GEV_GATE_USERS: 'gctp:traffic-2026,ram:mine' } });
  const page = await run(gate, req({ url: '/gate/login' }));
  assert.match(page.response.body, /name="name"/);
  const cross = await run(gate, req({ method: 'POST', url: '/gate/login', body: 'name=gctp&password=mine' }));
  assert.equal(cross.response.status, 401);
  const good = await run(gate, req({ method: 'POST', url: '/gate/login', body: 'name=GCTP&password=traffic-2026' }));
  assert.equal(good.response.status, 303);
  assert.equal(gate.verify(cookieFrom(good.response).split('=')[1]).name, 'gctp');
  for (let i = 0; i < 10; i++) await run(gate, req({ method: 'POST', url: '/gate/login', body: 'name=ram&password=wrong' }));
  const locked = await run(gate, req({ method: 'POST', url: '/gate/login', body: 'name=ram&password=mine' }));
  assert.equal(locked.response.status, 429);
});
