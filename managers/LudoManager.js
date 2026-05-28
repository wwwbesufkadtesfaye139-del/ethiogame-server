const { v4: uuidv4 } = require('uuid');
const LudoRoom = require('../rooms/LudoRoom');

const VALID_MAX_PLAYERS = new Set([2, 3, 4]);
const VALID_WIN_CONDITIONS = new Set([1, 2, 4]);

/**
 * LudoManager
 * ───────────
 * Central registry for all active Ludo rooms.
 * Handles room creation (with validation), lookups, cancellations,
 * and disconnection cleanup.
 */
class LudoManager {
  constructor(io) {
    this.io = io;
    /** @type {Map<string, LudoRoom>} */
    this.rooms = new Map();
  }

  // ─── Room Operations ──────────────────────────────────────────────────────

  /**
   * Creates a new Ludo room.
   *
   * @param {object} creatorInfo  - { telegramId, username, socketId }
   * @param {number} maxPlayers   - 2 | 3 | 4
   * @param {number} winCondition - 1 | 2 | 4 kings
   * @param {number} stake        - Birr per player
   * @returns {{ room: LudoRoom, roomId: string } | { error: string }}
   */
  createRoom(creatorInfo, maxPlayers, winCondition, stake) {
    if (!VALID_MAX_PLAYERS.has(maxPlayers)) {
      return { error: 'maxPlayers must be 2, 3, or 4.' };
    }
    if (!VALID_WIN_CONDITIONS.has(winCondition)) {
      return { error: 'winCondition must be 1, 2, or 4.' };
    }
    if (winCondition > 4) {
      return { error: 'winCondition cannot exceed the number of pieces per player (4).' };
    }
    if (!stake || stake <= 0) {
      return { error: 'Stake must be a positive number.' };
    }

    const roomId = `ludo_${uuidv4()}`;
    const room = new LudoRoom(roomId, creatorInfo, maxPlayers, winCondition, stake, this.io);
    this.rooms.set(roomId, room);

    // Register the auto-cancel cleanup callback
    this._watchForAutoCancel(roomId);

    console.log(
      `[LudoManager] Created room ${roomId} | maxPlayers: ${maxPlayers} | winCondition: ${winCondition} | stake: ${stake} Birr`
    );

    return { room, roomId };
  }

  /**
   * Lets a player join an existing waiting room.
   *
   * @param {string} roomId
   * @param {object} playerInfo  - { telegramId, username, socketId }
   * @returns {{ success: boolean, message: string, color?: string }}
   */
  joinRoom(roomId, playerInfo) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, message: 'Room not found.' };
    }
    if (room.state === 'cancelled') {
      return { success: false, message: 'Room was cancelled.' };
    }
    return room.addPlayer(playerInfo);
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getRoomCount() {
    return this.rooms.size;
  }

  /**
   * Returns all open rooms (state === 'waiting') as a lobby list.
   * Exposed to clients so they can browse and join rooms.
   */
  getOpenRooms() {
    const open = [];
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.state === 'waiting') {
        open.push({
          roomId,
          maxPlayers: room.maxPlayers,
          winCondition: room.winCondition,
          stake: room.stake,
          playerCount: room.getPlayerCount(),
          creatorUsername: room.players[0]?.username || 'Unknown',
        });
      }
    }
    return open;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.destroy();
      this.rooms.delete(roomId);
      console.log(`[LudoManager] Removed room ${roomId}. Total rooms: ${this.rooms.size}`);
    }
  }

  sweepStaleRooms() {
    let swept = 0;
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.state === 'finished' || room.state === 'cancelled') {
        room.destroy();
        this.rooms.delete(roomId);
        swept++;
      }
    }
    if (swept) console.log(`[LudoManager] Swept ${swept} stale room(s).`);
  }

  handleDisconnect(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      const player = room.players.find((p) => p.socketId === socketId);
      if (player) {
        // If game is active, notify room of disconnect
        if (room.state === 'active') {
          this.io.to(roomId).emit('ludo:playerDisconnected', {
            roomId,
            telegramId: player.telegramId,
            username: player.username,
          });
        }
        if (room.isEmpty() && room.state !== 'active') {
          this.removeRoom(roomId);
        }
        break;
      }
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Polls every 5s to detect rooms that were auto-cancelled and remove them.
   * This is a lightweight alternative to passing a callback into LudoRoom.
   */
  _watchForAutoCancel(roomId) {
    const interval = setInterval(() => {
      const room = this.rooms.get(roomId);
      if (!room) {
        clearInterval(interval);
        return;
      }
      if (room.state === 'cancelled' || room.state === 'finished') {
        this.removeRoom(roomId);
        clearInterval(interval);
      }
    }, 5000);
  }
}

module.exports = LudoManager;
