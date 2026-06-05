/**
 * bingoHandlers.js — New Card System
 * ────────────────────────────────────
 * Events — Client → Server:
 *   bingo:getCards    { stake }                          → get all 200 cards for a room
 *   bingo:buyCard     { telegramId, username, stake, cardNumber }  → buy one card
 *   bingo:claimBingo  { telegramId, roomId }             → claim bingo
 *
 * Events — Server → Client:
 *   bingo:cardsInfo     { cards[] }
 *   bingo:cardTaken     { cardNumber, playerCount }
 *   bingo:playerJoined  { playerCount, username }
 *   bingo:countdown     { durationMs, endsAt }
 *   bingo:gameStarted   { cards[], stake, winnerPrize, playerCount }
 *   bingo:numberDrawn   { drawnNumber, calledNumbers }
 *   bingo:claimResult   { isWinner, pattern, cardNumber }
 *   bingo:gameOver      { winners, winnerPrize, calledNumbers }
 */

const User = require('../models/User');

const registerBingoHandlers = (socket, io, bingoManager) => {
  const { id: socketId } = socket;

  // ── bingo:getCards ─────────────────────────────────────────────────────────
  // Get all 200 cards for a stake room (for the lobby)
  socket.on('bingo:getCards', ({ stake } = {}, ack) => {
    if (!stake) return safAck(ack, { success: false, message: 'Missing stake.' });

    const { room } = bingoManager.findOrCreateRoom(Number(stake));
    if (!room) return safAck(ack, { success: false, message: 'Could not get room.' });

    socket.join(room.roomId);

    safAck(ack, {
      success:     true,
      roomId:      room.roomId,
      cards:       room.getCardsInfo(),
      playerCount: room.getPlayerCount(),
      state:       room.state,
    });
  });

  // ── bingo:buyCard ──────────────────────────────────────────────────────────
  // Player buys a specific card number
  socket.on('bingo:buyCard', async ({ telegramId, username, stake, cardNumber } = {}, ack) => {
    if (!telegramId || !username || !stake || !cardNumber) {
      return safAck(ack, { success: false, message: 'Missing required fields.' });
    }

    try {
      // ✅ Check affordability
      const affordCheck = await User.canAffordStake(telegramId, Number(stake));
      if (!affordCheck.canJoin) {
        const messages = {
          USER_NOT_FOUND:       'User not found.',
          USER_BLOCKED:         'Your account is blocked.',
          INSUFFICIENT_BALANCE: `Insufficient balance. Need ${stake} Birr, have ${affordCheck.balance} Birr.`,
        };
        return safAck(ack, { success: false, message: messages[affordCheck.reason] || 'Cannot buy.' });
      }

      // ✅ Deduct stake
      const updatedUser = await User.deductBalance(telegramId, Number(stake));
      if (!updatedUser) {
        return safAck(ack, { success: false, message: 'Balance deduction failed. Please try again.' });
      }

      // ✅ Update app balance
      socket.emit('user:balanceUpdated', { balance: updatedUser.balance - (updatedUser.lockedBalance || 0) });

      // Get or create room
      const { room } = bingoManager.findOrCreateRoom(Number(stake));
      if (!room) {
        // Refund
        await User.creditBalance(telegramId, Number(stake));
        return safAck(ack, { success: false, message: 'Room not available.' });
      }

      socket.join(room.roomId);

      // ✅ Buy the card
      const result = room.buyCard(telegramId, username, socketId, Number(cardNumber));
      if (!result.success) {
        // Refund if card already taken or error
        await User.creditBalance(telegramId, Number(stake));
        socket.emit('user:balanceUpdated', { balance: updatedUser.balance });
        return safAck(ack, result);
      }

      safAck(ack, {
        success:     true,
        roomId:      room.roomId,
        cardNumber:  Number(cardNumber),
        card:        result.card,
        playerCount: room.getPlayerCount(),
        newBalance:  updatedUser.balance - (updatedUser.lockedBalance || 0),
        message:     `Card #${cardNumber} purchased!`,
      });

    } catch (err) {
      console.error('[BingoHandlers] buyCard error:', err.message);
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

    // Credit winner balance
    if (claimResult.isWinner && claimResult.winnerPrize) {
      try {
        const updatedWinner = await User.creditBalance(telegramId, claimResult.winnerPrize, true);
        if (updatedWinner) {
          socket.emit('user:balanceUpdated', { balance: updatedWinner.balance - (updatedWinner.lockedBalance || 0) });
          claimResult.newBalance = updatedWinner.balance;
        }
      } catch (err) {
        console.error('[BingoHandlers] credit winnings error:', err.message);
      }
    }

    socket.to(roomId).emit('bingo:claimResult', {
      roomId,
      telegramId,
      isWinner:   claimResult.isWinner,
      cardNumber: claimResult.cardNumber || null,
      pattern:    claimResult.pattern    || null,
      message:    claimResult.message,
    });

    safAck(ack, { roomId, ...claimResult });

    if (claimResult.isWinner) {
      setTimeout(() => bingoManager.removeRoom(roomId), 3000);
    }
  });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const safAck = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

module.exports = registerBingoHandlers;
