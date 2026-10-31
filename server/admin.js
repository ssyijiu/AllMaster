'use strict';
/**
 * 管理后台接口（/api/admin/*，浏览器端 admin.html 专用）
 * ---------------------------------------------------------------
 * 与「运营命令行」server/admin-cli.js 是同一套能力的两个入口：
 *   GET  /api/admin/bootstrap   登录态 → 是否管理员 + 当前配置（Key 只回 hasKeys，绝不回明文）
 *   POST /api/admin/config      保存服务商 / 风格 / 新填的 Key（写 app_config + .ai-config.json）
 *   POST /api/admin/grant       人工充值（按邮箱或用户 id）
 *   POST /api/admin/redeem      批量生成兑换码
 *   GET  /api/admin/users       最近注册用户 + 余额（充值面板选人用）
 *
 * 鉴权：**登录会话 + 管理员邮箱白名单**，不用 x-access-key。
 *   - 白名单来源优先级：环境变量 ADMIN_EMAILS → .admin-config.json{emails} → 首个注册用户兜底
 *   - 兜底是为了「刚迁移完不被锁在门外」，一旦配了白名单就立即失效（响应里 adminByFallback 会提示）
 *   - accessKey 仍只服务 /api/admin/sync-key 与 /api/admin/orders/health 这类机器调用，不发给浏览器
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbmod = require('./db');
const auth = require('./auth');
const wallet = require('./wallet');

const ROOT = path.join(__dirname, '..');
/* 与 server.js 用同一份路径规则：环境变量可覆盖，测试才能指向临时目录，
   不会把仓库里真实的 .ai-config.json 写成测试值 */
const AI_CONFIG_FILE = process.env.AI_CONFIG_FILE || path.join(ROOT, '.ai-config.json');
const ADMIN_CONFIG_FILE = process.env.ADMIN_CONFIG_FILE || path.join(ROOT, '.admin-config.json');
const CONFIG_ID = 'default';

/* 与 admin-cli 一致：去掉易混的 I/O/0/1 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_JSON_BODY = 1 * 1024 * 1024;

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || MAX_JSON_BODY)) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) { return {}; }
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw new Error('BAD_JSON'); }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/* 原子写 + 0600：密钥文件不能被同机其他用户读到 */
function writeJsonFile(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

/* ---------- 管理员判定 ---------- */
function configuredAdminEmails() {
  const env = String(process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (env.length) { return env; }
  const f = readJsonFile(ADMIN_CONFIG_FILE);
  const list = (f && Array.isArray(f.emails) ? f.emails : [])
    .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
  return list;
}

function fallbackAdminUserId() {
  const row = dbmod.db.prepare('SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1').get();
  return row ? row.id : '';
}

function isAdmin(user) {
  if (!user) { return false; }
  const list = configuredAdminEmails();
  if (list.length) { return list.indexOf(String(user.email || '').toLowerCase()) !== -1; }
  /* 兜底：白名单为空时，库里最早注册的账号视为管理员（部署即可用，避免锁死） */
  return user.id === fallbackAdminUserId();
}

/* 统一门禁：返回 user 或已写响应返回 null */
function requireAdmin(req, res) {
  const user = auth.userFromRequest(req);
  if (!user) {
    sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } });
    return null;
  }
  if (!isAdmin(user)) {
    sendJson(res, 403, { error: { code: 'NOT_ADMIN', message: '当前账号不是管理员' } });
    return null;
  }
  return user;
}

/* ---------- app_config 读写 ---------- */
function readAppConfigData() {
  const row = dbmod.db.prepare('SELECT data FROM app_config WHERE id = ?').get(CONFIG_ID);
  if (!row) { return {}; }
  try { return JSON.parse(row.data) || {}; } catch (_) { return {}; }
}

function writeAppConfigData(data) {
  dbmod.db.prepare(
    'INSERT INTO app_config (id, data, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  ).run(CONFIG_ID, JSON.stringify(data), dbmod.nowMs());
}

function readProviderKeys() {
  const ai = readJsonFile(AI_CONFIG_FILE) || {};
  const keys = ai.providerKeys && typeof ai.providerKeys === 'object' ? ai.providerKeys : {};
  return { ai: ai, keys: keys };
}

/* ---------- 字段归一化（后台传什么都别把库写脏） ---------- */
function cleanStr(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 200);
}

function normalizeConfig(body) {
  const providers = (Array.isArray(body.providers) ? body.providers : []).map((p) => ({
    id: cleanStr(p && p.id, 40),
    name: cleanStr(p && p.name, 60),
    baseUrl: cleanStr(p && p.baseUrl, 300),
    model: cleanStr(p && p.model, 120),
    apiMode: (p && p.apiMode) === 'generation' ? 'generation' : 'edit'
  }));
  const styles = (Array.isArray(body.styles) ? body.styles : []).map((s) => ({
    id: cleanStr(s && s.id, 40),
    name: cleanStr(s && s.name, 60),
    imageUrl: String((s && s.imageUrl) || '').slice(0, 200000),
    prompt: String((s && s.prompt) == null ? '' : s.prompt).slice(0, 8000),
    providerId: cleanStr(s && s.providerId, 40),
    product: cleanStr(s && s.product, 40) || 'avatar'
  }));
  return { providers: providers, styles: styles };
}

function validateConfig(cfg) {
  const providerIds = {};
  for (const p of cfg.providers) {
    if (!p.id || !p.name) { return '所有服务商都需要名称与 id'; }
    if (providerIds[p.id]) { return '服务商 id 重复：' + p.id; }
    providerIds[p.id] = true;
  }
  const styleIds = {};
  for (const s of cfg.styles) {
    if (!s.id || !s.name) { return '所有风格都需要名称与 id'; }
    if (styleIds[s.id]) { return '风格 id 重复：' + s.id; }
    styleIds[s.id] = true;
    if (s.providerId && !providerIds[s.providerId]) {
      return '风格「' + s.name + '」绑定的服务商不存在：' + s.providerId;
    }
  }
  return '';
}

/* ---------- 端点 ---------- */
function handleBootstrap(req, res) {
  const user = auth.userFromRequest(req);
  if (!user) { return sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }); }
  const emails = configuredAdminEmails();
  const admin = isAdmin(user);
  if (!admin) {
    return sendJson(res, 200, {
      isAdmin: false,
      user: { id: user.id, email: user.email },
      adminEmails: emails,
      adminByFallback: false
    });
  }
  const data = readAppConfigData();
  const pk = readProviderKeys().keys;
  return sendJson(res, 200, {
    isAdmin: true,
    user: { id: user.id, email: user.email, balance: wallet.balance(user.id) },
    adminEmails: emails,
    adminByFallback: emails.length === 0,
    config: { providers: data.providers || [], styles: data.styles || [] },
    /* 只回「哪些服务商有 Key」，Key 明文永不出库 */
    hasKeys: Object.keys(pk).filter((k) => !!pk[k]),
    /* 支付通道未配置（.pay-config.json 的 channels 为空），面板先隐藏 */
    payEnabled: false
  });
}

async function handleSaveConfig(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const cfg = normalizeConfig(body || {});
  /* 至少留一个服务商：防止前端异常传空数组把配置清光（连带清掉全部 Key） */
  if (!cfg.providers.length) {
    return sendJson(res, 400, { error: { code: 'NO_PROVIDER', message: '至少需要保留一个服务商' } });
  }
  const bad = validateConfig(cfg);
  if (bad) { return sendJson(res, 400, { error: { code: 'BAD_CONFIG', message: bad } }); }

  const data = readAppConfigData();
  data.providers = cfg.providers;
  data.styles = cfg.styles;
  writeAppConfigData(data);

  /* Key 合并规则：以「当前服务商列表」为准保留，前端新填的覆盖旧值。
     → 删掉服务商自动清掉它的 Key（不留孤儿）；前端没传的旧 Key 不会被误删。 */
  const { ai, keys } = readProviderKeys();
  const incoming = (body && body.providerKeys && typeof body.providerKeys === 'object') ? body.providerKeys : {};
  const merged = {};
  for (const p of cfg.providers) {
    const fresh = cleanStr(incoming[p.id], 400);
    const old = keys[p.id];
    if (fresh) { merged[p.id] = fresh; }
    else if (old) { merged[p.id] = old; }
  }
  ai.providerKeys = merged;
  writeJsonFile(AI_CONFIG_FILE, ai);

  return sendJson(res, 200, {
    ok: true,
    saved: { providers: cfg.providers.length, styles: cfg.styles.length },
    hasKeys: Object.keys(merged).filter((k) => !!merged[k])
  });
}

async function handleGrant(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const email = auth.normalizeEmail(String(body.email || body.userId || ''));
  const credits = Number(body.credits);
  const note = cleanStr(body.note, 200) || '人工充值';
  if (!credits || credits <= 0 || !Number.isFinite(credits)) {
    return sendJson(res, 400, { error: { code: 'INVALID_CREDITS', message: '积分必须是正整数' } });
  }
  const target = auth.findUserByEmail(email);
  if (!target) { return sendJson(res, 404, { error: { code: 'NO_USER', message: '没有这个用户：' + email } }); }
  const r = wallet.grant(
    target.id,
    Math.floor(credits),
    'admin-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    note
  );
  return sendJson(res, 200, { ok: true, email: target.email, balance: r.balance });
}

async function handleRedeem(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const credits = Math.floor(Number(body.credits) || 0);
  const count = Math.max(1, Math.min(Math.floor(Number(body.count) || 1), 500));
  if (credits <= 0) { return sendJson(res, 400, { error: { code: 'INVALID_CREDITS', message: '面值必须是正整数' } }); }
  const batch = cleanStr(body.batch, 40) || ('ADM' + Date.now().toString(36).toUpperCase());
  const codes = [];
  try {
    /* 一批码在一个事务里落库：要么全成，要么一张都不发 */
    dbmod.tx((d) => {
      const stmt = d.prepare('INSERT INTO redeem_codes (code, credits, batch, created_at) VALUES (?, ?, ?, ?)');
      for (let i = 0; i < count; i++) {
        let code = '';
        for (let t = 0; t < 8; t++) {
          const candidate = randomCode(10);
          if (!d.prepare('SELECT 1 FROM redeem_codes WHERE code = ?').get(candidate)) { code = candidate; break; }
        }
        if (!code) { throw new Error('CODE_GEN_FAILED'); }
        stmt.run(code, credits, batch, dbmod.nowMs());
        codes.push(code);
      }
    });
  } catch (e) {
    return sendJson(res, 400, { error: { code: 'CODE_GEN_FAILED', message: '兑换码生成失败（冲突过多），请重试' } });
  }
  return sendJson(res, 200, { ok: true, batch: batch, credits: credits, codes: codes });
}

function handleUsers(req, res, url) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 200));
  const rows = dbmod.db.prepare(
    'SELECT id, email, created_at, last_login_at FROM users ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
  const data = rows.map((r) => ({
    id: r.id,
    email: r.email,
    balance: wallet.balance(r.id),
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at
  }));
  return sendJson(res, 200, { data: data, error: null });
}

function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) { out += ALPHABET[crypto.randomInt(0, ALPHABET.length)]; }
  return out;
}

/**
 * 只接管下面这 5 个路径；其余 /api/admin/* 交回 server.js
 * （/api/admin/sync-key 与 /api/admin/orders/health 仍走 accessKey，属于机器调用）
 */
const ROUTES = {
  '/api/admin/bootstrap': { GET: handleBootstrap },
  '/api/admin/config': { POST: handleSaveConfig },
  '/api/admin/grant': { POST: handleGrant },
  '/api/admin/redeem': { POST: handleRedeem },
  '/api/admin/users': { GET: handleUsers }
};

async function handle(req, res, pathOnly, url) {
  const route = ROUTES[pathOnly];
  if (!route) { return false; }
  const fn = route[req.method];
  if (!fn) { sendJson(res, 405, { error: { code: 'METHOD', message: '方法不允许' } }); return true; }
  try {
    await fn(req, res, url);
  } catch (e) {
    const code = e && e.message === 'BAD_JSON' ? 'BAD_JSON' : (e && e.code) || 'INTERNAL';
    sendJson(res, e && e.message === 'BAD_JSON' ? 400 : 500, { error: { code: code, message: (e && e.message) || '服务异常' } });
  }
  return true;
}

module.exports = { handle, isAdmin, configuredAdminEmails };
