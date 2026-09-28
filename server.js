import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCollection } from './lib/discogs.js';
import { mergeCollection } from './lib/merge.js';
import { Store } from './lib/store.js';
import { MAX_CENTS } from './public/ledger.js';

const root = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.DISCOGS_TOKEN?.trim() || null;
const DATA_FILE = path.resolve(root, process.env.DATA_DIR || 'data', 'collection.json');
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const MAX_BODY_BYTES = 64 * 1024;
const ITEM_ID = /^\d{1,20}$/;
const BUNDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://*.discogs.com; " +
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

// An explicit allowlist: nothing else on disk is reachable.
const STATIC = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/ledger.js', { file: 'ledger.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const store = await Store.open(DATA_FILE);
let allowedHosts = new Set();
let syncInFlight = null;

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error(`${req.method} ${JSON.stringify(req.url)} failed:`, err);
    if (res.headersSent) return res.destroy();
    send(res, status, { error: err.expose ? err.message : 'Something went wrong. Check the server log.' });
  }
});

async function route(req, res) {
  // Rejecting unknown Host headers stops DNS-rebinding pages from talking to this server.
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!allowedHosts.has(host)) {
    console.warn(`Blocked request for unknown host ${JSON.stringify(host.slice(0, 200))}. Add it to ALLOWED_HOSTS if that's you.`);
    throw new HttpError(421, 'Unknown host');
  }

  const url = URL.parse(req.url, 'http://localhost');
  if (!url) throw new HttpError(400, 'Bad request');
  if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  const entry = STATIC.get(url.pathname);
  if (!entry) throw new HttpError(404, 'Not found');
  const body = await readFile(path.join(root, 'public', entry.file));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': entry.type, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function api(req, res, pathname) {
  const { method } = req;
  if (method !== 'GET') assertSameOrigin(req);

  if (pathname === '/api/state' && method === 'GET') return send(res, 200, snapshot());

  if (pathname === '/api/sync' && method === 'POST') {
    if (!TOKEN) throw new HttpError(400, 'Add your DISCOGS_TOKEN to .env and restart the server.');
    // Two tabs pressing refresh share one sync instead of racing each other.
    syncInFlight ??= syncCollection().finally(() => {
      syncInFlight = null;
    });
    const summary = await syncInFlight;
    return send(res, 200, { ...snapshot(), summary });
  }

  if (pathname === '/api/items/bundle' && method === 'POST') {
    const body = await readJson(req);
    const items = await store.update((data) => {
      const bundleId = body.bundleId === null ? null : findBundle(data, body.bundleId).id;
      return itemIds(data, body.itemIds).map((id) => Object.assign(data.items[id], { bundleId }));
    });
    return send(res, 200, { items });
  }

  const itemMatch = pathname.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch && method === 'PATCH') {
    const body = await readJson(req);
    const item = await store.update((data) => {
      const target = findItem(data, itemMatch[1]);
      // Only these fields are writable; everything else comes from Discogs.
      for (const key of ['paid', 'shipping', 'sold']) {
        if (Object.hasOwn(body, key)) target[key] = cents(body[key], key);
      }
      if (Object.hasOwn(body, 'gift')) {
        if (typeof body.gift !== 'boolean') throw new HttpError(400, 'Invalid gift value');
        target.gift = body.gift;
      }
      return target;
    });
    return send(res, 200, { item });
  }

  if (pathname === '/api/bundles' && method === 'POST') {
    const body = await readJson(req);
    const result = await store.update((data) => {
      const ids = itemIds(data, body.itemIds);
      const bundle = {
        id: randomUUID(),
        name: text(body.name, `Bundle ${Object.keys(data.bundles).length + 1}`),
        shipping: cents(body.shipping ?? 0, 'shipping') ?? 0,
        createdAt: new Date().toISOString(),
      };
      data.bundles[bundle.id] = bundle;
      return { bundle, items: ids.map((id) => Object.assign(data.items[id], { bundleId: bundle.id })) };
    });
    return send(res, 200, result);
  }

  const bundleMatch = pathname.match(/^\/api\/bundles\/([^/]+)$/);
  if (bundleMatch && method === 'PATCH') {
    const body = await readJson(req);
    const bundle = await store.update((data) => {
      const target = findBundle(data, bundleMatch[1]);
      if (Object.hasOwn(body, 'name')) target.name = text(body.name, target.name);
      if (Object.hasOwn(body, 'shipping')) target.shipping = cents(body.shipping, 'shipping') ?? 0;
      return target;
    });
    return send(res, 200, { bundle });
  }

  if (bundleMatch && method === 'DELETE') {
    const items = await store.update((data) => {
      const { id } = findBundle(data, bundleMatch[1]);
      delete data.bundles[id];
      return Object.values(data.items)
        .filter((item) => item.bundleId === id)
        .map((item) => Object.assign(item, { bundleId: null }));
    });
    return send(res, 200, { items });
  }

  throw new HttpError(404, 'Not found');
}

async function syncCollection() {
  const started = performance.now();
  const remote = await fetchCollection(TOKEN);
  const summary = await store.update((data) => {
    Object.assign(data, { username: remote.username, currency: remote.currency, lastSyncedAt: new Date().toISOString() });
    return mergeCollection(data, remote.items);
  });
  const ms = Math.round(performance.now() - started);
  console.log(`Synced ${summary.total} records for ${JSON.stringify(remote.username)} in ${ms} ms (${summary.added} new, ${summary.removed} gone)`);
  return summary;
}

function snapshot() {
  const { username, currency, lastSyncedAt, items, bundles } = store.data;
  return {
    configured: Boolean(TOKEN),
    username,
    currency,
    lastSyncedAt,
    items: Object.values(items),
    bundles: Object.values(bundles),
  };
}

// CSRF guard: browsers always send Origin (and usually Sec-Fetch-Site) on writes.
function assertSameOrigin(req) {
  const host = req.headers.host.toLowerCase();
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  const originOk = !origin || origin === `http://${host}` || origin === `https://${host}`;
  const siteOk = !site || site === 'same-origin' || site === 'none';
  if (!originOk || !siteOk) {
    console.warn(`Blocked cross-origin ${req.method} ${JSON.stringify(req.url)} from ${JSON.stringify(origin ?? site)}`);
    throw new HttpError(403, 'Cross-origin request blocked');
  }
}

async function readJson(req) {
  // Requiring JSON also forces a CORS preflight for any cross-site attempt, which we never approve.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Expected JSON');
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body;
}

function findItem(data, id) {
  if (typeof id !== 'string' || !ITEM_ID.test(id) || !Object.hasOwn(data.items, id)) {
    throw new HttpError(404, 'Record not found');
  }
  return data.items[id];
}

function findBundle(data, id) {
  if (typeof id !== 'string' || !BUNDLE_ID.test(id) || !Object.hasOwn(data.bundles, id)) {
    throw new HttpError(404, 'Bundle not found');
  }
  return data.bundles[id];
}

function itemIds(data, value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new HttpError(400, 'Pick at least one record');
  }
  const ids = [...new Set(value)];
  for (const id of ids) findItem(data, id);
  return ids;
}

function cents(value, field) {
  if (value === null) return null;
  if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS) return value;
  throw new HttpError(400, `Invalid ${field} amount`);
}

function text(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid name');
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length > 80) throw new HttpError(400, 'Names can be 80 characters at most');
  return cleaned || fallback;
}

function send(res, status, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...EXTRA_HOSTS]);
  console.log(`Crate running at http://localhost:${port}`);
  if (!TOKEN) console.log('No DISCOGS_TOKEN yet: copy .env.example to .env and paste your token in.');
  if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    console.warn(`Listening on ${HOST}. Crate has no login, so only expose it on a private network (e.g. Tailscale).`);
  }
});
