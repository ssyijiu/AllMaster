#!/usr/bin/env node
/* 最近生成（recent strip）jsdom 测试
 * 覆盖：restore 过滤 72h 过期项 / 渲染条数与 hidden / 点击回看 openTaskHtml /
 *       addRecent 入栈与 6 条上限 / persistRecent 写 localStorage / 非法数据容错
 * 运行：NODE_PATH=<node_modules> node /tmp/pixelart-recent-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = require('path').resolve(__dirname, '..', '..', '..');
const html = fs.readFileSync(path.join(REPO, 'apps/pixelart/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'apps/pixelart/app.js'), 'utf8');

const results = [];
function check(name, ok) { results.push([name, !!ok]); }

const dom = new JSDOM(html, {
  url: 'http://localhost/apps/pixelart/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const w = dom.window;

/* 平台层桩：app.js 顶层就调用 Platform.setup */
const authStub = {
  applySession: function () {},
  bindAuthEvents: function () {},
  loadPayChannels: function () {},
  renderAuthUI: function () {},
  walletService: { consume: function () { return Promise.resolve({}); }, refund: function () {} }
};
let setupOpts = null;
w.Platform = { setup: function (opts) { setupOpts = opts; return authStub; }, cloud: { getClient: function () { return null; } } };
w.__pixelartApiBase = undefined;

/* window.open 桩：记录调用 */
const opened = [];
w.open = function (url) { opened.push(url); };
w.fetch = function () { return Promise.reject(new Error('offline-test')); };

w.eval(appSrc);
const px = w.__pixelart;
const doc = w.document;

/* ---------- 用例 1：启动后 recent 为空 → 区块隐藏 ---------- */
check('启动后 recentWrap 隐藏', doc.getElementById('recentWrap').hidden === true);

/* ---------- 用例 2：restore 过滤过期与脏数据 ---------- */
const now = Date.now();
const seeded = [
  { id: 'a1b2c3d4e5f60718', thumb: 'data:image/jpeg;base64,AAAA', style: 'Q版', time: now - 60 * 60 * 1000 },
  { id: 'b2c3d4e5f6071819', thumb: 'data:image/jpeg;base64,BBBB', style: '还原', time: now - 73 * 60 * 60 * 1000 }, /* 过期 */
  { id: 'no-thumb', thumb: null, style: '', time: now },          /* 无缩略图 */
  null,
  { style: '', time: now }                                        /* 无 id */
];
w.localStorage.setItem('pixelart-recent-v1', JSON.stringify(seeded));
px.restoreRecent();
check('过期/脏数据被过滤，仅剩 1 条', doc.getElementById('recentStrip').children.length === 1);
check('有记录时 recentWrap 可见', doc.getElementById('recentWrap').hidden === false);

/* ---------- 用例 3：点击条目 → 打开对应图纸页 ---------- */
const btn = doc.getElementById('recentStrip').children[0];
btn.click();
check('点击回看打开 /task/html?id=a1b2...', opened.length === 1 &&
  opened[0].indexOf('id=a1b2c3d4e5f60718') > 0);

/* ---------- 用例 4：addRecent 入栈 + 6 条上限 ----------
 * jsdom 无 canvas，makeThumb 回落 null：内存条目保留（thumb 异步补），
 * 用 6 个不同 id 依次触发，验证 unshift + 截断逻辑 */
for (let i = 0; i < 8; i++) {
  px.store.imgDataUrl = 'data:image/png;base64,iVBORw0KGgo='; /* 伪图，makeThumb 失败不影响 */
  px.store.styleId = 'chibi';
  px.store.styles = [{ id: 'chibi', label: 'Q版', scope: 'character' }];
  px.addRecent('task' + i + '2345678abc');
}
check('addRecent 上限 6 条（内存）', px.store.recent.length === 6);
check('最新任务在最前', px.store.recent[0].id === 'task72345678abc');

/* ---------- 用例 5：persistRecent 只落有效缩略图 ----------
 * makeThumb 异步未回填时 thumb=null，持久化应为空数组而非抛错 */
w.localStorage.removeItem('pixelart-recent-v1');
px.renderRecent();
const stored = JSON.parse(w.localStorage.getItem('pixelart-recent-v1') || '[]');
check('无缩略图条目不落盘（数组存在且为空）', Array.isArray(stored) && stored.length === 0);

/* ---------- 用例 6：带缩略图条目完整落盘 + 渲染 ---------- */
px.store.recent = [{ id: 'c3d4e5f607181920', thumb: 'data:image/jpeg;base64,CCCC', style: '官方同款', time: now }];
px.renderRecent();
px.persistRecent();
const stored2 = JSON.parse(w.localStorage.getItem('pixelart-recent-v1'));
check('带缩略图条目写入 localStorage', stored2.length === 1 && stored2[0].id === 'c3d4e5f607181920');
check('渲染出 1 个缩略图按钮', doc.getElementById('recentStrip').children.length === 1);
check('按钮 title 含点击回看提示', doc.getElementById('recentStrip').children[0]
  .getAttribute('title').indexOf('点击回看') > 0);

/* ---------- 用例 7：localStorage 脏数据（非 JSON）不崩 ---------- */
w.localStorage.setItem('pixelart-recent-v1', '{not json');
px.restoreRecent();
check('非 JSON 存档被容错清空', doc.getElementById('recentWrap').hidden === true);

/* ---------- 汇总 ---------- */
let fail = 0;
for (const [name, ok] of results) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) { fail++; }
}
console.log(fail === 0 ? 'ALL ' + results.length + ' PASS' : fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
