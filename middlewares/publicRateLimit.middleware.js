// Tiny in-memory rate limiter for PUBLIC (no login) form endpoints.
// Per IP: `max` requests per `windowMs`. Good enough for a single Render
// instance; if the app is ever scaled to several instances, swap for a
// shared store (e.g. express-rate-limit + Redis).
const publicRateLimit = ({ windowMs = 60 * 60 * 1000, max = 10, keyGenerator } = {}) => {
  // Each limiter keeps its own counters, so the normal form limit and the
  // (higher) form-link limit never count against each other.
  const hits = new Map();

  // forget old entries now and then so the map cannot grow forever
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const ip =
      String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip ||
      "unknown";
    // optional custom key (e.g. per RSVP token) so many guests sharing one
    // IP (mobile CGNAT, venue wifi, office) do not block each other
    const key = keyGenerator ? keyGenerator(req, ip) : ip;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({
        success: false,
        message: "Too many submissions. Please try again after some time.",
      });
    }
    return next();
  };
};

module.exports = publicRateLimit;