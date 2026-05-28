const User = require('../models/User');
const GameSession = require('../models/GameSession');

const BROKER_FEE_PER_PLAYER = 1; // 1 Birr per participant

/**
 * PaymentService
 * ──────────────
 * All financial operations that gate or follow a game.
 * Designed for atomic, race-condition-safe MongoDB updates.
 */

// ─── Pre-game: Balance Gate ────────────────────────────────────────────────────

/**
 * Verifies that a single player can afford to join a game.
 * This is a READ-ONLY check — no funds are moved.
 *
 * Called from Socket.io handlers BEFORE addPlayer() mutates room state.
 *
 * @param {string} telegramId
 * @param {number} stakeAmount  - Birr required to enter
 * @returns {Promise<{ canJoin: boolean, reason?: string, balance?: number, shortfall?: number }>}
 */
const checkCanJoin = async (telegramId, stakeAmount) => {
  return User.canAffordStake(telegramId, stakeAmount);
};

/**
 * Bulk affordability check for all players in a room.
 * Returns a detailed report so the caller can identify exactly who can't pay.
 *
 * @param {Array<{ telegramId: string, username: string }>} players
 * @param {number} stakeAmount
 * @returns {Promise<{ allEligible: boolean, failed: Array, passed: Array }>}
 */
const checkAllPlayersCanJoin = async (players, stakeAmount) => {
  const results = await Promise.all(
    players.map(async (p) => {
      const check = await User.canAffordStake(p.telegramId, stakeAmount);
      return { ...p, ...check };
    })
  );

  const failed = results.filter((r) => !r.canJoin);
  const passed = results.filter((r) => r.canJoin);

  return { allEligible: failed.length === 0, failed, passed };
};

// ─── Post-game: Fund Release ───────────────────────────────────────────────────

/**
 * releaseFunds
 * ────────────
 * Called once a game has a verified winner.
 *
 * Steps:
 *   1. Load the GameSession by roomId to get player list and stake info.
 *   2. Calculate: totalPool = stakeAmount × playerCount
 *                 brokerFee = BROKER_FEE_PER_PLAYER × playerCount
 *                 winnerPrize = totalPool - brokerFee
 *   3. Credit the winner's balance with winnerPrize (atomic).
 *   4. Increment winner's gamesWon counter and all players' gamesPlayed.
 *   5. Update GameSession to 'completed' with winner and prize info.
 *   6. Return a full receipt object for logging / bot notification.
 *
 * @param {string} roomId
 * @param {string} winnerTelegramId
 * @returns {Promise<FundsReceipt>}
 */
const releaseFunds = async (roomId, winnerTelegramId) => {
  // ── 1. Load session ──────────────────────────────────────────────────────
  const session = await GameSession.findOne({ roomId });
  if (!session) {
    throw new Error(`[PaymentService] releaseFunds: GameSession not found for roomId ${roomId}`);
  }
  if (session.status === 'completed') {
    throw new Error(`[PaymentService] releaseFunds: Session ${roomId} already completed.`);
  }

  const playerCount  = session.players.length;
  const stakeAmount  = session.stakeAmount;
  const totalPool    = +(playerCount * stakeAmount).toFixed(2);
  const brokerFee    = +(playerCount * BROKER_FEE_PER_PLAYER).toFixed(2);
  const winnerPrize  = +(totalPool - brokerFee).toFixed(2);

  // ── 2. Credit winner ─────────────────────────────────────────────────────
  const updatedWinner = await User.findOneAndUpdate(
    { telegramId: winnerTelegramId },
    {
      $inc: {
        balance:      winnerPrize,
        totalWinnings: winnerPrize,
        totalBrokerFee: BROKER_FEE_PER_PLAYER, // winner also paid the fee
        gamesPlayed:  1,
        gamesWon:     1,
      },
    },
    { new: true }
  );

  if (!updatedWinner) {
    throw new Error(`[PaymentService] releaseFunds: Winner user not found: ${winnerTelegramId}`);
  }

  // ── 3. Increment gamesPlayed for non-winners ──────────────────────────────
  const loserTelegramIds = session.players
    .map((p) => p.telegramId)
    .filter((id) => id !== winnerTelegramId);

  if (loserTelegramIds.length) {
    await User.updateMany(
      { telegramId: { $in: loserTelegramIds } },
      {
        $inc: {
          gamesPlayed:    1,
          totalBrokerFee: BROKER_FEE_PER_PLAYER,
        },
      }
    );
  }

  // ── 4. Close the session ──────────────────────────────────────────────────
  await GameSession.findOneAndUpdate(
    { roomId },
    {
      $set: {
        status:           'completed',
        winnerTelegramId,
        totalPrizePool:   winnerPrize,
        brokerFee,
        completedAt:      new Date(),
      },
    }
  );

  const receipt = {
    roomId,
    gameType:         session.gameType,
    playerCount,
    stakeAmount,
    totalPool,
    brokerFee,
    winnerPrize,
    winnerTelegramId,
    winnerNewBalance: updatedWinner.balance,
  };

  console.log(
    `[PaymentService] Funds released | Room: ${roomId} | Winner: ${winnerTelegramId} | Prize: ${winnerPrize} Birr`
  );

  return receipt;
};

/**
 * refundAllPlayers
 * ────────────────
 * Used when a game is cancelled after stakes were already collected
 * (e.g. a player disconnects during an active game, or no winner found).
 *
 * @param {string} roomId
 * @returns {Promise<{ refunded: number, playerCount: number }>}
 */
const refundAllPlayers = async (roomId) => {
  const session = await GameSession.findOne({ roomId });
  if (!session) throw new Error(`[PaymentService] Session not found: ${roomId}`);

  const playerCount = session.players.length;
  const stakeAmount = session.stakeAmount;

  const ops = session.players.map((p) =>
    User.findOneAndUpdate(
      { telegramId: p.telegramId },
      { $inc: { balance: stakeAmount } }
    )
  );
  await Promise.allSettled(ops);

  await GameSession.findOneAndUpdate(
    { roomId },
    { $set: { status: 'cancelled', completedAt: new Date() } }
  );

  console.log(`[PaymentService] Refunded ${stakeAmount} Birr × ${playerCount} players for room ${roomId}`);
  return { refunded: stakeAmount, playerCount };
};

module.exports = {
  checkCanJoin,
  checkAllPlayersCanJoin,
  releaseFunds,
  refundAllPlayers,
  BROKER_FEE_PER_PLAYER,
};
