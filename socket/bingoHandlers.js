/**
 * bingoHandlers.js
 * ────────────────
 * Registers all Socket.io event listeners for the Bingo game.
 * Each handler validates input, interacts with BingoManager, and
 * uses acknowledgement callbacks (ack) to respond directly to the caller.
 *
 * Socket.io Events — Client → Server:
 *   bingo:join        { telegramId, username, stake }
 *   bingo:claimBingo  { telegramId, roomId }
 *
 * Socket.io Events — Server → Client (broadcasts):
 *   bingo:joined        { roomId, card, playerCount, stake }
 *   bingo:playerJoined  { roomId, playerCount, username }
 *   bingo:playerLeft    { roomId, playerCount, username }
 *   bingo:countdown     { roomId, durationMs, message }
 *   bingo:countdownCancelled { roomId, message }
 *   bingo:gameStarted   { roomId, card, stake, totalPool, brokerFee, winnerPrize, playerCount }
 *   bingo:numberDrawn   { roomId, drawnNumber, calledNumbers, remaining }
 *   bingo:claimResult   { roomId, telegramId, isWinner, pattern, message }
 *   bingo:gameOver      { roomId, winners, winnerPrize, calledNumbers }
 *   bingo:noWinner      { roomId, message }
 *   bingo:error         { roomId, message }
 */

const registerBingoHandlers = (socket, bingoManager) => {
  const { id: socketId } = socket;

  // ── bingo:join ─────────────────────────────────────────────────────────────
  // Player wants to join a Bingo game at a specific stake level.
  // Server finds or creates a room and places them in it.
  socket.on('bingo:join', ({ telegramId, username, stake } = {}, ack) => {
    if (!telegramId || !username || !stake || isNaN(stake) || stake <= 0) {
      return safAck(ack, { success: false, message: 'Invalid join payload.' });
    }

    const { room, isNew, reason } = bingoManager.findOrCreateRoom(stake);
    if (!room) {
      return safAck(ack, { success: false, message: reason });
    }

    // Join the Socket.io room (for broadcasting)
    socket.join(room.roomId);

    const result = room.addPlayer({ telegramId, username, socketId });
    if (!result.success) {
      socket.leave(room.roomId);
      return safAck(ack, result);
    }

    // Schedule cleanup once this room finishes
    _scheduleRoomCleanup(room, bingoManager);

    safAck(ack, {
      success: true,
      roomId: room.roomId,
      card: result.card,
      playerCount: room.getPlayerCount(),
      stake,
      isNewRoom: isNew,
      message: 'Joined Bingo room.',
    });
  });

  // ── bingo:claimBingo ───────────────────────────────────────────────────────
  // Player believes they have a Bingo. Server verifies server-side.
  socket.on('bingo:claimBingo', async ({ telegramId, roomId } = {}, ack) => {
    if (!telegramId || !roomId) {
      return safAck(ack, { success: false, message: 'Missing telegramId or roomId.' });
    }

    const room = bingoManager.getRoom(roomId);
    if (!room) {
      return safAck(ack, { success: false, message: 'Room not found.' });
    }

    const claimResult = await room.claimBingo(telegramId);

    // Broadcast claim result to all players in the room
    socket.to(roomId).emit('bingo:claimResult', {
      roomId,
      telegramId,
      isWinner: claimResult.isWinner,
      pattern: claimResult.pattern || null,
      message: claimResult.message,
    });

    safAck(ack, { roomId, ...claimResult });

    // If winner confirmed, clean up the room
    if (claimResult.isWinner) {
      setTimeout(() => bingoManager.removeRoom(roomId), 3000);
    }
  });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Schedules a one-time check to remove the room after the game ends.
 * Uses polling because BingoRoom emits events but doesn't call back into the manager.
 */
const _scheduleRoomCleanup = (room, bingoManager) => {
  const interval = setInterval(() => {
    if (room.state === 'finished') {
      bingoManager.removeRoom(room.roomId);
      clearInterval(interval);
    }
  }, 5000);
};

/**
 * Safely calls an acknowledgement callback if it exists.
 * Prevents crashes when clients don't supply a callback.
 */
const safAck = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

module.exports = registerBingoHandlers;
