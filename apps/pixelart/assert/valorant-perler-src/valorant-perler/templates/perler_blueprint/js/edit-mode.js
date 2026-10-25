/* =====================================================================
 * [EDIT-MODE] 编辑态模块 BEGIN
 * 专业编辑模式：画笔 / 填充 / 橡皮擦 / 吸管 + 撤销重做 + 保存。
 * 交互约定：鼠标悬停 = 预览（不改矩阵），按下 = 生效。
 * 数据约定：直接改 grid（当前色板 × 色数档位下的色号矩阵）；统计由 syncCounts 重算；
 *          保存复用 persistGrid() 的 localStorage 键，与「还原初始图纸」共用一套机制。
 * 与原模板的接点均标注 [EDIT-MODE hook]，合并时按此检索：
 *   draw()        读 ed.preview 覆盖格色、编辑态关闭施工高亮/已拼圆珠、画预览轮廓
 *   drawHud()     追加 edHudText()
 *   mousedown     编辑态左键交给 edPointerDown，空格/右键/中键仍平移
 *   click/dblclick/mousemove/Escape  编辑态屏蔽旧换色浮窗与双击适配
 * ===================================================================== */
/* 套索选法：圈选 = 圈里有豆的格子全选；按色圈选 = 先选一个或多个颜色（点图纸格子 / 取色 / 颜色区），再圈，只选圈里这些颜色的格子。
 * 选中后选区与颜色解绑：用填充在选区内点一下 = 整块换成当前色。label 写在套索按钮上，note 是切换时的角标 */
const LASSO_MODES = {
  draw:  { label: '套索', note: '圈选：圈里的像素全部选中' },
  color: { label: '按色', note: '按色圈选：先点格子或颜色区选颜色，再圈' },
};
const ed = {
  on: false,
  tool: 'brush',        // brush | fill | eraser | picker | lasso | hand
  prevTool: 'brush',    // 吸管取完色回到的工具（填充仍回填充，其余回画笔：取了色就是要用它画）
  handPrev: 'brush',    // 画布右下角「移动」再点一次回到的工具
  sel: null,            // 套索选区：{ cells: [[idx, code], ...], set: Set(idx) }；套索 / 移动 / 填充 / 取色下保留，画笔 / 橡皮清掉
  lassoColors: new Set(), // 按色圈选已选的颜色：图纸上同色格持续高亮，圈选只收这些颜色
  lasso: null,          // 套索拖动中：{ kind: 'draw', pts } 圈选 | { kind: 'move', from, dx, dy } 平移
  lassoMode: (() => { try { const m = localStorage.getItem('perler-lasso-mode'); return LASSO_MODES[m] ? m : 'draw'; } catch (e) { return 'draw'; } })(),
  hist: null,           // 退出编辑时的矩阵签名：再进编辑时矩阵没被外部改过，撤销栈接着用
  color: null,          // 当前色（当前色板色号；'' = 空白，不放豆）
  shift: false,         // 填充时按住 Shift = 全图同色一起换
  pops: [],             // 落位动画队列：{ idx, code, out, t0 }，见「滑豆手感」段
  undo: [], redo: [],   // 每步 = { label, changes: [[idx, from, to], ...] }
  preview: null,        // Map(idx -> code)：悬停预览覆盖，不写入 grid
  previewInfo: '',
  stroke: null,         // 画笔/橡皮按住拖动中：{ changes, touched:Set, last:[i,j] }
  base: null,           // 进入编辑或上次保存时的矩阵快照（「放弃」回到这里）
  dirty: false,
  space: false,         // 空格按住 = 临时平移
  hoverCell: null,
};
/* 画笔光标：单针豆笔图（48px 内嵌 PNG，红色镊式双臂+银针纵向穿透白色圆柱豆串，针尖朝左下，热点取最靠左下的不透明像素即针尖） */
const BRUSH_IMG = 'data:image/png;base64,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';  // 豆笔图：编辑态悬停光标与工具条按钮共用
const BRUSH_CURSOR = (() => {
  const IMG = BRUSH_IMG;
  const S = 48;
  const img = new Image(); img.src = IMG;
  // 同步取热点：解码后测不透明包围；同步阶段先用几何默认（针尖豆端面在左下角 0,47）
  let hx = 0, hy = S - 1;
  return { css: `url(${IMG}) ${hx} ${hy}, crosshair`, ready: new Promise(res => { img.onload = () => {
    const c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, S, S).data;
    let best = Infinity;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++)
      if (d[(j * S + i) * 4 + 3] > 128 && i - j < best) { best = i - j; hx = i; hy = j; }
    res(`url(${IMG}) ${hx} ${hy}, crosshair`);
  }; }) };
})();
/* 填充 / 橡皮 / 取色 / 套索的光标：与画笔同一做法，用工具条上的工具图（48px）当光标，热点落在工具干活的那一端，
 * 习惯是左下角为接触点：填充 = 倒出的红漆水洼中心、橡皮 = 擦头最下端的尖角（光标图转 180° 让白面朝下）、取色 = 吸管尖、套索 = 尾巴尖 */
const TOOL_HOT = { fill: [36, 43], eraser: [15, 44], picker: [4, 45], lasso: [14, 44] };
let eraserFlipped = null; // 橡皮光标图：工具图转 180°（工具条上的图标不变），首次用到时生成并缓存
function edToolCursorUrl(tool, img) {
  if (tool !== 'eraser') return img.src;
  if (!eraserFlipped && img.complete && img.naturalWidth) {
    const c = document.createElement('canvas'); c.width = c.height = 48;
    const x = c.getContext('2d'); x.translate(48, 48); x.rotate(Math.PI); x.drawImage(img, 0, 0, 48, 48);
    try { eraserFlipped = c.toDataURL('image/png'); } catch (e) { eraserFlipped = ''; }
  }
  return eraserFlipped || null;
}
/* 移动（手掌）光标：手图缩到 24px（按钮上是 26px，光标更小才贴手），热点在掌心；空格临时平移、悬在套索选区上也用它。
 * 首次用到时从按钮里的手图生成 24px 版本并缓存，图加载失败就退回系统 grab。 */
const HAND_CURSOR = { url: null };
function edHandCursorCss() {
  if (HAND_CURSOR.url) return `url(${HAND_CURSOR.url}) 12 13, grab`;
  const img = document.querySelector('#edHandBtn img');
  if (img && img.complete && img.naturalWidth) {
    const c = document.createElement('canvas'); c.width = c.height = 24;
    c.getContext('2d').drawImage(img, 0, 0, 24, 24);
    try { HAND_CURSOR.url = c.toDataURL('image/png'); } catch (e) { HAND_CURSOR.url = ''; }
    if (HAND_CURSOR.url) return `url(${HAND_CURSOR.url}) 12 13, grab`;
  }
  return 'grab';
}
function edToolCursorCss(tool) {
  const img = document.querySelector(`#edBar [data-tool="${tool}"] img`), h = TOOL_HOT[tool];
  const url = img && h ? edToolCursorUrl(tool, img) : null;
  return url ? `url(${url}) ${h[0]} ${h[1]}, crosshair` : 'crosshair';
}
const EMPTY = { code: '空白', name: '清除', hex: 'transparent', rgb: [245, 242, 234] };
const edCol = code => code ? PAL[code] : EMPTY;
const snapshot = () => grid.map(r => r.slice());
/* 未保存 = 当前图纸和上次保存时不同；撤销 / 重做回到已保存状态时就不算未保存（版本按钮不带 *，保存按钮置灰） */
const edDiffBase = () => !ed.base || grid.some((r, y) => r.some((c, x) => c !== ed.base[y][x]));
/* 编辑态光标写到当前看法的画布上 [VIEW-3D hook] */
const edCursorEl = () => state.mode === '3d' && V3 && V3.dom() ? V3.dom() : canvas;

/* 撤销栈对应的矩阵：规格 / 色板 / 色数 + 当前格子。退出时记下，再进编辑时一致才接着用旧撤销栈 */
function edHistSig() { return verCombo(state.size, state.palette, state.budget) + '|' + grid.map(r => r.join(',')).join(';'); }
const ED_UNDO_MAX = 1000;   // 撤销步数上限，防止长时间编辑占满内存

let edRaf = 0;
function edRequestDraw() { if (!edRaf) edRaf = requestAnimationFrame(() => { edRaf = 0; draw(); }); }

/* ---------- 进入 / 退出 ---------- */
function edEnter(color) {
  if (ed.on) { if (color !== undefined) edSetColor(color); return; }
  if (state.view !== 'grid') document.querySelector('.viewtab[data-view="grid"]').click();
  if (color !== undefined) ed.color = color;
  ed.on = true; ed.base = snapshot(); ed.dirty = false; ed.sel = null; ed.lasso = null;
  if (ed.hist !== edHistSig()) { ed.undo = []; ed.redo = []; } // 换了规格 / 色板 / 色数，或矩阵在编辑外被改过：旧撤销栈对不上
  // 回来改图纸就不再提示正在拼哪个色；说明并进左上角编辑徽标的第二行，和徽标一起呼吸一下就隐去，不另起提示条
  const sub = document.getElementById('edBadgeSub');
  if (state.highlight) { const c = state.highlight; setCurrent(c); sub.textContent = `已取消正在拼 ${edCol(c).code}`; sub.classList.add('show'); }
  else sub.classList.remove('show');
  if (ed.color === null || (ed.color && !PAL[ed.color])) {
    const counts = D.specs[state.size].counts;
    ed.color = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || PALS[state.palette].colors[0].code;
  }
  document.body.classList.add('editing');
  edSetTool('brush'); edUpdateBar(); refreshAll();
  edBrowseTip(null);
  edPalShow(false);
  edHandEnter(); // 进入编辑站：右下角移动按钮弹入提示
  flowOnEdit(); // [FLOW hook] 手机端：切到编辑站，色板收起等玩家点色块再开
  /* 存不了文件的内嵌页（WorkBuddy 产物区）：改动只活在这一页，第一次进编辑就先说清楚，免得改完才发现存不下来 */
  if (PC_SANDBOX && !edSandboxTold) { edSandboxTold = true; toast('这里改的图纸关掉就会丢，要保存请用默认浏览器打开：点右上角「···」→「在外部浏览器打开」', 8000, true); }
}
let edSandboxTold = false;
/* 页内确认框：buttons = [{ label, value, primary }]，返回被点按钮的 value；Esc / 点遮罩 = null，Enter = 主按钮 */
let edModalDone = null;
function edConfirm(title, msg, buttons) {
  const box = document.getElementById('edModal'), row = document.getElementById('edModalB');
  document.getElementById('edModalT').textContent = title;
  document.getElementById('edModalM').textContent = msg;
  row.innerHTML = '';
  return new Promise(resolve => {
    edModalDone = v => { box.classList.remove('show'); edModalDone = null; resolve(v); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label; if (b.primary) el.className = 'primary';
      el.onclick = () => edModalDone(b.value);
      row.appendChild(el);
    }
    box.classList.add('show');
    (row.querySelector('.primary') || row.lastChild).focus();
  });
}
document.getElementById('edModal').addEventListener('mousedown', e => { if (e.target.id === 'edModal' && edModalDone) edModalDone(null); });
window.addEventListener('keydown', e => {
  if (!edModalDone) return;
  e.preventDefault(); e.stopImmediatePropagation(); // 确认框打开时屏蔽编辑快捷键
  if (e.key === 'Escape') edModalDone(null);
  else if (e.key === 'Enter') document.querySelector('#edModalB .primary').click();
}, true);

/* 离开编辑：有改动就自动存成新版本（版本只增不减，不会丢东西），不打断玩家做决定；不要这次改动用右上角「放弃」。
 * 撤销栈不随保存或退出清空，回来还能接着撤销。force = 不保存直接退出（规格被删除等场合） */
async function edExit(force) {
  if (!force && ed.dirty) edSave();
  ed.hist = edHistSig();
  edNoteMsg = ''; clearTimeout(edNoteTm);
  ed.on = false; ed.preview = null; ed.stroke = null; ed.sel = null; ed.lasso = null; ed.lassoColors.clear(); edColorHover = null; edColorFlash = null;
  edLassoMenuShow(false); edColorHoldEnd();
  document.body.classList.remove('editing');
  if (document.body.classList.contains('dirty')) { // 带着未保存改动强制退出（规格被删等）：顶栏换回导出，播划入动画
    document.body.classList.remove('dirty');
    document.body.classList.add('ed-left');
  }
  edPalShow(false); refreshAll();
  flowAfterExit(); // [FLOW hook] 手机端：在编辑站点「完成」后进入 3D 站
}

/* ---------- 工具条 ---------- */
function edSetTool(t) {
  if (t === 'picker' && ed.tool !== 'picker') ed.prevTool = ed.tool;
  if (t === 'hand' && ed.tool !== 'hand') ed.handPrev = ed.tool;
  if (t === 'brush' || t === 'eraser') { ed.sel = null; ed.lasso = null; } // 移动 / 填充 / 取色都要接着用选区，留着
  if (t !== 'lasso') edLassoMenuShow(false);
  ed.tool = t;
  edLassoBodySync();
  document.querySelectorAll('#edBar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  document.getElementById('edHandBtn').classList.toggle('on', t === 'hand');
  edRefreshHover();
}
/* 工具 / 颜色 / 矩阵变了但鼠标没动：按最后鼠标位置重算预览 */
function edRefreshHover() {
  if (ed.lasso) { edRequestDraw(); return; }       // 套索拖动中：预览归套索管
  ed.preview = null; ed.hoverCell = null;
  if (ed.on && ed.lastMouse && !ed.stroke) edHover(ed.lastMouse); else edRequestDraw();
}
document.querySelectorAll('#edBar [data-tool]').forEach(b => {
  if (b.dataset.tool === 'lasso') {                // 套索：点按钮弹出选法选单，再点一次收起
    b.onclick = () => { if (ed.tool !== 'lasso') edSetTool('lasso'); edLassoMenuShow(!edLassoMenu.classList.contains('show')); };
    return;
  }
  b.title += ' · 再次点击可取消选中，切换为移动（H）';
  b.onclick = () => edSetTool(ed.tool === b.dataset.tool ? 'hand' : b.dataset.tool); // 再点当前工具 = 取消选中
});
/* ---------- 套索选法选单 ----------
 * 点套索按钮弹出，两种选法各一行，当前选法高亮；选单挪到 body 下 fixed 定位，免得被工具条的横向滚动裁掉。
 * 下方放得下就落在按钮下面，否则（手机上编辑栏在底部）弹到按钮上面。点选单外任意处、Esc、换工具都会收起。 */
const edLassoMenu = document.getElementById('edLassoMenu');
const edLassoBtn = document.querySelector('#edBar [data-tool="lasso"]');
document.body.appendChild(edLassoMenu);
function edLassoMenuShow(v) {
  edLassoMenu.classList.toggle('show', v);
  edLassoBtn.setAttribute('aria-expanded', String(v));
  if (!v) return;
  const r = edLassoBtn.getBoundingClientRect(), mh = edLassoMenu.offsetHeight, mw = edLassoMenu.offsetWidth;
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 6) top = Math.max(6, r.top - mh - 6);
  edLassoMenu.style.top = top + 'px';
  edLassoMenu.style.left = Math.max(6, Math.min(r.left + r.width / 2 - mw / 2, innerWidth - mw - 6)) + 'px';
}
function edLassoModeSet(m, note) {
  ed.lassoMode = m;
  try { localStorage.setItem('perler-lasso-mode', m); } catch (e) {}
  edLassoSync();
  ed.hoverCell = null; edRefreshHover();
  if (note) edNote(`套索 · ${LASSO_MODES[m].note}`, 2000);
}
function edLassoSync() {
  document.getElementById('edLassoLbl').textContent = LASSO_MODES[ed.lassoMode].label;
  edLassoBodySync();
  edLassoMenu.querySelectorAll('[data-lasso]').forEach(b => {
    const on = b.dataset.lasso === ed.lassoMode;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  });
}
edLassoMenu.querySelectorAll('[data-lasso]').forEach(b => {
  b.onclick = () => { edLassoModeSet(b.dataset.lasso, true); edLassoMenuShow(false); };
});
edLassoSync();
document.addEventListener('pointerdown', e => {
  if (edLassoMenu.classList.contains('show') && !edLassoMenu.contains(e.target) && !edLassoBtn.contains(e.target)) edLassoMenuShow(false);
}, true);
window.addEventListener('resize', () => edLassoMenuShow(false));
document.addEventListener('scroll', e => { if (edLassoMenu.classList.contains('show') && !edLassoMenu.contains(e.target)) edLassoMenuShow(false); }, true);
/* 移动（手掌）不算编辑工具，单独放在画布右下角，只在图纸编辑站出现；进入编辑站时弹入一下提示位置。
 * 移动态下按住选区拖 = 移动选区，按在选区外拖 = 挪视角；再点一次回到原来的工具 */
function edHandEnter() {
  const b = document.getElementById('edHandBtn');
  b.classList.remove('enter'); void b.offsetWidth; b.classList.add('enter');
}
/* 预热：手图加载完成后立刻生成 24px 光标，浏览态（规格 / 辅助拼豆 / 看图）悬停就是这只手，不闪系统光标 */
{
  const img = document.querySelector('#edHandBtn img');
  const warm = () => edHandCursorCss();
  if (img) { if (img.complete && img.naturalWidth) warm(); else img.addEventListener('load', warm, { once: true }); }
}
document.getElementById('edHandBtn').addEventListener('animationend', e => { if (e.animationName === 'edHandCue') e.currentTarget.classList.remove('cue'); if (e.animationName === 'edHandIn') e.currentTarget.classList.remove('enter'); });
const edSelHit = cell => !!(cell && ed.sel && state.mode === '2d' && ed.sel.set.has(cell[1] * GW + cell[0]));
document.getElementById('edHandBtn').onclick = () => edSetTool(ed.tool === 'hand' ? (ed.handPrev === 'hand' ? 'brush' : ed.handPrev) : 'hand');
/* 画笔按钮图标与悬停光标同款豆笔图 */
{
  const bi = document.querySelector('#edBar [data-tool="brush"] i');
  if (bi) { const img = document.createElement('img'); img.src = BRUSH_IMG; img.alt = '画笔'; img.className = 'brush-ico'; bi.replaceWith(img); }
}
function edSetColor(code) {
  ed.color = code;
  if (ed.tool === 'eraser' || ed.tool === 'picker' || ed.tool === 'hand' && !ed.sel) edSetTool('brush'); // 有选区时只换当前色，选区留着
  edUpdateBar(); edRenderPal(); edRefreshHover();
}
/* ---------- 选色反馈：临时画布高亮，不写入图纸 ----------
 * 与辅助拼豆「正在拼」同一种画法：被指到的颜色带本色光晕浮起，其他格子不变。
 * 桌面悬停 = 亮；点选 = 更亮一下再回到正常。触屏没有悬停，只有点选那一下，两边逻辑一致 */
let edColorHover = null, edColorFlash = null;
const edReduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function edColorFeedback() {
  if (!ed.on || ed.stroke) return null;
  const now = performance.now();
  if (edColorFlash && now >= edColorFlash.until) edColorFlash = null;
  if (edColorFlash) {
    edRequestDraw();
    const k = edReduceMotion() ? 1 : (edColorFlash.until - now) / 650;   // 1 → 0：点下最亮，随后回到正常
    return { code: edColorFlash.code, strength: k, glow: 2.2 * k };
  }
  return edColorHover !== null ? { code: edColorHover, strength: 1, glow: 1 } : edLassoColorsLit() ? edLassoColorsFb() : null;
}
/* 按色圈选已选的颜色：套索在按色选法下一直高亮（多色同时亮）；悬停 / 点选色块的那一下优先 */
const edLassoColorsLit = () => ed.tool === 'lasso' && ed.lassoMode === 'color' && ed.lassoColors.size > 0 && !(ed.lasso && ed.lasso.kind === 'move');
function edLassoColorsFb() { const codes = ed.lassoColors; return { code: codes.values().next().value, codes, strength: 1, glow: 1 }; }
function edColorPreview(code) {
  if (!ed.on || ed.stroke || isCoarse()) return;
  edColorHover = code; ed.preview = null; edRequestDraw();
}
function edColorLeave() {
  edColorHover = null;
  edRequestDraw();
}
/* 手机长按色块：按住约 0.3 秒后图纸上这个色号一直亮着（同电脑悬停的画法），松手 / 滑动滚动 / 系统取消触摸即恢复。
 * 长按后的那次 click 不算选色（edColorChoose 读 el.edHeld）；短按照常选色。
 * 松手的判定除了色块自己的 pointerup，还挂在 document 上：长按期间色块被重绘替换掉也不留残留高亮。 */
const ED_COLOR_HOLD_MS = 300;
let edColorHold = null;   // { el, code, x, y, tm, on }
function edColorHoldEnd() {
  if (!edColorHold) return;
  const h = edColorHold; edColorHold = null; clearTimeout(h.tm);
  if (h.on) edColorLeave();
}
function edColorHoldBind(el, code) {
  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !ed.on) return;
    edColorHoldEnd(); el.edHeld = false;
    const h = edColorHold = { el, code, x: e.clientX, y: e.clientY, t0: e.timeStamp, on: false };
    h.tm = setTimeout(() => {
      if (edColorHold !== h || ed.stroke) return;
      h.on = true; el.edHeld = true;
      edColorFlash = null; edColorHover = code; ed.preview = null; edRequestDraw();
      const n = code ? grid.reduce((s, row) => s + row.filter(x => x === code).length, 0) : 0;
      edNote(code ? `${code} · ${edCol(code).name} · ${n ? n + ' 颗' : '图纸中暂无'}` : '空白', 1600);
    }, ED_COLOR_HOLD_MS);
  });
  el.addEventListener('pointermove', e => {
    const h = edColorHold;
    if (h && h.el === el && Math.abs(e.clientX - h.x) + Math.abs(e.clientY - h.y) > 8) { if (!h.on) el.edHeld = false; edColorHoldEnd(); }
  });
  el.addEventListener('contextmenu', e => { if (edColorHold && edColorHold.el === el || el.edHeld) e.preventDefault(); });
}
/* 松手时按真实按住时长判定：主线程卡顿让计时器晚到或早到时，不把一次短按误当长按（短按照常选色） */
for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, e => {
  if (e.pointerType !== 'touch' || !edColorHold) return;
  if (t === 'pointerup' && e.timeStamp - edColorHold.t0 < ED_COLOR_HOLD_MS) edColorHold.el.edHeld = false;
  edColorHoldEnd();
}, true);
document.addEventListener('lostpointercapture', e => { if (edColorHold && e.target === edColorHold.el) edColorHoldEnd(); }, true);
document.addEventListener('scroll', () => { if (edColorHold && !edColorHold.on) edColorHoldEnd(); }, true);
/* 色号区防误选：手指在编辑栏里滑过（含松手后的惯性滚动）之后 250ms 内的点按，以及按下后挪动超过 8px 的点按，都不算选色。
 * 只认手指 / 滚轮带起的滚动，脚本里的 scrollIntoView 不算 */
let edSwipeAt = -1e9, edScrollAt = -1e9, edTapFrom = null;
document.addEventListener('touchmove', e => { if (e.target.closest && e.target.closest('#dock')) edSwipeAt = performance.now(); }, { passive: true, capture: true });
document.addEventListener('wheel', e => { if (e.target.closest && e.target.closest('#dock')) edSwipeAt = performance.now(); }, { passive: true, capture: true });
document.addEventListener('scroll', () => { if (performance.now() - edSwipeAt < 1500) edScrollAt = performance.now(); }, true);
document.addEventListener('pointerdown', e => { edTapFrom = [e.clientX, e.clientY, performance.now() - Math.max(edScrollAt, 0) < 250]; }, true);
function edTapIsScroll(e) {
  if (!e || !e.isTrusted || !e.detail || !edTapFrom) return false;   // 脚本 / 键盘触发的点击照常生效
  return edTapFrom[2] || Math.abs(e.clientX - edTapFrom[0]) + Math.abs(e.clientY - edTapFrom[1]) > 8;
}
function edColorChoose(code, e) {
  if (e && e.currentTarget && e.currentTarget.edHeld) { e.currentTarget.edHeld = false; return; } // 长按看过高亮后松手，不算选色
  if (edTapIsScroll(e)) return;
  edColorHover = null;
  if (ed.tool === 'lasso' && ed.lassoMode === 'color') {   // 按色圈选：颜色区点色 = 加入 / 去掉要圈的颜色，当前色不动
    if (code) edLassoColorToggle(code); else edNote('空白格没有豆子，不能按色圈选');
    edPalShow(false); return;
  }
  const tool = ed.tool;
  edSetColor(code);
  if (ed.tool !== tool) edSetTool(tool);
  edPalShow(false);
  edColorFlash = { code, until: performance.now() + (edReduceMotion() ? 150 : 650) };
  const c = edCol(code), n = code ? grid.reduce((sum, row) => sum + row.filter(x => x === code).length, 0) : 0;
  if (ed.sel && ed.tool !== 'fill') edNote(`已选 ${c.code} · 切到填充、在选区里点一下 = 选区整块换成它`, 2400);
  else if (ed.sel) edNote(`已选 ${c.code} · 在选区里点一下 = 整块换成它`, 2400);
  else
  edNote(code ? `已选 ${c.code} · ${c.name} · ${n ? n + ' 颗' : '图纸中暂无'}` : '已选 空白 · 用于清除格子');
  document.getElementById('edChipSw').getAnimations().forEach(a => a.cancel());
  if (!edReduceMotion()) {
    const frames = [{ transform: 'scale(1)' }, { transform: 'scale(.88)', offset: .25 }, { transform: 'scale(1.10)', offset: .65 }, { transform: 'scale(1)' }];
    const item = [...document.querySelectorAll('#edColorGrid .ed-count')].find(e => e.dataset.code === code);
    for (const el of [item, document.getElementById('edChipSw')]) {
      if (el) { el.getAnimations().forEach(a => a.cancel()); el.animate(frames, { duration: 320, easing: 'ease-out' }); }
    }
  }
  edRequestDraw();
}
function edUpdateBar() {
  const c = edCol(ed.color), sw = document.getElementById('edChipSw');
  sw.classList.toggle('empty', !ed.color);
  sw.style.background = ed.color ? c.hex : '';
  document.getElementById('edChipCd').textContent = c.code;
  document.getElementById('edUndo').disabled = !ed.undo.length;
  document.getElementById('edRedo').disabled = !ed.redo.length;
  // 顶栏右侧按钮由 body.dirty 决定（css/edit-mode.css）：有未保存改动 = 放弃 / 保存，没有 = 导出；改动清空那一刻才播划入动画
  const wasDirty = document.body.classList.contains('dirty');
  document.body.classList.toggle('dirty', ed.dirty);
  if (wasDirty && !ed.dirty) document.body.classList.add('ed-left');
  // [VERSIONS hook] 未保存状态一变就重画版本按钮：保存后「v5*」立刻变「v5」，开始改动立刻带「*」
  if (ed.dirty !== ed.verDirty) { ed.verDirty = ed.dirty; verDecorate(); }
}

/* ---------- 矩阵改动：生效 / 撤销 / 重做 ---------- */
function edSetCell(idx, code) { grid[(idx / GW) | 0][idx % GW] = code; }
function edAfterChange() {
  syncCounts(); buildColorMap(); refreshAll(); edUpdateBar(); edRenderPal(); edRefreshHover();
}
function edCommit(changes, label) {
  if (!changes.length) return;
  ed.undo.push({ label, changes }); ed.redo = []; ed.dirty = true;
  if (ed.undo.length > ED_UNDO_MAX) ed.undo.shift();
  edAfterChange();
  edNote(`${label} · ${edDelta(changes)}`);
}
function edUndo() {
  const op = ed.undo.pop(); if (!op) return;
  ed.sel = null; ed.lasso = null;                   // 选区里记的是旧格色，撤销后作废
  for (let k = op.changes.length - 1; k >= 0; k--) edSetCell(op.changes[k][0], op.changes[k][1]);
  ed.redo.push(op); ed.dirty = edDiffBase(); ed.preview = null; edAfterChange();
  edNote(`已撤销 ${op.label}`);
}
function edRedo() {
  const op = ed.redo.pop(); if (!op) return;
  ed.sel = null; ed.lasso = null;
  for (const [idx, , to] of op.changes) edSetCell(idx, to);
  ed.undo.push(op); ed.dirty = edDiffBase(); ed.preview = null; edAfterChange();
  edNote(`已重做 ${op.label}`);
}
document.getElementById('edUndo').onclick = edUndo;
document.getElementById('edRedo').onclick = edRedo;

/* ---------- 保存 / 放弃 ---------- */
/* toFile = 玩家主动点「保存」/ ⌘S：另存一份带着改动的新 HTML（[SAVE-FILE]）；离开编辑的自动保存只存本地，不弹分享 */
function edSave(toFile) {
  persistGrid(); // 复用原模板的本地保存：按「任务 × 规格」存 localStorage，下次打开读改动版
  const v = verSave(); // [VERSIONS hook] 每次保存生成一个小版本 v1、v2…
  ed.base = snapshot(); ed.dirty = false; edUpdateBar();
  const tag = v ? `已保存 · v${v.n}` : '已保存';
  toast(tag);
  if (toFile !== true) return;
  saveFileExport().then(r => {
    if (r === 'download') toast(`${tag} · 新图纸文件已下载，以后打开它就能接着改`, 3600);
    else if (r === 'blocked') toast(PC_SANDBOX ? `${tag} · 关掉页面改动会丢失，长期保存请用默认浏览器打开：点右上角「···」→「在外部浏览器打开」` : `${tag} · 关掉页面改动会丢失`, 8000, true);
    else if (r === 'shared') toast(`${tag} · 新图纸文件已导出，以后打开它就能接着改`, 3600);
  });
}
async function edDiscard() {
  if (!ed.dirty) return;
  const n = ed.undo.reduce((a, op) => a + op.changes.length, 0);
  const v = await edConfirm('放弃本次改动？', `将撤回上次保存之后的 ${ed.undo.length} 步操作（共 ${n} 格），图纸将恢复至上次保存的状态。`, [
    { label: '取消', value: null },
    { label: '放弃改动', value: true, primary: true },
  ]);
  if (!v) return;
  grid = ed.base.map(r => r.slice());
  ed.undo = []; ed.redo = []; ed.dirty = false; ed.preview = null; ed.sel = null; ed.lasso = null;
  edAfterChange(); toast('已放弃未保存的改动');
}
document.getElementById('edSave').onclick = () => edSave(true);
document.getElementById('edDiscard').onclick = edDiscard;

/* ---------- 填充：4 邻接同色连通区域（「围住的区域」；空格子区域也算，可给背景铺色） ---------- */
function edFloodRegion(i0, j0) {
  const target = grid[j0][i0], seen = new Uint8Array(GW * GH), out = [];
  const stack = [j0 * GW + i0]; seen[stack[0]] = 1;
  while (stack.length) {
    const idx = stack.pop(); out.push(idx);
    const i = idx % GW, j = (idx / GW) | 0;
    if (i > 0      && !seen[idx - 1]  && grid[j][i - 1] === target) { seen[idx - 1] = 1;  stack.push(idx - 1); }
    if (i < GW - 1 && !seen[idx + 1]  && grid[j][i + 1] === target) { seen[idx + 1] = 1;  stack.push(idx + 1); }
    if (j > 0      && !seen[idx - GW] && grid[j - 1][i] === target) { seen[idx - GW] = 1; stack.push(idx - GW); }
    if (j < GH - 1 && !seen[idx + GW] && grid[j + 1][i] === target) { seen[idx + GW] = 1; stack.push(idx + GW); }
  }
  return { target, cells: out };
}

/* 填充范围：默认同色连通区域；按住 Shift = 全图所有同色格 */
function edFillCells(i, j) {
  if (!ed.shift) return { ...edFloodRegion(i, j), global: false };
  const target = grid[j][i], cells = [];
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (grid[y][x] === target) cells.push(y * GW + x);
  return { target, cells, global: true };
}

/* ---------- 悬停预览：按下之前让玩家看到「按下去会变成什么样」 ---------- */
function edHover(e) {
  if (ed.stroke || ed.lasso) return;
  ed.lastMouse = { clientX: e.clientX, clientY: e.clientY };
  const cell = cellAt(e);
  const key = cell ? cell[1] * GW + cell[0] : -1;
  if (key === ed.hoverCell && ed.preview !== null) return; // 同一格不重复计算
  ed.hoverCell = key;
  ed.preview = null; ed.previewInfo = '';
  const hand = ed.space || ed.tool === 'hand' && !edSelHit(cell);
  const curCss = typeof BRUSH_CURSOR === 'string' ? BRUSH_CURSOR : BRUSH_CURSOR.css;
  edCursorEl().style.cursor = hand || ed.tool === 'hand' ? edHandCursorCss() : !cell ? (state.mode === '3d' ? edHandCursorCss() : 'default') : ed.tool === 'brush' ? curCss : edToolCursorCss(ed.tool);
  if (!hand && cell && ed.tool === 'brush' && BRUSH_CURSOR.ready) BRUSH_CURSOR.ready.then(c => { if (ed.tool === 'brush') edCursorEl().style.cursor = c; });
  if (!cell || hand) { if (ed.tool === 'hand') ed.previewInfo = ''; edRequestDraw(); return; }
  if (ed.tool === 'lasso' || ed.tool === 'hand') {   // 走到这里的手掌一定悬在选区上
    const on = ed.sel && ed.sel.set.has(key);
    const byColor = ed.tool === 'lasso' && ed.lassoMode === 'color';
    edCursorEl().style.cursor = on ? edHandCursorCss() : edToolCursorCss('lasso');   // 圈选时用套索图当光标，尾巴尖是热点；悬到选区上用手（按住可拖走）
    if (on) ed.previewInfo = `按住拖动选区 · ${ed.sel.cells.length} 格`;
    else if (byColor) {
      const code = grid[cell[1]][cell[0]], n = ed.lassoColors.size;
      ed.previewInfo = !code ? (n ? `按色圈选 · 已选 ${n} 色 · 拖动圈出范围` : '按色圈选 · 先点格子选颜色')
        : ed.lassoColors.has(code) ? `点一下去掉 ${code} · 拖动圈出范围` : `点一下加入 ${code}${n ? ` · 已选 ${n} 色` : ''} · 拖动圈出范围`;
    } else ed.previewInfo = ed.sel ? '在选区外拖动 = 重新圈选' : '';
    edRequestDraw(); return;
  }
  const [i, j] = cell, cur = grid[j][i];
  const nm = code => edCol(code).code;
  if (ed.tool === 'brush' || ed.tool === 'eraser') {
    const to = ed.tool === 'brush' ? ed.color : '';
    ed.preview = new Map([[key, to]]);
    ed.previewInfo = cur === to ? `(${i + 1},${j + 1}) 已是 ${nm(to)}` : `(${i + 1},${j + 1}) ${nm(cur)} → ${nm(to)}`;
  } else if (ed.tool === 'fill' && ed.sel && state.mode === '2d') {   // 有选区：填充只作用于选区
    if (!ed.sel.set.has(key)) ed.previewInfo = '在选区里点一下 = 整块填成当前色 · Esc 取消选区';
    else {
      const n = ed.sel.cells.filter(([k]) => grid[(k / GW) | 0][k % GW] !== ed.color).length;
      ed.preview = n ? new Map(ed.sel.cells.map(([k]) => [k, ed.color])) : null;
      ed.previewInfo = n ? `选区 ${ed.sel.cells.length} 格 → ${nm(ed.color)}` : `选区已是 ${nm(ed.color)}`;
    }
  } else if (ed.tool === 'fill') {
    const { target, cells, global } = edFillCells(i, j), scope = global ? '全图同色' : '';
    if (target === ed.color) {
      ed.preview = null;   // 同色填充不会有任何变化：不给区域描边光效，免得玩家误以为要填成新颜色
      ed.previewInfo = `${scope ? scope + ' ' : ''}已是 ${nm(target)} · ${cells.length} 格`;
    } else {
      ed.preview = new Map(cells.map(k => [k, ed.color]));
      ed.previewInfo = `${scope ? scope + ' ' : ''}${nm(target)} → ${nm(ed.color)} · ${cells.length} 格`;
    }
  } else if (ed.tool === 'picker') {
    ed.preview = new Map([[key, cur]]);
    ed.previewInfo = cur ? `已吸取 ${nm(cur)} · ${edCol(cur).name}` : '已吸取 空白';
  }
  edRequestDraw();
}
canvas.addEventListener('mouseleave', () => {
  if (!ed.on) return;
  ed.preview = null; ed.hoverCell = null; ed.lastMouse = null; ed.previewInfo = ''; edRequestDraw();
});

/* 预览区域轮廓：只画区域外沿（相邻格不在区域内的边），镜像视角同步翻转 */
function edDrawPreviewOutline(s) {
  if (!ed.on && edBrowseHint !== null) { // 浏览态：可单击编辑的格子
    const i = edBrowseHint % GW, j = (edBrowseHint / GW) | 0;
    ctx.save(); ctx.strokeStyle = '#00C8C8'; ctx.lineWidth = 2.5;
    ctx.strokeRect(state.ox + (state.mirror ? GW - 1 - i : i) * s + 1, state.oy + j * s + 1, s - 2, s - 2);
    ctx.restore(); return;
  }
  if (!ed.on || ed.lasso || !ed.preview || !ed.preview.size) return; // 套索平移中由 edDrawSel 描边
  const P = ed.preview, vx = i => state.ox + (state.mirror ? GW - 1 - i : i) * s;
  ctx.save();
  ctx.setLineDash(P.size > 1 ? [4, 3] : []);
  const one = P.size === 1, lw = Math.max(2, Math.min(3.5, s * 0.14));
  ctx.beginPath();
  for (const idx of P.keys()) {
    const i = idx % GW, j = (idx / GW) | 0, x = vx(i), y = state.oy + j * s;
    const L = state.mirror ? i + 1 : i - 1, R = state.mirror ? i - 1 : i + 1; // 屏幕左右邻
    if (L < 0 || L >= GW || !P.has(j * GW + L)) { ctx.moveTo(x, y); ctx.lineTo(x, y + s); }
    if (R < 0 || R >= GW || !P.has(j * GW + R)) { ctx.moveTo(x + s, y); ctx.lineTo(x + s, y + s); }
    if (j === 0 || !P.has(idx - GW)) { ctx.moveTo(x, y); ctx.lineTo(x + s, y); }
    if (j === GH - 1 || !P.has(idx + GW)) { ctx.moveTo(x, y + s); ctx.lineTo(x + s, y + s); }
  }
  // 两遍描边：先宽的白底（深浅格子上都托得出来），再红线；单格预览（橡皮 / 取色 / 画笔）再往外扩半格，不被格线吃掉
  ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = lw + 2.5; ctx.stroke();
  ctx.strokeStyle = '#FF4655'; ctx.lineWidth = lw; ctx.stroke();
  ctx.restore();
}
/* 编辑中这一下操作的即时反馈（如「画笔 · 本次 +20 颗」）；不写操作说明——工具在工具条上亮着，当前色在色块上 */
/* 编辑中的操作反馈都落在画布左下角的小角标里，不弹醒目的红色提示条，不打断落笔节奏：
 * 刚做完的一步（如「画笔 H7 · +14 颗」）显示约 1.6 秒，之后回到悬停预览（如「(10,45) 已是 H7」）。
 * 保存、放弃这类主动操作仍用提示条确认。 */
let edNoteMsg = '', edNoteTm = 0;
function edNote(msg, ms = 1600) {
  edNoteMsg = msg; clearTimeout(edNoteTm);
  edNoteTm = setTimeout(() => { edNoteMsg = ''; drawHud(); }, ms);
  drawHud();
}
function edHudText() {
  if (!ed.on) return '';
  return edNoteMsg || ed.previewInfo || '';
}
/* 一步改动的豆数：新放的 +、拿掉的 −、换色的 ⇄ */
function edDelta(changes) {
  let add = 0, del = 0, swap = 0;
  for (const [, from, to] of changes) { if (!from && to) add++; else if (from && !to) del++; else swap++; }
  return [add && `+${add} 颗`, del && `−${del} 颗`, swap && `换色 ${swap} 颗`].filter(Boolean).join(' · ');
}

/* ---------- 按下生效 ---------- */
function edPointerDown(e) {
  if (ed.space || e.button === 1) return false;  // 空格 / 中键：交还给原平移逻辑
  if (ed.tool === 'hand') {                      // 手掌：按在选区上 = 拖动选区，其余挪视角
    const cell = e.button === 0 && cellAt(e);
    if (!edSelHit(cell)) return false;
    edLassoDown(e, cell); return true;
  }
  const slideErase = e.button === 2;            // 右键滑动 = 擦除（滑豆时随手挑走豆子）
  if (slideErase && ed.tool !== 'brush' && ed.tool !== 'eraser') return false;
  if (e.button !== 0 && !slideErase) return false;
  edColorHover = null; edColorFlash = null;
  if (state.meltOn && ironPlaying) { ironStop(); ironSetProgress(state.melt); } // [IRON hook] 烫后接着改：停住播放，这一笔照常落豆，新豆按当前熔化度显示（平面与 3D视角 同一行为）
  const cell = cellAt(e);
  if (!cell) return true;
  const [i, j] = cell, idx = j * GW + i;
  ed.preview = null;
  if (ed.tool === 'picker') {
    const code = grid[j][i];
    if (ed.prevTool === 'lasso' && ed.lassoMode === 'color') {   // 从按色圈选来取色：取到的色加进要圈的颜色，回到套索
      edSetTool('lasso');
      if (code) { ed.lassoColors.add(code); edLassoColorsNote(`已加入 ${code}`); edRenderPal(); } else edNote('空白格没有豆子，不能按色圈选');
      return true;
    }
    ed.color = code; edSetTool(ed.prevTool === 'fill' ? 'fill' : 'brush'); // 取了色就是要用它：填充回填充，其余（含橡皮）回画笔
    edUpdateBar(); edRenderPal(); edNote(`已吸取 ${edCol(code).code} · ${edCol(code).name}`);
    return true;
  }
  if (ed.tool === 'lasso') { edLassoDown(e, cell); return true; }
  if (ed.tool === 'fill' && ed.sel && state.mode === '2d') { edSelFill(idx); return true; }
  if (ed.tool === 'fill') {
    const { target, cells, global } = edFillCells(i, j);
    if (target === ed.color) { edNote('已是当前颜色'); return true; }
    const to = ed.color, apply = () => {
      if (grid[j][i] !== target || ed.color !== to) return;            // 确认期间图纸或当前色变了：作废
      const changes = cells.map(k => [k, target, to]);
      for (const k of cells) edSetCell(k, to);
      edCommit(changes, `${global ? '全图替换' : '填充'} ${edCol(target).code} → ${edCol(to).code}`);
      ed.hoverCell = null;
    };
    if (cells.length <= GW * GH / 4) { apply(); return true; }
    const nm = c => c ? `${edCol(c).code}（${edCol(c).name}）` : '空白（无颜色）';
    ed.preview = new Map(cells.map(k => [k, to])); edRequestDraw();          // 先让玩家看到要填的范围
    edConfirm('确定要填充吗？', `将把 ${cells.length} 个格子从 ${nm(target)} 填成 ${nm(to)}。`, [
      { label: '取消', value: null },
      { label: '填充', value: true, primary: true },
    ]).then(ok => { ed.preview = null; if (ok) apply(); else edRefreshHover(); });
    return true;
  }
  // 画笔 / 橡皮：按住拖动为一笔（滑豆），一笔 = 一步撤销
  ed.stroke = { changes: [], touched: new Set(), last: cell, axis: null,
                lineFrom: null, lineStart: 0, lineSet: null,   // Shift 直线段：起点、在 changes 中的起始位置、上一帧的格子集合
                erase: slideErase || ed.tool === 'eraser' };
  edPaintCell(i, j, 0);
  edStrokeInfo();
  edRequestDraw();
  return true;
}
/* 落一颗豆：写矩阵 + 排一个落位动画。delay 让一次事件里补出的多颗豆依次落下（节奏感） */
function edPaintCell(i, j, delay, pop = true) {
  const idx = j * GW + i, st = ed.stroke;
  if (st.touched.has(idx)) return false;
  st.touched.add(idx);
  const to = st.erase ? '' : ed.color, from = grid[j][i];
  if (from === to) return false;
  st.changes.push([idx, from, to]); grid[j][i] = to;
  if (pop) edPop(idx, st.erase ? from : to, st.erase, delay);
  return true;
}
/* Bresenham：a → b 逐格落豆（快速拖动补格、Shift 直线共用） */
function edPaintLine(a, b, skip) {
  let [x0, y0] = a; const [x1, y1] = b;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, k = 0;
  for (;;) {
    const fresh = !skip || !skip.has(y0 * GW + x0);
    if (edPaintCell(x0, y0, k * 14, fresh) && fresh) k++;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
/* 把终点吸附到离拖动方向最近的横 / 竖 / 45° 斜线（8 个方向），斜线不越出图纸 */
function edSnapEnd(o, c) {
  const dx = c[0] - o[0], dy = c[1] - o[1], ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax >= ay * 2.414) return { end: [c[0], o[1]], axis: 'h' };   // tan 67.5°：离横线更近
  if (ay >= ax * 2.414) return { end: [o[0], c[1]], axis: 'v' };
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const n = Math.min(Math.round((ax + ay) / 2), sx > 0 ? GW - 1 - o[0] : o[0], sy > 0 ? GH - 1 - o[1] : o[1]);
  return { end: [o[0] + sx * n, o[1] + sy * n], axis: 'd' };
}
/* Shift 直线：每次移动先撤掉上一帧的直线段再按新方向重画，像直线工具一样跟手转向；
 * 松开 Shift 时直线段定稿，之后接着自由滑豆 */
function edShiftLine(cell) {
  const st = ed.stroke;
  if (!st.lineFrom) { st.lineFrom = st.last; st.lineStart = st.changes.length; st.lineSet = new Set(); }
  for (let k = st.changes.length - 1; k >= st.lineStart; k--) {
    const [idx, from] = st.changes[k]; edSetCell(idx, from);
  }
  for (const idx of st.lineSet) st.touched.delete(idx);
  st.changes.length = st.lineStart;
  const prev = st.lineSet, before = new Set(st.touched);
  const { end, axis } = edSnapEnd(st.lineFrom, cell);
  edPaintLine(st.lineFrom, end, prev);
  st.lineSet = new Set([...st.touched].filter(idx => !before.has(idx)));
  st.axis = axis;
  return end;
}
function edStrokeInfo() {
  const n = ed.stroke.changes.length;
  ed.previewInfo = `${ed.stroke.erase ? '橡皮' : '画笔'} · 本次 ${ed.stroke.erase ? '−' : '+'}${n} 颗` +
    (ed.stroke.axis ? ` · 直线 ${{ h: '水平', v: '垂直', d: '45°' }[ed.stroke.axis]}` : '');
}
/* 笔画的移动与收尾：鼠标走 window 监听，触屏由 [TOUCH] 直接调用 */
function edStrokeMove(e) {
  if (ed.on && ed.lasso) { edLassoMove(e); return; }   // 套索：圈选 / 平移
  if (!ed.on || !ed.stroke) return;
  let cell = cellAt(e);
  if (!cell) return;
  const st = ed.stroke;
  if (e.shiftKey) cell = edShiftLine(cell);            // Shift：直线段（横 / 竖 / 45°）
  else {
    if (st.lineFrom) { st.lineFrom = null; st.axis = null; } // 松开 Shift：直线段定稿
    edPaintLine(st.last, cell);                            // 自由滑豆：补齐两次事件之间的格子
  }
  st.last = cell;
  ed.preview = new Map([[cell[1] * GW + cell[0], grid[cell[1]][cell[0]]]]); // 目标钉位锚点：光标所在格描边
  edStrokeInfo();
  edRequestDraw();
}
function edStrokeEnd() {
  if (ed.on && ed.lasso) { edLassoEnd(); return; }
  if (!ed.on || !ed.stroke) return;
  const { changes, erase } = ed.stroke;
  ed.stroke = null; ed.hoverCell = null;
  edCommit(changes, erase ? '橡皮' : `画笔 ${edCol(ed.color).code}`);
}
window.addEventListener('mousemove', edStrokeMove);
window.addEventListener('mouseup', edStrokeEnd);
canvas.addEventListener('contextmenu', e => { if (ed.on) e.preventDefault(); }); // 右键用于滑擦
/* ---------- 套索：圈一块像素，拖到别处 ----------
 * 选区外按下拖动 = 重新圈（格心落在圈内、且有豆的格子入选；按色圈选只收已选颜色的格子）；选区内按下 = 拖动平移。
 * 按色圈选下原地点一下（不拖）= 把点到的颜色加入 / 去掉。
 * 平移会盖掉别的豆或把豆拖出图纸时先确认，写明影响多少格；一次平移 = 一步撤销。只在平面视角用。 */
function edGridPt(e) {          // 屏幕点 → 图纸坐标（格为单位，可出界；镜像视角翻回原图方向）
  const r = canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left - state.ox) / state.scale, fy = (e.clientY - r.top - state.oy) / state.scale;
  return [state.mirror ? GW - fx : fx, fy];
}
function edLassoDown(e, cell) {
  if (state.mode === '3d') { edNote('套索请在平面视角使用'); return; }
  const idx = cell[1] * GW + cell[0];
  ed.preview = null; ed.previewInfo = '';
  if (ed.sel && ed.sel.set.has(idx)) ed.lasso = { kind: 'move', from: cell, dx: 0, dy: 0 };
  else ed.lasso = { kind: 'draw', pts: [edGridPt(e)], cell };   // 选区等圈完再换，原地点一下（按色加减颜色）不丢选区
  edRequestDraw();
}
/* 按色圈选的颜色集合：加入 / 去掉一个色，颜色区色块标记与图纸高亮跟着变 */
function edLassoColorToggle(code) {
  if (ed.lassoColors.has(code)) { ed.lassoColors.delete(code); edLassoColorsNote(`已去掉 ${code}`); }
  else { ed.lassoColors.add(code); edLassoColorsNote(`已加入 ${code}`); }
  ed.hoverCell = null; edRenderPal(); edRefreshHover();
}
function edLassoColorsNote(head) {
  const n = ed.lassoColors.size;
  edNote(n ? `${head} · 已选 ${n} 色 · 拖动圈出范围，只选这些颜色` : `${head} · 还没选颜色，点格子或颜色区选`, 2400);
}
/* 套索按色选法时 body 带 lasso-color：颜色区给已选的色块打标 */
function edLassoBodySync() { document.body.classList.toggle('lasso-color', ed.on && ed.tool === 'lasso' && ed.lassoMode === 'color'); }
function edLassoMove(e) {
  const L = ed.lasso;
  if (L.wait) return;                                  // 确认框打开中：鼠标去点按钮，选区不跟着走
  if (L.kind === 'draw') {
    const p = edGridPt(e), q = L.pts[L.pts.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) * state.scale >= 3) L.pts.push(p);
    ed.previewInfo = ed.lassoMode === 'draw' ? '套索 · 圈出要选的像素'
      : ed.lassoColors.size ? `按色圈选 · 只选 ${[...ed.lassoColors].join('、')}` : '按色圈选 · 还没选颜色';
  } else {
    const [fx, fy] = edGridPt(e);
    L.dx = Math.floor(fx) - L.from[0]; L.dy = Math.floor(fy) - L.from[1];
    const m = edSelMove(L.dx, L.dy);
    ed.preview = m.map;
    ed.previewInfo = `移动 ${ed.sel.cells.length} 格` + (m.over ? ` · 将覆盖 ${m.over} 格` : '') + (m.out ? ` · ${m.out} 格移出图纸` : '');
  }
  edRequestDraw();
}
/* 平移结果：map = 预览 / 落盘用的新格色；over = 被盖掉的已有豆；out = 移出图纸的豆 */
function edSelMove(dx, dy) {
  const map = new Map(), dest = [];
  let over = 0, out = 0;
  for (const [idx] of ed.sel.cells) map.set(idx, '');
  for (const [idx, code] of ed.sel.cells) {
    const i = idx % GW + dx, j = ((idx / GW) | 0) + dy;
    if (i < 0 || j < 0 || i >= GW || j >= GH) { out++; continue; }
    const k = j * GW + i;
    if (!ed.sel.set.has(k) && grid[j][i]) over++;
    map.set(k, code); dest.push([k, code]);
  }
  return { map, dest, over, out };
}
/* 点是否在套索轨迹内：环绕数（nonzero），与画布上画出的填充区域同一规则。
 * 轨迹绕了好几圈时，被绕过的地方都算圈内；奇偶规则会把绕两圈的区域当成圈外 */
function edPointInPoly(x, y, P) {
  let w = 0;
  for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
    const [xa, ya] = P[b], [xb, yb] = P[a];
    const c = (xb - xa) * (y - ya) - (x - xa) * (yb - ya);
    if (ya <= y) { if (yb > y && c > 0) w++; }
    else if (yb <= y && c < 0) w--;
  }
  return w !== 0;
}
/* 轨迹够不够算「圈」：至少 3 个点；外接框不到一格、且屏幕上不到 8px 才算原地点了一下
 * （只看格数：放大时圈住单格会被当成点；只看像素：缩小时圈几格也会被当成点） */
const edLassoIsTap = P => {
  if (P.length < 3) return true;
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return ext < 1 && ext * state.scale < 8;
};
function edLassoEnd() {
  const L = ed.lasso;
  if (L.wait) return;                                  // 点确认框按钮的那次松开不算放下选区
  if (L.kind === 'draw') {
    ed.lasso = null; ed.previewInfo = ''; ed.hoverCell = null;
    const P = L.pts, byColor = ed.lassoMode === 'color';
    if (edLassoIsTap(P)) {                             // 原地点一下：按色圈选 = 加减颜色；圈选 = 取消选区
      if (byColor) { const code = grid[L.cell[1]][L.cell[0]]; if (code) edLassoColorToggle(code); else edNote('这里没有豆子'); }
      else ed.sel = null;
      edRequestDraw(); return;
    }
    if (byColor && !ed.lassoColors.size) { ed.sel = null; edNote('先点格子或颜色区选颜色，再圈', 2400); edRequestDraw(); return; }
    const cells = [];
    const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
    const i0 = Math.max(0, Math.floor(Math.min(...xs))), i1 = Math.min(GW - 1, Math.ceil(Math.max(...xs)));
    const j0 = Math.max(0, Math.floor(Math.min(...ys))), j1 = Math.min(GH - 1, Math.ceil(Math.max(...ys)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const code = grid[j][i];
      if (code && (!byColor || ed.lassoColors.has(code)) && edPointInPoly(i + 0.5, j + 0.5, P)) cells.push([j * GW + i, code]);
    }
    ed.sel = cells.length ? { cells, set: new Set(cells.map(c => c[0])) } : null;
    if (cells.length) edNote(`已选中 ${cells.length} 格 · 按住选区可拖走，切到填充在选区里点一下 = 整块换色`, 2600);
    else edNote(byColor ? '圈内没有所选颜色的像素' : '圈内没有像素');
    edRequestDraw();
    return;
  }
  const { dx, dy } = L;
  if (!dx && !dy) {                                    // 按在选区上没拖：按色圈选 = 加减这一格的颜色，其余不动
    ed.lasso = null; ed.preview = null;
    if (ed.tool === 'lasso' && ed.lassoMode === 'color') { const code = grid[L.from[1]][L.from[0]]; if (code) edLassoColorToggle(code); }
    edRequestDraw(); return;
  }
  const m = edSelMove(dx, dy);
  const apply = () => {
    const changes = [];
    for (const [k, to] of m.map) { const from = grid[(k / GW) | 0][k % GW]; if (from !== to) changes.push([k, from, to]); }
    for (const [k, to] of changes.map(c => [c[0], c[2]])) edSetCell(k, to);
    ed.sel = m.dest.length ? { cells: m.dest, set: new Set(m.dest.map(c => c[0])) } : null;
    ed.lasso = null; ed.preview = null;
    edCommit(changes, '移动选区');
  };
  if (!m.over && !m.out) { apply(); return; }
  const parts = [];
  if (m.over) parts.push(`会覆盖 ${m.over} 个已有像素`);
  if (m.out) parts.push(`有 ${m.out} 个像素移出图纸后会被删掉`);
  L.wait = true;
  edConfirm('确定移动吗？', `这次移动${parts.join('，')}。`, [
    { label: '取消', value: null },
    { label: '移动', value: true, primary: true },
  ]).then(ok => {
    if (ed.lasso !== L) return;
    if (ok) apply(); else { ed.lasso = null; ed.preview = null; ed.previewInfo = ''; edRequestDraw(); }
  });
}
/* 选区描边（青色虚线）+ 圈选中的套索轨迹；平移中描在目标位置。选区在套索 / 移动 / 填充 / 取色下都显示 */
function edDrawSel(s) {
  edSelPopSync(s);
  if (!ed.on || state.mode !== '2d') return;
  const vx = fx => state.ox + (state.mirror ? GW - fx : fx) * s;
  ctx.save();
  const L = ed.lasso;
  if (L && L.kind === 'draw' && L.pts.length > 1) {
    ctx.beginPath();
    L.pts.forEach(([x, y], k) => k ? ctx.lineTo(vx(x), state.oy + y * s) : ctx.moveTo(vx(x), state.oy + y * s));
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,200,200,.12)'; ctx.fill('nonzero');   // 与 edPointInPoly 同一规则：画出来的填充区域 = 会被选中的区域
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = '#00C8C8'; ctx.lineWidth = 2; ctx.stroke();
  }
  if (ed.sel) {
    const dx = L && L.kind === 'move' ? L.dx : 0, dy = L && L.kind === 'move' ? L.dy : 0;
    const S = new Set();
    for (const [idx] of ed.sel.cells) {
      const i = idx % GW + dx, j = ((idx / GW) | 0) + dy;
      if (i >= 0 && j >= 0 && i < GW && j < GH) S.add(j * GW + i);
    }
    ctx.beginPath();
    for (const [idx] of ed.sel.cells) {
      const i = idx % GW + dx, j = ((idx / GW) | 0) + dy, k = j * GW + i;
      if (i < 0 || j < 0 || i >= GW || j >= GH) continue;          // 拖出图纸的部分不描
      const x = Math.min(vx(i), vx(i + 1)), y = state.oy + j * s;
      const L_ = state.mirror ? i + 1 : i - 1, R_ = state.mirror ? i - 1 : i + 1;
      if (L_ < 0 || L_ >= GW || !S.has(j * GW + L_)) { ctx.moveTo(x, y); ctx.lineTo(x, y + s); }
      if (R_ < 0 || R_ >= GW || !S.has(j * GW + R_)) { ctx.moveTo(x + s, y); ctx.lineTo(x + s, y + s); }
      if (j === 0 || !S.has(k - GW)) { ctx.moveTo(x, y); ctx.lineTo(x + s, y); }
      if (j === GH - 1 || !S.has(k + GW)) { ctx.moveTo(x, y + s); ctx.lineTo(x + s, y + s); }
    }
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = '#00C8C8'; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.restore();
}

/* ---------- 选区浮条：有选区时贴在选区上方（放不下就放下方），「已选 N 格 · K 色 · 取消」 ----------
 * 选中后按住选区就能拖；要换色就切到填充、在选区里点一下。
 * 每次重画时对一次状态（选区在很多处被改写：撤销、放弃、换工具、移动），内容或位置变了才动 DOM；圈选 / 拖动中隐藏 */
let edSelPopKey = '', edSelPopPos = '';
const edSelPop = document.getElementById('edSelPop');
function edSelPopSync(s) {
  edLassoBodySync();
  const show = !!(ed.on && ed.sel && state.mode === '2d' && !ed.lasso);
  const codes = show ? new Set(ed.sel.cells.map(c => c[1]).filter(Boolean)) : null;
  const key = show ? `${ed.sel.cells.length}|${codes.size}|${ed.tool}` : '';
  if (key !== edSelPopKey) {
    edSelPopKey = key;
    document.body.classList.toggle('has-sel', show);
    if (show) document.getElementById('edSelN').textContent = `已选 ${ed.sel.cells.length} 格${codes.size > 1 ? ` · ${codes.size} 色` : ''}`;
  }
  if (!show) { edSelPopPos = ''; return; }
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [k] of ed.sel.cells) { const i = k % GW, j = (k / GW) | 0; if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
  const wrap = edSelPop.parentElement.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
  const sx = fx => cr.left - wrap.left + state.ox + (state.mirror ? GW - fx : fx) * s;
  const left = Math.min(sx(x0), sx(x1 + 1)), right = Math.max(sx(x0), sx(x1 + 1));
  const top = cr.top - wrap.top + state.oy + y0 * s, bottom = cr.top - wrap.top + state.oy + (y1 + 1) * s;
  const w = edSelPop.offsetWidth, h = edSelPop.offsetHeight, gap = 8;
  let y = top - h - gap;
  if (y < 6) y = bottom + gap <= wrap.height - h - 6 ? bottom + gap : Math.max(6, Math.min(top + gap, wrap.height - h - 6)); // 上面放不下就放下面，再不行贴在选区里面
  const x = Math.max(6, Math.min((left + right) / 2 - w / 2, wrap.width - w - 6));
  const pos = `${Math.round(x)},${Math.round(y)}`;
  if (pos !== edSelPopPos) { edSelPopPos = pos; edSelPop.style.left = Math.round(x) + 'px'; edSelPop.style.top = Math.round(y) + 'px'; }
}
/* 填充作用于选区：点在选区里 = 选区全部格子换成当前色（一步撤销），选区留着可以接着换别的色比较；点在选区外不改图 */
function edSelFill(idx) {
  if (!ed.sel) return;
  if (!ed.sel.set.has(idx)) { edNote('有选区时填充只改选区 · 在选区里点一下，或 Esc 取消选区', 2400); return; }
  const to = ed.color, changes = [];
  for (const [k] of ed.sel.cells) { const from = grid[(k / GW) | 0][k % GW]; if (from !== to) changes.push([k, from, to]); }
  if (!changes.length) { edNote('选区已是这个颜色'); return; }
  for (const [k] of changes) edSetCell(k, to);
  ed.sel = { cells: ed.sel.cells.map(([k]) => [k, to]), set: ed.sel.set };
  ed.hoverCell = null;
  edCommit(changes, `选区填充 ${edCol(to).code}`);
}
function edSelClear() {
  if (!ed.sel) return;
  ed.sel = null; ed.lasso = null; ed.preview = null; ed.hoverCell = null;
  if (ed.tool === 'hand' && ed.handPrev === 'lasso') edSetTool('lasso'); else edRefreshHover();
}
document.getElementById('edSelClear').onclick = edSelClear;
edSelPop.addEventListener('pointerdown', e => e.stopPropagation());

/* ---------- 滑豆手感：落位反馈 ----------
 * 实物里豆子滑到钉位会「咔」地卡入。这里每落一颗豆，在格子上画一颗圆豆从略大收紧到格内并淡出（约 170ms）；
 * 擦除则是旧色的豆向内缩小消失。一次事件补出的多颗豆按 14ms 间隔依次落下，快速滑动时看得到一串豆子排进去。 */
const POP_MS = 170;
function edPop(idx, code, out, delay) {
  if (!code || state.scale < 6) return;             // 缩得太小看不见，不排动画
  ed.pops.push({ idx, code, out, t0: performance.now() + delay });
  if (ed.pops.length > 400) ed.pops.splice(0, ed.pops.length - 400);
}
function edDrawPops(s) {
  if (!ed.pops.length) return;
  const now = performance.now();
  ed.pops = ed.pops.filter(p => now - p.t0 < POP_MS);
  ctx.save();
  for (const p of ed.pops) {
    const t = (now - p.t0) / POP_MS;
    if (t < 0) continue;
    const i = p.idx % GW, j = (p.idx / GW) | 0;
    const cx = state.ox + ((state.mirror ? GW - 1 - i : i) + 0.5) * s, cy = state.oy + (j + 0.5) * s;
    const e = 1 - (1 - t) ** 3;                      // ease-out
    const r = s * (p.out ? 0.42 * (1 - e) : 0.62 - 0.2 * e);
    ctx.globalAlpha = p.out ? 1 - e : 1 - t * t;
    ctx.fillStyle = edCol(p.code).hex;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(0.5, r), 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(15,25,35,.45)'; ctx.lineWidth = 1; ctx.stroke();
    if (!p.out && s >= 12) {                          // 高光：像一颗圆豆
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.22, 0, 7); ctx.fill();
    }
  }
  ctx.restore();
  if (ed.pops.length) edRequestDraw();               // 动画进行中持续请求下一帧
}

/* ---------- 颜色：选色与用量合一 ----------
 * 编辑站「颜色」区就是选色面板：在用颜色按颗数降序排成色块，每块带颗数、占比条，前三名与占比 ≥10% 的占比条用主色强调，
 * 点即选用；首块是「空白」（清除格子）。没用过的颜色在「全部色号」（搜索 + 全色板）里选，那里的在用色同样带颗数。
 * 工具条颜色按钮 / C 键 / 区块标题的「全部色号」三处共用 edPalShow 打开同一个全部色号区。 */
const ED_HOT_SHARE = 0.10, ED_HOT_TOP = 3;
function edPalShow(v) {
  document.getElementById('edPal').classList.toggle('show', v);
  document.getElementById('edChip').setAttribute('aria-expanded', String(v));
  document.getElementById('edPalMore').classList.toggle('on', v);
  if (v) {
    document.getElementById('edColorSec').classList.remove('sec-closed');
    requestAnimationFrame(() => document.getElementById('edPal').scrollIntoView({ block: 'nearest' }));
  }
  edRenderPal();                                     // 开 / 关都重绘颜色区（进出编辑走 edPalShow(false) 刷新用量）
  const ctl = document.getElementById('edControls');
  if (ctl.offsetHeight) document.querySelector('#dock aside').style.setProperty('--ed-ctl-h', ctl.offsetHeight + 8 + 'px');
  flowRelayout(false);
}
document.getElementById('edChip').onclick = () => edPalShow(!document.getElementById('edPal').classList.contains('show'));
document.getElementById('edPalMore').onclick = e => { e.stopPropagation(); edPalShow(!document.getElementById('edPal').classList.contains('show')); };
document.getElementById('edPalClose').onclick = () => edPalShow(false);
document.getElementById('edPalSearch').oninput = () => edRenderPal();
function edSw(c, n) {
  const d = document.createElement('div');
  const code = c === EMPTY ? '' : c.code;
  d.className = 'sw' + (code === ed.color ? ' sel' : '') + (c === EMPTY ? ' empty' : '') + (code.length > 4 ? ' long' : '') + (n ? ' used' : '') + (ed.lassoColors.has(code) ? ' lasso-on' : '');
  if (c !== EMPTY) { d.style.background = c.hex; d.style.color = txtOn(c.rgb); d.textContent = code; }  // 色块上直接标色号
  if (n) d.dataset.count = n;
  d.dataset.code = code;
  d.title = code ? `${c.code} · ${c.name} · ${n ? n + ' 颗' : '图纸未使用'}` : '空白 · 清除格子';
  d.onpointerenter = e => {
    if (e.pointerType !== 'touch') edColorPreview(code);
    document.getElementById('edPalFoot').innerHTML =
      `<b>${c.code}</b> · ${c.name}${c === EMPTY ? ' · 用于清除格子' : ' · ' + c.hex}${n ? ` · 图纸在用 ${n} 颗` : ' · 未使用'}`;
  };
  d.onpointerleave = e => { if (e.pointerType !== 'touch') edColorLeave(); };
  d.onclick = e => edColorChoose(code, e);
  edColorHoldBind(d, code);
  return d;
}
/* 当前矩阵的用量；空白格不计入豆数 */
function edColorItem(code, n, total, rank) {
  const item = document.createElement('button');
  item.type = 'button';
  const share = total ? n / total : 0, hot = !!code && (rank < ED_HOT_TOP || share >= ED_HOT_SHARE);
  item.className = 'ed-count' + (code === ed.color ? ' sel' : '') + (hot ? ' hot' : '') + (code ? '' : ' blank') + (ed.lassoColors.has(code) ? ' lasso-on' : '');
  item.dataset.code = code;
  if (code) item.dataset.count = n;
  const pct = share >= 0.01 ? Math.round(share * 100) + '%' : '<1%';
  item.title = code ? `${code} · ${PAL[code].name} · ${n} 颗 · 占 ${pct}` : '空白 · 用于清除格子';
  // 色号直接写在色样上（字色按底色明暗取深 / 浅），下方一条放颗数；长色号（如 Perler 80-15179）缩字号
  const sw = document.createElement('span'); sw.className = 'sw' + (code ? '' : ' empty') + ((code || '').length > 4 ? ' long' : '');
  if (code) { sw.style.background = PAL[code].hex; sw.style.color = txtOn(PAL[code].rgb); }
  const label = document.createElement('span'); label.className = 'code'; label.textContent = code || '空白';
  sw.appendChild(label);
  const qty = document.createElement('span'); qty.className = 'qty'; qty.textContent = code ? `${n} 颗` : '清除';
  item.append(sw, qty);
  if (code) { const bar = document.createElement('span'); bar.className = 'bar'; bar.style.setProperty('--w', Math.max(share * 100, 2) + '%'); item.appendChild(bar); }
  item.onpointerenter = e => { if (e.pointerType !== 'touch') edColorPreview(code); };
  item.onpointerleave = e => { if (e.pointerType !== 'touch') edColorLeave(); };
  item.onclick = e => edColorChoose(code, e);
  edColorHoldBind(item, code);
  return item;
}
function edRenderColorSec() {
  const g = document.getElementById('edColorGrid');
  if (!g || !ed.on) return;
  const counts = D.specs[state.size].counts, total = D.specs[state.size].beads;
  const codes = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  g.innerHTML = '';
  codes.forEach((code, i) => g.appendChild(edColorItem(code, counts[code], total, i)));
  g.appendChild(edColorItem('', 0, total, codes.length));
  document.getElementById('edColorHint').textContent = `在用 ${codes.length} 色 · ${total} 颗`;
}
function edRenderPal() {
  edColorHover = null;
  edRenderColorSec();
  if (!document.getElementById('edPal').classList.contains('show')) return;
  document.getElementById('edPalName').textContent = PALS[state.palette].label;
  const counts = D.specs[state.size].counts;
  const q = document.getElementById('edPalSearch').value.trim().toLowerCase();
  const all = document.getElementById('edPalAll'); all.innerHTML = '';
  let n = 0;
  for (const c of PALS[state.palette].colors) {
    if (q && !`${c.code} ${c.name} ${c.hex}`.toLowerCase().includes(q)) continue;
    all.appendChild(edSw(c, counts[c.code])); n++;
  }
  document.getElementById('edPalAllTitle').textContent = `${PALS[state.palette].label} 共 ${n} 色 · 带角标的是图纸在用`;
}

/* ---------- 浏览态入口：让编辑一点就开 ----------
 * 放大到格内显示色号（每格 ≥ CODE_PX）时，格子能被精准点中：悬停描边 + 提示「单击编辑」，单击即以该格颜色进入编辑。
 * 缩小时单击多半是在看图或拖图，不进入编辑；按住不动 450ms（进度环走满）进入，单击会提示这两种方式。 */
const HOLD_MS = 450;
let edHold = null, edHoldFired = false, edBrowseHint = null, edTipShown = false;
function edBrowseTip(e, html) {
  const el = document.getElementById('edTip');
  if (!e || !html) { el.classList.remove('show'); return; }
  const r = canvas.parentElement.getBoundingClientRect();
  el.innerHTML = html; el.classList.add('show');
  el.style.left = (e.clientX - r.left + 14) + 'px'; el.style.top = (e.clientY - r.top + 16) + 'px';
}
function edBrowseHover(e) {
  if (drag && drag.moved > 4) { edHoldCancel(); edBrowseTip(null); if (edBrowseHint !== null) { edBrowseHint = null; requestView(); } return; }
  if (drag) return;
  if (flowNoEdit()) { canvas.style.cursor = edHandCursorCss(); edBrowseTip(null); if (edBrowseHint !== null) { edBrowseHint = null; requestView(); } return; } // [FLOW hook] 辅助拼豆站不提示编辑
  const cell = cellAt(e), code = cell && grid[cell[1]][cell[0]];
  const precise = state.scale >= CODE_PX;
  const hint = cell && precise ? cell[1] * GW + cell[0] : null;
  if (hint !== edBrowseHint) { edBrowseHint = hint; requestView(); }
  canvas.style.cursor = cell && precise ? 'pointer' : edHandCursorCss();
  edBrowseTip(e, cell && precise ? `单击编辑 · <b>${edCol(code).code}</b>` : null);
}
function edBrowseClick(e) {
  if (edHoldFired) { edHoldFired = false; return; }   // 长按已进入编辑，吞掉随后这一次 click（须先于 ed.on 判断，否则标记残留）
  if (ed.on || flowNoEdit()) return; // [FLOW hook] 辅助拼豆站单击不进编辑
  if (e.detail !== 1 || lastDragMoved > 5) return;
  const cell = cellAt(e);
  if (!cell) return;
  if (state.scale >= CODE_PX) { edEnter(grid[cell[1]][cell[0]]); return; }
  if (!edTipShown) { edTipShown = true; toast('长按格子进入编辑 · 放大后可单击编辑', 3000); }
}
function edHoldStart(e) {
  edHoldCancel();
  const cell = cellAt(e);
  if (!cell || state.scale >= CODE_PX || flowNoEdit()) return;        // 放大时单击就够，不走长按；辅助拼豆站不进编辑 [FLOW hook]
  const r = canvas.parentElement.getBoundingClientRect(), ring = document.getElementById('edHoldRing');
  ring.style.left = (e.clientX - r.left) + 'px'; ring.style.top = (e.clientY - r.top) + 'px';
  edHold = {
    show: setTimeout(() => ring.classList.add('show'), 120), // 普通单击不闪进度环
    fire: setTimeout(() => {
      edHoldCancel(); edHoldFired = true;
      drag = null; canvas.classList.remove('panning');
      edEnter(grid[cell[1]][cell[0]]);
    }, HOLD_MS),
  };
}
function edHoldCancel() {
  if (!edHold) return;
  clearTimeout(edHold.show); clearTimeout(edHold.fire); edHold = null;
  document.getElementById('edHoldRing').classList.remove('show');
}
window.addEventListener('mouseup', edHoldCancel);
canvas.addEventListener('mouseleave', () => { edHoldCancel(); edBrowseTip(null); if (edBrowseHint !== null) { edBrowseHint = null; requestView(); } });

/* ---------- 快捷键 ---------- */
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (!ed.on) { if (k === 'e' && !mod && !flowNoEdit()) edEnter(); return; }
  if (e.key === 'Shift' && !ed.shift) { ed.shift = true; edRefreshHover(); return; }
  if (e.code === 'Space') { ed.space = true; edCursorEl().style.cursor = edHandCursorCss(); e.preventDefault(); return; }
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? edRedo() : edUndo(); return; }
  if (mod && k === 'y') { e.preventDefault(); edRedo(); return; }
  if (mod && k === 's') { e.preventDefault(); if (ed.dirty) edSave(true); return; }
  if (mod) return;
  if (k === 'b') edSetTool('brush');
  else if (k === 'g') edSetTool('fill');
  else if (k === 'x') edSetTool('eraser');
  else if (k === 'i') edSetTool('picker');
  else if (k === 'h') edSetTool('hand');
  else if (k === 'l') { if (ed.tool === 'lasso') { const m = Object.keys(LASSO_MODES); edLassoModeSet(m[(m.indexOf(ed.lassoMode) + 1) % m.length], true); } else edSetTool('lasso'); }
  else if (k === 'c') edPalShow(!document.getElementById('edPal').classList.contains('show'));
  else if (k === 'escape') {
    if (edLassoMenu.classList.contains('show')) edLassoMenuShow(false);
    else if (document.getElementById('edPal').classList.contains('show')) edPalShow(false);
    else if (ed.sel && !ed.lasso) edSelClear();
    else edExit();
  }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') { ed.space = false; ed.hoverCell = null; }
  if (e.key === 'Shift' && ed.shift) { ed.shift = false; if (ed.on) edRefreshHover(); }
});
window.addEventListener('blur', () => { ed.space = false; ed.shift = false; });
/* [EDIT-MODE] 编辑态模块 END ===================================================== */