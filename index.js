require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const User = require('./models/User');
const BingoManager = require('./managers/BingoManager');
const LudoManager = require('./managers/LudoManager');
const registerBingoHandlers = require('./socket/bingoHandlers');
const registerLudoHandlers = require('./socket/ludoHandlers');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// ─── App & Server Setup ───────────────────────────────────────────────────────

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 30000,
  pingInterval: 10000,
});

// ─── Connect DB ───────────────────────────────────────────────────────────────

// Connect to DB without blocking the server start
connectDB().catch(err => console.error("DB Connection Error:", err));


// ─── Game Managers ────────────────────────────────────────────────────────────

const bingoManager = new BingoManager(io);
const ludoManager = new LudoManager(io);

// Periodic stale-room sweep
setInterval(() => {
  bingoManager.sweepStaleRooms();
  ludoManager.sweepStaleRooms();
}, STALE_SWEEP_INTERVAL_MS);

// ─── REST Endpoints ───────────────────────────────────────────────────────────

/**
 * GET /health
 * Quick health check for monitoring / Telegram Mini App init.
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    bingoRooms: bingoManager.getRoomCount(),
    ludoRooms: ludoManager.getRoomCount(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /user/:telegramId
 * Fetch a user's balance and stats.
 */
app.get('/user/:telegramId', async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({
      telegramId: user.telegramId,
      username: user.username,
      balance: user.balance,
      totalWinnings: user.totalWinnings,
      totalGamesPlayed: user.totalGamesPlayed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /user/register
 * Register or retrieve a user by Telegram ID.
 * Body: { telegramId, username }
 */
app.post('/user/register', async (req, res) => {
  const { telegramId, username } = req.body;
  if (!telegramId || !username) {
    return res.status(400).json({ error: 'telegramId and username are required.' });
  }
  try {
    const user = await User.findOneAndUpdate(
      { telegramId },
      { $setOnInsert: { telegramId, username, balance: 0 } },
      { upsert: true, new: true }
    );
    res.json({ telegramId: user.telegramId, username: user.username, balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /lobby/ludo
 * Returns all open Ludo rooms for the lobby screen.
 */
app.get('/lobby/ludo', (_req, res) => {
  res.json({ rooms: ludoManager.getOpenRooms() });
});

// ─── Socket.io Connection Handler ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Register game-specific handlers
  registerBingoHandlers(socket, bingoManager);
  registerLudoHandlers(socket, ludoManager);

  // ── Disconnect cleanup ──────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
    bingoManager.handleDisconnect(socket.id);
    ludoManager.handleDisconnect(socket.id);
  });

  // ── Global error guard ──────────────────────────────────────────────────
  socket.on('error', (err) => {
    console.error(`[Socket] Error on ${socket.id}:`, err.message);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🚀 Telegram Gaming Platform running on port ${PORT}`);
  console.log(`   → Bingo: up to 200 concurrent rooms`);
  console.log(`   → Ludo:  2/3/4 player rooms, 120s auto-cancel`);
  console.log(`   → Broker fee: 1 Birr per participant\n`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = (signal) => {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully…`);
  httpServer.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
