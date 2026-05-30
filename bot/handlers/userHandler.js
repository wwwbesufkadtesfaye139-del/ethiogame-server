const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const MESSAGES = require('../utils/messages');

/**
 * userHandler.js
 * ──────────────
 * Handlers for player-facing bot commands.
 *
 * Commands:
 *   /start    — Welcome message + register user
 *   /balance  — Show current Birr balance
 *   /deposit  — Prompt user to send Telebirr screenshot
 *   /history  — Show last 5 transactions
 */

// ── /start ────────────────────────────────────────────────────────────────────
const handleStart = async (ctx) => {
  const from = ctx.from;
  const user = await User.findOrCreateFromTelegram(from);

  if (user.isBlocked) {
    return ctx.reply(MESSAGES.accountBlocked, { parse_mode: 'Markdown' });
  }

  await ctx.reply(
    `👋 Welcome${user.totalGamesPlayed > 0 ? ' back' : ''}, *${from.first_name}*!\n\n` +
    `💰 Balance: *${user.balance.toFixed(2)} Birr*\n\n` +
    `Use the commands below to get started:\n` +
    `/deposit — Top up your balance\n` +
    `/balance — Check your balance\n` +
    `/history — View recent transactions`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '💰 Balance' }, { text: '📥 Deposit' }],
          [{ text: '📜 History' }, { text: '🎮 Play' }],
        ],
        resize_keyboard: true,
        persistent: true,
      },
    }
  );
};

// ── /balance ──────────────────────────────────────────────────────────────────
const handleBalance = async (ctx) => {
  const user = await User.findOne({ telegramId: String(ctx.from.id) });
  if (!user) return ctx.reply('Please use /start first.');
  await ctx.reply(MESSAGES.balance(user.balance), { parse_mode: 'Markdown' });
};

// ── /deposit ──────────────────────────────────────────────────────────────────
const handleDeposit = async (ctx) => {
  const user = await User.findOne({ telegramId: String(ctx.from.id) });
  if (!user) return ctx.reply('Please use /start first.');
  if (user.isBlocked) return ctx.reply(MESSAGES.accountBlocked, { parse_mode: 'Markdown' });

  await ctx.reply(MESSAGES.depositPrompt, {
    parse_mode: 'Markdown',
    reply_markup: { remove_keyboard: true },
  });
};

// ── /history ──────────────────────────────────────────────────────────────────
const handleHistory = async (ctx) => {
  const telegramId = String(ctx.from.id);
  const txs = await Transaction.find({ telegramId })
    .sort({ createdAt: -1 })
    .limit(5);

  if (!txs.length) {
    return ctx.reply('No transaction history yet.\nUse /deposit to top up.', {
      parse_mode: 'Markdown',
    });
  }

  const lines = txs.map((tx, i) => {
    const shortId = tx._id.toString().slice(-8).toUpperCase();
    const emoji =
      tx.status === 'approved' ? '✅' : tx.status === 'rejected' ? '❌' : '⏳';
    const amountStr = tx.amount > 0 ? `${tx.amount.toFixed(2)} Birr` : 'Awaiting review';
    return `${i + 1}. ${emoji} *${tx.type.toUpperCase()}* — ${amountStr} — \`#${shortId}\``;
  });

  await ctx.reply(
    `📜 *Recent Transactions*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
};

module.exports = { handleStart, handleBalance, handleDeposit, handleHistory };
