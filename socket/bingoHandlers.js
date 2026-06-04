/**
 * bingoHandlers.js  (FIXED v2 — uses User model statics)
 * ────────────────────────────────────────────────────────
 * Changes made:
 *  1. user:getBalance   — app fetches real balance on connect
 *  2. bingo:join        — deducts stake atomically, sends newBalance back
 *  3. bingo:claimBingo  — credits winnings atomically, sends newBalance back
 */

const User = require('../models/User');

const registerBingoHandlers = (socket, io, bingoManager) => {
  const { id: socketId } = socket;

  // ── user:getBalance ────────────────────────────────────────────────────────
  // ✅ NEW — called by the app the moment it connects
  // Returns the real balance straight from MongoDB
  socket.on('user:getBalance', async ({ telegramId } = {}, ack) => {
    if (!telegramId) {
      return safAck(ack, { success: false, message: 'Missing telegramId.' });
    }
    try {
      const user = await User.findOne({ telegramId });
      if (!user) return safAck(ack, { success: false, message: 'User not found.' });
      safAck(ack, { success: true, balance: user.balance });
    } catch (err) {
      console.error('[Bingo] getBalance error:', err);
      safAck(ack, { success: false, message: 'Server error.' });
    }
  });

  // ── bingo:join ─────────────────────────────────────────────────────────────
  socket.on('bingo:join', async ({ telegramId, username, stake, pickedNumber } = {}, ack) => {
    if (!telegramId || !username || !stake || isNaN(stake) || stake <= 0) {
      return safAck(ack, { success: false, message: 'Invalid join payload.' });
    }

    // ✅ Validate pickedNumber 1-200
    const picked = Number(pickedNumber);
    if (!picked || picked < 1 || picked > 200) {
      return safAck(ack, { success: false, message: 'Please pick a number between 1 and 200.' });
    }

    try {
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

      // ✅ STEP 3 — Tell the app the new real balance right away
      socket.emit('user:balanceUpdated', { balance: updatedUser.balance });

      // STEP 4 — Find or create bingo room
      const { room, isNew, reason } = bingoManager.findOrCreateRoom(stake);
      if (!room) {
        await User.creditBalance(telegramId, stake);
        const refundedUser = await User.findOne({ telegramId });
        socket.emit('user:balanceUpdated', { balance: refundedUser.balance });
        return safAck(ack, { success: false, message: reason });
      }

      socket.join(room.roomId);

      // ✅ Pass pickedNumber to addPlayer
      const result = room.addPlayer({ telegramId, username, socketId, pickedNumber: picked });
      if (!result.success) {
        socket.leave(room.roomId);
        await User.creditBalance(telegramId, stake);
        const refundedUser = await User.findOne({ telegramId });
        socket.emit('user:balanceUpdated', { balance: refundedUser.balance });
        return safAck(ack, result);
      }

      _scheduleRoomCleanup(room, bingoManager);

      // ✅ STEP 5 — Send newBalance in the response so app updates immediately
      safAck(ack, {
        success:      true,
        roomId:       room.roomId,
        card:         result.card,
        playerCount:  room.getPlayerCount(),
        stake,
        isNewRoom:    isNew,
        message:      'Joined Bingo room.',
        newBalance:   updatedUser.balance, // ✅ KEY FIX
      });

    } catch (err) {
      console.error('[Bingo] join error:', err);
      safAck(ack, { success: false, message: 'Server error.' });
    }
  });

  // ── bingo:claimBingo ───────────────────────────────────────────────────────
  socket.on('bingo:claimBingo', async ({ telegramId, roomId } = {}, ack) => {
    if (!telegramId || !roomId) {
      return safAck(ack, { success: false, message: 'Missing telegramId or roomId.' });
    }

    const room = bingoManager.getRoom(roomId);
    if (!room) {
      return safAck(ack, { success: false, message: 'Room not found.' });
    }

    const claimResult = await room.claimBingo(telegramId);

    // ✅ If winner — credit winnings atomically using your creditBalance static
    if (claimResult.isWinner && claimResult.winnerPrize) {
      try {
        const updatedWinner = await User.creditBalance(telegramId, claimResult.winnerPrize, true);
        if (updatedWinner) {
          // ✅ Tell winner their new balance
          socket.emit('user:balanceUpdated', { balance: updatedWinner.balance });
          claimResult.newBalance = updatedWinner.balance;
        }
      } catch (err) {
        console.error('[Bingo] credit winnings error:', err);
      }
    }

    // Broadcast claim result to all other players in the room
    socket.to(roomId).emit('bingo:claimResult', {
      roomId,
      telegramId,
      isWinner:  claimResult.isWinner,
      pattern:   claimResult.pattern || null,
      message:   claimResult.message,
    });

    safAck(ack, { roomId, ...claimResult });

    if (claimResult.isWinner) {
      setTimeout(() => bingoManager.removeRoom(roomId), 3000);
    }
  });

  // ── bingo:listRooms ────────────────────────────────────────────────────────
  // ✅ Returns one room per stake amount
  socket.on('bingo:listRooms', (_payload, ack) => {
    const rooms = bingoManager.getActiveRooms();
    safAck(ack, { success: true, rooms });
  });

};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _scheduleRoomCleanup = (room, bingoManager) => {
  const interval = setInterval(() => {
    if (room.state === 'finished') {
      bingoManager.removeRoom(room.roomId);
      clearInterval(interval);
    }
  }, 5000);
};

const safAck = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

module.exports = registerBingoHandlers;
