/* ===== [VIEW-ZOOM] 原图 / 转换图的缩放平移 BEGIN =====
 * 与图纸同一套交互口径（见 view-smooth.js / touch.js）：
 *   右上角「+ / − / 恢复 / 百分比」；滚轮、⌘/Ctrl+滚轮、触控板捏合 = 以指针为中心缩放；触控板双指 = 平移；
 *   鼠标拖拽 = 平移；手指单指拖 = 平移、双指 = 捏合缩放；键盘 + / − / 0。
 * 100% = 图片按页面适配后的大小（与图纸 100% = 适配窗口同义），「恢复」回到 100% 并居中，已在 100% 时置灰不可点。
 * 每个看法各存一份 {s, tx, ty}，切走再切回保持原样；图纸自己的缩放存在 state.scale/ox/oy，同样切换不丢。
 * 实现：内容包在 .zstage 里，用 transform 平移缩放；.zstage 在容器里 flex 居中，所以以容器中心为原点换算。 */
const ZV_MIN = 0.5, ZV_MAX = 10;
const ZV = {}; // view → { wrap, stage, pct, s, tx, ty }
function zvApply(z) {
  z.stage.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
  z.pct.textContent = Math.round(z.s * 100) + '%';
  z.fit.disabled = z.s === 1 && z.tx === 0 && z.ty === 0;
}
/* 以容器内一点 (px, py)（相对容器左上角）为不动点缩放 */
function zvZoomAt(z, px, py, f) {
  const ns = Math.min(ZV_MAX, Math.max(ZV_MIN, z.s * f)), k = ns / z.s;
  const r = z.wrap.getBoundingClientRect(), cx = px - r.width / 2, cy = py - r.height / 2;
  z.tx = cx - (cx - z.tx) * k; z.ty = cy - (cy - z.ty) * k; z.s = ns;
  zvClamp(z); zvApply(z);
}
/* 平移限位：内容至少留 80px 在容器内，不会被拖丢 */
function zvClamp(z) {
  const r = z.wrap.getBoundingClientRect(), w = z.stage.offsetWidth * z.s, h = z.stage.offsetHeight * z.s, m = 80;
  const lx = Math.max(0, (r.width + w) / 2 - m), ly = Math.max(0, (r.height + h) / 2 - m);
  z.tx = Math.min(lx, Math.max(-lx, z.tx)); z.ty = Math.min(ly, Math.max(-ly, z.ty));
}
function zvReset(z) { z.s = 1; z.tx = 0; z.ty = 0; zvApply(z); }
function zvCenter(z, f) { const r = z.wrap.getBoundingClientRect(); zvZoomAt(z, r.width / 2, r.height / 2, f); }

function zvInit(view) {
  const wrap = document.getElementById('view-' + view);
  const stage = wrap.querySelector('.zstage'), ctl = wrap.querySelector('.zoomctl');
  const z = ZV[view] = { wrap, stage, pct: ctl.querySelector('.zpct'), fit: ctl.querySelector('[data-z="fit"]'), s: 1, tx: 0, ty: 0 };
  ctl.querySelector('[data-z="in"]').onclick = () => zvCenter(z, 1.3);
  ctl.querySelector('[data-z="out"]').onclick = () => zvCenter(z, 1 / 1.3);
  ctl.querySelector('[data-z="fit"]').onclick = () => zvReset(z);
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (e.ctrlKey || e.metaKey) zvZoomAt(z, mx, my, Math.exp(-dy * 0.012));
    else if (e.shiftKey) { z.tx -= dy; zvClamp(z); zvApply(z); }
    else if (isMouseWheel(e)) zvZoomAt(z, mx, my, Math.exp(-dy * 0.0022));
    else { z.tx -= e.deltaX; z.ty -= e.deltaY; zvClamp(z); zvApply(z); }
  }, { passive: false });
  /* 拖拽 + 双指捏合：pointer 事件统一处理鼠标与手指 */
  const pts = new Map(); let pan = null, pinch = null;
  wrap.addEventListener('pointerdown', e => {
    if (e.target.closest('.zoomctl')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    wrap.setPointerCapture(e.pointerId); e.preventDefault();
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { pan = { x: e.clientX, y: e.clientY, tx: z.tx, ty: z.ty }; wrap.classList.add('panning'); }
    else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }; pan = null;
    }
  });
  wrap.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, r = wrap.getBoundingClientRect();
      z.tx += mx - pinch.mx; z.ty += my - pinch.my;
      zvZoomAt(z, mx - r.left, my - r.top, d / (pinch.d || d));
      pinch = { d, mx, my };
    } else if (pan) {
      z.tx = pan.tx + e.clientX - pan.x; z.ty = pan.ty + e.clientY - pan.y; zvClamp(z); zvApply(z);
    }
  });
  const up = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) { const [p] = [...pts.values()]; pan = { x: p[0], y: p[1], tx: z.tx, ty: z.ty }; }
    if (!pts.size) { pan = null; wrap.classList.remove('panning'); }
  };
  wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  wrap.addEventListener('dblclick', e => { if (!e.target.closest('.zoomctl')) zvReset(z); }); // 与图纸双击回到适配一致
  zvApply(z);
}
zvInit('source'); zvInit('pixel');
window.addEventListener('keydown', e => {
  const z = ZV[state.view];
  if (!z || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
  if (e.key === '=' || e.key === '+') zvCenter(z, 1.25);
  else if (e.key === '-' || e.key === '_') zvCenter(z, 1 / 1.25);
  else if (e.key === '0') zvReset(z);
});
/* ===== [VIEW-ZOOM] END ===== */
