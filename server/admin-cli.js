#!/usr/bin/env node
'use strict';
/**
 * 运营命令行（自建服务）
 * ---------------------------------------------------------------
 * 云端后台（admin.html）还在改造中，先用这个把运营刚需兜住：
 * 发兑换码、人工充值、看订单与巡检。全部直接读写本机 SQLite，不需要登录。
 *
 * 用法（在服务器上）：
 *   node server/admin-cli.js code 10 20            # 生成 20 个 10 积分的兑换码
 *   node server/admin-cli.js codes                 # 列出未使用的码
 *   node server/admin-cli.js grant a@b.com 5 备注   # 给某邮箱充值 5 积分
 *   node server/admin-cli.js orders 24             # 最近 24 小时的生成单
 *   node server/admin-cli.js health                # 生成单巡检摘要
 *   node server/admin-cli.js users                 # 用户数 / 余额分布
 *   node server/admin-cli.js balance a@b.com       # 查某人余额与流水
 */

const crypto = require('crypto');
const dbmod = require('./db');
const wallet = require('./wallet');
const auth = require('./auth');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

function fmtTime(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   /* 去掉易混的 I/O/0/1 */

function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) { out += ALPHABET[crypto.randomInt(0, ALPHABET.length)]; }
  return out;
}

function help() {
  console.log([
    '运营命令行（直接读写本机数据库）',
    '',
    '  node server/admin-cli.js code <积分> [数量] [批次]',
    '  node server/admin-cli.js codes',
    '  node server/admin-cli.js grant <邮箱> <积分> [备注]',
    '  node server/admin-cli.js orders [小时]',
    '  node server/admin-cli.js health',
    '  node server/admin-cli.js users',
    '  node server/admin-cli.js balance <邮箱>',
    '  node server/admin-cli.js config [show|check]',
    '  node server/admin-cli.js config import <config.json>',
    '',
    '数据目录：' + dbmod.DATA_DIR,
    '库文件：' + dbmod.DB_FILE
  ].join('\n'));
}

function cmdCode() {
  const credits = Number(argv[1]);
  const count = Math.max(1, Math.min(Number(argv[2]) || 1, 500));
  const batch = argv[3] || 'cli-' + new Date().toISOString().slice(0, 10);
  if (!credits || credits <= 0) { throw new Error('积分必须是正整数'); }
  const d = dbmod.db;
  const codes = [];
  const stmt = d.prepare('INSERT INTO redeem_codes (code, credits, batch, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < count; i++) {
    let code;
    for (let t = 0; t < 8; t++) {
      code = randomCode(10);
      if (!d.prepare('SELECT 1 FROM redeem_codes WHERE code = ?').get(code)) { break; }
      code = null;
    }
    if (!code) { throw new Error('生成唯一码失败，请重试'); }
    stmt.run(code, credits, batch, dbmod.nowMs());
    codes.push(code);
  }
  console.log('批次 ' + batch + '，每码 ' + credits + ' 积分，共 ' + codes.length + ' 个：\n');
  codes.forEach((c) => console.log('  ' + c));
  console.log('\n（兑换入口：站点首页钱包弹窗 → 兑换码）');
}

function cmdCodes() {
  const rows = dbmod.db.prepare(
    'SELECT code, credits, batch, created_at FROM redeem_codes WHERE used_by IS NULL ORDER BY created_at DESC LIMIT 200'
  ).all();
  if (!rows.length) { return console.log('没有未使用的兑换码'); }
  console.log('未使用兑换码 ' + rows.length + ' 个：');
  rows.forEach((r) => console.log('  ' + r.code + '  ' + r.credits + ' 积分  ' + (r.batch || '-') + '  ' + fmtTime(r.created_at)));
}

function cmdGrant() {
  const email = auth.normalizeEmail(argv[1]);
  const credits = Number(argv[2]);
  const memo = argv[3] || '人工充值';
  if (!auth.isValidEmail(email)) { throw new Error('邮箱格式不对'); }
  if (!credits) { throw new Error('积分不能为 0'); }
  const user = auth.findUserByEmail(email);
  if (!user) { throw new Error('没有这个用户：' + email); }
  const r = wallet.grant(user.id, credits, 'cli-' + Date.now().toString(36), memo);
  console.log('已给 ' + email + ' 充值 ' + credits + ' 积分，当前余额 ' + r.balance);
}

function cmdOrders() {
  const hours = Math.max(1, Number(argv[1]) || 24);
  const cut = dbmod.nowMs() - hours * 3600 * 1000;
  const rows = dbmod.db.prepare(
    'SELECT o.id, o.product, o.status, o.credits, o.fail_reason, o.created_at, u.email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.created_at > ? ORDER BY o.created_at DESC LIMIT 100'
  ).all(cut);
  if (!rows.length) { return console.log('最近 ' + hours + ' 小时没有生成单'); }
  console.log('最近 ' + hours + ' 小时生成单 ' + rows.length + ' 条：');
  rows.forEach((r) => console.log('  ' + fmtTime(r.created_at) + '  ' + r.status.padEnd(9) + ' ' + r.product.padEnd(8) + ' ' + String(r.credits) + '分  ' + (r.email || r.id) + (r.fail_reason ? '  ← ' + r.fail_reason : '')));
}

function cmdHealth() {
  const d = dbmod.db;
  const now = dbmod.nowMs();
  const pending = d.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ?').get('pending').c;
  const stale = d.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ? AND created_at < ?').get('pending', now - 30 * 60000).c;
  const succ = d.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ? AND updated_at > ?').get('succeeded', now - 24 * 3600 * 1000).c;
  const fail = d.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ? AND updated_at > ?').get('failed', now - 24 * 3600 * 1000).c;
  const reasons = d.prepare('SELECT fail_reason, COUNT(*) AS c FROM orders WHERE status = ? AND updated_at > ? GROUP BY fail_reason ORDER BY c DESC').all('failed', now - 24 * 3600 * 1000);
  const sample = succ + fail;
  console.log('生成单巡检');
  console.log('  pending 总计 ' + pending + '（超 30 分钟 ' + stale + '）');
  console.log('  近 24h 成功 ' + succ + ' / 失败 ' + fail + (sample ? '（失败率 ' + Math.round(fail / sample * 100) + '%）' : ''));
  if (reasons.length) {
    console.log('  失败原因：');
    reasons.forEach((r) => console.log('    ' + (r.fail_reason || '(空)') + ' × ' + r.c));
  }
  if (stale > 0) { console.log('\n⚠ 有超窗未结算的单，用户下次登录会自动补退；也可手动 node server/admin-cli.js orders 查看'); }
}

function cmdUsers() {
  const d = dbmod.db;
  const users = d.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const withBalance = d.prepare(
    'SELECT COUNT(*) AS c FROM (SELECT user_id, SUM(credits) AS b FROM wallet_txns GROUP BY user_id HAVING b > 0)'
  ).get().c;
  const paidTotal = d.prepare('SELECT COALESCE(SUM(credits), 0) AS c FROM wallet_txns WHERE kind = ?').get('pay').c;
  const consumed = d.prepare('SELECT COALESCE(SUM(-credits), 0) AS c FROM wallet_txns WHERE kind = ?').get('consume').c;
  console.log('用户 ' + users + ' 人，其中 ' + withBalance + ' 人有正余额');
  console.log('累计支付入账 ' + paidTotal + ' 积分，累计消费 ' + consumed + ' 积分');
  console.log('文件占用 ' + (require('./storage').totalBytes() / 1048576).toFixed(1) + ' MB');
}

function cmdBalance() {
  const email = auth.normalizeEmail(argv[1]);
  const user = auth.findUserByEmail(email);
  if (!user) { throw new Error('没有这个用户：' + email); }
  console.log(email + ' 当前余额 ' + wallet.balance(user.id) + ' 积分\n');
  wallet.listTxns(user.id, 20).forEach((t) => {
    console.log('  ' + fmtTime(Date.parse(t.created_at)) + '  ' + String(t.credits).padStart(4) + '  ' + t.kind + (t.memo ? '  ' + t.memo : ''));
  });
}

/* 前台配置（app_config.default）：风格 + 服务商。admin.html 还是云端版本不可用，
   所以在自建后台改造完成前，配置走这里。data 里不含密钥（密钥在 .ai-config.json）。 */
function readConfig() {
  const row = dbmod.db.prepare('SELECT id, data, updated_at FROM app_config WHERE id = ?').get('default');
  if (!row) { return null; }
  let data = null;
  try { data = JSON.parse(row.data); } catch (_) { data = null; }
  return { id: row.id, data: data, updatedAt: row.updated_at, raw: row.data };
}

function cmdConfig() {
  const sub = argv[1] || 'show';
  const cfg = readConfig();

  if (sub === 'import') {
    const file = argv[2];
    if (!file) { throw new Error('用法：config import <config.json>'); }
    const fs = require('fs');
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      throw new Error('读不了这个 JSON：' + ((e && e.message) || e));
    }
    if (!Array.isArray(data.providers)) { throw new Error('缺少 providers 数组'); }
    if (!Array.isArray(data.styles)) { throw new Error('缺少 styles 数组'); }
    for (const p of data.providers) {
      if (!p || !p.id) { throw new Error('providers 里有一项没有 id'); }
      if (!p.baseUrl || !p.model) { console.warn('  提醒：服务商 ' + p.id + ' 缺少 baseUrl 或 model，生成会失败'); }
    }
    for (const s of data.styles) {
      if (!s || !s.id || !s.name) { throw new Error('styles 里有一项缺少 id 或 name'); }
    }
    const now = Date.now();
    dbmod.db.prepare('INSERT INTO app_config (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run('default', JSON.stringify(data), now);
    console.log('已写入配置：' + data.providers.length + ' 个服务商，' + data.styles.length + ' 个风格');
    cmdConfigCheck(data);
    return;
  }

  if (sub === 'check') {
    if (!cfg || !cfg.data) {
      console.log('app_config 是空的 —— 前台账本读不到配置，会退回内置兜底风格，且生成必然失败（没有服务商）。');
      console.log('用 config import <config.json> 导入，或先看 config show 确认现状。');
      return;
    }
    cmdConfigCheck(cfg.data);
    return;
  }

  /* show */
  if (!cfg || !cfg.data) {
    console.log('app_config.default 不存在（前台走内置兜底：' + '仅 grokbot 一个风格，但没有服务商 → 生成会失败）');
    return;
  }
  console.log('更新时间：' + fmtTime(cfg.updatedAt) + '\n');
  console.log(JSON.stringify(cfg.data, null, 2));
}

/* 交叉校验：风格绑定的服务商是否存在、是否配全、密钥有没有 */
function cmdConfigCheck(data) {
  const aiCfg = (() => {
    try { return JSON.parse(require('fs').readFileSync(require('path').join(dbmod.ROOT, '.ai-config.json'), 'utf8')); }
    catch (_) { return null; }
  })();
  const keys = (aiCfg && aiCfg.providerKeys) || {};
  const providers = Array.isArray(data.providers) ? data.providers : [];
  const styles = Array.isArray(data.styles) ? data.styles : [];
  const byId = {};
  for (const p of providers) { byId[p.id] = p; }

  console.log('服务商 ' + providers.length + ' 个：');
  for (const p of providers) {
    const gap = [];
    if (!p.baseUrl) { gap.push('缺 baseUrl'); }
    if (!p.model) { gap.push('缺 model'); }
    if (!keys[p.id]) { gap.push('缺密钥'); }
    console.log('  ' + (gap.length ? '✗' : '✓') + ' ' + p.id + '  ' + (p.baseUrl || '-') + '  ' + (p.model || '-') +
      (gap.length ? '  ← ' + gap.join(' / ') : ''));
  }

  console.log('\n风格 ' + styles.length + ' 个：');
  for (const s of styles) {
    const p = byId[s.providerId];
    let note = '';
    if (!s.providerId) { note = '← 没绑服务商，点了会提示配置缺失'; }
    else if (!p) { note = '← 服务商 ' + s.providerId + ' 不存在'; }
    else if (!p.baseUrl || !p.model) { note = '← 服务商配置不全'; }
    else if (!keys[s.providerId]) { note = '← 服务商没有密钥'; }
    console.log('  ' + (note ? '✗' : '✓') + ' ' + s.id + '  ' + s.name + (note ? '  ' + note : ''));
  }

  const orphan = Object.keys(keys).filter((k) => !byId[k]);
  if (orphan.length) {
    console.log('\n有密钥但没有服务商条目：' + orphan.join(', ') + '（这些 Key 用不上）');
  }
}

try {
  if (cmd === 'code') { cmdCode(); }
  else if (cmd === 'codes') { cmdCodes(); }
  else if (cmd === 'grant') { cmdGrant(); }
  else if (cmd === 'orders') { cmdOrders(); }
  else if (cmd === 'health') { cmdHealth(); }
  else if (cmd === 'users') { cmdUsers(); }
  else if (cmd === 'balance') { cmdBalance(); }
  else if (cmd === 'config') { cmdConfig(); }
  else { help(); }
} catch (e) {
  console.error('错误：' + ((e && e.message) || e));
  process.exitCode = 1;
}
