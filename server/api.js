'use strict';
/**
 * 自建 HTTP 接口（替代 WorkBuddy 云的 /.cloud/*）
 * ---------------------------------------------------------------
 * 浏览器端由 shared/local-cloud.js 调用，接口刻意做得「像」原来的云 SDK：
 *   /api/auth/*      登录（邮箱验证码）、会话
 *   /api/db/query    最小查询层（select + 过滤 + 排序 + limit），只放行白名单表
 *   /api/storage/*   上传 / 列表 / 删除 / 签名
 *   /files/<key>     签名直链（图片、缩略图、图纸元数据）
 *
 * 设计原则：
 * 1. 任何表访问都按「当前登录用户」收窄，前端传的 filter 不能越过 user_id；
 * 2. 会话只认 Authorization: Bearer，不依赖 cookie（避免跨端 CSRF）；
 * 3. 所有错误返回 {error:{code,message}}，与云 SDK 形状一致。
 */

const fs = require('fs');
const path = require('path');
const dbmod = require('./db');
const auth = require('./auth');
const wallet = require('./wallet');
const storage = require('./storage');
const { createLocalCloud } = require('./local-cloud');

const ROOT = path.join(__dirname, '..');

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

/* RPC 层：与 server.js 里订单状态机共用同一套实现（同一进程、同一份 sqlite 句柄） */
const cloud = createLocalCloud({
  accessKey: function () { return (readJsonFile(path.join(ROOT, '.pay-config.json')) || {}).accessKey || ''; },
  paySecret: function () { return (readJsonFile(path.join(ROOT, '.pay-config.json')) || {}).paySecret || ''; },
  log: function (m) { console.warn('[api-rpc] ' + m); }
});

const MAX_JSON_BODY = 1 * 1024 * 1024;
const MAX_UPLOAD_BODY = 24 * 1024 * 1024;

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
  const buf = await readBody(req, MAX_JSON_BODY);
  if (!buf.length) { return {}; }
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw new Error('BAD_JSON'); }
}

/* 客户端 IP：只有「直连对端是可信任的反向代理」时才信 X-Forwarded-For。
   备案期 dotbeads.online 由雅加达入口反代到本机，真实 IP 只能从 XFF 拿；
   但本机 8080 也直接暴露在公网，若无条件信 XFF，任何人伪造这个头就能
   绕过按 IP 的发码限流。所以按对端地址白名单判断。 */
const TRUSTED_PROXIES = new Set(
  (process.env.TRUSTED_PROXIES || '127.0.0.1,::1,163.7.10.124')
    .split(',').map(function (s) { return s.trim().replace(/^::ffff:/, ''); }).filter(Boolean)
);

function clientIp(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/, '');
  if (first && TRUSTED_PROXIES.has(peer)) { return first; }
  return peer || first;
}

/* ---------- 表访问白名单 ---------- */
const TABLES = {
  /* 账本：只读、只本人；列名映射成前端期望的形状 */
  app_wallet_txns: {
    needAuth: true,
    select: function (user, q) {
      const rows = wallet.listTxns(user.id, q.limit || 50);
      return rows.filter((r) => matches(r, q.filters));
    }
  },
  /* 风格/服务商配置：公开只读，一行 id='default' 的 JSON。
     形状必须与云端表一致：返回 [{ id, data }]，前端读 rows[0].data。
     （早前这里把 data 展开成 {id, providers, styles}，导致 rows[0].data 恒为
     undefined → 前台永远回退内置兜底，后台配的风格一直「读不到」。） */
  app_config: {
    needAuth: false,
    select: function (user, q) {
      const eqId = (q && q.filters || []).filter((f) => f && f.col === 'id' && f.op === 'eq')[0];
      const id = (eqId && eqId.val) || 'default';
      const row = dbmod.db.prepare('SELECT id, data FROM app_config WHERE id = ?').get(id);
      if (!row) { return []; }
      let data = null;
      try { data = JSON.parse(row.data); } catch (_) { data = null; }
      return [{ id: row.id, data: data }];
    }
  },
  /* 套餐：本地暂无产品套餐表，返回空 → 前端回落到内置套餐 */
  app_products: {
    needAuth: false,
    select: function () { return []; }
  }
};

function matches(row, filters) {
  if (!filters || !filters.length) { return true; }
  return filters.every((f) => {
    const v = row ? row[f.col] : undefined;
    if (f.op === 'eq') { return v === f.val; }
    if (f.op === 'in') { return Array.isArray(f.val) && f.val.indexOf(v) !== -1; }
    return true;
  });
}

/* ---------- auth ---------- */
async function handleAuth(req, res, pathOnly) {
  if (pathOnly === '/api/auth/send-code' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const out = await auth.sendCode(body.email, clientIp(req));
      return sendJson(res, 200, out);
    } catch (e) {
      const c = e && e.code;
      const status = c === 'BAD_EMAIL' ? 400
        : (c === 'MAIL_UNAVAILABLE' || c === 'MAIL_FAILED') ? 503
        : (c === 'TOO_MANY' ? 429 : 500);
      return sendJson(res, status, { error: { code: c || 'SEND_FAILED', message: (e && e.message) || '发送失败' } });
    }
  }
  if (pathOnly === '/api/auth/verify' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const out = auth.verifyCode(body.email, body.code, req.headers['user-agent']);
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 400, { error: { code: e.code || 'VERIFY_FAILED', message: e.message } });
    }
  }
  if (pathOnly === '/api/auth/session' && req.method === 'GET') {
    const user = auth.userFromRequest(req);
    if (!user) { return sendJson(res, 200, { user: null }); }
    return sendJson(res, 200, { user: user, balance: wallet.balance(user.id) });
  }
  if (pathOnly === '/api/auth/signout' && req.method === 'POST') {
    auth.revoke(auth.bearer(req));
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
}

/* ---------- db ---------- */
async function handleDb(req, res, pathOnly) {
  if (pathOnly !== '/api/db/query' || req.method !== 'POST') {
    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  }
  const q = await readJson(req);
  const def = TABLES[q.table];
  if (!def) { return sendJson(res, 403, { error: { code: 'TABLE_DENIED', message: '不允许访问该表' } }); }
  if (q.action && q.action !== 'select') {
    return sendJson(res, 501, { error: { code: 'UNSUPPORTED', message: '本地服务暂不支持该写操作' } });
  }
  const user = auth.userFromRequest(req);
  if (def.needAuth && !user) { return sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }); }
  try {
    const data = def.select(user, q || {});
    return sendJson(res, 200, { data: data, error: null });
  } catch (e) {
    return sendJson(res, 400, { data: null, error: { code: e.code || 'QUERY_FAILED', message: e.message } });
  }
}

/* ---------- storage ---------- */
async function handleStorage(req, res, pathOnly, url) {
  const user = auth.userFromRequest(req);
  if (!user) { return sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }); }

  if (pathOnly === '/api/storage/upload' && req.method === 'POST') {
    const key = url.searchParams.get('key') || '';
    const mime = url.searchParams.get('mime') || req.headers['content-type'] || 'application/octet-stream';
    let buf;
    try { buf = await readBody(req, MAX_UPLOAD_BODY); } catch (e) {
      return sendJson(res, 413, { error: { code: 'TOO_LARGE', message: '文件过大（上限 24MB）' } });
    }
    try {
      const meta = storage.put(user.id, key, buf, mime);
      return sendJson(res, 200, { data: { path: meta.key, id: meta.key, size: meta.size }, error: null });
    } catch (e) {
      return sendJson(res, 400, { data: null, error: { code: e.code || 'UPLOAD_FAILED', message: e.message } });
    }
  }

  if (pathOnly === '/api/storage/list' && req.method === 'GET') {
    const prefix = url.searchParams.get('prefix') || ('users/' + user.id + '/');
    const limit = Number(url.searchParams.get('limit')) || 100;
    try {
      const items = storage.list(user.id, prefix, { limit: limit });
      return sendJson(res, 200, { data: items, error: null });
    } catch (e) {
      return sendJson(res, 400, { data: [], error: { code: e.code || 'LIST_FAILED', message: e.message } });
    }
  }

  if (pathOnly === '/api/storage/remove' && req.method === 'POST') {
    const body = await readJson(req);
    const keys = body.keys || body.paths || [];
    try {
      const removed = storage.remove(user.id, keys);
      return sendJson(res, 200, { data: removed, error: null });
    } catch (e) {
      return sendJson(res, 400, { data: [], error: { code: e.code || 'REMOVE_FAILED', message: e.message } });
    }
  }

  if (pathOnly === '/api/storage/sign' && req.method === 'POST') {
    const body = await readJson(req);
    const keys = body.keys || [];
    const ttl = Math.min(Math.max(Number(body.ttl) || storage.SIGN_TTL_S, 60), 24 * 3600);
    const out = [];
    for (const raw of keys) {
      let k;
      try { k = storage.normalizeKey(raw); } catch (_) { continue; }
      if (!storage.ownsKey(user.id, k)) { continue; }
      const s = storage.signKey(k, ttl);
      out.push({ path: k, signedUrl: s.url, signed_url: s.url, url: s.url, expiresAt: s.exp });
    }
    return sendJson(res, 200, { data: out, error: null });
  }

  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
}

/* ---------- rpc：把本地 RPC 暴露成 HTTP，前端 walletRpc 零改动 ---------- */
async function handleRpc(req, res, pathOnly) {
  if (req.method !== 'POST') { return sendJson(res, 405, { error: { code: 'METHOD', message: '仅支持 POST' } }); }
  const fn = pathOnly.slice('/api/rpc/'.length);
  if (!fn) { return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } }); }
  const body = await readJson(req);
  const token = auth.bearer(req);
  const r = await cloud.rpc(token, fn, body);
  if (r.status === 200) { return sendJson(res, 200, { data: r.data, error: null }); }
  return sendJson(res, r.status, { data: null, error: { code: r.text, message: r.text } });
}

/* ---------- 文件直链 /files/<key>?e=&s= ---------- */
function handleFiles(req, res, pathOnly, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end('405');
  }
  const key = decodeURIComponent(pathOnly.replace(/^\/files\//, ''));
  const exp = url.searchParams.get('e');
  const sig = url.searchParams.get('s');
  let norm;
  try { norm = storage.normalizeKey(key); } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('400 bad key');
  }
  if (!storage.verifySign(norm, exp, sig)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('403 expired');
  }
  const file = storage.readFile(norm);
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
  const st = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml', '.pdf': 'application/pdf'
  };
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    /* 签名 URL 里带了过期时间，浏览器可在有效期内缓存；内容变了 key 会变 */
    'Cache-Control': 'private, max-age=3600'
  });
  if (req.method === 'HEAD') { return res.end(); }
  fs.createReadStream(file).pipe(res);
}

/**
 * 统一入口：返回 true 表示已处理。
 * @param {object} ctx 预留（日志等）
 */
async function handle(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathOnly = url.pathname;
  if (pathOnly.indexOf('/api/auth/') === 0) {
    try { await handleAuth(req, res, pathOnly); } catch (e) {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: (e && e.message) || '服务异常' } });
    }
    return true;
  }
  if (pathOnly === '/api/db/query') {
    try { await handleDb(req, res, pathOnly); } catch (e) {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: (e && e.message) || '服务异常' } });
    }
    return true;
  }
  if (pathOnly.indexOf('/api/storage/') === 0) {
    try { await handleStorage(req, res, pathOnly, url); } catch (e) {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: (e && e.message) || '服务异常' } });
    }
    return true;
  }
  if (pathOnly.indexOf('/api/rpc/') === 0) {
    try { await handleRpc(req, res, pathOnly); } catch (e) {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: (e && e.message) || '服务异常' } });
    }
    return true;
  }
  if (pathOnly.indexOf('/files/') === 0) {
    handleFiles(req, res, pathOnly, url);
    return true;
  }
  return false;
}

module.exports = { handle, sendJson, readJson, MAX_UPLOAD_BODY };
