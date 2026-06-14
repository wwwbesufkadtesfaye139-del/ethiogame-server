/**
 * ludoHandlers.js
 * ────────────────
 * SECURITY: telegramId and username come from socket.data (verified by
 *           Telegram initData on connect) — never from event payload.
 *
 * BUG FIX: rollDice and movePiece were missing the `room` lookup.
 *           `room` was used but never assigned — runtime ReferenceError.
 */

const User = require('../models/User');
const { createSocketLimiter } = require('../utils/socketRateLimiter');

// 60 rolls/moves per minute per user (generous for active gameplay)
const rollLimiter = createSocketLimiter('ludoRoll', 60, 60 * 1000);
const moveLimiter = createSocketLimiter('ludoMove', 60, 60 * 1000);

const registerLudoHandlers = (socket, io, ludoManager) => {
  const { id: socketId } = socket;

  // ── ludo:createRoom ────────────────────────────────────────────────────────
  socket.on('ludo:createRoom', async ({ maxPlayers, winCondition, stake } = {}, ack) => {
    const telegramId = socket.data.telegramId;
    const username   = socket.data.username;

    if (!telegramId || !username) {
      return safAck(ack, { success: false, message: 'Missing player identity.' });
    }

    try {
      const affordCheck = await User.canAffordStake(telegramId, Number(stake));
      if (!affordCheck.canJoin) {
        const messages = {
          USER_NOT_FOUND:       'User not found.',
          USER_BLOCKED:         'Your account is blocked.',
          INSUFFICIENT_BALANCE: `Insufficient balance. You need ${stake} Birr but have ${affordCheck.balance} Birr.`,
        };
        return safAck(ack, { success: false, message: messages[affordCheck.reason] || 'Cannot create room.' });
      }

      const updatedUser = await User.deductBalance(telegramId, Number(stake));
      if (!updatedUser) {
        return safAck(ack, { success: false, message: 'Balance deduction failed. Please try again.' });
      }

      socket.emit('user:balanceUpdated', { balance: updatedUser.balance });

      const result = ludoManager.createRoom(
        { telegramId, username, socketId },
        Number(maxPlayers),
        Number(winCondition),
        Number(stake)
      );

      if (result.error) {
        await User.creditBalance(telegramId, Number(stake));
        const refundedUser = await User.findOne({ telegramId });
        socket.emit('user:balanceUpdated', { balance: refundedUser.balance });
        return safAck(ack, { success: false, message: result.error });
      }

      socket.join(result.roomId);

      safAck(ack, {
        success:      true,
        roomId:       result.roomId,
        maxPlayers:   result.room.maxPlayers,
        winCondition: result.room.winCondition,
        stake:        result.room.stake,
        message:      `Room created. Waiting for ${result.room.maxPlayers - 1} more player(s). Auto-cancels in 120s.`,
        newBalance:   updatedUser.balance,
      });

      console.log(`[LudoHandlers] ${username} created room ${result.roomId}`);

    } catch (err) {
      console.error('[Ludo] createRoom error:', err);
      safAck(ack, { success: false, message: 'Server error.' });
    }
  });

  // ── ludo:joinRoom ──────────────────────────────────────────────────────────
  socket.on('ludo:joinRoom', async ({ roomId } = {}, ack) => {
    const telegramId = socket.data.telegramId;
    const username   = socket.data.username;

    if (!telegramId || !username || !roomId) {
      return safAck(ack, { success: false, message: 'Missing join payload.' });
    }

    try {
      const room = ludoManager.getRoom(roomId);
      if (!room) return safAck(ack, { success: false, message: 'Room not found.' });

      const stake = room.stake || 0;

      const affordCheck = await User.canAffordStake(telegramId, stake);
      if (!affordCheck.canJoin) {
        const messages = {
          USER_NOT_FOUND:       'User not found.',
          USER_BLOCKED:         'Your account is blocked.',
          INSUFFICIENT_BALANCE: `Insufficient balance. You need ${stake} Birr but have ${affordCheck.balance} Birr.`,
        };
        return safAck(ack, { success: false, message: messages[affordCheck.reason] || 'Cannot join.' });
      }

      const updatedUser = await User.deductBalance(telegramId, stake);
      if (!updatedUser) {
        return safAck(ack, { success: false, message: 'Balance deduction failed. Please try again.' });
      }

      socket.emit('user:balanceUpdated', { balance: updatedUser.balance });

      const joinResult = ludoManager.joinRoom(roomId, { telegramId, username, socketId });
      if (!joinResult.success) {
        await User.creditBalance(telegramId, stake);
        const refundedUser = await User.findOne({ telegramId });
        socket.emit('user:balanceUpdated', { balance: refundedUser.balance });
        return safAck(ack, joinResult);
      }

      socket.join(roomId);

      safAck(ack, {
        success:    true,
        roomId,
        color:      joinResult.color,
        message:    joinResult.message,
        newBalance: updatedUser.balance,
      });

    } catch (err) {
      console.error('[Ludo] joinRoom error:', err);
      safAck(ack, { success: false, message: 'Server error.' });
    }
  });

  // ── ludo:listRooms ─────────────────────────────────────────────────────────
  socket.on('ludo:listRooms', (_payload, ack) => {
    const rooms = ludoManager.getOpenRooms();
    safAck(ack, { success: true, rooms });
    socket.emit('ludo:roomsList', { rooms });
  });

  // ── ludo:rollDice ──────────────────────────────────────────────────────────
  socket.on('ludo:rollDice', ({ roomId } = {}, ack) => {
    const telegramId = socket.data.telegramId;

    if (!telegramId || !roomId) {
      return safAck(ack, { success: false, message: 'Missing payload.' });
    }

    if (!rollLimiter(telegramId)) {
      return safAck(ack, { success: false, message: 'Too many requests. Please slow down.' });
    }

    // BUG FIX: was missing — `room` used below but never defined
    const room = ludoManager.getRoom(roomId);
    if (!room) return safAck(ack, { success: false, message: 'Room not found.' });

    const result = room.rollDice(telegramId);
    safAck(ack, { roomId, ...result });
  });

  // ── ludo:movePiece ─────────────────────────────────────────────────────────
  socket.on('ludo:movePiece', async ({ roomId, pieceIndex } = {}, ack) => {
    const telegramId = socket.data.telegramId;

    if (!telegramId || !roomId || pieceIndex === undefined) {
      return safAck(ack, { success: false, message: 'Missing move payload.' });
    }

    if (!moveLimiter(telegramId)) {
      return safAck(ack, { success: false, message: 'Too many requests. Please slow down.' });
    }

    // BUG FIX: was missing — `room` used below but never defined
    const room = ludoManager.getRoom(roomId);
    if (!room) return safAck(ack, { success: false, message: 'Room not found.' });

    const result = await room.movePiece(telegramId, Number(pieceIndex));
    safAck(ack, { roomId, ...result });

    if (room.state === 'finished' && result.winner) {
      try {
        const winnerTelegramId = result.winner.telegramId || result.winner;
        const winnerSocketId   = result.winner.socketId;

        if (winnerSocketId) {
          const winner = await User.findOne({ telegramId: winnerTelegramId });
          if (winner) {
            io.to(winnerSocketId).emit('user:balanceUpdated', {
              balance: winner.balance - (winner.lockedBalance || 0),
            });
          }
        }
      } catch (err) {
        console.error('[Ludo] balance push error:', err);
      }

      setTimeout(() => ludoManager.removeRoom(roomId), 5000);
    }
  });
};

const safAck = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

module.exports = registerLudoHandlers;
