const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────
// FEE CHANGE (per Besu, July 2026): was a flat 1 Birr per participant,
// regardless of stake size — so a 10 Birr game paid the same house cut as
// a 200 Birr game. That's a 10% cut at the lowest tier and as little as
// 0.5% at the highest, which wasn't the intent. Replaced with a straight
// percentage of the total pool, so the cut scales with the money in play.
// ─────────────────────────────────────────────────────────────────────────
const FEE_PERCENT = 0.10; // 10% of the total pool

/**
 * Calculates the prize pool breakdown before any deductions.
 *
 * Takes totalPool directly rather than (numPlayers, stakePerPlayer) —
 * Ludo's pool is numPlayers × stake, but Bingo's pool is cardsSold × stake
 * (one player can hold several cards), so the two counts aren't
 * interchangeable. Making the caller compute its own totalPool the way it
 * already has to for its own bookkeeping removes that ambiguity instead of
 * baking one game's shape into the shared function.
 *
 * @param {number} totalPool  - sum of every stake collected for this game
 * @returns {{ totalPool: number, brokerFee: number, winnerPrize: number }}
 */
const calculatePrize = (totalPool) => {
  const brokerFee = Math.floor(totalPool * FEE_PERCENT * 100) / 100;
  const winnerPrize = Math.round((totalPool - brokerFee) * 100) / 100;
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

module.exports = { calculatePrize, collectStakes, refundStakes, disburseWinnings, FEE_PERCENT };
