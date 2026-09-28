import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const record = (id) => ({
  instanceId: id,
  releaseId: Number(id),
  title: `Record ${id}`,
  artist: 'Artist',
  year: 2000,
  format: 'Vinyl',
  label: '',
  catno: '',
  thumb: null,
  dateAdded: null,
  paid: null,
  shipping: null,
  sold: null,
  bundleId: null,
  inCollection: true,
});

let server;
let port;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'crate-test-'));
  await writeFile(
    path.join(dataDir, 'collection.json'),
    JSON.stringify({ version: 1, username: 'tester', currency: 'EUR', lastSyncedAt: null, items: { 1: record('1'), 2: record('2') }, bundles: {} }),
  );
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, DISCOGS_TOKEN: '', ALLOWED_HOSTS: '', CRATE_VERSION: '' },
  });
  port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 10_000);
    server.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    server.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(async () => {
  server?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

function request(method, pathname, { headers = {}, json } = {}) {
  const body = json === undefined ? undefined : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          host: `localhost:${port}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('serves the page with strict security headers', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('reports the running version', async () => {
  assert.equal((await request('GET', '/api/state')).json().version, 'dev');
});

test('only serves the allowlisted files', async () => {
  for (const pathname of ['/server.js', '/../server.js', '/%2e%2e/server.js', '/public/app.js', '/.env', '/data/collection.json']) {
    assert.equal((await request('GET', pathname)).status, 404, pathname);
  }
});

test('rejects unknown Host headers (DNS rebinding)', async () => {
  for (const host of ['attacker.example', `attacker.example:${port}`, 'localhost.attacker.example']) {
    assert.equal((await request('GET', '/api/state', { headers: { host } })).status, 421, host);
  }
});

test('accepts localhost on any port, as when Docker maps a different one', async () => {
  for (const host of ['localhost:8080', '127.0.0.1:80', '[::1]:5178', 'localhost']) {
    assert.equal((await request('GET', '/api/state', { headers: { host } })).status, 200, host);
  }
});

test('blocks cross-origin writes (CSRF)', async () => {
  const cross = await request('PATCH', '/api/items/1', { json: { paid: 1 }, headers: { origin: 'https://attacker.example' } });
  assert.equal(cross.status, 403);
  const site = await request('POST', '/api/sync', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(site.status, 403);
  const plain = await request('PATCH', '/api/items/1', { headers: { 'content-type': 'text/plain' } });
  assert.equal(plain.status, 415);
});

test('validates amounts and ids', async () => {
  for (const paid of [-1, 1.5, '12', 1e12, {}]) {
    assert.equal((await request('PATCH', '/api/items/1', { json: { paid } })).status, 400, JSON.stringify(paid));
  }
  assert.equal((await request('PATCH', '/api/items/999', { json: { paid: 1 } })).status, 404);
  assert.equal((await request('PATCH', '/api/items/__proto__', { json: { paid: 1 } })).status, 404);
  assert.equal((await request('PATCH', '/api/items/1', { json: [] })).status, 400);
  assert.equal((await request('PATCH', '/api/items/1', { headers: { 'content-type': 'application/json' }, json: undefined })).status, 400);
});

test('saves prices and ignores fields the user may not set', async () => {
  const res = await request('PATCH', '/api/items/1', {
    json: { paid: 1250, sold: null, title: '<img src=x onerror=alert(1)>', inCollection: false },
  });
  assert.equal(res.status, 200);
  const { item } = res.json();
  assert.equal(item.paid, 1250);
  assert.equal(item.title, 'Record 1');
  assert.equal(item.inCollection, true);

  const stored = JSON.parse(await readFile(path.join(dataDir, 'collection.json'), 'utf8'));
  assert.equal(stored.items['1'].paid, 1250);
});

test('marks a record as a gift', async () => {
  for (const gift of ['true', 1, null]) {
    assert.equal((await request('PATCH', '/api/items/2', { json: { gift } })).status, 400, JSON.stringify(gift));
  }
  const res = await request('PATCH', '/api/items/2', { json: { gift: true } });
  assert.equal(res.status, 200);
  assert.equal(res.json().item.gift, true);
  assert.equal((await request('PATCH', '/api/items/2', { json: { gift: false } })).json().item.gift, false);
});

test('saves where a record came from', async () => {
  const saved = await request('PATCH', '/api/items/2', { json: { source: '  rommelmarkt Patershol\u0007 ' } });
  assert.equal(saved.json().item.source, 'rommelmarkt Patershol');
  assert.equal((await request('PATCH', '/api/items/2', { json: { source: '   ' } })).json().item.source, null);
  assert.equal((await request('PATCH', '/api/items/2', { json: { source: 'x'.repeat(81) } })).status, 400);
  assert.equal((await request('PATCH', '/api/items/2', { json: { source: 5 } })).status, 400);
});

test('bundles records, edits and deletes the bundle', async () => {
  const created = await request('POST', '/api/bundles', { json: { name: '  Order from Juno  ', shipping: 1001, itemIds: ['1', '2', '2'] } });
  assert.equal(created.status, 200);
  const { bundle, items } = created.json();
  assert.equal(bundle.name, 'Order from Juno');
  assert.equal(bundle.shipping, 1001);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.bundleId === bundle.id));

  assert.equal((await request('PATCH', `/api/bundles/${bundle.id}`, { json: { shipping: 1200, name: 'x'.repeat(81) } })).status, 400);
  const edited = await request('PATCH', `/api/bundles/${bundle.id}`, { json: { shipping: 1200 } });
  assert.equal(edited.json().bundle.shipping, 1200);

  const moved = await request('POST', '/api/items/bundle', { json: { itemIds: ['2'], bundleId: null } });
  assert.equal(moved.json().items[0].bundleId, null);

  const deleted = await request('DELETE', `/api/bundles/${bundle.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json().items.map((item) => [item.instanceId, item.bundleId]), [['1', null]]);
  assert.equal((await request('DELETE', `/api/bundles/${bundle.id}`)).status, 404);
});

test('sync explains a missing token instead of failing', async () => {
  const res = await request('POST', '/api/sync');
  assert.equal(res.status, 400);
  assert.match(res.json().error, /DISCOGS_TOKEN/);
});
