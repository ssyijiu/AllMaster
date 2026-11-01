#!/usr/bin/env node
/* 发布前给静态资源打「内容哈希」版本戳（由 deploy/push.sh 调用）
 *
 * 背景：server.js 对带 ?v= 的静态资源下发 `Cache-Control: public, max-age=31536000, immutable`
 * （见 server.js serveStatic）。也就是同一个 URL 一年内不会回源。所以「文件内容变了但 ?v= 没变」
 * 会让回访用户一直跑旧 JS —— 2026-11-01 就因此出过事故：脱云改造改了 pixelart app.js 与
 * local-cloud.js 却没升版本号，旧 app.js 找已改名的 loginPhone 抛 null，bindUpload() 从未执行，
 * 表现就是「图片点击和拖拽上传全都没反应」。
 *
 * 现在改成发布时自动按文件内容算 v：内容不变 → v 不变（缓存继续命中）；内容一变 → v 自动变。
 * 手写版本号从此只是「本地开发时的占位」，线上以本脚本结果为准。
 *
 * 用法：node deploy/stamp-assets.js <发布快照目录>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.argv[2];
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error('用法: node deploy/stamp-assets.js <发布快照目录>');
  process.exit(2);
}

/* 不进静态下发的目录：deploy 与 server 由 serveStatic 直接 403，没必要扫 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'deploy', 'server', 'assert']);

const htmls = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) { continue; }
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(abs); continue; }
    if (/\.html?$/i.test(ent.name)) { htmls.push(abs); }
  }
})(ROOT);

const hashCache = new Map();
function contentHash(abs) {
  if (!hashCache.has(abs)) {
    hashCache.set(abs, crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 8));
  }
  return hashCache.get(abs);
}

/* 只处理 <script src> / <link href> 里的本地绝对路径，且必须已有 ?v= 才改写 */
const REF_RE = /(["'])(\/[^"'\s]+?\.(?:js|css))\?v=([^"'\s]*)\1/g;

let touched = 0;
let refs = 0;
const warned = [];

for (const html of htmls) {
  const src = fs.readFileSync(html, 'utf8');
  const out = src.replace(REF_RE, (whole, quote, urlPath) => {
    const abs = path.join(ROOT, urlPath.replace(/^\//, ''));
    if (!fs.existsSync(abs)) {
      warned.push(urlPath + '  (在 ' + path.relative(ROOT, html) + ' 里引用，但快照中没有这个文件)');
      return whole;
    }
    refs++;
    return quote + urlPath + '?v=' + contentHash(abs) + quote;
  });
  if (out !== src) {
    fs.writeFileSync(html, out);
    touched++;
  }
}

console.log('    资源版本戳：' + touched + ' 个 HTML / ' + refs + ' 处引用按内容哈希重写' + (warned.length ? '（' + warned.length + ' 处跳过）' : ''));
warned.forEach((w) => console.warn('      ! ' + w));
