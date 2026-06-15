const { generateBingoCard, generateDrawPool, verifyBingoWin } = require('../services/BingoVerifier');
const { calculatePrize, refundStakes, disburseWinnings } = require('../services/BrokerService');
const User        = require('../models/User');
const GameHistory = require('../models/GameHistory');

const COUNTDOWN_DURATION_MS  = 60_000; // 60s for more players to join
const NUMBER_DRAW_INTERVAL_MS = 4_000; // draw a number every 4s
const MIN_PLAYERS_TO_START   = 2;      // minimum unique players (not cards)
const TOTAL_CARDS            = 200;    // always 200 cards per room

/**
 * BingoRoom — New System
 * ──────────────────────
 * - 200 pre-generated cards (1-200) per room
 * - Players browse cards, preview them, buy one or more
 * - Each card costs one stake
 * - Countdown starts when 2nd PLAYER (not card) joins
 * - Up to 200 cards can be bought before countdown ends
 * - Game starts after countdown finishes
 * - Winner = player whose ANY card gets bingo first
 */
class BingoRoom {
  constructor(roomId, stake, io) {
    this.roomId = roomId;
    this.stake  = stake;
    this.io     = io;

    // Pre-generate all 200 cards on room creation
    // cards: Map<cardNumber(1-200), { card: number[][], owner: telegramId|null }>
    this.cards = new Map();
    for (let i = 1; i <= TOTAL_CARDS; i++) {
      this.cards.set(i, { cardNumber: i, card: generateBingoCard(), owner: null });
    }

    // Players: Map<telegramId, { username, socketId, ownedCards: number[] }>
    this.players = new Map();

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

  // ─── Get all 200 cards for lobby display ──────────────────────────────────

  getCardsInfo() {
    return Array.from(this.cards.values()).map(({ cardNumber, card, owner }) => ({
      cardNumber,
      card,
      isTaken: owner !== null,
      owner,
    }));
  }

  getCardInfo(cardNumber) {
    return this.cards.get(cardNumber) || null;
  }

  // ─── Buy card(s) ──────────────────────────────────────────────────────────

  /**
   * Player buys one card by cardNumber
   * Balance is already deducted before calling this
   */
  buyCard(telegramId, username, socketId, cardNumber) {
    if (this.state === 'finished') {
      return { success: false, message: 'Game already finished.' };
    }
    if (this.state === 'active') {
      return { success: false, message: 'Game already in progress. Wait for next round.' };
    }

    const cardInfo = this.cards.get(cardNumber);
    if (!cardInfo) {
      return { success: false, message: 'Invalid card number.' };
    }
    if (cardInfo.owner !== null) {
      return { success: false, message: `Card #${cardNumber} is already taken.` };
    }

    // Mark card as owned
    cardInfo.owner = telegramId;

    // Add or update player
    if (!this.players.has(telegramId)) {
      this.players.set(telegramId, { username, socketId, ownedCards: [cardNumber] });
    } else {
      this.players.get(telegramId).ownedCards.push(cardNumber);
    }

    console.log(
      `[BingoRoom ${this.roomId}] ${username} bought card #${cardNumber}. ` +
      `Total players: ${this.players.size}`
    );

    // Broadcast card taken
    this.io.to(this.roomId).emit('bingo:cardTaken', {
      roomId:      this.roomId,
      cardNumber,
      playerCount: this.players.size,
    });

    // ✅ Start countdown when 2nd unique player joins
    if (this.players.size === MIN_PLAYERS_TO_START && this.state === 'waiting') {
      this._startCountdown();
    }

    return { success: true, message: `Card #${cardNumber} purchased!`, card: cardInfo.card };
  }

  async removePlayer(socketId) {
    for (const [telegramId, player] of this.players.entries()) {
      if (player.socketId === socketId) {
        // Only remove/refund if game hasn't started yet
        if (this.state === 'waiting' || this.state === 'countdown') {
          const cardCount    = player.ownedCards.length;
          const refundAmount = +(this.stake * cardCount).toFixed(2);

          // Free up their cards in memory
          for (const cardNumber of player.ownedCards) {
            const cardInfo = this.cards.get(cardNumber);
            if (cardInfo) cardInfo.owner = null;
          }
          this.players.delete(telegramId);

          // ✅ FIX #1 — Refund every Birr the player spent on cards.
          // Balance was already deducted in bingoHandlers bingo:buyCard.
          // Without this, disconnecting before game start lost the player's money.
          if (cardCount > 0) {
            try {
              await refundStakes([telegramId], refundAmount);
              console.log(
                `[BingoRoom ${this.roomId}] Refunded ${refundAmount} Birr to ` +
                `${player.username} (${cardCount} card(s) × ${this.stake} Birr) on disconnect.`
              );

              // Push updated balance to any still-active sessions for this user
              // (covers multi-device users and very fast reconnects).
              const updatedUser = await User.findOne({ telegramId });
              if (updatedUser) {
                const available = updatedUser.balance - (updatedUser.lockedBalance || 0);
                this.io
                  .to(`user:${telegramId}`)
                  .emit('user:balanceUpdated', { balance: available });
              }
            } catch (err) {
              console.error(
                `[BingoRoom ${this.roomId}] Refund FAILED for ${telegramId}:`, err.message
              );
            }
          }

          this.io.to(this.roomId).emit('bingo:playerLeft', {
            roomId:      this.roomId,
            playerCount: this.players.size,
            username:    player.username,
          });

          if (this.players.size < MIN_PLAYERS_TO_START && this.state === 'countdown') {
            this._cancelCountdown();
          }
        }
        break;
      }
    }
  }

  getPlayerCount()    { return this.players.size; }

  // Returns the cards owned by a specific player — used when they rejoin after disconnect
  getPlayerCards(telegramId) {
    const player = this.players.get(telegramId);
    if (!player) return [];
    return player.ownedCards.map(cn => ({
      cardNumber: cn,
      card: this.cards.get(cn)?.card || null,
    }));
  }
  getTakenCardCount() { return Array.from(this.cards.values()).filter(c => c.owner !== null).length; }
  isEmpty()           { return this.players.size === 0; }

  // ─── Bingo Claim ──────────────────────────────────────────────────────────

  async claimBingo(telegramId) {
    if (this.state !== 'active') {
      return { isWinner: false, message: 'Game is not active.' };
    }

    const player = this.players.get(telegramId);
    if (!player) {
      return { isWinner: false, message: 'Player not in this room.' };
    }

    // Check ALL cards owned by this player
    for (const cardNumber of player.ownedCards) {
      const cardInfo = this.cards.get(cardNumber);
      if (!cardInfo) continue;

      const { isWinner, pattern } = verifyBingoWin(cardInfo.card, this.calledNumbers);
      if (isWinner) {
        console.log(`[BingoRoom ${this.roomId}] WINNER: ${player.username} card #${cardNumber} via ${pattern}`);
        // _endGame → disburseWinnings() credits the DB. We capture winnerPrize
        // BEFORE calling _endGame so it's available in the return value.
        const prize = this.winnerPrize;
        await this._endGame([telegramId]);
        // BUG 2 FIX: include winnerPrize so bingoHandlers can push balance update
        return { isWinner: true, pattern, cardNumber, winnerPrize: prize, message: 'Bingo confirmed! 🎉' };
      }
    }

    return { isWinner: false, message: 'Not a valid Bingo yet — keep playing!' };
  }

  // ─── Private Lifecycle ────────────────────────────────────────────────────

  _startCountdown() {
    this.state         = 'countdown';
    this._countdownEnd = Date.now() + COUNTDOWN_DURATION_MS;

    this.io.to(this.roomId).emit('bingo:countdown', {
      roomId:     this.roomId,
      durationMs: COUNTDOWN_DURATION_MS,
      endsAt:     this._countdownEnd,
      message:    `Game starts in ${COUNTDOWN_DURATION_MS / 1000}s! More players can still buy cards…`,
    });

    console.log(`[BingoRoom ${this.roomId}] Countdown started. ${this.players.size} players.`);

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
  }

  async _startGame() {
    if (this.players.size < MIN_PLAYERS_TO_START) {
      this._cancelCountdown();
      return;
    }

    // Count total cards bought = total stakes collected
    const takenCards  = this.getTakenCardCount();
    const totalPool   = +(takenCards * this.stake).toFixed(2);
    const brokerFee   = +(totalPool * 0.10).toFixed(2); // 10% house fee
    const winnerPrize = +(totalPool - brokerFee).toFixed(2);

    this.totalPool   = totalPool;
    this.brokerFee   = brokerFee;
    this.winnerPrize = winnerPrize;

    this.drawPool = generateDrawPool();
    this.state    = 'active';

    console.log(
      `[BingoRoom ${this.roomId}] Game started | ` +
      `Players: ${this.players.size} | Cards: ${takenCards} | Prize: ${winnerPrize} Birr`
    );

    // ✅ Send each player their owned cards + prize info
    for (const [telegramId, player] of this.players.entries()) {
      const playerCards = player.ownedCards.map(cn => ({
        cardNumber: cn,
        card: this.cards.get(cn)?.card,
      }));

      this.io.to(player.socketId).emit('bingo:gameStarted', {
        roomId:      this.roomId,
        cards:       playerCards,   // array of cards player owns
        stake:       this.stake,
        totalPool,
        brokerFee,
        winnerPrize,
        playerCount: this.players.size,
        cardCount:   takenCards,
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

    // Bug 7 Fix: Count exactly how many cards each player bought and refund
    // only that amount. Old code divided total cards equally across all owners
    // which robbed players who bought more cards and overpaid those who bought fewer.
    const cardsByOwner = new Map();
    for (const card of this.cards.values()) {
      if (card.owner) {
        cardsByOwner.set(card.owner, (cardsByOwner.get(card.owner) || 0) + 1);
      }
    }
    for (const [telegramId, cardCount] of cardsByOwner.entries()) {
      await refundStakes([telegramId], this.stake * cardCount);
    }

    await this._saveHistory([]);
  }

  async _endGame(winnerTelegramIds) {
    if (this.state === 'finished') return;
    this.state = 'finished';
    if (this._drawTimer) clearTimeout(this._drawTimer);

    await disburseWinnings(winnerTelegramIds, this.winnerPrize);

    const winners = winnerTelegramIds.map(id => {
      const p = this.players.get(id);
      return { telegramId: id, username: p?.username };
    });

    this.io.to(this.roomId).emit('bingo:gameOver', {
      roomId:        this.roomId,
      winners,
      winnerPrize:   this.winnerPrize,
      calledNumbers: this.calledNumbers,
    });

    await this._saveHistory(winnerTelegramIds);
  }

  async _saveHistory(winnerTelegramIds) {
    try {
      const participants = [];
      for (const [telegramId, player] of this.players.entries()) {
        for (const cardNumber of player.ownedCards) {
          participants.push({
            telegramId,
            username:     player.username,
            stake:        this.stake,
            cardNumber,
            didWin:       winnerTelegramIds.includes(telegramId),
            prizeReceived: winnerTelegramIds.includes(telegramId) ? this.winnerPrize : 0,
          });
        }
      }

      await GameHistory.create({
        roomId:        this.roomId,
        gameType:      'bingo',
        participants,
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
