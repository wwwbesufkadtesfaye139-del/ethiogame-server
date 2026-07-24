// Must be the first require in the entire process — see instrument.js
// for why. Also loads dotenv, so no separate dotenv.config() call needed.
const Sentry  = require('./instrument');
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const { Server } = require('socket.io');

const connectDB   = require('./config/db');
const User        = require('./models/User');
const Transaction = require('./models/Transaction');
const BingoManager = require('./managers/BingoManager');
const LudoManager  = require('./managers/LudoManager');
const registerBingoHandlers = require('./socket/bingoHandlers');
const registerLudoHandlers  = require('./socket/ludoHandlers');
const registerUserHandlers  = require('./socket/userHandlers');
const makeAdminRouter = require('./adminRoutes');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');

const PORT = process.env.PORT || 3000;
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// multer — store upload in memory as a Buffer (no disk needed)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

// ─── App & Server Setup ───────────────────────────────────────────────────────

const app = express();

// Trust Railway's proxy so rate limiter sees real client IPs
app.set('trust proxy', 1);

// Security headers — XSS protection, clickjacking prevention, content sniffing, etc.
app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ─── Rate Limiters ────────────────────────────────────────────────────────────

// General: 100 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// Deposit upload: max 5 per hour per IP (prevents receipt spam to admin)
const depositLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many deposit attempts. Please wait before trying again.' },
});

// Admin API: 60 per minute per IP
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests. Slow down.' },
});

app.use(generalLimiter);

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000,
});

// FIX: Mount admin routes AFTER io is created, passing io so it can
//      emit real-time balance updates to users' open Mini App sessions.
app.use('/admin/api', adminLimiter, makeAdminRouter(io));

// ─── Socket Auth Middleware ───────────────────────────────────────────────────
// Verifies every socket connection using Telegram's HMAC-SHA256 initData.
// Sets socket.data.telegramId — all handlers use THIS, never the client value.
const verifyTelegramInitData = require('./utils/verifyTelegram');

io.use((socket, next) => {
  const initData = socket.handshake.auth?.initData || '';
  const BOT_TOKEN = process.env.BOT_TOKEN;

  // Dev mode: allow connections without initData for local testing
  if (!initData) {
    if (process.env.NODE_ENV !== 'production') {
      socket.data.telegramId = 'dev';
      socket.data.username   = 'DevPlayer';
      return next();
    }
    return next(new Error('MISSING_INIT_DATA'));
  }

  if (!BOT_TOKEN) {
    console.error('[Auth] BOT_TOKEN env var not set — cannot verify initData');
    return next(new Error('SERVER_CONFIG_ERROR'));
  }

  const user = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!user) {
    return next(new Error('INVALID_INIT_DATA'));
  }

  // Store verified identity on the socket — handlers trust only this
  socket.data.telegramId = String(user.id);
  socket.data.username   = user.username || user.first_name || 'Player';
  next();
});

// ─── Connect DB ───────────────────────────────────────────────────────────────

connectDB();

// ─── Game Managers ────────────────────────────────────────────────────────────

const bingoManager = new BingoManager(io);
const ludoManager  = new LudoManager(io);
global.bingoManager = bingoManager;
global.ludoManager  = ludoManager;

setInterval(() => {
  bingoManager.sweepStaleRooms();
  ludoManager.sweepStaleRooms();
}, STALE_SWEEP_INTERVAL_MS);

// ─── REST Endpoints ───────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    bingoRooms: bingoManager.getRoomCount(),
    ludoRooms:  ludoManager.getRoomCount(),
    timestamp:  new Date().toISOString(),
  });
});

app.get('/user/:telegramId', async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({
      telegramId:       user.telegramId,
      username:         user.username,
      balance:          user.balance,
      totalWinnings:    user.totalWinnings,
      totalGamesPlayed: user.totalGamesPlayed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/lobby/ludo', (_req, res) => {
  res.json({ rooms: ludoManager.getOpenRooms() });
});

// ─── POST /deposit/upload ─────────────────────────────────────────────────────

app.post('/deposit/upload', depositLimiter, upload.single('photo'), async (req, res) => {
  const file     = req.file;
  const initData = req.body?.initData;

  if (!file || !initData) {
    return res.status(400).json({ success: false, message: 'Missing photo or initData.' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ADMIN_ID  = process.env.ADMIN_GROUP_ID || process.env.ADMIN_ID;

  if (!BOT_TOKEN || !ADMIN_ID) {
    console.error('[deposit/upload] BOT_TOKEN or ADMIN_ID not configured.');
    return res.status(500).json({ success: false, message: 'Server configuration error.' });
  }

  // ✅ FIX #3 — Verify Telegram identity before touching the database.
  //
  // Old code read telegramId straight from req.body — any user could POST
  // with someone else's telegramId and have funds credited to that account.
  //
  // We now run the same HMAC-SHA256 check used by the socket auth middleware.
  // telegramId and username are extracted only from the verified payload,
  // making identity spoofing impossible without access to the bot token.
  const verifiedUser = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verifiedUser) {
    console.warn('[deposit/upload] Rejected: invalid or expired initData');
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired Telegram session. Please reopen the app.',
    });
  }

  const telegramId = String(verifiedUser.id);
  const username   = verifiedUser.username || verifiedUser.first_name || 'Anonymous';

  try {
    // ── Find or create user ─────────────────────────────────────────────────
    const user = await User.findOneAndUpdate(
      { telegramId: String(telegramId) },
      { $setOnInsert: { telegramId: String(telegramId), username, balance: 0 } },
      { upsert: true, new: true }
    );

    // ── Spam guard ──────────────────────────────────────────────────────────
    const pendingCount = await Transaction.countPendingByUser(String(telegramId));
    if (pendingCount >= 3) {
      return res.status(429).json({
        success: false,
        message: `You already have ${pendingCount} pending deposit(s). Please wait for admin approval.`,
      });
    }

    // ── Create pending Transaction ──────────────────────────────────────────
    const txn = await Transaction.create({
      userId:     user._id,
      telegramId: String(telegramId),
      username:   username || user.username || 'Anonymous',
      type:       'deposit',
      status:     'pending',
      amount:     0,
    });

    // ── Forward photo to Telegram admin ─────────────────────────────────────
    const formData = new FormData();
    const blob     = new Blob([file.buffer], { type: file.mimetype });
    formData.append('chat_id',    ADMIN_ID);
    formData.append('photo',      blob, file.originalname || `receipt_${txn._id}.jpg`);
    formData.append('caption',
      `📥 *New Deposit Request (Mini App)*\n\n` +
      `👤 @${username} (\`${telegramId}\`)\n` +
      `🆔 Transaction ID: \`${txn._id}\`\n\n` +
      `To approve:\n\`/release ${telegramId} <amount>\`\n\n` +
      `To reject:\n\`/reject ${txn._id} <reason>\``
    );
    formData.append('parse_mode', 'Markdown');

    const tgRes  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body:   formData,
    });
    const tgData = await tgRes.json();

    if (tgData.ok) {
      const fileId = tgData.result?.photo?.at(-1)?.file_id;
      if (fileId) {
        await Transaction.findByIdAndUpdate(txn._id, { screenshotFileId: fileId });
      }
    } else {
      console.warn('[deposit/upload] Telegram forward failed:', tgData.description);
    }

    return res.json({
      success: true,
      txId:    String(txn._id),
      message: 'Receipt submitted! Admin will verify and credit your balance shortly.',
    });

  } catch (err) {
    console.error('[deposit/upload] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─── Sentry Express Error Handler ─────────────────────────────────────────────
// Must come after all routes above, and before any custom error middleware
// (there isn't one here — each route already handles its own try/catch and
// sends a response; this is a safety net for anything that slips through).
Sentry.setupExpressErrorHandler(app);

// ─── Socket.io Connection Handler ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);
  registerBingoHandlers(socket, io, bingoManager);
  registerLudoHandlers(socket, io, ludoManager);
  registerUserHandlers(socket, io);

  // ✅ FIX #1 — async so the refund DB write in handleDisconnect fully
  // completes before the process continues. Without await, the refund
  // was fire-and-forget and could be silently skipped under load.
  socket.on('disconnect', async (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
    await bingoManager.handleDisconnect(socket.id);
    ludoManager.handleDisconnect(socket.id);
  });

  socket.on('error', (err) => {
    console.error(`[Socket] Error on ${socket.id}:`, err.message);
    Sentry.captureException(err, {
      tags: { source: 'socket' },
      extra: { socketId: socket.id, telegramId: socket.data?.telegramId },
    });
  });
});

// ─── Process-level Safety Net ──────────────────────────────────────────────────
// Neither of these change existing crash behavior — Node already terminates
// the process by default when an exception/rejection has no listener. This
// just makes sure Sentry sees it (with which player/room was involved, where
// known) before that happens, instead of the error only ever reaching the
// Railway log tail.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  Sentry.captureException(err, { tags: { source: 'uncaughtException' } });
  // Flush before exiting — an uncaught exception leaves the process in an
  // undefined state, so we exit right after, same as Node's own default.
  Sentry.close(2000).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  Sentry.captureException(reason, { tags: { source: 'unhandledRejection' } });
  Sentry.close(2000).finally(() => process.exit(1));
});

// ─── Start Server ─────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🚀 Telegram Gaming Platform running on port ${PORT}`);
  console.log(`   → Bingo: up to 200 concurrent rooms`);
  console.log(`   → Ludo:  2/3/4 player rooms, 120s auto-cancel`);
  console.log(`   → Broker fee: 10% of the total pool\n`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = (signal) => {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully…`);
  httpServer.close(() => {
    console.log('[Server] HTTP server closed.');
    Sentry.close(2000).finally(() => process.exit(0));
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
