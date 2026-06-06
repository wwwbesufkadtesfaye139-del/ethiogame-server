require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const User = require('./models/User');
const Transaction = require('./models/Transaction');
const BingoManager = require('./managers/BingoManager');
const LudoManager = require('./managers/LudoManager');
const registerBingoHandlers = require('./socket/bingoHandlers');
const registerLudoHandlers = require('./socket/ludoHandlers');
const registerUserHandlers = require('./socket/userHandlers');

const PORT = process.env.PORT || 3000;
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// ─── App & Server Setup ───────────────────────────────────────────────────────

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' })); // ✅ increased limit for base64 images

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

connectDB();

// ─── Game Managers ────────────────────────────────────────────────────────────

const bingoManager = new BingoManager(io);
const ludoManager = new LudoManager(io);
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
    ludoRooms: ludoManager.getRoomCount(),
    timestamp: new Date().toISOString(),
  });
});

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
// Called by the Mini App DepositScreen when user uploads a Telebirr receipt.
// Receives base64 image + user info, forwards photo to the Telegram admin group,
// and creates a pending Transaction record in MongoDB.

app.post('/deposit/upload', async (req, res) => {
  const { image, mimeType, telegramId, username } = req.body;

  // ── Validate input ──────────────────────────────────────────────────────────
  if (!image || !telegramId) {
    return res.status(400).json({ success: false, message: 'Missing image or telegramId.' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ADMIN_ID  = process.env.ADMIN_GROUP_ID || process.env.ADMIN_ID;

  if (!BOT_TOKEN || !ADMIN_ID) {
    console.error('[deposit/upload] BOT_TOKEN or ADMIN_ID not configured.');
    return res.status(500).json({ success: false, message: 'Server configuration error.' });
  }

  try {
    // ── Find or create user ─────────────────────────────────────────────────
    const user = await User.findOneAndUpdate(
      { telegramId: String(telegramId) },
      { $setOnInsert: { telegramId: String(telegramId), username: username || 'Anonymous', balance: 0 } },
      { upsert: true, new: true }
    );

    // ── Spam guard: max 3 pending deposits ──────────────────────────────────
    const pendingCount = await Transaction.countPendingByUser(String(telegramId));
    if (pendingCount >= 3) {
      return res.status(429).json({
        success: false,
        message: `You already have ${pendingCount} pending deposit(s). Please wait for admin approval.`,
      });
    }

    // ── Create pending Transaction (amount=0 until admin sets it) ───────────
    const txn = await Transaction.create({
      userId:     user._id,
      telegramId: String(telegramId),
      username:   username || user.username || 'Anonymous',
      type:       'deposit',
      status:     'pending',
      amount:     0,
    });

    // ── Convert base64 → Buffer, forward photo to Telegram admin ────────────
    const imageBuffer = Buffer.from(image, 'base64');
    const mime        = mimeType || 'image/jpeg';
    const ext         = mime.split('/')[1]?.split('+')[0] || 'jpg';

    const formData = new FormData();
    const blob     = new Blob([imageBuffer], { type: mime });
    formData.append('chat_id',    ADMIN_ID);
    formData.append('photo',      blob, `receipt_${txn._id}.${ext}`);
    formData.append('caption',
      `📥 *New Deposit Request (Mini App)*\n\n` +
      `👤 @${username || 'Anonymous'} (\`${telegramId}\`)\n` +
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
      // Save the Telegram file_id so admin can reference the photo later
      const fileId = tgData.result?.photo?.at(-1)?.file_id;
      if (fileId) {
        await Transaction.findByIdAndUpdate(txn._id, { screenshotFileId: fileId });
      }
    } else {
      // Log the error but still return success — transaction is saved,
      // admin can still find it via /pending command in the bot
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

// ─── Socket.io Connection Handler ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // ✅ FIXED — pass io as second argument so handlers can emit balance updates
  // to specific sockets (e.g. notifying winner after game ends)
  registerBingoHandlers(socket, io, bingoManager); // ← was: registerBingoHandlers(socket, bingoManager)
  registerLudoHandlers(socket, io, ludoManager);   // ← was: registerLudoHandlers(socket, ludoManager)
  registerUserHandlers(socket, io);

  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
    bingoManager.handleDisconnect(socket.id);
    ludoManager.handleDisconnect(socket.id);
  });

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
process.on('SIGINT',  () => shutdown('SIGINT'));
