'use strict';
/* ---------- 生图通道：运行时状态 + 自动切换判定 ----------
 *
 * 背景（2026-11-04）：腾讯 VP 的匿名池额度耗尽，19 单里 8 单直接报
 * `error_code=service_quota_exhausted`，而另外 10 单是我们自己的 400（用户侧问题）。
 * 结论：按「失败率」切会误切，只能按「上游自己吐出来的错误码」切。
 *
 * 判定规则（宁可漏切，不可误切）：
 *   1) 只认白名单错误码 service_quota_exhausted —— 这是上游明确的「额度没了」；
 *      user_busy（同一身份上一张还没好）、400（图片/参数）、超时、5xx 一律不算。
 *   2) 同一通道**连续 2 个任务**都命中该码，且这期间**没有任何一单成功**。
 *      窗口 30 分钟：低频时段不至于把两次相隔一小时的事件连起来。
 *   3) 池标签是 anon（全站共享匿名池）时，一次命中就足以证明池空，但仍要 2 连防抖；
 *      若哪天上游改成用户级额度（pool 不是 anon），则追加要求「≥2 个不同用户」。
 *
 * 状态只存 meta 表一行 JSON：切换是低频操作，不需要单独建表；
 * 事件流另存 upstream_errors，供后台看「为什么切」以及事后复盘。
 */
const dbmod = require('./db');

const META_KEY = 'pixelart_channel';
const EVENTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_TABLE = 'upstream_errors';

/* 判定参数（改动前先想清楚：放宽 = 更容易误切，收紧 = 故障时切得更慢） */
const WINDOW_MS = 30 * 60 * 1000;
const NEED_HITS = 2;
const QUOTA_CODES = ['service_quota_exhausted'];

const BASE = { vp: '/api/pixelart-vp', self: '/api/pixelart' };
const LABEL = { vp: '腾讯（VP）', self: '自研' };

let notifyFn = null;

/* 上游错误文案 → 结构化字段。上游原文形如：
 *   提交：HTTP 429，error_code=service_quota_exhausted，{"quota_pool": "anon", ...}
 * scrubVendor 只替换供应商称谓，error_code / quota_pool 原样保留。 */
function parseUpstreamError(message) {
  const s = String(message || '');
  const code = /error_code["']?\s*[:=]\s*["']?([a-zA-Z0-9_]+)/.exec(s);
  const pool = /"quota_pool"\s*:\s*"([a-zA-Z0-9_]+)"/.exec(s);
  const http = /HTTP\s+(\d{3})/.exec(s);
  return {
    errorCode: code ? code[1] : '',
    quotaPool: pool ? pool[1] : '',
    httpStatus: http ? Number(http[1]) : 0
  };
}

function defaultState() {
  return { active: 'vp', since: 0, reason: '', evidence: null, by: '' };
}

function getState() {
  let raw = '';
  try { raw = dbmod.metaGet(META_KEY, '') || ''; } catch (_) { return defaultState(); }
  if (!raw) { return defaultState(); }
  try {
    const o = JSON.parse(raw);
    const active = o && o.active === 'self' ? 'self' : 'vp';
    return {
      active: active,
      since: Number(o.since) || 0,
      reason: String(o.reason || ''),
      evidence: o.evidence || null,
      by: String(o.by || '')
    };
  } catch (_) { return defaultState(); }
}

function pageBase() {
  return BASE[getState().active] || BASE.vp;
}

/* 手动/自动切换的唯一入口。返回 { changed, state }：changed=false 时不重复发通知。 */
function setActive(target, opts) {
  const o = opts || {};
  if (target !== 'vp' && target !== 'self') { throw new Error('BAD_CHANNEL'); }
  const prev = getState();
  const next = {
    active: target,
    since: Date.now(),
    reason: String(o.reason || '').slice(0, 500),
    evidence: o.evidence || null,
    by: String(o.by || 'system')
  };
  dbmod.metaSet(META_KEY, JSON.stringify(next));
  const changed = prev.active !== target;
  if (changed) {
    console.warn('[channel] 生图通道切到 ' + LABEL[target] + '（' + next.by + '）：' + next.reason);
    if (notifyFn) {
      try { notifyFn({ from: prev.active, to: target, state: next }); } catch (_) { /* 通知失败不影响切换 */ }
    }
  }
  return { changed: changed, state: next };
}

function setNotify(fn) { notifyFn = typeof fn === 'function' ? fn : null; }

/* 记一条事件。成功与失败都记：判定要判断「最近两个任务是否都失败」，
 * 成功事件是清零信号，不能只记失败。返回判定结果（切换时带 state）。 */
function record(ev) {
  const e = ev || {};
  const channel = e.backend === 'valperler' ? 'vp' : 'self';
  const ts = Date.now();
  const ok = e.ok ? 1 : 0;
  try {
    const d = dbmod.db;
    d.prepare(
      'INSERT INTO ' + EVENT_TABLE +
      ' (ts, channel, backend, ok, error_code, quota_pool, http_status, user_id, order_id, message) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(
      ts, channel, String(e.backend || ''), ok,
      e.errorCode ? String(e.errorCode).slice(0, 80) : null,
      e.quotaPool ? String(e.quotaPool).slice(0, 40) : null,
      e.httpStatus ? Number(e.httpStatus) : 0,
      e.userId ? String(e.userId) : null,
      e.orderId ? String(e.orderId) : null,
      e.message ? String(e.message).slice(0, 500) : null
    );
    prune(d, ts);
  } catch (err) {
    console.warn('[channel] 事件落库失败：' + ((err && err.message) || err));
  }
  if (ok) { return null; }        /* 成功只入表，不触发判定 */
  if (channel !== 'vp') { return null; }   /* 自研通道没有备用通道可切，只记录 */
  return evaluate(ts);
}

let writeCount = 0;
function prune(d, ts) {
  writeCount += 1;
  if (writeCount % 200 !== 0) { return; }   /* 事件表很小，定期清即可 */
  try { d.prepare('DELETE FROM ' + EVENT_TABLE + ' WHERE ts < ?').run(ts - EVENTS_TTL_MS); } catch (_) {}
}

/* 判定：最近 NEED_HITS 个任务是否全部命中同一个额度错误码，且期间零成功。 */
function evaluate(ts) {
  const st = getState();
  if (st.active !== 'vp') { return null; }   /* 已经切过或在自研通道上，不再重复判定 */
  let rows = [];
  try {
    /* ts 只到毫秒：同一毫秒内的连续事件（用户连点重试、测试里同步造数据）会并列，
       必须用 id 做 tie-breaker，否则「最近两个任务」可能取到错的两条。 */
    rows = dbmod.db.prepare(
      'SELECT ts, ok, error_code, quota_pool, user_id, order_id FROM ' + EVENT_TABLE +
      ' WHERE channel = ? AND ts > ? ORDER BY ts DESC, id DESC LIMIT ?'
    ).all('vp', ts - WINDOW_MS, NEED_HITS);
  } catch (_) { return null; }
  if (rows.length < NEED_HITS) { return null; }
  if (rows.some((r) => Number(r.ok) === 1)) { return null; }  /* 有成功单 = 通道还活着 */
  const codes = rows.map((r) => String(r.error_code || ''));
  if (!codes.every((c) => c === codes[0] && QUOTA_CODES.indexOf(c) !== -1)) { return null; }

  /* 共享匿名池：一个用户的两次失败就足以证明池空，不再要求跨用户；
     用户级额度（pool 不是 anon 或没给）：必须两个不同用户都为同一码才算服务级。 */
  const sharedPool = rows.every((r) => String(r.quota_pool || '') === 'anon');
  if (!sharedPool) {
    const users = new Set(rows.map((r) => String(r.user_id || '')).filter(Boolean));
    if (users.size < 2) { return null; }
  }

  const evidence = {
    windowMin: Math.round(WINDOW_MS / 60000),
    need: NEED_HITS,
    hits: rows.map((r) => ({
      at: r.ts, code: r.error_code, pool: r.quota_pool || '', order: r.order_id || ''
    }))
  };
  const r = setActive('self', {
    reason: '上游返回 ' + codes[0] + (sharedPool ? '（匿名共享池额度耗尽）' : '（多用户同时命中）'),
    evidence: evidence,
    by: 'auto'
  });
  return r.changed ? r.state : null;
}

function listEvents(limit) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 200));
  try {
    return dbmod.db.prepare(
      'SELECT ts, channel, backend, ok, error_code, quota_pool, http_status, user_id, order_id, message FROM ' +
      EVENT_TABLE + ' ORDER BY ts DESC, id DESC LIMIT ?'
    ).all(n);
  } catch (_) { return []; }
}

/* 后台/CLI 用的一份摘要：当前通道 + 最近事件 + 判定参数（口径只有这一处） */
function summary(limit) {
  const st = getState();
  return {
    active: st.active,
    activeLabel: LABEL[st.active] || st.active,
    since: st.since,
    reason: st.reason,
    evidence: st.evidence,
    by: st.by,
    base: BASE[st.active] || BASE.vp,
    rule: {
      codes: QUOTA_CODES,
      windowMin: Math.round(WINDOW_MS / 60000),
      needHits: NEED_HITS,
      sharedPoolOnly: false
    },
    events: listEvents(limit || 20)
  };
}

module.exports = {
  BASE,
  LABEL,
  getState,
  setActive,
  setNotify,
  pageBase,
  record,
  listEvents,
  summary,
  parseUpstreamError
};
