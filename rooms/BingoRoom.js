const { generateBingoCard, generateDrawPool, verifyBingoWin } = require('../services/BingoVerifier');
const { calculatePrize, collectStakes, refundStakes, disburseWinnings } = require('../services/BrokerService');
const GameHistory = require('../models/GameHistory');

const COUNTDOWN_DURATION_MS  = 60_000; // 60 seconds for more players to join
const NUMBER_DRAW_INTERVAL_MS = 4_000; // draw a number every 4 seconds
const MIN_PLAYERS_TO_START   = 2;
const MAX_PLAYERS_PER_ROOM   = 200;    // ✅ up to 200 players per room

/**
 * BingoRoom
 * ─────────
 * Rules:
 *   - One room per stake amount
 *   - Player picks a number 1-200 when joining
 *   - Each player gets a random 5x5 bingo card
 *   - Countdown starts when 2nd player joins
 *   - Up to 200 players can join before countdown ends
 *   - Game starts after countdown finishes
 *
 * Lifecycle:
 *   'waiting'   → open, awaiting 2nd player
 *   'countdown' → 2+ players joined, 60s window for more
 *   'active'    → numbers drawing
 *   'finished'  → winner found or all numbers exhausted
 */
class BingoRoom {
  constructor(roomId, stake, io) {
    this.roomId = roomId;
    this.stake  = stake;
    this.io     = io;

    this.players       = [];
    this.calledNumbers = [];
    this.drawPool      = [];
    this.state         = 'waiting';

    this.winnerPrize = 0;
    this.totalPool   = 0;
    this.brokerFee   = 0;

    this._countdownTimer = null;
    this._drawTimer      = null;
    this._countdownEnd   = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Adds a player to the room.
   * playerInfo: { telegramId, username, socketId, pickedNumber }
   * pickedNumber: 1-200, chosen by the player
   */
  addPlayer(playerInfo) {
    if (this.state === 'finished') {
      return { success: false, message: 'Game already finished.' };
    }
    if (this.state === 'active') {
      return { success: false, message: 'Game already in progress. Wait for next round.' };
    }
    if (this.players.length >= MAX_PLAYERS_PER_ROOM) {
      return { success: false, message: 'Room is full (200 players max).' };
    }
    if (this.players.find((p) => p.telegramId === playerInfo.telegramId)) {
      return { success: false, message: 'You are already in this room.' };
    }

    // ✅ Validate picked number 1-200
    const pickedNumber = Number(playerInfo.pickedNumber);
    if (!pickedNumber || pickedNumber < 1 || pickedNumber > 200) {
      return { success: false, message: 'Please pick a number between 1 and 200.' };
    }

    // ✅ Generate random 5x5 bingo card
    const card = generateBingoCard();

    this.players.push({ ...playerInfo, card, pickedNumber });

    console.log(
      `[BingoRoom ${this.roomId}] Player joined: ${playerInfo.username} ` +
      `(picked: ${pickedNumber}, total: ${this.players.length})`
    );

    // Broadcast updated player count
    this.io.to(this.roomId).emit('bingo:playerJoined', {
      roomId:      this.roomId,
      playerCount: this.players.length,
      username:    playerInfo.username,
    });

    // ✅ Start countdown when 2nd player joins
    if (this.players.length === MIN_PLAYERS_TO_START && this.state === 'waiting') {
      this._startCountdown();
    }

    return { success: true, message: 'Joined room.', card };
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex((p) => p.socketId === socketId);
    if (idx === -1) return;

    const [removed] = this.players.splice(idx, 1);
    console.log(`[BingoRoom ${this.roomId}] Player left: ${removed.username}`);

    if (this.state === 'waiting' || this.state === 'countdown') {
      this.io.to(this.roomId).emit('bingo:playerLeft', {
        roomId:      this.roomId,
        playerCount: this.players.length,
        username:    removed.username,
      });

      if (this.players.length < MIN_PLAYERS_TO_START && this.state === 'countdown') {
        this._cancelCountdown();
      }
    }
  }

  getPlayerCount() { return this.players.length; }
  isEmpty()        { return this.players.length === 0; }

  // ─── Bingo Claim ──────────────────────────────────────────────────────────

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
      return { isWinner: false, message: 'Not a valid Bingo yet — keep playing!' };
    }

    console.log(`[BingoRoom ${this.roomId}] WINNER: ${player.username} via ${pattern}`);
    await this._endGame([telegramId]);
    return { isWinner: true, pattern, message: 'Bingo confirmed! 🎉' };
  }

  // ─── Private Lifecycle ────────────────────────────────────────────────────

  _startCountdown() {
    this.state         = 'countdown';
    this._countdownEnd = Date.now() + COUNTDOWN_DURATION_MS;

    this.io.to(this.roomId).emit('bingo:countdown', {
      roomId:     this.roomId,
      durationMs: COUNTDOWN_DURATION_MS,
      endsAt:     this._countdownEnd,
      message:    `Game starts in ${COUNTDOWN_DURATION_MS / 1000}s! More players can still join…`,
    });

    console.log(`[BingoRoom ${this.roomId}] Countdown started. ${this.players.length} players.`);

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
      roomId:  this.roomId,
      message: 'A player left. Waiting for more players…',
    });
    console.log(`[BingoRoom ${this.roomId}] Countdown cancelled.`);
  }

  async _startGame() {
    if (this.players.length < MIN_PLAYERS_TO_START) {
      this._cancelCountdown();
      return;
    }

    const stakeResult = await collectStakes(this.players, this.stake);
    if (!stakeResult.success) {
      this.io.to(this.roomId).emit('bingo:error', {
        roomId:     this.roomId,
        message:    'A player has insufficient balance. Game cancelled.',
        telegramId: stakeResult.failed,
      });
      this.state = 'waiting';
      return;
    }

    const { totalPool, brokerFee, winnerPrize } = calculatePrize(this.players.length, this.stake);
    this.totalPool   = totalPool;
    this.brokerFee   = brokerFee;
    this.winnerPrize = winnerPrize;

    this.drawPool = generateDrawPool();
    this.state    = 'active';

    console.log(
      `[BingoRoom ${this.roomId}] Game started | ` +
      `Players: ${this.players.length} | Prize: ${winnerPrize} Birr`
    );

    // ✅ Send each player their own card
    for (const player of this.players) {
      this.io.to(player.socketId).emit('bingo:gameStarted', {
        roomId:       this.roomId,
        card:         player.card,
        pickedNumber: player.pickedNumber,
        stake:        this.stake,
        totalPool,
        brokerFee,
        winnerPrize,
        playerCount:  this.players.length,
      });
    }

    this._scheduleNextDraw();
  }

  _scheduleNextDraw() {
    if (this.state !== 'active' || this.drawPool.length === 0) {
      this._handleNoWinner();
      return;
    }

    this._drawTimer = setTimeout(() => {
      const drawnNumber = this.drawPool.shift();
      this.calledNumbers.push(drawnNumber);

      this.io.to(this.roomId).emit('bingo:numberDrawn', {
        roomId:        this.roomId,
        drawnNumber,
        calledNumbers: this.calledNumbers,
        remaining:     this.drawPool.length,
      });

      this._scheduleNextDraw();
    }, NUMBER_DRAW_INTERVAL_MS);
  }

  async _handleNoWinner() {
    this.state = 'finished';
    this.io.to(this.roomId).emit('bingo:noWinner', {
      roomId:  this.roomId,
      message: 'All numbers drawn with no winner. Stakes refunded.',
    });
    await refundStakes(this.players.map((p) => p.telegramId), this.stake);
    await this._saveHistory([]);
  }

  async _endGame(winnerTelegramIds) {
    if (this.state === 'finished') return;
    this.state = 'finished';
    if (this._drawTimer) clearTimeout(this._drawTimer);

    await disburseWinnings(winnerTelegramIds, this.winnerPrize);

    const winners = this.players.filter((p) => winnerTelegramIds.includes(p.telegramId));

    this.io.to(this.roomId).emit('bingo:gameOver', {
      roomId:        this.roomId,
      winners:       winners.map((w) => ({ telegramId: w.telegramId, username: w.username })),
      winnerPrize:   this.winnerPrize,
      calledNumbers: this.calledNumbers,
    });

    await this._saveHistory(winnerTelegramIds);
  }

  async _saveHistory(winnerTelegramIds) {
    try {
      await GameHistory.create({
        roomId:       this.roomId,
        gameType:     'bingo',
        participants: this.players.map((p) => ({
          telegramId:   p.telegramId,
          username:     p.username,
          stake:        this.stake,
          pickedNumber: p.pickedNumber,
          didWin:       winnerTelegramIds.includes(p.telegramId),
          prizeReceived: winnerTelegramIds.includes(p.telegramId)
            ? Math.floor((this.winnerPrize / winnerTelegramIds.length) * 100) / 100
            : 0,
        })),
        totalPool:     this.totalPool,
        brokerFee:     this.brokerFee,
        winnerPrize:   this.winnerPrize,
        winners:       winnerTelegramIds,
        calledNumbers: this.calledNumbers,
        gameState:     winnerTelegramIds.length ? 'completed' : 'aborted',
      });
    } catch (err) {
      console.error(`[BingoRoom ${this.roomId}] Failed to save history:`, err.message);
    }
  }

  destroy() {
    if (this._countdownTimer) clearTimeout(this._countdownTimer);
    if (this._drawTimer)      clearTimeout(this._drawTimer);
    console.log(`[BingoRoom ${this.roomId}] Room destroyed.`);
  }
}

module.exports = BingoRoom;
