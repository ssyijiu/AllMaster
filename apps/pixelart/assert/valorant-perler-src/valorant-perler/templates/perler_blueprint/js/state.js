/* ================= 数据与状态 ================= */
const D = window.DEMO_DATA;
const PALS = {}; D.palettes.forEach(p => { p.byCode = {}; p.colors.forEach(c => p.byCode[c.code] = c); PALS[p.id] = p; });
const LEVELS = {}; D.levels.forEach(l => LEVELS[l.step] = l);
const DEFAULT_PAL = D.palettes[0].id;
let PAL = PALS[DEFAULT_PAL].byCode;   // 当前色板：色号 -> 颜色
const SIZES = {}; D.sizes.forEach(s => SIZES[s.key] = s);   // 板规格 key -> {w,h,isCustom}
// 本机存档按「这一次出的图」分开：同一个浏览器里 file:// 打开的所有图纸共用一份 localStorage，只用任务名会让同名的新图纸读到旧图纸的改动；
// 加上渲染时间后，重新出图从干净状态开始，同一份文件复制、转发、另存后打开仍接着原来的进度。局部修复版再另起一套，修复前的改动不会盖住修复版
const TASK_KEY = encodeURIComponent(D.taskName) + (D.renderedAt ? '@' + D.renderedAt.replace(/\D/g, '') : '') + (D.repairs ? '~r' + D.repairs.tag : '');

const state = {
  view: 'grid',
  mode: '2d',           // 图纸视图的看法：2d 平面俯视 / 3d 豆板 [VIEW-3D]
  size: D.defaultSize,
  sortKey: 'count',
  budget: 0,   // 色数档位 step：0 = 脚本默认，负 = 更少色，正 = 更多色
  palette: DEFAULT_PAL,
  highlight: null,      // 在拼色（唯一）
  done: new Set(),      // 已拼色（当前色板色号集合）
  mirror: false,
  meltOn: false,        // [IRON] 平面烫豆预览开关
  melt: 0,              // [IRON] 熔化程度 0..1
  scale: 0,             // 每格屏幕像素（CSS px）
  ox: 0, oy: 0,
};

/* 施工进度持久化（按任务和规格分键） */
const PKEY = () => `perler-progress-${TASK_KEY}-${state.size}-${state.palette}${state.budget ? "-b" + state.budget : ""}`;
function saveProgress() {
  try { localStorage.setItem(PKEY(), JSON.stringify({ cur: state.highlight, done: [...state.done] })); } catch (e) {}
}
function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(PKEY()) || 'null');
    state.highlight = p && p.cur || null;
    state.done = new Set(p && p.done || []);
  } catch (e) { state.highlight = null; state.done = new Set(); }
}
function toggleDone(code) {
  if (state.done.has(code)) {
    state.done.delete(code);
  } else {
    state.done.add(code);
    const left = D.specs[state.size].colors - state.done.size;
    toast(`${code} 已完成 · 剩余 ${left} 色`);
  }
  saveProgress(); renderColors(); renderHlStatus(); draw();
}
/* 点色号 = 选「正在拼」的颜色，只管高亮；✓ 是否拼完只由 ✓ 按钮改，两件事互不牵动 */
function setCurrent(code) {
  state.highlight = state.highlight === code ? null : code;
  saveProgress(); renderColors(); renderHlStatus(); draw();
}

