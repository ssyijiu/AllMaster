/* ===== [VIEW-SMOOTH] 缩放平移 BEGIN =====
 * 手势约定（与 Figma 一致）：
 *   触控板双指滑动 = 平移；触控板捏合（浏览器上报为 ctrlKey+wheel）= 缩放；
 *   鼠标滚轮 = 以指针为中心缩放；⌘/Ctrl + 滚轮 = 缩放；Shift + 滚轮 = 横向平移
 *   拖拽平移：浏览态左键拖；编辑态空格 + 拖、右键或中键拖
 * 缩放量按 deltaY 连续换算（不是每个事件固定一档），所有视图变化经 requestView() 合到一帧重绘。 */
/* 缩放范围与豆板规格是两回事：下限 = 适配窗口大小的 1/3（长宽各缩到 1/3，豆板占画面约 1/9，方便捏小了看整体效果），
 * 上限每格 90px。百分比以适配为 100%，所以下限显示 33%。 */
const ZMAX = 90, ZMIN_RATIO = 1 / 3;
const zMin = () => fitScale() * ZMIN_RATIO;
let viewRaf = 0;
function requestView() { if (!viewRaf) viewRaf = requestAnimationFrame(() => { viewRaf = 0; draw(); }); }
function zoomAt(mx, my, factor) {
  const ns = Math.min(ZMAX, Math.max(zMin(), state.scale * factor));
  const k = ns / state.scale;
  state.ox = mx - (mx - state.ox) * k;
  state.oy = my - (my - state.oy) * k;
  state.scale = ns;
  clampView(); requestView();
}
/* 平移限位：图纸至少留 80px 在画布内，不会被拖丢 */
function clampView() {
  const W = canvas.width / dpr, H = canvas.height / dpr, m = 80;
  state.ox = Math.min(W - m, Math.max(m - GW * state.scale, state.ox));
  state.oy = Math.min(H - m, Math.max(m - GH * state.scale, state.oy));
}
/* 鼠标滚轮：整数步长、无横向分量、单步幅度大；触控板：小幅像素增量或带横向分量 */
const isMouseWheel = e => e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (e.ctrlKey || e.metaKey) zoomAt(mx, my, Math.exp(-dy * 0.012));        // 捏合 / ⌘+滚轮：灵敏
  else if (e.shiftKey) { state.ox -= dy; clampView(); requestView(); }      // Shift+滚轮：横向平移
  else if (isMouseWheel(e)) zoomAt(mx, my, Math.exp(-dy * 0.0022));         // 鼠标滚轮：一格约 ×1.25
  else { state.ox -= e.deltaX; state.oy -= e.deltaY; clampView(); requestView(); } // 触控板双指：平移
  if (ed.on) edRefreshHover(); // [EDIT-MODE hook] 视图变了，预览跟着指针所在格重算
}, { passive: false });

let drag = null, lastDragMoved = 0;
canvas.addEventListener('mousedown', e => {
  if (ed.on && edPointerDown(e)) return; // [EDIT-MODE hook] 编辑态左键交给工具；空格/右键/中键仍平移
  if (!ed.on && e.button === 0) edHoldStart(e); // [EDIT-MODE hook] 浏览态长按进入编辑
  drag = { x: e.clientX, y: e.clientY, ox: state.ox, oy: state.oy, moved: 0 };
  lastDragMoved = 0;
  canvas.classList.add('panning');
  e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
  state.ox = drag.ox + dx;
  state.oy = drag.oy + dy;
  clampView(); requestView();
});
window.addEventListener('mouseup', () => { if (drag) lastDragMoved = drag.moved; drag = null; canvas.classList.remove('panning'); });
canvas.addEventListener('dblclick', () => { if (!ed.on) fitView(); }); // [EDIT-MODE hook] 编辑态双击不重置视图（避免连点画笔误触）
/* 键盘：+ / − 以画布中心缩放，0 适配窗口（输入框内不响应） */
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || state.view !== 'grid' || e.metaKey || e.ctrlKey) return;
  if (e.key === '=' || e.key === '+') zoomBtn(1.25);
  else if (e.key === '-' || e.key === '_') zoomBtn(1 / 1.25);
  else if (e.key === '0') fitView();
});
/* ===== [VIEW-SMOOTH] 缩放平移 END ===== */
