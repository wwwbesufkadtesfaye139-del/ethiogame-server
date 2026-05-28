const mongoose = require('mongoose');

/**
 * Transaction Model
 * ─────────────────
 * Records every deposit and withdrawal request.
 * Deposits are initiated when a user sends a Telebirr receipt photo to the bot.
 * An admin must manually approve or reject each transaction.
 *
 * Flow:
 *   User sends photo  → status: 'pending'
 *   Admin /approve    → status: 'approved', balance credited
 *   Admin /reject     → status: 'rejected', user notified
 */
const TransactionSchema = new mongoose.Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    telegramId: { type: String, required: true, index: true },
    username:   { type: String, default: 'Anonymous' },

    // ── Financial ─────────────────────────────────────────────────────────────
    amount:   { type: Number, default: 0, min: 0 }, // set by admin on approval
    type:     { type: String, enum: ['deposit', 'withdrawal'], required: true },
    currency: { type: String, default: 'ETB' },

    // ── Status lifecycle ──────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    rejectionReason: { type: String, default: '' },

    // ── Evidence ─────────────────────────────────────────────────────────────
    screenshotFileId: { type: String, default: '' }, // Telegram Bot API file_id
    screenshotUrl:    { type: String, default: '' }, // optional cloud mirror URL

    // ── Telebirr-specific ─────────────────────────────────────────────────────
    telebirrReference: {
      type: String,
      default: '',
      index: { sparse: true },
    },

    // ── Admin audit ───────────────────────────────────────────────────────────
    approvedBy: { type: String, default: '' }, // admin telegramId
    approvedAt: { type: Date,   default: null },
    reviewNote: { type: String, default: '' },
  },
  { timestamps: true }
);

TransactionSchema.index({ telegramId: 1, status: 1 });

// ─── Statics ─────────────────────────────────────────────────────────────────

TransactionSchema.statics.getPendingQueue = function () {
  return this.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .populate('userId', 'username balance');
};

TransactionSchema.statics.countPendingByUser = function (telegramId) {
  return this.countDocuments({ telegramId, status: 'pending' });
};

module.exports = mongoose.model('Transaction', TransactionSchema);
