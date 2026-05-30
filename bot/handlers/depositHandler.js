const { InlineKeyboard } = require('grammy');
const User        = require('../../models/User');
const Transaction = require('../../models/Transaction');

const MAX_PENDING_PER_USER = 3; // anti-spam: max unresolved deposits at once

/**
 * depositHandler.js
 * ─────────────────
 * Handles the full Telebirr deposit flow:
 *
 *   1. User sends any photo to the bot.
 *   2. Bot replies: "Is this a Telebirr deposit receipt?" with Yes / No buttons.
 *   3a. Yes → save a Transaction (status: 'pending'), notify admin group.
 *   3b. No  → politely dismiss.
 *
 * All handlers are exported as functions so bot/index.js wires them up.
 */

// ─── Step 1: Photo received ───────────────────────────────────────────────────

/**
 * Triggered on any photo message.
 * Presents a Yes/No inline keyboard to confirm intent.
 */
const onPhotoReceived = async (ctx) => {
  const photos  = ctx.message.photo;
  // Telegram sends multiple sizes; take the largest (last in array)
  const bestPhoto = photos[photos.length - 1];
  const fileId    = bestPhoto.file_id;

  // Encode fileId in callback_data so we recover it on button press
  // Max callback_data length: 64 bytes — use a short prefix + file_id
  // file_ids can be long; we store them in a temp session keyed by message_id instead.
  const callbackData = `deposit_confirm:yes:${ctx.message.message_id}`;
  const cancelData   = `deposit_confirm:no:${ctx.message.message_id}`;

  // Stash the file_id so the callback handler can retrieve it
  // We use a lightweight in-memory map keyed by "telegramId:messageId"
  pendingPhotoCache.set(`${ctx.from.id}:${ctx.message.message_id}`, {
    fileId,
    timestamp: Date.now(),
  });

  const keyboard = new InlineKeyboard()
    .text('✅ Yes, this is my Telebirr receipt', callbackData)
    .row()
    .text('❌ No, ignore this', cancelData);

  await ctx.reply(
    '📸 *Photo received!*\n\nIs this a *Telebirr deposit receipt* for topping up your game balance?',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
      reply_to_message_id: ctx.message.message_id,
    }
  );
};

// ─── Step 2: Inline keyboard callback ────────────────────────────────────────

/**
 * Handles the Yes/No callback from the deposit confirmation keyboard.
 */
const onDepositCallback = async (ctx) => {
  await ctx.answerCallbackQuery(); // remove loading indicator

  const data    = ctx.callbackQuery.data; // "deposit_confirm:yes:12345"
  const parts   = data.split(':');
  const answer  = parts[1];              // "yes" | "no"
  const msgId   = parts[2];
  const userId  = String(ctx.from.id);
  const cacheKey = `${userId}:${msgId}`;

  if (answer === 'no') {
    await ctx.editMessageText('👍 Got it — photo ignored. Send any photo when you have a deposit receipt to submit.');
    pendingPhotoCache.delete(cacheKey);
    return;
  }

  // ── Yes: save transaction ──────────────────────────────────────────────────

  const cached = pendingPhotoCache.get(cacheKey);
  if (!cached) {
    await ctx.editMessageText('⚠️ Session expired. Please re-send your receipt photo.');
    return;
  }

  const { fileId } = cached;
  pendingPhotoCache.delete(cacheKey);

  const dbUser = ctx.dbUser;

  // Anti-spam: limit pending transactions per user
  const pendingCount = await Transaction.countPendingByUser(userId);
  if (pendingCount >= MAX_PENDING_PER_USER) {
    await ctx.editMessageText(
      `⏳ You already have *${pendingCount}* pending deposit(s) under review.\n` +
      `Please wait for admin approval before submitting more.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Create the Transaction document
  let txn;
  try {
    txn = await Transaction.create({
      userId:           dbUser._id,
      telegramId:       userId,
      username:         dbUser.username,
      type:             'deposit',
      status:           'pending',
      screenshotFileId: fileId,
    });
  } catch (err) {
    console.error('[depositHandler] Failed to save transaction:', err.message);
    await ctx.editMessageText('❌ Failed to save your receipt. Please try again.');
    return;
  }

  // Confirm to user
  await ctx.editMessageText(
    `✅ *Receipt submitted for review!*\n\n` +
    `🆔 Transaction ID: \`${txn._id}\`\n` +
    `⏳ Status: *Pending*\n\n` +
    `An admin will verify your Telebirr receipt and top up your balance shortly.\n` +
    `You will receive a notification here once approved.`,
    { parse_mode: 'Markdown' }
  );

  // Notify admin group/channel
  await notifyAdmins(ctx, txn, dbUser, fileId);
};

// ─── Admin notification ───────────────────────────────────────────────────────

/**
 * Forwards the receipt photo to the admin group with approve/reject buttons.
 *
 * Requires ADMIN_GROUP_ID env variable (a negative chat_id for a group/channel).
 */
const notifyAdmins = async (ctx, txn, dbUser, fileId) => {
  const adminGroupId = process.env.ADMIN_GROUP_ID;
  if (!adminGroupId) return; // no admin group configured

  const caption =
    `📥 *New Deposit Request*\n\n` +
    `👤 User: @${dbUser.username} (ID: \`${dbUser.telegramId}\`)\n` +
    `💰 Current Balance: *${dbUser.balance} Birr*\n` +
    `🆔 Transaction ID: \`${txn._id}\`\n\n` +
    `To approve:\n\`/approve ${txn._id} <amount>\`\n` +
    `To reject:\n\`/reject ${txn._id} <reason>\``;

  try {
    await ctx.api.sendPhoto(adminGroupId, fileId, {
      caption,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('[depositHandler] Failed to notify admin group:', err.message);
  }
};

// ─── In-memory photo cache ────────────────────────────────────────────────────
// Maps "telegramId:messageId" → { fileId, timestamp }
// Entries older than 10 minutes are pruned automatically.

const pendingPhotoCache = new Map();

setInterval(() => {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, val] of pendingPhotoCache.entries()) {
    if (val.timestamp < tenMinutesAgo) pendingPhotoCache.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = { onPhotoReceived, onDepositCallback };
