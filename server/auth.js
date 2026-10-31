'use strict';
/**
 * 自建账号体系：邮箱验证码登录 + HMAC 会话
 * ---------------------------------------------------------------
 * 为什么换掉云端 auth：2026-10-31 云端整项目被暂停后，连发码与登录都不可用
 * （auth/v1/settings 返回 401 invalid_client），账号体系不能寄生在别人的额度上。
 *
 * 安全约定：
 * - 验证码只存 sha256(email + code) 摘要，库被拖走也拿不到可用码；
 * - 6 位数字、10 分钟有效、同一条码最多试 5 次；用完即置 consumed_at；
 * - 同邮箱 60 秒冷却、每小时最多 8 条；同 IP 每小时最多 20 条（防爆破与滥发）；
 * - 会话是 HMAC-SHA256 签名的 JWT-like token，同时把它的哈希写进 sessions 表，
 *   所以既能「无状态校验」又能「单条吊销」（登出、改密、清全端）。
 */

const crypto = require('crypto');
const dbmod = require('./db');
const mail = require('./mail');

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_TRIES = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const PER_EMAIL_HOURLY = 8;
const PER_IP_HOURLY = 20;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;   /* 30 天 */

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function isValidEmail(v) {
  const e = normalizeEmail(v);
  return e.length <= 254 && EMAIL_RE.test(e);
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function codeHash(email, code) {
  return crypto.createHmac('sha256', dbmod.sessionSecret()).update(email + ':' + code).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length) { return false; }
  return crypto.timingSafeEqual(ba, bb);
}

function findUserByEmail(email) {
  return dbmod.db.prepare('SELECT id, email, name, created_at FROM users WHERE email = ?').get(normalizeEmail(email)) || null;
}

function upsertUser(email) {
  const e = normalizeEmail(email);
  const existing = findUserByEmail(e);
  if (existing) {
    dbmod.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(dbmod.nowMs(), existing.id);
    return existing;
  }
  const id = dbmod.newId('usr');
  dbmod.db.prepare('INSERT INTO users (id, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, e, '', dbmod.nowMs(), dbmod.nowMs());
  return { id: id, email: e, name: '', created_at: dbmod.nowMs() };
}

/* ---------- 发码 ---------- */
function sendCode(rawEmail, ip) {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) { throw fail('BAD_EMAIL', '邮箱格式不正确'); }

  /* 生产环境绝不「假装发出去了」：没配邮件通道就在动数据库之前直接失败。
     否则验证码只落在服务器 outbox 里，用户永远收不到，而我们以为发成功了；
     更危险的是 dev 通道原本会把验证码回传给调用方 —— 等于任何人输别人的
     邮箱就能拿到码登录。生产必须关死这条路。 */
  const provider = mail.providerName();
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && provider === 'dev') {
    console.error('[auth] 生产环境未配置邮件通道，拒绝发码');
    throw fail('MAIL_UNAVAILABLE', '邮件服务暂不可用，请稍后重试或联系客服');
  }

  const d = dbmod.db;
  const now = dbmod.nowMs();

  const last = d.prepare('SELECT created_at FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
  if (last && now - Number(last.created_at) < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - Number(last.created_at))) / 1000);
    throw fail('TOO_FREQUENT', '发送太频繁，请 ' + wait + ' 秒后再试');
  }
  const hourAgo = now - 3600 * 1000;
  const byEmail = d.prepare('SELECT COUNT(*) AS c FROM email_codes WHERE email = ? AND created_at > ?').get(email, hourAgo);
  if (Number(byEmail.c) >= PER_EMAIL_HOURLY) { throw fail('TOO_MANY', '该邮箱今日验证码次数过多，请稍后再试'); }
  if (ip) {
    const byIp = d.prepare('SELECT COUNT(*) AS c FROM email_codes WHERE ip = ? AND created_at > ?').get(String(ip), hourAgo);
    if (Number(byIp.c) >= PER_IP_HOURLY) { throw fail('TOO_MANY', '请求过于频繁，请稍后再试'); }
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  d.prepare('INSERT INTO email_codes (email, code_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email, codeHash(email, code), now + CODE_TTL_MS, ip ? String(ip) : null, now);

  const text = '你的点豆登录验证码是：' + code + '\n\n10 分钟内有效。若非本人操作，请忽略本邮件。\n—— 点豆 DotBeads';
  const html = '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;color:#1F1D1A">'
    + '<p>你的点豆登录验证码是：</p>'
    + '<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:16px 0">' + code + '</p>'
    + '<p style="color:#6B6F76">10 分钟内有效。若非本人操作，请忽略本邮件。</p>'
    + '<p style="color:#8E91A0;font-size:13px">点豆 DotBeads</p></div>';

  return mail.send(email, '点豆登录验证码 ' + code, text, html).then((r) => ({
    ok: true,
    provider: provider,
    expiresIn: Math.floor(CODE_TTL_MS / 1000),
    /* 仅非生产环境的 dev 通道回传验证码，方便本地/自测 */
    devCode: !isProd && r && r.provider === 'dev' ? code : undefined
  })).catch((e) => {
    /* 上游通道的具体原因（域名未验证 / Key 失效 / 限流）只进日志，不回给前端 */
    console.error('[auth] 验证码发送失败 provider=' + provider + ': ' + ((e && e.message) || e));
    throw fail('MAIL_FAILED', '验证码发送失败，请稍后重试');
  });
}

/* ---------- 校验并签发会话 ---------- */
function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', dbmod.sessionSecret()).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') { return null; }
  const parts = token.split('.');
  if (parts.length !== 3) { return null; }
  const expect = crypto.createHmac('sha256', dbmod.sessionSecret()).update(parts[0] + '.' + parts[1]).digest('base64url');
  if (expect.length !== parts[2].length) { return null; }
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(parts[2]))) { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload || !payload.sub || !payload.exp || payload.exp < dbmod.nowMs()) { return null; }
  return payload;
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function verifyCode(rawEmail, rawCode, ua) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || '').trim();
  if (!isValidEmail(email)) { throw fail('BAD_EMAIL', '邮箱格式不正确'); }
  if (!/^\d{6}$/.test(code)) { throw fail('BAD_CODE', '验证码是 6 位数字'); }
  const d = dbmod.db;
  const now = dbmod.nowMs();
  const row = d.prepare(
    'SELECT id, code_hash, expires_at, tries FROM email_codes WHERE email = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(email);
  if (!row) { throw fail('CODE_EXPIRED', '验证码已失效，请重新获取'); }
  if (Number(row.expires_at) < now) { throw fail('CODE_EXPIRED', '验证码已过期，请重新获取'); }
  if (Number(row.tries) >= CODE_MAX_TRIES) { throw fail('TOO_MANY_TRIES', '尝试次数过多，请重新获取验证码'); }

  if (!safeEqualHex(row.code_hash, codeHash(email, code))) {
    d.prepare('UPDATE email_codes SET tries = tries + 1 WHERE id = ?').run(row.id);
    throw fail('BAD_CODE', '验证码不正确');
  }
  d.prepare('UPDATE email_codes SET consumed_at = ? WHERE id = ?').run(now, row.id);

  const user = upsertUser(email);
  const token = signToken({ sub: user.id, email: user.email, iat: now, exp: now + SESSION_TTL_MS });
  d.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), user.id, now, now + SESSION_TTL_MS, String(ua || '').slice(0, 200));
  /* 清理过期会话（顺带，不单独起定时任务） */
  d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);

  return { token: token, user: { id: user.id, email: user.email, name: user.name || '' } };
}

/* 从 Authorization: Bearer xxx 解析当前用户；无效返回 null */
function userFromToken(token) {
  const payload = verifyToken(token);
  if (!payload) { return null; }
  const row = dbmod.db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!row) { return null; }   /* 已吊销 */
  const user = dbmod.db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(payload.sub);
  if (!user) { return null; }
  return { id: user.id, email: user.email, name: user.name || '' };
}

function bearer(req) {
  const h = String((req && req.headers && req.headers.authorization) || '');
  if (!/^Bearer\s+/i.test(h)) { return ''; }
  return h.replace(/^Bearer\s+/i, '').trim();
}

function userFromRequest(req) {
  return userFromToken(bearer(req));
}

function revoke(token) {
  if (!token) { return false; }
  const r = dbmod.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  return Number(r.changes) > 0;
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  sendCode,
  verifyCode,
  verifyToken,
  signToken,
  userFromToken,
  userFromRequest,
  bearer,
  revoke,
  findUserByEmail,
  SESSION_TTL_MS
};
