'use strict';
/**
 * 数据看板（管理员）—— 三个核心观测指标
 * ---------------------------------------------------------------
 * ① 打开页面 → 首次出图 转化率：反映登录、上传环节的摩擦力
 * ② 人均生成张数：反映图纸质量（好就会多转几张试试）
 * ③ 7 日内二次回访率：决定这是「一次性玩具」还是「工具」
 *
 * 口径统一按**东八区自然日**切（与后台其它报表一致），不是 UTC。
 *
 * 数据来源分两类，页面上会标清楚：
 *   - 生成：orders 表（历史可回溯到上线第一天）
 *   - 访问/注册：events 表（2026-11-03 起埋点）+ users 表
 * 所以埋点上线前的日期，「打开页面」的分母不存在，转化率会标记 untracked，
 * 绝不拿注册数冒充访客数 —— 那样率会虚高，看板就失去意义了。
 *
 * 定义（避免以后各说各话）：
 *   访客        = 浏览器 localStorage 里的匿名 visitor_id
 *   新访客      = 首次出现落在窗口内的访客
 *   首次出图    = 该用户第一条 status='succeeded' 的订单
 *   转化率      = 窗口内新访客中，在首访后 7 日内产生首个成功出图的占比
 *   人均生成张数 = 窗口内成功生成总数 ÷ 窗口内有成功生成的用户数
 *   7 日回访    = 首次活跃日落在窗口内的用户，在第 2~7 天再次活跃（访问或生成）的占比
 */

const dbmod = require('./db');

const DAY_MS = 86400000;
const TZ = 8 * 3600 * 1000;

/* 本地日 <-> UTC 毫秒：只用日期字符串做算术，避免夏令时/时区漂移 */
function dayOf(ms) {
  return new Date(Number(ms) + TZ).toISOString().slice(0, 10);
}
function dayToUtc(day) {
  const p = String(day).split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
}
function addDays(day, n) {
  return new Date(dayToUtc(day) + n * DAY_MS).toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((dayToUtc(b) - dayToUtc(a)) / DAY_MS);
}
function today() {
  return dayOf(Date.now());
}

/* orders / users 的本地日表达式（SQLite 只认 UTC，加 8 小时再取日期） */
function dayExpr(col) {
  return "strftime('%Y-%m-%d', " + col + "/1000, 'unixepoch', '+8 hours')";
}

function pct(a, b) {
  if (!b) { return null; }
  return Math.round((a / b) * 1000) / 10;   /* 一位小数，前端再补 % */
}

function rangeOf(days) {
  const n = Math.max(1, Math.min(365, Number(days) || 30));
  const to = today();
  return { from: addDays(to, -(n - 1)), to: to, days: n };
}

/* ---------------- 基础取数 ---------------- */

function allRows(sql, params) {
  return dbmod.db.prepare(sql).all.apply(dbmod.db.prepare(sql), params);
}
function one(sql, params) {
  return dbmod.db.prepare(sql).get.apply(dbmod.db.prepare(sql), params);
}

function genRows(from, to, product) {
  const sql = 'SELECT user_id AS uid, ' + dayExpr('created_at') + ' AS day, product, status, created_at ' +
    "FROM orders WHERE status = 'succeeded' AND " + dayExpr('created_at') + ' >= ? AND ' + dayExpr('created_at') + ' <= ?' +
    (product ? ' AND product = ?' : '');
  const params = product ? [from, to, product] : [from, to];
  return allRows(sql, params);
}

function firstGenByUser(product) {
  const sql = "SELECT user_id AS uid, MIN(created_at) AS ms FROM orders WHERE status = 'succeeded'" +
    (product ? ' AND product = ?' : '') + ' GROUP BY user_id';
  const rows = product ? allRows(sql, [product]) : allRows(sql, []);
  const m = new Map();
  rows.forEach(function (r) { m.set(r.uid, dayOf(r.ms)); });
  return m;
}

/* 访客 → 账号：取该访客最近一次带 user_id 的记录（同一浏览器换账号以最新为准） */
function visitorUsers() {
  const rows = allRows(
    "SELECT visitor_id AS vid, user_id AS uid, MAX(ts) AS ms FROM events " +
    'WHERE user_id IS NOT NULL AND visitor_id IS NOT NULL GROUP BY visitor_id', []);
  const m = new Map();
  rows.forEach(function (r) { m.set(r.vid, r.uid); });
  return m;
}

function firstPvByVisitor(product) {
  const sql = "SELECT visitor_id AS vid, MIN(day) AS day FROM events WHERE kind = 'pv' AND visitor_id IS NOT NULL" +
    (product ? ' AND (product = ? OR product IS NULL)' : '') + ' GROUP BY visitor_id';
  const rows = product ? allRows(sql, [product]) : allRows(sql, []);
  const m = new Map();
  rows.forEach(function (r) { m.set(r.vid, r.day); });
  return m;
}

/* ---------------- 指标 ① 打开页面 → 首次出图 ---------------- */

function funnelMeta(range, product) {
  const visitors = firstPvByVisitor(product);
  const vmap = visitorUsers();
  const firstGen = firstGenByUser(product);

  let newVisitors = 0;      /* 首访落在窗口内的访客 */
  let converted = 0;        /* 其中首访后 7 日内首次出图的 */
  const newVisitorVids = [];
  visitors.forEach(function (day, vid) {
    if (day >= range.from && day <= range.to) {
      newVisitors += 1;
      newVisitorVids.push(vid);
    }
  });
  newVisitorVids.forEach(function (vid) {
    const uid = vmap.get(vid);
    const g = uid ? firstGen.get(uid) : null;
    if (!g) { return; }
    const firstVisit = visitors.get(vid);
    if (g >= firstVisit && diffDays(firstVisit, g) <= 7) { converted += 1; }
  });

  const signups = one(
    'SELECT COUNT(*) AS n FROM (SELECT ' + dayExpr('created_at') + ' AS day FROM users) WHERE day >= ? AND day <= ?',
    [range.from, range.to]
  ).n;

  /* 窗口内首次出图的用户数（账号口径，历史可回溯） */
  let firstGenUsers = 0;
  firstGen.forEach(function (day) {
    if (day >= range.from && day <= range.to) { firstGenUsers += 1; }
  });

  const tracked = one("SELECT MIN(day) AS d, COUNT(*) AS n FROM events", []);

  /* 有访问数据 → 访客口径；没有 → 退回「注册 → 首图」，并明确标注 */
  if (newVisitors > 0) {
    return {
      basis: 'visitor',
      label: '新访客 → 首次出图',
      visitors: newVisitors,
      signups: signups,
      firstGen: firstGenUsers,
      converted: converted,
      rate: pct(converted, newVisitors),
      note: '分母是窗口内首次出现的匿名访客；分子是其中首访后 7 日内完成首次出图的访客。'
    };
  }
  return {
    basis: 'signup',
    label: '新注册 → 首次出图',
    visitors: 0,
    signups: signups,
    firstGen: firstGenUsers,
    converted: Math.min(firstGenUsers, signups),
    rate: pct(Math.min(firstGenUsers, signups), signups),
    note: tracked && tracked.n
      ? '本窗口没有访问数据（埋点覆盖不到），暂按「新注册 → 首次出图」计算。'
      : '访问埋点刚刚上线，还没有数据；暂按「新注册 → 首次出图」计算。'
  };
}

/* ---------------- 指标 ② 人均生成张数 ---------------- */

function perUserMeta(range, product) {
  const gens = genRows(range.from, range.to, product);
  const byUser = new Map();
  gens.forEach(function (r) { byUser.set(r.uid, (byUser.get(r.uid) || 0) + 1); });

  const dist = [
    { key: '1', label: '1 张', users: 0 },
    { key: '2-3', label: '2–3 张', users: 0 },
    { key: '4-9', label: '4–9 张', users: 0 },
    { key: '10+', label: '10 张以上', users: 0 }
  ];
  byUser.forEach(function (n) {
    if (n >= 10) { dist[3].users += 1; }
    else if (n >= 4) { dist[2].users += 1; }
    else if (n >= 2) { dist[1].users += 1; }
    else { dist[0].users += 1; }
  });

  const total = gens.length;
  const users = byUser.size;
  const signups = one(
    'SELECT COUNT(*) AS n FROM (SELECT ' + dayExpr('created_at') + ' AS day FROM users) WHERE day >= ? AND day <= ?',
    [range.from, range.to]
  ).n;

  let byProduct = [];
  if (!product) {
    const m = new Map();
    gens.forEach(function (r) {
      const k = r.product || 'unknown';
      const o = m.get(k) || { product: k, gens: 0, users: new Set() };
      o.gens += 1; o.users.add(r.uid);
      m.set(k, o);
    });
    byProduct = Array.from(m.values())
      .map(function (o) { return { product: o.product, gens: o.gens, users: o.users.size }; })
      .sort(function (a, b) { return b.gens - a.gens; });
  }

  return {
    total: total,
    users: users,
    avg: users ? Math.round((total / users) * 100) / 100 : null,
    avgPerSignup: signups ? Math.round((total / signups) * 100) / 100 : null,
    signups: signups,
    distribution: dist,
    byProduct: byProduct,
    note: '人均生成张数 = 成功出图总数 ÷ 有成功出图的用户数；失败单不计入。'
  };
}

/* ---------------- 指标 ③ 7 日内二次回访 ---------------- */

/* 每个用户的活跃日：访问（events 带 user_id）∪ 任意下单（含失败，用了就算活跃） */
function activityDays(product) {
  const evSql = "SELECT user_id AS uid, day FROM events WHERE user_id IS NOT NULL" +
    (product ? ' AND (product = ? OR product IS NULL)' : '');
  const odSql = 'SELECT user_id AS uid, ' + dayExpr('created_at') + ' AS day FROM orders' +
    (product ? ' WHERE product = ?' : '');
  const sql = evSql + ' UNION ' + odSql;
  const rows = product ? allRows(sql, [product, product]) : allRows(sql, []);
  const m = new Map();   /* uid -> Set(day) */
  rows.forEach(function (r) {
    if (!r.uid) { return; }
    if (!m.has(r.uid)) { m.set(r.uid, new Set()); }
    m.get(r.uid).add(r.day);
  });
  return m;
}

function retentionMeta(range, product) {
  const act = activityDays(product);
  const cohorts = new Map();   /* day -> {size, returned} */
  let total = 0;
  let returned = 0;

  act.forEach(function (days) {
    const sorted = Array.from(days).sort();
    const first = sorted[0];
    if (first < range.from || first > range.to) { return; }
    const mature = diffDays(first, today()) >= 7;
    const hit = sorted.some(function (d) {
      const gap = diffDays(first, d);
      return gap >= 1 && gap <= 7;
    });
    const c = cohorts.get(first) || { day: first, size: 0, returned: 0, mature: mature };
    c.size += 1;
    if (hit) { c.returned += 1; }
    cohorts.set(first, c);
    if (mature) {
      total += 1;
      if (hit) { returned += 1; }
    }
  });

  const list = Array.from(cohorts.values()).sort(function (a, b) { return (a.day < b.day ? 1 : -1); });
  const tracked = one("SELECT MIN(day) AS d FROM events", []);
  const since = tracked && tracked.d;

  return {
    cohortSize: total,           /* 只统计满 7 天的队列，避免新队列拉低 */
    returned: returned,
    rate: pct(returned, total),
    pending: list.filter(function (c) { return !c.mature; }).reduce(function (s, c) { return s + c.size; }, 0),
    cohorts: list,
    since: since || null,
    note: '7 日回访 = 首次活跃日在窗口内的用户，第 2~7 天再次访问或生成的比例。只统计已满 7 天的队列。'
  };
}

/* ---------------- 趋势 ---------------- */

function trendMeta(range, product) {
  const pvSql = product
    ? "SELECT day, COUNT(*) AS hits, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE kind = 'pv' AND day >= ? AND day <= ? AND (product = ? OR product IS NULL) GROUP BY day"
    : "SELECT day, COUNT(*) AS hits, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE kind = 'pv' AND day >= ? AND day <= ? GROUP BY day";
  const pv = new Map();
  (product ? allRows(pvSql, [range.from, range.to, product]) : allRows(pvSql, [range.from, range.to]))
    .forEach(function (r) { pv.set(r.day, r); });

  const su = new Map();
  allRows(
    'SELECT day, COUNT(*) AS n FROM (SELECT ' + dayExpr('created_at') + ' AS day FROM users) WHERE day >= ? AND day <= ? GROUP BY day',
    [range.from, range.to]
  ).forEach(function (r) { su.set(r.day, r.n); });

  const ge = new Map();
  genRows(range.from, range.to, product).forEach(function (r) {
    ge.set(r.day, (ge.get(r.day) || 0) + 1);
  });

  const actSql = 'SELECT day, COUNT(DISTINCT uid) AS n FROM (' +
    "SELECT day, user_id AS uid FROM events WHERE user_id IS NOT NULL AND day >= ? AND day <= ?" +
    ' UNION ' +
    'SELECT ' + dayExpr('created_at') + ' AS day, user_id AS uid FROM orders WHERE ' + dayExpr('created_at') + ' >= ? AND ' + dayExpr('created_at') + ' <= ?' +
    ') GROUP BY day';
  const au = new Map();
  allRows(actSql, [range.from, range.to, range.from, range.to])
    .forEach(function (r) { au.set(r.day, r.n); });

  const out = [];
  for (let i = 0; i < range.days; i++) {
    const d = addDays(range.from, i);
    const p = pv.get(d);
    out.push({
      day: d,
      hits: p ? p.hits : 0,
      visitors: p ? p.visitors : 0,
      signups: su.get(d) || 0,
      gens: ge.get(d) || 0,
      activeUsers: au.get(d) || 0
    });
  }
  return out;
}

/* ---------------- 入口 ---------------- */

function overview(opts) {
  const o = opts || {};
  const range = rangeOf(o.days);
  const product = o.product && o.product !== 'all' ? String(o.product) : '';

  const funnel = funnelMeta(range, product);
  const perUser = perUserMeta(range, product);
  const retention = retentionMeta(range, product);
  const trend = trendMeta(range, product);

  const since = one("SELECT MIN(day) AS d FROM events", []);
  const totals = one(
    'SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM orders) AS orders, ' +
    '(SELECT COUNT(*) FROM events) AS events', []);

  return {
    range: range,
    product: product || 'all',
    funnel: funnel,
    perUser: perUser,
    retention: retention,
    trend: trend,
    tracking: {
      since: since && since.d ? since.d : null,
      events: totals.events,
      totals: { users: totals.users, orders: totals.orders }
    },
    generatedAt: Date.now()
  };
}

module.exports = { overview, dayOf, addDays, diffDays, today };
