/**
 * adminRoutes.js
 * ──────────────
 * Secure REST API routes for the EthioGame Admin Panel.
 *
 * HOW TO USE:
 *   1. Add ADMIN_SECRET=your-secret-key-here to your Railway env vars
 *   2. In index.js, add these two lines near the top of the file:
 *        const adminRoutes = require('./adminRoutes');
 *        app.use('/admin/api', adminRoutes);
 *
 * All routes are protected by the ADMIN_SECRET key.
 * Pass it as: Authorization: Bearer <ADMIN_SECRET>
 */

const express     = require('express');
const router      = express.Router();
const User        = require('./models/User');
const Transaction = require('./models/Transaction');
const GameSession = require('./models/GameSession');

// ─── Auth Middleware ───────────────────────────────────────────────────────────

const requireAdminKey = (req, res, next) => {
  const auth = req.headers['authorization'] || '';
  const key  = auth.replace('Bearer ', '').trim();
  if (!key || key !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or missing ADMIN_SECRET.' });
  }
  next();
};

router.use(requireAdminKey);

// ─── GET /admin/api/stats ──────────────────────────────────────────────────────
// Dashboard overview: total users, total balance in system, pending txns, etc.

router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsers,
      blockedUsers,
      totalBalanceAgg,
      pendingDeposits,
      pendingWithdrawals,
      approvedToday,
      activeSessions,
      completedGames,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isBlocked: true }),
      User.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]),
      Transaction.countDocuments({ type: 'deposit',    status: 'pending' }),
      Transaction.countDocuments({ type: 'withdrawal', status: 'pending' }),
      Transaction.countDocuments({
        status: 'approved',
        approvedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),
      GameSession.countDocuments({ status: 'active' }),
      GameSession.countDocuments({ status: 'completed' }),
    ]);

    const totalBalanceInSystem = totalBalanceAgg[0]?.total || 0;

    res.json({
      totalUsers,
      blockedUsers,
      totalBalanceInSystem: +totalBalanceInSystem.toFixed(2),
      pendingDeposits,
      pendingWithdrawals,
      approvedToday,
      activeSessions,
      completedGames,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/api/users ──────────────────────────────────────────────────────
// List all users with search, filter, pagination

router.get('/users', async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(50, parseInt(req.query.limit) || 20);
    const search  = req.query.search || '';
    const filter  = req.query.filter || 'all'; // all | blocked | admin
    const sortBy  = req.query.sort   || 'createdAt';
    const sortDir = req.query.dir    === 'asc' ? 1 : -1;

    const query = {};
    if (search) {
      query.$or = [
        { username:   { $regex: search, $options: 'i' } },
        { firstName:  { $regex: search, $options: 'i' } },
        { telegramId: { $regex: search, $options: 'i' } },
      ];
    }
    if (filter === 'blocked') query.isBlocked = true;
    if (filter === 'admin')   query.isAdmin   = true;

    const allowedSortFields = ['balance', 'createdAt', 'gamesPlayed', 'totalDeposited', 'totalWinnings'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';

    const [users, total] = await Promise.all([
      User.find(query)
        .sort({ [sortField]: sortDir })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-__v'),
      User.countDocuments(query),
    ]);

    res.json({ users, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/api/users/:telegramId ─────────────────────────────────────────
// Single user full profile

router.get('/users/:telegramId', async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const [recentTxns, recentGames] = await Promise.all([
      Transaction.find({ telegramId: req.params.telegramId })
        .sort({ createdAt: -1 })
        .limit(10),
      GameSession.find({ 'players.telegramId': req.params.telegramId })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('roomId gameType stakeAmount status winnerTelegramId totalPrizePool createdAt completedAt'),
    ]);

    res.json({ user, recentTxns, recentGames });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /admin/api/users/:telegramId/balance ───────────────────────────────
// Adjust user balance (add or subtract). Creates an audit transaction record.

router.patch('/users/:telegramId/balance', async (req, res) => {
  const { adjustment, note } = req.body;
  if (typeof adjustment !== 'number' || adjustment === 0) {
    return res.status(400).json({ error: 'adjustment must be a non-zero number.' });
  }

  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const newBalance = +(user.balance + adjustment).toFixed(2);
    if (newBalance < 0) {
      return res.status(400).json({
        error: `Cannot reduce balance below 0. Current: ${user.balance}, Adjustment: ${adjustment}`,
      });
    }

    const updated = await User.findOneAndUpdate(
      { telegramId: req.params.telegramId },
      {
        $set: { balance: newBalance },
        ...(adjustment > 0 ? { $inc: { totalDeposited: adjustment } } : {}),
      },
      { new: true }
    );

    // Create audit record
    await Transaction.create({
      userId:       user._id,
      telegramId:   user.telegramId,
      username:     user.username,
      amount:       Math.abs(adjustment),
      type:         adjustment > 0 ? 'deposit' : 'withdrawal',
      status:       'approved',
      approvedBy:   'ADMIN_PANEL',
      approvedAt:   new Date(),
      reviewNote:   note || 'Manual balance adjustment via Admin Panel',
    });

    res.json({
      success: true,
      oldBalance: user.balance,
      newBalance: updated.balance,
      adjustment,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /admin/api/users/:telegramId/block ─────────────────────────────────

router.patch('/users/:telegramId/block', async (req, res) => {
  const { blocked, reason } = req.body;
  try {
    const user = await User.findOneAndUpdate(
      { telegramId: req.params.telegramId },
      { $set: { isBlocked: !!blocked, blockedReason: blocked ? (reason || 'Blocked via Admin Panel') : '' } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true, isBlocked: user.isBlocked, blockedReason: user.blockedReason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/api/transactions ──────────────────────────────────────────────
// All transactions with filter

router.get('/transactions', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const status = req.query.status || ''; // pending | approved | rejected
    const type   = req.query.type   || ''; // deposit | withdrawal

    const query = {};
    if (status) query.status = status;
    if (type)   query.type   = type;

    const [txns, total] = await Promise.all([
      Transaction.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Transaction.countDocuments(query),
    ]);

    res.json({ transactions: txns, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /admin/api/transactions/:id/approve ─────────────────────────────────

router.post('/transactions/:id/approve', async (req, res) => {
  const { amount } = req.body;
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Valid positive amount required.' });
  }
  try {
    const txn = await Transaction.findById(req.params.id);
    if (!txn)                    return res.status(404).json({ error: 'Transaction not found.' });
    if (txn.status !== 'pending') return res.status(400).json({ error: `Transaction is already ${txn.status}.` });

    txn.status     = 'approved';
    txn.amount     = parseFloat(amount);
    txn.approvedBy = 'ADMIN_PANEL';
    txn.approvedAt = new Date();
    await txn.save();

    const updatedUser = await User.findOneAndUpdate(
      { telegramId: txn.telegramId },
      { $inc: { balance: parseFloat(amount), totalDeposited: parseFloat(amount) } },
      { new: true }
    );

    res.json({ success: true, transaction: txn, newBalance: updatedUser?.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /admin/api/transactions/:id/reject ──────────────────────────────────

router.post('/transactions/:id/reject', async (req, res) => {
  const { reason } = req.body;
  try {
    const txn = await Transaction.findById(req.params.id);
    if (!txn)                    return res.status(404).json({ error: 'Transaction not found.' });
    if (txn.status !== 'pending') return res.status(400).json({ error: `Transaction is already ${txn.status}.` });

    txn.status          = 'rejected';
    txn.rejectionReason = reason || 'Rejected via Admin Panel';
    txn.approvedBy      = 'ADMIN_PANEL';
    txn.approvedAt      = new Date();
    await txn.save();

    res.json({ success: true, transaction: txn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/api/sessions ──────────────────────────────────────────────────

router.get('/sessions', async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(50, parseInt(req.query.limit) || 20);
    const status   = req.query.status   || '';
    const gameType = req.query.gameType || '';

    const query = {};
    if (status)   query.status   = status;
    if (gameType) query.gameType = gameType;

    const [sessions, total] = await Promise.all([
      GameSession.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      GameSession.countDocuments(query),
    ]);

    res.json({ sessions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
