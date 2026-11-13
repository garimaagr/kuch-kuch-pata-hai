// GET /healthz: plain "ok", no database, no limits, no logging. Starts the real server.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('GET /healthz answers "ok" without the database, limits or logging', async (t) => {
  const port = await freePort();
  // A database address that can't be reached: /healthz must not care.
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none', PUBLIC_URL: 'https://example.test', HOST_PIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const check = () => (out.includes('BuzzIn is running') ? resolve() : null);
    child.stdout.on('data', check);
    child.once('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  await new Promise((r) => setTimeout(r, 300)); // let startup logging finish
  const before = out;

  const url = `http://127.0.0.1:${port}/healthz`;
  const res = await fetch(url);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'ok');
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  assert.strictEqual(res.headers.get('set-cookie'), null, 'no session');

  // Far past any rate limit, from one address: never a 429.
  const many = await Promise.all(Array.from({ length: 300 }, () => fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.9' } }).then((r) => r.status)));
  assert.deepStrictEqual([...new Set(many)], [200]);

  assert.strictEqual(out, before, 'nothing logged for health checks');
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'POST' })).status, 404, 'GET only');
});
