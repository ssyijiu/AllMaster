'use strict';
/**
 * 数据看板（管理员）—— 三个核心观测指标
 * ---------------------------------------------------------------
 * ① 7 日转化率（打开页面 → 首次出图）：反映登录、上传环节的摩擦力
 * ② 人均生成张数：反映图纸质量（好就会多转几张试试）
 * ③ 7 日内二次回访率：决定这是「一次性玩具」还是「工具」
 *
 * 口径统一按**东八区自然日**切（与后台其它报表一致），不是 UTC。
 *
 * 数据来源分两类，页面上会标清楚：
 *   - 生成：orders 表
 *   - 访问/注册：events 表（2026-11-03 起埋点）+ users 表
 *
 * **统计起点（SINCE）**：2026-11-03。这之前的订单、注册、访问全部是内部
 * 试跑数据，一律不计入任何指标 —— 不是「降级计算」，是直接当不存在。
 * 窗口起点早于 SINCE 时自动截断到 SINCE，页面标注实际覆盖天数。
 * 需要重置起点时改环境变量 STATS_SINCE（YYYY-MM-DD），不用动代码。
 *
 * **内部账号排除**：两种口径叠加。
 *   ① 快照时点 SNAPSHOT（默认 2026-11-03 16:30）：该时点**之前注册**的账号
 *      一律视为内部测试号。产品还没有真实用户，早期账号全是自己试跑；
 *      用「时点」而不是「邮箱清单」，省得每加一个测试号就改一次配置，
 *      也不会漏掉没进 ADMIN_EMAILS 的号。此后注册的账号正常统计。
 *   ② ADMIN_EMAILS 里的账号（管理员自己）：无论什么时候注册都排除。
 * 排除是**账号级**的：该账号的订单、活跃日不计，它用过的浏览器 visitor_id
 * 也从访客里剔掉。环境变量：STATS_SNAPSHOT 调时点（ISO 时间，- 关闭），
 * STATS_EXCLUDE_EMAILS 追加邮箱（- 关闭邮箱那一路）。
 *
 * 定义（避免以后各说各话）：
 *   访客        = 浏览器 localStorage 里的匿名 visitor_id
 *   新访客      = 首次出现落在窗口内的访客
 *   首次出图    = 该用户 SINCE 之后第一条 status='succeeded' 的订单
 *   转化率      = 窗口内新访客中，在首访后 7 日内产生首个成功出图的占比
 *   人均生成张数 = 窗口内成功生成总数 ÷ 窗口内有成功生成的用户数
 *   7 日回访    = 首次活跃日落在窗口内的用户，在第 2~7 天再次活跃（访问或生成）的占比
 */

const dbmod = require('./db');

const DAY_MS = 86400000;
const TZ = 8 * 3600 * 1000;

const DEFAULT_SINCE = '2026-11-03';

/* 内部测试期截止：此时点之前注册的账号全部是内部试跑号（2026-11-03 15:45
   定稿时库里 9 个账号全在此时点之前）。此后注册的账号正常计入统计。 */
const DEFAULT_SNAPSHOT = '2026-11-03T15:45:00+08:00';

function sinceDay() {
  const v = String(process.env.STATS_SINCE || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_SINCE;
}

function snapshotMs() {
  const v = String(process.env.STATS_SNAPSHOT || '').trim();
  if (v === '-' || v === 'none') { return 0; }
  const t = Date.parse(v || DEFAULT_SNAPSHOT);
  return Number.isFinite(t) ? t : Date.parse(DEFAULT_SNAPSHOT);
}

/* 取数时间下界：统计起点当天 00:00（本地）与快照时点取较晚者。
   events 有精确 ts，用它把「快照之前的内部浏览」整段切掉——匿名访客无法
   按账号归属，只能靠时间切，否则那几条内部 pv 七天后会变成「未转化」。 */
function cutoffMs() {
  const dayStart = dayToUtc(sinceDay()) - TZ;
  const snap = snapshotMs();
  return snap > dayStart ? snap : dayStart;
}

/* 本地时间文案（给页面用，别让前端自己猜时区） */
function localStamp(ms) {
  return new Date(Number(ms) + TZ).toISOString().slice(0, 16).replace('T', ' ');
}

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
  const since = sinceDay();
  const wantFrom = addDays(to, -(n - 1));
  /* 不早于统计起点：之前的数据是内部试跑，看一眼都算污染 */
  let from = wantFrom < since ? since : wantFrom;
  if (from > to) { from = to; }
  return {
    from: from,
    to: to,
    days: diffDays(from, to) + 1,
    requested: n,
    since: since,
    truncated: from > wantFrom
  };
}

/* ---------------- 基础取数 ---------------- */

function allRows(sql, params) {
  return dbmod.db.prepare(sql).all.apply(dbmod.db.prepare(sql), params);
}
function one(sql, params) {
  return dbmod.db.prepare(sql).get.apply(dbmod.db.prepare(sql), params);
}

/* ---------------- 内部账号排除 ---------------- */

function excludedEmails() {
  const raw = process.env.STATS_EXCLUDE_EMAILS;
  if (raw === undefined) {
    /* 没显式配置时，默认把自己的管理员账号当内部账号 */
    return String(process.env.ADMIN_EMAILS || '')
      .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }
  const v = String(raw).trim();
  if (v === '-' || v === 'none') { return []; }
  return v.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

function excludedUids() {
  const ids = new Set();
  const emails = excludedEmails();
  if (emails.length) {
    const holes = emails.map(function () { return '?'; }).join(',');
    allRows('SELECT id FROM users WHERE lower(email) IN (' + holes + ')', emails)
      .forEach(function (r) { ids.add(r.id); });
  }
  const snap = snapshotMs();
  if (snap > 0) {
    allRows('SELECT id FROM users WHERE created_at < ?', [snap])
      .forEach(function (r) { ids.add(r.id); });
  }
  return Array.from(ids);
}

/* 内部账号用过的浏览器：这些 visitor_id 的访问也不算真实流量 */
function excludedVids(exSet) {
  const set = new Set(exSet || []);
  if (!set.size) { return []; }
  const out = [];
  visitorUsers().forEach(function (uid, vid) {
    if (set.has(uid)) { out.push(vid); }
  });
  return out;
}

/* 拼 "AND col NOT IN (?,?,...)" 与对应参数，空名单时返回空串 */
function notIn(col, ids) {
  if (!ids.length) { return { sql: '', params: [] }; }
  return {
    sql: ' AND ' + col + ' NOT IN (' + ids.map(function () { return '?'; }).join(',') + ')',
    params: ids.slice()
  };
}

function genRows(from, to, product, ex) {
  const ni = notIn('user_id', ex || []);
  const sql = 'SELECT user_id AS uid, ' + dayExpr('created_at') + ' AS day, product, status, created_at ' +
    "FROM orders WHERE status = 'succeeded' AND " + dayExpr('created_at') + ' >= ? AND ' + dayExpr('created_at') + ' <= ?' +
    (product ? ' AND product = ?' : '') + ni.sql;
  const params = (product ? [from, to, product] : [from, to]).concat(ni.params);
  return allRows(sql, params);
}

/* 首次出图只在 SINCE 之后找：更早的订单是内部试跑，不算「首次」 */
function firstGenByUser(product, ex) {
  const ni = notIn('user_id', ex || []);
  const sql = "SELECT user_id AS uid, MIN(created_at) AS ms FROM orders WHERE status = 'succeeded' AND " +
    dayExpr('created_at') + ' >= ?' + (product ? ' AND product = ?' : '') + ni.sql +
    ' GROUP BY user_id';
  const params = (product ? [sinceDay(), product] : [sinceDay()]).concat(ni.params);
  const rows = allRows(sql, params);
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

function firstPvByVisitor(product, fromMs) {
  const sql = "SELECT visitor_id AS vid, MIN(day) AS day FROM events WHERE kind = 'pv' AND visitor_id IS NOT NULL" +
    ' AND ts >= ?' + (product ? ' AND (product = ? OR product IS NULL)' : '') + ' GROUP BY visitor_id';
  const params = product ? [fromMs, product] : [fromMs];
  const rows = allRows(sql, params);
  const m = new Map();
  rows.forEach(function (r) { m.set(r.vid, r.day); });
  return m;
}

/* 四步漏斗：打开页面 → 完成登录 → 上传图片 → 首次出图
   分母与 ① 相同（窗口内首访的访客），每一步都要求发生在该访客首访后的 7 个自然日内。

   「完成登录」「上传图片」来自埋点（kind = identify / upload），出图来自订单。
   出图必然「登录过且上传过」（生成按钮先卡登录、再卡有没有图），所以出图的人
   反向补进登录与上传两步 —— 否则历史数据里会出现「0 人上传、却有人出图」。
   但**不**把「上传过」补成「登录过」：拼豆页允许先选图、点生成时才弹登录，
   上传了却没登录的人正是最大的漏点，要如实留在漏斗里（此时上传条会比登录条长）。 */
function funnelStepsOf(range, product, vids, firstPv, genVids) {
  const login = new Set();
  const upload = new Set();

  if (vids.length) {
    const want = new Set(vids);
    const sql = "SELECT visitor_id AS vid, kind, day FROM events " +
      "WHERE kind IN ('identify','upload') AND day >= ?" +
      (product ? ' AND (product = ? OR product IS NULL)' : '');
    const params = product ? [range.from, product] : [range.from];
    allRows(sql, params).forEach(function (r) {
      if (!want.has(r.vid)) { return; }
      const first = firstPv.get(r.vid);
      if (!first || r.day < first) { return; }        /* 首访之前的不算 */
      if (diffDays(first, r.day) > 7) { return; }     /* 超出 7 日窗口的不算 */
      if (r.kind === 'upload') { upload.add(r.vid); } else { login.add(r.vid); }
    });
  }

  genVids.forEach(function (vid) { upload.add(vid); login.add(vid); });

  return [
    { key: 'page', label: '打开页面', n: vids.length },
    { key: 'login', label: '完成登录', n: login.size },
    { key: 'upload', label: '上传图片', n: upload.size },
    { key: 'gen', label: '首次出图', n: genVids.size }
  ];
}

/* ---------------- 指标 ① 7 日转化率（打开页面 → 首次出图） ---------------- */

function funnelMeta(range, product, ex) {
  const badVids = new Set(excludedVids(ex));
  const visitors = firstPvByVisitor(product, cutoffMs());
  const vmap = visitorUsers();
  const firstGen = firstGenByUser(product, ex);

  let newVisitors = 0;      /* 首访落在窗口内的访客（已剔除内部账号的浏览器） */
  let converted = 0;        /* 其中首访后 7 日内首次出图的 */
  let matured = 0;          /* 观察期满、确认没转化的 */
  let pending = 0;          /* 首访还不满 7 天，暂时判不了 */
  const newVisitorVids = [];
  visitors.forEach(function (day, vid) {
    if (badVids.has(vid)) { return; }
    if (day >= range.from && day <= range.to) {
      newVisitors += 1;
      newVisitorVids.push(vid);
    }
  });
  const genVids = new Set();
  newVisitorVids.forEach(function (vid) {
    const firstVisit = visitors.get(vid);
    const uid = vmap.get(vid);
    const g = uid ? firstGen.get(uid) : null;
    const hit = !!g && g >= firstVisit && diffDays(firstVisit, g) <= 7;
    if (hit) { converted += 1; genVids.add(vid); return; }
    /* 没转化：观察期满才算真流失，不满 7 天的挂起，免得拉低转化率 */
    if (diffDays(firstVisit, today()) < 7) { pending += 1; }
    else { matured += 1; }
  });
  const judged = converted + matured;
  const steps = funnelStepsOf(range, product, newVisitorVids, visitors, genVids);

  const niU = notIn('id', ex || []);
  const signups = one(
    'SELECT COUNT(*) AS n FROM (SELECT ' + dayExpr('created_at') + ' AS day, id FROM users) ' +
    'WHERE day >= ? AND day <= ?' + niU.sql,
    [range.from, range.to].concat(niU.params)
  ).n;

  /* 窗口内首次出图的用户数（账号口径） */
  let firstGenUsers = 0;
  firstGen.forEach(function (day) {
    if (day >= range.from && day <= range.to) { firstGenUsers += 1; }
  });

  /* 有访问数据 → 访客口径；没有 → 退回「注册 → 首图」，并明确标注 */
  if (newVisitors > 0) {
    return {
      basis: 'visitor',
      label: '新访客 7 日转化',
      visitors: newVisitors,
      judged: judged,
      pending: pending,
      signups: signups,
      firstGen: firstGenUsers,
      converted: converted,
      rate: pct(converted, judged),
      steps: steps,
      note: '7 日转化率：分母是窗口内首次出现的匿名访客，分子是其中首访后 7 日内（含当天）完成首次出图的。' +
        '出图即刻计入；只有「不满 7 天且还没出图」的人才进观察中、暂不进分母。'
    };
  }
  return {
    basis: 'signup',
    label: '新注册 → 首次出图',
    visitors: 0,
    judged: 0,
    pending: 0,
    signups: signups,
    firstGen: firstGenUsers,
    converted: Math.min(firstGenUsers, signups),
    rate: pct(Math.min(firstGenUsers, signups), signups),
    note: (range.truncated
      ? '统计起点 ' + sinceDay() + ' 起还没有访客数据，'
      : '本窗口没有访问数据（埋点未覆盖），') +
      '暂按「新注册 → 首次出图」计算。'
  };
}

/* ---------------- 指标 ② 人均生成张数 ---------------- */

function perUserMeta(range, product, ex) {
  const gens = genRows(range.from, range.to, product, ex);
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
  const niU = notIn('id', ex || []);
  const signups = one(
    'SELECT COUNT(*) AS n FROM (SELECT ' + dayExpr('created_at') + ' AS day, id FROM users) ' +
    'WHERE day >= ? AND day <= ?' + niU.sql,
    [range.from, range.to].concat(niU.params)
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

/* 每个用户的活跃日：访问（events 带 user_id）∪ 任意下单（含失败，用了就算活跃）。
   只取 SINCE 之后：更早的活动是内部试跑，会把「首次活跃日」拖到 10 月，
   凭空造出一条本不存在的队列。 */
function activityDays(product, ex) {
  const ni = notIn('user_id', ex || []);
  const since = sinceDay();
  const evSql = "SELECT user_id AS uid, day FROM events WHERE user_id IS NOT NULL AND day >= ? AND ts >= ?" +
    (product ? ' AND (product = ? OR product IS NULL)' : '') + ni.sql;
  const odSql = 'SELECT user_id AS uid, ' + dayExpr('created_at') + ' AS day FROM orders WHERE ' +
    dayExpr('created_at') + ' >= ?' + (product ? ' AND product = ?' : '') + ni.sql;
  const evParams = [since, cutoffMs()].concat(product ? [product] : []).concat(ni.params);
  const odParams = [since].concat(product ? [product] : []).concat(ni.params);
  const rows = allRows(evSql + ' UNION ' + odSql, evParams.concat(odParams));
  const m = new Map();   /* uid -> Set(day) */
  rows.forEach(function (r) {
    if (!r.uid) { return; }
    if (!m.has(r.uid)) { m.set(r.uid, new Set()); }
    m.get(r.uid).add(r.day);
  });
  return m;
}

function retentionMeta(range, product, ex) {
  const act = activityDays(product, ex);
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
  const tracked = one('SELECT MIN(day) AS d FROM events WHERE ts >= ?', [cutoffMs()]);
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

function trendMeta(range, product, ex) {
  /* 内部账号用过的浏览器也算内部：把它们的 visitor_id 从访问量里剔掉 */
  const niV = notIn('visitor_id', excludedVids(ex));

  const pvSql = "SELECT day, COUNT(*) AS hits, COUNT(DISTINCT visitor_id) AS visitors FROM events " +
    "WHERE kind = 'pv' AND day >= ? AND day <= ? AND ts >= ?" +
    (product ? ' AND (product = ? OR product IS NULL)' : '') + niV.sql + ' GROUP BY day';
  const pv = new Map();
  allRows(pvSql, (product ? [range.from, range.to, cutoffMs(), product] : [range.from, range.to, cutoffMs()]).concat(niV.params))
    .forEach(function (r) { pv.set(r.day, r); });

  const su = new Map();
  const niU = notIn('id', ex || []);
  allRows(
    'SELECT day, COUNT(*) AS n FROM (SELECT ' + dayExpr('created_at') + ' AS day, id FROM users) ' +
    'WHERE day >= ? AND day <= ?' + niU.sql + ' GROUP BY day',
    [range.from, range.to].concat(niU.params)
  ).forEach(function (r) { su.set(r.day, r.n); });

  const ge = new Map();
  genRows(range.from, range.to, product, ex).forEach(function (r) {
    ge.set(r.day, (ge.get(r.day) || 0) + 1);
  });

  const niA = notIn('uid', ex || []);
  const actSql = 'SELECT day, COUNT(DISTINCT uid) AS n FROM (' +
    "SELECT day, user_id AS uid FROM events WHERE user_id IS NOT NULL AND day >= ? AND day <= ?" +
    ' UNION ' +
    'SELECT ' + dayExpr('created_at') + ' AS day, user_id AS uid FROM orders WHERE ' + dayExpr('created_at') + ' >= ? AND ' + dayExpr('created_at') + ' <= ?' +
    ') WHERE 1 = 1' + niA.sql + ' GROUP BY day';
  const au = new Map();
  allRows(actSql, [range.from, range.to, range.from, range.to].concat(niA.params))
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
  const ex = excludedUids();

  const funnel = funnelMeta(range, product, ex);
  const perUser = perUserMeta(range, product, ex);
  const retention = retentionMeta(range, product, ex);
  const trend = trendMeta(range, product, ex);

  /* 页脚的量也按统计起点算、也剔掉内部账号，免得「累计 193 单」这种历史数字混进来 */
  const niU = notIn('id', ex);
  const niO = notIn('user_id', ex);
  const niV = notIn('visitor_id', excludedVids(ex));
  const totals = {
    users: one('SELECT COUNT(*) AS n FROM users WHERE ' + dayExpr('created_at') + ' >= ?' + niU.sql,
      [range.since].concat(niU.params)).n,
    orders: one('SELECT COUNT(*) AS n FROM orders WHERE ' + dayExpr('created_at') + ' >= ?' + niO.sql,
      [range.since].concat(niO.params)).n,
    events: one('SELECT COUNT(*) AS n FROM events WHERE day >= ? AND ts >= ?' + niV.sql,
      [range.since, cutoffMs()].concat(niV.params)).n
  };
  const snap = snapshotMs();

  return {
    range: range,
    product: product || 'all',
    funnel: funnel,
    perUser: perUser,
    retention: retention,
    trend: trend,
    tracking: {
      since: range.since,
      events: totals.events,
      totals: { users: totals.users, orders: totals.orders },
      excluded: {
        accounts: ex.length,
        emails: excludedEmails(),
        snapshot: snap > 0 ? localStamp(snap) : null
      }
    },
    generatedAt: Date.now()
  };
}

module.exports = { overview, dayOf, addDays, diffDays, today };
