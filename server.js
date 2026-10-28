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

/* POST /api/ai { providerId, baseUrl, model, path, prompt, imageBase64? }
 * Key 按 providerId 从服务器本地 .ai-config.json 解析；响应为 SSE 心跳流。 */
async function handleAi(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch (err) {
    return sendJson(res, 400, { error: { message: (err && err.message) || '请求解析失败' } });
  }

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

  /* SSE 心跳流：边等上游边每 2 秒写心跳，最后一行 data: 携带真实结果 */
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  });
  const startedAt = Date.now();
  res.write(': start\n\n');

  const beat = setInterval(() => {
    if (res.writableEnded) { clearInterval(beat); return; }
    try { res.write(': wait ' + Math.round((Date.now() - startedAt) / 1000) + '\n\n'); } catch (_) {}
  }, BEAT_INTERVAL);

  let out;
  try {
    const r = await callUpstream(arg);
    out = { statusCode: r.statusCode, data: r.data };
  } catch (err) {
    out = { statusCode: err.status || 502, data: { error: { message: err.message } } };
  }

  clearInterval(beat);
  if (!res.writableEnded) {
    try { res.end('data: ' + JSON.stringify(out) + '\n\n'); } catch (_) {}
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

function pixelartPython() {
  const cfg = readDotJson(PIXELART_CONFIG_FILE) || {};
  const wanted = (cfg.pythonExe || '').trim();
  if (wanted) {
    try { fs.accessSync(wanted, fs.constants.X_OK); return wanted; } catch (_) {}
  }
  return 'python3';
}

/* GET /api/pixelart/env-check：探测沙箱能否跑拼豆 Python 链。
   返回 python3 版本/路径、关键依赖导入结果、pip 可用性、生图后端（apinebula）健康、WB ID（脱敏，已废弃）。
   传 ?chain=1 时额外真实执行一次 render --check-id（验证 python 侧连通性与 API Key 鉴权）。 */
function handlePixelartEnvCheck(res, deep) {
  const { execFile } = require('child_process');
  const out = { python: null, pip: null, imports: {}, valPerler: null, imageApi: null, wbId: null, home: os.homedir() };

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
    /* 生图后端健康（2026-10-28 起为 apinebula OpenAI Images 兼容；Node 侧 fetch，不依赖 python）。
       out.valPerler 保留为旧字段别名（历史上无人消费，仅为日志连续性）。 */
    const finish = () => sendJson(res, 200, out);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const pLLM = pxcfg.promptLLM || {};
    const pxKeys = (readDotJson(AI_CONFIG_FILE) || {}).providerKeys || {};
    const imgKey = (pLLM.providerId && pxKeys[pLLM.providerId]) || pLLM.apiKey || '';
    const imgBase = String(pLLM.baseUrl || 'https://apinebula.ai/v1').replace(/\/+$/, '');
    out.imageApi = { base: imgBase, model: pxcfg.imageModel || pLLM.imageModel || 'gpt-image-2.5', hasKey: !!imgKey };
    const healthHeaders = imgKey ? { Authorization: 'Bearer ' + imgKey } : {};
    fetch(imgBase + '/models', { signal: ctrl.signal, headers: healthHeaders })
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
        /* 深度自检：真实执行 render --check-id（python 侧连通性 + API Key 鉴权全链路） */
        if (!deep) { return finish(); }
        execFile(pyExe, ['val_perler.py', 'render', '--check-id'], {
          cwd: path.join(PERLER_DIR, 'scripts'),
          timeout: 30000,
          env: Object.assign({}, process.env,
            imgKey ? { PERLER_IMAGE_API_KEY: imgKey } : {},
            pLLM.baseUrl ? { PERLER_IMAGE_BASE_URL: pLLM.baseUrl } : {})
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
  if (pathOnly === '/api/pixelart/env-check') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return handlePixelartEnvCheck(res, fullUrl.searchParams.get('chain') === '1');
  }
  if (pathOnly === '/api/pixelart/generate') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return require('./apps/pixelart/generate').handleGenerate(req, res, sendJson);
  }
  if (pathOnly === '/api/pixelart/regen') {
    if (req.method !== 'POST') { return sendJson(res, 405, { error: { message: '仅支持 POST' } }); }
    return require('./apps/pixelart/generate').handleRegen(req, res, sendJson);
  }
  if (pathOnly === '/api/pixelart/task') {
    return require('./apps/pixelart/generate').handleTaskStatus(req, res, fullUrl, sendJson);
  }
  if (pathOnly === '/api/pixelart/task/stream') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return require('./apps/pixelart/generate').handleTaskStream(req, res, fullUrl);
  }
  if (pathOnly === '/api/pixelart/task/html') {
    return require('./apps/pixelart/generate').handleTaskHtml(req, res, fullUrl, sendJson);
  }
  if (pathOnly === '/api/pixelart/styles') {
    if (req.method !== 'GET') { return sendJson(res, 405, { error: { message: '仅支持 GET' } }); }
    return require('./apps/pixelart/generate').handleStyles(res, sendJson);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end('405 Method Not Allowed');
  }
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('AI Avatar Studio server listening on port ' + PORT);
});
