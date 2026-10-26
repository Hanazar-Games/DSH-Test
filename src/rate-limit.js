// Fixed-window counter: cheap, predictable, and good enough for a single-process service.
export function createRateLimiter({ windowMs = 60_000, max = 30, now = Date.now } = {}) {
  const buckets = new Map();
  let calls = 0;

  function sweep(at) {
    calls += 1;
    if (calls % 256 !== 0) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  }

  return {
    take(key) {
      const at = now();
      sweep(at);
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= at) {
        bucket = { count: 0, resetAt: at + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > max) {
        return { ok: false, remaining: 0, retryAfterMs: Math.max(0, bucket.resetAt - at) };
      }
      return { ok: true, remaining: max - bucket.count, retryAfterMs: 0 };
    },
    get size() {
      return buckets.size;
    },
  };
}
