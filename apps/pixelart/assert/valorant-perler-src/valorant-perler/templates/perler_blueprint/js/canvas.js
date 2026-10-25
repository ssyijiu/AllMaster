/* ================= 图纸画布（纸面质感） ================= */
const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d');
const RULER = 34; // 标尺宽（CSS px）
const CODE_PX = 19; // 每格 ≥ 该像素时格内显示色号，也是「单击格子即编辑」的门槛 [EDIT-MODE hook]
let dpr = 1;

function resizeCanvas() {
  const p = canvas.parentElement, r = { width: p.clientWidth, height: p.clientHeight }; // 内框尺寸：外框含边框，画布会比容器大一圈，挤出滚动条并和浮层错位
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
}

function fitScale() {
  const w = canvas.width / dpr - RULER - 24, h = canvas.height / dpr - RULER - 24;
  return Math.max(0.2, Math.min(w / GW, h / GH)); // 大板在手机上每格可不足 1px，照样整板放进画面
}

function fitView() {
  resizeCanvas();
  state.scale = fitScale();
  const w = canvas.width / dpr - RULER - 24, h = canvas.height / dpr - RULER - 24;
  state.ox = RULER + (w - GW * state.scale) / 2 + 12;
  state.oy = RULER + (h - GH * state.scale) / 2 + 12;
  draw();
}

function draw() {
  if (state.view === 'grid' && state.mode === '3d') { V3.sync(); drawHud(); return; } // [VIEW-3D hook] 3D 看法：矩阵写进豆板纹理
  if (state.view !== 'grid' || !state.scale) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
  const feedback = edColorFeedback();
  const s = state.scale, hl = ed.on ? (feedback ? feedback.code : null) : trackHL(), hlSet = ed.on && feedback && feedback.codes ? feedback.codes : null; // hlSet：按色圈选的多色高亮 [EDIT-MODE hook] [TRACK-HOVER hook] 浏览态：进度表悬停的颜色优先于在拼色 编辑态显示真实颜色，不叠施工高亮

  // 图纸面板（纸面上微深一档，衬出豆格区域）。[IRON hook] 烫豆预览是撕下来的成品，没有豆板：不画面板与外框
  if (!state.meltOn) {
    ctx.fillStyle = '#EDE9DF';
    ctx.fillRect(state.ox - 1, state.oy - 1, GW * s + 2, GH * s + 2);
  }

  // 可见范围裁剪
  const c0 = Math.max(0, Math.floor((RULER - state.ox) / s) - 1);
  const c1 = Math.min(GW - 1, Math.ceil((W - state.ox) / s) + 1);
  const r0 = Math.max(0, Math.floor((RULER - state.oy) / s) - 1);
  const r1 = Math.min(GH - 1, Math.ceil((H - state.oy) / s) + 1);
  const curCells = [], ironCells = [], todoCells = [];

  for (let j = r0; j <= r1; j++) {
    const row = grid[j];
    for (let i = c0; i <= c1; i++) {
      let code = row[i];
      if (ed.preview) { const pv = ed.preview.get(j * GW + i); if (pv !== undefined) code = pv; } // [EDIT-MODE hook] 悬停预览覆盖
      const x0 = state.mirror ? (GW - 1 - i) : i;
      const x = state.ox + x0 * s, y = state.oy + j * s;
      if (!code) { // 空格：底板钉柱（[IRON hook] 烫豆预览是成品视角，不画钉柱）
        if (s >= 9 && !state.meltOn) {
          ctx.fillStyle = 'rgba(15,25,35,.12)';
          ctx.beginPath();
          ctx.arc(x + s/2, y + s/2, Math.max(1, s * 0.09), 0, 7);
          ctx.fill();
        }
        continue;
      }
      const c = edCol(code); // [EDIT-MODE hook] 原为 colorMap[code]；画笔可引入图纸里原本没有的色号
      const isCur = hlSet ? hlSet.has(code) : hl === code, isDone = !ed.on && state.done.has(code); // [EDIT-MODE hook]
      // 方 / 圆只是图纸画法（分享导出里可选圆豆），不代表拼没拼完。进度：在拼发光最亮；已拼是实色（有在拼色时稍退）；
      // 没拼的淡成底色并叠铅笔稿斜线——靠纹理而不是只靠透明度区分，浅色已拼和深色没拼也不会混
      const todo = progTodo(code, hl); // [TRACK-HOVER] 悬停预览只描边，不触发施工态淡化
      if (state.meltOn) { // [IRON hook] 烫豆预览：每格改画熔豆、不出色号；进度与烫前同一口径（没拼淡成底色叠斜线，在拼描荧光边）
        if (!ironUsesGL()) ironCells.push([x, y, s, todo ? progFade(code) : c, j, i]);
        if (todo) { if (s >= 4) todoCells.push(x, y); } else if (isCur) curCells.push(x0, j);
        continue;
      }
      if (isDone) ctx.globalAlpha = 1; // 已拼就是手里实打实的豆：始终满色，靠「满色 vs 淡稿」和没拼的拉开
      else if (todo) ctx.globalAlpha = 0.1;
      ctx.fillStyle = c.hex;
      ctx.fillRect(x, y, s + 0.5, s + 0.5);
      ctx.globalAlpha = 1;
      if (todo) { if (s >= 4) { ctx.fillStyle = hatchPattern(); ctx.fillRect(x, y, s + 0.5, s + 0.5); } continue; }
      if (isCur) curCells.push(x0, j);  // 在拼格 / 编辑态选色反馈：豆面照常画，网格线之后在这片区域的外轮廓上描荧光边
      if (s >= CODE_PX) { // 色号文字 [EDIT-MODE hook] 阈值与单击编辑共用
        ctx.fillStyle = txtOn(c.rgb);
        ctx.font = `600 ${Math.min(s * 0.30, 15)}px Rajdhani, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(c.code, x + s/2, y + s/2 + 0.5);
      }
    }
  }

  if (ironCells.length) ironDrawCells(ironCells); // [IRON hook] 先画完所有豆形、再统一揉色与开孔，后画的豆不会盖住先画的揉色
  if (todoCells.length) { // [IRON hook] 烫后没拼的豆：斜线叠在熔豆上（带纹理的烫法由质感层画豆，图纸画布叠在质感层之上）
    ctx.fillStyle = hatchPattern();
    for (let k = 0; k < todoCells.length; k += 2) ctx.fillRect(todoCells[k], todoCells[k + 1], s + 0.5, s + 0.5);
  }

  // 网格线（[IRON hook] 烫豆预览是成品视角，不画网格）
  if (!state.meltOn && s >= 7) {
    ctx.strokeStyle = 'rgba(15,25,35,.18)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = c0; i <= c1 + 1; i++) {
      const lx = state.mirror ? GW - i : i;
      const x = state.ox + lx * s;
      ctx.moveTo(x, state.oy + r0 * s); ctx.lineTo(x, state.oy + (r1 + 1) * s);
    }
    for (let j = r0; j <= r1 + 1; j++) {
      const y = state.oy + j * s;
      const xa = state.ox + (state.mirror ? GW - 1 - c1 : c0) * s;
      const xb = state.ox + (state.mirror ? GW - c0 : c1 + 1) * s;
      ctx.moveTo(xa, y); ctx.lineTo(xb, y);
    }
    ctx.stroke();
  }
  // 外框
  if (!state.meltOn) { ctx.strokeStyle = '#8A8272'; ctx.lineWidth = 1.5; ctx.strokeRect(state.ox, state.oy, GW * s, GH * s); }
  if (curCells.length && hlSet) {                // 多色高亮：按色分组，各描各色的荧光边
    const by = new Map();
    for (let k = 0; k < curCells.length; k += 2) {
      const code = grid[curCells[k + 1]][curCells[k]];
      if (!by.has(code)) by.set(code, []);
      by.get(code).push(curCells[k], curCells[k + 1]);
    }
    for (const [code, cells] of by) drawGlowEdge(cells, edCol(code), s, feedback.glow, state.meltOn);
  } else if (curCells.length) drawGlowEdge(curCells, edCol(hl), s, feedback ? feedback.glow : 1, state.meltOn);
  edDrawPops(s); edDrawPreviewOutline(s); edDrawSel(s); // [EDIT-MODE hook] 落位动画 + 预览区域描边
  islandDrawHover(s); // [ISLANDS hook] 悬停某个岛行时在画布叠高亮描边

  drawRulers(W, H, s);
  drawHud();
  ironGLDraw(); // [IRON hook] 带纹理的烫法由质感层画熔豆
}

/* 进度态（平面、3D、烫前烫后共用）：浏览态下选了在拼色或打过卡才生效；没拼 = 不是在拼色也没打卡 */
function progOn() { return !ed.on && (state.highlight !== null || state.done.size > 0); }
function progTodo(code, hl) { return progOn() && code !== hl && !state.done.has(code); }
/* 烫后没拼的豆：本色只留一成、其余是桌面色（与烫前 globalAlpha 0.1 同一观感），平面熔豆与质感层共用。
   缓存键带上本色 RGB：不同品牌色板会有同名色号、颜色却不同，只按色号取键换色板后会沿用上一个品牌的颜色 */
const _fade = new Map();
function progFade(code) {
  const c = edCol(code), key = code + '|' + c.rgb.join(',');
  let f = _fade.get(key);
  if (!f) {
    const rgb = c.rgb.map((v, k) => Math.round(IRON_TABLE[k] * 0.88 + v * 0.12));
    f = { code, rgb, hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('') };
    _fade.set(key, f);
  }
  return f;
}

/* 没拼的格子叠的铅笔稿斜线（6px 一条，对齐屏幕不对齐格子，缩放时疏密不变） */
let _hatch = null;
function hatchPattern() {
  if (_hatch) return _hatch;
  const t = document.createElement('canvas'); t.width = t.height = 6;
  const g = t.getContext('2d'); g.strokeStyle = 'rgba(15,25,35,.28)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(-1, 7); g.lineTo(7, -1); g.stroke();
  return (_hatch = ctx.createPattern(t, 'repeat'));
}

/* 高亮颜色的荧光边：在拼（辅助拼豆）与编辑态选色反馈共用。
 * 只描这片同色区域的外轮廓，光落在豆外侧（邻格与格缝），豆面本身一像素不改——深色豆也保持原色。
 * 光色：彩色取本色的高饱和提亮版（饱和度 ≥ 0.85、亮度 0.62–0.72，比豆本身亮），压在黑描边和米色底上都看得见；
 * 黑 / 白 / 灰这类无彩色没有可「发」的色相，统一用界面高亮青，深色豆也有清楚的荧光边。中心一道细亮线定位轮廓。
 * cells = [屏幕列, 行, ...]（镜像已换算成屏幕列）；glow = 1 常亮（悬停 / 在拼），> 1 = 点选那一下更亮，随后回落到 0 */
const GLOW_NEUTRAL = [0, 200, 200];   // --teal
function glowEdgeColor(rgb) {
  const [r, g, b] = rgb.map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  if (s < .18 || mx - mn < .08) return GLOW_NEUTRAL.slice();
  s = Math.max(.85, s); l = Math.min(.72, Math.max(.62, l + .2));
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
}
function drawGlowEdge(cells, c, s, glow = 1, noCodes = false) {
  if (glow <= 0.02) return noCodes ? undefined : drawGlowCodes(cells, c, s);
  const on = new Set();
  for (let k = 0; k < cells.length; k += 2) on.add(cells[k] + ',' + cells[k + 1]);
  const X = i => state.ox + i * s, Y = j => state.oy + j * s;
  const edge = new Path2D(), body = new Path2D();
  body.rect(0, 0, canvas.width, canvas.height);
  for (let k = 0; k < cells.length; k += 2) {
    const i = cells[k], j = cells[k + 1], x = X(i), y = Y(j);
    body.rect(x, y, s, s);
    if (!on.has((i - 1) + ',' + j)) { edge.moveTo(x, y); edge.lineTo(x, y + s); }
    if (!on.has((i + 1) + ',' + j)) { edge.moveTo(x + s, y); edge.lineTo(x + s, y + s); }
    if (!on.has(i + ',' + (j - 1))) { edge.moveTo(x, y); edge.lineTo(x + s, y); }
    if (!on.has(i + ',' + (j + 1))) { edge.moveTo(x, y + s); edge.lineTo(x + s, y + s); }
  }
  const [R, G, B] = glowEdgeColor(c.rgb), k = Math.min(glow, 2.2), lw = Math.max(1.5, s * .1);
  ctx.save();
  ctx.clip(body, 'evenodd');                    // 只画在高亮豆之外：豆面不被光罩住
  ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
  ctx.shadowColor = `rgba(${R},${G},${B},1)`;
  ctx.strokeStyle = `rgba(${R},${G},${B},${Math.min(1, .55 * k)})`;
  ctx.shadowBlur = Math.max(6, s * .6) * (.8 + .35 * k) * dpr; ctx.lineWidth = lw * (1.6 + .5 * k);
  ctx.stroke(edge);                             // 外层光晕：向四周散开
  ctx.shadowBlur = Math.max(3, s * .25) * dpr; ctx.lineWidth = lw * 1.4;
  ctx.strokeStyle = `rgba(${R},${G},${B},${Math.min(1, .9 * k)})`;
  ctx.stroke(edge);                             // 中层：贴着轮廓的荧光带
  ctx.shadowBlur = 0; ctx.lineWidth = Math.max(1, lw * .55);
  ctx.strokeStyle = `rgba(255,255,255,${Math.min(.95, .6 * k)})`;
  ctx.stroke(edge);                             // 芯线：一道细亮线把轮廓定死
  ctx.restore();
  if (!noCodes) drawGlowCodes(cells, c, s);
}
function drawGlowCodes(cells, c, s) {
  if (s < CODE_PX) return;
  ctx.fillStyle = txtOn(c.rgb); ctx.font = `600 ${Math.min(s * 0.30, 15)}px Rajdhani, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let k = 0; k < cells.length; k += 2) ctx.fillText(c.code, state.ox + cells[k] * s + s / 2, state.oy + cells[k + 1] * s + s / 2 + 0.5);
}

function drawRulers(W, H, s) {
  const step = [1, 5, 10, 20, 50, 100].find(k => k * s >= 22) || 100; // 相邻刻度至少 22px
  ctx.fillStyle = '#E3DDCF';
  ctx.fillRect(0, 0, W, RULER); ctx.fillRect(0, 0, RULER, H);
  ctx.strokeStyle = '#C9C2B2'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, RULER + .5); ctx.lineTo(W, RULER + .5);
  ctx.moveTo(RULER + .5, 0); ctx.lineTo(RULER + .5, H); ctx.stroke();
  ctx.fillStyle = '#5B6B7A'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '600 11px Rajdhani, sans-serif';
  for (let i = 0; i < GW; i++) {
    const n = i + 1;
    if (n % step !== 0 && n !== 1 && n !== GW) continue;
    if (n !== GW && n !== 1 && (GW - n) * s < 22) continue; // 太靠近末端的整刻度让给末端编号，不叠字
    const x = state.ox + (state.mirror ? GW - 1 - i : i) * s + s / 2;
    if (x < RULER + 8 || x > W - 8) continue;
    ctx.fillText(n, x, RULER / 2);
  }
  for (let j = 0; j < GH; j++) {
    const n = j + 1;
    if (n % step !== 0 && n !== 1 && n !== GH) continue;
    if (n !== GH && n !== 1 && (GH - n) * s < 22) continue;
    const y = state.oy + j * s + s / 2;
    if (y < RULER + 8 || y > H - 8) continue;
    ctx.fillText(n, RULER / 2, y);
  }
}

/* 画布角标只放编辑时这一下操作的即时反馈（如「画笔 · 本次 +20 颗」），平时为空、不显示。
 * 规格 / 色板 / 颗数在 02、03 底部栏已有，正在下豆的颜色在 #hlStatus，画布上不重复。 */
function drawHud() {
  const el = document.getElementById('hud');
  const t = edHudText(); // [EDIT-MODE hook]
  el.innerHTML = t; el.classList.toggle('show', !!t);
  el.classList.toggle('note', !!(t && typeof edNoteMsg === 'string' && edNoteMsg && t === edNoteMsg)); // [EDIT-MODE hook] 操作反馈：3D 下也显示
  document.getElementById('zoomPct').textContent = Math.round(state.scale * 100 / fitScale()) + '%';
  document.getElementById('zoomFit').disabled = isFitView();
}
/* 是否正处于适配态（100% 且居中）：此时「恢复」置灰 */
function isFitView() {
  const fs = fitScale(), w = canvas.width / dpr - RULER - 24, h = canvas.height / dpr - RULER - 24;
  return Math.abs(state.scale / fs - 1) < 0.005
    && Math.abs(state.ox - (RULER + (w - GW * fs) / 2 + 12)) < 1
    && Math.abs(state.oy - (RULER + (h - GH * fs) / 2 + 12)) < 1;
}

