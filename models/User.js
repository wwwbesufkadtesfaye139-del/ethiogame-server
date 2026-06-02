const mongoose = require('mongoose');

/**
 * User Model (UPDATED — added lockedBalance for withdrawal locking)
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
    // ✅ NEW — amount locked for a pending withdrawal
    lockedBalance: {
      type: Number,
      default: 0,
      min: [0, 'Locked balance cannot be negative.'],
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

// ✅ NEW — shows how much is actually available to play with
UserSchema.virtual('availableBalance').get(function () {
  return +(this.balance - (this.lockedBalance || 0)).toFixed(2);
});

// ─── Statics ──────────────────────────────────────────────────────────────────

/**
 * Atomically deducts amount. Returns null if balance insufficient or user blocked.
 * ✅ Uses available balance (balance - lockedBalance)
 */
UserSchema.statics.deductBalance = async function (telegramId, amount) {
  return this.findOneAndUpdate(
    {
      telegramId,
      isBlocked: false,
      $expr: {
        $gte: [
          { $subtract: ['$balance', { $ifNull: ['$lockedBalance', 0] }] },
          amount,
        ],
      },
    },
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
 * ✅ Uses available balance (balance - lockedBalance)
 */
UserSchema.statics.canAffordStake = async function (telegramId, stakeAmount) {
  const user = await this.findOne({ telegramId });
  if (!user)          return { canJoin: false, reason: 'USER_NOT_FOUND' };
  if (user.isBlocked) return { canJoin: false, reason: 'USER_BLOCKED', balance: user.balance };
  const available = user.balance - (user.lockedBalance || 0);
  if (available < stakeAmount) {
    return {
      canJoin:   false,
      reason:    'INSUFFICIENT_BALANCE',
      balance:   available,
      shortfall: +(stakeAmount - available).toFixed(2),
    };
  }
  return { canJoin: true, balance: available };
};

/**
 * ✅ NEW — Lock amount for a pending withdrawal.
 * Money stays in balance but cannot be used for games.
 */
UserSchema.statics.lockForWithdrawal = async function (telegramId, amount) {
  return this.findOneAndUpdate(
    {
      telegramId,
      isBlocked: false,
      $expr: {
        $gte: [
          { $subtract: ['$balance', { $ifNull: ['$lockedBalance', 0] }] },
          amount,
        ],
      },
    },
    { $inc: { lockedBalance: amount } },
    { new: true }
  );
};

/**
 * ✅ NEW — Approve withdrawal: deduct balance AND remove lock atomically.
 */
UserSchema.statics.approveWithdrawal = async function (telegramId, amount) {
  return this.findOneAndUpdate(
    { telegramId },
    {
      $inc: {
        balance:        -amount,
        lockedBalance:  -amount,
        totalWithdrawn:  amount,
      },
    },
    { new: true }
  );
};

/**
 * ✅ NEW — Reject withdrawal: just unlock the amount, keep balance unchanged.
 */
UserSchema.statics.rejectWithdrawal = async function (telegramId, amount) {
  return this.findOneAndUpdate(
    { telegramId },
    { $inc: { lockedBalance: -amount } },
    { new: true }
  );
};

module.exports = mongoose.model('User', UserSchema);
