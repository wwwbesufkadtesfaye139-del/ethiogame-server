const User = require('../models/User');

const BROKER_FEE_PER_PLAYER = 1; // 1 Birr per participant

/**
 * Calculates the prize pool breakdown before any deductions.
 *
 * @param {number} numPlayers
 * @param {number} stakePerPlayer  - Birr each player puts in
 * @returns {{ totalPool: number, brokerFee: number, winnerPrize: number }}
 */
const calculatePrize = (numPlayers, stakePerPlayer) => {
  const totalPool = numPlayers * stakePerPlayer;
  const brokerFee = numPlayers * BROKER_FEE_PER_PLAYER;
  const winnerPrize = totalPool - brokerFee;
  return { totalPool, brokerFee, winnerPrize };
};

/**
 * Deducts the stake from every participant's balance atomically.
 * Returns a result object detailing which players succeeded or failed.
 *
 * Strategy:
 *   1. Attempt to deduct from each player in sequence.
 *   2. If any player has insufficient funds, refund already-deducted players
 *      and return a failure result.
 *
 * @param {Array<{ telegramId: string, username: string }>} players
 * @param {number} stakePerPlayer
 * @returns {Promise<{ success: boolean, deducted: string[], failed: string|null }>}
 */
const collectStakes = async (players, stakePerPlayer) => {
  const deducted = [];

  for (const player of players) {
    const updated = await User.deductBalance(player.telegramId, stakePerPlayer);

    if (!updated) {
      // This player has insufficient balance — refund everyone already charged
      await refundStakes(deducted, stakePerPlayer);
      return { success: false, deducted, failed: player.telegramId };
    }

    deducted.push(player.telegramId);
  }

  return { success: true, deducted, failed: null };
};

/**
 * Refunds a stake back to a list of players (used on collection failure or cancellation).
 *
 * @param {string[]} telegramIds
 * @param {number} stakePerPlayer
 */
const refundStakes = async (telegramIds, stakePerPlayer) => {
  const ops = telegramIds.map((id) =>
    User.findOneAndUpdate({ telegramId: id }, { $inc: { balance: stakePerPlayer } })
  );
  await Promise.allSettled(ops);
  console.log(`[Broker] Refunded ${stakePerPlayer} Birr to ${telegramIds.length} player(s).`);
};

/**
 * Credits the winnerPrize to one or more winners.
 * If there are multiple winners (e.g. Bingo tie is not expected but Ludo may have one winner),
 * the prize is split equally.
 *
 * @param {string[]} winnerTelegramIds
 * @param {number} winnerPrize  - total prize pool after broker fee
 */
const disburseWinnings = async (winnerTelegramIds, winnerPrize) => {
  if (!winnerTelegramIds.length) return;

  const prizePerWinner = Math.floor((winnerPrize / winnerTelegramIds.length) * 100) / 100;

  const ops = winnerTelegramIds.map((id) => User.creditBalance(id, prizePerWinner));
  await Promise.allSettled(ops);

  console.log(
    `[Broker] Disbursed ${prizePerWinner} Birr to each of ${winnerTelegramIds.length} winner(s).`
  );
};

module.exports = { calculatePrize, collectStakes, refundStakes, disburseWinnings, BROKER_FEE_PER_PLAYER };
