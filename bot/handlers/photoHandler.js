const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const MESSAGES = require('../utils/messages');

/**
 * photoHandler.js
 * ───────────────
 * Handles the two-step deposit screenshot flow:
 *
 *   Step 1 — User sends a photo:
 *     Bot stores the file_id on the User document (pendingDepositFileId)
 *     and asks "Is this a Telebirr deposit receipt?"
 *
 *   Step 2 — User replies "yes" or "no":
 *     Yes → create Transaction (status: pending), notify admin, clear pending state
 *     No  → clear pending state, cancel flow
 *
 * The photo is NOT downloaded to the server. Its Telegram file_id is stored
 * in the Transaction and can be fetched via the Bot API at any time.
 */

// ─── Step 1: Photo received ───────────────────────────────────────────────────

const handlePhoto = async (ctx) => {
  const from = ctx.from;
  const telegramId = String(from.id);

  // Ensure user record exists
  const user = await User.findOrCreateFromTelegram(from);

  if (user.isBlocked) {
    return ctx.reply(MESSAGES.accountBlocked, { parse_mode: 'Markdown' });
  }

  // Telegram sends multiple sizes — pick the highest resolution (last in array)
  const photo = ctx.message.photo;
  const bestPhoto = photo[photo.length - 1];
  const fileId = bestPhoto.file_id;

  // Store file_id on user so the confirmation handler can retrieve it
  await User.findOneAndUpdate(
    { telegramId },
    { $set: { pendingDepositFileId: fileId } }
  );

  await ctx.reply(MESSAGES.depositConfirmQuestion(), {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        [{ text: '✅ Yes, this is my deposit' }, { text: '❌ No, cancel' }],
      ],
      one_time_keyboard: true,
      resize_keyboard: true,
    },
  });
};

// ─── Step 2: Confirmation reply ────────────────────────────────────────────────

/**
 * Registered as a text handler that only fires when the user has a
 * pendingDepositFileId set (checked inside the handler).
 */
const handleDepositConfirmation = async (ctx) => {
  const from = ctx.from;
  const telegramId = String(from.id);
  const text = ctx.message.text?.trim() || '';

  const user = await User.findOne({ telegramId });
  if (!user || !user.pendingDepositFileId) {
    // No pending deposit — let the message fall through to other handlers
    return;
  }

  const isConfirmed =
    text.toLowerCase().startsWith('yes') ||
    text.includes('✅');

  // Always clear the pending state regardless of answer
  await User.findOneAndUpdate(
    { telegramId },
    { $set: { pendingDepositFileId: null } }
  );

  if (!isConfirmed) {
    return ctx.reply(MESSAGES.depositCancelled, {
      parse_mode: 'Markdown',
      reply_markup: { remove_keyboard: true },
    });
  }

  // Create pending Transaction
  const transaction = await Transaction.create({
    userId: user._id,
    telegramId,
    username: user.username || from.username || 'Anonymous',
    amount: 0,              // amount is unknown until admin reviews
    type: 'deposit',
    status: 'pending',
    screenshotFileId: user.pendingDepositFileId,
    screenshotUrl: `telegram://file/${user.pendingDepositFileId}`, // logical reference
    userChatId: String(ctx.chat.id),
  });

  const shortId = transaction._id.toString().slice(-8).toUpperCase();

  // Confirm to user
  await ctx.reply(MESSAGES.depositSubmitted(shortId), {
    parse_mode: 'Markdown',
    reply_markup: { remove_keyboard: true },
  });

  // Notify all admins
  await _notifyAdmins(ctx, transaction, shortId, user);
};

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Forwards the screenshot and a summary to every registered admin.
 * Stores the admin notification message_id so it can be updated on approval/rejection.
 */
const _notifyAdmins = async (ctx, transaction, shortId, user) => {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (!adminIds.length) {
    console.warn('[PhotoHandler] No ADMIN_TELEGRAM_IDS set in .env');
    return;
  }

  for (const adminId of adminIds) {
    try {
      // Forward the screenshot
      await ctx.telegram.sendPhoto(adminId, transaction.screenshotFileId, {
        caption:
          `🔔 *New Deposit Request*\n\n` +
          `👤 @${user.username} (ID: \`${transaction.telegramId}\`)\n` +
          `🆔 Ref: \`#${shortId}\`\n\n` +
          `To approve:\n\`/approve ${shortId} <amount>\`\n\n` +
          `To reject:\n\`/reject ${shortId} <reason>\``,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      console.error(`[PhotoHandler] Failed to notify admin ${adminId}:`, err.message);
    }
  }
};

module.exports = { handlePhoto, handleDepositConfirmation };
