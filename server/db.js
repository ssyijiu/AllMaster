'use strict';
/**
 * 自建数据层（SQLite）
 * ---------------------------------------------------------------
 * 为什么：2026-10-31 云端资源点耗尽 → 云服务整项目挂起（auth/rest/storage 全拒），
 * 全站积分与登录停摆。决定脱离云服务，数据落到自己的服务器。
 *
 * 选型：Node 22 内置 `node:sqlite`（零依赖、零运维）。单机 + 低并发场景下
 * SQLite(WAL) 的写入吞吐远超本站峰值；不需要再装一个数据库服务。
 *
 * ⚠️ 数据库文件**不能**放在 Web 根目录下可被静态服务的路径里。
 *   默认 ROOT/.data（serveStatic 已拒绝点开头的路径），生产用
 *   DATA_DIR=/opt/allmaster-data 由 systemd 注入，与代码目录物理分离，
 *   发布（覆盖式解压）不会碰到它。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'dotbeads.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

/* 邮箱验证码：只存哈希，泄库也拿不到可用码 */
CREATE TABLE IF NOT EXISTS email_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  tries       INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes ON email_codes(email, id DESC);

/* 会话：存 token 的哈希，可单条吊销（改密码/登出全端） */
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

/* 账本：余额 = SUM(credits) 派生，不做余额字段（避免双写不一致） */
CREATE TABLE IF NOT EXISTS wallet_txns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id     TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL,
  credits    INTEGER NOT NULL,
  kind       TEXT NOT NULL,          -- consume|refund|redeem|pay|grant
  ref        TEXT,                   -- 幂等键：订单号 / 支付单号 / 兑换码
  memo       TEXT,
  product    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wtx_user ON wallet_txns(user_id, id DESC);
/* 幂等：同一个 ref 只允许一笔消费 / 一笔退款 / 一笔支付入账 / 一笔兑换 */
CREATE UNIQUE INDEX IF NOT EXISTS uq_wtx_consume ON wallet_txns(ref) WHERE kind = 'consume' AND ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wtx_refund  ON wallet_txns(ref) WHERE kind = 'refund'  AND ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wtx_pay     ON wallet_txns(ref) WHERE kind = 'pay'     AND ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wtx_redeem  ON wallet_txns(ref) WHERE kind = 'redeem'  AND ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  product     TEXT NOT NULL,
  status      TEXT NOT NULL,         -- pending|succeeded|failed
  credits     INTEGER NOT NULL,
  result_ref  TEXT,
  fail_reason TEXT,
  meta        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

/* 生图通道事件流（2026-11-04）：每单成功/失败各一行，自动切换判定与后台复盘共用。
   只留 7 天（channel.js 内定期清）——这是运维数据，不是业务账本。 */
CREATE TABLE IF NOT EXISTS upstream_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  channel     TEXT NOT NULL,         -- vp|self
  backend     TEXT,                  -- valperler|apinebula
  ok          INTEGER NOT NULL DEFAULT 0,
  error_code  TEXT,
  quota_pool  TEXT,
  http_status INTEGER,
  user_id     TEXT,
  order_id    TEXT,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_upstream_channel ON upstream_errors(channel, ts DESC);

CREATE TABLE IF NOT EXISTS redeem_codes (
  code          TEXT PRIMARY KEY,
  credits       INTEGER NOT NULL,
  used_by       TEXT,
  used_at       INTEGER,
  batch         TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,              -- 到期时间(ms)；NULL = 永久（生成时显式选择才允许）
  new_user_only INTEGER NOT NULL DEFAULT 0,  -- 1 = 仅限新用户（此前无任何积分流水）
  per_user_limit INTEGER NOT NULL DEFAULT 1  -- 同一批次每人最多领几张；0 = 不限
);

/* 邀请批次：?batch=XXX 打开即自动领一张码并入账（拉新链接）。
 * 与 redeem_codes 是 1:N（码表 batch 字段关联），码仍复用同一张表，
 * 所以后台「兑换码列表」照旧能看到每一张码、使用人与时间。
 * 为什么要单独一张表而不是把配置塞进码里：链接本身需要渠道名、落地页、
 * 启停开关这类「链接级」信息——码被领光了链接还要能显示「名额已领完」，
 * 停用链接也不该去改几百行码。规则字段（new_user_only/per_user_limit）
 * 在码上也存一份，兑换时按码判断，两条入口（发码/链接）口径一致。 */
CREATE TABLE IF NOT EXISTS redeem_batches (
  batch          TEXT PRIMARY KEY,
  label          TEXT,                    -- 渠道/活动名，后台列表用
  landing        TEXT,                    -- 落地页路径，如 /pixelart
  credits        INTEGER NOT NULL,
  quota          INTEGER NOT NULL DEFAULT 0,  -- 发行名额（= 这批码的行数，冗余留存便于展示）
  new_user_only  INTEGER NOT NULL DEFAULT 0,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  expires_at     INTEGER,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);

/* 风格/服务商配置（原云表 app_config，公开只读 JSON） */
CREATE TABLE IF NOT EXISTS app_config (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

/* 充值套餐（钱包弹窗「充值套餐」网格的数据源）。
 * 自建版此前 app_products.select 恒返空 → 前台永远「暂无可售套餐」。
 * product 为空 = 全产品通用；platform.js 客户端按产品过滤。
 * 总开关不在表里：存 app_config.data.productsEnabled（默认开），
 * 一键下掉 = 管理后台开关置 false，前台查询直接返空。 */
CREATE TABLE IF NOT EXISTS app_products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  credits     INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  product     TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

/* 文件索引：正文在磁盘 storage/ 下，这里只存元信息，便于列表与容量统计 */
CREATE TABLE IF NOT EXISTS files (
  key        TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner, created_at DESC);

/* 访问日志（数据看板用，2026-11-03 起）：只记「谁在哪天打开了哪个页面」，
   **不存 IP、UA、referer**。visitor_id 是浏览器 localStorage 里的匿名随机串，
   用于算「7 日转化率（打开页面 → 首次出图）」的分母；登录后同一条记录会补上 user_id，
   从而把访客与账号串起来。kind 只允许 pv / identify（见 server/api.js）。
   day 按东八区切（与所有报表口径一致），避免 UTC 跨日把一天拆成两天。 */
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  day        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  user_id    TEXT,
  visitor_id TEXT,
  product    TEXT,
  path       TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_day ON events(day, kind);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id, day);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, day);
`;

let db = null;

function nowMs() { return Date.now(); }

function newId(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}

function open() {
  if (db) { return db; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  /* WAL：读写不互相阻塞；busy_timeout 让并发写自动排队而不是立刻 SQLITE_BUSY */
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/* 顺序迁移：meta.schema_version 记录已应用到的版本，逐版执行且只执行一次。
 * 新库直接建出最新 SCHEMA 后，迁移要能识别「列已存在」并跳过。 */
const MIGRATIONS = {
  /* v2：兑换码加有效期（2026-11-01）。存量码一次性回填 created_at + 30 天，
   * 不留「永久负债」；此后管理员只有显式选「永久」才会落 NULL。 */
  2: (d) => {
    const cols = d.prepare('PRAGMA table_info(redeem_codes)').all().map((c) => c.name);
    if (cols.indexOf('expires_at') === -1) {
      d.exec('ALTER TABLE redeem_codes ADD COLUMN expires_at INTEGER');
    }
    d.exec('UPDATE redeem_codes SET expires_at = created_at + 30*24*3600*1000 WHERE expires_at IS NULL');
  },
  /* v3：兑换码加批次规则（2026-11-01）。解决「一批码被一个人领完」——发一批给群里，
   * 老用户各领一张照样吃完预算，新用户一个没来。
   * 存量码统一按「不限新老、每人每批 1 张」回填，与升级前行为一致（此前一张码一条
   * 链接、天然一人一张），不会因为迁移突然拒掉老用户。 */
  3: (d) => {
    const cols = d.prepare('PRAGMA table_info(redeem_codes)').all().map((c) => c.name);
    if (cols.indexOf('new_user_only') === -1) {
      d.exec('ALTER TABLE redeem_codes ADD COLUMN new_user_only INTEGER NOT NULL DEFAULT 0');
    }
    if (cols.indexOf('per_user_limit') === -1) {
      d.exec('ALTER TABLE redeem_codes ADD COLUMN per_user_limit INTEGER NOT NULL DEFAULT 1');
    }
  }
};

function migrate(d) {
  const row = d.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
  let current = row ? Number(row.v) : 1;
  for (let v = current + 1; MIGRATIONS[v]; v++) {
    MIGRATIONS[v](d);
    current = v;
    d.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run('schema_version', String(v));
  }
}

/* 事务封装：回调内抛错自动回滚。BEGIN IMMEDIATE 立刻拿写锁，
 * 避免「先读后写」在并发下变成 SQLITE_BUSY 或丢失更新。 */
function tx(fn) {
  const d = open();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

function metaGet(k, fallback) {
  const row = open().prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : fallback;
}

function metaSet(k, v) {
  open().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

/* 会话签名密钥：首次启动生成并落库，重启不失效（否则所有人被登出） */
function sessionSecret() {
  let s = metaGet('session_secret', '');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    metaSet('session_secret', s);
  }
  return s;
}

module.exports = {
  ROOT,
  DATA_DIR,
  DB_FILE,
  open,
  tx,
  get db() { return open(); },
  newId,
  nowMs,
  metaGet,
  metaSet,
  sessionSecret
};
