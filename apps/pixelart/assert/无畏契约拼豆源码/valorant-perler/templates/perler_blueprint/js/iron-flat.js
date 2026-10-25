/* ================= [IRON] 平面烫豆预览 =================
 * 烫豆效果不依赖 3D：平面图纸看法下点「模拟烫豆」，画布直接按熔化程度渲染熔豆，可自动播放或拖滑条。
 * 熔化模型与 3D 俯视同口径（view-3d.js 的 cellMelt / beadPos 顶视轮廓），改一边必须同步另一边：
 *   每格熔化时刻 = 左上→右下对角扫描 + 少量随机；豆朝「有邻豆且双方都在熔」的方向铺满到格边（方化），
 *   外轮廓一侧拉直并与相邻豆对齐，只有外凸角保留圆角；色块交界是干净的硬边；中心孔随熔化收缩直至闭合。
 *   （平面无孔与 3D 俯视在外轮廓与交界上已不同式：3D 仍是圆鼓外沿 + 揉色。）
 * 平面与 3D视角 共用这一个开关、这一条控制条（播放 / 进度滑条 / 烫法）和同一个进度：
 *   平面下画布按熔化度画熔豆；3D视角 下进度写进着色器（V3.melt）；播放中切视角接着播。
 * 编辑中也能开：落笔照常改格子，播放中会先停住，新豆按当前熔化度显示（edPointerDown 钩子，平面与 3D 同一行为）。
 * 切到原图/转换图会退出预览。 */

const IRON_TABLE = [245, 242, 234], IRON_TABLE_HEX = '#F5F2EA'; // 画布底色（base.css --paper）：烫后成品放在它上面
const IRON_HOLE = 0.14; // 孔半径与 3D uHole 一致
const ironFr = x => x - Math.floor(x);
/* 与 3D 着色器 cellMelt 同式（不含编辑重烫） */
function ironCellMelt(r, c) {
  let p3 = [ironFr(c * .1031), ironFr(r * .1031), ironFr(c * .1031)];
  const d = p3[0] * (p3[1] + 33.33) + p3[1] * (p3[2] + 33.33) + p3[2] * (p3[0] + 33.33);
  p3 = p3.map(v => v + d);
  const h = ironFr((p3[0] + p3[1]) * p3[2]);
  const st = (c + r) / Math.max(GW + GH - 2, 1) * 0.55 + h * 0.08;
  let m = Math.min(Math.max((state.melt - st) / 0.35, 0), 1);
  return m * m * (3 - 2 * m);
}
const ironOcc = (r, c) => r >= 0 && c >= 0 && r < GH && c < GW && !!grid[r][c];

/* 单格熔豆（顶视）：r/c 为格坐标，x/y/s 为屏幕格位。
 * 分两遍画：第一遍所有格的豆形，第二遍所有格的本色重铺与中心孔。
 * 若逐格一次画完，后画的格子补缝描边会压在先画格子的揉色上，放大后格边出现一条条亮线 */
function ironDrawCells(cells) {
  const nfs = cells.map(a => ironCellShape(...a));
  cells.forEach((a, k) => ironCellDecor(...a, nfs[k]));
}
/* 豆形 = 四边各自外伸、四角各自圆角的圆角矩形。未熔时四边都缩在 .43、圆角 .43，即一颗圆豆。
 * 熔合边（有邻豆且双方都在熔）随熔化外伸到格边 .505，与邻豆压在一起；
 * 自由边（外轮廓）随熔化只外扩到 .46，并且拉直：同一条外轮廓上相邻几颗豆的自由边对齐成一条直线，不再一鼓一鼓。
 * 圆角只留在外凸角（相邻两边都自由），随熔化收到 .16；只要一侧熔合，该角随熔化收成直角，和邻豆接平。 */
function ironCellPath(x, y, s, m, nf) {
  const cx = x + s / 2, cy = y + s / 2, R0 = .43;
  const ext = f => (R0 + (f > 0 ? (.505 - R0) * f : (.46 - R0) * m)) * s;
  const eE = ext(nf.E), eW = ext(nf.W), eS = ext(nf.S), eN = ext(nf.N);
  const rad = (a, b) => (R0 - (R0 - .16) * m) * (1 - Math.max(a, b) / Math.max(m, 1e-6)) * s;
  const lim = (r, a, b) => Math.max(0, Math.min(r, a, b));
  const L = cx - eW, Rt = cx + eE, T = cy - eN, B = cy + eS;
  const w = Rt - L, h = B - T;
  const rNE = lim(rad(nf.N, nf.E), w / 2, h / 2), rSE = lim(rad(nf.S, nf.E), w / 2, h / 2),
        rSW = lim(rad(nf.S, nf.W), w / 2, h / 2), rNW = lim(rad(nf.N, nf.W), w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(L + rNW, T);
  ctx.lineTo(Rt - rNE, T); if (rNE) ctx.arcTo(Rt, T, Rt, T + rNE, rNE);
  ctx.lineTo(Rt, B - rSE); if (rSE) ctx.arcTo(Rt, B, Rt - rSE, B, rSE);
  ctx.lineTo(L + rSW, B); if (rSW) ctx.arcTo(L, B, L, B - rSW, rSW);
  ctx.lineTo(L, T + rNW); if (rNW) ctx.arcTo(L, T, L + rNW, T, rNW);
  ctx.closePath();
}
function ironCellShape(x, y, s, c, r, col) {
  const m = ironCellMelt(r, col);
  const nb = (dr, dc) => ironOcc(r + dr, col + dc) ? Math.min(m, ironCellMelt(r + dr, col + dc)) : 0;
  let nE = nb(0, 1), nW = nb(0, -1);
  const nS = nb(1, 0), nN = nb(-1, 0);
  if (state.mirror) [nE, nW] = [nW, nE]; // 镜像时屏幕左右与格坐标相反
  const nf = { E: nE, W: nW, S: nS, N: nN, m };
  ironCellPath(x, y, s, m, nf);
  ctx.fillStyle = c.hex;
  ctx.fill();
  if (m > 0) { ctx.strokeStyle = c.hex; ctx.lineWidth = 1; ctx.stroke(); } // 补抗锯齿缝：3D 靠 0.505 几何重叠，canvas 边缘半透明会漏出纸色细线
  return nf;
}
function ironCellDecor(x, y, s, c, r, col, nf) {
  const m = nf.m, cx = x + s / 2, cy = y + s / 2;
  // 邻豆的补缝描边会伸进本格半个像素：在本格方格内重铺本色盖住它，色块交界保持一条干净的边（不做渐变揉色，放大看不糊）
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, s, s); ctx.clip();
  ironCellPath(x, y, s, m, nf); ctx.fillStyle = c.hex; ctx.fill();
  ctx.restore();
  const ri = IRON_HOLE * (1 - Math.pow(m, 0.7)) * s; // 中心孔：露出底下纸面
  if (ri > 0.4) {
    ctx.fillStyle = IRON_TABLE_HEX; // 撕下来的豆片，孔里透出的是桌面（画布底色），不是豆板
    ctx.beginPath(); ctx.arc(cx, cy, ri, 0, 7); ctx.fill();
  }
}

const ironBtn = document.getElementById('ironBtn');
const ironBar = document.getElementById('ironBar');
const ironPlayBtn = document.getElementById('ironPlay');
const ironMeltIn = document.getElementById('ironMelt'), ironPlayIco = ironPlayBtn.querySelector('.ico');
const IRON_SECONDS = 4.5; // 平面与 3D视角 同速
let ironPlaying = false, ironLastT = 0, ironRaf = 0;

/* 播放按钮图标用内联 SVG：字符图标（⏸ ▶ ↺）在部分设备上会变成彩色 emoji 或缺字方块 */
const IRON_ICONS = {
  play: '<svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor"><path d="M3 1.5v9l7-4.5z"/></svg>',
  pause: '<svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor"><rect x="2.5" y="1.5" width="2.4" height="9"/><rect x="7.1" y="1.5" width="2.4" height="9"/></svg>',
  replay: '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.2 6a3.8 3.8 0 1 0 1.1-2.7"/><path d="M2 1.6v2.6h2.6" stroke-linejoin="round"/></svg>',
};
function ironSetProgress(p) {
  state.melt = p;
  ironMeltIn.value = Math.round(p * 1000);
  const ico = ironPlaying ? 'pause' : p >= 1 ? 'replay' : 'play';
  if (ironPlayBtn.dataset.ico !== ico) { ironPlayBtn.dataset.ico = ico; ironPlayIco.innerHTML = IRON_ICONS[ico]; ironPlayBtn.title = { pause: '暂停', replay: '重播', play: '播放' }[ico]; }
  if (state.mode === '3d') { if (V3) V3.melt(p); } else draw(); // [VIEW-3D hook] 3D视角 每帧自己渲染，只需更新熔化度
}
function ironStop() { ironPlaying = false; cancelAnimationFrame(ironRaf); }
function ironPlay() {
  if (ironPlaying) { ironStop(); ironSetProgress(state.melt); return; }
  if (state.melt >= 1) state.melt = 0;
  ironPlaying = true; ironLastT = null; // 计时起点取首帧 rAF 时间戳：rAF 时间可能早于 performance.now()，混用会算出负进度
  ironSetProgress(state.melt);
  const tick = t => {
    if (!ironPlaying) return;
    if (ironLastT === null) ironLastT = t;
    const dt = Math.min(Math.max(t - ironLastT, 0), 100); // 单帧最多推进 0.1 秒：3D视角 在慢设备上一帧很久，不让动画两三帧就跳到结尾
    const p = Math.min(Math.max(state.melt + dt / 1000 / IRON_SECONDS, 0), 1);
    ironLastT = t;
    if (p >= 1) ironStop();
    ironSetProgress(p);
    if (ironPlaying) ironRaf = requestAnimationFrame(tick);
  };
  ironRaf = requestAnimationFrame(tick);
}
function ironEnter() {
  if (state.view !== 'grid') document.querySelector('.viewtab[data-view="grid"]').click(); // 从原图 / 转换图点也直接回到图纸看烫后
  state.meltOn = true;
  if (state.mode === '3d' && V3) V3.iron(ironStyle);
  document.body.classList.add('ironon');
  ironBtn.classList.add('on');
  if (state.mode === '3d') draw(); // [3D-PROGRESS hook] 豆板换成撕下的豆片，进度态照常显示
  ironSetProgress(0);
  ironPlay();
}
function ironExit() { // 幂等：被「模拟烫豆」按钮、切到原图 / 转换图调用
  if (!state.meltOn) return;
  ironStop();
  state.meltOn = false;
  document.body.classList.remove('ironon');
  ironBtn.classList.remove('on');
  if (state.mode === '3d' && V3) V3.melt(0); // 关掉预览 = 回到烫前
  if (state.mode === '3d' && V3) V3.iron('plain');
  draw();
}
ironBtn.onclick = () => { state.meltOn ? ironExit() : ironEnter(); };
ironPlayBtn.onclick = ironPlay;

ironMeltIn.oninput = () => { ironStop(); ironSetProgress(ironMeltIn.value / 1000); };

/* ===== [IRON] 烫法切换（平面）：质感层 + 烫法按钮 =====
 * 「无孔」沿用上面的 canvas 熔豆画法；带纹理的烫法交给 iron-gl.js 的质感层，参数按当前板规格取 IRON_PARAMS。
 * 切到另一种烫法时进度归零、从头播放。选的烫法记在本机，下次打开沿用。平面与 3D视角 都按所选烫法渲染。
 * 五种烫法平铺成五个按钮：无孔 / 毛巾 / 澡巾 / 细闪 / 粗闪。 */
const ironGLCv = document.getElementById('ironGL');
let ironGL, ironStyle = IRON_DEFAULT_STYLE, ironAnim = 0;
try { const k = localStorage.getItem('perler-iron-style'); if (IRON_STYLES.some(s => s.key === k)) ironStyle = k; } catch (e) {}
function ironGLReady() {
  if (ironGL === undefined) { try { ironGL = IronGL.create(ironGLCv); } catch (e) { ironGL = null; } }
  return ironGL;
}
function ironUsesGL() {
  return state.meltOn && state.mode === '2d' && ironStyle !== 'plain' && !!ironGLReady();
}
function ironGLFrame(time) {
  const st = IRON_STYLES.findIndex(s => s.key === ironStyle), pr = ironParamsFor(Math.max(GW, GH), ironStyle);
  ironGL.render({ w: canvas.width / dpr, h: canvas.height / dpr, dpr, ox: state.ox, oy: state.oy, s: state.scale, mirror: state.mirror,
    ruler: RULER, progress: state.melt, paper: IRON_TABLE, style: IRON_STYLES[st].sh, mat: IRON_STYLES[st].mat, melt: pr.melt, amp: pr.amp, scale: pr.scale, p: pr.p, glit: ironGlitterFor(Math.max(GW, GH), ironStyle), time });
}
function ironGLDraw() {
  const on = ironUsesGL();
  ironGLCv.classList.toggle('show', on);
  if (!on) { cancelAnimationFrame(ironAnim); ironAnim = 0; return; }
  const pv = ed.preview, g = pv ? grid.map((row, j) => row.map((code, i) => { const v = pv.get(j * GW + i); return v === undefined ? code : v; })) : grid; // [EDIT-MODE hook] 编辑悬停预览同样画进烫后质感
  const hl = trackHL();
  ironGL.setGrid(g, code => (progTodo(code, hl) ? progFade(code) : edCol(code)).rgb); // [PROGRESS] 没拼的豆淡成桌面色，与无孔烫同口径（编辑中 progOn 为假，只剩预览）
  ironGLFrame(performance.now() / 1000);
  if (!ironAnim) { // 光源缓慢摆动，平面俯视下也能看到闪片和毛面的明暗变化
    const loop = t => { if (!ironUsesGL()) { ironAnim = 0; return; } ironGLFrame(t / 1000); ironAnim = requestAnimationFrame(loop); };
    ironAnim = requestAnimationFrame(loop);
  }
}
const ironStylesEl = document.getElementById('ironStyles');
function ironStyleLabels() {
  ironStylesEl.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.k === ironStyle));
}
IRON_STYLES.forEach(s => {
  const b = document.createElement('button');
  b.textContent = s.name; b.dataset.k = s.key;
  b.onclick = () => { // 换烫法 = 换一块布重新烫：进度归零从头播放；再点当前烫法 = 跳过动画直接看成品
    if (s.key === ironStyle) {
      if (state.melt < 1) { ironStop(); ironSetProgress(1); }
      return;
    }
    ironStyle = s.key;
    try { localStorage.setItem('perler-iron-style', s.key); } catch (e) {}
    ironStyleLabels();
    if (state.mode === '3d' && V3) V3.iron(ironStyle);
    ironStop(); state.melt = 0; ironPlay();
  };
  ironStylesEl.appendChild(b);
});
ironStyleLabels();
