/* ================= 色板落色（底稿簇 → 目标色板） =================
 * 页面数据（window.DEMO_DATA，构建时内联）携带对齐阶段的中间态：K 个颜色簇中心（Lab）+ 每格各簇面积票数。
 * 换色板 = 把每个簇中心映射到目标色板最近色（CIEDE2000），同色票合并后每格取多数。
 * 几何对齐与豆格数不随色板变化；点击色板时浏览器现场计算，结果只进内存缓存。 */
function ciede2000(a, b) {
  const [L1, a1, b1] = a, [L2, a2, b2] = b, rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (x, y) => { if (!x && !y) return 0; const t = Math.atan2(y, x) / rad; return t < 0 ? t + 360 : t; };
  const h1p = h(a1p, b1), h2p = h(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2 * rad);
  const Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p) { hpm = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2; }
  const T = 1 - 0.17 * Math.cos((hpm - 30) * rad) + 0.24 * Math.cos(2 * hpm * rad)
          + 0.32 * Math.cos((3 * hpm + 6) * rad) - 0.20 * Math.cos((4 * hpm - 63) * rad);
  const dTh = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + 0.015 * (Lpm - 50) ** 2 / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T, Rt = -Math.sin(2 * dTh * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
/* 解码格内票数：'簇.票,簇.票|…'，空串 = 纯背景 */
const VOTES = {};
function votesOf(size) {
  if (VOTES[size]) return VOTES[size];
  return VOTES[size] = D.specs[size].votes.map(row => row.split('|').map(cell =>
    cell ? cell.split(',').map(p => p.split('.').map(Number)) : null));
}
const RESOLVED = {};  // 仅本次打开页面的内存缓存，关页即失
function resolveGrid(size, palId, budget) {
  budget = budget ?? state.budget;
  const key = size + '|' + palId + '|' + budget;
  if (RESOLVED[key]) return RESOLVED[key];
  let rows;
  {
    const pal = PALS[palId].colors;
    const target = LEVELS[budget].centers.map(c => { // 细簇 k+1 -> 色板下标
      let best = 0, bd = Infinity;
      for (let i = 0; i < pal.length; i++) { const d = ciede2000(c, pal[i].lab); if (d < bd) { bd = d; best = i; } }
      return best;
    });
    const pools = votesOf(size).map(row => row.map(cell => {
      if (!cell) return null;
      const pool = new Map();
      let bg = 0;
      for (const [k, w] of cell) {
        if (k === 0) { bg = w; continue; }
        const t = target[k - 1]; pool.set(t, (pool.get(t) || 0) + w);
      }
      return { bg, pool };
    }));
    const win = pools.map(row => row.map(c => {
      if (!c) return -1;
      let pick = -1, pw = c.bg; // 与 Python 端一致：背景优先、同票取先出现的色板序
      for (const [t, w] of [...c.pool].sort((x, y) => x[0] - y[0])) if (w > pw) { pw = w; pick = t; }
      return pick;
    }));
    const used = [...new Set(target)].sort((x, y) => x - y);
    const fixed = outlineFix(highlightFix(win, pools, pal, used), pools, pal, used, target, D.specs[size].ring, D.ringAll);
    rows = fixed.map(row => row.map(i => i < 0 ? '' : pal[i].code));
    applyRepairs(rows, size, pal);
  }
  return RESOLVED[key] = rows;
}

/* 局部修复覆盖层（D.repairs，构建时可选带入）：落色之后把修过的格子盖上去。
 * 每格存修复色的 Lab，按当前色板取最近色（CIEDE2000）；null 表示这格不放豆。颜色数量档位不改它们。 */
function applyRepairs(rows, size, pal) {
  const cells = D.repairs && D.repairs.sizes[size];
  if (!cells) return;
  const near = new Map();
  for (const [r, c, lab] of cells) {
    if (!rows[r] || c >= rows[r].length) continue;
    if (!lab) { rows[r][c] = ''; continue; }
    const k = lab.join(',');
    if (!near.has(k)) {
      let best = 0, bd = Infinity;
      for (let i = 0; i < pal.length; i++) { const d = ciede2000(lab, pal[i].lab); if (d < bd) { bd = d; best = i; } }
      near.set(k, pal[best].code);
    }
    rows[r][c] = near.get(k);
  }
}

/* 高光分票修正（与 alignment_search.highlight_fix 一致）：小块高光由几档相近亮色组成，按单色计票会被拆票、
 * 输给一档暗的过渡色。格内 ΔE<16 的色合成色族合票；不含原赢家的色族合票更多、其代表色比原赢家和 8 邻域
 * 主流色都亮 20 以上、且原赢家不是近黑描边（L≥20）时，格子改为代表色。win 为色板下标网格，-1 为空格。 */
const HL_FAMILY_DE = 16, HL_BRIGHT_L = 20, HL_OUTLINE_L = 20;
function highlightFix(win, pools, pal, used) {
  const K = used.length, pos = new Map(used.map((t, i) => [t, i]));
  const L = used.map(t => pal[t].lab[0]);
  const same = used.map(a => used.map(b => ciede2000(pal[a].lab, pal[b].lab) < HL_FAMILY_DE));
  const H = win.length, W = H ? win[0].length : 0;
  const out = win.map(r => r.slice());
  const share = new Float64Array(K), fam = new Float64Array(K), cnt = new Int32Array(K);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const g = win[y][x], c = pools[y][x];
    if (g < 0 || !c) continue;
    const gi = pos.get(g);
    if (L[gi] < HL_OUTLINE_L) continue;
    cnt.fill(0);
    let any = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dy && !dx) continue;
      const v = (win[y + dy] || [])[x + dx];
      if (v !== undefined && v >= 0) { cnt[pos.get(v)]++; any = true; }
    }
    if (!any) continue;
    let mode = 0;
    for (let i = 1; i < K; i++) if (cnt[i] > cnt[mode]) mode = i;
    let total = c.bg;
    for (const w of c.pool.values()) total += w;
    share.fill(0);
    for (const [t, w] of c.pool) share[pos.get(t)] = w / Math.max(total, 1e-9);
    for (let i = 0; i < K; i++) { let s = 0; for (let j = 0; j < K; j++) if (same[i][j]) s += share[j]; fam[i] = s; }
    let best = -1, bestScore = 0;
    for (let i = 0; i < K; i++) {
      if (same[i][gi] || fam[i] <= fam[gi]) continue;
      let rep = -1, rs = -1;
      for (let j = 0; j < K; j++) if (same[i][j] && share[j] > rs) { rs = share[j]; rep = j; }
      if (L[rep] < L[gi] + HL_BRIGHT_L || L[rep] < L[mode] + HL_BRIGHT_L) continue;
      if (fam[i] > bestScore) { bestScore = fam[i]; best = rep; }
    }
    if (best >= 0) out[y][x] = used[best];
  }
  return out;
}

/* 描边断口补齐（与 alignment_search.outline_fix / outline_family 一致）：外描边只有一两个底稿像素宽，常被相邻两格
 * 各分走一半面积、两格都没投成描边，轮廓破口。先按外缘计数识别描边色族（外缘没有统一描边色就原样返回），再把描边
 * 还给面积更大的那一格。图案有多种描边色时，外缘占比 ≥ OL_EXTRA_RING 且是全图占比 OL_MIN_LIFT 倍以上的其他色号连同近色也算
 * 描边色族。只动与外部背景（从板边 4 连通能走到的空格）相邻的格子，内部留白不补；描边始终一格厚。
 * win 为色板下标网格（-1 为空格），ring / ringAll 为每个细簇在剪影外缘一圈 / 全图前景的像素数（下标 0 为背景）。 */
const OL_FAMILY_DE = 22, OL_MIN_RING = 0.4, OL_MIN_LIFT = 1.3, OL_PAIR = 0.1, OL_RECOLOR = 0.2, OL_EXTRA_RING = 0.1;
function outlineFix(win, pools, pal, used, target, ring, ringAll) {
  if (!ring || !ringAll) return win;
  const K = used.length, pos = new Map(used.map((t, i) => [t, i + 1]));
  const rc = new Float64Array(K + 1), gc = new Float64Array(K + 1);
  for (let k = 1; k < ring.length; k++) { const j = pos.get(target[k - 1]); rc[j] += ring[k]; gc[j] += ringAll[k] || 0; }
  let rs = 0, gs = 0, top = 1;
  for (let j = 1; j <= K; j++) { rs += rc[j]; gs += gc[j]; if (rc[j] > rc[top]) top = j; }
  if (rs <= 0 || gs <= 0) return win;
  const fam = new Uint8Array(K + 1);
  let r = 0, gl = 0;
  for (let j = 1; j <= K; j++) if (ciede2000(pal[used[top - 1]].lab, pal[used[j - 1]].lab) < OL_FAMILY_DE) { fam[j] = 1; r += rc[j]; gl += gc[j]; }
  if (r / rs < OL_MIN_RING || r / rs < OL_MIN_LIFT * gl / gs) return win;
  const extra = [];
  for (let c = 1; c <= K; c++) if (!fam[c] && rc[c] / rs >= OL_EXTRA_RING && rc[c] / rs >= OL_MIN_LIFT * gc[c] / gs) extra.push(c);
  for (const c of extra) for (let j = 1; j <= K; j++) if (ciede2000(pal[used[c - 1]].lab, pal[used[j - 1]].lab) < OL_FAMILY_DE) fam[j] = 1;
  const H = win.length, W = H ? win[0].length : 0, N = H * W;
  const g = new Int32Array(N), osh = new Float64Array(N), best = new Int32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, v = win[y][x], c = pools[y][x];
    g[i] = v < 0 ? 0 : pos.get(v);
    if (!c) continue;
    let total = c.bg;
    for (const w of c.pool.values()) total += w;
    const sh = new Float64Array(K + 1);
    for (const [t, w] of c.pool) sh[pos.get(t)] = w / Math.max(total, 1e-9);
    let o = 0, bk = 0, bv = -1;
    for (let j = 1; j <= K; j++) if (fam[j]) { o += sh[j]; if (sh[j] > bv) { bv = sh[j]; bk = j; } }
    osh[i] = Math.round(o * 1e9) / 1e9; best[i] = bk;
  }
  for (let i = 0; i < N; i++) if (!best[i]) { for (let j = 1; j <= K; j++) if (fam[j]) { best[i] = j; break; } }
  const inb = (y, x) => y >= 0 && y < H && x >= 0 && x < W;
  const isO = (y, x) => inb(y, x) && g[y * W + x] > 0 && fam[g[y * W + x]] === 1;
  const solid = (y, x) => inb(y, x) && g[y * W + x] > 0 && !fam[g[y * W + x]];
  const N4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  let out = new Uint8Array(N), outCount = 0;
  const flood = () => {
    const o = new Uint8Array(N), st = [];
    let c = 0;
    const push = t => { if (g[t] === 0 && !o[t]) { o[t] = 1; st.push(t); c++; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (st.length) {
      const t = st.pop(), y = (t / W) | 0, x = t % W;
      for (const [dy, dx] of N4) if (inb(y + dy, x + dx)) push((y + dy) * W + x + dx);
    }
    return [o, c];
  };
  [out, outCount] = flood();
  const isOut = (y, x) => !inb(y, x) || out[y * W + x] === 1;
  const onRim = (y, x) => N4.some(([dy, dx]) => isOut(y + dy, x + dx));
  const block2 = (y, x) => [[-1, -1], [-1, 0], [0, -1], [0, 0]].some(([oy, ox]) =>
    isO(y + oy, x + ox) && isO(y + oy + 1, x + ox) && isO(y + oy, x + ox + 1) && isO(y + oy + 1, x + ox + 1));
  const apply = (y, x) => {
    const keep = [];
    for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) if (isO(yy, xx) && onRim(yy, xx)) keep.push([yy, xx]);
    const t = y * W + x, old = g[t];
    g[t] = best[t];
    if (old === 0) {
      const [o, c] = flood();
      if (c !== outCount - 1) { g[t] = old; return 0; }
      out = o; outCount = c;
    }
    if (!onRim(y, x) || keep.some(([yy, xx]) => !onRim(yy, xx)) || block2(y, x)) {
      g[t] = old;
      if (old === 0) [out, outCount] = flood();
      return 0;
    }
    return 1;
  };
  const pairs = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!out[y * W + x]) continue;
    for (const [dy, dx] of N4) {
      const fy = y + dy, fx = x + dx;
      if (solid(fy, fx) && osh[y * W + x] + osh[fy * W + fx] >= OL_PAIR) pairs.push([osh[y * W + x] + osh[fy * W + fx], y, x, fy, fx]);
    }
  }
  pairs.sort((a, b) => b[0] - a[0]);
  for (const [, ey, ex, fy, fx] of pairs) {
    if (!out[ey * W + ex] || !solid(fy, fx)) continue;
    const intoFill = osh[fy * W + fx] > osh[ey * W + ex];
    if (intoFill && isO(2 * fy - ey, 2 * fx - ex)) continue;
    if (intoFill) apply(fy, fx); else apply(ey, ex);
  }
  const order = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (solid(y, x) && onRim(y, x) && osh[y * W + x] >= OL_RECOLOR) order.push([osh[y * W + x], y, x]);
  order.sort((a, b) => b[0] - a[0]);
  for (const [, y, x] of order) {
    if (!solid(y, x)) continue;
    const outward = N4.filter(([dy, dx]) => isOut(y + dy, x + dx));
    if (!outward.length || outward.some(([dy, dx]) => isO(y - dy, x - dx))) continue;
    apply(y, x);
  }
  return Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => { const v = g[y * W + x]; return v ? used[v - 1] : -1; }));
}

/* 解析当前规格矩阵（本地有换色改动则读改动版） */
let grid = [], GW = 0, GH = 0;
const GKEY = () => `perler-grid-${TASK_KEY}-${state.size}-${state.palette}${state.budget ? "-b" + state.budget : ""}`;
function parseGrid() {
  let rows = null;
  try { rows = JSON.parse(localStorage.getItem(GKEY()) || 'null'); } catch (e) {}
  grid = rows ? rows.map(r => r.split(',')) : resolveGrid(state.size, state.palette, state.budget).map(r => r.slice());
  GH = grid.length; GW = grid[0].length;
  if (!rows) islandDefaultCull(); // [ISLANDS hook] 无存档：基线矩阵默认剔除所有未恢复的岛格（岛判定锚定 budget=0 解析矩阵）
  syncCounts();
  document.getElementById('restoreGrid').style.display = rows ? 'inline' : 'none';
}
function persistGrid() {
  try {
    localStorage.setItem(GKEY(), JSON.stringify(grid.map(r => r.join(','))));
    document.getElementById('restoreGrid').style.display = 'inline';
  } catch (e) {}
}
/* 矩阵改动后重算统计（矩阵是唯一事实源） */
function syncCounts() {
  const counts = {};
  for (const row of grid) for (const c of row) if (c) counts[c] = (counts[c] || 0) + 1;
  const sp = D.specs[state.size];
  sp.counts = counts;
  sp.beads = Object.values(counts).reduce((a, b) => a + b, 0);
  sp.colors = Object.keys(counts).length;
}
document.getElementById('restoreGrid').onclick = () => {
  try { localStorage.removeItem(GKEY()); } catch (e) {}
  parseGrid(); buildColorMap(); refreshAll(); fitView();
  toast('已恢复初始图纸');
};

/* 色号 -> 颜色：矩阵已是当前色板的原生色号 */
let colorMap = {};
function buildColorMap() { PAL = PALS[state.palette].byCode; colorMap = PAL; }

const lum = rgb => (0.2126*rgb[0] + 0.7152*rgb[1] + 0.0722*rgb[2]) / 255;
const txtOn = rgb => lum(rgb) > 0.55 ? '#141C24' : '#F5F2EC';

function toast(msg, ms = 1800, wrap = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.title = msg; t.classList.toggle('wrap', wrap); t.classList.add('show');
  // 窄屏：落在图纸区顶部、右上「镜像 / 模拟烫豆」按钮组下沿之下，不压顶栏、页签和按钮
  const g = document.getElementById('view-grid'), r = g && g.offsetParent ? g.getBoundingClientRect() : null;
  const tools = g && g.querySelector('.canvas-tools'), tb = tools && tools.offsetParent ? tools.getBoundingClientRect().bottom : 0;
  if (r && r.height) t.style.setProperty('--toast-top', Math.round(Math.max(r.top + 8, tb + 6)) + 'px');
  t.onclick = null;
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), ms);
}

