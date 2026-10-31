'use strict';
/**
 * 本地文件存储（替代 WorkBuddy 云存储）
 * ---------------------------------------------------------------
 * 布局：DATA_DIR/storage/<key>，key 形如 users/<uid>/history/xxx.png。
 * 元信息写进 files 表，列表/容量/清理都查表，不用扫盘。
 *
 * 为什么不再用签名 URL 跳第三方：之前头像下载/删除慢的根因就是「浏览器直连境外
 * 云存储 + 每次都要现签 URL」。现在文件在本机，`/files/<key>?e=&s=` 由本站签发、
 * 本站直出，浏览器还能正常缓存。
 *
 * 安全：
 * - key 只允许 [A-Za-z0-9._/-]，拒绝 .. 与绝对路径；
 * - 写/删必须是 `users/<自己的 uid>/...`；
 * - 读走短期签名（默认 1 小时），签名绑定 key + 过期时间，换 key 立即失效。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbmod = require('./db');

const STORAGE_DIR = path.join(dbmod.DATA_DIR, 'storage');
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SIGN_TTL_S = 3600;

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function normalizeKey(key) {
  const k = String(key || '').replace(/^\/+/, '');
  if (!k || !KEY_RE.test(k)) { throw fail('BAD_KEY', '非法文件名'); }
  if (k.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) { throw fail('BAD_KEY', '非法文件名'); }
  if (k.length > 400) { throw fail('BAD_KEY', '文件名过长'); }
  return k;
}

function absPath(key) {
  const k = normalizeKey(key);
  const p = path.join(STORAGE_DIR, k);
  if (!p.startsWith(STORAGE_DIR + path.sep)) { throw fail('BAD_KEY', '非法文件名'); }
  return { key: k, file: p };
}

function ownsKey(userId, key) {
  return !!userId && key.indexOf('users/' + userId + '/') === 0;
}

function signKey(key, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + (Number(ttlSeconds) || SIGN_TTL_S);
  const sig = crypto.createHmac('sha256', dbmod.sessionSecret()).update(key + '|' + exp).digest('base64url');
  return { exp: exp, sig: sig, url: '/files/' + key + '?e=' + exp + '&s=' + sig };
}

function verifySign(key, exp, sig) {
  const e = Number(exp) || 0;
  if (!e || e < Math.floor(Date.now() / 1000)) { return false; }
  const expect = crypto.createHmac('sha256', dbmod.sessionSecret()).update(key + '|' + e).digest('base64url');
  if (expect.length !== String(sig || '').length) { return false; }
  return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(sig || '')));
}

/* 上传（覆盖同 key）。返回元信息。 */
function put(userId, key, buffer, mime) {
  const { key: k, file } = absPath(key);
  if (!ownsKey(userId, k)) { throw fail('FORBIDDEN', '只能写入自己的目录'); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  const size = buffer.length;
  dbmod.db.prepare(
    'INSERT INTO files (key, owner, size, mime, created_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET size = excluded.size, mime = excluded.mime, created_at = excluded.created_at'
  ).run(k, userId, size, String(mime || 'application/octet-stream'), dbmod.nowMs());
  return { key: k, size: size, mime: mime };
}

/* 列表：按 prefix 前缀过滤（只在本人的目录内） */
function list(userId, prefix, opts) {
  const o = opts || {};
  const p = String(prefix || '').replace(/^\/+/, '');
  if (!ownsKey(userId, p)) { throw fail('FORBIDDEN', '只能读取自己的目录'); }
  const limit = Math.min(Math.max(Number(o.limit) || 100, 1), 500);
  /* 注意：用户 id 形如 usr_xxx（含下划线），而 LIKE 里 _ 是通配符。
   * 必须转义 + 显式 ESCAPE，否则 prefix 永远匹配不到自己的文件（列表恒空）。 */
  const pattern = p.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = dbmod.db.prepare(
    'SELECT key, size, mime, created_at FROM files WHERE owner = ? AND key LIKE ? ESCAPE \'\\\' ORDER BY created_at DESC LIMIT ?'
  ).all(userId, pattern, limit);
  return rows.map((r) => ({
    id: r.key,
    name: r.key.split('/').pop(),
    path: r.key,
    metadata: { size: r.size, mimetype: r.mime },
    created_at: new Date(Number(r.created_at)).toISOString()
  }));
}

function remove(userId, keys) {
  const out = [];
  for (const raw of (keys || [])) {
    let k;
    try { k = normalizeKey(raw); } catch (_) { continue; }
    if (!ownsKey(userId, k)) { continue; }
    const file = path.join(STORAGE_DIR, k);
    try { fs.unlinkSync(file); } catch (_) {}
    dbmod.db.prepare('DELETE FROM files WHERE key = ?').run(k);
    out.push(k);
  }
  return out;
}

function readFile(key) {
  const { file } = absPath(key);
  if (!fs.existsSync(file)) { return null; }
  return file;
}

function stat(key) {
  const row = dbmod.db.prepare('SELECT key, size, mime FROM files WHERE key = ?').get(String(key || ''));
  return row || null;
}

function totalBytes() {
  const row = dbmod.db.prepare('SELECT COALESCE(SUM(size), 0) AS b FROM files').get();
  return Number(row && row.b) || 0;
}

module.exports = {
  STORAGE_DIR,
  normalizeKey,
  absPath,
  ownsKey,
  signKey,
  verifySign,
  put,
  list,
  remove,
  readFile,
  stat,
  totalBytes,
  SIGN_TTL_S
};
