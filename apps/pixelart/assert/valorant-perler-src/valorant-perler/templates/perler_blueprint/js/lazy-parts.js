/* =====================================================================
 * [LAZY-PARTS] 大块数据的按需取
 * 图纸里只内联「翻开就要用」的数据：逐格票数、色板、色数档位、原图 / 转换图。
 * 只有自定义规格才用得上的搜索场（逐像素细簇标签 1MB + 评估参照图 0.6MB）由服务端按任务号单独给：
 * 玩家点「生成」时取一次，之后浏览器按 URL 长缓存（内容对任务号固定，一年有效）。
 * 本地保存出来的单文件里什么都有，走不到这里；老图纸没有 lazyParts 标记，数据本来就在里面。
 * ===================================================================== */
const PART_CACHE = {};
const PART_LOADING = {};

function bpPartWanted(key) {
  return Array.isArray(D.lazyParts) && D.lazyParts.indexOf(key) !== -1;
}
function bpPartUrl(key) {
  const base = (window.PIXELART_API_BASE || '').replace(/\/+$/, '');
  const id = (window.PIXELART_TASK_ID || '').trim();
  if (!base || !id) { return ''; }
  return `${base}/task/part?id=${encodeURIComponent(id)}&k=${encodeURIComponent(key)}`;
}

/* 取一块数据；同一个 key 并发只发一次请求。没有任务号（本地文件）时直接拒绝，由调用方按不可用处理 */
function bpGetPart(key) {
  if (PART_CACHE[key]) { return Promise.resolve(PART_CACHE[key]); }
  if (PART_LOADING[key]) { return PART_LOADING[key]; }
  const url = bpPartUrl(key);
  if (!url) { return Promise.reject(new Error('no task id')); }
  PART_LOADING[key] = fetch(url, { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then(v => { PART_CACHE[key] = v; delete PART_LOADING[key]; return v; },
      e => { delete PART_LOADING[key]; throw e; });
  return PART_LOADING[key];
}

/* 搜索场：只在自定义规格真用到时补上（labels / ref 打包在同一个 part 里） */
async function bpEnsureField() {
  const F = D.field;
  if (!F) { return null; }
  if (F.labels && F.ref) { return F; }
  if (!bpPartWanted('field')) { return F; }   // 老图纸：缺就是真缺，别去要
  const part = await bpGetPart('field');
  F.labels = part.labels;
  F.ref = part.ref;
  return F;
}

/* 原图（玩家上传的那张）：只被「原图」页签、海报里的原图角标、另存单文件用到，
   翻开图纸先看的是转换图和图纸，所以不跟着首屏下载。构建时拆到 parts/sources.json，
   D.images 先留空、D.hasSource 记住「本来有原图」（页签显隐靠它，不能靠 D.images.length）。
   取回来后派发 bp-sources，等在那里的三处各自重绘。 */
async function bpEnsureSources() {
  if (D.images && D.images.length) { return D.images; }
  if (!bpPartWanted('sources')) { return D.images || []; }
  const part = await bpGetPart('sources');
  D.images = (part && part.images) || [];
  window.dispatchEvent(new Event('bp-sources'));
  return D.images;
}

/* 另存单文件之前把没取过的块补齐：存出来的文件必须自给自足（离线也能改自定义尺寸、看原图） */
async function bpCompleteAllParts() {
  if (bpPartWanted('field') && D.field && (!D.field.labels || !D.field.ref)) { await bpEnsureField(); }
  if (bpPartWanted('sources') && !(D.images && D.images.length)) { await bpEnsureSources(); }
}

/* three.js（663KB 原文 / br 159KB）只被 3D 看法用：只看平面图纸的人不该为它付。
   构建时把原本内联的 vendor 换成 window.PIXELART_THREE_URL（带内容哈希，一年 immutable），
   第一次切 3D 才注入 <script>；加载成功后由 view-3d.js 重建 V3 实例。
   老图纸没有这个变量，three 本来就在页面里，走不到这里。
   另存的单文件要离线能看 3D，保存时由 js/save-file.js 把源码取回来内联。 */
let THREE_LOADING = null;
function loadThree() {
  if (window.THREE && window.OrbitControls) return Promise.resolve();
  if (THREE_LOADING) return THREE_LOADING;
  const url = window.PIXELART_THREE_URL;
  if (!url) return Promise.reject(new Error('no three url'));
  THREE_LOADING = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.async = true;
    s.onload = () => (window.THREE && window.OrbitControls ? resolve() : reject(new Error('three missing')));
    s.onerror = () => reject(new Error('three load failed'));
    document.head.appendChild(s);
  }).catch((e) => { THREE_LOADING = null; throw e; });
  return THREE_LOADING;
}
