'use strict';
/**
 * 邮件发送（验证码）
 * ---------------------------------------------------------------
 * 三条通道，按配置自动选择：
 *   dev    没配置任何通道时：验证码写进 DATA_DIR/outbox/*.json 并打日志。
 *          ——只用于开发/自测，生产必须配真实通道，否则用户收不到码。
 *   smtp   隐式 TLS（465，QQ/163/企业邮都支持）。零依赖手写，避免部署时还要
 *          npm install —— 本站的发布流程是「git archive 解压即跑」。
 *   resend HTTP API（api.resend.com）。腾讯云轻量默认封 25 端口出站，
 *          HTTP 通道不受影响，作为云主机上的首选。
 *
 * 配置来源优先级：.mail-config.json（服务器上 chmod 600）> 环境变量。
 */

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');

const ROOT = path.join(__dirname, '..');

let cfgCache = null;

function loadConfig() {
  if (cfgCache) { return cfgCache; }
  let file = {};
  for (const p of [path.join(ROOT, '.mail-config.json'), path.join(process.env.DATA_DIR || '', '.mail-config.json')]) {
    try {
      if (p && fs.existsSync(p)) { file = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
    } catch (_) {}
  }
  const pick = (k) => (file[k] != null ? file[k] : process.env[k]);
  const cfg = {
    provider: String(pick('MAIL_PROVIDER') || (file.host ? 'smtp' : (file.resendApiKey ? 'resend' : 'dev'))).toLowerCase(),
    host: pick('MAIL_HOST') || file.host || '',
    port: Number(pick('MAIL_PORT') || file.port || 465),
    user: pick('MAIL_USER') || file.user || '',
    pass: pick('MAIL_PASS') || file.pass || '',
    from: pick('MAIL_FROM') || file.from || '',
    fromName: pick('MAIL_FROM_NAME') || file.fromName || '点豆 DotBeads',
    resendApiKey: pick('RESEND_API_KEY') || file.resendApiKey || ''
  };
  if (cfg.provider === 'auto') {
    cfg.provider = cfg.resendApiKey ? 'resend' : (cfg.host ? 'smtp' : 'dev');
  }
  cfgCache = cfg;
  return cfg;
}

function providerName() {
  const c = loadConfig();
  if (c.provider === 'smtp' && !(c.host && c.user && c.pass)) { return 'dev'; }
  if (c.provider === 'resend' && !c.resendApiKey) { return 'dev'; }
  return c.provider;
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

/* 极简 MIME：纯文本 + HTML 双段，UTF-8，base64 编码正文 */
function buildMessage(cfg, to, subject, text, html) {
  const from = cfg.fromName ? '"' + cfg.fromName + '" <' + cfg.from + '>' : cfg.from;
  const boundary = 'wb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const head = [
    'From: ' + from,
    'To: ' + to,
    'Subject: =?UTF-8?B?' + b64(subject) + '?=',
    'MIME-Version: 1.0',
    'Date: ' + new Date().toUTCString(),
    'Content-Type: multipart/alternative; boundary="' + boundary + '"'
  ].join('\r\n');
  const body = [
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html || ('<p>' + text.replace(/\n/g, '<br>') + '</p>')),
    '--' + boundary + '--',
    ''
  ].join('\r\n');
  return head + '\r\n' + body;
}

/* --- SMTP（隐式 TLS 465） --- */
function smtpSend(cfg, to, subject, text, html) {
  return new Promise((resolve, reject) => {
    const msg = buildMessage(cfg, to, subject, text, html);
    const socket = tls.connect({ host: cfg.host, port: cfg.port || 465, servername: cfg.host }, () => {});
    let buf = '';
    let step = 0;
    let done = false;
    const fail = (e) => { if (done) { return; } done = true; try { socket.destroy(); } catch (_) {} reject(e); };
    socket.setTimeout(20000, () => fail(new Error('smtp timeout')));

    const commands = [
      'EHLO dotbeads.local',
      'AUTH LOGIN',
      b64(cfg.user),
      b64(cfg.pass),
      'MAIL FROM:<' + cfg.from + '>',
      'RCPT TO:<' + to + '>',
      'DATA'
    ];

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      /* 一行可能分多个 chunk 到达：攒到 \r\n 再判断 */
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const code = parseInt(line.slice(0, 3), 10);
        if (!/^\d{3}/.test(line)) { continue; }
        /* 多行响应（如 EHLO 的 250-xxx）继续等 */
        if (line.charAt(3) === '-') { continue; }
        if (code >= 400) { return fail(new Error('smtp ' + code + ' ' + line.slice(4))); }
        if (step === 0) {                 /* 220 问候 → EHLO */
          step = 1; socket.write(commands[0] + '\r\n');
        } else if (step === 1) {          /* 250 EHLO → AUTH */
          step = 2; socket.write(commands[1] + '\r\n');
        } else if (step === 2) {          /* 334 用户名 */
          step = 3; socket.write(commands[2] + '\r\n');
        } else if (step === 3) {          /* 334 密码（或直接 235） */
          if (code === 235) { step = 5; socket.write(commands[4] + '\r\n'); }
          else { step = 4; socket.write(commands[3] + '\r\n'); }
        } else if (step === 4) {          /* 235 认证通过 → MAIL FROM */
          step = 5; socket.write(commands[4] + '\r\n');
        } else if (step === 5) {          /* 250 → RCPT */
          step = 6; socket.write(commands[5] + '\r\n');
        } else if (step === 6) {          /* 250 → DATA */
          step = 7; socket.write(commands[6] + '\r\n');
        } else if (step === 7) {          /* 354 → 正文 + . */
          step = 8; socket.write(msg.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
        } else if (step === 8) {          /* 250 queued */
          step = 9; socket.write('QUIT\r\n');
        } else if (step === 9) {
          done = true; socket.end(); resolve({ ok: true, provider: 'smtp' });
        }
      }
    });
    socket.on('error', (e) => fail(e));
  });
}

/* --- Resend HTTP --- */
function resendSend(cfg, to, subject, text, html) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: cfg.fromName ? cfg.fromName + ' <' + cfg.from + '>' : cfg.from,
      to: [to],
      subject: subject,
      text: text,
      html: html || ('<p>' + text.replace(/\n/g, '<br>') + '</p>')
    });
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: 'Bearer ' + cfg.resendApiKey
      },
      timeout: 15000
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { return resolve({ ok: true, provider: 'resend' }); }
        reject(new Error('resend ' + res.statusCode + ' ' + body.slice(0, 200)));
      });
    });
    req.on('timeout', () => req.destroy(new Error('resend timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* --- dev：落盘 + 打日志 --- */
function devSend(to, subject, text) {
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '.data'), 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.json');
  fs.writeFileSync(file, JSON.stringify({ to: to, subject: subject, text: text, at: new Date().toISOString() }, null, 2));
  console.log('[mail:dev] to=' + to + ' subject=' + subject + '\n' + text + '\n[mail:dev] 已写入 ' + file);
  return Promise.resolve({ ok: true, provider: 'dev', file: file });
}

function send(to, subject, text, html) {
  const cfg = loadConfig();
  const p = providerName();
  if (p === 'smtp') { return smtpSend(cfg, to, subject, text, html); }
  if (p === 'resend') { return resendSend(cfg, to, subject, text, html); }
  return devSend(to, subject, text);
}

module.exports = { send, providerName, loadConfig };
