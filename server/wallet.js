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

/* 兑换码输入归一化。
 * 码字符集是 32 个无歧义大写字符（见 admin.js ALPHABET，不含 0/O/1/I）。
 * 用户手抄时最常见的手误：
 *   - 小写 → 大写（toUpperCase）
 *   - 1 / I / i / l / | / ! → L（这些字形几乎一样，且码内本来就没有 I 和 1，不会造成碰撞）
 *   - 0 / O → 码内不存在、表内也没有形状相近的字符，无法可靠映射 → 交给调用方明确报错
 * 分组连字符 / 空格（如 ABCD-EFGH）直接去掉，方便对照着抄。 */
function normalizeRedeemCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/[1I|!]/g, 'L');
}

/* 兑换码：码只能用一次，事务内抢占，避免并发双花；有效期 30 天（生成时可调，0 = 永久） */
function redeem(userId, code) {
  if (!userId) { throw fail('AUTH_REQUIRED', '请先登录后再兑换'); }
  const raw = String(code || '').trim().toUpperCase();
  const c = normalizeRedeemCode(raw);
  if (!c) { throw fail('CODE_INVALID', '请输入兑换码'); }
  if (/[0O]/.test(c)) {
    /* 大写归一化后仍含 0/O：码里没有这两个字符，多半是把别的看混了，明确提示比默默判无效友好 */
    throw fail('CODE_INVALID', '兑换码不含数字 0 和字母 O，请检查是否认混了字形');
  }
  return dbmod.tx((d) => {
    const row = d.prepare('SELECT code, credits, used_by, expires_at, batch, new_user_only, per_user_limit FROM redeem_codes WHERE code = ?').get(c);
    if (!row) { throw fail('CODE_INVALID', '兑换码无效'); }
    if (row.used_by) {
      /* 同一个人再次兑换自己已用掉的码：不报错、也不重复入账。
         典型场景是兑换链接被重复点开（收藏/群聊里点两次），
         报「已被使用」会让人以为没到账，按 alreadyOwned 返回更贴合直觉。
         注意这一步排在批次规则之前：已经领到手的码不该再被规则拦一次。 */
      if (row.used_by === userId) {
        return { balance: balance(userId), credits: 0, code: c, alreadyOwned: true };
      }
      throw fail('CODE_INVALID', '兑换码已被使用');
    }
    if (row.expires_at && row.expires_at < dbmod.nowMs()) { throw fail('CODE_EXPIRED', '兑换码已过期'); }

    /* ---- 批次规则（v3）：解决「一批码发到群里被一个人领完」----
       规则跟着码走（生成时整批写入同一份规则），所以这里按当前码自己的配置判断。 */
    const batch = row.batch ? String(row.batch) : '';
    const perUserLimit = Number(row.per_user_limit);
    if (batch && perUserLimit > 0) {
      /* 同批次内该用户已领张数。按 used_by 计数而不是按流水：一个人领两张就是两行码。 */
      const got = d.prepare('SELECT COUNT(*) AS n FROM redeem_codes WHERE batch = ? AND used_by = ?').get(batch, userId);
      if ((got && Number(got.n)) >= perUserLimit) {
        throw fail('CODE_BATCH_LIMIT',
          perUserLimit === 1
            ? '这批兑换码每人限领 1 张，你已经领过了'
            : '这批兑换码每人限领 ' + perUserLimit + ' 张，你已经领满了');
      }
    }
    if (Number(row.new_user_only) === 1) {
      /* 「新用户」= 此前没有任何积分流水（没转过图 / 没充过值 / 没领过码）。
         用流水判断而不是注册时间：注册了半年但一次没用过的账号本质仍是新用户，
         而转过很多张图的老客，注册时间再"新"也不该算。

         关键细节：同批次里自己领过的码**不算**「有流水」。
         否则「仅新用户 + 每人 2 张」永远只能领 1 张——领完第一张他就不再是新用户了，
         配置本身就自相矛盾。排除掉本批次的兑换记录，这个组合才有意义。 */
      const seen = batch
        ? d.prepare(
          'SELECT 1 AS x FROM wallet_txns WHERE user_id = ? ' +
          'AND NOT (kind = ? AND ref IN (SELECT code FROM redeem_codes WHERE batch = ?)) LIMIT 1'
        ).get(userId, 'redeem', batch)
        : d.prepare('SELECT 1 AS x FROM wallet_txns WHERE user_id = ? LIMIT 1').get(userId);
      if (seen) {
        throw fail('CODE_NEW_USER_ONLY', '这批兑换码是给新用户的见面礼，你的账号已有积分记录～可以直接用现有积分去转图');
      }
    }

    d.prepare('UPDATE redeem_codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .run(userId, dbmod.nowMs(), c);
    const again = d.prepare('SELECT used_by FROM redeem_codes WHERE code = ?').get(c);
    if (!again || again.used_by !== userId) { throw fail('CODE_INVALID', '兑换码已被使用'); }
    const credits = Number(row.credits) || 0;
    insert(d, { userId: userId, credits: credits, kind: 'redeem', ref: c, memo: '兑换码充值' });
    /* 返回对象（旧版本只回余额数字）：调用方据此提示「已到账 N 积分」，
       不必靠前后余额相减去猜——前端余额可能还没拉回来，也可能是并发变动。 */
    return { balance: balance(userId), credits: credits, code: c, alreadyOwned: false };
  });
}

/* 邀请链接领码：一次调用 = 「从这批名额里取一张码 + 记到自己名下 + 入账」。
 * 与 redeem 的区别：码不是用户填的，是服务端从池子里分配的。
 *
 * 为什么不做「先发码，前端再调 wallet_redeem」两步：中间态（已判给某人但没入账）
 * 一断网就永久占住一张码，还得写回收；单事务分配没有这个洞——两个人同时点开，
 * BEGIN IMMEDIATE 串行化，第二个人拿到的是下一张。
 *
 * 规则与 redeem 完全同口径（同一张表、同一套判定），避免两条入口说法不一。 */
function redeemBatch(userId, batch) {
  if (!userId) { throw fail('AUTH_REQUIRED', '请先登录后再领取'); }
  const b = String(batch || '').trim().toUpperCase();
  if (!b) { throw fail('BATCH_INVALID', '邀请链接无效'); }
  return dbmod.tx((d) => {
    const bt = d.prepare(
      'SELECT batch, label, landing, credits, new_user_only, per_user_limit, expires_at, active FROM redeem_batches WHERE batch = ?'
    ).get(b);
    if (!bt) { throw fail('BATCH_INVALID', '邀请链接无效'); }
    if (!Number(bt.active)) { throw fail('BATCH_CLOSED', '这个邀请链接已经停止发放了'); }
    const now = dbmod.nowMs();
    if (bt.expires_at && Number(bt.expires_at) < now) { throw fail('BATCH_EXPIRED', '邀请链接已过期'); }

    const perUserLimit = Number(bt.per_user_limit) || 0;
    const mine = d.prepare(
      'SELECT code FROM redeem_codes WHERE batch = ? AND used_by = ? ORDER BY used_at ASC, code ASC'
    ).all(b, userId);
    if (perUserLimit > 0 && mine.length >= perUserLimit) {
      /* 重复点开同一条链接：不报错。用户看到「已领过」比看到「失败」安心，
         也不会以为没到账去翻客服记录。 */
      return {
        balance: balance(userId), credits: 0, batch: b,
        code: mine.length ? String(mine[0].code) : '', alreadyOwned: true
      };
    }

    /* 新用户口径与 redeem 一致：此前没有任何积分流水，但排除本批次自己领过的记录。
       放在选码之前——被拒的人不该占掉一张码。 */
    if (Number(bt.new_user_only) === 1) {
      const seen = d.prepare(
        'SELECT 1 AS x FROM wallet_txns WHERE user_id = ? ' +
        'AND NOT (kind = ? AND ref IN (SELECT code FROM redeem_codes WHERE batch = ?)) LIMIT 1'
      ).get(userId, 'redeem', b);
      if (seen) {
        throw fail('CODE_NEW_USER_ONLY', '这批兑换码是给新用户的见面礼，你的账号已有积分记录～可以直接用现有积分去转图');
      }
    }

    /* 挑一张「没被领、也没过期」的码。码是随机的，ORDER BY code 等价于随机取，
       但比 random() 确定，出问题时能复现。 */
    const pick = d.prepare(
      'SELECT code, credits FROM redeem_codes WHERE batch = ? AND used_by IS NULL ' +
      'AND (expires_at IS NULL OR expires_at >= ?) ORDER BY code LIMIT 1'
    ).get(b, now);
    if (!pick) {
      const left = d.prepare('SELECT COUNT(*) AS n FROM redeem_codes WHERE batch = ? AND used_by IS NULL').get(b);
      if (!left || !Number(left.n)) { throw fail('BATCH_EXHAUSTED', '这个邀请链接的名额已经领完了'); }
      /* 还有没领的码但都过期了：按链接过期回，提示才准确 */
      throw fail('BATCH_EXPIRED', '邀请链接已过期');
    }

    const claimed = d.prepare('UPDATE redeem_codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .run(userId, now, pick.code);
    if (!claimed || Number(claimed.changes) !== 1) {
      throw fail('BATCH_EXHAUSTED', '这个邀请链接的名额刚被领完，请稍后再试');
    }

    const credits = Number(pick.credits) || 0;
    insert(d, { userId: userId, credits: credits, kind: 'redeem', ref: String(pick.code), memo: '邀请链接领取' });
    return { balance: balance(userId), credits: credits, code: String(pick.code), batch: b, alreadyOwned: false };
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
  redeemBatch,
  payCredit,
  grant,
  listTxns,
  fail
};
