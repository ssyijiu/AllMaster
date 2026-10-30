'use strict';
/**
 * 生成单（P3）
 * ---------------------------------------------------------------
 * 为什么需要：P2 之前「扣费」与「拿到图」是两次独立动作，中间任何一环断掉，
 * 用户就是「已扣积分、没有结果」，而服务端无从知道这一单该退还是不该退。
 * 现在一次生成 = 一单：
 *
 *   建单(order_create) → 用单号当钱包扣费 ref(wallet_consume) → 成功(order_succeed)
 *                                                          └→ 失败(order_fail，同事务退款)
 *
 * 三个关键设计：
 * 1. 单号即扣费 ref —— 即使「扣费成功但响应丢了」，也能凭单号在流水里找到这笔
 *    consume，退款不依赖任何内存状态。
 * 2. 退款在云端函数里与状态变更同事务完成，且幂等（同一单号只退一次），所以
 *    服务端重复调用、重启、双机并发都不会多退。
 * 3. 建单失败不阻断生成 —— 降级为「只按 txn id 退款」的老路径（少一层崩溃恢复，
 *    但用户不会因为一次数据库抖动而无法生成）。
 *
 * 本模块不碰 HTTP，也不含密钥；所有云端调用通过注入的 rpc 完成，便于测试。
 */

const crypto = require('crypto');

/* 与云端 order_reap() 默认窗口一致：超过这个时长还在 pending 的单算「被遗弃」，
 * 下次用户登录时（/api/orders/settle）自动退款。取值要大于最长生成耗时
 * （头像上游 300s、拼豆任务 8min），30 分钟留足余量。 */
const REAP_MINUTES = 30;

const PRODUCT_PREFIX = { avatar: 'av', pixelart: 'px' };

function newOrderId(product) {
  const head = PRODUCT_PREFIX[product] || 'od';
  return head + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function rpcMessage(r) {
  if (!r) { return ''; }
  const d = r.data;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    return String(d.message || (d.error && d.error.message) || d.hint || '');
  }
  return String(r.text || '');
}

/* RPC 返回可能是行数组（TABLE 函数）或标量（integer 函数） */
function firstRow(r) {
  const d = r && r.data;
  if (!d) { return null; }
  if (Array.isArray(d)) { return d[0] || null; }
  return d;
}

function mapChargeError(r) {
  const msg = rpcMessage(r);
  if ((r && (r.status === 401 || r.status === 403)) || /AUTH_REQUIRED/.test(msg)) {
    return { status: 401, code: 'AUTH_REQUIRED', message: '登录状态已失效，请重新登录后再生成' };
  }
  if (/INSUFFICIENT_BALANCE/.test(msg)) {
    return { status: 402, code: 'INSUFFICIENT_BALANCE', message: '积分不足：免费体验已用完，请充值或输入兑换码。' };
  }
  return { status: 502, code: 'WALLET_UNAVAILABLE', message: '计费服务暂不可用，请稍后重试' };
}

function createOrderService(deps) {
  const rpc = deps.rpc;
  const log = deps.log || function () {};

  /* 关单 + 退款。永不抛错：结算失败最多让这一单停在 pending，
   * 下次用户登录的 order_reap 会补上（单号就是扣费 ref，信息不丢）。 */
  async function fail(orderId, token, reason, txnId, tracked) {
    const out = { status: '', refunded: false, balance: null };
    if (!orderId) { return out; }
    if (tracked !== false) {
      try {
        const r = await rpc(token, 'order_fail', {
          p_id: orderId,
          p_reason: String(reason || '').slice(0, 300)
        });
        const row = firstRow(r);
        if (r && r.status === 200 && row && row.status) {
          out.status = String(row.status);
          out.refunded = !!row.refunded;
          out.balance = typeof row.balance === 'number' ? row.balance : null;
          if (out.status !== 'missing') { return out; }
          log('order_fail 未找到单据（' + orderId + '），回退 txn 退款');
        } else {
          log('order_fail 失败：' + (r ? r.status + ' ' + rpcMessage(r) : 'no response'));
        }
      } catch (e) {
        log('order_fail 异常：' + ((e && e.message) || e));
      }
    }
    /* 兜底：建单失败 / 单据丢失 / 接口异常时，用扣费流水号直接退（云端幂等） */
    if (txnId) {
      try {
        const r2 = await rpc(token, 'wallet_refund', { p_ref: String(txnId) });
        if (r2 && r2.status === 200) {
          out.refunded = true;
          out.status = 'refunded';
          out.balance = typeof r2.data === 'number' ? r2.data : out.balance;
        } else if (/ALREADY_REFUNDED/.test(rpcMessage(r2))) {
          out.refunded = true;
          out.status = 'refunded';
        } else {
          log('wallet_refund 失败：' + (r2 ? r2.status + ' ' + rpcMessage(r2) : 'no response'));
        }
      } catch (e) {
        log('wallet_refund 异常：' + ((e && e.message) || e));
      }
    }
    return out;
  }

  return {
    REAP_MINUTES: REAP_MINUTES,
    newOrderId: newOrderId,
    mapChargeError: mapChargeError,

    /**
     * 建单 + 扣费。
     * @returns {Promise<{orderId:string, tracked:boolean, txnId:string, balance:number}|{error:{status,code,message}}>}
     */
    async create(opts) {
      const o = opts || {};
      const token = o.token;
      const product = o.product || 'avatar';
      const credits = o.credits == null ? 1 : o.credits;
      const orderId = newOrderId(product);

      /* 1) 建单。失败只降级，不阻断（见文件头第 3 条）。 */
      let tracked = false;
      try {
        const r = await rpc(token, 'order_create', {
          p_id: orderId,
          p_product: product,
          p_credits: credits,
          p_meta: o.meta || {}
        });
        const row = firstRow(r);
        tracked = !!(r && r.status === 200 && row && row.status === 'pending');
        if (!tracked) {
          log('order_create 未建单：' + (r ? r.status + ' ' + rpcMessage(r) : 'no response'));
        }
      } catch (e) {
        log('order_create 异常：' + ((e && e.message) || e));
      }

      /* 2) 扣费，单号即 ref（这是能凭单号追溯/退款的关键） */
      let cr;
      try {
        cr = await rpc(token, 'wallet_consume', { p_credits: -Math.abs(credits), p_ref: orderId });
      } catch (e) {
        log('wallet_consume 异常：' + ((e && e.message) || e));
        await fail(orderId, token, 'wallet_unreachable', null, tracked);
        return { error: { status: 502, code: 'WALLET_UNAVAILABLE', message: '计费服务连接失败，请稍后重试' } };
      }

      const row = firstRow(cr);
      if (!cr || cr.status !== 200 || !row || row.txn_id == null) {
        const err = mapChargeError(cr);
        /* 没扣到钱：把单据关掉，避免它躺在 pending 里被 order_reap 误判 */
        await fail(orderId, token, 'charge_failed:' + err.code, null, tracked);
        return { error: err };
      }

      return {
        orderId: orderId,
        tracked: tracked,
        txnId: String(row.txn_id),
        balance: typeof row.balance === 'number' ? row.balance : null
      };
    },

    /* 成功结算：pending → succeeded（已退款/已成功的单不会被改写） */
    async succeed(orderId, token, resultRef) {
      if (!orderId) { return null; }
      try {
        const r = await rpc(token, 'order_succeed', {
          p_id: orderId,
          p_result_ref: resultRef == null ? '' : String(resultRef)
        });
        return firstRow(r);
      } catch (e) {
        log('order_succeed 异常：' + ((e && e.message) || e));
        return null;
      }
    },

    fail: fail,

    /* 登录后的补退：把本人在各产品上被遗弃的 pending 单结掉 */
    async reap(token, minutes) {
      try {
        const r = await rpc(token, 'order_reap', { p_minutes: minutes || REAP_MINUTES });
        const row = firstRow(r);
        if (!r || r.status !== 200 || !row) {
          return { refunded: 0, balance: null, error: rpcMessage(r) || '' };
        }
        return {
          refunded: Number(row.refunded) || 0,
          balance: typeof row.balance === 'number' ? row.balance : null
        };
      } catch (e) {
        return { refunded: 0, balance: null, error: (e && e.message) || String(e) };
      }
    },

    async get(orderId, token) {
      if (!orderId) { return null; }
      try {
        const r = await rpc(token, 'order_get', { p_id: String(orderId) });
        return firstRow(r);
      } catch (e) {
        return null;
      }
    }
  };
}

module.exports = { createOrderService: createOrderService, newOrderId: newOrderId, REAP_MINUTES: REAP_MINUTES };
