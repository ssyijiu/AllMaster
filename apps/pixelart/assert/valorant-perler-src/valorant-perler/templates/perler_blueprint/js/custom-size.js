/* =====================================================================
 * [CUSTOM-SIZE] 自定义方形规格 BEGIN
 * 玩家在侧栏「板子规格」下填一个边长 N（每边 15–156 格），输入框右侧即时回显「×N」，一眼看出板是 N×N 的正方形；
 * 页面现场跑对齐搜索并新增一张自定义规格卡，可多张并存。
 * 算法复刻专家包 alignment_search.search：内容格 n×n 居中放上 N×N 方板，n 在 ⌊0.8×N⌋ 到 N 之间，
 * 相位 dx/dy 各试 phases 个，逐个候选按调色板落色后打分（色差 / 边缘 / 局部最差块 + 铺满度），得分最低者胜出。
 * 输入是构建时打包的搜索场 D.field：前景框内像素细簇标签、细簇 → 搜索调色板色的映射、评估参照图与搜索参数。
 * 选定几何后按细簇出格内票数，写进 VOTES 缓存，此后换色板、调色数、附属岛、编辑、导出都走原有链路。
 * 「自定义是上限」：实际内容格数 n 可能小于 N，板上多出来的格不放豆。
 * 自定义卡 key 一律为「NxN」，与固定档（「52」）区分：同边长的自定义卡搜 ⌊0.8×N⌋–N，固定档搜档间区间。
 *
 * 计算按时间片让出主线程（每片约 30ms），卡片上显示进度，页面不会假死。
 * 本机只记「这份图纸加过哪些自定义尺寸」（localStorage），重开页面按同一算法后台重算；
 * 自定义卡上的编辑存档沿用 persistGrid() 的按「任务 × 规格」分键，与固定档一致。
 * 接点 [CUSTOM-SIZE hook]：renderSizes() 调 csRenderCards() 追加进行中的卡、给自定义卡挂删除钮。
 * ===================================================================== */
const CS_FIELD = D.field || null;
const CS_KEY = `perler-custom-sizes-${TASK_KEY}`;
const CS = { prep: null, queue: [], running: null };   // queue / running: { n, key, progress }

function csKey(n) { return `${n}x${n}`; }   // key 一律 NxN：同边长的自定义卡与固定档是两张卡，搜索区间不同
function csSaved() { try { return (JSON.parse(localStorage.getItem(CS_KEY) || '[]') || []).filter(Number.isInteger); } catch (e) { return []; } }
function csPersist() {
  const list = D.sizes.filter(s => s.page).map(s => s.w).concat([CS.running, ...CS.queue].filter(Boolean).map(j => j.n));
  try { localStorage.setItem(CS_KEY, JSON.stringify(list)); } catch (e) {}
}

async function csInflate(b64) {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* 一次性准备：解码标签与参照图，预算边缘权重与分块（与 Evaluator.__init__ 一致） */
async function csPrepare() {
  if (CS.prep) return CS.prep;
  const F = CS_FIELD, [x0, y0, x1, y1] = F.bbox, cw = x1 - x0, ch = y1 - y0;
  const fine = await csInflate(F.labels), raw = await csInflate(F.ref);
  const search = new Uint8Array(fine.length);
  for (let i = 0; i < fine.length; i++) search[i] = F.searchOf[fine[i]];
  const ew = F.evalW, eh = F.evalH, np = ew * eh;
  const ref = new Float64Array(np * 3), emask = new Uint8Array(np);
  for (let p = 0; p < np; p++) {
    for (let c = 0; c < 3; c++) ref[p * 3 + c] = raw[p * 4 + c] / 255;
    emask[p] = raw[p * 4 + 3] > 127 ? 1 : 0;
  }
  const xs = new Float64Array(ew), ys = new Float64Array(eh);
  for (let i = 0; i < ew; i++) xs[i] = x0 + (i + 0.5) * cw / ew;
  for (let j = 0; j < eh; j++) ys[j] = y0 + (j + 0.5) * ch / eh;
  const e0 = new Float64Array(np);
  const dmax = (p, q) => Math.max(Math.abs(ref[p * 3] - ref[q * 3]), Math.abs(ref[p * 3 + 1] - ref[q * 3 + 1]), Math.abs(ref[p * 3 + 2] - ref[q * 3 + 2]));
  for (let j = 0; j < eh; j++) for (let i = 1; i < ew; i++) e0[j * ew + i] += dmax(j * ew + i, j * ew + i - 1);
  for (let j = 1; j < eh; j++) for (let i = 0; i < ew; i++) e0[j * ew + i] += dmax(j * ew + i, (j - 1) * ew + i);
  const edges = new Float64Array(np);   // 3×3 膨胀（取邻域最大，越界不计）
  let edgeSum = 0;
  for (let j = 0; j < eh; j++) for (let i = 0; i < ew; i++) {
    let m = 0;
    for (let b = Math.max(0, j - 1); b <= Math.min(eh - 1, j + 1); b++)
      for (let a = Math.max(0, i - 1); a <= Math.min(ew - 1, i + 1); a++) m = Math.max(m, e0[b * ew + a]);
    edges[j * ew + i] = m; edgeSum += m;
  }
  const th = Math.ceil(eh / 8), tw = Math.ceil(ew / 8), tiles = [];
  for (let y = 0; y < eh; y += th) for (let x = 0; x < ew; x += tw) tiles.push([y, Math.min(y + th, eh), x, Math.min(x + tw, ew)]);
  const pal = new Float64Array(F.searchRgb.length * 3);
  F.searchRgb.forEach((c, k) => { pal[k * 3] = c[0] / 255; pal[k * 3 + 1] = c[1] / 255; pal[k * 3 + 2] = c[2] / 255; });
  return CS.prep = { x0, y0, x1, y1, cw, ch, fine, search, K: F.searchRgb.length, kf: F.searchOf.length,
    ew, eh, ref, emask, xs, ys, edges, edgeDen: Math.max(edgeSum, 1e-9), tiles, pal };
}

/* 单色积分图（cv2.integral 语义：I[y][x] = 左上 y×x 区域内该色像素数），缓冲区复用 */
function csIntegral(P, labels, k, out) {
  const W1 = P.cw + 1;
  out.fill(0, 0, W1);
  for (let y = 0; y < P.ch; y++) {
    let run = 0; const r = y * P.cw, o = (y + 1) * W1, u = y * W1;
    out[o] = 0;
    for (let x = 0; x < P.cw; x++) { if (labels[r + x] === k) run++; out[o + x + 1] = out[u + x + 1] + run; }
  }
  return out;
}
/* 格线坐标（原图坐标 → 前景框坐标，夹到框内；框外只有背景，前景色积分与夹到整图等价） */
function csAxis(start, pitch, n, origin, limit) {
  const i0 = new Int32Array(n + 1), i1 = new Int32Array(n + 1), w = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) {
    const v = Math.min(Math.max(start + k * pitch - origin, 0), limit), f = Math.floor(v);
    i0[k] = f; i1[k] = Math.min(f + 1, limit); w[k] = v - f;
  }
  return { i0, i1, w };
}
/* 按几何在积分图上取每格该色面积（双线性积分 = 精确的分数像素覆盖），回调 (格下标, 面积) */
function csCellAreas(I, W1, ax, ay, n, vals, each) {
  for (let j = 0; j <= n; j++) {
    const ya = ay.i0[j] * W1, yb = ay.i1[j] * W1, wy = ay.w[j];
    for (let i = 0; i <= n; i++) {
      const xa = ax.i0[i], xb = ax.i1[i], wx = ax.w[i];
      vals[j * (n + 1) + i] = (I[ya + xa] * (1 - wx) + I[ya + xb] * wx) * (1 - wy) + (I[yb + xa] * (1 - wx) + I[yb + xb] * wx) * wy;
    }
  }
  const N1 = n + 1;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = vals[(j + 1) * N1 + i + 1] - vals[j * N1 + i + 1] - vals[(j + 1) * N1 + i] + vals[j * N1 + i];
    if (v > 0) each(j * n + i, v);
  }
}
function csGeom(P, n, dx, dy) {
  const pitch = Math.max(P.cw, P.ch) / (n - 1);
  return { left: (P.x0 + P.x1 - n * pitch) / 2 + dx * pitch, top: (P.y0 + P.y1 - n * pitch) / 2 + dy * pitch, pitch };
}
/* 与 Evaluator.score 同式：0.5 色差 + 0.3 边缘 + 0.2 最差四分之一分块，再加铺满度惩罚 */
function csScore(P, g, grid, n, board) {
  const F = CS_FIELD, xi = new Int32Array(P.ew), yi = new Int32Array(P.eh);
  for (let i = 0; i < P.ew; i++) xi[i] = Math.min(n - 1, Math.max(0, Math.floor((P.xs[i] - g.left) / g.pitch)));
  for (let j = 0; j < P.eh; j++) yi[j] = Math.min(n - 1, Math.max(0, Math.floor((P.ys[j] - g.top) / g.pitch)));
  const err = new Float64Array(P.ew * P.eh), sup = new Uint8Array(P.ew * P.eh);
  let cs = 0, cn = 0, es = 0;
  for (let j = 0; j < P.eh; j++) for (let i = 0; i < P.ew; i++) {
    const p = j * P.ew + i, k = grid[yi[j] * n + xi[i]];
    const e = (Math.abs(P.pal[k * 3] - P.ref[p * 3]) + Math.abs(P.pal[k * 3 + 1] - P.ref[p * 3 + 1]) + Math.abs(P.pal[k * 3 + 2] - P.ref[p * 3 + 2])) / 3;
    err[p] = e; es += e * P.edges[p];
    if (P.emask[p] || k) { sup[p] = 1; cs += e; cn++; }
  }
  const local = [];
  for (const [ya, yb, xa, xb] of P.tiles) {
    let s = 0, c = 0;
    for (let j = ya; j < yb; j++) for (let i = xa; i < xb; i++) { const p = j * P.ew + i; if (sup[p]) { s += err[p]; c++; } }
    if (c) local.push(s / c);
  }
  local.sort((a, b) => a - b);
  const worst = local.slice(-Math.max(1, Math.ceil(local.length / 4)));
  let mx0 = n, mx1 = -1, my0 = n, my1 = -1;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (grid[j * n + i]) {
    if (i < mx0) mx0 = i; if (i > mx1) mx1 = i; if (j < my0) my0 = j; if (j > my1) my1 = j;
  }
  const contentW = mx1 >= 0 ? mx1 - mx0 + 1 : 0, contentH = my1 >= 0 ? my1 - my0 + 1 : 0;
  const [wc, we, wl] = F.lossWeights;
  const quality = wc * (cn ? cs / cn : 0) + we * es / P.edgeDen + wl * (worst.reduce((a, b) => a + b, 0) / worst.length);
  return { score: quality + F.sizeWeight * (1 - Math.max(contentW, contentH) / board), contentW, contentH };
}

/* 时间片调度：超过 30ms 就让出主线程并回报进度 */
function csSlicer(onProgress) {
  let t = performance.now();
  return async frac => {
    if (performance.now() - t < 30) return;
    onProgress(frac); await new Promise(r => setTimeout(r)); t = performance.now();
  };
}

/* 对齐搜索：返回得分最低的候选 { n, dx, dy, score, contentW, contentH } */
async function csSearch(P, board, tick) {
  const F = CS_FIELD, lo = Math.max(3, Math.floor(F.customRatio * board));
  const lin = Array.from({ length: F.phases }, (_, i) => i === F.phases - 1 ? 0.5 : -0.5 + i / (F.phases - 1));
  const I = new Int32Array((P.cw + 1) * (P.ch + 1)), records = [];
  const total = (board - lo + 1) * (P.K - 1);
  let done = 0;
  for (let n = lo; n <= board; n++) {
    const geoms = [];
    for (const dy of lin) for (const dx of lin) {
      const g = csGeom(P, n, dx, dy);
      geoms.push(Object.assign(g, { dx, dy, ax: csAxis(g.left, g.pitch, n, P.x0, P.cw), ay: csAxis(g.top, g.pitch, n, P.y0, P.ch),
        best: new Float64Array(n * n), pick: new Uint8Array(n * n), sum: new Float64Array(n * n) }));
    }
    const vals = new Float64Array((n + 1) * (n + 1));
    for (let k = 1; k < P.K; k++) {
      csIntegral(P, P.search, k, I);
      for (const g of geoms) csCellAreas(I, P.cw + 1, g.ax, g.ay, n, vals, (c, v) => {
        g.sum[c] += v; if (v > g.best[c]) { g.best[c] = v; g.pick[c] = k; }
      });
      await tick(++done / total);
    }
    for (const g of geoms) {
      const p2 = g.pitch * g.pitch;
      for (let c = 0; c < n * n; c++) if (p2 - g.sum[c] >= g.best[c]) g.pick[c] = 0;   // 背景票 = 格面积 − 前景票，同票背景优先
      records.push(Object.assign({ n, dx: g.dx, dy: g.dy }, csScore(P, g, g.pick, n, board)));
    }
  }
  records.sort((a, b) => a.score - b.score || b.n - a.n || (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy)) || a.dy - b.dy || a.dx - b.dx);
  return records[0];
}

/* 选定几何下按细簇出格内票数，居中放上 board×board 板（与 build_html_blueprint.cell_votes + encode_votes 同式） */
async function csVotes(P, board, sel, tick) {
  const S = CS_FIELD.voteScale, n = sel.n, g = csGeom(P, n, sel.dx, sel.dy), p2 = g.pitch * g.pitch;
  const ax = csAxis(g.left, g.pitch, n, P.x0, P.cw), ay = csAxis(g.top, g.pitch, n, P.y0, P.ch);
  const I = new Int32Array((P.cw + 1) * (P.ch + 1)), vals = new Float64Array((n + 1) * (n + 1));
  const cells = Array.from({ length: n * n }, () => []), sum = new Float64Array(n * n);
  const present = new Uint8Array(P.kf);
  for (let i = 0; i < P.fine.length; i++) present[P.fine[i]] = 1;
  for (let k = 1; k < P.kf; k++) {
    if (present[k]) {
      csIntegral(P, P.fine, k, I);
      csCellAreas(I, P.cw + 1, ax, ay, n, vals, (c, v) => { sum[c] += v; cells[c].push([k, v]); });
    }
    await tick(k / P.kf);
  }
  const rows = Array.from({ length: board }, () => new Array(board).fill(null));
  const off = (board - n) >> 1;
  for (let c = 0; c < n * n; c++) {
    const q0 = Math.round(Math.max(0, p2 - sum[c]) / p2 * S);
    if (q0 >= S) continue;
    const cell = cells[c].map(([k, v]) => [k, Math.round(v / p2 * S)]).filter(x => x[1] > 0);
    if (q0 > 0) cell.push([0, q0]);
    rows[off + ((c / n) | 0)][off + c % n] = cell.length ? cell : null;
  }
  return rows;
}

/* 每个细簇在剪影外缘一圈里的像素数（下标 0 为背景），供描边断口补齐识别描边色。与 alignment_search.outline_ring 同式：
 * 前景像素在 (2r+1)×(2r+1) 方窗内有背景像素即属外缘，r = max(2, round(格距/6))；图外不算背景。 */
function csRing(P, pitch) {
  const F = CS_FIELD, iw = F.imgW, ih = F.imgH;
  const half = Math.floor(pitch / 6), frac = pitch / 6 - half;
  const r = Math.max(2, frac > 0.5 || (frac === 0.5 && half % 2) ? half + 1 : half);   // Python round：逢半取偶
  const w = P.cw + 2 * r, h = P.ch + 2 * r;
  const bg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ix = P.x0 - r + x, iy = P.y0 - r + y;
    if (ix < 0 || iy < 0 || ix >= iw || iy >= ih) continue;
    const cx = ix - P.x0, cy = iy - P.y0;
    bg[y * w + x] = (cx < 0 || cy < 0 || cx >= P.cw || cy >= P.ch || !P.fine[cy * P.cw + cx]) ? 1 : 0;
  }
  const rowMax = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const pre = new Int32Array(w + 1);
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + bg[y * w + x];
    for (let x = 0; x < w; x++) rowMax[y * w + x] = pre[Math.min(w, x + r + 1)] - pre[Math.max(0, x - r)] > 0 ? 1 : 0;
  }
  const ring = new Array(P.kf).fill(0);
  for (let cy = 0; cy < P.ch; cy++) for (let cx = 0; cx < P.cw; cx++) {
    const k = P.fine[cy * P.cw + cx];
    if (!k) continue;
    const x = cx + r;
    let hit = false;
    for (let y = cy; y <= cy + 2 * r && !hit; y++) hit = rowMax[y * w + x] === 1;
    if (hit) ring[k]++;
  }
  return ring;
}

/* ---------- 任务队列：一次算一张，进行中的卡片显示进度 ---------- */
function csSubmit(n, quiet) {
  const key = csKey(n);
  if (SIZES[key]) { if (!quiet) { csSwitch(key); toast(`${n}×${n} 已存在`); } return; }
  if ([CS.running, ...CS.queue].some(j => j && j.key === key)) { if (!quiet) toast(`${n}×${n} 计算中`); return; }
  CS.queue.push({ n, key, progress: 0, quiet });
  csPersist(); renderSizes();
  if (!CS.running) csPump();
}
async function csPump() {
  while (CS.queue.length) {
    const job = CS.running = CS.queue.shift();
    renderSizes();
    try {
      const P = await csPrepare();
      const bar = frac => { job.progress = frac; csPaintProgress(job); };
      const sel = await csSearch(P, job.n, csSlicer(f => bar(f * 0.85)));
      const rows = await csVotes(P, job.n, sel, csSlicer(f => bar(0.85 + f * 0.15)));
      VOTES[job.key] = rows;
      D.specs[job.key] = { contentW: sel.contentW, contentH: sel.contentH, sel, ring: csRing(P, csGeom(P, sel.n, sel.dx, sel.dy).pitch) };
      const s = { key: job.key, w: job.n, h: job.n, isCustom: true, page: true };
      SIZES[job.key] = s;
      D.sizes.push(s); D.sizes.sort((a, b) => a.w - b.w);
      CS.running = null; csPersist();
      if (!job.quiet && !ed.on) { csSwitch(job.key); toast(`自定义 ${job.n}×${job.n} 已生成 · 图案占 ${sel.contentW}×${sel.contentH} 格`, 2600); }
      else { renderSizes(); if (!job.quiet) toast(`自定义 ${job.n}×${job.n} 已生成，点击卡片查看`, 2600); }
    } catch (e) {
      CS.running = null; csPersist(); renderSizes();
      toast(`${job.n}×${job.n} 生成失败，请调整边长后重试`, 4000);
      console.error(e);
    }
  }
}
function csSwitch(key) { state.size = key; parseGrid(); buildColorMap(); loadProgress(); refreshAll(); fitView(); }
function csPaintProgress(job) {
  const el = document.querySelector(`.size-card.pending[data-key="${job.key}"]`);
  if (!el) return;
  el.querySelector('.cs-bar i').style.width = (job.progress * 100).toFixed(1) + '%';
  el.querySelector('.meta').textContent = `计算中 ${Math.round(job.progress * 100)}%`;
}

/* 删自定义卡：连同它在本机的编辑存档与施工进度一起清掉 */
async function csRemove(key) {
  const s = SIZES[key];
  const prefix = [`perler-grid-${TASK_KEY}-${key}-`, `perler-progress-${TASK_KEY}-${key}-`, `perler-vers-${TASK_KEY}-${key}-`];
  let keys = [];
  try { keys = Object.keys(localStorage).filter(k => prefix.some(p => k.startsWith(p))); } catch (e) {}
  if (keys.some(k => k.startsWith(prefix[0])) || (state.size === key && ed.on && ed.dirty)) {
    const v = await edConfirm(`删除自定义 ${s.w}×${s.w}？`, '该尺寸下的编辑内容（含未保存的改动）将被清除。', [
      { label: '取消', value: null }, { label: '删除', value: 'del', primary: true }]);
    if (!v) return;
  }
  const wasCur = state.size === key;
  if (wasCur) { if (ed.on) await edExit(true); state.size = D.defaultSize; }
  try { keys.forEach(k => localStorage.removeItem(k)); } catch (e) {}
  D.sizes.splice(D.sizes.indexOf(s), 1);
  delete SIZES[key]; delete D.specs[key]; delete VOTES[key];
  for (const c of [RESOLVED, ISLAND_CACHE, THUMBS]) for (const k of Object.keys(c)) if (k.startsWith(key + '|')) delete c[k];
  csPersist();
  if (wasCur) csSwitch(D.defaultSize); else renderSizes();
  toast(`已删除自定义 ${s.w}×${s.w}`);
}

/* [CUSTOM-SIZE hook] renderSizes() 末尾调用：给页面自定义卡挂删除钮，追加进行中的卡 */
function csRenderCards(el) {
  el.querySelectorAll('.size-card[data-page]').forEach(card => {
    const x = document.createElement('button');
    x.className = 'cs-del'; x.title = '删除此尺寸'; x.textContent = '✕';
    x.onclick = e => { e.stopPropagation(); csRemove(card.dataset.key); };
    card.appendChild(x);
  });
  for (const job of [CS.running, ...CS.queue].filter(Boolean)) {
    const b = document.createElement('div');
    b.className = 'size-card pending'; b.dataset.key = job.key;
    b.innerHTML = `<div class="cs-ph"><div class="cs-bar"><i></i></div></div>
      <div class="nm"><span class="n">自定义 ${job.n}×${job.n}</span><span class="meta">${job === CS.running ? '计算中' : '排队中'}</span></div>`;
    el.appendChild(b);
    if (job === CS.running) csPaintProgress(job);
  }
}

/* ---------- 输入面板：填一个边长，右侧即时回显「×N」 ---------- */
(function csInit() {
  const row = document.getElementById('csRow');
  if (!CS_FIELD || typeof DecompressionStream === 'undefined') { row.style.display = 'none'; return; }
  const F = CS_FIELD, nIn = document.getElementById('csN'), echo = document.getElementById('csEcho');
  const note = document.getElementById('csNote');
  const NOTE = `边长 ${F.boardMin}–${F.boardMax} 格 · 图案按比例缩放至边长的 ${Math.round(F.customRatio * 100)}%–100%`;
  note.textContent = NOTE; row.title = NOTE; nIn.placeholder = `${F.boardMin}–${F.boardMax}`;
  const ok = v => Number.isInteger(v) && v >= F.boardMin && v <= F.boardMax;
  const echoOf = () => {
    const n = Number(nIn.value), good = nIn.value !== '' && ok(n);
    echo.textContent = '×' + (good ? n : 'N');
    echo.classList.toggle('on', good);
    return good ? n : null;
  };
  const go = () => {
    const n = echoOf();
    if (n === null) {
      note.textContent = `边长须是 ${F.boardMin}–${F.boardMax} 之间的整数`;
      row.classList.add('bad'); return;
    }
    row.classList.remove('bad'); note.textContent = NOTE;
    csSubmit(n);
  };
  document.getElementById('csGo').onclick = go;
  nIn.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  nIn.addEventListener('input', () => { row.classList.remove('bad'); note.textContent = NOTE; echoOf(); });
  setTimeout(() => { for (const n of csSaved()) csSubmit(n, true); });   // 本机加过的自定义尺寸：等页面初始化完，后台按同一算法重算
})();
/* ===== [CUSTOM-SIZE] 自定义方形规格 END ===== */
