const { v4: uuidv4 } = require('uuid');
const BingoRoom = require('../rooms/BingoRoom');

const STAKE_OPTIONS = [10, 20, 50, 100, 200]; // ✅ fixed stake tiers

/**
 * BingoManager
 * ────────────
 * ✅ ONE room per stake amount
 * When a player joins a stake tier, they always go into the same room
 * until that room fills (200 players) or the game starts.
 * After the game ends, a new room is created for that stake tier.
 */
class BingoManager {
  constructor(io) {
    this.io = io;
    /** @type {Map<string, BingoRoom>} roomId → BingoRoom */
    this.rooms = new Map();
    /** @type {Map<number, string>} stake → roomId (active waiting/countdown room) */
    this.stakeRooms = new Map();
  }

  // ─── Room Lookup ──────────────────────────────────────────────────────────

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getRoomCount() {
    return this.rooms.size;
  }

  // ✅ Get all current waiting/countdown rooms (one per stake)
  getActiveRooms() {
    return STAKE_OPTIONS.map((stake) => {
      const roomId = this.stakeRooms.get(stake);
      const room   = roomId ? this.rooms.get(roomId) : null;
      return {
        stake,
        roomId:      room?.roomId || null,
        playerCount: room?.getPlayerCount() || 0,
        state:       room?.state || 'waiting',
        isAvailable: !room || room.state === 'waiting' || room.state === 'countdown',
      };
    });
  }

  // ─── Find or Create Room (ONE per stake) ─────────────────────────────────

  findOrCreateRoom(stake) {
    // Check if there's already an open room for this stake
    const existingRoomId = this.stakeRooms.get(stake);
    if (existingRoomId) {
      const existingRoom = this.rooms.get(existingRoomId);
      if (existingRoom && (existingRoom.state === 'waiting' || existingRoom.state === 'countdown')) {
        return { room: existingRoom, isNew: false };
      }
    }

    // No open room — create a new one for this stake tier
    const roomId = `bingo_${stake}_${uuidv4()}`;
    const room   = new BingoRoom(roomId, stake, this.io);
    this.rooms.set(roomId, room);
    this.stakeRooms.set(stake, roomId); // ✅ register as the active room for this stake

    console.log(`[BingoManager] Created room ${roomId} (stake: ${stake} Birr).`);
    return { room, isNew: true };
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      // Remove from stakeRooms if this was the active room for its stake
      if (this.stakeRooms.get(room.stake) === roomId) {
        this.stakeRooms.delete(room.stake);
      }
      room.destroy();
      this.rooms.delete(roomId);
      console.log(`[BingoManager] Removed room ${roomId}.`);
    }
  }

  sweepStaleRooms() {
    let swept = 0;
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.state === 'finished' || (room.state === 'waiting' && room.isEmpty())) {
        if (this.stakeRooms.get(room.stake) === roomId) {
          this.stakeRooms.delete(room.stake);
        }
        room.destroy();
        this.rooms.delete(roomId);
        swept++;
      }
    }
    if (swept) console.log(`[BingoManager] Swept ${swept} stale room(s).`);
  }

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
