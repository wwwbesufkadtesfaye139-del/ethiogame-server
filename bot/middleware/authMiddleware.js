const User = require('../../models/User');

/**
 * authMiddleware.js
 * ─────────────────
 * grammY middleware that runs on every update.
 *
 * Responsibilities:
 *   1. Auto-register unknown users in MongoDB on first contact.
 *   2. Attach the Mongoose User document to ctx.dbUser for downstream handlers.
 *   3. Block access for isBlocked users (they receive a notification once).
 *   4. Expose ctx.isAdmin for admin-only command guards.
 */

const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

/**
 * Main middleware — attach dbUser to context.
 */
const attachUser = async (ctx, next) => {
  const tgUser = ctx.from;
  if (!tgUser) return next(); // non-user updates (channel posts, etc.)

  const telegramId = String(tgUser.id);

  try {
    // Upsert: create on first visit, update username if it changed
    const dbUser = await User.findOneAndUpdate(
      { telegramId },
      {
        $set: {
          username:  tgUser.username  || 'Anonymous',
          firstName: tgUser.first_name || '',
          lastName:  tgUser.last_name  || '',
        },
        $setOnInsert: { telegramId, balance: 0 },
      },
      { upsert: true, new: true }
    );

    ctx.dbUser  = dbUser;
    ctx.isAdmin = ADMIN_TELEGRAM_IDS.includes(telegramId) || dbUser.isAdmin;

    // Block check
    if (dbUser.isBlocked) {
      await ctx.reply(
        `⛔ Your account has been blocked.\nReason: ${dbUser.blockedReason || 'Policy violation.'}\n\nContact support if you believe this is an error.`
      );
      return; // halt middleware chain
    }
  } catch (err) {
    console.error('[authMiddleware] DB error:', err.message);
    await ctx.reply('⚠️ A server error occurred. Please try again.');
    return;
  }

  return next();
};

/**
 * Admin-only guard — use as a filter before admin handlers.
 * Usage: bot.command('approve', adminOnly, handleApprove)
 */
const adminOnly = async (ctx, next) => {
  if (!ctx.isAdmin) {
    await ctx.reply('🚫 This command is for admins only.');
    return;
  }
  return next();
};

module.exports = { attachUser, adminOnly };
