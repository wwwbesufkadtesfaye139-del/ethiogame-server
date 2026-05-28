const { v4: uuidv4 } = require('uuid');
const BingoRoom = require('../rooms/BingoRoom');

const MAX_BINGO_ROOMS = 200;

/**
 * BingoManager
 * ────────────
 * Central registry for all active Bingo rooms.
 * Enforces the 200-room cap and provides smart room matching:
 * a player joining a specific stake tier is placed into an existing
 * 'waiting' or 'countdown' room first; a new room is only created
 * when none is available.
 */
class BingoManager {
  constructor(io) {
    this.io = io;
    /** @type {Map<string, BingoRoom>} */
    this.rooms = new Map();
  }

  // ─── Room Lookup ──────────────────────────────────────────────────────────

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getRoomCount() {
    return this.rooms.size;
  }

  // ─── Join or Create ───────────────────────────────────────────────────────

  /**
   * Finds an available room for the given stake, or creates one.
   * Returns null with a reason if capacity is reached.
   *
   * @param {number} stake
   * @returns {{ room: BingoRoom, isNew: boolean } | { room: null, reason: string }}
   */
  findOrCreateRoom(stake) {
    // Try to find an existing open room with the same stake
    for (const room of this.rooms.values()) {
      if (
        room.stake === stake &&
        (room.state === 'waiting' || room.state === 'countdown')
      ) {
        return { room, isNew: false };
      }
    }

    // No open room found — create a new one
    if (this.rooms.size >= MAX_BINGO_ROOMS) {
      return { room: null, reason: 'Server is at full capacity (200 rooms). Please try again shortly.' };
    }

    const roomId = `bingo_${uuidv4()}`;
    const room = new BingoRoom(roomId, stake, this.io);
    this.rooms.set(roomId, room);
    console.log(`[BingoManager] Created room ${roomId} (stake: ${stake} Birr). Total rooms: ${this.rooms.size}`);
    return { room, isNew: true };
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Removes a finished or empty room from the registry.
   * Should be called after 'bingo:gameOver' or 'bingo:noWinner' events.
   *
   * @param {string} roomId
   */
  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.destroy();
      this.rooms.delete(roomId);
      console.log(`[BingoManager] Removed room ${roomId}. Total rooms: ${this.rooms.size}`);
    }
  }

  /**
   * Sweep stale rooms — rooms that are 'finished' or 'waiting' and empty.
   * Call this periodically (e.g. every 5 minutes) to prevent leaks.
   */
  sweepStaleRooms() {
    let swept = 0;
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.state === 'finished' || (room.state === 'waiting' && room.isEmpty())) {
        room.destroy();
        this.rooms.delete(roomId);
        swept++;
      }
    }
    if (swept) console.log(`[BingoManager] Swept ${swept} stale room(s).`);
  }

  /**
   * Given a socket that disconnected, find their room and remove them.
   * Removes the room if it becomes empty and finished.
   *
   * @param {string} socketId
   */
  handleDisconnect(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      const hadPlayer = room.players.some((p) => p.socketId === socketId);
      if (hadPlayer) {
        room.removePlayer(socketId);
        if (room.isEmpty() && room.state !== 'active') {
          this.removeRoom(roomId);
        }
        break;
      }
    }
  }
}

module.exports = BingoManager;
