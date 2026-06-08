const { calculatePrize, refundStakes, disburseWinnings } = require('../services/BrokerService');
const GameHistory = require('../models/GameHistory');

const AUTO_CANCEL_MS = 120_000;  // 120 seconds to fill the room
const DICE_SIDES = 6;
const PIECES_PER_PLAYER = 4;

// Board constants
const BOARD_PATH_LENGTH = 52;   // main loop cells (0-51)
const HOME_COLUMN_LENGTH = 5;   // cells 52-56 per player
const FINISHED_POSITION = 57;   // piece has reached home center

const PLAYER_COLORS = ['red', 'blue', 'green', 'yellow'];

// Starting positions on the main path for each color slot
const START_POSITIONS = { red: 0, blue: 13, green: 26, yellow: 39 };

/**
 * LudoRoom
 * ─────────
 * Lifecycle states:
 *   'waiting'   → room open, waiting for maxPlayers
 *   'active'    → all players joined, game in progress
 *   'finished'  → a winner has met the winCondition
 *   'cancelled' → auto-cancel fired before room filled
 */
class LudoRoom {
  /**
   * @param {string}  roomId
   * @param {object}  creatorInfo  - { telegramId, username, socketId }
   * @param {number}  maxPlayers   - 2 | 3 | 4
   * @param {number}  winCondition - number of kings (finished pieces) needed: 1 | 2 | 4
   * @param {number}  stake        - Birr per player
   * @param {object}  io           - Socket.io server instance
   */
  constructor(roomId, creatorInfo, maxPlayers, winCondition, stake, io) {
    this.roomId = roomId;
    this.maxPlayers = maxPlayers;
    this.winCondition = winCondition;
    this.stake = stake;
    this.io = io;

    // Players: { telegramId, username, socketId, color, pieces: [pos, pos, pos, pos] }
    this.players = [];
    this.state = 'waiting';
    this.currentTurnIndex = 0;  // index into this.players

    this.totalPool = 0;
    this.brokerFee = 0;
    this.winnerPrize = 0;

    this._autoCancelTimer = null;
    this._startAutoCancelTimer();

    // Add creator as first player
    this.addPlayer(creatorInfo);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {{ telegramId, username, socketId }} playerInfo
   * @returns {{ success: boolean, message: string, color?: string }}
   */
  addPlayer(playerInfo) {
    if (this.state !== 'waiting') {
      return { success: false, message: 'Room is no longer accepting players.' };
    }
    if (this.players.length >= this.maxPlayers) {
      return { success: false, message: 'Room is full.' };
    }
    if (this.players.find((p) => p.telegramId === playerInfo.telegramId)) {
      return { success: false, message: 'Already in this room.' };
    }

    const color = PLAYER_COLORS[this.players.length];
    const pieces = Array(PIECES_PER_PLAYER).fill(-1); // -1 = in base (not started)

    this.players.push({ ...playerInfo, color, pieces });

    console.log(`[LudoRoom ${this.roomId}] Player joined: ${playerInfo.username} as ${color} (${this.players.length}/${this.maxPlayers})`);

    this.io.to(this.roomId).emit('ludo:playerJoined', {
      roomId: this.roomId,
      telegramId: playerInfo.telegramId,
      username: playerInfo.username,
      color,
      playerCount: this.players.length,
      maxPlayers: this.maxPlayers,
    });

    // Start when room is full
    if (this.players.length === this.maxPlayers) {
      this._clearAutoCancelTimer();
      setImmediate(() => this._startGame());
    }

    return { success: true, message: 'Joined room.', color };
  }

  /**
   * Rolls the dice for the current player.
   * @param {string} telegramId - must match the current turn player
   * @returns {{ success: boolean, diceValue?: number, message: string }}
   */
  rollDice(telegramId) {
    if (this.state !== 'active') {
      return { success: false, message: 'Game is not active.' };
    }
    const currentPlayer = this.players[this.currentTurnIndex];
    if (currentPlayer.telegramId !== telegramId) {
      return { success: false, message: 'Not your turn.' };
    }

    const diceValue = Math.floor(Math.random() * DICE_SIDES) + 1;

    this.io.to(this.roomId).emit('ludo:diceRolled', {
      roomId: this.roomId,
      telegramId,
      username: currentPlayer.username,
      color: currentPlayer.color,
      diceValue,
      currentTurnIndex: this.currentTurnIndex,
    });

    console.log(`[LudoRoom ${this.roomId}] ${currentPlayer.username} rolled ${diceValue}`);

    // If no legal moves, auto-advance turn
    if (!this._hasLegalMove(currentPlayer, diceValue)) {
      console.log(`[LudoRoom ${this.roomId}] No legal moves for ${currentPlayer.username}. Skipping turn.`);
      this._advanceTurn();
    }

    return { success: true, diceValue, message: 'Dice rolled.' };
  }

  /**
   * Moves a piece for the current player.
   * @param {string} telegramId
   * @param {number} pieceIndex  - 0-3
   * @param {number} diceValue
   * @returns {Promise<{ success: boolean, newPosition?: number, message: string }>}
   */
  async movePiece(telegramId, pieceIndex, diceValue) {
    if (this.state !== 'active') {
      return { success: false, message: 'Game is not active.' };
    }
    const currentPlayer = this.players[this.currentTurnIndex];
    if (currentPlayer.telegramId !== telegramId) {
      return { success: false, message: 'Not your turn.' };
    }
    if (pieceIndex < 0 || pieceIndex >= PIECES_PER_PLAYER) {
      return { success: false, message: 'Invalid piece index.' };
    }

    const piece = currentPlayer.pieces[pieceIndex];
    const newPosition = this._calculateNewPosition(piece, diceValue, this.players.indexOf(currentPlayer));

    if (newPosition === null) {
      return { success: false, message: 'Illegal move.' };
    }

    currentPlayer.pieces[pieceIndex] = newPosition;

    this.io.to(this.roomId).emit('ludo:pieceMoved', {
      roomId: this.roomId,
      telegramId,
      username: currentPlayer.username,
      color: currentPlayer.color,
      pieceIndex,
      fromPosition: piece,
      toPosition: newPosition,
      diceValue,
      boardState: this._getBoardState(),
    });

    console.log(
      `[LudoRoom ${this.roomId}] ${currentPlayer.username} moved piece ${pieceIndex}: ${piece} → ${newPosition}`
    );

    // Check win condition
    const kingsCount = currentPlayer.pieces.filter((p) => p === FINISHED_POSITION).length;
    if (kingsCount >= this.winCondition) {
      await this._endGame(telegramId);
      // Bug 9 Fix: return winner so ludoHandlers can fetch updated balance and push it
      return {
        success: true,
        newPosition,
        message: 'Move made. You win!',
        winner: { telegramId: currentPlayer.telegramId, socketId: currentPlayer.socketId },
      };
    }

    // Only advance turn if dice was not a 6 (reward: roll again on 6)
    if (diceValue !== 6) {
      this._advanceTurn();
    } else {
      this.io.to(this.roomId).emit('ludo:rollAgain', {
        roomId: this.roomId,
        telegramId,
        message: `${currentPlayer.username} rolled a 6! Roll again.`,
      });
    }

    return { success: true, newPosition, message: 'Move made.' };
  }

  getPlayerCount() {
    return this.players.length;
  }

  isEmpty() {
    return this.players.length === 0;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _startAutoCancelTimer() {
    this._autoCancelTimer = setTimeout(async () => {
      if (this.state === 'waiting') {
        this.state = 'cancelled';
        console.log(`[LudoRoom ${this.roomId}] Auto-cancelled after ${AUTO_CANCEL_MS / 1000}s.`);

        // Bug 6 Fix: Refund every player who already paid their stake.
        // Before this fix, stakes were silently lost on auto-cancel.
        const User = require('../models/User');
        for (const player of this.players) {
          try {
            await User.creditBalance(player.telegramId, this.stake);
            console.log(`[LudoRoom ${this.roomId}] Refunded ${this.stake} Birr to ${player.username}`);
          } catch (err) {
            console.error(`[LudoRoom ${this.roomId}] Refund failed for ${player.telegramId}:`, err.message);
          }
        }

        // Notify the creator specifically
        const creator = this.players[0];
        if (creator) {
          this.io.to(creator.socketId).emit('ludo:roomCancelled', {
            roomId: this.roomId,
            message: 'Your room was cancelled because no one joined in time.',
          });
        }

        // Notify all others (if any partial joins)
        this.io.to(this.roomId).emit('ludo:roomCancelled', {
          roomId: this.roomId,
          message: 'Room cancelled — not enough players joined.',
        });
      }
    }, AUTO_CANCEL_MS);
  }

  _clearAutoCancelTimer() {
    if (this._autoCancelTimer) {
      clearTimeout(this._autoCancelTimer);
      this._autoCancelTimer = null;
    }
  }

  async _startGame() {
    // Stakes were already collected atomically when each player joined/created the room
    // (in ludoHandlers.js via User.deductBalance). Do NOT collect again here.
    const { totalPool, brokerFee, winnerPrize } = calculatePrize(this.players.length, this.stake);
    this.totalPool = totalPool;
    this.brokerFee = brokerFee;
    this.winnerPrize = winnerPrize;

    this.state = 'active';
    this.currentTurnIndex = 0;

    console.log(
      `[LudoRoom ${this.roomId}] Game started | Players: ${this.players.length} | winCondition: ${this.winCondition} kings | Prize: ${winnerPrize} Birr`
    );

    this.io.to(this.roomId).emit('ludo:gameStarted', {
      roomId: this.roomId,
      players: this.players.map(({ telegramId, username, color, pieces }) => ({
        telegramId, username, color, pieces,
      })),
      stake: this.stake,
      totalPool,
      brokerFee,
      winnerPrize,
      winCondition: this.winCondition,
      currentTurnTelegramId: this.players[0].telegramId,
    });
  }

  _advanceTurn() {
    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
    const nextPlayer = this.players[this.currentTurnIndex];

    this.io.to(this.roomId).emit('ludo:turnChanged', {
      roomId: this.roomId,
      currentTurnIndex: this.currentTurnIndex,
      currentTurnTelegramId: nextPlayer.telegramId,
      username: nextPlayer.username,
      color: nextPlayer.color,
    });
  }

  /**
   * Calculates the new position for a piece given a dice roll.
   * Returns null if the move is illegal.
   *
   * Rules:
   *   - Piece in base (-1): only a 6 launches it to START_POSITIONS[color]
   *   - Piece on main path (0-51): advance by diceValue (wraps around 52)
   *   - Piece entering home column (52-56): advance within it
   *   - Piece at position 56: a diceValue of 1 finishes it (57)
   *
   * @param {number} position     - current piece position
   * @param {number} diceValue
   * @param {number} playerIndex  - player's index (determines color)
   * @returns {number|null}
   */
  _calculateNewPosition(position, diceValue, playerIndex) {
    const color = PLAYER_COLORS[playerIndex];
    const startPos = START_POSITIONS[color];

    if (position === -1) {
      // Piece in base — only a 6 lets it enter the board
      return diceValue === 6 ? startPos : null;
    }

    if (position === FINISHED_POSITION) {
      // Already a king, can't move
      return null;
    }

    if (position >= 52) {
      // In home column (52-56)
      const newPos = position + diceValue;
      if (newPos === FINISHED_POSITION) return FINISHED_POSITION;
      if (newPos > FINISHED_POSITION) return null; // overshot
      return newPos;
    }

    // On main path — calculate steps relative to this player's perspective
    const stepsFromStart = (position - startPos + BOARD_PATH_LENGTH) % BOARD_PATH_LENGTH;
    const newStepsFromStart = stepsFromStart + diceValue;

    if (newStepsFromStart === BOARD_PATH_LENGTH) {
      // Entering home column at cell 52
      return 52;
    } else if (newStepsFromStart < BOARD_PATH_LENGTH) {
      return (startPos + newStepsFromStart) % BOARD_PATH_LENGTH;
    } else {
      // Move enters home column
      const homeSteps = newStepsFromStart - BOARD_PATH_LENGTH;
      const homePos = 52 + homeSteps - 1;
      if (homePos > FINISHED_POSITION) return null; // overshot
      if (homePos === FINISHED_POSITION) return FINISHED_POSITION;
      return homePos;
    }
  }

  _hasLegalMove(player, diceValue) {
    return player.pieces.some((pos, idx) => {
      const playerIndex = this.players.indexOf(player);
      return this._calculateNewPosition(pos, diceValue, playerIndex) !== null;
    });
  }

  _getBoardState() {
    return this.players.map(({ telegramId, color, pieces }) => ({ telegramId, color, pieces }));
  }

  async _endGame(winnerTelegramId) {
    if (this.state === 'finished') return;
    this.state = 'finished';

    await disburseWinnings([winnerTelegramId], this.winnerPrize);

    const winner = this.players.find((p) => p.telegramId === winnerTelegramId);

    this.io.to(this.roomId).emit('ludo:gameOver', {
      roomId: this.roomId,
      winner: { telegramId: winner.telegramId, username: winner.username, color: winner.color },
      winnerPrize: this.winnerPrize,
      winCondition: this.winCondition,
      boardState: this._getBoardState(),
    });

    await this._saveHistory([winnerTelegramId]);
  }

  async _saveHistory(winnerTelegramIds) {
    try {
      await GameHistory.create({
        roomId: this.roomId,
        gameType: 'ludo',
        participants: this.players.map((p) => ({
          telegramId: p.telegramId,
          username: p.username,
          stake: this.stake,
          didWin: winnerTelegramIds.includes(p.telegramId),
          prizeReceived: winnerTelegramIds.includes(p.telegramId) ? this.winnerPrize : 0,
        })),
        totalPool: this.totalPool,
        brokerFee: this.brokerFee,
        winnerPrize: this.winnerPrize,
        winners: winnerTelegramIds,
        winCondition: this.winCondition,
        ludoMaxPlayers: this.maxPlayers,
        gameState: winnerTelegramIds.length ? 'completed' : 'cancelled',
      });
    } catch (err) {
      console.error(`[LudoRoom ${this.roomId}] Failed to save history:`, err.message);
    }
  }

  destroy() {
    this._clearAutoCancelTimer();
    console.log(`[LudoRoom ${this.roomId}] Room destroyed.`);
  }
}

module.exports = LudoRoom;
