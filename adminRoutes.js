/**
 * adminRoutes.js
 * ──────────────
 * Secure REST API routes for the EthioGame Admin Panel.
 *
 * HOW TO USE:
 *   1. Add ADMIN_SECRET=your-secret-key-here to your Railway env vars
 *   2. This file is already imported and mounted in index.js — no changes needed there.
 *
 * All routes are protected by the ADMIN_SECRET key.
 * Pass it as: Authorization: Bearer <ADMIN_SECRET>
 *
 * FIXED BUGS:
 *   1. Withdrawal approval now correctly DEDUCTS balance instead of crediting it.
 *   2. Withdrawal rejection now unlocks the locked balance.
 *   3. All balance-changing actions now emit real-time socket updates to the user.
 */

const express     = require('express');
const User        = require('./models/User');
const Transaction = require('./models/Transaction');
const GameSession = require('./models/GameSession');

// ─── Factory: accepts io so we can push real-time balance updates ──────────────
module.exports = function makeAdminRouter(io) {
  const router = express.Router();

  // ─── Auth Middleware ─────────────────────────────────────────────────────────

  const requireAdminKey = (req, res, next) => {
    const auth = req.headers['authorization'] || '';
    const key  = auth.replace('Bearer ', '').trim();
    if (!key || key !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized. Invalid or missing ADMIN_SECRET.' });
    }
    next();
  };

  router.use(requireAdminKey);

  // ─── Helper: push live balance to a user's open Mini App ──────────────────
  // userHandlers.js makes every connected socket join "user:<telegramId>",
  // so this reaches the user immediately if they have the Mini App open.
  const pushBalance = async (telegramId) => {
    try {
      const u = await User.findOne({ telegramId: String(telegramId) });
      if (u && io) {
        io.to(`user:${telegramId}`).emit('user:balanceUpdated', {
          balance: u.balance - (u.lockedBalance || 0),
        });
      }
    } catch (_) {}
  };

  // ─── GET /admin/api/stats ──────────────────────────────────────────────────

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

  // ─── GET /admin/api/users ──────────────────────────────────────────────────

  router.get('/users', async (req, res) => {
    try {
      const page    = Math.max(1, parseInt(req.query.page)  || 1);
      const limit   = Math.min(50, parseInt(req.query.limit) || 20);
      const search  = req.query.search || '';
      const filter  = req.query.filter || 'all';
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

  // ─── GET /admin/api/users/:telegramId ─────────────────────────────────────

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

  // ─── PATCH /admin/api/users/:telegramId/balance ───────────────────────────
  // FIX: now emits real-time socket update to the user's open Mini App.

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
        userId:     user._id,
        telegramId: user.telegramId,
        username:   user.username,
        amount:     Math.abs(adjustment),
        type:       adjustment > 0 ? 'deposit' : 'withdrawal',
        status:     'approved',
        approvedBy: 'ADMIN_PANEL',
        approvedAt: new Date(),
        reviewNote: note || 'Manual balance adjustment via Admin Panel',
      });

      // FIX: push real-time update to user's Mini App
      await pushBalance(req.params.telegramId);

      res.json({
        success:    true,
        oldBalance: user.balance,
        newBalance: updated.balance,
        adjustment,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PATCH /admin/api/users/:telegramId/clearlock ────────────────────────
  // Resets a stuck lockedBalance to 0 when no pending withdrawal exists.

  router.patch('/users/:telegramId/clearlock', async (req, res) => {
    try {
      const user = await User.findOne({ telegramId: req.params.telegramId });
      if (!user) return res.status(404).json({ error: 'User not found.' });

      const stuckAmount = user.lockedBalance || 0;
      if (stuckAmount === 0) {
        return res.json({ success: true, message: 'No locked balance to clear.', freed: 0 });
      }

      const updated = await User.findOneAndUpdate(
        { telegramId: req.params.telegramId },
        { $set: { lockedBalance: 0 } },
        { new: true }
      );

      // Create audit record
      await Transaction.create({
        userId:     user._id,
        telegramId: user.telegramId,
        username:   user.username,
        amount:     stuckAmount,
        type:       'deposit',
        status:     'approved',
        approvedBy: 'ADMIN_PANEL',
        approvedAt: new Date(),
        reviewNote: `Admin cleared stuck locked balance of ${stuckAmount} Birr`,
      });

      // Push real-time balance update
      await pushBalance(req.params.telegramId);

      res.json({
        success:     true,
        freed:       stuckAmount,
        newBalance:  updated.balance,
        newLocked:   updated.lockedBalance,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PATCH /admin/api/users/:telegramId/block ─────────────────────────────

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

  // ─── GET /admin/api/transactions ──────────────────────────────────────────

  router.get('/transactions', async (req, res) => {
    try {
      const page   = Math.max(1, parseInt(req.query.page)  || 1);
      const limit  = Math.min(50, parseInt(req.query.limit) || 20);
      const status = req.query.status || '';
      const type   = req.query.type   || '';

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

  // ─── POST /admin/api/transactions/:id/approve ─────────────────────────────
  // FIXED: deposits → credit balance; withdrawals → deduct balance + remove lock.
  // FIXED: emits real-time socket update to the affected user.

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

      let updatedUser;

      if (txn.type === 'withdrawal') {
        // FIX: withdrawals must DEDUCT balance and remove the lock atomically
        updatedUser = await User.approveWithdrawal(txn.telegramId, parseFloat(amount));
      } else {
        // Deposit: credit balance
        updatedUser = await User.findOneAndUpdate(
          { telegramId: txn.telegramId },
          { $inc: { balance: parseFloat(amount), totalDeposited: parseFloat(amount) } },
          { new: true }
        );
      }

      // FIX: push real-time balance update to user's open Mini App
      if (updatedUser) {
        io.to(`user:${txn.telegramId}`).emit('user:balanceUpdated', {
          balance: updatedUser.balance - (updatedUser.lockedBalance || 0),
        });
      }

      res.json({ success: true, transaction: txn, newBalance: updatedUser?.balance });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /admin/api/transactions/:id/reject ──────────────────────────────
  // FIXED: withdrawal rejection now unlocks the frozen funds so the user can
  //        spend their balance again. Also emits a real-time socket update.

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

      // FIX: if it was a withdrawal, release the locked funds back to available
      if (txn.type === 'withdrawal' && txn.amount > 0) {
        const updatedUser = await User.rejectWithdrawal(txn.telegramId, txn.amount);
        if (updatedUser) {
          io.to(`user:${txn.telegramId}`).emit('user:balanceUpdated', {
            balance: updatedUser.balance - (updatedUser.lockedBalance || 0),
          });
        }
      }

      res.json({ success: true, transaction: txn });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /admin/api/sessions ──────────────────────────────────────────────

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

  return router;
};
