const User        = require('../models/User');
const Transaction = require('../models/Transaction');

const registerUserHandlers = (socket, io) => {

  // ── user:getBalance ────────────────────────────────────────────────────────
  socket.on('user:getBalance', async ({ telegramId } = {}, cb) => {
    if (!telegramId) return cb?.({ success: false });
    try {
      const user = await User.findOne({ telegramId: String(telegramId) });
      if (!user) return cb?.({ success: false, message: 'User not found' });
      cb?.({ success: true, balance: user.balance - (user.lockedBalance || 0) });
    } catch (err) {
      console.error('[userHandlers] getBalance error:', err.message);
      cb?.({ success: false });
    }
  });

  // ── user:getTransactions ───────────────────────────────────────────────────
  socket.on('user:getTransactions', async ({ telegramId } = {}, cb) => {
    if (!telegramId) return cb?.({ success: false });
    try {
      const transactions = await Transaction.find({ telegramId: String(telegramId) })
        .sort({ createdAt: -1 })
        .limit(10);
      cb?.({ success: true, transactions });
    } catch (err) {
      console.error('[userHandlers] getTransactions error:', err.message);
      cb?.({ success: false, transactions: [] });
    }
  });

  // ── server:getStats ────────────────────────────────────────────────────────
  socket.on('server:getStats', async (_data, cb) => {
    try {
      // Get live room counts from global managers
      const bingoRooms = global.bingoManager ? global.bingoManager.getRoomCount() : 0;
      const ludoRooms  = global.ludoManager  ? global.ludoManager.getRoomCount()  : 0;
      const liveRooms  = bingoRooms + ludoRooms;

      // Get online count
      const onlineCount = io.engine.clientsCount || 0;

      // Get total paid today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const paidResult = await Transaction.aggregate([
        { $match: { type: 'withdrawal', status: 'approved', createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      const paidToday = paidResult[0]?.total || 0;

      cb?.({ success: true, liveRooms, online: onlineCount, paidToday });
    } catch (err) {
      console.error('[userHandlers] getStats error:', err.message);
      cb?.({ success: false, liveRooms: 0, online: 0, paidToday: 0 });
    }
  });

  // ── user:requestWithdraw ───────────────────────────────────────────────────
  socket.on('user:requestWithdraw', async ({ telegramId, amount, phone } = {}, cb) => {
    if (!telegramId || !amount || !phone) {
      return cb?.({ success: false, message: 'Missing required fields' });
    }
    try {
      const existing = await Transaction.findOne({
        telegramId: String(telegramId),
        type:   'withdrawal',
        status: 'pending',
      });

      if (existing) {
        return cb?.({
          success: false,
          message: 'You already have a pending withdrawal. Please wait for it to be processed.',
        });
      }

      const updatedUser = await User.lockForWithdrawal(String(telegramId), amount);
      if (!updatedUser) {
        return cb?.({ success: false, message: 'Insufficient balance or account blocked.' });
      }

      const txn = await Transaction.create({
        userId:            updatedUser._id,
        telegramId:        String(telegramId),
        username:          updatedUser.username,
        type:              'withdrawal',
        status:            'pending',
        amount,
        telebirrReference: phone,
      });

      // ✅ Notify admin using Node 18 built-in fetch
      const adminId = process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_GROUP_ID || process.env.ADMIN_ID;
      if (adminId && process.env.BOT_TOKEN) {
        try {
          await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id:    adminId,
              text:
                `💸 *New Withdrawal Request*\n\n` +
                `👤 @${updatedUser.username} (\`${telegramId}\`)\n` +
                `💰 Amount: *${amount} Birr*\n` +
                `📱 Telebirr: *${phone}*\n` +
                `🆔 TxID: \`${txn._id}\`\n\n` +
                `To approve:\n\`/approvewithdraw ${txn._id}\`\n\n` +
                `To reject:\n\`/rejectwithdraw ${txn._id} <reason>\``,
              parse_mode: 'Markdown',
            }),
          });
        } catch (e) {
          console.error('[userHandlers] Admin notify error:', e.message);
        }
      }

      socket.emit('user:balanceUpdated', {
        balance: updatedUser.balance - (updatedUser.lockedBalance || 0),
      });

      cb?.({ success: true, txId: txn._id });

    } catch (err) {
      console.error('[userHandlers] requestWithdraw error:', err.message);
      cb?.({ success: false, message: 'Server error. Please try again.' });
    }
  });

};

module.exports = registerUserHandlers;
