const { v4: uuidv4 } = require('uuid');
const { generateBingoCard, generateDrawPool, verifyBingoWin } = require('../services/BingoVerifier');
const { calculatePrize, collectStakes, refundStakes, disburseWinnings } = require('../services/BrokerService');
const GameHistory = require('../models/GameHistory');

const COUNTDOWN_DURATION_MS = 30_000;  // 30 seconds
const NUMBER_DRAW_INTERVAL_MS = 4_000; // draw a number every 4 seconds
const MIN_PLAYERS_TO_START = 2;
const MAX_PLAYERS_PER_ROOM = 50;       // sane cap per room

/**
 * BingoRoom
 * ─────────
 * Lifecycle states:
 *   'waiting'   → room open, awaiting MIN_PLAYERS_TO_START
 *   'countdown' → ≥2 players joined; 30 s window for more to join
 *   'active'    → stake collected, numbers drawing
 *   'finished'  → winner found or all 75 numbers exhausted
 */
class BingoRoom {
  /**
   * @param {string}  roomId
   * @param {number}  stake   - Birr per player
   * @param {object}  io      - Socket.io server instance
   */
  constructor(roomId, stake, io) {
    this.roomId = roomId;
    this.stake = stake;
    this.io = io;

    // Players: { telegramId, username, socketId, card }
    this.players = [];

    this.calledNumbers = [];
    this.drawPool = [];           // shuffled 1-75 pool; set at game start
    this.state = 'waiting';

    this.winnerPrize = 0;
    this.totalPool = 0;
    this.brokerFee = 0;

    this._countdownTimer = null;
    this._drawTimer = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Adds a player to the room.
   * @param {{ telegramId, username, socketId }} playerInfo
   * @returns {{ success: boolean, message: string, card?: number[][] }}
   */
  addPlayer(playerInfo) {
    if (this.state === 'finished') {
      return { success: false, message: 'Game already finished.' };
    }
    if (this.state === 'active') {
      return { success: false, message: 'Game already in progress.' };
    }
    if (this.players.length >= MAX_PLAYERS_PER_ROOM) {
      return { success: false, message: 'Room is full.' };
    }
    if (this.players.find((p) => p.telegramId === playerInfo.telegramId)) {
      return { success: false, message: 'Already in this room.' };
    }

    const card = generateBingoCard();
    this.players.push({ ...playerInfo, card });

    console.log(`[BingoRoom ${this.roomId}] Player joined: ${playerInfo.username} (${this.players.length} total)`);

    // Broadcast updated player count to the room
    this.io.to(this.roomId).emit('bingo:playerJoined', {
      roomId: this.roomId,
      playerCount: this.players.length,
      username: playerInfo.username,
    });

    // Trigger countdown when second player joins
    if (this.players.length === MIN_PLAYERS_TO_START && this.state === 'waiting') {
      this._startCountdown();
    }

    return { success: true, message: 'Joined room.', card };
  }

  /**
   * Removes a player by socketId (e.g. on disconnect).
   * If game hasn't started and player count drops to 0, emits idle state.
   */
  removePlayer(socketId) {
    const idx = this.players.findIndex((p) => p.socketId === socketId);
    if (idx === -1) return;

    const [removed] = this.players.splice(idx, 1);
    console.log(`[BingoRoom ${this.roomId}] Player left: ${removed.username}`);

    if (this.state === 'waiting' || this.state === 'countdown') {
      this.io.to(this.roomId).emit('bingo:playerLeft', {
        roomId: this.roomId,
        playerCount: this.players.length,
        username: removed.username,
      });

      // If we drop below minimum during countdown, cancel it
      if (this.players.length < MIN_PLAYERS_TO_START && this.state === 'countdown') {
        this._cancelCountdown();
      }
    }
  }

  getPlayerCount() {
    return this.players.length;
  }

  isEmpty() {
    return this.players.length === 0;
  }

  // ─── Bingo Claim (client-initiated, server-verified) ─────────────────────

  /**
   * Called when a player claims Bingo.
   * The server re-checks their card against calledNumbers — no client data is trusted.
   *
   * @param {string} telegramId
   * @returns {Promise<{ isWinner: boolean, pattern?: string, message: string }>}
   */
  async claimBingo(telegramId) {
    if (this.state !== 'active') {
      return { isWinner: false, message: 'Game is not active.' };
    }

    const player = this.players.find((p) => p.telegramId === telegramId);
    if (!player) {
      return { isWinner: false, message: 'Player not in this room.' };
    }

    const { isWinner, pattern } = verifyBingoWin(player.card, this.calledNumbers);

    if (!isWinner) {
      console.log(`[BingoRoom ${this.roomId}] False Bingo claim by ${player.username}`);
      return { isWinner: false, message: 'Invalid Bingo claim.' };
    }

    console.log(`[BingoRoom ${this.roomId}] WINNER: ${player.username} via ${pattern}`);
    await this._endGame([telegramId]);
    return { isWinner: true, pattern, message: 'Bingo confirmed!' };
  }

  // ─── Private Lifecycle ───────────────────────────────────────────────────

  _startCountdown() {
    this.state = 'countdown';

    this.io.to(this.roomId).emit('bingo:countdown', {
      roomId: this.roomId,
      durationMs: COUNTDOWN_DURATION_MS,
      message: `Game starts in ${COUNTDOWN_DURATION_MS / 1000}s! Waiting for more players…`,
    });

    console.log(`[BingoRoom ${this.roomId}] Countdown started.`);

    this._countdownTimer = setTimeout(async () => {
      await this._startGame();
    }, COUNTDOWN_DURATION_MS);
  }

  _cancelCountdown() {
    if (this._countdownTimer) {
      clearTimeout(this._countdownTimer);
      this._countdownTimer = null;
    }
    this.state = 'waiting';
    this.io.to(this.roomId).emit('bingo:countdownCancelled', {
      roomId: this.roomId,
      message: 'Not enough players. Waiting for more…',
    });
    console.log(`[BingoRoom ${this.roomId}] Countdown cancelled — too few players.`);
  }

  async _startGame() {
    if (this.players.length < MIN_PLAYERS_TO_START) {
      this._cancelCountdown();
      return;
    }

    // Collect stakes from all players
    const stakeResult = await collectStakes(this.players, this.stake);
    if (!stakeResult.success) {
      this.io.to(this.roomId).emit('bingo:error', {
        roomId: this.roomId,
        message: `Player has insufficient balance. Game cancelled.`,
        telegramId: stakeResult.failed,
      });
      this.state = 'waiting';
      return;
    }

    // Calculate prize pool
    const { totalPool, brokerFee, winnerPrize } = calculatePrize(this.players.length, this.stake);
    this.totalPool = totalPool;
    this.brokerFee = brokerFee;
    this.winnerPrize = winnerPrize;

    this.drawPool = generateDrawPool();
    this.state = 'active';

    console.log(
      `[BingoRoom ${this.roomId}] Game started | Players: ${this.players.length} | Prize: ${winnerPrize} Birr`
    );

    // Send each player their card + prize info
    for (const player of this.players) {
      this.io.to(player.socketId).emit('bingo:gameStarted', {
        roomId: this.roomId,
        card: player.card,         // player's own card (server-generated)
        stake: this.stake,
        totalPool,
        brokerFee,
        winnerPrize,
        playerCount: this.players.length,
      });
    }

    // Begin drawing numbers
    this._scheduleNextDraw();
  }

  _scheduleNextDraw() {
    if (this.state !== 'active' || this.drawPool.length === 0) {
      // All 75 numbers exhausted with no winner — rare, handle gracefully
      this._handleNoWinner();
      return;
    }

    this._drawTimer = setTimeout(() => {
      const drawnNumber = this.drawPool.shift();
      this.calledNumbers.push(drawnNumber);

      this.io.to(this.roomId).emit('bingo:numberDrawn', {
        roomId: this.roomId,
        drawnNumber,
        calledNumbers: this.calledNumbers,
        remaining: this.drawPool.length,
      });

      console.log(`[BingoRoom ${this.roomId}] Drew: ${drawnNumber} (${this.calledNumbers.length}/75)`);
      this._scheduleNextDraw();
    }, NUMBER_DRAW_INTERVAL_MS);
  }

  async _handleNoWinner() {
    this.state = 'finished';
    this.io.to(this.roomId).emit('bingo:noWinner', {
      roomId: this.roomId,
      message: 'All numbers drawn with no winner. Stakes refunded.',
    });
    await refundStakes(
      this.players.map((p) => p.telegramId),
      this.stake
    );
    await this._saveHistory([]);
  }

  async _endGame(winnerTelegramIds) {
    if (this.state === 'finished') return;
    this.state = 'finished';

    if (this._drawTimer) clearTimeout(this._drawTimer);

    await disburseWinnings(winnerTelegramIds, this.winnerPrize);

    const winners = this.players.filter((p) => winnerTelegramIds.includes(p.telegramId));

    this.io.to(this.roomId).emit('bingo:gameOver', {
      roomId: this.roomId,
      winners: winners.map((w) => ({ telegramId: w.telegramId, username: w.username })),
      winnerPrize: this.winnerPrize,
      calledNumbers: this.calledNumbers,
    });

    await this._saveHistory(winnerTelegramIds);
  }

  async _saveHistory(winnerTelegramIds) {
    try {
      await GameHistory.create({
        roomId: this.roomId,
        gameType: 'bingo',
        participants: this.players.map((p) => ({
          telegramId: p.telegramId,
          username: p.username,
          stake: this.stake,
          didWin: winnerTelegramIds.includes(p.telegramId),
          prizeReceived: winnerTelegramIds.includes(p.telegramId)
            ? Math.floor((this.winnerPrize / winnerTelegramIds.length) * 100) / 100
            : 0,
        })),
        totalPool: this.totalPool,
        brokerFee: this.brokerFee,
        winnerPrize: this.winnerPrize,
        winners: winnerTelegramIds,
        calledNumbers: this.calledNumbers,
        gameState: winnerTelegramIds.length ? 'completed' : 'aborted',
      });
    } catch (err) {
      console.error(`[BingoRoom ${this.roomId}] Failed to save history:`, err.message);
    }
  }

  destroy() {
    if (this._countdownTimer) clearTimeout(this._countdownTimer);
    if (this._drawTimer) clearTimeout(this._drawTimer);
    console.log(`[BingoRoom ${this.roomId}] Room destroyed.`);
  }
}

module.exports = BingoRoom;
