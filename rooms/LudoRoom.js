import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

import { SERVER_URL } from '../config';

const GameCtx = createContext(null);

export const GameProvider = ({ children, telegramId: propTelegramId, username }) => {
  const socketRef    = useRef(null);
  const [connected,  setConnected]  = useState(false);
  const [balance,    setBalance]    = useState(0);
  const [userStats,  setUserStats]  = useState({ totalWinnings: 0, totalDeposited: 0, gamesPlayed: 0, gamesWon: 0 });
  const [bingoState, setBingoState] = useState(null);
  const [ludoState,  setLudoState]  = useState(null);

  // ✅ Get telegramId from prop OR directly from Telegram WebApp
  const telegramId = String(
    propTelegramId ||
    window?.Telegram?.WebApp?.initDataUnsafe?.user?.id ||
    'dev'
  );

  useEffect(() => {
    // SECURITY FIX: send Telegram initData in the socket handshake so the
    // server can verify our identity with HMAC-SHA256 before trusting anything.
    const socket = io(SERVER_URL, {
      transports:   ['websocket', 'polling'],
      reconnection: true,
      auth: {
        initData: window?.Telegram?.WebApp?.initData || '',
      },
    });
    socketRef.current = socket;

    // Handle auth rejection from server (invalid or expired initData)
    socket.on('connect_error', (err) => {
      console.error('[Socket] Auth error:', err.message);
      setConnected(false);
    });

    // ✅ FIX 1 — When app connects, immediately ask Railway for the REAL balance
    socket.on('connect', () => {
      setConnected(true);
      console.log('Connected to server');
      // Ask server for real balance right away — no more starting at 0
      socket.emit('user:getBalance', { telegramId }, (res) => {
        if (res?.success) {
          setBalance(res.balance);
        }
      });
      // Fetch lifetime stats for the Wallet screen (Total Won, Deposited, Games)
      socket.emit('user:getStats', { telegramId }, (res) => {
        if (res?.success) {
          setUserStats({
            totalWinnings:  res.totalWinnings,
            totalDeposited: res.totalDeposited,
            gamesPlayed:    res.gamesPlayed,
            gamesWon:       res.gamesWon,
          });
        }
      });
      // Resume: check if this user is mid-game after reconnect
      if (telegramId && telegramId !== 'dev') {
        socket.emit('bingo:rejoin', { telegramId }, (res) => {
          if (res?.inGame) {
            setBingoState(prev => ({
              ...prev,
              roomId:        res.roomId,
              stake:         res.stake,
              calledNumbers: res.calledNumbers,
              ownedCards:    res.ownedCards,
              state:         'active',
              playerCount:   res.playerCount,
              winnerPrize:   res.winnerPrize,
            }));
          }
        });
      }
    });

    socket.on('disconnect', () => setConnected(false));

    // ✅ FIX 2 — Listen for balance updates from server (deposit, win, loss)
    // Whenever Railway changes the balance, the app will hear it and update
    socket.on('user:balanceUpdated', (d) => {
      setBalance(d.balance); // always the real number from the database
    });

    // ─── BINGO EVENTS ────────────────────────────────────────────────────────

    socket.on('bingo:gameStarted', (d) => {
      setBingoState((p) => ({ ...p, ...d, calledNumbers: [], state: 'active' }));
      // ✅ FIX 3 — Use server balance if provided, NOT local math
      // Old (wrong): setBalance(b => b - d.stake)
      // New (correct): server sends the real new balance
      if (d.newBalance !== undefined) setBalance(d.newBalance);
    });

    socket.on('bingo:numberDrawn', (d) =>
      setBingoState((p) => (p ? { ...p, calledNumbers: d.calledNumbers, lastDrawn: d.drawnNumber } : p))
    );

    socket.on('bingo:countdown', (d) =>
      setBingoState((p) => ({ ...p, ...d, state: 'countdown' }))
    );

    // ✅ FIX #8 — Handle countdown cancellation.
    //
    // The server emits this when a player leaves during the countdown
    // and the room drops below the minimum player count (see
    // BingoRoom._cancelCountdown). It correctly reverts the ROOM's state
    // to 'waiting' server-side — but nothing on the client listened,
    // so the waiting screen kept showing "⏱ Game Starting Soon!" forever
    // even though the countdown had actually been cancelled and no game
    // was coming.
    //
    // Setting state back to 'waiting' here makes BingoScreen's waiting
    // view automatically switch its text to "⏳ Waiting for Players…"
    // (it already branches on bingoState?.state === 'countdown' vs not —
    // no UI changes needed, just feeding it the truth).
    socket.on('bingo:countdownCancelled', (d) =>
      setBingoState((p) => (p ? { ...p, ...d, state: 'waiting' } : p))
    );

    socket.on('bingo:playerJoined', (d) =>
      setBingoState((p) => (p ? { ...p, playerCount: d.playerCount } : p))
    );

    // ✅ FIX #9 — Keep playerCount accurate when someone leaves.
    //
    // The server emits 'bingo:playerLeft' with the updated count whenever
    // a player disconnects during waiting/countdown (see BingoRoom.removePlayer),
    // but only 'bingo:playerJoined' was ever handled. The waiting screen's
    // "N player(s) joined" text could only go up, never down — so after a
    // player left (e.g. right after a countdown cancellation), the count
    // stayed stale and overcounted until something else happened to refresh it.
    socket.on('bingo:playerLeft', (d) =>
      setBingoState((p) => (p ? { ...p, playerCount: d.playerCount } : p))
    );

    socket.on('bingo:gameOver', (d) => {
      setBingoState((p) => ({ ...p, ...d, state: 'finished' }));
      // ✅ Update balance when game ends (win or loss — server sends real amount)
      if (d.newBalance !== undefined) setBalance(d.newBalance);
      // Refresh lifetime stats (gamesPlayed, gamesWon, totalWinnings changed)
      socket.emit('user:getStats', { telegramId }, (res) => {
        if (res?.success) {
          setUserStats({
            totalWinnings:  res.totalWinnings,
            totalDeposited: res.totalDeposited,
            gamesPlayed:    res.gamesPlayed,
            gamesWon:       res.gamesWon,
          });
        }
      });
    });

    // ✅ FIX #7 — Handle the case where all 75 numbers are drawn with no
    // winner. The server already emits this and refunds every player's
    // stake (see BingoRoom._handleNoWinner + FIX #5's balance push), but
    // nothing on the client was listening — players were stuck staring
    // at a frozen "Game in Progress" screen forever with no explanation.
    //
    // We set a distinct 'noWinner' state (rather than reusing 'finished',
    // which the UI already treats as "someone won") so BingoScreen can
    // show the correct message. The refunded balance itself arrives
    // separately via the 'user:balanceUpdated' event already handled above.
    socket.on('bingo:noWinner', (d) => {
      setBingoState((p) => ({ ...p, ...d, state: 'noWinner' }));
    });

    socket.on('bingo:claimResult', (d) => {
      setBingoState((p) => ({ ...p, claimResult: d }));
      // ✅ Update balance if player won
      if (d.newBalance !== undefined) setBalance(d.newBalance);
    });

    // ─── LUDO EVENTS ─────────────────────────────────────────────────────────

    socket.on('ludo:gameStarted', (d) => {
      setLudoState((p) => ({ ...p, ...d, state: 'active' }));
      // ✅ FIX 3 — Use server balance if provided, NOT local math
      // Old (wrong): setBalance(b => b - d.stake)
      // New (correct): server sends the real new balance
      if (d.newBalance !== undefined) setBalance(d.newBalance);
    });

    socket.on('ludo:diceRolled', (d) =>
      setLudoState((p) => (p ? { ...p, lastDice: d } : p))
    );

    socket.on('ludo:pieceMoved', (d) =>
      setLudoState((p) => (p ? { ...p, boardState: d.boardState, lastMove: d } : p))
    );

    socket.on('ludo:turnChanged', (d) =>
      setLudoState((p) => (p ? { ...p, currentTurnTelegramId: d.currentTurnTelegramId } : p))
    );

    socket.on('ludo:gameOver', (d) => {
      setLudoState((p) => ({ ...p, ...d, state: 'finished' }));
      // ✅ Update balance when game ends
      if (d.newBalance !== undefined) setBalance(d.newBalance);
      // Refresh lifetime stats (gamesPlayed, gamesWon, totalWinnings changed)
      socket.emit('user:getStats', { telegramId }, (res) => {
        if (res?.success) {
          setUserStats({
            totalWinnings:  res.totalWinnings,
            totalDeposited: res.totalDeposited,
            gamesPlayed:    res.gamesPlayed,
            gamesWon:       res.gamesWon,
          });
        }
      });
    });

    socket.on('ludo:roomCancelled', (d) =>
      setLudoState((p) => ({ ...p, state: 'cancelled', message: d.message }))
    );

    socket.on('ludo:playerJoined', (d) =>
      setLudoState((p) => (p ? { ...p, playerCount: d.playerCount } : p))
    );

    return () => socket.disconnect();
  }, [telegramId]); // ✅ Added telegramId as dependency so it re-fetches if user changes

  // ─── EMIT HELPER ───────────────────────────────────────────────────────────
  const emit = (ev, data, cb) => {
    if (!socketRef.current?.connected) {
      // ✅ Wait up to 3 seconds for connection before giving up
      let attempts = 0;
      const retry = setInterval(() => {
        attempts++;
        if (socketRef.current?.connected) {
          clearInterval(retry);
          socketRef.current.emit(ev, data, cb);
        } else if (attempts >= 6) {
          clearInterval(retry);
          cb?.({ success: false, message: 'Not connected to server. Please wait.' });
        }
      }, 500);
      return;
    }
    socketRef.current.emit(ev, data, cb);
  };

  // ─── BINGO ACTIONS ─────────────────────────────────────────────────────────
  const getBingoCards = (stake, cb) =>
    emit('bingo:getCards', { stake }, cb);

  const buyBingoCard = (stake, cardNumber, cb) =>
    emit('bingo:buyCard', { telegramId, username, stake, cardNumber }, (res) => {
      if (res?.success) {
        setBingoState(prev => {
          const existingCards = prev?.ownedCards || [];
          return {
            ...prev,
            roomId:      res.roomId,
            ownedCards:  [...existingCards, { cardNumber: res.cardNumber, card: res.card }],
            stake,
            playerCount: res.playerCount,
            calledNumbers: prev?.calledNumbers || [],
            state:       prev?.state || 'waiting',
          };
        });
        if (res.newBalance !== undefined) setBalance(res.newBalance);
      }
      cb?.(res);
    });

  const claimBingo = (roomId, cb) =>
    emit('bingo:claimBingo', { telegramId, roomId }, cb);

  const leaveGame = () => setBingoState(null);

  // ─── LUDO ACTIONS ──────────────────────────────────────────────────────────
  const createLudoRoom = (opts, cb) =>
    emit('ludo:createRoom', { telegramId, username, ...opts }, (res) => {
      if (res?.success) {
        setLudoState({
          roomId: res.roomId,
          maxPlayers: res.maxPlayers,
          winCondition: res.winCondition,
          stake: res.stake,
          playerCount: 1,
          state: 'waiting',
          isCreator: true,
        });
        // ✅ Update balance from server response if provided
        if (res.newBalance !== undefined) setBalance(res.newBalance);
      }
      cb?.(res);
    });

  const joinLudoRoom = (roomId, cb) =>
    emit('ludo:joinRoom', { telegramId, username, roomId }, (res) => {
      // ✅ Update balance when joining (stake deducted)
      if (res?.newBalance !== undefined) setBalance(res.newBalance);
      cb?.(res);
    });

  const rollDice  = (roomId, cb) => emit('ludo:rollDice',  { telegramId, roomId }, cb);
  const movePiece = (roomId, pieceIndex, diceValue, cb) =>
    emit('ludo:movePiece', { telegramId, roomId, pieceIndex, diceValue }, cb);

  const listLudoRooms = (cb) => emit('ludo:listRooms', {}, cb);
  const leaveLudoGame = () => setLudoState(null);

  // ─── MANUAL REFRESH (bonus) ────────────────────────────────────────────────
  // Call this anywhere in your app to force-refresh balance from server
  const refreshBalance = () => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('user:getBalance', { telegramId }, (res) => {
        if (res?.success) setBalance(res.balance);
      });
    }
  };

  // Call this to force-refresh lifetime stats (Total Won, Deposited, Games)
  const refreshUserStats = () => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('user:getStats', { telegramId }, (res) => {
        if (res?.success) {
          setUserStats({
            totalWinnings:  res.totalWinnings,
            totalDeposited: res.totalDeposited,
            gamesPlayed:    res.gamesPlayed,
            gamesWon:       res.gamesWon,
          });
        }
      });
    }
  };

  return (
    <GameCtx.Provider
      value={{
        socket: socketRef.current,
        connected,
        balance,
        setBalance,
        refreshBalance,
        userStats,
        refreshUserStats,
        telegramId,       // Bug 4 Fix: export real telegramId so screens don't hardcode it
        bingoState,
        setBingoState,
        ludoState,
        setLudoState,
        getBingoCards,    // ✅ NEW
        buyBingoCard,     // ✅ NEW
        claimBingo,
        leaveGame,
        createLudoRoom,
        joinLudoRoom,
        rollDice,
        movePiece,
        listLudoRooms,
        leaveLudoGame,
      }}
    >
      {children}
    </GameCtx.Provider>
  );
};

export const useGame = () => useContext(GameCtx);
