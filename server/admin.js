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
 * 鉴权：**后台专用登录 + 管理员邮箱白名单**，不用 x-access-key。
 *   - 白名单来源：环境变量 ADMIN_EMAILS → .admin-config.json{emails}
 *   - 白名单外的邮箱在**发码环节就被拒**，拿不到验证码、也签不出会话；
 *     即使它已是前台普通用户，访问后台接口一律 403
 *   - 白名单为空时 fail closed（不放行任何人），而不是退化成「首个注册账号」
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

/* 白名单为空时**不放行任何人**（fail closed）。
   早前有「首个注册账号兜底」，那是迁移期怕把自己锁在门外的权宜之计；
   实际风险更大：库里只要有个更早的测试账号，管理权就落到它头上。
   现在白名单由 systemd 的 ADMIN_EMAILS 显式给出，缺失就报配置错误。 */
function isAdminEmail(email) {
  const list = configuredAdminEmails();
  const e = String(email || '').trim().toLowerCase();
  return !!e && list.indexOf(e) !== -1;
}

function isAdmin(user) {
  if (!user) { return false; }
  return isAdminEmail(user.email);
}

/* 统一门禁：返回 user 或已写响应返回 null */
function requireAdmin(req, res) {
  const user = auth.userFromRequest(req);
  if (!user) {
    sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } });
    return null;
  }
  if (!configuredAdminEmails().length) {
    sendJson(res, 503, { error: { code: 'ADMIN_NOT_CONFIGURED', message: '后台未配置管理员白名单，请先在服务器设置 ADMIN_EMAILS' } });
    return null;
  }
  if (!isAdmin(user)) {
    sendJson(res, 403, { error: { code: 'NOT_ADMIN', message: '该账号禁止访问管理后台' } });
    return null;
  }
  return user;
}

/* ---------- 管理员登录：白名单外一律不发码、不签会话 ----------
   与前台 /api/auth/* 的区别就在这里：前台任何邮箱都能注册登录（产品要用人），
   后台只认白名单邮箱 —— 非管理员连验证码都拿不到，也就无从「登录后台」。 */
function clientIp(req) {
  const trusted = new Set(
    (process.env.TRUSTED_PROXIES || '127.0.0.1,::1,163.7.10.124')
      .split(',').map((s) => s.trim().replace(/^::ffff:/, '')).filter(Boolean)
  );
  const peer = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/, '');
  if (first && trusted.has(peer)) { return first; }
  return peer || first;
}

function loginErrorStatus(code) {
  if (code === 'BAD_EMAIL' || code === 'BAD_CODE' || code === 'CODE_EXPIRED') { return 400; }
  if (code === 'NOT_ADMIN') { return 403; }
  if (code === 'ADMIN_NOT_CONFIGURED') { return 503; }
  if (code === 'MAIL_UNAVAILABLE' || code === 'MAIL_FAILED') { return 503; }
  if (code === 'TOO_MANY' || code === 'TOO_MANY_TRIES' || code === 'TOO_FREQUENT') { return 429; }
  return 500;
}

async function handleLoginSend(req, res) {
  const body = await readJson(req);
  const email = auth.normalizeEmail(body.email);
  if (!configuredAdminEmails().length) {
    return sendJson(res, 503, { error: { code: 'ADMIN_NOT_CONFIGURED', message: '后台未配置管理员白名单，请先在服务器设置 ADMIN_EMAILS' } });
  }
  /* 先判身份再发码：白名单外的邮箱不消耗邮件额度，也不会收到验证码 */
  if (!isAdminEmail(email)) {
    console.warn('[admin] 拒绝向非白名单邮箱发送后台验证码：' + email);
    return sendJson(res, 403, { error: { code: 'NOT_ADMIN', message: '该邮箱没有管理后台权限' } });
  }
  try {
    const out = await auth.sendCode(email, clientIp(req));
    return sendJson(res, 200, out);
  } catch (e) {
    const code = (e && e.code) || 'SEND_FAILED';
    return sendJson(res, loginErrorStatus(code), { error: { code: code, message: (e && e.message) || '发送失败' } });
  }
}

async function handleLoginVerify(req, res) {
  const body = await readJson(req);
  const email = auth.normalizeEmail(body.email);
  /* 校验前再判一次：发码后白名单被改掉，手里的码也不能换出会话 */
  if (!isAdminEmail(email)) {
    return sendJson(res, 403, { error: { code: 'NOT_ADMIN', message: '该邮箱没有管理后台权限' } });
  }
  try {
    const out = auth.verifyCode(email, body.code, req.headers['user-agent']);
    return sendJson(res, 200, out);
  } catch (e) {
    const code = (e && e.code) || 'VERIFY_FAILED';
    return sendJson(res, loginErrorStatus(code), { error: { code: code, message: (e && e.message) || '验证失败' } });
  }
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

/* 头像页「参考图」入口的全局设置：是否开放 + 追加给 AI 的说明（英文提示词片段，留空用前端内置默认） */
function normalizeSettings(body) {
  const s = (body && typeof body === 'object') ? body : {};
  return {
    avatarRefImage: s.avatarRefImage === undefined ? true : s.avatarRefImage !== false,
    refPrompt: String(s.refPrompt == null ? '' : s.refPrompt).slice(0, 1200)
  };
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
  return { providers: providers, styles: styles, settings: normalizeSettings(body.settings) };
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
  if (!emails.length) {
    return sendJson(res, 503, { error: { code: 'ADMIN_NOT_CONFIGURED', message: '后台未配置管理员白名单，请先在服务器设置 ADMIN_EMAILS' } });
  }
  /* 非管理员直接 403，连「谁在白名单里」都不告诉它 */
  if (!isAdmin(user)) {
    console.warn('[admin] 拒绝非管理员读取后台配置：' + user.email);
    return sendJson(res, 403, { error: { code: 'NOT_ADMIN', message: '该账号禁止访问管理后台' } });
  }
  const data = readAppConfigData();
  const pk = readProviderKeys().keys;
  return sendJson(res, 200, {
    isAdmin: true,
    user: { id: user.id, email: user.email, balance: wallet.balance(user.id) },
    adminEmails: emails,
    config: {
      providers: data.providers || [],
      styles: data.styles || [],
      settings: normalizeSettings(data.settings)
    },
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
  /* settings 只在请求显式带了才写：老页面/机器调用不传这个字段时，不把已有开关冲成默认值 */
  if (body && body.settings !== undefined) { data.settings = cfg.settings; }
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

/* ---------- 一批码落库（发码 / 邀请链接共用） ----------
 * 整批在一个事务里写：要么全成，要么一张都不发（不留半批残码）。
 * 冲突重试 8 次：32^10 的码空间里几乎不会撞，重试只是给极端情况兜底。 */
function insertBatchCodes(d, opts) {
  const stmt = d.prepare(
    'INSERT INTO redeem_codes (code, credits, batch, created_at, expires_at, new_user_only, per_user_limit) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const codes = [];
  for (let i = 0; i < opts.count; i++) {
    let code = '';
    for (let t = 0; t < 8; t++) {
      const candidate = randomCode(10);
      if (!d.prepare('SELECT 1 FROM redeem_codes WHERE code = ?').get(candidate)) { code = candidate; break; }
    }
    if (!code) { throw new Error('CODE_GEN_FAILED'); }
    stmt.run(code, opts.credits, opts.batch, opts.now, opts.expiresAt, opts.newUserOnly ? 1 : 0, opts.perUserLimit);
    codes.push(code);
  }
  return codes;
}

/* 面值 / 张数 / 有效期 / 每人限领：两个生成入口同一套校验，避免口径漂移 */
function parseCodeParams(body, out) {
  const e = out || {};
  e.credits = Math.floor(Number(body.credits) || 0);
  e.count = Math.max(1, Math.min(Math.floor(Number(body.count) || 1), 2000));
  e.days = Math.floor(Number(body.expiresInDays === undefined ? 30 : body.expiresInDays));
  e.newUserOnly = body.newUserOnly === true || body.newUserOnly === 1 || body.newUserOnly === '1';
  const raw = body.perUserLimit === undefined || body.perUserLimit === '' ? 1 : Math.floor(Number(body.perUserLimit));
  e.perUserLimit = raw;
  if (e.credits <= 0) { return { code: 'INVALID_CREDITS', message: '面值必须是正整数' }; }
  if (Number.isNaN(e.days) || e.days < 0 || e.days > 3650) {
    return { code: 'INVALID_EXPIRY', message: '有效期应为 0（永久）或 1~3650 天' };
  }
  if (Number.isNaN(raw) || raw < 0 || raw > 100) {
    return { code: 'INVALID_PER_USER_LIMIT', message: '每人限领应为 0（不限）或 1~100' };
  }
  return null;
}

async function handleRedeem(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const p = {};
  const bad = parseCodeParams(body, p);
  if (bad) { return sendJson(res, 400, { error: bad }); }
  const batch = cleanStr(body.batch, 40) || ('ADM' + Date.now().toString(36).toUpperCase());
  const now = dbmod.nowMs();
  const expiresAt = p.days > 0 ? now + p.days * 24 * 3600 * 1000 : null;
  let codes = [];
  try {
    /* 一批码在一个事务里落库：要么全成，要么一张都不发 */
    codes = dbmod.tx((d) => insertBatchCodes(d, {
      batch: batch, credits: p.credits, count: p.count, now: now, expiresAt: expiresAt,
      newUserOnly: p.newUserOnly, perUserLimit: p.perUserLimit
    }));
  } catch (e) {
    return sendJson(res, 400, { error: { code: 'CODE_GEN_FAILED', message: '兑换码生成失败（冲突过多），请重试' } });
  }
  return sendJson(res, 200, {
    ok: true, batch: batch, credits: p.credits, expiresInDays: p.days, expiresAt: expiresAt,
    newUserOnly: p.newUserOnly, perUserLimit: p.perUserLimit, codes: codes
  });
}

/* ---------- 邀请链接（?batch=XXXX，拉新用） ----------
 * 一条链接对应一个批次：用户点开 → 登录 → 服务端从这批名额里取一张码直接入账。
 * 与「一码一条链接」的区别是**不用发几百条链接**，而且链接自带渠道名，
 * 能看每批领了多少、还剩多少——这正是拉新最需要的口径。
 * 批次号随机（IV + 8 位，无 0/O/1/I），不暴露发行量，也猜不到别批。 */
const INVITE_LANDINGS = ['/pixelart', '/', '/apps/avatar/'];

async function handleInviteCreate(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const p = {};
  const bad = parseCodeParams(body, p);
  if (bad) { return sendJson(res, 400, { error: bad }); }
  const label = cleanStr(body.label, 40);
  const landing = INVITE_LANDINGS.indexOf(String(body.landing || '')) !== -1 ? String(body.landing) : '/pixelart';
  const now = dbmod.nowMs();
  const expiresAt = p.days > 0 ? now + p.days * 24 * 3600 * 1000 : null;

  let batch = '';
  let codes = [];
  try {
    batch = dbmod.tx((d) => {
      /* 批次号撞车概率极低（32^8），撞了就重摇，别让后台看到 500 */
      let id = '';
      for (let t = 0; t < 6; t++) {
        const candidate = 'IV' + randomCode(8);
        if (!d.prepare('SELECT 1 FROM redeem_batches WHERE batch = ?').get(candidate)) { id = candidate; break; }
      }
      if (!id) { throw new Error('BATCH_GEN_FAILED'); }
      d.prepare(
        'INSERT INTO redeem_batches (batch, label, landing, credits, quota, new_user_only, per_user_limit, expires_at, active, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
      ).run(id, label, landing, p.credits, p.count, p.newUserOnly ? 1 : 0, p.perUserLimit, expiresAt, now);
      codes = insertBatchCodes(d, {
        batch: id, credits: p.credits, count: p.count, now: now, expiresAt: expiresAt,
        newUserOnly: p.newUserOnly, perUserLimit: p.perUserLimit
      });
      return id;
    });
  } catch (e) {
    return sendJson(res, 400, { error: { code: 'BATCH_GEN_FAILED', message: '邀请链接生成失败，请重试' } });
  }
  return sendJson(res, 200, {
    ok: true, batch: batch, label: label, landing: landing, credits: p.credits, quota: p.count,
    expiresInDays: p.days, expiresAt: expiresAt, newUserOnly: p.newUserOnly, perUserLimit: p.perUserLimit,
    codes: codes
  });
}

/* 批次列表的「状态」是派生的，不是库里的列：
 *   closed    = 手动停用（优先，停用了就不论过期/名额）
 *   expired   = 没停用但过了有效期
 *   exhausted = 没停用没过期，但名额被领完了
 *   open      = 其余
 * 派生逻辑必须在 SQL 里算完再筛再分页，不能在 JS 里筛：否则「已领完」这一页
 * 是从前 N 条里挑出来的，翻页会漏行、总数也对不上。CTE 里的 base 只算一次
 * 三个 COUNT 子查询，tagged 再挂上 CASE，行数与 select * 都由它派生。
 */
const INVITE_STATUS = ['open', 'exhausted', 'closed', 'expired'];
const INVITE_PAGE_MAX = 200;
const INVITE_CTE =
  'WITH base AS (' +
  '  SELECT b.batch, b.label, b.landing, b.credits, b.quota, b.new_user_only, b.per_user_limit, ' +
  '         b.expires_at, b.active, b.created_at, ' +
  '         (SELECT COUNT(*) FROM redeem_codes c WHERE c.batch = b.batch) AS issued, ' +
  '         (SELECT COUNT(*) FROM redeem_codes c WHERE c.batch = b.batch AND c.used_by IS NOT NULL) AS used, ' +
  '         (SELECT COUNT(DISTINCT c.used_by) FROM redeem_codes c WHERE c.batch = b.batch AND c.used_by IS NOT NULL) AS users ' +
  '  FROM redeem_batches b' +
  '), tagged AS (' +
  '  SELECT base.*, CASE ' +
  '      WHEN active = 0 THEN \'closed\' ' +
  '      WHEN expires_at IS NOT NULL AND expires_at < ? THEN \'expired\' ' +
  '      WHEN issued - used <= 0 THEN \'exhausted\' ' +
  '      ELSE \'open\' END AS status ' +
  '  FROM base' +
  ') ';

/* LIKE 里的 % _ 是通配符，用户搜「小红书_11」不该匹配到别的；一律转义 + ESCAPE */
function likeEscape(v) {
  return String(v || '').replace(/[\\%_]/g, (m) => '\\' + m);
}

/*
 * 邀请批次列表：状态筛选 + 关键词 + 分页 + 汇总。
 * 参数：status（all/open/exhausted/closed/expired）、q（渠道名或批次号，模糊）、
 *      batch（精确，单行刷新用）、page、pageSize。
 */
function handleInviteList(req, res, url) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const q = url.searchParams;
  const status = (q.get('status') || 'all').trim();
  if (status !== 'all' && INVITE_STATUS.indexOf(status) === -1) {
    return sendJson(res, 400, { error: { code: 'BAD_STATUS', message: 'status 只支持 all / open / exhausted / closed / expired' } });
  }
  const exactBatch = (q.get('batch') || '').trim();
  const keyword = cleanStr(q.get('q'), 60);
  const page = Math.max(1, Math.floor(Number(q.get('page')) || 1));
  const pageSize = Math.max(1, Math.min(Math.floor(Number(q.get('pageSize')) || 20), INVITE_PAGE_MAX));
  const now = dbmod.nowMs();

  const where = [];
  const filterArgs = [];
  if (status !== 'all') { where.push('status = ?'); filterArgs.push(status); }
  if (exactBatch) { where.push('batch = ?'); filterArgs.push(exactBatch); }
  if (keyword) {
    where.push("(label LIKE ? ESCAPE '\\' OR batch LIKE ? ESCAPE '\\')");
    const like = '%' + likeEscape(keyword) + '%';
    filterArgs.push(like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const d = dbmod.db;
  const total = d.prepare(INVITE_CTE + 'SELECT COUNT(*) AS c FROM tagged ' + whereSql).get(now, ...filterArgs).c || 0;
  const rows = d.prepare(
    INVITE_CTE + 'SELECT * FROM tagged ' + whereSql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(now, ...filterArgs, pageSize, (page - 1) * pageSize);

  /* 汇总看全量（不受筛选影响）：一眼看到还有多少名额没发出去 */
  const agg = d.prepare(INVITE_CTE + 'SELECT status, COUNT(*) AS n FROM tagged GROUP BY status').all(now);
  const stats = { total: 0, open: 0, exhausted: 0, closed: 0, expired: 0 };
  for (const r of agg) {
    const n = Number(r.n) || 0;
    stats[r.status] = n;
    stats.total += n;
  }
  /* 名额/已领按批次整体汇总（不含 filters，符合「家底」语义） */
  const sumRow = d.prepare(
    INVITE_CTE + 'SELECT COALESCE(SUM(quota), 0) AS quota, COALESCE(SUM(used), 0) AS used FROM tagged'
  ).get(now);
  stats.quota = Number(sumRow.quota) || 0;
  stats.used = Number(sumRow.used) || 0;

  return sendJson(res, 200, {
    data: rows.map((r) => ({
      batch: r.batch,
      label: r.label || '',
      landing: r.landing || '/pixelart',
      credits: r.credits,
      quota: r.quota || 0,
      newUserOnly: Number(r.new_user_only) === 1,
      perUserLimit: Number(r.per_user_limit) || 0,
      expiresAt: r.expires_at,
      active: Number(r.active) === 1,
      createdAt: r.created_at,
      issued: Number(r.issued) || 0,
      used: Number(r.used) || 0,
      users: Number(r.users) || 0,
      /* 剩余名额按「还没被领的码」算；过期但没被领的码也算剩余（只是领不了） */
      remaining: Math.max(0, (Number(r.issued) || 0) - (Number(r.used) || 0)),
      expired: r.status === 'expired',
      status: r.status
    })),
    page: page,
    pageSize: pageSize,
    total: total,
    stats: stats,
    error: null
  });
}

/* 停用 / 改名：停用只改链接状态，不动已发出去的码（已领的积分不受影响） */
async function handleInviteUpdate(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const batch = cleanStr(body.batch, 40);
  if (!batch) { return sendJson(res, 400, { error: { code: 'BAD_BATCH', message: '缺少批次号' } }); }
  const row = dbmod.db.prepare('SELECT batch FROM redeem_batches WHERE batch = ?').get(batch);
  if (!row) { return sendJson(res, 404, { error: { code: 'NO_BATCH', message: '没有这个邀请批次' } }); }
  if (body.active !== undefined) {
    dbmod.db.prepare('UPDATE redeem_batches SET active = ? WHERE batch = ?').run(body.active ? 1 : 0, batch);
  }
  if (body.label !== undefined) {
    dbmod.db.prepare('UPDATE redeem_batches SET label = ? WHERE batch = ?').run(cleanStr(body.label, 40), batch);
  }
  return sendJson(res, 200, { ok: true, batch: batch });
}

/* 兑换码列表：状态筛选 + 批次筛选 + 分页 + 汇总。
 * 状态定义：used 优先（已兑换的码无论是否过期都算 used）；过期 = 未使用且已过 expires_at。 */
const REDEEM_PAGE_MAX = 200;
function handleRedeemList(req, res, url) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const q = url.searchParams;
  const status = q.get('status') || 'all';
  const batch = (q.get('batch') || '').trim();
  const page = Math.max(1, Math.floor(Number(q.get('page')) || 1));
  const pageSize = Math.max(1, Math.min(Math.floor(Number(q.get('pageSize')) || 50), REDEEM_PAGE_MAX));
  const now = dbmod.nowMs();

  const where = [];
  const args = [];
  if (status === 'unused') { where.push('used_by IS NULL AND (expires_at IS NULL OR expires_at >= ?)'); args.push(now); }
  else if (status === 'expired') { where.push('used_by IS NULL AND expires_at IS NOT NULL AND expires_at < ?'); args.push(now); }
  else if (status === 'used') { where.push('used_by IS NOT NULL'); }
  else if (status !== 'all') {
    return sendJson(res, 400, { error: { code: 'BAD_STATUS', message: 'status 只支持 all / unused / used / expired' } });
  }
  if (batch) { where.push('batch = ?'); args.push(batch); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const d = dbmod.db;
  const total = d.prepare('SELECT COUNT(*) AS c FROM redeem_codes ' + whereSql).get(...args).c;
  const rows = d.prepare(
    'SELECT code, credits, batch, created_at, expires_at, used_by, used_at, new_user_only, per_user_limit FROM redeem_codes ' +
    whereSql + ' ORDER BY created_at DESC, code LIMIT ? OFFSET ?'
  ).all(...args, pageSize, (page - 1) * pageSize);

  /* 本页涉及到的邀请批次名（渠道）：单独查一次比 JOIN 省事——
     redeem_codes / redeem_batches 都有 batch 列，JOIN 后每个条件都得加前缀。 */
  const labels = {};
  const batchIds = Array.from(new Set(rows.map((r) => r.batch).filter(Boolean)));
  if (batchIds.length) {
    const ph = batchIds.map(() => '?').join(',');
    for (const r of d.prepare('SELECT batch, label FROM redeem_batches WHERE batch IN (' + ph + ')').all(...batchIds)) {
      labels[r.batch] = r.label || '';
    }
  }

  /* 汇总永远看全量（不受筛选影响），方便一眼看到还挂着多少未兑换负债 */
  const stats = d.prepare(
    "SELECT COUNT(*) AS total," +
    " SUM(CASE WHEN used_by IS NOT NULL THEN 1 ELSE 0 END) AS used," +
    " SUM(CASE WHEN used_by IS NULL AND expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END) AS expired," +
    " SUM(CASE WHEN used_by IS NULL THEN credits ELSE 0 END) AS creditsUnused" +
    ' FROM redeem_codes'
  ).get(now);
  const unused = stats.total - (stats.used || 0);

  return sendJson(res, 200, {
    data: rows.map((r) => ({
      code: r.code,
      credits: r.credits,
      batch: r.batch || '',
      batchLabel: labels[r.batch] || '',
      newUserOnly: Number(r.new_user_only) === 1,
      perUserLimit: Number(r.per_user_limit) || 0,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedBy: r.used_by || '',
      usedAt: r.used_at,
      status: r.used_by ? 'used' : (r.expires_at && r.expires_at < now ? 'expired' : 'unused')
    })),
    page: page,
    pageSize: pageSize,
    total: total,
    stats: {
      total: stats.total || 0,
      unused: unused || 0,
      used: stats.used || 0,
      expired: stats.expired || 0,
      creditsUnused: stats.creditsUnused || 0
    },
    error: null
  });
}

/* ---------- 充值套餐 ----------
 * 数据在 app_products 表；总开关（一键下掉全部套餐）存 app_config.data.productsEnabled。
 * 开关不走「保存配置」通道：config 保存只写 providers/styles/settings，
 * 两边互不覆盖。前台查询（/api/db/query → app_products）关掉时直接返空。 */
const PRODUCT_TARGETS = ['', 'avatar', 'pixelart'];  // 空 = 通用（全产品可见）

function readProductsEnabled() {
  const data = readAppConfigData();
  return data.productsEnabled !== false;
}

function handleProductsList(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const rows = dbmod.db.prepare(
    'SELECT id, name, credits, price_cents, product, sort, active, created_at FROM app_products ' +
    'ORDER BY sort ASC, id ASC'
  ).all();
  return sendJson(res, 200, {
    enabled: readProductsEnabled(),
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      credits: r.credits,
      priceCents: r.price_cents,
      product: r.product || '',
      sort: r.sort,
      active: Number(r.active) === 1,
      createdAt: r.created_at
    })),
    error: null
  });
}

/* 校验并归一化一条套餐；出错返回 { error }，成功返回 { row } */
function normalizeProduct(body, out) {
  out.name = cleanStr(body.name, 60);
  if (!out.name) { return '套餐需要一个名称'; }
  out.credits = Math.floor(Number(body.credits));
  if (!Number.isFinite(out.credits) || out.credits <= 0 || out.credits > 10000000) {
    return '积分必须是 1 ~ 10000000 的整数';
  }
  out.priceCents = Math.round(Number(body.priceCents));
  if (!Number.isFinite(out.priceCents) || out.priceCents <= 0 || out.priceCents > 100000000) {
    return '价格必须是 0.01 ~ 1000000 元';
  }
  out.product = cleanStr(body.product, 40);
  if (PRODUCT_TARGETS.indexOf(out.product) === -1) { return '归属产品不支持：' + out.product; }
  out.sort = Math.floor(Number(body.sort)) || 0;
  out.active = body.active === undefined ? true : !!body.active;
  return '';
}

async function handleProductSave(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const p = {};
  const bad = normalizeProduct(body || {}, p);
  if (bad) { return sendJson(res, 400, { error: { code: 'BAD_PRODUCT', message: bad } }); }
  const d = dbmod.db;
  if (body.id) {
    const id = cleanStr(body.id, 60);
    const row = d.prepare('SELECT id FROM app_products WHERE id = ?').get(id);
    if (!row) { return sendJson(res, 404, { error: { code: 'NO_PRODUCT', message: '没有这个套餐' } }); }
    d.prepare('UPDATE app_products SET name = ?, credits = ?, price_cents = ?, product = ?, sort = ?, active = ? WHERE id = ?')
      .run(p.name, p.credits, p.priceCents, p.product, p.sort, p.active ? 1 : 0, id);
    return sendJson(res, 200, { ok: true, id: id });
  }
  const id = dbmod.newId('pk_');
  d.prepare('INSERT INTO app_products (id, name, credits, price_cents, product, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.name, p.credits, p.priceCents, p.product, p.sort, p.active ? 1 : 0, dbmod.nowMs());
  return sendJson(res, 200, { ok: true, id: id });
}

async function handleProductDelete(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const id = cleanStr((body || {}).id, 60);
  if (!id) { return sendJson(res, 400, { error: { code: 'BAD_ID', message: '缺少套餐 id' } }); }
  const info = dbmod.db.prepare('DELETE FROM app_products WHERE id = ?').run(id);
  if (!info.changes) { return sendJson(res, 404, { error: { code: 'NO_PRODUCT', message: '没有这个套餐' } }); }
  return sendJson(res, 200, { ok: true });
}

/* 总开关：一键下掉 / 恢复全部套餐（前台查询直接返空，不动每条套餐的上下架状态） */
async function handleProductSwitch(req, res) {
  const user = requireAdmin(req, res);
  if (!user) { return; }
  const body = await readJson(req);
  const enabled = !body || body.enabled !== false;
  const data = readAppConfigData();
  data.productsEnabled = enabled;
  writeAppConfigData(data);
  return sendJson(res, 200, { ok: true, enabled: enabled });
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
 * 只接管下列路径；其余 /api/admin/* 交回 server.js
 * （/api/admin/sync-key 与 /api/admin/orders/health 仍走 accessKey，属于机器调用）
 * login/send + login/verify 是**后台专用登录**：只放行白名单邮箱。
 */
const ROUTES = {
  '/api/admin/login/send': { POST: handleLoginSend },
  '/api/admin/login/verify': { POST: handleLoginVerify },
  '/api/admin/bootstrap': { GET: handleBootstrap },
  '/api/admin/config': { POST: handleSaveConfig },
  '/api/admin/grant': { POST: handleGrant },
  '/api/admin/redeem': { POST: handleRedeem },
  '/api/admin/redeem/list': { GET: handleRedeemList },
  '/api/admin/invite': { POST: handleInviteCreate },
  '/api/admin/invite/list': { GET: handleInviteList },
  '/api/admin/invite/update': { POST: handleInviteUpdate },
  '/api/admin/products': { GET: handleProductsList },
  '/api/admin/products/save': { POST: handleProductSave },
  '/api/admin/products/delete': { POST: handleProductDelete },
  '/api/admin/products/switch': { POST: handleProductSwitch },
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

module.exports = { handle, isAdmin, isAdminEmail, configuredAdminEmails };
