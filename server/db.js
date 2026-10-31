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

CREATE TABLE IF NOT EXISTS redeem_codes (
  code       TEXT PRIMARY KEY,
  credits    INTEGER NOT NULL,
  used_by    TEXT,
  used_at    INTEGER,
  batch      TEXT,
  created_at INTEGER NOT NULL
);

/* 风格/服务商配置（原云表 app_config，公开只读 JSON） */
CREATE TABLE IF NOT EXISTS app_config (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
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
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', '1');
  }
  return db;
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
