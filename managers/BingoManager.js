const { v4: uuidv4 } = require('uuid');
const BingoRoom = require('../rooms/BingoRoom');

const STAKE_OPTIONS = [10, 20, 50, 100, 200];

/**
 * BingoManager — One room per stake
 * Each room has 200 pre-generated cards
 * When game ends, new room created for that stake
 */
class BingoManager {
  constructor(io) {
    this.io = io;
    this.rooms      = new Map(); // roomId → BingoRoom
    this.stakeRooms = new Map(); // stake  → roomId
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  // Returns all active rooms — used to find a reconnecting player's room
  getAllRooms() {
    return Array.from(this.rooms.values());
  }

  getRoomCount() {
    return this.rooms.size;
  }

  // ✅ Get summary of all stake rooms
  getActiveRooms() {
    return STAKE_OPTIONS.map((stake) => {
      const roomId = this.stakeRooms.get(stake);
      const room   = roomId ? this.rooms.get(roomId) : null;
      return {
        stake,
        roomId:      room?.roomId    || null,
        playerCount: room?.getPlayerCount()    || 0,
        cardsTaken:  room?.getTakenCardCount() || 0,
        state:       room?.state     || 'waiting',
      };
    });
  }

  // ✅ ONE room per stake — always reuse existing waiting/countdown room
  findOrCreateRoom(stake) {
    const existingId = this.stakeRooms.get(stake);
    if (existingId) {
      const existing = this.rooms.get(existingId);
      if (existing && (existing.state === 'waiting' || existing.state === 'countdown')) {
        return { room: existing, isNew: false };
      }
    }

    // Create new room for this stake
    const roomId = `bingo_${stake}_${uuidv4()}`;
    const room   = new BingoRoom(roomId, stake, this.io);
    this.rooms.set(roomId, room);
    this.stakeRooms.set(stake, roomId);

    console.log(`[BingoManager] Created room ${roomId} (stake: ${stake} Birr).`);
    return { room, isNew: true };
  }

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
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
      const hasPlayer = [...room.players.values()].some(p => p.socketId === socketId);
      if (hasPlayer) {
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
