const User = require('../../models/User');

/**
 * isAdmin Middleware (Telegraf)
 * ─────────────────────────────
 * Checks whether the sender is a registered admin before allowing
 * the command to proceed. Blocks the middleware chain on failure.
 *
 * Admin status is set via the User.isAdmin flag OR by matching
 * the hardcoded ADMIN_TELEGRAM_IDs in .env (comma-separated).
 *
 * Usage:
 *   bot.command('approve', isAdmin, approveHandler);
 */

const ADMIN_IDS_ENV = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const isAdmin = async (ctx, next) => {
  const telegramId = String(ctx.from?.id);

  // Fast path: check env list first (no DB hit)
  if (ADMIN_IDS_ENV.includes(telegramId)) {
    return next();
  }

  // Fallback: check DB flag
  try {
    const user = await User.findOne({ telegramId });
    if (user?.isAdmin) {
      return next();
    }
  } catch (err) {
    console.error('[isAdmin] DB error:', err.message);
  }

  await ctx.reply(
    '⛔ You are not authorised to run admin commands.',
    { parse_mode: 'Markdown' }
  );
};

module.exports = isAdmin;
