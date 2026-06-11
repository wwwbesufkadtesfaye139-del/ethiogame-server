/**
 * bingoHandlers.js — New Card System
 * ────────────────────────────────────
 * Events — Client → Server:
 *   bingo:getCards    { stake }                          → get all 200 cards for a room
 *   bingo:buyCard     { stake, cardNumber }              → buy one card
 *   bingo:claimBingo  { roomId }                        → claim bingo
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
 *
 * SECURITY: telegramId and username come from socket.data (verified by
 *           Telegram initData on connect) — never from event payload.
 */

const User = require('../models/User');
const { createSocketLimiter } = require('../utils/socketRateLimiter');

// 20 card purchases per minute per user
const buyCardLimiter = createSocketLimiter('buyCard', 20, 60 * 1000);

const registerBingoHandlers = (socket, io, bingoManager) => {
  const { id: socketId } = socket;

  // Track which room this socket is in so we leave before joining a new one
  let currentRoomId = null;
  const joinRoom = (newRoomId) => {
    if (currentRoomId && currentRoomId !== newRoomId) {
      socket.leave(currentRoomId);
    }
    currentRoomId = newRoomId;
    socket.join(newRoomId);
  };
  socket.on('disconnect', () => { currentRoomId = null; });

  // ── bingo:getCards ─────────────────────────────────────────────────────────
  socket.on('bingo:getCards', ({ stake } = {}, ack) => {
    if (!stake) return safAck(ack, { success: false, message: 'Missing stake.' });

    const { room } = bingoManager.findOrCreateRoom(Number(stake));
    if (!room) return safAck(ack, { success: false, message: 'Could not get room.' });

    joinRoom(room.roomId);

    safAck(ack, {
      success:     true,
      roomId:      room.roomId,
      cards:       room.getCardsInfo(),
      playerCount: room.getPlayerCount(),
      state:       room.state,
    });
  });

  // ── bingo:buyCard ──────────────────────────────────────────────────────────
  socket.on('bingo:buyCard', async ({ stake, cardNumber } = {}, ack) => {
    // SECURITY FIX: identity from verified socket.data — not from event payload
    const telegramId = socket.data.telegramId;
    const username   = socket.data.username;

    if (!telegramId || !stake || !cardNumber) {
      return safAck(ack, { success: false, message: 'Missing required fields.' });
    }

    // Rate limit: max 20 card purchases per minute
    if (!buyCardLimiter(telegramId)) {
      return safAck(ack, { success: false, message: 'Too many requests. Please slow down.' });
    }

    try {
      const affordCheck = await User.canAffordStake(telegramId, Number(stake));
      if (!affordCheck.canJoin) {
        const messages = {
          USER_NOT_FOUND:       'User not found.',
          USER_BLOCKED:         'Your account is blocked.',
          INSUFFICIENT_BALANCE: `Insufficient balance. Need ${stake} Birr, have ${affordCheck.balance} Birr.`,
        };
        return safAck(ack, { success: false, message: messages[affordCheck.reason] || 'Cannot buy.' });
      }

      const updatedUser = await User.deductBalance(telegramId, Number(stake));
      if (!updatedUser) {
        return safAck(ack, { success: false, message: 'Balance deduction failed. Please try again.' });
      }

      socket.emit('user:balanceUpdated', { balance: updatedUser.balance - (updatedUser.lockedBalance || 0) });

      const { room } = bingoManager.findOrCreateRoom(Number(stake));
      if (!room) {
        await User.creditBalance(telegramId, Number(stake));
        return safAck(ack, { success: false, message: 'Room not available.' });
      }

      joinRoom(room.roomId);

      const result = room.buyCard(telegramId, username, socketId, Number(cardNumber));
      if (!result.success) {
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
  socket.on('bingo:claimBingo', async ({ roomId } = {}, ack) => {
    // SECURITY FIX: identity from verified socket.data
    const telegramId = socket.data.telegramId;

    if (!telegramId || !roomId) {
      return safAck(ack, { success: false, message: 'Missing roomId.' });
    }

    const room = bingoManager.getRoom(roomId);
    if (!room) {
      return safAck(ack, { success: false, message: 'Room not found.' });
    }

    const claimResult = await room.claimBingo(telegramId);

    if (claimResult.isWinner) {
      try {
        const updatedWinner = await User.findOne({ telegramId });
        if (updatedWinner) {
          const available = updatedWinner.balance - (updatedWinner.lockedBalance || 0);
          socket.emit('user:balanceUpdated', { balance: available });
          claimResult.newBalance = available;
        }
      } catch (err) {
        console.error('[BingoHandlers] fetch updated balance error:', err.message);
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

  // ── bingo:rejoin ───────────────────────────────────────────────────────────
  socket.on('bingo:rejoin', (_data, ack) => {
    // SECURITY FIX: identity from verified socket.data
    const telegramId = socket.data.telegramId;
    if (!telegramId) return safAck(ack, { success: true, inGame: false });

    const allRooms = bingoManager.getAllRooms();
    for (const room of allRooms) {
      if (room.state === 'active' && room.players.has(telegramId)) {
        joinRoom(room.roomId);
        const ownedCards = room.getPlayerCards(telegramId);
        console.log(`[BingoHandlers] ${telegramId} rejoined room ${room.roomId}`);
        return safAck(ack, {
          success:       true,
          inGame:        true,
          roomId:        room.roomId,
          stake:         room.stake,
          calledNumbers: room.calledNumbers,
          ownedCards,
          state:         'active',
          playerCount:   room.getPlayerCount(),
          winnerPrize:   room.winnerPrize,
        });
      }
    }
    safAck(ack, { success: true, inGame: false });
  });

};

const safAck = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

module.exports = registerBingoHandlers;
