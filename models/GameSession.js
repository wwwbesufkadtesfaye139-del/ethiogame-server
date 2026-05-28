const mongoose = require('mongoose');

/**
 * GameSession Model
 * ─────────────────
 * One document per completed (or cancelled) game.
 * Created at game start; winner/prize fields populated at game end.
 *
 * Replaces/extends GameHistory with richer financial and audit fields.
 */

const PlayerSnapshotSchema = new mongoose.Schema(
  {
    userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    telegramId:     { type: String, required: true },
    username:       { type: String, default: 'Anonymous' },
    stakeDeducted:  { type: Boolean, default: false },
    didWin:         { type: Boolean, default: false },
    prizeReceived:  { type: Number,  default: 0 },
  },
  { _id: false }
);

const GameSessionSchema = new mongoose.Schema(
  {
    // ── Game identity ────────────────────────────────────────────────────────
    roomId:   { type: String, required: true, unique: true, index: true },
    gameType: { type: String, enum: ['bingo', 'ludo'], required: true },

    // ── Configuration ─────────────────────────────────────────────────────────
    stakeAmount: { type: Number, required: true },   // Birr per player

    // Ludo-specific config
    winCondition:   { type: Number, default: null },  // 1 | 2 | 4 kings
    ludoMaxPlayers: { type: Number, default: null },  // 2 | 3 | 4

    // ── Participants ──────────────────────────────────────────────────────────
    players: [PlayerSnapshotSchema],

    // ── Financials (populated once stakes are collected) ──────────────────────
    /**
     * brokerFee = 1 Birr × number of players.
     * totalPrizePool = (stakeAmount × playerCount) - brokerFee.
     */
    totalPrizePool: { type: Number, default: 0 },
    brokerFee:      { type: Number, default: 0 },

    // ── Outcome ───────────────────────────────────────────────────────────────
    winnerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    winnerTelegramId: { type: String, default: null },

    status: {
      type: String,
      enum: ['pending', 'active', 'completed', 'cancelled'],
      default: 'pending',
      index: true,
    },

    // Bingo-specific
    calledNumbers: [Number],

    // ── Timestamps ────────────────────────────────────────────────────────────
    startedAt:   { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// ─── Statics ─────────────────────────────────────────────────────────────────

/**
 * Creates a new session document at game start (before stakes are collected).
 */
GameSessionSchema.statics.openSession = async function (roomId, gameType, stakeAmount, players, opts = {}) {
  return this.create({
    roomId,
    gameType,
    stakeAmount,
    players: players.map((p) => ({
      userId:    p.userId || null,
      telegramId: p.telegramId,
      username:  p.username,
    })),
    status: 'pending',
    ...opts,
  });
};

/**
 * Marks a session as active once stakes have been successfully collected.
 */
GameSessionSchema.statics.activateSession = async function (roomId, brokerFee, totalPrizePool) {
  return this.findOneAndUpdate(
    { roomId },
    {
      $set: {
        status: 'active',
        brokerFee,
        totalPrizePool,
        startedAt: new Date(),
        'players.$[].stakeDeducted': true,
      },
    },
    { new: true }
  );
};

/**
 * Closes a session with a winner. Called by releaseFunds in PaymentService.
 */
GameSessionSchema.statics.closeSession = async function (roomId, winnerTelegramId, prizeReceived) {
  return this.findOneAndUpdate(
    { roomId },
    {
      $set: {
        status: 'completed',
        winnerTelegramId,
        completedAt: new Date(),
      },
      // Mark winner in the players array
    },
    { new: true }
  );
};

module.exports = mongoose.model('GameSession', GameSessionSchema);
