// PUBLIC_URL (www is the main address), ALLOWED_ORIGINS and the 301 to it (site.js, and the real server).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const site = require('../site');

const LIVE = {
  PUBLIC_URL: 'https://www.buzzin-game.com/',
  ALLOWED_ORIGINS: 'https://buzzin-game.com, https://www.buzzin-game.com ,https://kuch-kuch-pata-hai.onrender.com',
  RENDER_EXTERNAL_URL: 'https://kuch-kuch-pata-hai.onrender.com',
};

test('originOf keeps only bare http(s) origins', () => {
  assert.strictEqual(site.originOf('https://Buzzin-Game.com/'), 'https://buzzin-game.com');
  assert.strictEqual(site.originOf(' http://localhost:3000 '), 'http://localhost:3000');
  for (const bad of ['', 'buzzin-game.com', 'ftp://x.com', 'https://x.com/path', 'https://x.com/?a=1', 'https://u:p@x.com', 'javascript:alert(1)']) {
    assert.strictEqual(site.originOf(bad), '', bad);
  }
});

test('siteConfig: allowed origins and which hosts redirect', () => {
  const c = site.siteConfig(LIVE);
  assert.strictEqual(c.publicUrl, 'https://www.buzzin-game.com');
  assert.deepStrictEqual([...c.allowedOrigins], ['https://buzzin-game.com', 'https://www.buzzin-game.com', 'https://kuch-kuch-pata-hai.onrender.com']);
  assert.deepStrictEqual([...c.redirectHosts], ['buzzin-game.com', 'kuch-kuch-pata-hai.onrender.com'], 'never www itself');
  // PUBLIC_URL is always allowed; nothing redirects without it.
  assert.deepStrictEqual([...site.siteConfig({ PUBLIC_URL: 'https://buzzin-game.com' }).allowedOrigins], ['https://buzzin-game.com']);
  const noPublic = site.siteConfig({ ALLOWED_ORIGINS: LIVE.ALLOWED_ORIGINS, RENDER_EXTERNAL_URL: LIVE.RENDER_EXTERNAL_URL });
  assert.strictEqual(noPublic.redirectHosts.size, 0);
  assert.strictEqual(noPublic.allowedOrigins.size, 3);
  assert.deepStrictEqual(site.siteConfig({}), { publicUrl: '', allowedOrigins: new Set(), redirectHosts: new Set() });
});

test('canonicalRedirect never redirects PUBLIC_URL\'s own host, even if it were listed', () => {
  const mw = site.canonicalRedirect({ publicUrl: 'https://www.buzzin-game.com', redirectHosts: new Set(['www.buzzin-game.com', 'buzzin-game.com']) });
  const run = (host, p = '/host') => { let out = 'next'; mw({ headers: { host }, path: p, originalUrl: p, method: 'GET' }, { redirect: (s, l) => { out = [s, l]; } }, () => {}); return out; };
  assert.strictEqual(run('www.buzzin-game.com'), 'next');
  assert.deepStrictEqual(run('buzzin-game.com'), [301, 'https://www.buzzin-game.com/host']);
  assert.strictEqual(run('buzzin-game.com', '/healthz'), 'next');
});

test('originAllowed: the list when set, else the page\'s own address', () => {
  const allowed = site.siteConfig(LIVE).allowedOrigins;
  const req = (origin, host) => ({ headers: { origin, host } });
  assert.ok(site.originAllowed(req('https://www.buzzin-game.com', 'www.buzzin-game.com'), allowed));
  assert.ok(site.originAllowed(req('https://kuch-kuch-pata-hai.onrender.com', 'buzzin-game.com'), allowed));
  assert.ok(!site.originAllowed(req('https://evil.example', 'evil.example'), allowed), 'not listed, even if it matches its Host');
  assert.ok(!site.originAllowed(req('http://buzzin-game.com', 'buzzin-game.com'), allowed), 'http is a different origin');
  assert.ok(!site.originAllowed(req(undefined, 'buzzin-game.com'), allowed));
  const none = new Set();
  assert.ok(site.originAllowed(req('http://localhost:3000', 'localhost:3000'), none));
  assert.ok(!site.originAllowed(req('https://evil.example', 'localhost:3000'), none));
});

test('requestOrigin and isLoopback (the fallback when PUBLIC_URL is unset)', () => {
  assert.strictEqual(site.requestOrigin({ host: 'buzzin-game.com', 'x-forwarded-proto': 'https' }, { trustProxy: true }), 'https://buzzin-game.com');
  assert.strictEqual(site.requestOrigin({ host: 'buzzin-game.com', 'x-forwarded-proto': 'https' }), 'http://buzzin-game.com', 'only trusts the proxy when hosted');
  assert.strictEqual(site.requestOrigin({ host: '192.168.1.20:3000' }), 'http://192.168.1.20:3000');
  assert.strictEqual(site.requestOrigin({ host: 'x.com', 'x-forwarded-proto': 'gopher' }, { trustProxy: true, secure: true }), 'https://x.com');
  for (const bad of ['', 'a b', 'x.com/evil', 'x.com@y', '"><script>']) assert.strictEqual(site.requestOrigin({ host: bad }), '', bad);
  for (const o of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://app.localhost']) assert.ok(site.isLoopback(o), o);
  for (const o of ['http://192.168.1.20:3000', 'https://buzzin-game.com']) assert.ok(!site.isLoopback(o), o);
});

// ---- The real server ----
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const request = (port, { method = 'GET', path: p = '/', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
  });
  req.on('error', reject);
  req.end();
});
async function startServer(t, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none', ADMIN_PIN: 'site-test-pin-1234', HOST_PIN: '', PUBLIC_URL: '', ALLOWED_ORIGINS: '', RENDER_EXTERNAL_URL: '', RENDER: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('BuzzIn is running')) resolve(); });
    child.once('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  return port;
}

test('live settings: the bare domain and onrender.com 301 to www (not /healthz), www never redirects; /admin checks ALLOWED_ORIGINS', async (t) => {
  const port = await startServer(t, LIVE);
  for (const host of ['buzzin-game.com', 'kuch-kuch-pata-hai.onrender.com', 'Buzzin-Game.com']) {
    const res = await request(port, { path: '/join/ABCD?x=1', headers: { host } });
    assert.deepStrictEqual([res.status, res.location], [301, 'https://www.buzzin-game.com/join/ABCD?x=1'], host);
  }
  assert.strictEqual((await request(port, { method: 'HEAD', path: '/host', headers: { host: 'buzzin-game.com' } })).status, 301);
  const post = await request(port, { method: 'POST', path: '/admin/api/login', headers: { host: 'kuch-kuch-pata-hai.onrender.com' } });
  assert.deepStrictEqual([post.status, post.location], [308, 'https://www.buzzin-game.com/admin/api/login'], 'a POST stays a POST');
  // www is the main address: nothing on it redirects (Render sends the bare domain to www, so this would loop).
  for (const [method, p] of [['GET', '/'], ['GET', '/host'], ['GET', '/join/ABCD'], ['GET', '/admin'], ['HEAD', '/host'], ['GET', '/remote']]) {
    const res = await request(port, { method, path: p, headers: { host: 'www.buzzin-game.com' } });
    assert.ok(res.location !== 'https://www.buzzin-game.com' + p && ![301, 308].includes(res.status), `${method} ${p} on www`);
  }
  for (const host of ['buzzin-game.com', 'kuch-kuch-pata-hai.onrender.com', 'www.buzzin-game.com']) {
    const res = await request(port, { path: '/healthz', headers: { host } });
    assert.deepStrictEqual([res.status, res.body], [200, 'ok'], `/healthz on ${host}`);
  }
  assert.strictEqual((await request(port, { path: '/host', headers: { host: 'www.buzzin-game.com' } })).status, 200, 'the public address itself');

  const login = (origin) => request(port, { method: 'POST', path: '/admin/api/login', headers: { host: 'www.buzzin-game.com', 'content-type': 'application/json', ...(origin ? { origin } : {}) } });
  for (const origin of ['https://buzzin-game.com', 'https://www.buzzin-game.com', 'https://kuch-kuch-pata-hai.onrender.com']) {
    assert.notStrictEqual((await login(origin)).status, 403, origin);
  }
  for (const origin of ['https://evil.example', 'http://www.buzzin-game.com', undefined]) {
    assert.strictEqual((await login(origin)).status, 403, String(origin));
  }
});

test('on a laptop (no PUBLIC_URL): no redirects, /admin allows its own address', async (t) => {
  const port = await startServer(t, {});
  assert.strictEqual((await request(port, { path: '/host', headers: { host: 'www.buzzin-game.com' } })).status, 200);
  const own = await request(port, { method: 'POST', path: '/admin/api/login', headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json' } });
  assert.notStrictEqual(own.status, 403);
  const other = await request(port, { method: 'POST', path: '/admin/api/login', headers: { host: `localhost:${port}`, origin: 'https://evil.example', 'content-type': 'application/json' } });
  assert.strictEqual(other.status, 403);
});
