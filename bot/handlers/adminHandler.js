const User        = require('../../models/User');
const Transaction = require('../../models/Transaction');

/**
 * adminHandler.js
 * ───────────────
 * Admin-only bot commands for transaction management.
 *
 * Commands:
 *   /approve <transactionId> <amount>   — approve a deposit, credit user balance
 *   /reject  <transactionId> <reason>   — reject a deposit, notify user
 *   /pending                            — list all pending transactions
 *   /balance <telegramId>               — check a user's balance
 *   /block   <telegramId> <reason>      — block a user
 *   /unblock <telegramId>               — unblock a user
 */

// ─── /approve ─────────────────────────────────────────────────────────────────

/**
 * Usage: /approve <transactionId> <amount>
 *
 * Steps:
 *   1. Parse and validate arguments.
 *   2. Load the Transaction; ensure it is still pending.
 *   3. Update Transaction → status: 'approved', amount, approvedBy, approvedAt.
 *   4. Credit the User's balance by the approved amount.
 *   5. Update User.totalDeposited.
 *   6. Send confirmation to the player via their telegramId.
 *   7. Confirm to admin.
 */
const handleApprove = async (ctx) => {
  const args = ctx.match ? ctx.match.trim().split(/\s+/) : [];

  if (args.length < 2) {
    return ctx.reply(
      '⚠️ Usage: `/approve <transactionId> <amount>`\n\nExample: `/approve 664abc123def456 150`',
      { parse_mode: 'Markdown' }
    );
  }

  const [transactionId, rawAmount] = args;
  const amount = parseFloat(rawAmount);

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ Invalid amount. Must be a positive number.');
  }

  // ── Load transaction ──────────────────────────────────────────────────────
  let txn;
  try {
    txn = await Transaction.findById(transactionId);
  } catch {
    return ctx.reply('❌ Invalid transaction ID format.');
  }

  if (!txn) {
    return ctx.reply(`❌ Transaction \`${transactionId}\` not found.`, { parse_mode: 'Markdown' });
  }
  if (txn.status !== 'pending') {
    return ctx.reply(
      `⚠️ Transaction is already *${txn.status}*. No changes made.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Approve transaction ───────────────────────────────────────────────────
  const adminTelegramId = String(ctx.from.id);

  txn.status     = 'approved';
  txn.amount     = amount;
  txn.approvedBy = adminTelegramId;
  txn.approvedAt = new Date();
  await txn.save();

  // ── Credit user balance ───────────────────────────────────────────────────
  const updatedUser = await User.findOneAndUpdate(
    { telegramId: txn.telegramId },
    {
      $inc: {
        balance:        amount,
        totalDeposited: amount,
      },
    },
    { new: true }
  );

  if (!updatedUser) {
    return ctx.reply(`⚠️ Transaction approved but user \`${txn.telegramId}\` not found in DB.`, {
      parse_mode: 'Markdown',
    });
  }

  // ── Notify the player ─────────────────────────────────────────────────────
  try {
    await ctx.api.sendMessage(
      txn.telegramId,
      `🎉 *Deposit Approved!*\n\n` +
      `✅ Your deposit of *${amount} Birr* has been verified!\n` +
      `💰 New Balance: *${updatedUser.balance.toFixed(2)} Birr*\n\n` +
      `You're all set to play! Head back to the game. 🎮`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error(`[adminHandler] Could not notify user ${txn.telegramId}:`, err.message);
  }

  // ── Confirm to admin ──────────────────────────────────────────────────────
  await ctx.reply(
    `✅ *Approved!*\n\n` +
    `👤 User: @${updatedUser.username} (\`${txn.telegramId}\`)\n` +
    `💰 Credited: *${amount} Birr*\n` +
    `🏦 New Balance: *${updatedUser.balance.toFixed(2)} Birr*\n` +
    `🆔 TxID: \`${transactionId}\``,
    { parse_mode: 'Markdown' }
  );

  console.log(
    `[adminHandler] Approved txn ${transactionId}: +${amount} Birr → user ${txn.telegramId}`
  );
};

// ─── /reject ──────────────────────────────────────────────────────────────────

/**
 * Usage: /reject <transactionId> <reason>
 */
const handleReject = async (ctx) => {
  const args = ctx.match ? ctx.match.trim().split(/\s+/) : [];

  if (args.length < 2) {
    return ctx.reply(
      '⚠️ Usage: `/reject <transactionId> <reason>`\n\nExample: `/reject 664abc123def456 Blurry screenshot`',
      { parse_mode: 'Markdown' }
    );
  }

  const [transactionId, ...reasonParts] = args;
  const reason = reasonParts.join(' ');

  let txn;
  try {
    txn = await Transaction.findById(transactionId);
  } catch {
    return ctx.reply('❌ Invalid transaction ID format.');
  }

  if (!txn)                    return ctx.reply('❌ Transaction not found.');
  if (txn.status !== 'pending') {
    return ctx.reply(`⚠️ Transaction already *${txn.status}*.`, { parse_mode: 'Markdown' });
  }

  txn.status          = 'rejected';
  txn.rejectionReason = reason;
  txn.approvedBy      = String(ctx.from.id);
  txn.approvedAt      = new Date();
  await txn.save();

  // FIX: if this was a withdrawal, release the locked funds back to available
  if (txn.type === 'withdrawal' && txn.amount > 0) {
    await User.rejectWithdrawal(txn.telegramId, txn.amount);
  }

  // Notify player
  try {
    await ctx.api.sendMessage(
      txn.telegramId,
      `❌ *Deposit Rejected*\n\n` +
      `Your deposit request (\`${transactionId}\`) was not approved.\n` +
      `📋 Reason: _${reason}_\n\n` +
      `Please re-send a clear photo of your Telebirr receipt and try again.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error(`[adminHandler] Could not notify user ${txn.telegramId}:`, err.message);
  }

  await ctx.reply(
    `🗑 *Rejected* txn \`${transactionId}\`\nReason: _${reason}_`,
    { parse_mode: 'Markdown' }
  );
};

// ─── /pending ─────────────────────────────────────────────────────────────────

/**
 * Lists the 10 oldest pending transactions.
 */
const handlePending = async (ctx) => {
  const txns = await Transaction.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(10);

  if (!txns.length) {
    return ctx.reply('✅ No pending transactions.');
  }

  const lines = txns.map((t, i) => {
    const ago = Math.round((Date.now() - t.createdAt) / 60000);
    return (
      `${i + 1}. \`${t._id}\`\n` +
      `   👤 @${t.username} (\`${t.telegramId}\`) — ${ago}m ago`
    );
  });

  await ctx.reply(
    `📋 *Pending Deposits (${txns.length}):*\n\n${lines.join('\n\n')}\n\n` +
    `Use \`/approve <id> <amount>\` or \`/reject <id> <reason>\``,
    { parse_mode: 'Markdown' }
  );
};

// ─── /balance ─────────────────────────────────────────────────────────────────

const handleBalance = async (ctx) => {
  const telegramId = ctx.match ? ctx.match.trim() : null;
  if (!telegramId) {
    return ctx.reply('Usage: `/balance <telegramId>`', { parse_mode: 'Markdown' });
  }

  const user = await User.findOne({ telegramId });
  if (!user) return ctx.reply('❌ User not found.');

  await ctx.reply(
    `👤 *@${user.username}* (\`${user.telegramId}\`)\n` +
    `💰 Balance: *${user.balance.toFixed(2)} Birr*\n` +
    `📥 Total Deposited: ${user.totalDeposited.toFixed(2)} Birr\n` +
    `🏆 Total Winnings: ${user.totalWinnings.toFixed(2)} Birr\n` +
    `🎮 Games Played: ${user.gamesPlayed} | Won: ${user.gamesWon}\n` +
    `🚫 Blocked: ${user.isBlocked ? 'Yes — ' + user.blockedReason : 'No'}`,
    { parse_mode: 'Markdown' }
  );
};

// ─── /block & /unblock ────────────────────────────────────────────────────────

const handleBlock = async (ctx) => {
  const args = ctx.match ? ctx.match.trim().split(/\s+/) : [];
  if (args.length < 2) {
    return ctx.reply('Usage: `/block <telegramId> <reason>`', { parse_mode: 'Markdown' });
  }
  const [telegramId, ...rest] = args;
  const reason = rest.join(' ');

  const user = await User.findOneAndUpdate(
    { telegramId },
    { $set: { isBlocked: true, blockedReason: reason } },
    { new: true }
  );

  if (!user) return ctx.reply('❌ User not found.');

  try {
    await ctx.api.sendMessage(
      telegramId,
      `⛔ Your account has been *blocked*.\nReason: _${reason}_\n\nContact support to appeal.`,
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}

  await ctx.reply(`🚫 Blocked @${user.username} (\`${telegramId}\`).\nReason: ${reason}`, {
    parse_mode: 'Markdown',
  });
};

const handleUnblock = async (ctx) => {
  const telegramId = ctx.match ? ctx.match.trim() : null;
  if (!telegramId) {
    return ctx.reply('Usage: `/unblock <telegramId>`', { parse_mode: 'Markdown' });
  }

  const user = await User.findOneAndUpdate(
    { telegramId },
    { $set: { isBlocked: false, blockedReason: '' } },
    { new: true }
  );

  if (!user) return ctx.reply('❌ User not found.');

  try {
    await ctx.api.sendMessage(
      telegramId,
      `✅ Your account has been *unblocked*! You can now play again. 🎮`,
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}

  await ctx.reply(`✅ Unblocked @${user.username} (\`${telegramId}\`).`, { parse_mode: 'Markdown' });
};

module.exports = {
  handleApprove,
  handleReject,
  handlePending,
  handleBalance,
  handleBlock,
  handleUnblock,
};
