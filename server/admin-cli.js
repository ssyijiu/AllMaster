#!/usr/bin/env node
'use strict';
/**
 * 运营命令行（自建服务）
 * ---------------------------------------------------------------
 * 云端后台（admin.html）还在改造中，先用这个把运营刚需兜住：
 * 发兑换码、人工充值、看订单与巡检。全部直接读写本机 SQLite，不需要登录。
 *
 * 用法（在服务器上）：
 *   node server/admin-cli.js code 10 20            # 生成 20 个 10 积分的兑换码（默认 30 天有效）
 *   node server/admin-cli.js code 10 5 b --days 0  # 生成永久码；--days N 指定有效期天数
 *   node server/admin-cli.js code 10 20 launch --new-only --per-user 1  # 拉新批次：仅新用户、每人 1 张
 *   node server/admin-cli.js codes [状态]           # 列出兑换码（unused/used/expired/all，默认 unused）
 *   node server/admin-cli.js invite 10 50 小红书    # 生成拉新邀请链接（?batch=，服务端自动发码）
 *   node server/admin-cli.js invites               # 列出邀请批次与已领/剩余
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
    '  node server/admin-cli.js invite <积分> <名额> [渠道名] [--days N] [--per-user N] [--any-user] [--origin URL]',
    '  node server/admin-cli.js invites',
    '  node server/admin-cli.js grant <邮箱> <积分> [备注]',
    '  node server/admin-cli.js orders [小时]',
    '  node server/admin-cli.js health',
    '  node server/admin-cli.js users',
    '  node server/admin-cli.js balance <邮箱>',
    '  node server/admin-cli.js config [show|check]',
    '  node server/admin-cli.js config import <config.json>',
    '  node server/admin-cli.js channel [vp|self]',
    '',
    '数据目录：' + dbmod.DATA_DIR,
    '库文件：' + dbmod.DB_FILE
  ].join('\n'));
}

function cmdCode() {
  /* 用法：code <积分> [数量] [批次] [--days N] [--per-user N] [--new-only]
     --days 0 = 永久（默认 30 天）；--per-user 0 = 不限（默认 1）；--new-only 仅限新用户 */
  const flags = {};
  const rest = [];
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--new-only') { flags.newOnly = true; continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name === '--days' || name === '--per-user') {
      const raw = eq > 0 ? a.slice(eq + 1) : args[++i];
      flags[name === '--days' ? 'days' : 'perUser'] = Number(raw);
      continue;
    }
    rest.push(a);
  }
  const credits = Number(rest[0]);
  const count = Math.max(1, Math.min(Number(rest[1]) || 1, 500));
  const batch = rest[2] || 'cli-' + new Date().toISOString().slice(0, 10);
  const days = flags.days === undefined ? 30 : Math.floor(flags.days);
  const perUser = flags.perUser === undefined ? 1 : Math.floor(flags.perUser);
  const newOnly = !!flags.newOnly;
  if (Number.isNaN(days) || days < 0 || days > 3650) { throw new Error('有效期应为 0（永久）或 1~3650 天'); }
  if (Number.isNaN(perUser) || perUser < 0 || perUser > 100) { throw new Error('每人限领应为 0（不限）或 1~100'); }
  if (!credits || credits <= 0) { throw new Error('积分必须是正整数'); }
  const now = dbmod.nowMs();
  const expiresAt = days > 0 ? now + days * 24 * 3600 * 1000 : null;
  const d = dbmod.db;
  const codes = [];
  const stmt = d.prepare('INSERT INTO redeem_codes (code, credits, batch, created_at, expires_at, new_user_only, per_user_limit) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < count; i++) {
    let code;
    for (let t = 0; t < 8; t++) {
      code = randomCode(10);
      if (!d.prepare('SELECT 1 FROM redeem_codes WHERE code = ?').get(code)) { break; }
      code = null;
    }
    if (!code) { throw new Error('生成唯一码失败，请重试'); }
    stmt.run(code, credits, batch, now, expiresAt, newOnly ? 1 : 0, perUser);
    codes.push(code);
  }
  const ruleText = (newOnly ? '仅限新用户' : '不限新老') + '，每人每批' + (perUser > 0 ? '限领 ' + perUser + ' 张' : '不限');
  console.log('批次 ' + batch + '，每码 ' + credits + ' 积分，共 ' + codes.length + ' 个，有效期 ' + (days > 0 ? days + ' 天（至 ' + fmtTime(expiresAt) + '）' : '永久') + '；规则：' + ruleText + '\n');
  codes.forEach((c) => console.log('  ' + c));
  console.log('\n（兑换入口：站点首页钱包弹窗 → 兑换码）');
}

/* 邀请链接（批次自动发码）：一条链接发给所有人，服务端给每个点开的人分一张码。
   用法：invite <积分> <名额> [渠道名] [--days N] [--per-user N] [--any-user] [--origin URL] [--landing PATH]
   默认：仅新用户、每人 1 张、30 天有效、落地 /pixelart——拉新的默认口径。 */
function cmdInvite() {
  const flags = {};
  const rest = [];
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--any-user') { flags.anyUser = true; continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name === '--days' || name === '--per-user' || name === '--origin' || name === '--landing') {
      const raw = eq > 0 ? a.slice(eq + 1) : args[++i];
      flags[name.slice(2)] = name === '--origin' || name === '--landing' ? raw : Number(raw);
      continue;
    }
    rest.push(a);
  }
  const credits = Number(rest[0]);
  const quota = Math.max(1, Math.min(Number(rest[1]) || 1, 2000));
  const label = rest[2] || '';
  const days = flags.days === undefined ? 30 : Math.floor(flags.days);
  const perUser = flags['per-user'] === undefined ? 1 : Math.floor(flags['per-user']);
  const newOnly = !flags.anyUser;
  const origin = String(flags.origin || process.env.PUBLIC_ORIGIN || 'https://dotbeads.online').replace(/\/+$/, '');
  const landing = flags.landing || '/pixelart';
  if (!credits || credits <= 0) { throw new Error('积分必须是正整数'); }
  if (Number.isNaN(days) || days < 0 || days > 3650) { throw new Error('有效期应为 0（永久）或 1~3650 天'); }
  if (Number.isNaN(perUser) || perUser < 0 || perUser > 100) { throw new Error('每人限领应为 0（不限）或 1~100'); }

  const now = dbmod.nowMs();
  const expiresAt = days > 0 ? now + days * 24 * 3600 * 1000 : null;
  const out = dbmod.tx((d) => {
    let batch = '';
    for (let t = 0; t < 6; t++) {
      const candidate = 'IV' + randomCode(8);
      if (!d.prepare('SELECT 1 FROM redeem_batches WHERE batch = ?').get(candidate)) { batch = candidate; break; }
    }
    if (!batch) { throw new Error('批次号生成失败，请重试'); }
    d.prepare(
      'INSERT INTO redeem_batches (batch, label, landing, credits, quota, new_user_only, per_user_limit, expires_at, active, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
    ).run(batch, label, landing, credits, quota, newOnly ? 1 : 0, perUser, expiresAt, now);
    const stmt = d.prepare('INSERT INTO redeem_codes (code, credits, batch, created_at, expires_at, new_user_only, per_user_limit) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < quota; i++) {
      let code = '';
      for (let t = 0; t < 8; t++) {
        const candidate = randomCode(10);
        if (!d.prepare('SELECT 1 FROM redeem_codes WHERE code = ?').get(candidate)) { code = candidate; break; }
      }
      if (!code) { throw new Error('生成唯一码失败，请重试'); }
      stmt.run(code, credits, batch, now, expiresAt, newOnly ? 1 : 0, perUser);
    }
    return batch;
  });
  const sep = landing.indexOf('?') === -1 ? '?' : '&';
  console.log('邀请链接已生成：');
  console.log('\n  ' + origin + landing + sep + 'batch=' + out + '\n');
  console.log('渠道 ' + (label || '(未命名)') + '，每份 ' + credits + ' 积分，名额 ' + quota + ' 个，' +
    (days > 0 ? days + ' 天有效（至 ' + fmtTime(expiresAt) + '）' : '永久有效') + '；规则：' +
    (newOnly ? '仅限新用户' : '不限新老') + '，每人' + (perUser > 0 ? '最多 ' + perUser + ' 张' : '不限'));
  console.log('（这条链接可以群发/印物料；每个点开的人各自领一张，领完即止）');
}

function cmdInvites() {
  const rows = dbmod.db.prepare(
    'SELECT b.batch, b.label, b.credits, b.quota, b.new_user_only, b.per_user_limit, b.expires_at, b.active, b.created_at, ' +
    '  (SELECT COUNT(*) FROM redeem_codes c WHERE c.batch = b.batch AND c.used_by IS NOT NULL) AS used, ' +
    '  (SELECT COUNT(*) FROM redeem_codes c WHERE c.batch = b.batch) AS issued ' +
    'FROM redeem_batches b WHERE b.batch <> \'WELCOME\' ORDER BY b.created_at DESC LIMIT 100'
  ).all();
  if (!rows.length) { return console.log('还没有邀请链接'); }
  const now = dbmod.nowMs();
  console.log('邀请批次（最多 100 条）：');
  rows.forEach((r) => {
    const st = !Number(r.active) ? '已停用'
      : (r.expires_at && r.expires_at < now ? '已过期'
        : (r.issued - r.used <= 0 ? '已领完' : '发放中'));
    const rule = (Number(r.new_user_only) === 1 ? '仅新用户' : '不限新老') +
      (Number(r.per_user_limit) > 0 ? '·每人' + r.per_user_limit + '张' : '·不限量');
    console.log('  ' + r.batch + '  ' + (r.label || '-') + '  ' + r.credits + ' 积分  ' +
      r.used + '/' + r.issued + ' 已领  [' + rule + ']  ' + st);
  });
}

function cmdCodes() {
  const status = argv[1] || 'unused'; /* unused | used | expired | all */
  const now = dbmod.nowMs();
  let where = "WHERE (batch IS NULL OR batch <> 'WELCOME')";
  const args = [];
  if (status === 'unused') { where += ' AND used_by IS NULL AND (expires_at IS NULL OR expires_at >= ?)'; args.push(now); }
  else if (status === 'used') { where += ' AND used_by IS NOT NULL'; }
  else if (status === 'expired') { where += ' AND used_by IS NULL AND expires_at IS NOT NULL AND expires_at < ?'; args.push(now); }
  else if (status !== 'all') { throw new Error('状态只支持 unused / used / expired / all'); }
  const rows = dbmod.db.prepare(
    'SELECT code, credits, batch, created_at, expires_at, used_by, used_at, new_user_only, per_user_limit FROM redeem_codes ' +
    where + ' ORDER BY created_at DESC LIMIT 200'
  ).all(...args);
  if (!rows.length) { return console.log('没有符合条件的兑换码'); }
  console.log('兑换码（' + status + '，最多显示 200 条）：');
  rows.forEach((r) => {
    const st = r.used_by ? '已用 ' + fmtTime(r.used_at) + ' ' + r.used_by
      : (r.expires_at && r.expires_at < now ? '已过期'
        : (r.expires_at ? '未用，' + fmtTime(r.expires_at) + ' 前有效' : '未用，永久'));
    const rule = (Number(r.new_user_only) === 1 ? '仅新用户' : '不限新老') +
      (Number(r.per_user_limit) > 0 ? '·每人' + r.per_user_limit + '张' : '·不限量');
    console.log('  ' + r.code + '  ' + r.credits + ' 积分  批次 ' + (r.batch || '-') + '  [' + rule + ']  ' + st);
  });
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

/* 生图通道：不带参数看状态，带 vp/self 手动切换。
   自动切换只往自研走，**回切永远由人决定**（和后台「生图通道」按钮同一动作）。 */
function cmdChannel() {
  const channel = require('./channel');
  const target = argv[1];
  if (target === 'vp' || target === 'self') {
    const r = channel.setActive(target, { reason: '命令行手动切换', by: 'cli' });
    console.log(r.changed ? '已切换到 ' + channel.LABEL[target] : '本来就是 ' + channel.LABEL[target] + '，未改动');
  } else if (target && target !== 'status') {
    return console.log('用法：node server/admin-cli.js channel [vp|self]');
  }
  const s = channel.summary(15);
  console.log('\n生图通道');
  console.log('  当前：' + s.activeLabel + '（' + s.base + '）');
  if (s.since) { console.log('  切换时间：' + fmtTime(s.since) + '  操作者：' + (s.by || '-')); }
  if (s.reason) { console.log('  原因：' + s.reason); }
  console.log('  自动切换规则：连续 ' + s.rule.needHits + ' 单 ' + s.rule.codes.join('/')
    + '，窗口 ' + s.rule.windowMin + ' 分钟，期间零成功');
  console.log('\n最近事件：');
  if (!s.events.length) { console.log('  （无）'); }
  s.events.forEach((e) => console.log('  ' + fmtTime(e.ts) + '  ' + (e.channel === 'vp' ? '腾讯' : '自研')
    + '  ' + (e.ok ? '成功' : '失败') + (e.error_code ? '  ' + e.error_code : '')
    + (e.quota_pool ? '/' + e.quota_pool : '') + (e.order_id ? '  ' + e.order_id : '')));
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
  else if (cmd === 'invite') { cmdInvite(); }
  else if (cmd === 'invites') { cmdInvites(); }
  else if (cmd === 'grant') { cmdGrant(); }
  else if (cmd === 'orders') { cmdOrders(); }
  else if (cmd === 'health') { cmdHealth(); }
  else if (cmd === 'users') { cmdUsers(); }
  else if (cmd === 'balance') { cmdBalance(); }
  else if (cmd === 'config') { cmdConfig(); }
  else if (cmd === 'channel') { cmdChannel(); }
  else { help(); }
} catch (e) {
  console.error('错误：' + ((e && e.message) || e));
  process.exitCode = 1;
}
