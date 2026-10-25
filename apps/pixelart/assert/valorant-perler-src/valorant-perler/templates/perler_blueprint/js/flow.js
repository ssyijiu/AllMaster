/* =====================================================================
 * [FLOW] 站点流 BEGIN
 * 页面最上方（原图 / 转换图 / 拼豆图纸、平面 / 3D）只管「怎么看」；编辑栏 #dock 管图纸产出与使用的动线：
 * 规格调整 → 图纸编辑 → 辅助拼豆。栏内顶部三个 Tab 给内容分类（面板区块用 data-st 声明所属站点，
 * 空格分隔，body[data-st] 决定显示哪些）。
 * 底部栏：栏顶是一条拖动横条（点一下收起 / 展开，上下拖改高矮，拖过最矮即收起）；收起时只藏面板、站点 Tab 留着，
 * 点任一站即展开到该站。侧栏：把手在朝画布的一边，收起整栏。收起状态记在 body.dock-closed。
 * 编辑工具条是编辑站内容的第一行；唯一会主动拉起编辑栏的是「进入编辑」（flowOnEdit），否则长按进编辑后看不到工具。
 * 3D 预览与导出不进站点：平面 / 3D 切换常驻在画布上方（modeSeg），导出常驻顶栏。
 * 编辑栏位置可切：底部（默认）/ 右侧 / 左侧（body[data-nav]，偏好存本机 localStorage）；
 * 窗口 < 960px 时 CSS 强制回到底部，切换按钮也不出现。样式在 css/flow.css。
 * 布局与输入方式分离：布局只看宽度，措辞与 3D 编辑限制只看是否触屏（isCoarse）。
 * 与其他模块的接点：
 *   edEnter()  → flowOnEdit()     从任何入口进入编辑（长按、孤立像素、E 键）都切到编辑站
 *   edExit()   → flowAfterExit()  在编辑站点「完成」后进入拼豆站
 *   edHudText() 读 isCoarse()     触屏设备换成手指的说法
 * ===================================================================== */
const flow = { st: 'plan', seen: new Set(['plan']), busy: false };
/* 辅助拼豆站是照着下豆的沉浸态：画布上不响应任何「进编辑」手势（单击 / 长按 / E 键 / 3D 双击），要改图回 02 站 */
function flowNoEdit() { return flow.st === 'codes'; }
const FLOW_NARROW = window.matchMedia('(max-width: 820px)');   // 紧凑布局断点
const FLOW_WIDE = window.matchMedia('(min-width: 960px)');     // 允许工具栏钉两侧的断点
let _coarseMQ = null;
function isCoarse() { if (!_coarseMQ) _coarseMQ = window.matchMedia('(hover: none) and (pointer: coarse)'); return _coarseMQ.matches; }
const FLOW_NEXT = {
  plan: ['edit', '下一步 · 图纸编辑'],
  edit: ['codes', '完成编辑，开始拼豆'],
  codes: ['export', '导出图纸'],          // 最后一站的大按钮：打开导出图纸抽屉（js/poster.js）
};
const FLOW_HINT = {
  edit: () => isCoarse() ? '单指绘制 · 双指缩放' : '左键绘制 · 滚轮 / 双指缩放', // 桌面兼顾鼠标滚轮与触控板双指
  codes: () => '带色号与用量的高清图纸，可存相册或发给朋友',
};

function flowSet(st) {
  flow.st = st; flow.seen.add(st);
  document.body.dataset.st = st;
  document.querySelectorAll('#flowNav button[data-st]').forEach(b => {
    b.classList.toggle('on', b.dataset.st === st);
    b.classList.toggle('seen', flow.seen.has(b.dataset.st));
  });
  const nx = FLOW_NEXT[st];
  document.getElementById('flowNextBtn').textContent = nx ? nx[1] : '';
  document.getElementById('flowHint').textContent = (FLOW_HINT[st] || (() => ''))();
  document.querySelector('aside').scrollTop = 0;
}
/* 面板高度变了，画布跟着重排；fit = 重新把整张图纸放进画布 */
function flowRelayout(fit) {
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
    if (fit && state.view === 'grid' && state.mode === '2d') fitView();
  });
}
async function flowGo(st) {
  if (flow.st === 'edit' && st !== 'edit' && ed.on) {
    flow.busy = true; await edExit(); flow.busy = false;
    if (ed.on) return;                               // 确认框里选了「继续编辑」
  }
  if (state.view !== 'grid') document.querySelector('.viewtab[data-view="grid"]').click();
  flowSet(st);
  if (st === 'edit' && !ed.on) edEnter();
  flowRelayout(FLOW_NARROW.matches && st !== 'edit'); // 窄屏面板高度随站点变，重新适配；桌面保持当前视图
}
function flowOnEdit() {
  if (isCoarse() && state.mode === '3d') setMode('2d');  // 触屏只在平面上编辑
  if (document.body.classList.contains('dock-closed')) dockSet(false);  // 工具条住在编辑栏里：进入编辑必须把栏拉起，否则看不到工具
  if (flow.st !== 'edit') { flowSet('edit'); flowRelayout(false); }
}
function flowAfterExit() {
  if (flow.busy || flow.st !== 'edit') return;
  flowGo('codes');
}

document.querySelectorAll('#flowNav button[data-st]').forEach(b => b.onclick = () => {
  if (document.body.classList.contains('dock-closed')) dockSet(false);   // 收起时只剩站点 Tab：点哪站就展开到哪站
  if (b.dataset.st !== flow.st) flowGo(b.dataset.st);
});
/* 把手：拉起 / 收起编辑栏，把整屏让给图纸 */
function dockSet(closed) {
  document.body.classList.toggle('dock-closed', closed);
  const h = document.getElementById('dockHandle');
  h.setAttribute('aria-expanded', String(!closed));
  h.setAttribute('aria-label', closed ? '展开编辑栏' : '收起编辑栏');
  dockTitle();
  flowRelayout(false);
}
/* 把手：点一下收起 / 展开；底部栏时按住上下拖动改栏高（移动超过 6px 才算拖，松手不再当作点击）。
 * 往下拖过最矮再多 DOCK_HCLOSE 即收起，拖动中拖回来又展开；收起后往上拖从最矮开始长高。
 * 高度写进 --dock-h（作用于 #dock aside），存本机；以收起结束的那次拖动不改记住的高度。
 * 侧栏时把手只管收起 / 展开，宽度由 #dockResize 调。 */
const DOCK_HMIN = 160, DOCK_HCLOSE = 48;
function dockTitle() {   // 悬停提示：底部栏时补一句可以拖高矮
  const h = document.getElementById('dockHandle'), closed = document.body.classList.contains('dock-closed');
  h.title = (closed ? '展开编辑栏' : '收起编辑栏') + (dockBottom() ? '；按住上下拖动可调高矮' : '');
}
const dockHMax = () => Math.max(DOCK_HMIN, Math.floor(window.innerHeight * 0.75));
const dockBottom = () => !FLOW_WIDE.matches || (document.body.dataset.nav || 'bottom') === 'bottom';
function dockHSet(h, save) {
  const aside = document.querySelector('#dock aside');
  if (h === null) {
    aside.style.removeProperty('--dock-h');
    if (save) try { localStorage.removeItem('perler-dock-h'); } catch (e) {}
    return null;
  }
  h = Math.round(Math.min(dockHMax(), Math.max(DOCK_HMIN, h)));
  aside.style.setProperty('--dock-h', h + 'px');
  if (save) try { localStorage.setItem('perler-dock-h', String(h)); } catch (e) {}
  return h;
}
try { const h0 = +localStorage.getItem('perler-dock-h'); if (h0) dockHSet(h0, false); } catch (e) {}
(() => {
  const h = document.getElementById('dockHandle'), aside = document.querySelector('#dock aside');
  let drag = null, moved = false, raf = 0;
  h.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !dockBottom()) return;
    const closed = document.body.classList.contains('dock-closed');
    drag = { y: e.clientY, h: closed ? DOCK_HMIN - 6 : aside.getBoundingClientRect().height };   // 收起时：越过 6px 起拖点正好落在最矮
    moved = false;
    h.setPointerCapture(e.pointerId);
  });
  h.addEventListener('pointermove', e => {
    if (!drag) return;
    if (e.pointerType === 'mouse' && !e.buttons) return end();   // 松手没收到（在页面外松开）：鼠标回来时按键已抬起，当作松手
    const dy = drag.y - e.clientY;   // 往上拖 = 栏变高
    if (!moved) {
      if (Math.abs(dy) < 6) return;
      moved = true;
      document.body.classList.add('dock-resizing-h');
    }
    const want = drag.h + dy, closed = document.body.classList.contains('dock-closed');
    if (want < DOCK_HMIN - DOCK_HCLOSE) { if (!closed) dockSet(true); return; }
    if (closed) dockSet(false);
    dockHSet(want, false);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; window.dispatchEvent(new Event('resize')); });   // 画布跟着重排
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    if (!moved) return;
    document.body.classList.remove('dock-resizing-h');
    if (!document.body.classList.contains('dock-closed')) dockHSet(aside.getBoundingClientRect().height, true);
    else try { const h0 = +localStorage.getItem('perler-dock-h'); dockHSet(h0 || null, false); } catch (e) { dockHSet(null, false); }   // 拖到收起：栏高回到记住的值，下次展开不是拖动途中的高度
    flowRelayout(false);
  };
  /* 拖动的结束不能只靠 pointerup：页面嵌在 WorkBuddy 窗口里，在页面外松手或捕获被系统收走时收不到 pointerup，
   * 拖动态会一直挂着（光标停在上下箭头、松手后移动还在改栏高）。lostpointercapture 在任何一种结束方式下都会来。 */
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end); h.addEventListener('lostpointercapture', end);
  h.addEventListener('click', e => {
    if (moved) { moved = false; e.preventDefault(); return; }   // 刚拖完的那次 click 不收起
    dockSet(!document.body.classList.contains('dock-closed'));
  });
  window.addEventListener('resize', () => { if (!drag) { const v = parseInt(aside.style.getPropertyValue('--dock-h')); if (v && v > dockHMax()) dockHSet(v, false); } });
})();
document.getElementById('flowNextBtn').onclick = () => {
  const nx = FLOW_NEXT[flow.st]; if (!nx) return;
  if (nx[0] === 'export') document.getElementById('flowExpBtn').click(); else flowGo(nx[0]);
};

/* 面板区块折叠：点区块标题（▼）收起 / 展开本区块；标题里的按钮（用量/色号排序）不触发 */
document.querySelectorAll('.panel-section .panel-label').forEach(l => {
  l.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    l.parentElement.classList.toggle('sec-closed');
  });
});

/* 顶栏「导出」由 js/poster.js 接管（导出图纸抽屉）；恢复初始图纸在「版本」面板里 */
/* 侧栏宽度：编辑栏钉左 / 右侧时拖朝画布那条边调宽窄（300px 到窗口 60%），双击恢复 380px；宽度存本机 */
const DOCK_W0 = 380, DOCK_WMIN = 300;
const dockWMax = () => Math.max(DOCK_WMIN, Math.min(760, Math.floor(window.innerWidth * 0.6)));
function dockWSet(w, save) {
  w = Math.round(Math.min(dockWMax(), Math.max(DOCK_WMIN, w)));
  document.body.style.setProperty('--dock-w', w + 'px');
  if (save) try { w === DOCK_W0 ? localStorage.removeItem('perler-dock-w') : localStorage.setItem('perler-dock-w', String(w)); } catch (e) {}
  return w;
}
try { const w0 = +localStorage.getItem('perler-dock-w'); if (w0) dockWSet(w0, false); } catch (e) {}
(() => {
  const bar = document.getElementById('dockResize'), dock = document.getElementById('dock');
  let drag = null, raf = 0;
  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, w: dock.getBoundingClientRect().width, sign: document.body.dataset.nav === 'left' ? 1 : -1 };
    bar.setPointerCapture(e.pointerId);
    document.body.classList.add('dock-resizing');
  });
  bar.addEventListener('pointermove', e => {
    if (!drag) return;
    if (e.pointerType === 'mouse' && !e.buttons) return end();   // 同上：页面外松手
    dockWSet(drag.w + (e.clientX - drag.x) * drag.sign, false);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; window.dispatchEvent(new Event('resize')); });   // 画布跟着重排
  });
  const end = () => {
    if (!drag) return;
    drag = null; document.body.classList.remove('dock-resizing');
    dockWSet(dock.getBoundingClientRect().width, true);
    flowRelayout(false);
  };
  bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end); bar.addEventListener('lostpointercapture', end);   // 同底部横条：页面外松手也要结束
  bar.addEventListener('dblclick', () => { dockWSet(DOCK_W0, true); flowRelayout(false); });
  window.addEventListener('resize', () => { if (!drag) { const v = parseInt(document.body.style.getPropertyValue('--dock-w')); if (v && v > dockWMax()) dockWSet(v, false); } });
})();

/* 编辑栏位置：底部（默认）/ 右侧 / 左侧；< 960px 时由 CSS 强制底部，这里只记偏好 */
const NAV_POS = ['bottom', 'right', 'left'];
function navPosGet() {
  let p = 'bottom';
  try { p = localStorage.getItem('perler-nav-pos') || 'bottom'; } catch (e) {}
  return NAV_POS.includes(p) ? p : 'bottom';
}
let navPos = navPosGet();
function navPosApply() {
  const p = navPos;
  document.body.dataset.nav = p;
  document.querySelectorAll('#navDock button').forEach(b => {
    const on = b.dataset.pos === p;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
document.querySelectorAll('#navDock button').forEach(b => b.onclick = () => {
  if (b.dataset.pos === navPos) return;
  navPos = b.dataset.pos;
  navPosApply(); flowRelayout(true); dockTitle();
  try { localStorage.setItem('perler-nav-pos', navPos); } catch (e) {}
});

document.getElementById('edPalFoot').textContent = '点击色块选取';
flowSet(flow.st);
navPosApply();
dockTitle();
FLOW_NARROW.addEventListener('change', () => flowRelayout(true));
FLOW_WIDE.addEventListener('change', () => { flowRelayout(true); dockTitle(); });
document.addEventListener('gesturestart', e => e.preventDefault()); // iOS：页面其他区域不跟着双指缩放
/* [FLOW] 站点流 END ============================================================= */