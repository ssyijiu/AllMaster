/* =====================================================================
 * [TOUCH] 平面图纸的手指操作 BEGIN
 * 只接管 pointerType === 'touch'，鼠标 / 触控板仍走 view-smooth.js 与 edit-mode.js 的原路径。
 * 手势表：
 *   浏览：单指拖 = 平移；点按 = 看该格色号；长按 = 以该格颜色进入编辑；双指 = 捏合缩放 + 平移
 *   编辑：画笔 / 橡皮单指拖 = 连续落豆 / 擦豆（一笔一步撤销）；填充 / 吸管抬指生效；套索单指拖 = 圈选 / 拖动选区（点选同色是点按抬指生效）；手掌单指拖 = 平移
 *         手指按下先等 STROKE_WAIT 或挪动超过 MOVE_TOL 才落笔：这段时间里第二根手指到达就直接转双指，不留痕
 *         已开始的一笔遇到第二根手指或 pointercancel（iOS 进双指时常见）一律撤回，不进撤销栈
 * pointerdown 调 preventDefault，浏览器不再合成 mousedown / mousemove，避免与鼠标路径重复处理。
 * 编辑动作复用 edPointerDown / edStrokeMove / edStrokeEnd，不复制编辑逻辑。
 * ===================================================================== */
(function touchInput() {
  const pts = new Map();
  const T = { mode: null, start: null, pinch: null, hold: null, lastTouch: 0, tipTm: 0 };
  const MOVE_TOL = 8, STROKE_WAIT = 80;

  const rect = () => canvas.getBoundingClientRect();
  function holdCancel() {
    if (!T.hold) return;
    clearTimeout(T.hold.show); clearTimeout(T.hold.fire); T.hold = null;
    document.getElementById('edHoldRing').classList.remove('show');
  }
  function holdStart(e) {
    const cell = cellAt(e); if (!cell || flowNoEdit()) return; // [FLOW hook] 辅助拼豆站长按不进编辑，只看色号
    const r = canvas.parentElement.getBoundingClientRect(), ring = document.getElementById('edHoldRing');
    ring.style.left = (e.clientX - r.left) + 'px'; ring.style.top = (e.clientY - r.top) + 'px';
    T.hold = {
      show: setTimeout(() => ring.classList.add('show'), 120),
      fire: setTimeout(() => {
        holdCancel(); T.mode = 'done'; tipHide();
        if (navigator.vibrate) navigator.vibrate(12);
        edEnter(grid[cell[1]][cell[0]]);
      }, HOLD_MS),
    };
  }
  /* 点按看色号：描边 + 浮动提示，2.5 秒后自动收起 */
  function tipHide() {
    clearTimeout(T.tipTm);
    document.getElementById('edTip').classList.remove('show');
    if (edBrowseHint !== null) { edBrowseHint = null; requestView(); }
  }
  function tapInfo(e) {
    const cell = cellAt(e);
    if (!cell) { tipHide(); return; }
    const [i, j] = cell, code = grid[j][i], c = edCol(code);
    edBrowseHint = j * GW + i; requestView();
    const el = document.getElementById('edTip'), r = canvas.parentElement.getBoundingClientRect();
    el.innerHTML = code ? `<b>${c.code}</b> ${c.name.startsWith('≈') ? '' : c.name} · (${i + 1}, ${j + 1})` : `空白 · (${i + 1}, ${j + 1})`;
    el.classList.add('show');
    const x = e.clientX - r.left, y = e.clientY - r.top;
    el.style.left = Math.max(6, Math.min(x - el.offsetWidth / 2, r.width - el.offsetWidth - 6)) + 'px';
    el.style.top = Math.max(6, y - el.offsetHeight - 26) + 'px';
    clearTimeout(T.tipTm); T.tipTm = setTimeout(tipHide, 2500);
  }
  /* 一笔还没提交就转成双指：把这笔落下的豆撤回，不进撤销栈 */
  function strokeRevert() {
    if (ed.lasso) { ed.lasso = null; ed.preview = null; ed.previewInfo = ''; edRequestDraw(); return; }
    const st = ed.stroke; if (!st) return;
    for (let k = st.changes.length - 1; k >= 0; k--) edSetCell(st.changes[k][0], st.changes[k][1]);
    ed.stroke = null; ed.pops = []; ed.hoverCell = null; ed.previewInfo = '';
    edAfterChange();
  }
  /* 等待期满 / 手指挪动：从按下的位置开始落笔（或开始圈选、拖选区） */
  function strokeBegin() {
    clearTimeout(T.wait);
    if (T.mode !== 'wait' || !T.down) return;
    edPointerDown(T.down);
    T.mode = ed.stroke || ed.lasso ? 'stroke' : 'pan';
  }
  function pinchStart() {
    const [a, b] = [...pts.values()];
    T.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, s: state.scale, ox: state.ox, oy: state.oy };
  }
  function panStart(p) { T.start = { x: p.x, y: p.y, ox: state.ox, oy: state.oy }; }

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    T.lastTouch = performance.now();
    if (pts.size === 1) {
      panStart(pts.get(e.pointerId));
      if (!ed.on) { T.mode = 'tap'; holdStart(e); return; }
      if (ed.tool === 'hand') {                         // 按在套索选区上：立即开始拖选区；其余单指挪视角
        if (edSelHit(cellAt(e))) { edPointerDown(e); T.mode = ed.lasso ? 'stroke' : 'pan'; return; }
        T.mode = 'pan'; return;
      }
      if (ed.tool === 'brush' || ed.tool === 'eraser' || ed.tool === 'lasso') {
        T.mode = 'wait'; T.down = e;
        T.wait = setTimeout(strokeBegin, STROKE_WAIT); return;
      }
      T.mode = 'toolTap';                                // 填充 / 吸管：抬指时生效
      return;
    }
    holdCancel(); tipHide();
    clearTimeout(T.wait);
    if (T.mode === 'stroke') strokeRevert();
    if (pts.size === 2) { T.mode = 'pinch'; pinchStart(); }
  });

  canvas.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (T.mode === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()], P = T.pinch, r = rect();
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const ns = Math.min(ZMAX, Math.max(zMin(), P.s * d / P.d));
      const u = (P.cx - r.left - P.ox) / P.s, v = (P.cy - r.top - P.oy) / P.s;  // 起始双指中点下的图纸坐标
      state.scale = ns; state.ox = cx - r.left - u * ns; state.oy = cy - r.top - v * ns;
      clampView(); requestView();
      return;
    }
    if (T.mode === 'wait' && Math.abs(e.clientX - T.start.x) + Math.abs(e.clientY - T.start.y) > MOVE_TOL) strokeBegin();
    if (T.mode === 'stroke') { edStrokeMove(e); return; }
    if (!T.start) return;
    const dx = e.clientX - T.start.x, dy = e.clientY - T.start.y;
    if ((T.mode === 'tap' || T.mode === 'toolTap') && Math.abs(dx) + Math.abs(dy) > MOVE_TOL) { holdCancel(); tipHide(); T.mode = 'pan'; }
    if (T.mode === 'pan') { state.ox = T.start.ox + dx; state.oy = T.start.oy + dy; clampView(); requestView(); }
  });

  function up(e) {
    if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    T.lastTouch = performance.now();
    if (pts.size === 1) {                               // 双指松开一根：剩下那根接着平移
      if (T.mode === 'pinch') { T.mode = 'pan'; panStart([...pts.values()][0]); }
      return;
    }
    if (pts.size) return;
    holdCancel();
    if (T.mode === 'wait') { if (e.type === 'pointerup') strokeBegin(); else T.mode = null; } // 很快的一点：照常落一颗豆
    const m = T.mode; T.mode = null; T.start = null; T.down = null;
    if (m === 'stroke') { if (e.type === 'pointercancel') strokeRevert(); else edStrokeEnd(); }
    else if (m === 'toolTap' && e.type === 'pointerup') edPointerDown(e);
    else if (m === 'tap' && e.type === 'pointerup') tapInfo(e);
  }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  /* 触摸之后浏览器仍会补发 click / dblclick：吞掉，免得走鼠标的「单击进编辑」「双击适配」 */
  const swallow = e => { if (performance.now() - T.lastTouch < 700) { e.stopImmediatePropagation(); e.preventDefault(); } };
  canvas.addEventListener('click', swallow, true);
  canvas.addEventListener('dblclick', swallow, true);
  canvas.addEventListener('contextmenu', e => { if (performance.now() - T.lastTouch < 1500) e.preventDefault(); });
})();
/* [TOUCH] 平面图纸的手指操作 END ================================================= */
