import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createService } from './service.mjs';

const PORT = Number(process.env.PORT || 4180);
const BASE_URL = (process.env.GEV_BASE_URL || 'http://localhost:4173').replace(/\/$/, '');
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10);
const DATA_DIR = process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const service = createService({ baseUrl: BASE_URL, dataDir: DATA_DIR });

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
}
const authorized = (req) => !ADMIN_TOKEN || req.headers.authorization === `Bearer ${ADMIN_TOKEN}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, service.health());
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/assets') return json(res, 200, { assets: service.listAssets() });
    if (req.method === 'POST' && url.pathname === '/assets') {
      const body = await readJson(req);
      const list = Array.isArray(body) ? body : Array.isArray(body.assets) ? body.assets : [body];
      const saved = list.map((a) => service.upsertAsset(a));
      return json(res, 200, { assets: saved });
    }
    const removal = url.pathname.match(/^\/assets\/(.+)$/);
    if (req.method === 'DELETE' && removal)
      return json(res, service.removeAsset(decodeURIComponent(removal[1])) ? 200 : 404, { ok: true });
    if (req.method === 'GET' && url.pathname === '/matches')
      return json(res, 200, { matches: service.listMatches({ product: url.searchParams.get('product') || undefined, asset: url.searchParams.get('asset') || undefined }) });
    if (req.method === 'GET' && url.pathname === '/events') return json(res, 200, { events: service.listEvents() });
    if (req.method === 'POST' && url.pathname === '/poll') return json(res, 200, await service.poll());
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, error instanceof SyntaxError || /must|too large/.test(error.message) ? 400 : 500, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[alerts] listening on http://127.0.0.1:${PORT} · feeds from ${BASE_URL} · poll every ${POLL_MINUTES} min · data in ${DATA_DIR}`);
  service.poll().catch((e) => console.error('[alerts] first poll failed:', e.message));
  setInterval(() => service.poll().catch((e) => console.error('[alerts] poll failed:', e.message)), POLL_MINUTES * 60_000).unref();
});
