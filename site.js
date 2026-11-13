// The site's addresses: the public one (PUBLIC_URL, e.g. https://www.buzzin-game.com), which origins may post to /admin
// (ALLOWED_ORIGINS) and which other hosts are sent to the public one with a 301.

// "https://Example.com/" -> "https://example.com". Anything that isn't a bare http(s) origin -> ''.
function originOf(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return '';
  return u.origin;
}

const hostOf = (origin) => (origin ? new URL(origin).host : '');

// Read once from the environment (tests pass their own).
function siteConfig(env = process.env) {
  const publicUrl = originOf(env.PUBLIC_URL);
  const listed = String(env.ALLOWED_ORIGINS || '').split(',').map(originOf).filter(Boolean);
  // PUBLIC_URL is always allowed, so a typo in the list can't lock you out of /admin.
  const allowedOrigins = new Set([...listed, ...(publicUrl ? [publicUrl] : [])]);
  // Other addresses of this same site (e.g. the bare domain, onrender.com) redirect to PUBLIC_URL.
  // PUBLIC_URL's own host is never one of them, so the app can't loop with a redirect in front of it.
  const redirectHosts = new Set();
  if (publicUrl) {
    for (const o of [...listed, originOf(env.RENDER_EXTERNAL_URL)]) {
      if (o && hostOf(o) !== hostOf(publicUrl)) redirectHosts.add(hostOf(o));
    }
  }
  return { publicUrl, allowedOrigins, redirectHosts };
}

// Express middleware: the bare domain / onrender.com -> PUBLIC_URL, same path and query.
// Never redirects PUBLIC_URL's own host, and never /healthz.
// 301 for GET/HEAD; 308 for anything else so a POST stays a POST.
function canonicalRedirect({ publicUrl, redirectHosts }) {
  return (req, res, next) => {
    if (!publicUrl || !redirectHosts.size || req.path === '/healthz') return next();
    const host = String(req.headers.host || '').toLowerCase();
    if (host === hostOf(publicUrl) || !redirectHosts.has(host)) return next();
    res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, publicUrl + req.originalUrl);
  };
}

// Is this request's Origin allowed to post? With a list: only those. Without one (e.g. on your
// laptop): the page's own address.
function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (allowedOrigins.size) return allowedOrigins.has(origin);
  const host = req.headers.host;
  return !!host && (origin === `https://${host}` || origin === `http://${host}`);
}

// The address the page was opened on, e.g. "https://buzzin-game.com" or "http://192.168.1.20:3000".
// Returns '' for a Host header that doesn't look like one. `trustProxy`: believe X-Forwarded-Proto.
function requestOrigin(headers, { secure = false, trustProxy = false } = {}) {
  const host = String(headers.host || '').toLowerCase();
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(host)) return '';
  const fwd = trustProxy ? String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
  const proto = fwd === 'https' || fwd === 'http' ? fwd : secure ? 'https' : 'http';
  return `${proto}://${host}`;
}

// localhost and friends: a phone can't reach those, so the wifi address is used instead.
function isLoopback(origin) {
  const h = new URL(origin).hostname;
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '0.0.0.0' || /^127\./.test(h);
}

module.exports = { originOf, siteConfig, canonicalRedirect, originAllowed, requestOrigin, isLoopback };
