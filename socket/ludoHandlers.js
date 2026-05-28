/**
 * ludoHandlers.js
 * ───────────────
 * Registers all Socket.io event listeners for the Ludo game.
 *
 * Socket.io Events — Client → Server:
 *   ludo:createRoom  { telegramId, username, maxPlayers, winCondition, stake }
 *   ludo:joinRoom    { telegramId, username, roomId }
 *   ludo:listRooms   (no payload)
 *   ludo:rollDice    { telegramId, roomId }
 *   ludo:movePiece   { telegramId, roomId, pieceIndex, diceValue }
 *
 * Socket.io Events — Server → Client (broadcasts):
 *   ludo:roomCreated       { roomId, maxPlayers, winCondition, stake }
 *   ludo:playerJoined      { roomId, telegramId, username, color, playerCount, maxPlayers }
 *   ludo:roomsList         { rooms: [...] }
 *   ludo:gameStarted       { roomId, players, stake, totalPool, brokerFee, winnerPrize, winCondition, currentTurnTelegramId }
 *   ludo:diceRolled        { roomId, telegramId, username, color, diceValue, currentTurnIndex }
 *   ludo:pieceMoved        { roomId, telegramId, username, color, pieceIndex, fromPosition, toPosition, diceValue, boardState }
 *   ludo:turnChanged       { roomId, currentTurnIndex, currentTurnTelegramId, username, color }
 *   ludo:rollAgain         { roomId, telegramId, message }
 *   ludo:gameOver          { roomId, winner, winnerPrize, winCondition, boardState }
 *   ludo:roomCancelled     { roomId, message }
 *   ludo:playerDisconnected { roomId, telegramId, username }
 *   ludo:error             { roomId, message }
 */

const registerLudoHandlers = (socket, ludoManager) => {
  const { id: socketId } = socket;

  // ── ludo:createRoom ────────────────────────────────────────────────────────
  socket.on('ludo:createRoom', ({ telegramId, username, maxPlayers, winCondition, stake } = {}, ack) => {
    if (!telegramId || !username) {
      return safAck(ack, { success: false, message: 'Missing player identity.' });
    }

    const result = ludoManager.createRoom(
      { telegramId, username, socketId },
      Number(maxPlayers),
      Number(winCondition),
      Number(stake)
    );

    if (result.error) {
      return safAck(ack, { success: false, message: result.error });
    }

    // Creator joins the Socket.io room
    socket.join(result.roomId);

    safAck(ack, {
      success: true,
      roomId: result.roomId,
      maxPlayers: result.room.maxPlayers,
      winCondition: result.room.winCondition,
      stake: result.room.stake,
      message: `Room created. Waiting for ${result.room.maxPlayers - 1} more player(s). Auto-cancels in 120s.`,
    });

    console.log(`[LudoHandlers] ${username} created room ${result.roomId}`);
  });

  // ── ludo:joinRoom ──────────────────────────────────────────────────────────
  socket.on('ludo:joinRoom', ({ telegramId, username, roomId } = {}, ack) => {
    if (!telegramId || !username || !roomId) {
      return safAck(ack, { success: false, message: 'Missing join payload.' });
    }

    const joinResult = ludoManager.joinRoom(roomId, { telegramId, username, socketId });
    if (!joinResult.success) {
      return safAck(ack, joinResult);
    }

    socket.join(roomId);

    safAck(ack, {
      success: true,
      roomId,
      color: joinResult.color,
      message: joinResult.message,
    });
  });

  // ── ludo:listRooms ─────────────────────────────────────────────────────────
  // Returns the current lobby of open rooms.
  socket.on('ludo:listRooms', (_payload, ack) => {
    const rooms = ludoManager.getOpenRooms();
    safAck(ack, { success: true, rooms });
    // Also emit as a broadcast event for clients using listeners
    socket.emit('ludo:roomsList', { rooms });
  });

  // ── ludo:rollDice ──────────────────────────────────────────────────────────
  socket.on('ludo:rollDice', ({ telegramId, roomId } = {}, ack) => {
    if (!telegramId || !roomId) {
      return safAck(ack, { success: false, message: 'Missing payload.' });
    }

    const room = ludoManager.getRoom(roomId);
    if (!room) {
      return safAck(ack, { success: false, message: 'Room not found.' });
    }

    const result = room.rollDice(telegramId);
    safAck(ack, { roomId, ...result });
  });

  // ── ludo:movePiece ─────────────────────────────────────────────────────────
  socket.on('ludo:movePiece', async ({ telegramId, roomId, pieceIndex, diceValue } = {}, ack) => {
    if (!telegramId || !roomId || pieceIndex === undefined || !diceValue) {
      return safAck(ack, { success: false, message: 'Missing move payload.' });
    }

    const room = ludoManager.getRoom(roomId);
    if (!room) {
      return safAck(ack, { success: false, message: 'Room not found.' });
    }

    const result = await room.movePiece(telegramId, Number(pieceIndex), Number(diceValue));
    safAck(ack, { roomId, ...result });

    // If the game ended, clean up after a short delay
    if (room.state === 'finished') {
      setTimeout(() => ludoManager.removeRoom(roomId), 5000);
    }
  });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const safAck = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

module.exports = registerLudoHandlers;
