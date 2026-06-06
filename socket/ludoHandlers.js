/**
 * ludoHandlers.js  (FIXED v2 — uses User model statics)
 * ───────────────────────────────────────────────────────
 * Changes made:
 *  1. ludo:createRoom — deducts stake atomically, sends newBalance back
 *  2. ludo:joinRoom   — deducts stake atomically, sends newBalance back
 *  3. ludo:movePiece  — credits winner atomically when game ends
 */

const User = require('../models/User');

const registerLudoHandlers = (socket, io, ludoManager) => {
  const { id: socketId } = socket;

  // ── ludo:createRoom ────────────────────────────────────────────────────────
  socket.on('ludo:createRoom', async ({ telegramId, username, maxPlayers, winCondition, stake } = {}, ack) => {
    if (!telegramId || !username) {
      return safAck(ack, { success: false, message: 'Missing player identity.' });
    }

    try {
      // ✅ STEP 1 — Check if user can afford the stake
      const affordCheck = await User.canAffordStake(telegramId, Number(stake));
      if (!affordCheck.canJoin) {
        const messages = {
          USER_NOT_FOUND:        'User not found.',
          USER_BLOCKED:          'Your account is blocked.',
          INSUFFICIENT_BALANCE:  `Insufficient balance. You need ${stake} Birr but have ${affordCheck.balance} Birr.`,
        };
        return safAck(ack, { success: false, message: messages[affordCheck.reason] || 'Cannot create room.' });
      }

      // ✅ STEP 2 — Deduct stake atomically
      const updatedUser = await User.deductBalance(telegramId, Number(stake));
      if (!updatedUser) {
        return safAck(ack, { success: false, message: 'Balance deduction failed. Please try again.' });
      }

      // ✅ STEP 3 — Tell app the new balance right away
      socket.emit('user:balanceUpdated', { balance: updatedUser.balance });

      // STEP 4 — Create room (your existing logic unchanged)
      const result = ludoManager.createRoom(
        { telegramId, username, socketId },
        Number(maxPlayers),
        Number(winCondition),
        Number(stake)
      );

      if (result.error) {
        // ✅ Refund if room creation failed
        await User.creditBalance(telegramId, Number(stake));
        const refundedUser = await User.findOne({ telegramId });
        socket.emit('user:balanceUpdated', { balance: refundedUser.balance });
        return safAck(ack, { success: false, message: result.error });
      }

      socket.join(result.roomId);

      // ✅ STEP 5 — Send newBalance in response
      safAck(ack, {
        success:      true,
        roomId:       result.roomId,
        maxPlayers:   result.room.maxPlayers,
        winCondition: result.room.winCondition,
        stake:        result.room.stake,
        message:      `Room created. Waiting for ${result.room.maxPlayers - 1} more player(s). Auto-cancels in 120s.`,
        newBalance:   updatedUser.balance, // ✅ KEY FIX
      });

      console.log(`[LudoHandlers] ${username} created room ${result.roomId}`);

    } catch (err) {
      console.error('[Ludo] createRoom error:', err);
      safAck(ack, { success: false, message: 'Server error.' });
    }
  });

  // ── ludo:joinRoom ──────────────────────────────────────────────────────────
  socket.on('ludo:joinRoom', async ({ telegramId, username, roomId } = {}, ack) => {
    if (!telegramId || !username || !roomId) {
      return safAck(ack, { success: false, message: 'Missing join payload.' });
    }

    try {
      // ✅ Get room first to know the stake amount
      const room = ludoManager.getRoom(roomId);
      if (!room) return safAck(ack, { success: false, message: 'Room not found.' });

      const stake = room.stake || 0;

      // ✅ STEP 1 — Check if user can afford the stake
      const affordCheck = await User.canAffordStake(telegramId, stake);
      if (!affordCheck.canJoin) {
        const messages = {
          USER_NOT_FOUND:        'User not found.',
          USER_BLOCKED:          'Your account is blocked.',
          INSUFFICIENT_BALANCE:  `Insufficient balance. You need ${stake} Birr but have ${affordCheck.balance} Birr.`,
        };
        return safAck(ack, { success: false, message: messages[affordCheck.reason] || 'Cannot join.' });
      }

      // ✅ STEP 2 — Deduct stake atomically
      const updatedUser = await User.deductBalance(telegramId, stake);
      if (!updatedUser) {
        return safAck(ack, { success: false, message: 'Balance deduction failed. Please try again.' });
      }

      // ✅ STEP 3 — Tell app the new balance right away
      socket.emit('user:balanceUpdated', { balance: updatedUser.balance });

      // STEP 4 — Join the room (your existing logic unchanged)
      const joinResult = ludoManager.joinRoom(roomId, { telegramId, username, socketId });
      if (!joinResult.success) {
        // ✅ Refund if join failed
        await User.creditBalance(telegramId, stake);
        const refundedUser = await User.findOne({ telegramId });
        socket.emit('user:balanceUpdated', { balance: refundedUser.balance });
        return safAck(ack, joinResult);
      }

      socket.join(roomId);

      // ✅ STEP 5 — Send newBalance in response
      safAck(ack, {
        success:    true,
        roomId,
        color:      joinResult.color,
        message:    joinResult.message,
        newBalance: updatedUser.balance, // ✅ KEY FIX
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
  socket.on('ludo:rollDice', ({ telegramId, roomId } = {}, ack) => {
    if (!telegramId || !roomId) {
      return safAck(ack, { success: false, message: 'Missing payload.' });
    }
    const room = ludoManager.getRoom(roomId);
    if (!room) return safAck(ack, { success: false, message: 'Room not found.' });

    const result = room.rollDice(telegramId);
    safAck(ack, { roomId, ...result });
  });

  // ── ludo:movePiece ─────────────────────────────────────────────────────────
  socket.on('ludo:movePiece', async ({ telegramId, roomId, pieceIndex, diceValue } = {}, ack) => {
    if (!telegramId || !roomId || pieceIndex === undefined || !diceValue) {
      return safAck(ack, { success: false, message: 'Missing move payload.' });
    }

    const room = ludoManager.getRoom(roomId);
    if (!room) return safAck(ack, { success: false, message: 'Room not found.' });

    const result = await room.movePiece(telegramId, Number(pieceIndex), Number(diceValue));
    safAck(ack, { roomId, ...result });

    // Prize was already disbursed inside LudoRoom._endGame() via disburseWinnings().
    // Do NOT call creditBalance again here — that would pay the winner twice.
    // Just read the updated balance and push it to the winner's socket for the UI.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const safAck = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

module.exports = registerLudoHandlers;
