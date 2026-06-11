/**
 * socketRateLimiter.js
 * ─────────────────────
 * Simple fixed-window rate limiter for Socket.IO events.
 * Uses the verified telegramId as the key (not IP) since
 * identity is now confirmed via Telegram initData.
 */

const windows = new Map(); // `${limiterId}:${telegramId}` → { count, resetAt }

// Prevent memory leaks — purge expired windows every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of windows.entries()) {
    if (now > val.resetAt) windows.delete(key);
  }
}, 5 * 60 * 1000).unref(); // .unref() so this timer doesn't keep the process alive

/**
 * Creates a rate limiter function.
 *
 * @param {string} id        - unique name for this limiter (e.g. 'buyCard')
 * @param {number} max       - max calls allowed within the window
 * @param {number} windowMs  - window size in milliseconds
 * @returns {(telegramId: string) => boolean}  true = allowed, false = blocked
 *
 * Example:
 *   const canBuy = createSocketLimiter('buyCard', 20, 60_000); // 20/min
 *   if (!canBuy(telegramId)) return cb({ success: false, message: 'Too fast.' });
 */
function createSocketLimiter(id, max, windowMs) {
  return function isAllowed(telegramId) {
    const key = `${id}:${telegramId}`;
    const now = Date.now();
    const entry = windows.get(key);

    if (!entry || now > entry.resetAt) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (entry.count >= max) return false;

    entry.count++;
    return true;
  };
}

module.exports = { createSocketLimiter };
