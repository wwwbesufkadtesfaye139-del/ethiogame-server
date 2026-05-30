require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Bot, session } = require('grammy');
const connectDB        = require('../config/db');

const { attachUser, adminOnly }       = require('./middleware/authMiddleware');
const { onPhotoReceived, onDepositCallback } = require('./handlers/depositHandler');
const {
  handleApprove,
  handleReject,
  handlePending,
  handleBalance,
  handleBlock,
  handleUnblock,
} = require('./handlers/adminHandler');

const User = require('../models/User');

// ─── Validate env ─────────────────────────────────────────────────────────────

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('[Bot] TELEGRAM_BOT_TOKEN is required. Add it to .env');
  process.exit(1);
}

// ─── Bot init ─────────────────────────────────────────────────────────────────

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Connect to MongoDB
connectDB();

// ─── Global middleware ────────────────────────────────────────────────────────

// Attach dbUser to every ctx; block blocked users
bot.use(attachUser);

// ─── Public commands ──────────────────────────────────────────────────────────

/**
 * /start  — Welcome message + wallet balance
 */
bot.command('start', async (ctx) => {
  const user = ctx.dbUser;
  await ctx.reply(
    `👋 Welcome to *EthioGame*, ${user.displayName}!\n\n` +
    `🎮 Play Bingo & Ludo for real Birr prizes.\n\n` +
    `💰 *Your Balance:* ${user.balance.toFixed(2)} Birr\n\n` +
    `📱 Open the Mini App to start playing.\n\n` +
    `To deposit, simply *send a photo* of your Telebirr receipt here and follow the prompts.`,
    { parse_mode: 'Markdown' }
  );
});

/**
 * /balance  — Check own balance
 */
bot.command('balance', async (ctx) => {
  const user = ctx.dbUser;
  await ctx.reply(
    `💰 *Your Wallet*\n\n` +
    `Balance: *${user.balance.toFixed(2)} Birr*\n` +
    `Total Deposited: ${user.totalDeposited.toFixed(2)} Birr\n` +
    `Total Winnings: ${user.totalWinnings.toFixed(2)} Birr\n` +
    `Games Played: ${user.gamesPlayed} | Won: ${user.gamesWon}`,
    { parse_mode: 'Markdown' }
  );
});

/**
 * /help  — Command reference
 */
bot.command('help', async (ctx) => {
  const adminSection = ctx.isAdmin
    ? `\n\n*🔐 Admin Commands:*\n` +
      `/approve <txId> <amount> — Approve a deposit\n` +
      `/reject <txId> <reason>  — Reject a deposit\n` +
      `/pending                 — List pending deposits\n` +
      `/checkbalance <id>       — Check a user's balance\n` +
      `/block <id> <reason>     — Block a user\n` +
      `/unblock <id>            — Unblock a user`
    : '';

  await ctx.reply(
    `*EthioGame Bot Commands*\n\n` +
    `/start   — Welcome & balance\n` +
    `/balance — Your wallet info\n` +
    `/help    — This message\n\n` +
    `📸 *To deposit:* Just send a photo of your Telebirr receipt!` +
    adminSection,
    { parse_mode: 'Markdown' }
  );
});

// ─── Deposit flow ─────────────────────────────────────────────────────────────

/**
 * Any photo sent to the bot triggers the deposit confirmation flow.
 */
bot.on('message:photo', onPhotoReceived);

/**
 * Inline keyboard callbacks for deposit confirmation.
 * Pattern matches "deposit_confirm:yes:*" and "deposit_confirm:no:*"
 */
bot.callbackQuery(/^deposit_confirm:(yes|no):\d+$/, onDepositCallback);

// ─── Admin commands ───────────────────────────────────────────────────────────

bot.command('approve',      adminOnly, async (ctx) => {
  // ctx.match is the text after the command
  ctx.match = ctx.message.text.replace('/approve', '').replace(`@${ctx.me.username}`, '').trim();
  return handleApprove(ctx);
});

bot.command('reject',       adminOnly, async (ctx) => {
  ctx.match = ctx.message.text.replace('/reject', '').replace(`@${ctx.me.username}`, '').trim();
  return handleReject(ctx);
});

bot.command('pending',      adminOnly, handlePending);

bot.command('checkbalance', adminOnly, async (ctx) => {
  ctx.match = ctx.message.text.replace('/checkbalance', '').replace(`@${ctx.me.username}`, '').trim();
  return handleBalance(ctx);
});

bot.command('block',        adminOnly, async (ctx) => {
  ctx.match = ctx.message.text.replace('/block', '').replace(`@${ctx.me.username}`, '').trim();
  return handleBlock(ctx);
});

bot.command('unblock',      adminOnly, async (ctx) => {
  ctx.match = ctx.message.text.replace('/unblock', '').replace(`@${ctx.me.username}`, '').trim();
  return handleUnblock(ctx);
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  const { ctx, error } = err;
  console.error(`[Bot] Unhandled error for update ${ctx.update.update_id}:`, error);
});

// ─── Start polling ────────────────────────────────────────────────────────────

bot.start({
  onStart: (info) => {
    console.log(`\n🤖 Bot @${info.username} started (long-polling)`);
    console.log(`   Admin IDs: ${process.env.ADMIN_TELEGRAM_IDS || 'none configured'}\n`);
  },
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.once('SIGINT',  () => bot.stop());
process.once('SIGTERM', () => bot.stop());

module.exports = bot; // exported for testing
