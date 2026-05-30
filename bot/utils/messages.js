/**
 * messages.js
 * ───────────
 * Centralised string templates for every bot message.
 * Keeping all copy here makes translations and edits trivial.
 * Use the helper functions rather than inline string literals.
 */

const MESSAGES = {
  // ── Onboarding ─────────────────────────────────────────────────────────────
  welcome: (firstName) =>
    `👋 Welcome to the Gaming Platform, ${firstName}!\n\n` +
    `You can play *Bingo* and *Ludo* for real Birr.\n\n` +
    `Use the buttons below to top-up your balance or start playing.\n\n` +
    `Your current balance: *0.00 Birr*`,

  balance: (balance) =>
    `💰 Your current balance: *${Number(balance).toFixed(2)} Birr*`,

  accountBlocked:
    `🚫 Your account has been suspended.\n` +
    `Please contact admin for support.`,

  // ── Deposit Flow ───────────────────────────────────────────────────────────
  depositPrompt:
    `📸 Please send a screenshot of your *Telebirr receipt* to deposit funds.\n\n` +
    `Make sure the transfer amount is clearly visible in the screenshot.`,

  depositConfirmQuestion: (filePreview) =>
    `📎 Screenshot received!\n\n` +
    `Is this a *Telebirr deposit receipt* for your account balance?\n\n` +
    `Reply *Yes* to submit it for review, or *No* to cancel.`,

  depositSubmitted: (shortId) =>
    `✅ Receipt submitted!\n\n` +
    `Your deposit request *#${shortId}* is pending admin review.\n` +
    `You will be notified once it's approved. This usually takes a few minutes.`,

  depositCancelled:
    `❌ Deposit cancelled. Send /deposit when you're ready to try again.`,

  // ── Approval / Rejection (sent to USER) ───────────────────────────────────
  depositApproved: (amount, newBalance) =>
    `🎉 *Deposit Approved!*\n\n` +
    `Your deposit of *${Number(amount).toFixed(2)} Birr* has been verified!\n` +
    `💰 New balance: *${Number(newBalance).toFixed(2)} Birr*\n\n` +
    `You can now join any game. Good luck! 🍀`,

  depositRejected: (reason) =>
    `❌ *Deposit Rejected*\n\n` +
    `Your deposit request could not be approved.\n` +
    `Reason: _${reason || 'Screenshot unclear or amount mismatch.'}_\n\n` +
    `Please send a new screenshot or contact support.`,

  // ── Admin Notifications ────────────────────────────────────────────────────
  adminNewDeposit: (username, telegramId, shortId) =>
    `🔔 *New Deposit Request*\n\n` +
    `👤 User: @${username} (ID: \`${telegramId}\`)\n` +
    `🆔 Transaction: \`#${shortId}\`\n\n` +
    `To approve:\n\`/approve ${shortId} <amount>\`\n\n` +
    `To reject:\n\`/reject ${shortId} <reason>\``,

  adminApproveSuccess: (username, amount, shortId) =>
    `✅ Transaction \`#${shortId}\` approved.\n` +
    `@${username} credited *${Number(amount).toFixed(2)} Birr*.`,

  adminRejectSuccess: (username, shortId) =>
    `🗑 Transaction \`#${shortId}\` rejected. @${username} notified.`,

  adminUnknownTransaction: (shortId) =>
    `❌ No pending transaction found with ID \`#${shortId}\`.`,

  adminNotAuthorised:
    `⛔ You are not authorised to run admin commands.`,

  // ── Game Entry ─────────────────────────────────────────────────────────────
  insufficientBalance: (stake, balance) =>
    `💸 *Insufficient Balance*\n\n` +
    `This game requires *${Number(stake).toFixed(2)} Birr*.\n` +
    `Your balance: *${Number(balance).toFixed(2)} Birr*.\n\n` +
    `Use /deposit to top up your account.`,

  gameJoined: (gameType, stake, winnerPrize) =>
    `🎮 You joined a *${gameType.toUpperCase()}* game!\n\n` +
    `Stake: *${Number(stake).toFixed(2)} Birr*\n` +
    `Prize Pool: *${Number(winnerPrize).toFixed(2)} Birr* (after broker fee)\n\n` +
    `Good luck! 🍀`,

  // ── Errors ─────────────────────────────────────────────────────────────────
  genericError:
    `⚠️ Something went wrong. Please try again or contact support.`,

  commandUsageApprove:
    `Usage: \`/approve <transactionShortId> <amount>\`\n` +
    `Example: \`/approve AB12CD34 500\``,

  commandUsageReject:
    `Usage: \`/reject <transactionShortId> <reason>\`\n` +
    `Example: \`/reject AB12CD34 Amount does not match\``,
};

module.exports = MESSAGES;
