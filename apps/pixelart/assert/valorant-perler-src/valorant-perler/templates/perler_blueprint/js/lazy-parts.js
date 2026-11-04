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

/* 另存单文件之前把没取过的块补齐：存出来的文件必须自给自足（离线也能改自定义尺寸） */
async function bpCompleteAllParts() {
  if (!bpPartWanted('field')) { return; }
  if (D.field && (!D.field.labels || !D.field.ref)) { await bpEnsureField(); }
}
