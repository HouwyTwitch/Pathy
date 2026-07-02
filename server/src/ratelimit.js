// Small in-memory sliding-window rate limiter. Single-process by design —
// Pathy runs as one server container; swap for a Redis-backed limiter when
// scaling out.
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

export function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = `${req.baseUrl}${req.path}|${keyFn ? keyFn(req) : req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    if (++b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    next();
  };
}
