/**
 * verifyTelegram.js
 * ──────────────────
 * Verifies that a Telegram Mini App initData string was genuinely signed
 * by Telegram using your bot token — not forged by a client.
 *
 * Algorithm (per Telegram docs):
 *   1. Parse the initData query string and pull out the `hash` field.
 *   2. Sort the remaining fields alphabetically and join as "key=value\n".
 *   3. Derive a secret key: HMAC-SHA256("WebAppData", botToken)
 *   4. Compute HMAC-SHA256(dataCheckString, secretKey)
 *   5. Compare with the hash from step 1.
 *   6. Check auth_date is within 24 hours (prevents replay attacks).
 *
 * Returns the verified Telegram user object, or null if invalid/expired.
 */

const crypto = require('crypto');

/**
 * @param {string} initData  - window.Telegram.WebApp.initData from the client
 * @param {string} botToken  - Your Telegram bot token (BOT_TOKEN env var)
 * @returns {{ id: number, username?: string, first_name?: string } | null}
 */
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;

    params.delete('hash');

    // Sort fields alphabetically and build the check string
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // Derive secret key: HMAC-SHA256("WebAppData", botToken)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // Compute expected hash
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(receivedHash))) {
      return null;
    }

    // Reject data older than 24 hours (replay attack prevention)
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
    if (ageSeconds > 86400) {
      console.warn('[verifyTelegram] initData expired (age:', ageSeconds, 's)');
      return null;
    }

    // Parse and return the verified user object
    const userStr = params.get('user');
    if (!userStr) return null;

    return JSON.parse(userStr); // { id, username, first_name, ... }
  } catch (err) {
    console.error('[verifyTelegram] Verification error:', err.message);
    return null;
  }
}

module.exports = verifyTelegramInitData;
