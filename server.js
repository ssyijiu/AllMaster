/**
 * AI 头像工坊 · 静态站点 + 同源 AI 代理 + 支付通道层
 *
 * 【AI 代理】/api/ai（SSE 心跳流）
 * - 第三方 AI 网关 CORS 配置不全（Allow-Headers: * 不覆盖 Authorization），
 *   浏览器直连会 Failed to fetch，因此由同源服务端转发。
 * - 托管平台边缘网关对「空闲 30 秒」的请求直接 524（实测），而图片生成常需
 *   60~120 秒；心跳流让连接持续有字节流动，实测 120s+ 正常返回。
 * - **Key 下沉**：服务商 Key 存在服务器本地 .ai-config.json（点开头的隐藏文件，
 *   静态服务会拒绝下发），前端请求只带 providerId，不再持有 Key。
 *
 * 【支付通道层】/api/pay/*
 * - 统一适配层 payChannels：每个通道实现 createOrder / verifyNotify。
 *   已实现：xunhupay（虎皮椒，个人可签约）；redeem（兑换码）走云端 RPC，不经本服务。
 * - 通道凭据存 .pay-config.json（未配置的通道自动休眠）。
 * - 支付回调 /api/pay/notify 验签后落盘；用户端 /api/pay/claim 领取带签名的
 *   入账凭证，最终由云端 RPC wallet_pay_claim（HMAC 校验 + 幂等）加积分。
 * - 管理端点（拉取订单 / 同步 Key）用 x-access-key（与云端 app_secrets 一致）。
 *
 * 安全边界：
 * - 只允许 https 目标，禁止本机/内网地址（防 SSRF）
 * - 请求体上限 25MB，上游超时 300s
 * - 隐藏文件（. 开头）不可通过 HTTP 下载
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const querystring = require('querystring');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MAX_BODY = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT = 300000;
const BEAT_INTERVAL = 2000;

const AI_CONFIG_FILE = path.join(ROOT, '.ai-config.json');
const PAY_CONFIG_FILE = path.join(ROOT, '.pay-config.json');
const PAY_STATE_FILE = path.join(ROOT, '.pay-state.json');

/* 生成单（P3）：一次生成 = 一单，先建单扣费，成功/失败必须结算。
 * 云端 app_orders 存状态，退款在 order_fail() 里与状态变更同事务、且幂等。 */
const orderService = require('./server/orders').createOrderService({
  rpc: function (token, fn, params) { return cloudRpc(token, fn, params); },
  rpcAnon: function (fn, params) { return cloudRpcAnon(fn, params); },
  log: function (msg) { console.warn('[order] ' + msg); }
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* 每次请求时读取配置文件（小文件，读取廉价），管理员更新后即时生效、无需重启 */
function readDotJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

/* 固定长度比较，避免时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) { return false; }
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------- 支付通道适配层 ---------- */

/* 虎皮椒 V3 签名：除 hash 外的参数按 key ASCII 升序拼接 k=v&…（跳过空值），
 * 末尾接 &key=商户密钥 后取 MD5 小写。以官方文档为准，开通后联调验证。 */
function xunhuHash(params, secret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'hash' && params[k] !== undefined && params[k] !== null && String(params[k]) !== '')
    .sort();
  const src = keys.map((k) => k + '=' + params[k]).join('&') + '&key=' + secret;
  return md5(src);
}

const payChannels = {
  xunhupay: {
    enabled(cfg) {
      return !!(cfg && cfg.xunhupay && cfg.xunhupay.appid && cfg.xunhupay.secret);
    },
    /* 创建订单：调虎皮殿下单接口，返回支付跳转地址 */
    async createOrder(cfg, order, req) {
      const host = req.headers.host || '';
      const share = cfg.siteSharecode ? ('?sharecode=' + cfg.siteSharecode) : '';
      const params = {
        version: '1.1',
        lang: 'zh-cn',
        plugins: 'web',
        appid: cfg.xunhupay.appid,
        trade_order_id: order.orderNo,
        total_fee: (order.amountCents / 100).toFixed(2),
        title: order.title || 'AI 头像工坊积分充值',
        time: Math.floor(Date.now() / 1000),
        notify_url: 'https://' + host + '/api/pay/notify' + share,
        return_url: 'https://' + host + '/apps/avatar/?paid=' + order.orderNo + share.replace('?', '&'),
        nonce_str: crypto.randomBytes(8).toString('hex')
      };
      params.hash = xunhuHash(params, cfg.xunhupay.secret);
      const res = await fetch('https://api.xunhupay.com/payment/do.html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: querystring.stringify(params)
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }
      if (!data || !data.url) {
        const e = new Error('支付下单失败：' + ((data && (data.errmsg || data.errcode)) || '网关无响应'));
        e.status = 502;
        throw e;
      }
      return { payUrl: data.url };
    },
    /* 验证异步通知签名 */
    verifyNotify(cfg, params) {
      if (!cfg || !cfg.xunhupay || !cfg.xunhupay.secret) { return null; }
      const expect = xunhuHash(params, cfg.xunhupay.secret);
      if (!params.hash || !safeEqual(expect, String(params.hash).toLowerCase())) { return null; }
      return {
        orderNo: params.trade_order_id,
        tradeNo: params.transaction_id || params.openorder_id || '',
        status: params.status || params.pay_type || ''
      };
    }
  }
};

function readPayState() {
  const st = readDotJson(PAY_STATE_FILE);
  return st && typeof st === 'object' && st.orders ? st : { orders: {} };
}

function writePayState(state) {
  const tmp = PAY_STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, PAY_STATE_FILE);
}

/* ---------- AI 代理 ---------- */

/* 只允许公网 https 地址，阻断本机与内网（SSRF 防护） */
function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('接口地址格式不正确'); }
  if (u.protocol !== 'https:') { throw new Error('接口地址必须是 https'); }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) { throw new Error('不允许访问本机地址'); }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const p = host.split('.').map(Number);
    const isPrivate =
      p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
    if (isPrivate) { throw new Error('不允许访问内网地址'); }
  }
  if (host === 'metadata.google.internal') { throw new Error('不允许访问该地址'); }
  return u;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大（上限 25MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* 校验入参；Key 由调用方解析后传入（服务器本地文件优先，payload.apiKey 仅作旧版兼容） */
function preparePayload(payload, apiKey) {
  const { baseUrl, model, path: apiPath, prompt, imageBase64 } = payload || {};
  function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
  if (!baseUrl || !apiKey || !model || !prompt) {
    throw bad('缺少必要参数（接口地址 / Key / 模型 / 提示词）');
  }
  if (apiPath !== '/images/edits' && apiPath !== '/images/generations') {
    throw bad('不支持的接口路径');
  }
  const target = assertSafeUrl(String(baseUrl).replace(/\/+$/, '') + apiPath);
  if (apiPath === '/images/edits' && !imageBase64) {
    throw bad('该接口需要上传照片');
  }
  return { target: target.toString(), apiKey, model, apiPath, prompt, imageBase64 };
}

/* 真正调用上游，返回 { statusCode, data }；网络层失败抛出异常 */
async function callUpstream(arg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  try {
    let upstreamRes;
    if (arg.apiPath === '/images/edits') {
      const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(arg.imageBase64);
      if (!match) { const e = new Error('图片数据格式不正确'); e.status = 400; throw e; }
      const mime = match[1];
      const buf = Buffer.from(match[2], 'base64');
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
      const form = new FormData();
      form.append('model', arg.model);
      form.append('prompt', arg.prompt);
      form.append('n', '1');
      form.append('size', '1024x1024');
      form.append('image', new Blob([buf], { type: mime }), 'photo.' + ext);
      upstreamRes = await fetch(arg.target, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + arg.apiKey },
        body: form,
        signal: controller.signal
      });
    } else {
      upstreamRes = await fetch(arg.target, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + arg.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: arg.model, prompt: arg.prompt, n: 1, size: '1024x1024' }),
        signal: controller.signal
      });
    }
    const text = await upstreamRes.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 800) }; }
    return { statusCode: upstreamRes.status, data: data };
  } catch (err) {
    if (err && err.status === 400) { throw err; }
    const aborted = err && (err.name === 'AbortError');
    const e = new Error(aborted
      ? ('上游服务超时（' + Math.round(UPSTREAM_TIMEOUT / 1000) + ' 秒未返回），请稍后重试或换更快的模型')
      : ('转发失败：' + ((err && err.message) || '网络错误')));
    e.status = aborted ? 504 : 502;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* 前端能解析的图片形态（对齐 apps/avatar/app.js 的 parseImageResponse/extractImageUrl）：
 * 只认 data[0].b64_json | data[0].url。2xx 但没有图 = 用户拿不到东西，按失败处理并退款。 */
function hasImagePayload(data) {
  if (!data || typeof data !== 'object') { return false; }
  const arr = Array.isArray(data.data) ? data.data : null;
  if (!arr || !arr.length) { return false; }
  const it = arr[0];
  if (!it || typeof it !== 'object') { return false; }
  return !!(it.b64_json || it.url);
}

/* POST /api/ai { providerId, baseUrl, model, path, prompt, imageBase64? }
 * Key 按 providerId 从服务器本地 .ai-config.json 解析；响应为 SSE 心跳流。
 *
 * 计费（P3 生成单）：建单 → 扣费(单号即 ref) → 调上游 → 交付成功才结算 succeeded；
 * 上游失败、2xx 但没图、图拿到了却没能写回客户端（用户关页/断网）——全部 fail 退款。
 * 这样「已扣费但没拿到图」的三个窗口都收敛到同一处判断，前端不需要再退款。 */
async function handleAi(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch (err) {
    return sendJson(res, 400, { error: { message: (err && err.message) || '请求解析失败' } });
  }

  /* —— 身份（先判，未登录不该走到 Key/参数校验的分支）—— */
  const authHeader = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!bearer) {
    return sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '生成需要登录，请先登录后再试' } });
  }
  const token = bearer[1];

  const aiCfg = readDotJson(AI_CONFIG_FILE) || {};
  const keys = aiCfg.providerKeys || {};
  const apiKey = (payload.providerId && keys[payload.providerId]) || payload.apiKey || '';
  if (!apiKey) {
    return sendJson(res, 400, { error: { message: '该服务商的 Key 未在服务器配置，请管理员在后台同步' } });
  }

  let arg;
  try {
    arg = preparePayload(payload, apiKey);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: { message: err.message } });
  }

  /* —— 建单 + 扣费（服务端把关，前端绕不过）—— */
  const order = await orderService.create({
    token: token,
    product: 'avatar',
    meta: { path: arg.apiPath, model: arg.model }
  });
  if (order.error) {
    return sendJson(res, order.error.status, { error: { code: order.error.code, message: order.error.message } });
  }

  /* SSE 心跳流：边等上游边每 2 秒写心跳，最后一行 data: 携带真实结果 */
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Order-Id': order.orderId,
    'X-Wallet-Balance': order.balance == null ? '' : String(order.balance),
    Connection: 'keep-alive'
  });
  const startedAt = Date.now();
  res.write(': start\n\n');

  const beat = setInterval(() => {
    if (res.writableEnded) { clearInterval(beat); return; }
    try { res.write(': wait ' + Math.round((Date.now() - startedAt) / 1000) + '\n\n'); } catch (_) {}
  }, BEAT_INTERVAL);

  let out = null;
  let delivered = false;
  let settled = false;

  try {
    try {
      const r = await callUpstream(arg);
      out = { statusCode: r.statusCode, data: r.data };
    } catch (err) {
      out = { statusCode: err.status || 502, data: { error: { message: err.message } } };
    }

    const httpOk = out.statusCode >= 200 && out.statusCode < 300;
    if (!httpOk || !hasImagePayload(out.data)) {
      /* 上游失败 / 超时 / 2xx 但没图：这一单没交付，退款并给前端明确原因 */
      if (httpOk) {
        out = {
          statusCode: 502,
          data: { error: { message: '服务商没有返回图片（回包缺少 b64_json / url），本次未扣积分，请重试' } }
        };
      }
      await orderService.fail(order.orderId, token, 'upstream_' + out.statusCode, order.txnId, order.tracked);
      settled = true;
    } else {
      /* 图已拿到：先投递，再结算成功。投递失败（关页/断网）就退款，不让用户白花钱 */
      if (!res.writableEnded && !res.destroyed) {
        try { res.write('data: ' + JSON.stringify(out) + '\n\n'); delivered = true; } catch (_) {}
      }
      if (delivered) {
        await orderService.succeed(order.orderId, token, '');
        settled = true;
      } else {
        await orderService.fail(order.orderId, token, 'client_gone', order.txnId, order.tracked);
        settled = true;
      }
    }
  } catch (err) {
    /* 兜底：任何没预料到的异常都必须让这一单有结论 */
    if (!settled) {
      await orderService.fail(order.orderId, token, 'proxy_error', order.txnId, order.tracked);
      settled = true;
    }
    if (!out) {
      out = { statusCode: 502, data: { error: { message: '生成服务异常：' + ((err && err.message) || err) } } };
    }
  } finally {
    clearInterval(beat);
    if (!delivered && !res.writableEnded) {
      try { res.write('data: ' + JSON.stringify(out) + '\n\n'); } catch (_) {}
    }
    if (!res.writableEnded) {
      try { res.end(); } catch (_) {}
    }
  }
}

/* ---------- 支付端点 ---------- */

/* POST /api/pay/order {channel, productId, credits, amountCents, userId, title} */
async function handlePayOrder(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch (err) {
    return sendJson(res, 400, { error: { message: '请求解析失败' } });
  }
  const cfg = readDotJson(PAY_CONFIG_FILE) || {};
  const channel = payChannels[body.channel];
  if (!channel) { return sendJson(res, 400, { error: { message: '未知的支付通道' } }); }
  if (!channel.enabled(cfg)) {
    return sendJson(res, 501, { error: { code: 'PAY_NOT_CONFIGURED', message: '该支付通道尚未开通' } });
  }
  if (!body.userId || !body.credits || body.credits <= 0 || !body.amountCents || body.amountCents <= 0) {
    return sendJson(res, 400, { error: { message: '订单参数不完整' } });
  }
  const orderNo = 'W' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
  const order = {
    orderNo: orderNo,
    userId: String(body.userId),
    productId: body.productId || '',
    credits: Math.floor(body.credits),
    amountCents: Math.floor(body.amountCents),
    title: body.title || '',
    status: 'created',
    tradeNo: '',
    createdAt: Date.now(),
    paidAt: 0
  };
  const state = readPayState();
  state.orders[orderNo] = order;
  writePayState(state);
  try {
    const r = await channel.createOrder(cfg, order, req);
    return sendJson(res, 200, { orderNo: orderNo, payUrl: r.payUrl });
  } catch (err) {
    state.orders[orderNo].status = 'failed';
    writePayState(state);
    return sendJson(res, err.status || 502, { error: { message: err.message } });
  }
}

/* POST /api/pay/notify：虎皮椒异步通知（form-urlencoded），验签后落盘并回 success */
async function handlePayNotify(req, res) {
  const raw = await readBody(req);
  const ct = String(req.headers['content-type'] || '');
  let params;
  if (ct.indexOf('json') !== -1) {
    try { params = JSON.parse(raw.toString('utf8') || '{}'); } catch (_) { params = {}; }
  } else {
    params = querystring.parse(raw.toString('utf8'));
  }
  const cfg = readDotJson(PAY_CONFIG_FILE) || {};
  const verified = payChannels.xunhupay.verifyNotify(cfg, params);
  if (!verified || !verified.orderNo) {
    return res.end('fail');
  }
  const state = readPayState();
  const order = state.orders[verified.orderNo];
  if (order) {
    order.status = 'paid';
    order.tradeNo = verified.tradeNo;
    order.paidAt = Date.now();
    writePayState(state);
  }
  /* 按虎皮椒规范返回 success 表示已接收 */
  return res.end('success');
}

/* GET /api/pay/claim?orderNo=xxx：用户支付回跳后领取入账凭证 */
function handlePayClaim(req, res, url) {
  const orderNo = String(url.searchParams.get('orderNo') || '');
  const cfg = readDotJson(PAY_CONFIG_FILE) || {};
  const paySecret = cfg.paySecret || '';
  if (!paySecret) { return sendJson(res, 501, { error: { message: '支付未配置' } }); }
  const state = readPayState();
  const order = state.orders[orderNo];
  if (!order || order.status !== 'paid') {
    return sendJson(res, 404, { error: { code: 'ORDER_NOT_PAID', message: '订单尚未确认到账，请稍后再试' } });
  }
  const ts = Math.floor(Date.now() / 1000);
  const sig = md5(orderNo + '|' + order.userId + '|' + order.credits + '|' + ts + '|' + paySecret);
  return sendJson(res, 200, {
    orderNo: orderNo, userId: order.userId, credits: order.credits, ts: ts, sig: sig
  });
}

/* GET /api/pay/pending：管理员拉取已支付订单（header x-access-key） */
function handlePayPending(req, res) {
  const cfg = readDotJson(PAY_CONFIG_FILE) || {};
  if (!cfg.accessKey || !safeEqual(req.headers['x-access-key'], cfg.accessKey)) {
    return sendJson(res, 401, { error: { message: '无权访问' } });
  }
  const state = readPayState();
  const list = Object.values(state.orders)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
  return sendJson(res, 200, { orders: list });
}

/* GET /api/pay/config：公开的通道可用性（前端据此决定展示支付按钮还是兑换引导） */
function handlePayConfig(res) {
  const cfg = readDotJson(PAY_CONFIG_FILE) || {};
  return sendJson(res, 200, {
    channels: {
      xunhupay: payChannels.xunhupay.enabled(cfg)
    }
  });
}

/* POST /api/admin/sync-key {providerId, apiKey}（header x-access-key）：后台保存 Key 后同步到服务器 */
async function handleAdminSyncKey(req, res) {
  const cfg = readDotJson(PAY_CONFIG_FILE) || {};
  if (!cfg.accessKey || !safeEqual(req.headers['x-access-key'], cfg.accessKey)) {
    return sendJson(res, 401, { error: { message: '无权访问' } });
  }
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch (err) {
    return sendJson(res, 400, { error: { message: '请求解析失败' } });
  }
  if (!body.providerId || !body.apiKey) {
    return sendJson(res, 400, { error: { message: '缺少 providerId 或 apiKey' } });
  }
  const aiCfg = readDotJson(AI_CONFIG_FILE) || { providerKeys: {} };
  if (!aiCfg.providerKeys) { aiCfg.providerKeys = {}; }
  aiCfg.providerKeys[body.providerId] = String(body.apiKey);
  const tmp = AI_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(aiCfg, null, 2));
  fs.renameSync(tmp, AI_CONFIG_FILE);
  try { fs.chmodSync(AI_CONFIG_FILE, 0o600); } catch (_) {}
  return sendJson(res, 200, { ok: true });
}

/* ---------- 拼豆大师：沙箱环境诊断（只读） ---------- */

/* 拼豆大师服务器本地配置（.pixelart-config.json）：accUserId（生图服务 WB ID）、
   pythonExe（拼豆链路用的解释器，路径不存在时回落 python3——本机指向 venv，沙箱系统 python3 自带依赖）、
   promptLLM（写槽位的视觉 chat 模型，null=模板兜底） */
const PIXELART_CONFIG_FILE = path.join(ROOT, '.pixelart-config.json');
const PERLER_DIR = path.join(ROOT, 'apps/pixelart/assert/valorant-perler-src/valorant-perler');

/* 拼豆生成引擎（双后端并存，2026-10-28）：
   - 主实例（/ 与 /apps/pixelart/）：apinebula 生图后端
   - 经典实例（/pixelart）：val-perler.qq.com 经典后端，独立任务目录 .pixelart-tasks-vp */
const pixelartGen = require('./apps/pixelart/generate');
/* 任务结束 → 生成单结算（成功扣费定格 / 失败自动退款）。
 * 放在这里而不是引擎里：引擎不知道钱怎么算，也不该知道。 */
const onPixelartTaskFinish = (taskId, status, orderId) => {
  if (!orderId) { return null; }   /* 重转等不扣费的任务没有单号 */
  return settleTaskOrder(orderId, status);
};
const pixelartMain = pixelartGen.createEngine({ backend: 'apinebula', onTaskFinish: onPixelartTaskFinish });
const pixelartVp = pixelartGen.createEngine({
  backend: 'valperler',
  taskRoot: path.join(ROOT, '.pixelart-tasks-vp'),
  archiveRoot: path.join(ROOT, '.pixelart-archive-vp'),
  onTaskFinish: onPixelartTaskFinish
});

function pixelartPython() {
  const cfg = readDotJson(PIXELART_CONFIG_FILE) || {};
  const wanted = (cfg.pythonExe || '').trim();
  if (wanted) {
    try { fs.accessSync(wanted, fs.constants.X_OK); return wanted; } catch (_) {}
  }
  return 'python3';
}

/* GET /api/pixelart/env-check：探测能否跑拼豆 Python 链。
   variant 'apinebula'（默认）：健康探测 apinebula /models（带 Bearer），深检校验 API Key；
   variant 'valperler'（/pixelart 经典版）：健康探测 val-perler.qq.com /health，深检校验 WB ID。
   传 ?chain=1 时额外真实执行一次 render --check-id（验证 python 侧连通性）。 */
function handlePixelartEnvCheck(res, deep, variant) {
  const { execFile } = require('child_process');
  const isVp = variant === 'valperler';
  const out = { python: null, pip: null, imports: {}, valPerler: null, imageApi: null, wbId: null, home: os.homedir(), backend: isVp ? 'valperler' : 'apinebula' };

  /* WB ID 来源：.pixelart-config.json → env → ~/.workbuddy/user-*-personal */
  function maskId(id) { return id ? id.slice(0, 4) + '…' + id.slice(-4) : null; }
  const pxcfg = readDotJson(PIXELART_CONFIG_FILE) || {};
  let wbId = (pxcfg.accUserId || '').trim() || (process.env.ACC_USER_ID || '').trim() || null;
  let wbIdSource = pxcfg.accUserId ? 'config' : (process.env.ACC_USER_ID ? 'env' : null);
  if (!wbId) {
    try {
      const wbDir = path.join(os.homedir(), '.workbuddy');
      const hit = fs.readdirSync(wbDir).find((n) => /^user-[0-9a-f-]{36}-personal$/i.test(n));
      if (hit) { wbId = hit.slice(5, 41); wbIdSource = 'home-dir'; }
    } catch (_) {}
  }
  out.wbId = maskId(wbId);
  out.wbIdSource = wbIdSource || 'none';

  const probe = [
    'import json,sys,shutil',
    "info={'exe':sys.executable,'ver':sys.version.split()[0],'pip':bool(shutil.which('pip3') or shutil.which('pip'))}",
    'mods={}',
    "for m in ['PIL','numpy','cv2','skimage','sklearn','requests']:",
    '    try:',
    '        __import__(m); mods[m]=True',
    '    except Exception:',
    '        mods[m]=False',
    "info['imports']=mods",
    "print(json.dumps(info))",
  ].join('\n');
  const pyExe = pixelartPython();
  out.pythonExe = pyExe;
  const py = execFile(pyExe, ['-c', probe], { timeout: 15000 }, (err, stdout) => {
    if (err) {
      out.python = { ok: false, error: String(err.message || err).slice(0, 200) };
    } else {
      try {
        const info = JSON.parse(stdout);
        out.python = { ok: true, exe: info.exe, version: info.ver };
        out.pip = info.pip;
        out.imports = info.imports;
      } catch (e2) {
        out.python = { ok: false, error: '解析失败: ' + String(stdout).slice(0, 120) };
      }
    }
    /* 生图后端健康（Node 侧 fetch，不依赖 python）。
       out.valPerler 保留为旧字段别名（历史上无人消费，仅为日志连续性）。 */
    const finish = () => sendJson(res, 200, out);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const pLLM = pxcfg.promptLLM || {};
    const pxKeys = (readDotJson(AI_CONFIG_FILE) || {}).providerKeys || {};
    const imgKey = (pLLM.providerId && pxKeys[pLLM.providerId]) || pLLM.apiKey || '';
    const imgBase = String(pLLM.baseUrl || 'https://apinebula.ai/v1').replace(/\/+$/, '');
    const healthUrl = isVp ? 'https://val-perler.qq.com/health' : (imgBase + '/models');
    const healthHeaders = (!isVp && imgKey) ? { Authorization: 'Bearer ' + imgKey } : {};
    out.imageApi = isVp
      ? { base: 'https://val-perler.qq.com', backend: 'valperler' }
      : { base: imgBase, model: pxcfg.imageModel || pLLM.imageModel || 'gpt-image-2.5', hasKey: !!imgKey };
    fetch(healthUrl, { signal: ctrl.signal, headers: healthHeaders })
      .then((r) => {
        out.imageApi.ok = r.ok; out.imageApi.status = r.status;
        out.valPerler = { ok: r.ok, status: r.status };
      })
      .catch((e3) => {
        out.imageApi.ok = false; out.imageApi.error = String(e3.message || e3).slice(0, 120);
        out.valPerler = { ok: false, error: out.imageApi.error };
      })
      .finally(() => {
        clearTimeout(timer);
        /* 深度自检：真实执行 render --check-id（python 侧连通性全链路）。
           经典版校验 WB ID（注入 ACC_USER_ID + 选 vp 客户端）；主版校验 API Key。 */
        if (!deep) { return finish(); }
        const deepEnv = Object.assign({}, process.env);
        if (isVp) {
          deepEnv.PERLER_IMAGE_SCRIPT = 'image_render_vp.py';
          if (wbId) { deepEnv.ACC_USER_ID = wbId; }
        } else {
          if (imgKey) { deepEnv.PERLER_IMAGE_API_KEY = imgKey; }
          if (pLLM.baseUrl) { deepEnv.PERLER_IMAGE_BASE_URL = pLLM.baseUrl; }
        }
        execFile(pyExe, ['val_perler.py', 'render', '--check-id'], {
          cwd: path.join(PERLER_DIR, 'scripts'),
          timeout: 30000,
          env: deepEnv
        }, (err2, stdout2, stderr2) => {
          out.chain = err2
            ? { ok: false, error: String(stderr2 || err2.message).slice(-300) }
            : { ok: true, output: String(stdout2).slice(-300) };
          finish();
        });
      });
  });
  if (!py) { return sendJson(res, 500, { error: { message: '无法启动探测进程' } }); }
}

/* 根级「只给服务器看」的文件名（小写比较），不经 HTTP 下发 */
const SERVER_ONLY_FILES = ['server.js', 'package.json', 'package-lock.json', 'architecture.md', 'readme.md', 'orders.js'];

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') { pathname = '/index.html'; }
  /* 目录穿越与隐藏文件防护 */
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  if (safePath.split('/').some((seg) => seg.startsWith('.'))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  /* assert 目录存放产品源码/资产备份，不经 HTTP 下发 */
  if (safePath.split('/').includes('assert')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  /* 服务端文件不下发：server.js 源码暴露全部路由与反代逻辑，deploy/ 里的脚本含服务器
     IP、部署路径与密钥文件名，package.json / 架构文档同理。只放行前端资产。 */
  const firstSeg = ((safePath.split('/').filter(Boolean)[0]) || '').toLowerCase();
  if (firstSeg === 'deploy' || firstSeg === 'server' || SERVER_ONLY_FILES.includes(firstSeg)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  const filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('403 Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    let fp = filePath;
    if (!err && stat.isDirectory()) {
      /* 目录请求 → 该目录下的 index.html（如 /apps/avatar/） */
      fp = path.join(filePath, 'index.html');
      try { stat = fs.statSync(fp); } catch (_) { stat = null; }
    }
    if (err || !stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(fp).pipe(res);
  });
}

/* ---------- 云服务同源反代：/.cloud/* → WorkBuddy 云 ----------
 * 为什么需要：云 API 对跨域预检（OPTIONS）返回 403（实测），浏览器跨域调
 * 登录/钱包/数据库会被 CORS 拦死。改为本站同源反代后浏览器认为同源，
 * 不触发预检，前端登录/积分/云历史代码零改动。
 * 已验证：云端不校验 Host（改 Host 仍 200），凭据走 x-wb-webapp-access-key。
 */
const CLOUD_UPSTREAM = process.env.CLOUD_UPSTREAM || 'https://ai-avatar-studio-50356.app.workbuddy.host';
const CLOUD_ORIGIN = new URL(CLOUD_UPSTREAM).origin;
const CLOUD_PUBLISHABLE_KEY = 'wbpk_eoMql05K7PT2JgZUKFFOo9_9vLkFanCYcm67RRrIgxoEnsGnDS52YEM';

/* ---------- 服务端计费：用调用者自己的 JWT 调云端钱包 RPC ----------
 * 为什么必须放在服务端：/api/ai 是唯一消耗服务商 Key 的出口，前端扣费可被绕过
 * （2026-10-30 事故：会话过期 → 云端自动降级为匿名会话 → 扣费打在共享 anon 账本上，
 *  界面照样显示「已登录 -2」，生成照跑）。改为「先扣后放行 + 失败退款」。
 */
function cloudRpc(token, fn, params) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(params || {}), 'utf8');
    const u = new URL('/.cloud/database/rest/rpc/' + fn, CLOUD_UPSTREAM);
    const req = https.request({
      protocol: 'https:',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        Authorization: 'Bearer ' + token,
        'x-wb-webapp-access-key': CLOUD_PUBLISHABLE_KEY,
        Origin: CLOUD_ORIGIN,
        Referer: CLOUD_ORIGIN + '/'
      },
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
        resolve({ status: res.statusCode || 0, data: data, text: text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('wallet rpc timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function rpcErrorText(r) {
  if (!r) { return ''; }
  const d = r.data;
  if (d && typeof d === 'object') {
    return String(d.message || (d.error && d.error.message) || d.hint || '');
  }
  return String(r.text || '');
}

/* 匿名（无 JWT）调云函数：用于跨用户的运维聚合 order_health()。
 * 云端用「accessKey 门」而不是 auth.uid()，因为巡检时没有登录用户。
 * 只读、只返回计数，不含任何用户标识。 */
function cloudRpcAnon(fn, params) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(params || {}), 'utf8');
    const u = new URL('/.cloud/database/rest/rpc/' + fn, CLOUD_UPSTREAM);
    const req = https.request({
      protocol: 'https:',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'x-wb-webapp-access-key': CLOUD_PUBLISHABLE_KEY,
        Origin: CLOUD_ORIGIN,
        Referer: CLOUD_ORIGIN + '/'
      },
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
        resolve({ status: res.statusCode || 0, data: data, text: text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('health rpc timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ---------- 拼豆生成：生成单 + 任务结算 ----------
 * 提交期失败（参数错 / 落盘失败，引擎还回 4xx-5xx）→ 包装层直接 fail 退款；
 * 任务期失败 / 超时 → 引擎回调 onTaskFinish 结算。两条路都不依赖前端还在页面上，
 * 这正是「已扣费没拿到图」的第二个窗口（用户关页后失败没人退）。 */
const taskOrderCtx = new Map();   /* orderId → { token, tracked, txnId, at } */

function pruneOrderCtx() {
  const now = Date.now();
  for (const [id, ctx] of taskOrderCtx) {
    if (now - ctx.at > 2 * 60 * 60 * 1000) { taskOrderCtx.delete(id); }
  }
}

async function settleTaskOrder(orderId, status) {
  const ctx = taskOrderCtx.get(orderId);
  if (!ctx) {
    /* 服务重启后内存里没有这单：状态照常报给前端，钱由 order_reap 补退 */
    return { refunded: false, known: false };
  }
  taskOrderCtx.delete(orderId);
  if (status === 'done') {
    await orderService.succeed(orderId, ctx.token, '');
    return { refunded: false, known: true };
  }
  const r = await orderService.fail(orderId, ctx.token, 'task_failed', ctx.txnId, ctx.tracked);
  return { refunded: !!(r && r.refunded), known: true };
}

/* 拼豆生成接口的强制计费包装：先建单扣 1 分，再放行引擎。
 * 响应头带 X-Order-Id（前端凭它查询/续接），余额同步回写顶部积分 chip。 */
async function handlePixelartGenerate(req, res, engine) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!bearer) {
    return sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '生成需要登录，请先登录后再试' } });
  }
  const token = bearer[1];
  const order = await orderService.create({
    token: token,
    product: 'pixelart',
    meta: { backend: engine.backend }
  });
  if (order.error) {
    return sendJson(res, order.error.status, { error: { code: order.error.code, message: order.error.message } });
  }

  pruneOrderCtx();
  taskOrderCtx.set(order.orderId, {
    token: token, tracked: order.tracked, txnId: order.txnId, at: Date.now()
  });
  /* 引擎把单号记到任务上，任务结束（成功/失败/超时）回调本服务结算 */
  req.orderId = order.orderId;

  let statusCode = 200;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (code, headers) {
    statusCode = code;
    if (code === 200) {
      headers = Object.assign({}, headers || {}, {
        'X-Order-Id': order.orderId,
        'X-Wallet-Txn-Id': order.txnId,
        'X-Wallet-Balance': order.balance == null ? '' : String(order.balance)
      });
    }
    return origWriteHead(code, headers);
  };
  try {
    await engine.handleGenerate(req, res, sendJson);
  } catch (err) {
    if (!res.headersSent) {
      return sendJson(res, 500, { error: { message: String((err && err.message) || err).slice(0, 160) } });
    }
    throw err; /* 头已发出，只能让连接以错误收场 */
  } finally {
    if (statusCode >= 400) {
      taskOrderCtx.delete(order.orderId);
      await orderService.fail(order.orderId, token, 'submit_' + statusCode, order.txnId, order.tracked);
    }
  }
}

/* 登录后的补退：把本人被遗弃的 pending 单结掉（关页 / 崩溃 / 记账丢失都会留单）。
 * 前端在登录态建立后调用，非关键路径，失败静默。 */
async function handleOrderSettle(req, res) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!bearer) {
    return sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '需要登录' } });
  }
  const r = await orderService.reap(bearer[1]);
  return sendJson(res, 200, {
    refunded: r.refunded || 0,
    balance: r.balance == null ? null : r.balance
  });
}

/* 单据查询（前端排查 / 断线续接用） */
async function handleOrderGet(req, res, fullUrl) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!bearer) {
    return sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '需要登录' } });
  }
  const id = String(fullUrl.searchParams.get('id') || '');
  if (!id) { return sendJson(res, 400, { error: { message: '缺少单据号' } }); }
  const row = await orderService.get(id, bearer[1]);
  if (!row) { return sendJson(res, 404, { error: { message: '单据不存在' } }); }
  return sendJson(res, 200, { order: row });
}

/* GET /api/admin/orders/health?hours=24（header x-access-key）：生成单运维快照
 * 为什么用 accessKey 而不是登录态：巡检看的是跨用户聚合，服务端没有管理员 JWT。
 * 云端 order_health() 内部再比一次 app_secrets.accessKey（密钥换了对不上就 P0001）。 */
async function handleOrderHealth(req, res, fullUrl) {
  const cfg = readDotJson(PAY_CONFIG_FILE) || {};
  if (!cfg.accessKey || !safeEqual(req.headers['x-access-key'], cfg.accessKey)) {
    return sendJson(res, 401, { error: { message: '无权访问' } });
  }
  const raw = parseInt(fullUrl.searchParams.get('hours'), 10);
  const hours = Math.max(1, Math.min(720, isFinite(raw) ? raw : 24));
  const r = await orderService.health({ key: cfg.accessKey, hours: hours });
  if (r.error) {
    return sendJson(res, 502, { error: { message: '云端巡检接口不可用：' + r.error } });
  }
  return sendJson(res, 200, { snapshot: r.snapshot, summary: r.summary });
}

function proxyCloud(req, res) {
  let target;
  try {
    target = new URL(req.url, CLOUD_UPSTREAM);
  } catch (_) {
    return sendJson(res, 400, { error: { message: '非法路径' } });
  }
  if (target.protocol !== 'https:') {
    return sendJson(res, 400, { error: { message: '仅允许 https 上游' } });
  }
  const headers = Object.assign({}, req.headers);
  headers.host = target.host;
  /* 云端按 Origin 白名单校验 client（publishableKey 绑定托管域名），
     本站源会被拒（the request origin is not allowed for this client）。
     反代改写为云站源：浏览器侧是同源请求，不校验 CORS 响应头，改写安全。 */
  if (headers.origin) { headers.origin = CLOUD_ORIGIN; }
  if (headers.referer) { headers.referer = CLOUD_ORIGIN + '/'; }
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers.upgrade;
  delete headers['accept-encoding'];

  const up = https.request({
    protocol: 'https:',
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: req.method,
    headers: headers,
    timeout: 60000
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('cloud upstream timeout')));
  up.on('error', (e) => {
    if (!res.headersSent) { sendJson(res, 502, { error: { message: 'cloud upstream error: ' + e.message } }); }
    else { try { res.end(); } catch (_) {} }
  });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  const pathOnly = req.url ? req.url.split('?')[0] : '';
  const fullUrl = new URL(req.url || '/', 'http://localhost');

  /* 云服务（登录 / 钱包 / 数据库 / 存储）同源反代 */
  if (pathOnly === '/.cloud' || pathOnly.indexOf('/.cloud/') === 0) {
    return proxyCloud(req, res);
  }

  if (req.method === 'GET' && (pathOnly === '/' || pathOnly === '/index.html')) {
    /* 站点根 → 拼豆大师（dotbeads.com 根目录即拼豆首页）。
       内部重写而非 302：地址栏保持 /，拼豆页资产均为绝对路径（/apps/pixelart/*、/shared/*）不受影响。
       头像制作大师仍在 /apps/avatar/。 */
    req.url = '/apps/pixelart/index.html' + (fullUrl.search || '');
    return serveStatic(req, res);
  }
  if (req.method === 'GET' && (pathOnly === '/my' || pathOnly === '/my/')) {
    /* 我的作品（平台层共享页）：作品 + 积分明细，跨产品统一入口 */
    req.url = '/shared/my.html' + (fullUrl.search || '');
    return serveStatic(req, res);
  }
  if (req.method === 'GET' && (pathOnly === '/pixelart' || pathOnly === '/pixelart/')) {
    /* 拼豆大师·经典版（/pixelart）：与主页完全同一套页面与功能，唯一差异是生图后端
       （val-perler.qq.com 经典模型）。页面复用 apps/pixelart/index.html，在此注入
       API base，让 app.js 全部请求打到 /api/pixelart-vp/*（第二引擎实例）。 */
    let html;
    try { html = fs.readFileSync(path.join(ROOT, 'apps/pixelart/index.html'), 'utf8'); } catch (_) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('pixelart page missing');
    }
    const inject = '<script>window.PIXELART_API_BASE="/api/pixelart-vp";</script>';
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html;
    const body = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }
  if (pathOnly === '/api/ai') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return handleAi(req, res);
  }
  if (pathOnly === '/api/pay/order') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return handlePayOrder(req, res);
  }
  if (pathOnly === '/api/pay/notify') {
    if (req.method !== 'POST') { return res.end('fail'); }
    return handlePayNotify(req, res);
  }
  if (pathOnly === '/api/pay/claim') {
    return handlePayClaim(req, res, fullUrl);
  }
  if (pathOnly === '/api/pay/pending') {
    return handlePayPending(req, res);
  }
  if (pathOnly === '/api/pay/config') {
    return handlePayConfig(res);
  }
  if (pathOnly === '/api/admin/sync-key') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return handleAdminSyncKey(req, res);
  }
  if (pathOnly === '/api/orders/settle') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return handleOrderSettle(req, res);
  }
  if (pathOnly === '/api/admin/orders/health') {
    return handleOrderHealth(req, res, fullUrl);
  }
  if (pathOnly === '/api/orders/get') {
    return handleOrderGet(req, res, fullUrl);
  }
  if (pathOnly === '/api/pixelart/env-check') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return handlePixelartEnvCheck(res, fullUrl.searchParams.get('chain') === '1');
  }
  if (pathOnly === '/api/pixelart/generate') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return handlePixelartGenerate(req, res, pixelartMain);
  }
  if (pathOnly === '/api/pixelart/regen') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return pixelartMain.handleRegen(req, res, sendJson);
  }
  if (pathOnly === '/api/pixelart/task') {
    return pixelartMain.handleTaskStatus(req, res, fullUrl, sendJson);
  }
  if (pathOnly === '/api/pixelart/task/stream') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return pixelartMain.handleTaskStream(req, res, fullUrl);
  }
  if (pathOnly === '/api/pixelart/task/html') {
    return pixelartMain.handleTaskHtml(req, res, fullUrl, sendJson);
  }
  if (pathOnly === '/api/pixelart/task/cover') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return pixelartMain.handleTaskCover(req, res, fullUrl);
  }
  if (pathOnly === '/api/pixelart/task/meta') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return pixelartMain.handleTaskMeta(req, res, fullUrl, sendJson);
  }
  if (pathOnly === '/api/pixelart/styles') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return pixelartMain.handleStyles(res, sendJson);
  }
  /* ---- 经典版（val-perler 后端）：/pixelart 页面的 API，与主版一一对应、互不共享任务 ---- */
  if (pathOnly === '/api/pixelart-vp/env-check') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return handlePixelartEnvCheck(res, fullUrl.searchParams.get('chain') === '1', 'valperler');
  }
  if (pathOnly === '/api/pixelart-vp/generate') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return handlePixelartGenerate(req, res, pixelartVp);
  }
  if (pathOnly === '/api/pixelart-vp/regen') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return pixelartVp.handleRegen(req, res, sendJson);
  }
  if (pathOnly === '/api/pixelart-vp/task') {
    return pixelartVp.handleTaskStatus(req, res, fullUrl, sendJson);
  }
  if (pathOnly === '/api/pixelart-vp/task/stream') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return pixelartVp.handleTaskStream(req, res, fullUrl);
  }
  if (pathOnly === '/api/pixelart-vp/task/html') {
    return pixelartVp.handleTaskHtml(req, res, fullUrl, sendJson);
  }
  if (pathOnly === '/api/pixelart-vp/task/cover') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return pixelartVp.handleTaskCover(req, res, fullUrl);
  }
  if (pathOnly === '/api/pixelart-vp/task/meta') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return pixelartVp.handleTaskMeta(req, res, fullUrl, sendJson);
  }
  if (pathOnly === '/api/pixelart-vp/styles') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return pixelartVp.handleStyles(res, sendJson);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end('405 Method Not Allowed');
  }
  serveStatic(req, res);
});

/* ---------- 生成单巡检（默认每 30 分钟） ----------
 * 为什么要「服务端自己算 + 落盘」而不是只做接口：
 * 1. pending 卡住是静默故障——用户不再登录，order_reap 就永远等不到它，
 *    所以需要一个不依赖任何人上线来看的定时器；
 * 2. 快照落到 .health/latest.json，定时巡检（automation）ssh 上来 cat 即可出简报，
 *    不必把 accessKey 写进任何脚本或提示词；
 * 3. 超阈值同时打 [health] WARN 到 journalctl，服务器自己也有据可查。
 * .health 是隐藏目录，静态服务本就 403，不会被下发。
 */
const HEALTH_DIR = path.join(ROOT, '.health');
const HEALTH_FILE = path.join(HEALTH_DIR, 'latest.json');
const HEALTH_HISTORY = path.join(HEALTH_DIR, 'history.log');
const HEALTH_INTERVAL_MS = (parseFloat(process.env.ORDER_HEALTH_INTERVAL_MIN) || 30) * 60 * 1000;
const HEALTH_FIRST_DELAY_MS = (process.env.ORDER_HEALTH_FIRST_DELAY_SEC == null
  ? 90
  : parseFloat(process.env.ORDER_HEALTH_FIRST_DELAY_SEC) || 0) * 1000;

function writeHealthSnapshot(obj) {
  try {
    fs.mkdirSync(HEALTH_DIR, { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(obj, null, 2));
    fs.appendFileSync(HEALTH_HISTORY, JSON.stringify(obj) + '\n');
    /* 历史只留最近 500 条，避免无限增长（30 分钟一条 ≈ 10 天） */
    const lines = fs.readFileSync(HEALTH_HISTORY, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 800) { fs.writeFileSync(HEALTH_HISTORY, lines.slice(-500).join('\n') + '\n'); }
  } catch (e) {
    console.warn('[health] 快照落盘失败：' + ((e && e.message) || e));
  }
}

async function runOrderHealth() {
  const cfg = readDotJson(PAY_CONFIG_FILE) || {};
  if (!cfg.accessKey) { return; }
  const at = new Date().toISOString();
  const r = await orderService.health({ key: cfg.accessKey, hours: 24 });
  if (r.error) {
    console.warn('[health] 巡检失败：' + r.error);
    writeHealthSnapshot({ at: at, ok: false, error: String(r.error) });
    return;
  }
  writeHealthSnapshot(Object.assign({ at: at, ok: true }, r.snapshot || {}, { summary: r.summary }));
  if (r.summary && r.summary.level === 'warn') {
    console.warn('[health] WARN ' + r.summary.warnings.join('；') + ' | ' + r.summary.text);
  }
}

function startOrderHealth() {
  const tick = () => {
    runOrderHealth().catch((e) => console.warn('[health] 异常：' + ((e && e.message) || e)));
  };
  const first = setTimeout(tick, HEALTH_FIRST_DELAY_MS);
  const timer = setInterval(tick, HEALTH_INTERVAL_MS);
  if (first.unref) { first.unref(); }
  if (timer.unref) { timer.unref(); }
  return { first: first, timer: timer };
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('AI Avatar Studio server listening on port ' + PORT);
  startOrderHealth();
});
