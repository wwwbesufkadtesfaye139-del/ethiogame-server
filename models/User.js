const mongoose = require('mongoose');

/**
 * User Model
 * ──────────
 * Central identity and wallet record for every player.
 * All monetary values are in Ethiopian Birr (ETB).
 *
 * Key invariant: balance must never go negative.
 * All mutations go through the static helper methods below, which
 * use atomic MongoDB operations to prevent race conditions.
 */
const UserSchema = new mongoose.Schema(
  {
    telegramId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    username: {
      type: String,
      default: 'Anonymous',
      trim: true,
    },
    firstName: { type: String, default: '' },
    lastName:  { type: String, default: '' },

    // ── Wallet ─────────────────────────────────────────────────────────────
    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative.'],
    },

    // ── Lifetime stats ─────────────────────────────────────────────────────
    totalDeposited: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    totalWinnings:  { type: Number, default: 0 },
    totalBrokerFee: { type: Number, default: 0 },
    gamesPlayed:    { type: Number, default: 0 },
    gamesWon:       { type: Number, default: 0 },

    // ── Access control ─────────────────────────────────────────────────────
    isBlocked:     { type: Boolean, default: false },
    blockedReason: { type: String,  default: '' },
    isAdmin:       { type: Boolean, default: false },

    notificationsEnabled: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: { virtuals: true } }
);

// ─── Virtuals ──────────────────────────────────────────────────────────────────

UserSchema.virtual('displayName').get(function () {
  return this.username || this.firstName || `User_${this.telegramId}`;
});

// ─── Statics ──────────────────────────────────────────────────────────────────

/**
 * Atomically deducts amount. Returns null if balance insufficient or user blocked.
 */
UserSchema.statics.deductBalance = async function (telegramId, amount) {
  return this.findOneAndUpdate(
    { telegramId, balance: { $gte: amount }, isBlocked: false },
    { $inc: { balance: -amount } },
    { new: true }
  );
};

/**
 * Atomically credits amount. Increments totalWinnings when isWinning=true.
 */
UserSchema.statics.creditBalance = async function (telegramId, amount, isWinning = false) {
  const inc = { balance: amount };
  if (isWinning) inc.totalWinnings = amount;
  return this.findOneAndUpdate(
    { telegramId },
    { $inc: inc },
    { new: true, upsert: true }
  );
};

/**
 * Returns a detailed affordability check without mutating any data.
 */
UserSchema.statics.canAffordStake = async function (telegramId, stakeAmount) {
  const user = await this.findOne({ telegramId });
  if (!user)               return { canJoin: false, reason: 'USER_NOT_FOUND' };
  if (user.isBlocked)      return { canJoin: false, reason: 'USER_BLOCKED',            balance: user.balance };
  if (user.balance < stakeAmount) {
    return {
      canJoin: false,
      reason: 'INSUFFICIENT_BALANCE',
      balance: user.balance,
      shortfall: +(stakeAmount - user.balance).toFixed(2),
    };
  }
  return { canJoin: true, balance: user.balance };
};

module.exports = mongoose.model('User', UserSchema);
