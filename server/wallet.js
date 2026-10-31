'use strict';
/**
 * 积分账本（本地）
 * ---------------------------------------------------------------
 * 与云端 RPC 语义保持一致，迁移时上层（orders.js / 前端）不用改：
 *   wallet_balance   余额 = SUM(credits)，不存冗余字段
 *   wallet_consume   扣费，ref 幂等（同一 ref 重复调用只扣一次）
 *   wallet_refund    退款，ref 幂等（同一 ref 只退一次）
 *   wallet_redeem    兑换码入账，码只能用一次
 *   wallet_pay_claim 支付到账，支付单号幂等（回调重放不会重复入账）
 *
 * 免费额度：允许透支到 -2（= 2 次免费体验），与云端 floor 一致；
 * 再往下扣必须抛 INSUFFICIENT_BALANCE。
 */

const dbmod = require('./db');

const FREE_FLOOR = -2;

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function balance(userId) {
  if (!userId) { throw fail('AUTH_REQUIRED', '未登录'); }
  const row = dbmod.db.prepare('SELECT COALESCE(SUM(credits), 0) AS b FROM wallet_txns WHERE user_id = ?').get(userId);
  return Number(row && row.b) || 0;
}

function nextTxnId() {
  return 'tx_' + Date.now().toString(36) + require('crypto').randomBytes(4).toString('hex');
}

function insert(d, row) {
  const txnId = nextTxnId();
  d.prepare(
    'INSERT INTO wallet_txns (txn_id, user_id, credits, kind, ref, memo, product, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(txnId, row.userId, row.credits, row.kind, row.ref || null, row.memo || null, row.product || null, dbmod.nowMs());
  return txnId;
}

function findTxn(d, kind, ref) {
  if (!ref) { return null; }
  return d.prepare('SELECT txn_id, credits, user_id FROM wallet_txns WHERE kind = ? AND ref = ?').get(kind, ref) || null;
}

/* 扣费。credits 取正数（内部转负）。幂等：同 ref 已扣过则原样返回。 */
function consume(userId, credits, ref, opts) {
  const amount = Math.abs(Number(credits) || 0);
  if (!amount) { throw fail('BAD_AMOUNT', '扣费金额必须大于 0'); }
  if (!userId) { throw fail('AUTH_REQUIRED', '未登录'); }
  return dbmod.tx((d) => {
    const dup = findTxn(d, 'consume', ref);
    if (dup) {
      /* 幂等返回：重复建单/重试不应二次扣费 */
      return { txnId: dup.txn_id, balance: balance(userId), duplicated: true };
    }
    const cur = balance(userId);
    if (cur - amount < FREE_FLOOR) { throw fail('INSUFFICIENT_BALANCE', '积分不足'); }
    const txnId = insert(d, {
      userId: userId,
      credits: -amount,
      kind: 'consume',
      ref: ref || null,
      memo: (opts && opts.memo) || '',
      product: (opts && opts.product) || ''
    });
    return { txnId: txnId, balance: balance(userId) };
  });
}

/* 退款核心：**必须在调用方已开启的事务里执行**。
 * orders.js 的 order_fail 要求「关单 + 退款」同事务，若这里再开一个事务，
 * SQLite 会直接报 cannot start a transaction within a transaction。 */
function refundCore(d, userId, ref) {
  if (!ref) { throw fail('BAD_REF', '缺少退款单号'); }
  const dup = d.prepare('SELECT txn_id FROM wallet_txns WHERE kind = ? AND ref = ?').get('refund', String(ref));
  if (dup) { throw fail('ALREADY_REFUNDED', '该笔已退款'); }
  let spent = d.prepare('SELECT user_id, credits FROM wallet_txns WHERE kind = ? AND ref = ?').get('consume', String(ref));
  if (!spent) {
    /* 兼容：前端历史上把 txn_id 当 ref 传 */
    spent = d.prepare('SELECT user_id, credits FROM wallet_txns WHERE txn_id = ? AND kind = ?').get(String(ref), 'consume');
  }
  if (!spent) { throw fail('NOT_FOUND', '找不到对应的扣费记录'); }
  if (userId && spent.user_id !== userId) { throw fail('FORBIDDEN', '不是本人的扣费记录'); }
  insert(d, {
    userId: spent.user_id,
    credits: Math.abs(spent.credits),
    kind: 'refund',
    ref: String(ref),
    memo: '生成失败退回'
  });
  return balance(spent.user_id);
}

/* 退款：ref 是当初 consume 的 ref（订单号 / txn_id）。独立事务版本的入口。 */
function refund(userId, ref) {
  return dbmod.tx((d) => refundCore(d, userId, ref));
}

/* 兑换码：码只能用一次，事务内抢占，避免并发双花 */
function redeem(userId, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) { throw fail('CODE_INVALID', '兑换码无效'); }
  return dbmod.tx((d) => {
    const row = d.prepare('SELECT code, credits, used_by FROM redeem_codes WHERE code = ?').get(c);
    if (!row) { throw fail('CODE_INVALID', '兑换码无效'); }
    if (row.used_by) { throw fail('CODE_INVALID', '兑换码已被使用'); }
    d.prepare('UPDATE redeem_codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .run(userId, dbmod.nowMs(), c);
    const again = d.prepare('SELECT used_by FROM redeem_codes WHERE code = ?').get(c);
    if (!again || again.used_by !== userId) { throw fail('CODE_INVALID', '兑换码已被使用'); }
    insert(d, { userId: userId, credits: Number(row.credits) || 0, kind: 'redeem', ref: c, memo: '兑换码充值' });
    return balance(userId);
  });
}

/* 支付入账：ref = 支付单号，重放幂等（返回 duplicated 供回调判断） */
function payCredit(userId, credits, ref, memo) {
  const amount = Number(credits) || 0;
  if (!userId) { throw fail('AUTH_REQUIRED', '未登录'); }
  if (amount <= 0) { throw fail('BAD_AMOUNT', '入账金额必须大于 0'); }
  if (!ref) { throw fail('BAD_REF', '缺少支付单号'); }
  return dbmod.tx((d) => {
    const dup = findTxn(d, 'pay', String(ref));
    if (dup) { return { balance: balance(dup.user_id), duplicated: true, userId: dup.user_id }; }
    insert(d, { userId: userId, credits: amount, kind: 'pay', ref: String(ref), memo: memo || '在线支付' });
    return { balance: balance(userId), duplicated: false, userId: userId };
  });
}

/* 管理发放（活动赠送 / 人工补偿） */
function grant(userId, credits, ref, memo) {
  const amount = Number(credits) || 0;
  if (!userId) { throw fail('AUTH_REQUIRED', '未登录'); }
  if (!amount) { throw fail('BAD_AMOUNT', '金额不能为 0'); }
  return dbmod.tx((d) => {
    if (ref) {
      const dup = d.prepare('SELECT txn_id FROM wallet_txns WHERE kind = ? AND ref = ?').get('grant', String(ref));
      if (dup) { return { balance: balance(userId), duplicated: true }; }
    }
    insert(d, { userId: userId, credits: amount, kind: 'grant', ref: ref ? String(ref) : null, memo: memo || '' });
    return { balance: balance(userId), duplicated: false };
  });
}

function listTxns(userId, limit) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return dbmod.db.prepare(
    'SELECT txn_id, credits, kind, ref, memo, product, created_at FROM wallet_txns WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, n).map((r) => ({
    txn_id: r.txn_id,
    credits: r.credits,
    kind: r.kind,
    ref: r.ref,
    memo: r.memo,
    product: r.product,
    /* 前端按 created_at 排序，给 ISO 字符串（与云端 timestamptz 同形） */
    created_at: new Date(Number(r.created_at)).toISOString()
  }));
}

module.exports = {
  FREE_FLOOR,
  balance,
  consume,
  refund,
  refundCore,
  redeem,
  payCredit,
  grant,
  listTxns,
  fail
};
