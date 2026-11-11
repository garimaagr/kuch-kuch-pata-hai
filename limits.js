// Small helpers that keep the public server safe: rate limits and text cleaning.

// Allows at most `max` hits per key within a sliding window of `windowMs`.
function makeLimiter(max, windowMs) {
  const hits = new Map(); // key -> timestamps
  return {
    allow(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    // Forget keys with no recent hits, so the map can't grow forever.
    prune(now = Date.now()) {
      for (const [key, list] of hits) {
        if (!list.some((t) => now - t < windowMs)) hits.delete(key);
      }
    },
  };
}

// Trims, removes control characters, collapses whitespace and cuts to `max` characters.
function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

module.exports = { makeLimiter, cleanText };
