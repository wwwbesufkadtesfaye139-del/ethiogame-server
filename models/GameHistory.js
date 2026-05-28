const mongoose = require('mongoose');

/**
 * GameHistory model.
 * Records every completed game for audit, prize disbursement history,
 * and the broker fee collected per game.
 */
const GameHistorySchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      index: true,
    },
    gameType: {
      type: String,
      enum: ['bingo', 'ludo'],
      required: true,
    },
    participants: [
      {
        telegramId: String,
        username: String,
        stake: Number,           // Birr staked by this player
        didWin: Boolean,
        prizeReceived: Number,   // Birr received (0 for losers)
      },
    ],
    totalPool: Number,           // sum of all stakes
    brokerFee: Number,           // 1 Birr × numPlayers deducted for admin
    winnerPrize: Number,         // totalPool - brokerFee (split if multiple winners)
    winners: [String],           // telegramIds of winner(s)
    gameState: {
      type: String,
      enum: ['completed', 'cancelled', 'aborted'],
      default: 'completed',
    },
    // Bingo-specific
    calledNumbers: [Number],

    // Ludo-specific
    winCondition: Number,        // 1 | 2 | 4 kings needed to win
    ludoMaxPlayers: Number,      // 2 | 3 | 4
  },
  { timestamps: true }
);

module.exports = mongoose.model('GameHistory', GameHistorySchema);
