'use strict';
/**
 * 本地 RPC 兼容层
 * ---------------------------------------------------------------
 * 目的：让 server/orders.js（生成单状态机）与前端钱包调用**一行不改**就从
 * 「云端 RPC」切到「本地 SQLite」。只要保持返回形状 {"status","data","text"}、
 * 以及各函数的数据契约（行数组 / 标量 / 错误文本），上层完全无感。
 *
 * 数据契约（与云端一致，改这里就要同步改 orders.js）：
 *   wallet_balance    → 数字
 *   wallet_consume    → [{ txn_id, balance }]
 *   wallet_refund     → 数字（余额）；重复退 → 非 200 + 'ALREADY_REFUNDED'
 *   wallet_redeem     → { balance, credits, code, alreadyOwned }（旧版是裸余额数字，前端兼容两种）
 *   wallet_redeem_batch → { balance, credits, code, batch, alreadyOwned }（邀请链接，服务端分配码）
 *   wallet_pay_claim  → 数字（余额）
 *   order_create      → [{ order_id, status:'pending', credits }]
 *   order_succeed     → [{ order_id, status }]
 *   order_fail        → [{ order_id, status, refunded, balance }]，查无此单 status='missing'
 *   order_get         → [{ ... }]
 *   order_reap        → [{ refunded, balance }]
 *   order_health      → { pending_total, pending_stale, oldest_pending_minutes,
 *                         window_hours, succeeded_window, failed_window, fail_reasons }
 */

const crypto = require('crypto');
const dbmod = require('./db');
const wallet = require('./wallet');
const auth = require('./auth');

function ok(data) { return { status: 200, data: data, text: JSON.stringify(data) }; }
function err(status, text) { return { status: status, data: { message: text }, text: text }; }

const REAP_MINUTES_DEFAULT = 30;

function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

/* order_fail 的核心：关单 + 退款同事务，幂等 */
function failOrder(orderId, userId, reason) {
  return dbmod.tx((d) => {
    const o = d.prepare('SELECT id, user_id, status, credits FROM orders WHERE id = ?').get(String(orderId));
    if (!o) { return { order_id: String(orderId), status: 'missing', refunded: false, balance: userId ? wallet.balance(userId) : null }; }
    if (o.user_id !== userId) { return { order_id: o.id, status: 'missing', refunded: false, balance: wallet.balance(userId) }; }
    if (o.status !== 'pending') {
      /* 已成功/已退过的单不再改写（重复回调、补退竞态都落这里） */
      return { order_id: o.id, status: o.status, refunded: o.status === 'failed', balance: wallet.balance(userId) };
    }
    let refunded = false;
    try {
      wallet.refundCore(d, userId, o.id);
      refunded = true;
    } catch (e) {
      if (e && e.code === 'ALREADY_REFUNDED') { refunded = true; }
      else if (e && e.code === 'NOT_FOUND') { refunded = false; }
      else { throw e; }
    }
    d.prepare('UPDATE orders SET status = ?, fail_reason = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run('failed', String(reason || '').slice(0, 300), dbmod.nowMs(), o.id, 'pending');
    return { order_id: o.id, status: 'failed', refunded: refunded, balance: wallet.balance(userId) };
  });
}

/**
 * @param {object} deps
 * @param {function} deps.accessKey  返回服务器 accessKey（巡检门）；也可返回 ''
 * @param {function} deps.paySecret  返回支付签名密钥
 * @param {function} deps.log
 */
function createLocalCloud(deps) {
  const d = deps || {};
  const accessKey = d.accessKey || function () { return ''; };
  const paySecret = d.paySecret || function () { return ''; };
  const log = d.log || function () {};

  /* 兑换码尝试限流（按用户滑动窗口）：5 分钟内 10 次 + 1 小时内 50 次。
     内存态即可：重启清零无妨——限流是刹车，不是账本。 */
  const tries = new Map(); /* userId -> [timestamp, ...] */
  const redeemTries = {
    take(userId) {
      const now = Date.now();
      const arr = (tries.get(userId) || []).filter((t) => now - t < 3600 * 1000);
      const ok = arr.filter((t) => now - t < 5 * 60 * 1000).length < 10 && arr.length < 50;
      if (ok) { arr.push(now); }
      tries.set(userId, arr);
      return ok;
    }
  };

  const impl = {
    wallet_balance: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      return ok(wallet.balance(user.id));
    },

    wallet_consume: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      const credits = Number(p.p_credits);
      if (!credits || credits >= 0) { return err(400, 'BAD_AMOUNT'); }
      try {
        const r = wallet.consume(user.id, Math.abs(credits), p.p_ref, { memo: p.p_memo, product: p.p_product });
        return ok([{ txn_id: r.txnId, balance: r.balance }]);
      } catch (e) {
        return err(e.code === 'INSUFFICIENT_BALANCE' ? 402 : 400, (e && e.code) || 'CONSUME_FAILED');
      }
    },

    wallet_refund: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      try {
        return ok(wallet.refund(user.id, String(p.p_ref || '')));
      } catch (e) {
        return err(400, (e && e.code) || 'REFUND_FAILED');
      }
    },

    wallet_redeem: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      /* 兑换尝试限流（成功失败都算）：防止拿接口枚举试码。码空间 32^10 ≈ 2^50，
         本来就爆破不动，这里再加一道闸让试探彻底不划算。 */
      if (!redeemTries.take(user.id)) { return err(429, 'TOO_MANY'); }
      try {
        return ok(wallet.redeem(user.id, p.p_code));
      } catch (e) {
        /* message 保留 "CODE: 中文原因" 形状：上层用 /CODE_/ 判类型，
           同时能拿到「兑换码已被使用 / 已过期 / 不含 0 和 O」这类具体说法。 */
        const code = (e && e.code) || 'CODE_INVALID';
        const detail = e && e.message && e.message !== code ? code + ': ' + e.message : code;
        return err(400, detail);
      }
    },

    /* 邀请链接领码：batch 是链接里的批次号，码由服务端分配（见 wallet.redeemBatch） */
    wallet_redeem_batch: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      if (!redeemTries.take(user.id)) { return err(429, 'TOO_MANY'); }
      try {
        return ok(wallet.redeemBatch(user.id, p.p_batch));
      } catch (e) {
        /* 与 wallet_redeem 同形状："BATCH_EXHAUSTED: 中文原因"，前端按冒号前判类型 */
        const code = (e && e.code) || 'BATCH_INVALID';
        const detail = e && e.message && e.message !== code ? code + ': ' + e.message : code;
        return err(400, detail);
      }
    },

    /* 新用户见面礼：注册后自动领 2 积分。无参数——批次号是服务端内置的，
       不让客户端指定，避免被当成「任意批次免检领取」的入口。
       形状与 wallet_redeem_batch 一致。 */
    wallet_claim_welcome: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      if (!redeemTries.take(user.id)) { return err(429, 'TOO_MANY'); }
      try {
        return ok(wallet.claimWelcome(user.id));
      } catch (e) {
        const code = (e && e.code) || 'WELCOME_FAILED';
        const detail = e && e.message && e.message !== code ? code + ': ' + e.message : code;
        return err(400, detail);
      }
    },

    /* 支付入账：验签由服务器 /api/pay/claim 生成的 md5 凭证承担 */
    wallet_pay_claim: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      const orderNo = String(p.p_order_no || '');
      const userId = String(p.p_user || '');
      const credits = Number(p.p_credits) || 0;
      const ts = Number(p.p_ts) || 0;
      const sig = String(p.p_sig || '');
      const secret = paySecret();
      if (!orderNo || !credits || !secret) { return err(400, 'BAD_PAYLOAD'); }
      if (userId !== user.id) { return err(403, 'USER_MISMATCH'); }
      if (Math.abs(Date.now() / 1000 - ts) > 900) { return err(400, 'CLAIM_EXPIRED'); }
      if (md5(orderNo + '|' + userId + '|' + credits + '|' + ts + '|' + secret) !== sig) {
        return err(403, 'BAD_SIGNATURE');
      }
      try {
        const r = wallet.payCredit(user.id, credits, orderNo, '在线支付充值');
        return ok(r.balance);
      } catch (e) {
        return err(400, (e && e.code) || 'PAY_FAILED');
      }
    },

    order_create: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      const id = String(p.p_id || '');
      if (!id) { return err(400, 'BAD_ID'); }
      const credits = Math.abs(Number(p.p_credits) || 0);
      const product = String(p.p_product || 'avatar');
      return dbmod.tx((db) => {
        const exist = db.prepare('SELECT id, status, credits FROM orders WHERE id = ?').get(id);
        if (exist) {
          return ok([{ order_id: id, status: exist.status, credits: exist.credits, duplicated: true }]);
        }
        const now = dbmod.nowMs();
        db.prepare(
          'INSERT INTO orders (id, user_id, product, status, credits, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, user.id, product, 'pending', credits, JSON.stringify(p.p_meta || {}), now, now);
        return ok([{ order_id: id, status: 'pending', credits: credits }]);
      });
    },

    order_succeed: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      const id = String(p.p_id || '');
      if (!id) { return err(400, 'BAD_ID'); }
      return dbmod.tx((db) => {
        const o = db.prepare('SELECT id, user_id, status FROM orders WHERE id = ?').get(id);
        if (!o || o.user_id !== user.id) { return ok([{ order_id: id, status: 'missing' }]); }
        if (o.status !== 'pending') { return ok([{ order_id: id, status: o.status }]); }
        db.prepare('UPDATE orders SET status = ?, result_ref = ?, updated_at = ? WHERE id = ? AND status = ?')
          .run('succeeded', String(p.p_result_ref == null ? '' : p.p_result_ref), dbmod.nowMs(), id, 'pending');
        return ok([{ order_id: id, status: 'succeeded' }]);
      });
    },

    order_fail: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      const id = String(p.p_id || '');
      if (!id) { return err(400, 'BAD_ID'); }
      try {
        return ok([failOrder(id, user.id, p.p_reason)]);
      } catch (e) {
        log('order_fail 异常：' + ((e && e.message) || e));
        return err(500, 'ORDER_FAIL_ERROR');
      }
    },

    order_get: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      const row = dbmod.db.prepare('SELECT * FROM orders WHERE id = ?').get(String(p.p_id || ''));
      if (!row || row.user_id !== user.id) { return ok([]); }
      return ok([{
        order_id: row.id, product: row.product, status: row.status, credits: row.credits,
        result_ref: row.result_ref, fail_reason: row.fail_reason,
        created_at: new Date(Number(row.created_at)).toISOString()
      }]);
    },

    /* 登录后补退：把本人超窗仍 pending 的单关掉退款 */
    order_reap: (user, p) => {
      if (!user) { return err(401, 'AUTH_REQUIRED'); }
      const minutes = Math.max(1, Number(p.p_minutes) || REAP_MINUTES_DEFAULT);
      const cutoff = dbmod.nowMs() - minutes * 60 * 1000;
      const rows = dbmod.db.prepare('SELECT id FROM orders WHERE user_id = ? AND status = ? AND created_at < ? LIMIT 50')
        .all(user.id, 'pending', cutoff);
      let refunded = 0;
      for (const r of rows) {
        const out = failOrder(r.id, user.id, 'abandoned:' + minutes + 'min');
        if (out.refunded && out.status === 'failed') { refunded++; }
      }
      return ok([{ refunded: refunded, balance: wallet.balance(user.id) }]);
    },

    /* 运维巡检：accessKey 门（无登录身份），只回计数，不含用户标识 */
    order_health: (user, p) => {
      const key = String(p.p_key || '');
      const serverKey = accessKey();
      if (!serverKey || key !== serverKey) { return err(403, 'FORBIDDEN'); }
      const hours = Math.max(1, Math.min(Number(p.p_hours) || 24, 720));
      const now = dbmod.nowMs();
      const cut = now - hours * 3600 * 1000;
      const db = dbmod.db;
      const pendingTotal = Number(db.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ?').get('pending').c);
      const staleCut = now - REAP_MINUTES_DEFAULT * 60 * 1000;
      const stale = Number(db.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ? AND created_at < ?').get('pending', staleCut).c);
      const oldestRow = db.prepare('SELECT MIN(created_at) AS t FROM orders WHERE status = ?').get('pending');
      const oldest = oldestRow && oldestRow.t ? Math.round((now - Number(oldestRow.t)) / 60000) : 0;
      const succeeded = Number(db.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ? AND updated_at > ?').get('succeeded', cut).c);
      const failed = Number(db.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ? AND updated_at > ?').get('failed', cut).c);
      const reasons = {};
      for (const r of db.prepare('SELECT fail_reason, COUNT(*) AS c FROM orders WHERE status = ? AND updated_at > ? GROUP BY fail_reason').all('failed', cut)) {
        if (r.fail_reason) { reasons[r.fail_reason] = Number(r.c); }
      }
      return ok({
        pending_total: pendingTotal,
        pending_stale: stale,
        oldest_pending_minutes: oldest,
        window_hours: hours,
        succeeded_window: succeeded,
        failed_window: failed,
        fail_reasons: reasons
      });
    }
  };

  function dispatch(token, fn, params) {
    const p = params || {};
    const handler = impl[fn];
    if (!handler) { return Promise.resolve(err(404, 'UNKNOWN_RPC:' + fn)); }
    let user = null;
    if (token) {
      user = auth.userFromToken(token);
      if (!user && fn !== 'order_health') { return Promise.resolve(err(401, 'AUTH_REQUIRED')); }
    }
    try {
      return Promise.resolve(handler(user, p));
    } catch (e) {
      log('rpc ' + fn + ' 异常：' + ((e && e.message) || e));
      return Promise.resolve(err(500, (e && e.code) || 'RPC_ERROR'));
    }
  }

  return {
    /* 与 cloudRpc 同签名：rpc(token, fn, params) → {status, data, text} */
    rpc: (token, fn, params) => dispatch(token, fn, params),
    /* 匿名版：只有 order_health 这类自带 accessKey 门的函数可用 */
    rpcAnon: (fn, params) => dispatch('', fn, params)
  };
}

module.exports = { createLocalCloud, failOrder };
