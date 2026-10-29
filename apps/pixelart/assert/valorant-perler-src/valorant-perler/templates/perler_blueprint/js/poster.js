/* =====================================================================
 * [POSTER] 导出图纸抽屉 BEGIN
 * 顶栏「导出」从底部升起抽屉，海报用 Canvas 逐元素绘制，预览与出图共用 drawPoster：
 * 左侧海报预览（整张可放大、拖动查看，只影响预览，不进出图）+ 右侧选项 + 下载 PNG（固定最高清，手机按设备画布上限封顶；手机弹出成品图长按保存）。
 * 海报画面不带任何品牌标识（无 logo、无二维码、无来源字样）。版式自上而下：规格条（规格 / 色板 / 色数 / 用豆）
 * → 图纸面板（按图纸宽高比铺满，画面绝对主体）→ 色号表（滑块调色块大小：最左是关，越往右色块越大、一行越少）→ 底栏（原图、烫后小图 + 右侧说明）。
 * 主图一个下拉单选：图纸（方豆，二级开关色号、网格、发光）或某种烫法的烫后效果（二级开关只有发光）；底栏原图开关 + 烫后小图下拉多选（每种一张「X烫效果模拟」），
 * 主图已经用的烫法在底栏置灰、不重复放。两个下拉共用自绘弹出菜单 #psMenu。
 * 烫法五项（无孔 / 毛巾 / 澡巾 / 细闪 / 粗闪），默认跟图纸页模拟烫豆当前所选。
 * 文字用随包内联的腾讯体子集（TencentSans：300=W3 标签，700=W7 标题与数值）；layout() 按当前选项算出各块位置与海报总高。
 * 海报数据每次打开时从当前图纸取（grid / colorMap / D.specs[state.size]），编辑后的改动、换色板都会带上。
 * 与其他模块的接点：flowExpBtn 打开抽屉；页面标题 state.title 只用于下载文件名，海报画面不放标题。
 * 全部变量收在 IIFE 里，DOM 与样式带 ps 前缀（css/poster.css）。
 * ===================================================================== */
(function () {
const $ = id => document.getElementById(id);
const PW = 1080, M = 56, PAD = 46, TS = '"TencentSans","PingFang SC","Microsoft YaHei",sans-serif';
/* 随包腾讯体是子集：字表在发版构建时从模板文案自动收集
 * （海报、抽屉、色板中文色名都在内），W3 与 W7 收同一套字，改文案后需重新生成子集。
 * 随包字体没加载成功时不改写文案，整句交给用户设备字体渲染——句子完整比字形统一更要紧。 */
const FALLBACK_FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Heiti SC",sans-serif';
let FACE_READY = false;
/* 色号表色块大小：滑块最左一档是「关」（不画色号表），向右逐档变大、一行个数变少。
 * 下标 = chipLevel - 1；相邻两档色块宽约差 1.4 倍，每档都看得出差别，一行个数越多色块越矮。 */
const CHIP_COLS = [24, 16, 12, 8, 6];
const CHIP_H = [50, 60, 66, 66, 68];               // 每档色块高，随一行个数减少单调不减
function chipSpec(cols) {
  const i = CHIP_COLS.indexOf(cols);
  const named = cols <= 8;                          // 一行 8 个及以下放得下色名
  const gap = cols <= 8 ? 12 : cols <= 12 ? 10 : cols <= 16 ? 8 : 6;
  const w = (PW - 2 * M - gap * (cols - 1)) / cols;
  const fs = cols <= 12 ? 17 : cols <= 16 ? 15 : 13;
  return { cols, named, gap, w, h: CHIP_H[i], fs, cnt: cols <= 16 ? 13 : 11 };
}
const chipShown = () => P.chipLevel > 0;           // 0 档是关，整块不画
const chipCols = () => CHIP_COLS[P.chipLevel - 1];
const thumbsShown = () => P.thumbs.filter(k => !(P.main === 'iron' && k === P.ironStyle));   // 主图已经是这种烫法时，底栏不重复放
const corners = () => [P.source && HAS_SOURCE && ready(srcImg) && 'source', ...thumbsShown()].filter(Boolean);   // 'source' 或烫法 key
let L = {}, PH = 1600;
function layout() {
  const stripY = 48, by = stripY + 48 + 28, bw = PW - 2 * M;
  const cell = Math.min((bw - 2 * PAD) / PGW, ((bw - 2 * PAD) * 1.3) / PGH);
  const gbw = PGW * cell, gbh = PGH * cell, bh = gbh + 2 * PAD;
  let y = by + bh + 30;
  const chipY = y;
  if (chipShown()) { const k = chipSpec(chipCols()); y += Math.ceil(PT.palette.length / k.cols) * (k.h + k.gap) - k.gap + 34; }
  const footY = y, footH = corners().length ? 178 : 84;
  L = { stripY, bx: M, by, bw, bh, gx: M + (bw - gbw) / 2, gy: by + PAD, gbw, gbh, cell, chipY, footY };
  PH = Math.round(footY + footH + 40);
}
const LAT = '"DIN Alternate","Bahnschrift","Arial Narrow","PingFang SC",sans-serif';
const C = { ink: '#0F1923', ink2: '#16202B', ink3: '#1E2B38', red: '#FF4655', bone: '#ECE8E1', mut: '#8B9BB0', light: false };
const P = { main: 'board', codes: true, grid: true, glow: true, source: true, thumbs: ['plain'], ironStyle: 'plain', chipLevel: 3 };   // thumbs：底栏放哪几种烫后小图（按 IRON_STYLES 顺序，空 = 不放）
const PNG_SCALE = 3.5556;   // 小规格（≤104）基准 4K 宽；中/大规格按分辨率梯度升档（pngGrade）
const view = { z: 1, tx: 0, ty: 0 };   // 主图区（图纸框）里图纸的缩放，及图纸中心相对框中心的平移（海报坐标）；预览与出图共用

/* ---------- 图纸快照：打开抽屉时从当前图纸取 ---------- */
let PT = null, cells = [], PGW = 0, PGH = 0, glowCache = null, glowKey = '', ironCache = null, ironStyledCache = {}, ironThumbCache = {};
function snapshot() {
  const sp = D.specs[state.size];
  const rows = Object.entries(sp.counts).sort((a, b) => b[1] - a[1]);
  const idx = {};
  const palette = rows.map(([code, n], i) => {
    idx[code] = i;
    const c = colorMap[code];
    return { code, name: c.name.startsWith('≈') ? '' : c.name, hex: c.hex, count: n };
  });
  PGW = GW; PGH = GH;
  cells = grid.map(row => row.map(code => code ? idx[code] : -1));
  if (state.mirror) cells = cells.map(row => row.slice().reverse());   // 镜像跟图纸页画布同一语义（canvas.js：列 i → GW-1-i），导出与所见一致
  PT = { board: PALS[state.palette].label, colors: palette.length, beads: sp.beads, palette };
  glowCache = null; glowKey = ''; ironCache = null; ironStyledCache = {}; ironThumbCache = {};
}

/* ---------- 图片资源 ---------- */
const srcImg = new Image();
const HAS_SOURCE = !!(D.images && D.images.length);
if (HAS_SOURCE) srcImg.src = D.images[0];
[srcImg].forEach(im => im && im.addEventListener('load', () => { if (isOpen()) refresh(); }));
/* 腾讯体随包内联，Canvas 要等字体就位再画，否则导出 PNG 会落到回退字体。
 * 加载失败也重绘一次：底栏那句此时改由设备字体渲染，不能留一张按加载中状态画的图。 */
if (document.fonts && document.fonts.load) {
  Promise.all(['300 14px TencentSans', '700 32px TencentSans'].map(f => document.fonts.load(f)))
    .then(() => { FACE_READY = document.fonts.check('700 12px TencentSans'); })
    .catch(() => { FACE_READY = false; })
    .then(() => { if (isOpen()) refresh(); });
}
const ready = im => im && im.complete && im.naturalWidth > 0;

/* ---------- 工具 ---------- */
function mixHex(hex, to, k) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const ch = s => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('');
}
function hlum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
function setTheme(bg) {   // 一个底色推出整套配色：深底浅字，浅底深字
  const light = hlum(bg) > .55;
  Object.assign(C, light
    ? { ink: bg, ink2: mixHex(bg, '#FFFFFF', .55), ink3: mixHex(bg, '#0F1923', .08), bone: '#0F1923', mut: '#6B7A8C', light }
    : { ink: bg, ink2: mixHex(bg, '#FFFFFF', .05), ink3: mixHex(bg, '#FFFFFF', .10), bone: '#ECE8E1', mut: '#8B9BB0', light });
}
function cutPath(g, x, y, w, h, c) {
  g.beginPath();
  g.moveTo(x, y); g.lineTo(x + w - c, y); g.lineTo(x + w, y + c);
  g.lineTo(x + w, y + h); g.lineTo(x + c, y + h); g.lineTo(x, y + h - c);
  g.closePath();
}
function txt(g, s, x, y, { size = 14, color = C.bone, weight = 400, align = 'left', font = null, spacing = 0 } = {}) {
  g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
  g.font = `${weight} ${size}px ${font || '"PingFang SC","Microsoft YaHei",sans-serif'}`;
  if (spacing && g.letterSpacing !== undefined) g.letterSpacing = spacing + 'px';
  g.fillText(s, x, y);
  if (g.letterSpacing !== undefined) g.letterSpacing = '0px';
}
function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }

/* ---------- 发光：轮廓外发光 + 星芒（取主体内部亮色，越过深色描边后再发光） ----------
 * 开关 P.glow：导出面板底部的「发光」勾选框，默认开。
 * 光色：亮度不低于 GLOW_LUM 的格作为光源，颜色向外逐格扩散，深色描边与底色不参与取色。
 * 画法：按「离图纸外轮廓的格距 d」逐圈衰减铺色，再叠三层：宽柔光晕、贴边亮芯（光色提白）、沿轮廓散落的四角星芒与微光点。
 *   1 圈 + 贴边亮芯 + 少量小星芒；主体本身挖空，光只落在豆外侧。 */
const GLOW_LUM = .28;
const GLOW_CFG = { ring: [.6], wide: [.6, .8], core: [.4, .55], spark: { d: 1, rate: .14, len: [1, 1.9], gap: 6 }, dust: .06 };
function vivid([r, g, b]) {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  let l = (mx + mn) / 2, s = mx === mn ? 0 : (l > .5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
  let h = 0;
  if (mx !== mn) {
    const d = mx - mn, R = r / 255, G = g / 255, B = b / 255;
    h = mx === R ? (G - B) / d + (G < B ? 6 : 0) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h /= 6;
  }
  s = Math.min(1, s * 1.15); l = C.light ? Math.max(.6, Math.min(.78, l)) : Math.max(.66, Math.min(.86, l));
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255 | 0, f(h) * 255 | 0, f(h - 1 / 3) * 255 | 0];
}
const whiten = ([r, g, b], t) => [r + (255 - r) * t | 0, g + (255 - g) * t | 0, b + (255 - b) * t | 0];
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
function hash01(r, c, k) { let h = (r * 73856093) ^ (c * 19349663) ^ (k * 83492791); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
/* 颜色场 F（光源亮色逐格扩散）+ 轮廓外格距 D（主体格 0，外侧 1、2、3…，超出 maxD 为 null） */
function glowField(maxD) {
  let F = cells.map(row => row.map(i => {
    if (i < 0) return null;
    const rgb = hexRgb(PT.palette[i].hex);
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 >= GLOW_LUM ? rgb : null;
  }));
  if (!F.some(row => row.some(Boolean)))
    F = cells.map(row => row.map(i => i < 0 ? null : hexRgb(PT.palette[i].hex)));
  const D = cells.map(row => row.map(i => i >= 0 ? 0 : null));
  for (let k = 1; k <= maxD + 1; k++) {
    for (let r = 0; r < PGH; r++) for (let c = 0; c < PGW; c++) {
      if (D[r][c] !== null) continue;
      for (let dr = -1; dr <= 1 && D[r][c] === null; dr++) for (let dc = -1; dc <= 1; dc++)
        if (D[r + dr] && D[r + dr][c + dc] === k - 1) { D[r][c] = k; break; }
    }
  }
  for (let k = 0; k < maxD + 6; k++) {
    const N = F.map(row => row.slice());
    for (let r = 0; r < PGH; r++) for (let c = 0; c < PGW; c++) {
      if (F[r][c] || D[r][c] === null) continue;
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const v = F[r + dr] && F[r + dr][c + dc];
        if (v) { s0 += v[0]; s1 += v[1]; s2 += v[2]; n++; }
      }
      if (n) N[r][c] = [s0 / n | 0, s1 / n | 0, s2 / n | 0];
    }
    F = N;
  }
  return { F, D };
}
/* 四角星芒：长臂十字 + 短臂斜十字 + 白色星心 */
function sparkle(g, x, y, L, col, white) {
  const arm = (ang, len, w) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    const gr = g.createLinearGradient(-len, 0, len, 0);
    gr.addColorStop(0, rgba(col, 0)); gr.addColorStop(.5, rgba(white, 1)); gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr; g.beginPath();
    g.moveTo(-len, 0); g.quadraticCurveTo(0, -w, len, 0); g.quadraticCurveTo(0, w, -len, 0); g.fill(); g.restore();
  };
  const halo = g.createRadialGradient(x, y, 0, x, y, L * .55);
  halo.addColorStop(0, rgba(white, .55)); halo.addColorStop(.4, rgba(col, .22)); halo.addColorStop(1, rgba(col, 0));
  g.fillStyle = halo; g.beginPath(); g.arc(x, y, L * .55, 0, Math.PI * 2); g.fill();
  arm(0, L, L * .09); arm(Math.PI / 2, L, L * .09);
  arm(Math.PI / 4, L * .42, L * .06); arm(-Math.PI / 4, L * .42, L * .06);
  g.fillStyle = rgba(white, 1); g.beginPath(); g.arc(x, y, L * .07, 0, Math.PI * 2); g.fill();
}
function glowLayer(bs, cell) {
  const key = bs + '|' + C.light + '|' + P.glow;
  if (glowCache && glowKey === key) return glowCache;
  const cfg = GLOW_CFG, maxD = cfg.ring.length;
  const { F, D } = glowField(maxD);
  const lift = C.light ? 0 : .2;
  const mk = () => { const c = document.createElement('canvas'); c.width = bs; c.height = bs; return c; };
  /* 底色层：主体格满色，外侧按格距衰减 */
  const off = mk(), g = off.getContext('2d');
  const rim = mk(), rg = rim.getContext('2d');
  for (let r = 0; r < PGH; r++) for (let c = 0; c < PGW; c++) {
    const v = F[r][c], d = D[r][c]; if (!v || d === null || d > maxD) continue;
    const col = vivid(v);
    g.fillStyle = rgba(col, d === 0 ? 1 : cfg.ring[d - 1]);
    g.fillRect(c * cell, r * cell, cell + .5, cell + .5);
    if (d <= 1) { rg.fillStyle = rgba(whiten(col, lift), 1); rg.fillRect(c * cell, r * cell, cell + .5, cell + .5); }
  }
  const body = mk(), bg = body.getContext('2d'); bg.fillStyle = '#fff';
  for (let r = 0; r < PGH; r++) for (let c = 0; c < PGW; c++)
    if (cells[r][c] >= 0) bg.fillRect(c * cell, r * cell, cell + .5, cell + .5);
  const cut = mk(), cg = cut.getContext('2d');
  cg.filter = `blur(${Math.max(2, cell * cfg.wide[0])}px)`; cg.globalAlpha = cfg.wide[1]; cg.drawImage(off, 0, 0);
  cg.globalCompositeOperation = C.light ? 'source-over' : 'lighter';
  cg.filter = `blur(${Math.max(1, cell * cfg.core[0])}px)`; cg.globalAlpha = cfg.core[1]; cg.drawImage(rim, 0, 0);
  cg.filter = 'none'; cg.globalAlpha = 1;
  cg.globalCompositeOperation = 'destination-out'; cg.drawImage(body, 0, 0);
  /* 星芒与微光点：沿轮廓外侧确定性散落（同一张图纸每次出图位置一致），彼此至少隔 gap 格 */
  cg.globalCompositeOperation = C.light ? 'source-over' : 'lighter';
  const sp = cfg.spark, taken = [];
  for (let r = 0; r < PGH; r++) for (let c = 0; c < PGW; c++) {
    const d = D[r][c], v = F[r][c]; if (!v || !d) continue;
    const col = vivid(v), wcol = whiten(col, C.light ? .1 : .85);
    if (d <= sp.d && hash01(r, c, 1) < sp.rate && !taken.some(([tr, tc]) => Math.abs(tr - r) < sp.gap && Math.abs(tc - c) < sp.gap)) {
      taken.push([r, c]);
      const L = cell * (sp.len[0] + (sp.len[1] - sp.len[0]) * hash01(r, c, 2));
      sparkle(cg, (c + .2 + .6 * hash01(r, c, 3)) * cell, (r + .2 + .6 * hash01(r, c, 4)) * cell, L, col, wcol);
    } else if (d <= maxD + 1 && hash01(r, c, 5) < cfg.dust) {
      const x = (c + hash01(r, c, 6)) * cell, y = (r + hash01(r, c, 7)) * cell, rad = cell * (.07 + .09 * hash01(r, c, 8));
      cg.fillStyle = rgba(wcol, .55 + .4 * hash01(r, c, 9)); cg.beginPath(); cg.arc(x, y, rad, 0, Math.PI * 2); cg.fill();
    }
  }
  cg.globalCompositeOperation = 'source-over';
  glowCache = cut; glowKey = key;
  return cut;
}

/* ---------- 烫后效果（左下角小图）：与图纸页烫豆熔化 100% 的俯视终态同一口径 ---------- */
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  const top = a + (b - a) * fx, bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}
function ironLayer() {
  if (ironCache) return ironCache;
  const K = Math.max(3, Math.min(10, Math.floor(1200 / Math.max(PGW, PGH))));
  const W = PGW * K, H = PGH * K;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), img = g.createImageData(W, H), Dd = img.data;
  const occ = (r, c) => r >= 0 && c >= 0 && r < PGH && c < PGW && cells[r][c] >= 0;
  const rgb = cells.map(row => row.map(i => i < 0 ? null : hexRgb(PT.palette[i].hex)));
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const NB = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const r = (py / K) | 0, c = (px / K) | 0;
    if (!occ(r, c)) continue;
    const u = (px + .5) / K - c - .5, v = (py + .5) / K - r - .5;
    const sx = u >= 0 ? 1 : -1, sy = v >= 0 ? 1 : -1;
    const hx = occ(r, c + sx), hy = occ(r + sy, c);
    const ex = hx ? .5 : .445, ey = hy ? .5 : .445, rad = (!hx && !hy) ? .26 : 0;
    const ax = Math.abs(u), ay = Math.abs(v);
    if (ax > ex || ay > ey) continue;
    let edge = 1;
    if (!hx) edge = Math.min(edge, ex - ax);
    if (!hy) edge = Math.min(edge, ey - ay);
    if (rad) {
      const dx = ax - (ex - rad), dy = ay - (ey - rad);
      if (dx > 0 && dy > 0) { const d = Math.hypot(dx, dy); if (d > rad) continue; edge = Math.min(edge, rad - d); }
    }
    const own = rgb[r][c], wx = c + .5 + u, wy = r + .5 + v;
    const wob = (vnoise(wx * 4.5, wy * 4.5) - .5) * .22 + (vnoise(wx * 11, wy * 11) - .5) * .08;
    let a0 = 0, a1 = 0, a2 = 0, ws = 0;
    for (const [dr, dc] of NB) {
      if (!occ(r + dr, c + dc)) continue;
      const wt = .5 * (1 - sm(0, .2, .5 - (u * dc + v * dr) + wob));
      if (wt <= 0) continue;
      const n = rgb[r + dr][c + dc]; a0 += wt * n[0]; a1 += wt * n[1]; a2 += wt * n[2]; ws += wt;
    }
    if (ws > .75) { const q = .75 / ws; a0 *= q; a1 *= q; a2 *= q; ws = .75; }
    const R = own[0] * (1 - ws) + a0, G = own[1] * (1 - ws) + a1, B = own[2] * (1 - ws) + a2;
    const bev = 1 - sm(0, .12, edge);
    const lit = ((!hx && sx < 0) || (!hy && sy < 0)) ? .22 : -.30;
    const k = 1 + bev * lit;
    const s0 = (wx / PGW + wy / PGH) / 2;
    const spec = 255 * (.06 * Math.exp(-(((s0 - .32) / .10) ** 2)) + .02 * (vnoise(wx * .6, wy * .6) - .5));
    const o = (py * W + px) * 4;
    Dd[o] = Math.min(255, Math.max(0, R * k + spec));
    Dd[o + 1] = Math.min(255, Math.max(0, G * k + spec));
    Dd[o + 2] = Math.min(255, Math.max(0, B * k + spec));
    Dd[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  ironCache = cv;
  return cv;
}

/* ---------- 烫后效果：主图与底栏小图共用 ----------
 * 走图纸页同一个质感着色器（iron-gl.js）与参数（IRON_STYLES / IRON_PARAMS，按当前板规格），熔化 100%、透明底；
 * 光源取固定时刻，同一选择每次导出一致。K = 每格像素：小图约 1600px 见方即可；主图按出图倍率取，上限受纹理尺寸 4096 约束。
 * 设备不支持 WebGL2 时退回上面的 canvas 画法。 */
const ironName = k => (IRON_STYLES.find(x => x.key === k) || IRON_STYLES[0]).name + '烫';   // 无孔烫 / 毛巾烫 …
let posterGL, posterGLCv;
function ironRender(key, K) {   // 按烫法 key、每格 K 像素渲一张烫后终态；不支持 WebGL2 时退回 canvas 画法
  const side = Math.max(PGW, PGH);
  if (posterGL === undefined) { posterGLCv = document.createElement('canvas'); try { posterGL = typeof IronGL === 'undefined' ? null : IronGL.create(posterGLCv); } catch (e) { posterGL = null; } }
  if (!posterGL) return ironLayer();
  const st = IRON_STYLES.findIndex(x => x.key === key), pr = ironParamsFor(side, key);
  posterGL.setGrid(cells.map(row => row.map(i => i < 0 ? null : 'c' + i)), k => hexRgb(PT.palette[+k.slice(1)].hex)); // 键不能是 0（setGrid 把假值当空格）
  posterGL.render({ w: PGW * K, h: PGH * K, dpr: 1, ox: 0, oy: 0, s: K, mirror: false, ruler: 0, progress: 1, style: IRON_STYLES[st].sh, mat: IRON_STYLES[st].mat,
    melt: pr.melt, amp: pr.amp, scale: pr.scale, p: pr.p, glit: ironGlitterFor(side, key), time: 1.3, clear: true });
  const cv = document.createElement('canvas'); cv.width = posterGLCv.width; cv.height = posterGLCv.height;
  cv.getContext('2d').drawImage(posterGLCv, 0, 0);
  return cv;
}
function ironStyled(K) {   // 主图（烫后效果）用：按出图倍率取，只缓存当前烫法，大图不堆内存
  K = Math.max(3, Math.min(2 ** Math.ceil(Math.log2(Math.max(K, 1))), Math.floor(4096 / Math.max(PGW, PGH)))); // 取 2 的幂：缩放平移时不逐帧重渲
  const opt = P.ironStyle, ck = opt + '|' + K;
  if (ironStyledCache[ck]) return ironStyledCache[ck];
  for (const k of Object.keys(ironStyledCache)) if (!k.startsWith(opt + '|')) delete ironStyledCache[k];
  return (ironStyledCache[ck] = ironRender(opt, K));
}
/* 底栏小图：每种烫法一张约 1600px 见方，可同时放几种，按烫法分别缓存 */
const thumbIron = key => ironThumbCache[key] || (ironThumbCache[key] = ironRender(key, Math.max(3, Math.floor(1600 / Math.max(PGW, PGH)))));

/* ---------- 图纸区（可单独缩放）：区域按图纸宽高比铺开，不再强制方形 ----------
 * 缩放绕图纸框中心：z>1 放大、超出框的部分裁掉；z<1 缩小、四周留白。v.tx/ty 是图纸中心相对框中心的偏移 */
function drawBoard(g, gx, gy, bw, bh, cell0, v) {
  const z = v.z, cell = cell0 * z;
  const ox = gx + bw * (1 - z) / 2 + v.tx, oy = gy + bh * (1 - z) / 2 + v.ty;
  const c0 = Math.max(0, Math.floor((gx - ox) / cell)), c1 = Math.min(PGW - 1, Math.floor((gx + bw - ox) / cell));
  const r0 = Math.max(0, Math.floor((gy - oy) / cell)), r1 = Math.min(PGH - 1, Math.floor((gy + bh - oy) / cell));
  g.save();
  g.beginPath(); g.rect(gx, gy, bw, bh); g.clip();
  if (P.glow) {
    const gl = glowLayer(Math.round(Math.max(PGW, PGH) * cell0), cell0);
    g.save(); g.globalCompositeOperation = C.light ? 'source-over' : 'lighter'; g.globalAlpha = C.light ? .85 : 1;
    g.drawImage(gl, ox, oy, gl.width * z, gl.height * z); g.restore();
  }
  if (P.main === 'iron') {   // 主图 = 烫后效果：按当前出图分辨率取一张，随缩放平移
    const im = ironStyled(Math.ceil(cell0 * ironRes * 1.5));
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.save(); g.shadowColor = 'rgba(0,0,0,.42)'; g.shadowBlur = 14; g.shadowOffsetY = 5;
    g.drawImage(im, ox, oy, PGW * cell, PGH * cell); g.restore();
    g.restore();
    return;
  }
  g.fillStyle = C.light ? 'rgba(15,25,35,.06)' : 'rgba(255,255,255,.045)';
  if (P.grid) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++)   // 空格的小孔随网格线一起显示，关网格线即去掉
    if (cells[r][c] < 0) g.fillRect(ox + c * cell + cell * .32, oy + r * cell + cell * .32, cell * .36, cell * .36);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const i = cells[r][c]; if (i < 0) continue;
    const x = ox + c * cell, y = oy + r * cell;
    g.fillStyle = PT.palette[i].hex;
    g.fillRect(x, y, cell + .5, cell + .5);
  }
  if (P.codes) {   // 色号随格子缩放、任何缩放档都画：大规格默认档也能看出每颗豆，不会像只有每 5 格的大格
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${cell * .32}px ${LAT}`;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = cells[r][c]; if (i < 0) continue;
      const p = PT.palette[i];
      g.fillStyle = hlum(p.hex) > .62 ? 'rgba(15,25,35,.78)' : 'rgba(255,255,255,.85)';
      g.fillText(p.code, ox + (c + .5) * cell, oy + (r + .52) * cell);
    }
  }
  if (P.grid) {   // 网格线：逐格细线 + 每 5 格一条粗线。中性灰在白豆、黑豆、深浅底色上都看得见；
    // 细线至少 1 个实际像素（px = 当前画布每海报单位的像素数），又不超过格宽的 3 成，免得缩小时线盖住颜色
    const px = ironRes / z, fine = Math.min(cell * .3, Math.max(1 / px, cell * .06));
    for (let i = 0; i <= Math.max(PGW, PGH); i++) {
      const major = i % 5 === 0;
      g.strokeStyle = major ? (C.light ? 'rgba(15,25,35,.3)' : 'rgba(236,232,225,.3)') : 'rgba(128,128,128,.42)';
      g.lineWidth = major ? Math.max(1.4, fine * 1.8) : fine;
      if (i <= PGW && i >= c0 && i <= c1 + 1) { g.beginPath(); g.moveTo(ox + i * cell, oy); g.lineTo(ox + i * cell, oy + PGH * cell); g.stroke(); }
      if (i <= PGH && i >= r0 && i <= r1 + 1) { g.beginPath(); g.moveTo(ox, oy + i * cell); g.lineTo(ox + PGW * cell, oy + i * cell); g.stroke(); }
    }
  }
  g.restore();
  if (P.grid) {   // 轴号：跟着格子走，放大到格子够宽时逐格标
    const step = [1, 5, 10, 20, 50].find(s => s * cell >= 24) || 50;   // 轴号间隔随格子宽度放疏，缩小时不挤在一起
    const ax = Math.max(gx, ox), ay = Math.max(gy, oy);   // 轴号贴图纸边；放大到图纸超出框时贴框边，缩小时跟着图走
    g.save(); g.fillStyle = C.mut; g.font = `500 ${Math.max(Math.min(cell0 * .52, 20), 10)}px ${LAT}`;
    g.save(); g.beginPath(); g.rect(gx, gy - 28, bw, 28 + bh); g.clip();
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    for (let c = step - 1; c < PGW; c += step) if (c >= c0 && c <= c1) g.fillText(c + 1, ox + (c + .5) * cell, ay - 7);
    g.restore();
    g.save(); g.beginPath(); g.rect(gx - 38, gy, 38 + bw, bh); g.clip();
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let r = step - 1; r < PGH; r += step) if (r >= r0 && r <= r1) g.fillText(r + 1, ax - 8, oy + (r + .5) * cell);
    g.restore();
    g.restore();
  }
}

/* ---------- 海报 ---------- */
function drawPoster(g) {
  g.clearRect(0, 0, PW, PH);
  g.fillStyle = C.ink; g.fillRect(0, 0, PW, PH);
  const rg = g.createRadialGradient(PW * .82, -60, 40, PW * .82, -60, 820);
  rg.addColorStop(0, 'rgba(255,70,85,.13)'); rg.addColorStop(1, 'rgba(255,70,85,0)');
  g.fillStyle = rg; g.fillRect(0, 0, PW, PH);
  g.save(); g.globalAlpha = .04; g.strokeStyle = C.bone; g.lineWidth = 1;
  for (let x = -PH; x < PW; x += 26) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + PH, PH); g.stroke(); }
  g.restore();
  const line = C.light ? 'rgba(15,25,35,.16)' : 'rgba(236,232,225,.16)';

  /* 规格条：红色竖标 + 规格 / 色板 / 色数 / 用豆 四格。小字 W3 作标签，数值 W7 */
  const sy = L.stripY;
  g.fillStyle = C.red; g.fillRect(M, sy + 3, 4, 42);
  const specs = [['规格', `${PGW}×${PGH}`, ''], ['色板', PT.board, ''], ['色数', String(PT.colors), '色'], ['用豆', PT.beads.toLocaleString(), '颗']];
  let sx = M + 18;
  specs.forEach(([lb, val, unit], i) => {
    if (i) { g.fillStyle = line; g.fillRect(sx - 20, sy + 6, 1, 36); }
    txt(g, lb, sx, sy + 10, { size: 12, weight: 300, color: C.mut, font: TS, spacing: 3 });
    txt(g, val, sx, sy + 34, { size: 22, weight: 700, font: TS });
    g.font = `700 22px ${TS}`;
    let w = g.measureText(val).width;
    if (unit) { txt(g, unit, sx + w + 3, sy + 37, { size: 13, weight: 300, color: C.mut, font: TS }); g.font = `300 13px ${TS}`; w += 3 + g.measureText(unit).width; }
    sx += w + 40;
  });
  const tag = P.main === 'iron' ? '点豆图纸烫后效果分享' : '点豆图纸分享';   // 角标随主图：图纸 / 烫后效果
  g.font = `700 12px ${TS}`;
  const tw = g.measureText(tag).width + 6 * 1.5 + 22, tx = PW - M - tw;
  if (tx > sx - 20) {
    cutPath(g, tx, sy + 12, tw, 24, 6);
    g.strokeStyle = C.red; g.lineWidth = 1.2; g.stroke();
    txt(g, tag, tx + tw / 2 + 1, sy + 24, { size: 12, weight: 700, color: C.red, font: TS, align: 'center', spacing: 1.5 });
  }

  /* 图纸面板：切角边框 + 红色角标，图纸是画面绝对主体 */
  cutPath(g, L.bx, L.by, L.bw, L.bh, 20); g.fillStyle = C.ink2; g.fill();
  g.strokeStyle = C.light ? 'rgba(15,25,35,.12)' : 'rgba(255,255,255,.10)'; g.lineWidth = 1; g.stroke();
  g.strokeStyle = C.red; g.lineWidth = 3;
  [[L.bx + 14, L.by + 14, 1, 1], [L.bx + L.bw - 14, L.by + 14, -1, 1], [L.bx + 14, L.by + L.bh - 14, 1, -1], [L.bx + L.bw - 14, L.by + L.bh - 14, -1, -1]]
    .forEach(([x, y, dx, dy]) => { g.beginPath(); g.moveTo(x, y + 12 * dy); g.lineTo(x, y); g.lineTo(x + 12 * dx, y); g.stroke(); });
  drawBoard(g, L.gx, L.gy, L.gbw, L.gbh, L.cell, view);

  /* 色号表：滑块控制色块大小，密集档只留色号 + 用量，「关」档整块不画 */
  if (chipShown()) {
    const k = chipSpec(chipCols()), band = Math.round(k.h * .61);
    PT.palette.forEach((p, i) => {
      const cx = M + (i % k.cols) * (k.w + k.gap), cy = L.chipY + Math.floor(i / k.cols) * (k.h + k.gap);
      const dark = hlum(p.hex) > .62;
      const fg = dark ? 'rgba(15,25,35,.9)' : 'rgba(255,255,255,.95)';
      if (k.named) {
        const fs = dark ? 'rgba(15,25,35,.55)' : 'rgba(255,255,255,.66)';
        cutPath(g, cx, cy, k.w, k.h, 9); g.fillStyle = p.hex; g.fill();
        txt(g, p.code, cx + 13, cy + 20, { size: k.fs, weight: 700, color: fg, font: TS });
        if (p.name) txt(g, p.name.length > 5 ? p.name.slice(0, 5) : p.name, cx + k.w - 12, cy + 20, { size: 11, color: fs, align: 'right' });
        txt(g, `×${p.count.toLocaleString()}`, cx + 13, cy + 44, { size: 12, color: fs, font: TS });
      } else {
        cutPath(g, cx, cy, k.w, k.h, 7); g.fillStyle = C.ink3; g.fill();
        g.save(); cutPath(g, cx, cy, k.w, k.h, 7); g.clip(); g.fillStyle = p.hex; g.fillRect(cx, cy, k.w, band); g.restore();
        txt(g, p.code, cx + k.w / 2, cy + band / 2 + 1, { size: k.fs, weight: 700, color: fg, font: TS, align: 'center' });
        txt(g, p.count.toLocaleString(), cx + k.w / 2, cy + band + 11, { size: k.cnt, weight: 300, color: C.mut, font: TS, align: 'center' });
      }
    });
  }

  /* 底栏：左侧参考小图（原图、烫后小图），右侧说明；放不下时小图等比缩小，不压到右侧说明 */
  const fy = L.footY, list = corners(), GAP = 16, footW = PW - 2 * M - 176;
  const S = Math.min(132, (footW - GAP * (list.length - 1)) / Math.max(1, list.length));
  list.forEach((kind, n) => {
    const bx = M + n * (S + GAP);
    g.save();
    cutPath(g, bx, fy, S, S, 10); g.fillStyle = C.ink3; g.fill();
    g.strokeStyle = C.light ? 'rgba(15,25,35,.12)' : 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.stroke();
    cutPath(g, bx, fy, S, S, 10); g.clip();
    if (kind === 'source') {
      const k = Math.max(S / srcImg.naturalWidth, S / srcImg.naturalHeight);
      const w = srcImg.naturalWidth * k, h = srcImg.naturalHeight * k;
      g.drawImage(srcImg, bx + (S - w) / 2, fy + (S - h) / 2, w, h);
    } else {
      const iron = thumbIron(kind);
      const k = Math.min((S - 16) / iron.width, (S - 16) / iron.height);
      const w = iron.width * k, h = iron.height * k;
      g.shadowColor = 'rgba(0,0,0,.42)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(iron, bx + (S - w) / 2, fy + (S - h) / 2, w, h);
    }
    g.restore();
    g.fillStyle = C.red; g.fillRect(bx, fy + S + 14, 3, 14);
    // 五种烫法名与「烫效果模拟」都在随包子集里（新增烫法需重新生成子集）
    txt(g, kind === 'source' ? '原图' : ironName(kind) + '效果模拟', bx + 10, fy + S + 21, { size: 13, weight: 300, color: C.mut, font: TS, spacing: kind === 'source' ? 3 : 1 });
  });
  const rowB = fy + (list.length ? 150 : 56);
  /* 来源声明只留账号署名一行：随包 W7 就位时用腾讯体（@书若 三字不在子集内，逐字回落设备字体）；没就位时整句交给设备字体，不删字、不改写。 */
  txt(g, '来自小红书 @书生若木', PW - M, rowB - 12,
    { size: 12, weight: 700, color: C.mut, font: FACE_READY ? TS : FALLBACK_FONT, align: 'right', spacing: 2 });
  g.fillStyle = C.red;
  g.fillRect(PW - M - 150, rowB + 10, 150, 4);
  g.fillRect(PW - M - 84, rowB + 20, 84, 4);
}

/* ---------- 渲染：预览按显示尺寸，出图离屏按倍率，都重画整张海报；主图区的缩放平移在 drawBoard 里，预览与出图一致 ---------- */
const stageEl = $('psStage'), wrapEl = $('psStageWrap');
let ironRes = 1;   // 当前绘制的像素倍率（显示或出图倍率 × 主图缩放），主图烫后效果按它取分辨率
function render(scale, target) {
  const cv = target || stageEl;
  ironRes = scale * view.z;
  const w = Math.round(PW * scale), h = Math.round(PH * scale);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d'), kx = w / PW, ky = h / PH;
  g.setTransform(kx, 0, 0, ky, 0, 0);
  drawPoster(g);
  return cv;
}
let previewRs = 1;
const previewScale = () => Math.min(3, Math.max(1, wrapEl.clientWidth * (window.devicePixelRatio || 1) / PW));
/* 抽屉高度贴合内容：最高 SHEET_MAX 屏高，内容放不下时控制坞自己滚动；内容少时不低于 SHEET_MIN 屏高，
 * 多出的高度均分在内容上下留白，内容也随之上移到拇指好够的位置 */
const SHEET_MAX = 0.92, SHEET_MIN = 0.55, HEAD_H = 66;
/* 玩家按住抽屉顶部上下拖动可调高矮（存本机，按屏高比例记）；拖高后内容大小不变、整体上移，多出的高度留在下方。
 * 往下拖到比 SHEET_DRAG_MIN 还矮就进入收起手势，松手超过阈值即收起 */
const SHEET_DRAG_MIN = 0.4, SHEET_DRAG_MAX = 0.96, SHEET_KEY = 'perler-ps-h';
let userSheetR = 0;
try { userSheetR = +localStorage.getItem(SHEET_KEY) || 0; } catch (e) {}
const sheetH = (vh, autoH) => userSheetR ? Math.min(vh * SHEET_DRAG_MAX, Math.max(vh * SHEET_DRAG_MIN, vh * userSheetR)) : autoH;
const STACK_TOP = 0.54;   // 上下构图：预览区占正文高度的比例
/* 预览宽度占正文宽度的上限比例：正文宽 ≥ STAGE_W_WIDE 时取 STAGE_R_WIDE，≤ STAGE_W_NARROW 时取 STAGE_R_NARROW，中间线性过渡 */
const STAGE_W_WIDE = 1100, STAGE_W_NARROW = 360, STAGE_R_WIDE = 0.64, STAGE_R_NARROW = 0.58, DOCK_MAX = 260;
/* 键盘开合会改可视区高度：输入框聚焦期间按聚焦前的高度排版，弹窗不随键盘缩放跳动、预览画布不重设尺寸（重设会清空成黑底）；
 * 收起键盘后等可视区稳定再一次性复原 */
let kbLockVh = 0, kbTm = 0;
document.getElementById('ps').addEventListener('focusin', e => {
  if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.type === 'color') return;
  clearTimeout(kbTm);
  if (!kbLockVh) kbLockVh = window.visualViewport ? visualViewport.height : innerHeight;
});
document.getElementById('ps').addEventListener('focusout', () => {
  clearTimeout(kbTm);
  kbTm = setTimeout(() => { if (/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) return; kbLockVh = 0; if (isOpen()) refresh(); }, 350);
});
function fitStage() {
  const sheet = $('ps'), body = $('psBody'), dock = $('psDock');
  const cs = getComputedStyle(body);
  const vh = kbLockVh || (window.visualViewport ? visualViewport.height : innerHeight);
  const padB = parseFloat(cs.paddingBottom), gap = parseFloat(cs.columnGap || cs.gap || 0);
  const innerW = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const capH = userSheetR ? sheetH(vh, 0) : vh * SHEET_MAX;   // 拖矮了按拖后的高度排，拖高了不放大内容
  const availH = Math.min(vh * SHEET_MAX, capH) - HEAD_H - padB;
  /* 窄屏上下构图（CSS 断点决定 #psBody 是否纵向）：预览只占正文区上方一小块（够看清样貌即可），其余高度全给下方选项 */
  if (cs.flexDirection === 'column') {
    dock.style.width = '';
    const w = Math.max(80, Math.floor(Math.min(innerW, availH * STACK_TOP * PW / PH)));
    $('psStageArea').style.width = w + 'px';
    wrapEl.style.width = w + 'px';
    dock.style.minHeight = ''; dock.style.maxHeight = '';
    dock.style.flex = 'none';
    const dockH = dock.scrollHeight;   // 不被 flex 撑开时的自然高度
    const stageH = Math.round(w * PH / PW);
    const H = sheetH(vh, Math.min(vh * SHEET_MAX, Math.max(vh * SHEET_MIN, HEAD_H + stageH + gap + dockH + padB + 6)));
    dock.style.maxHeight = Math.max(60, H - HEAD_H - stageH - gap - padB) + 'px';   // 选项区按内容高，放不下才滚动；多出的高度留在下方，下载按钮跟着内容走
    sheet.style.height = H + 'px';
    return;
  }
  /* 左右分配：宽屏下预览只受高度限制，控制坞保持基准宽；越接近手机宽度，预览可占的宽度比例越小（STAGE_R_WIDE → STAGE_R_NARROW 线性过渡），
   * 省下的宽度给控制坞（上限 DOCK_MAX）。控制坞变宽后两列开关可以并排、整列变短；预览变窄后高度随比例同步变矮，不会拉得太长 */
  dock.style.width = '';
  const baseDock = dock.offsetWidth;
  const t = Math.min(1, Math.max(0, (innerW - STAGE_W_NARROW) / (STAGE_W_WIDE - STAGE_W_NARROW)));
  const ratio = STAGE_R_NARROW + t * (STAGE_R_WIDE - STAGE_R_NARROW);
  const byH = availH * PW / PH;
  const byRatio = innerW * ratio;
  let w, dockW = baseDock;
  if (byH + baseDock + gap <= innerW && byH <= byRatio) w = byH;   // 宽屏：高度先到顶，布局与原来一致
  else {
    w = Math.min(byH, byRatio, innerW - baseDock - gap);
    dockW = Math.min(DOCK_MAX, Math.max(baseDock, innerW - w - gap));
    dock.style.width = dockW + 'px';
  }
  w = Math.max(80, Math.floor(w));
  $('psStageArea').style.width = w + 'px';
  wrapEl.style.width = w + 'px';
  dock.style.minHeight = ''; dock.style.alignSelf = 'flex-start';
  const dockH = dock.scrollHeight;
  dock.style.alignSelf = '';
  const leftH = Math.round(w * PH / PW);
  const contentH = Math.min(availH, Math.max(leftH, dockH));
  dock.style.minHeight = contentH + 'px';
  dock.style.maxHeight = availH + 'px';
  sheet.style.height = sheetH(vh, Math.min(vh * SHEET_MAX, Math.max(vh * SHEET_MIN, HEAD_H + contentH + padB + 6))) + 'px';
}
function refresh() {
  if (!PT) return;
  layout();
  $('psStageWrap').style.aspectRatio = `${PW}/${PH}`;
  fitStage(); placeZoom(); glowKey = ''; previewRs = previewScale(); render(previewRs);
}

/* ---------- 选项 ---------- */
document.querySelectorAll('#ps .ps-sw[data-k]').forEach(el => el.addEventListener('click', () => {
  const k = el.dataset.k; P[k] = !P[k]; el.classList.toggle('on', P[k]); refresh();
}));
/* ---- 烫法下拉：主图（单选）与底栏（多选）共用一个弹出菜单 #psMenu ----
 * 菜单结构：底栏多一项「无」+ 分隔线，再列五种烫法；选中项前打勾。主图用的烫法在底栏菜单里置灰（不重复放小图） */
const ddMain = $('psIronMain'), ddFoot = $('psIron'), menuEl = $('psMenu'), psEl = $('ps');   // psEl：抽屉根（抽屉开合段的 sheetEl 在后面才声明）
const IRON_KEYS = IRON_STYLES.map(x => x.key);
let menuFor = null, thumbsTouched = false;   // thumbsTouched：玩家动过底栏烫法前，每次打开都跟图纸页当前烫法走
function renderDD() {
  ddMain.querySelector('.v').textContent = P.main === 'board' ? '图纸' : ironName(P.ironStyle) + '效果';
  const shown = thumbsShown();
  ddFoot.querySelector('.v').textContent = !shown.length ? '无' : shown.length === 1 ? ironName(shown[0]) : `${ironName(shown[0])}等`;
  if (menuFor) buildMenu();
}
function buildMenu() {
  const multi = menuFor === ddFoot;
  const row = (v, t, on, dis) => `<div class="mi${on ? ' on' : ''}${dis ? ' dis' : ''}" data-v="${v}" role="option" aria-selected="${on}">${t}</div>`;
  // 两个菜单同一结构：两组，组标题在上、选项缩进在下（二级）。分享图：「图纸」「烫豆效果」；底部栏：「无」「烫豆效果 · 可多选」
  let h = `<div class="mg">${multi ? '无' : '图纸'}</div>`;
  h += multi ? row('none', '无', !thumbsShown().length) : row('board', '图纸', P.main === 'board');
  h += '<i class="sep"></i>';
  h += multi ? '<div class="mg">烫豆效果<span>可多选</span></div>' : '<div class="mg">烫豆效果</div>';
  IRON_STYLES.forEach(x => {
    const used = multi && P.main === 'iron' && x.key === P.ironStyle;
    const on = multi ? P.thumbs.includes(x.key) && !used : P.main === 'iron' && x.key === P.ironStyle;
    h += row(x.key, x.name + '烫' + (used ? '<em>分享图已用</em>' : ''), on, used);
  });
  menuEl.innerHTML = h;
}
function openMenu(btn) {
  if (menuFor === btn) return closeMenu();
  menuFor = btn; buildMenu(); menuEl.hidden = false;
  const r = btn.getBoundingClientRect(), sr = psEl.getBoundingClientRect(), mw = Math.max(r.width, 150);
  menuEl.style.minWidth = mw + 'px';
  const left = Math.min(r.left, sr.right - mw - 8) - sr.left;
  const below = r.bottom + 6 + menuEl.offsetHeight <= innerHeight - 8;
  menuEl.style.left = Math.max(8, left) + 'px';
  menuEl.style.top = (below ? r.bottom + 6 : r.top - 6 - menuEl.offsetHeight) - sr.top + 'px';
  btn.classList.add('open');
}
function closeMenu() { if (!menuFor) return; menuFor.classList.remove('open'); menuFor = null; menuEl.hidden = true; }
[ddMain, ddFoot].forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openMenu(b); }));
menuEl.addEventListener('click', e => {
  e.stopPropagation();
  const it = e.target.closest('.mi'); if (!it || it.classList.contains('dis')) return;
  const v = it.dataset.v;
  if (menuFor === ddMain) { closeMenu(); if (v === 'board') setMain('board'); else { P.ironStyle = v; setMain('iron'); } }
  else {
    thumbsTouched = true;
    if (v === 'none') P.thumbs = [];
    else { const on = new Set(P.thumbs); on.has(v) ? on.delete(v) : on.add(v); P.thumbs = IRON_KEYS.filter(k => on.has(k)); }
  }
  renderDD(); refresh();
});
psEl.addEventListener('click', closeMenu);
$('psDock').addEventListener('scroll', closeMenu, { passive: true });
function setIronStyle(v) { P.ironStyle = v; renderDD(); }
/* 主图：图纸或烫后效果（烫法在 P.ironStyle）；二级开关随之显隐。切换时预览缩放复位 */
function setMain(m) {
  P.main = m; psEl.classList.toggle('main-iron', m === 'iron');
  view.z = 1; view.tx = view.ty = 0; applyView(); renderDD();
}
const syncThumbs = renderDD;
const chipRng = $('psChipRng'), chipValEl = $('psChipVal');
const chipLabel = () => chipShown() ? `${chipCols()} 个 / 行` : '关';
/* 色号大小：分档滑块（0 = 关，1–5 = CHIP_COLS 各档）。滑钮只停在档位上、换档时滑过去；
 * 轨道只在首末两端各画一个端点，中间不画刻度点。拖动按指针离哪个档位最近取档，过了两档中点才换，一次只走一格的距离，不会一下从头跳到尾；点轨道也是滑到最近的那一档。
 * 换档才重绘（按帧合并），手机上换档轻震一下给段落感；键盘 ← → / Home / End 也能调。 */
const CHIP_MAX = CHIP_COLS.length;
[0, CHIP_MAX].forEach(i => { const t = document.createElement('i'); t.className = 'tick'; t.dataset.i = i; t.style.left = `calc(var(--kw) / 2 + (100% - var(--kw)) * ${i} / var(--n))`; chipRng.insertBefore(t, chipRng.querySelector('.knob')); });
chipRng.style.setProperty('--n', CHIP_MAX);
function syncChips() {
  chipRng.style.setProperty('--i', P.chipLevel);
  chipRng.querySelectorAll('.tick').forEach(t => t.classList.toggle('on', +t.dataset.i <= P.chipLevel));
  chipRng.setAttribute('aria-valuenow', P.chipLevel); chipRng.setAttribute('aria-valuetext', chipLabel());
  chipValEl.textContent = chipLabel();
}
let chipRaf = 0;
function setChipLevel(v) {
  v = Math.max(0, Math.min(CHIP_MAX, v));
  if (v === P.chipLevel) return;
  P.chipLevel = v; syncChips();
  if (navigator.vibrate) try { navigator.vibrate(6); } catch (e) {}
  if (!chipRaf) chipRaf = requestAnimationFrame(() => { chipRaf = 0; if (isOpen()) refresh(); });
}
const chipAt = e => { const r = chipRng.getBoundingClientRect(), kw = 14; return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - kw / 2) / (r.width - kw))) * CHIP_MAX); };
chipRng.addEventListener('pointerdown', e => { chipRng.setPointerCapture(e.pointerId); chipRng.classList.add('drag'); setChipLevel(chipAt(e)); });
chipRng.addEventListener('pointermove', e => { if (chipRng.hasPointerCapture(e.pointerId)) setChipLevel(chipAt(e)); });
const chipUp = () => chipRng.classList.remove('drag');
chipRng.addEventListener('pointerup', chipUp); chipRng.addEventListener('pointercancel', chipUp);
/* 键盘：抽屉打开时 window 捕获阶段会拦下全部按键（见「抽屉开合」段），这里由那个拦截器在滑块聚焦时转交 */
function chipKey(e) {
  const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
  if (d) setChipLevel(P.chipLevel + d); else if (e.key === 'Home') setChipLevel(0); else if (e.key === 'End') setChipLevel(CHIP_MAX); else return false;
  e.preventDefault(); return true;
}
syncChips();
if (!HAS_SOURCE) { const o = $('psOptSource'); o.classList.remove('on'); o.classList.add('off'); P.source = false; }
syncThumbs();
function pickBg(hex, el) {
  document.querySelectorAll('#psBgs > *').forEach(d => d.classList.remove('on'));
  el.classList.add('on'); setTheme(hex); refresh();
}
document.querySelectorAll('#psBgs i').forEach(el => el.addEventListener('click', () => pickBg(el.dataset.bg, el)));
$('psBgPick').addEventListener('input', e => pickBg(e.target.value, e.target.parentNode));

/* ---------- 主图缩放：只作用在图纸框里（按钮 / 滚轮 / 拖拽 / 双指），框外裁切；缩放结果同样进出图。
 * 范围：线性 25% ~ 400%（面积最小 1/16、最大 16 倍），按钮每次 ×1.5，到头自动封顶 ---------- */
const ZMIN = 1 / 4, ZMAX = 4, ZSTEP = 1.5;
let raf = 0;
function redraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(previewRs); }); }
const boardC = () => [L.gx + L.gbw / 2, L.gy + L.gbh / 2];
function applyView() {
  const mx = Math.abs(view.z - 1) * L.gbw / 2, my = Math.abs(view.z - 1) * L.gbh / 2;   // 放大时图不露出框边，缩小时图不出框
  view.tx = Math.min(mx, Math.max(-mx, view.tx));
  view.ty = Math.min(my, Math.max(-my, view.ty));
  $('psZReset').textContent = Math.round(view.z * 100) + '%'; zPing();
  $('psZOut').disabled = view.z <= ZMIN + 1e-3;
  $('psZIn').disabled = view.z >= ZMAX - 1e-3;
  stageEl.style.touchAction = 'none';
  redraw();
}
function zoomAt(f, lx, ly) {   // 以框内 (lx, ly)（海报坐标）为不动点缩放
  const nz = Math.min(ZMAX, Math.max(ZMIN, view.z * f)), k = nz / view.z, [cx, cy] = boardC();
  view.tx = (lx - cx) - (lx - cx - view.tx) * k; view.ty = (ly - cy) - (ly - cy - view.ty) * k; view.z = nz;
  applyView();
}
function toBoard(e) {   // 指针在图纸框里的位置（海报坐标）；框外返回 null
  const rc = stageEl.getBoundingClientRect();
  const lx = (e.clientX - rc.left) / rc.width * PW, ly = (e.clientY - rc.top) / rc.height * PH;
  return (lx >= L.gx && ly >= L.gy && lx <= L.gx + L.gbw && ly <= L.gy + L.gbh) ? [lx, ly] : null;
}
function placeZoom() {   // 缩放条收进图纸面板最右下角（红色角标内侧），不压主图中部
  const z = $('psZoom').style;
  z.right = `calc(${(PW - L.bx - L.bw) / PW * 100}% + 3px)`;
  z.bottom = `calc(${(PH - L.by - L.bh) / PH * 100}% + 3px)`;
}
/* 平时半透明；指针移入预览或刚操作过时亮起，片刻后淡回 */
let zActTm = 0;
const zPing = () => { $('psZoom').classList.add('act'); clearTimeout(zActTm); zActTm = setTimeout(() => $('psZoom').classList.remove('act'), 1400); };
$('psZIn').addEventListener('click', () => zoomAt(ZSTEP, ...boardC()));
$('psZOut').addEventListener('click', () => zoomAt(1 / ZSTEP, ...boardC()));
$('psZReset').addEventListener('click', () => { view.z = 1; view.tx = view.ty = 0; applyView(); });
stageEl.addEventListener('wheel', e => {
  const p = toBoard(e); if (!p) return;
  e.preventDefault();
  zoomAt(Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * .0018), p[0], p[1]);
}, { passive: false });
const ptrs = new Map(); let pinch0 = null;
const pxScale = () => PW / stageEl.getBoundingClientRect().width;
stageEl.addEventListener('pointerdown', e => {
  if (!toBoard(e)) return;
  ptrs.set(e.pointerId, [e.clientX, e.clientY]); stageEl.setPointerCapture(e.pointerId);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: view.z }; }
});
stageEl.addEventListener('pointermove', e => {
  const over = toBoard(e);
  stageEl.style.cursor = over && Math.abs(view.z - 1) > 1e-3 ? (ptrs.size ? 'grabbing' : 'grab') : 'default';
  if (!ptrs.has(e.pointerId)) return;
  const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size === 2 && pinch0) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const c = toBoard({ clientX: (a[0] + b[0]) / 2, clientY: (a[1] + b[1]) / 2 }) || boardC();
    zoomAt(pinch0.z * d / pinch0.d / view.z, c[0], c[1]);
  } else if (ptrs.size === 1 && Math.abs(view.z - 1) > 1e-3) {
    const k = pxScale();
    view.tx += (e.clientX - prev[0]) * k; view.ty += (e.clientY - prev[1]) * k; applyView();
  }
});
const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null; };
stageEl.addEventListener('pointerup', up); stageEl.addEventListener('pointercancel', up);
window.addEventListener('resize', () => { if (isOpen() && !kbLockVh) refresh(); }); // 键盘开合引起的 resize 不重排
/* 横竖屏切换：iOS 的 resize 先于新尺寸落定触发，按旧尺寸排出来的宽度会留下来。先清掉上一方向写入的内联尺寸，
 * 页面滚回左上，再在尺寸稳定后补排两次 */
let rotTm = [];
function onRotate() {
  kbLockVh = 0; rotTm.forEach(clearTimeout);
  ['psStageArea', 'psStageWrap', 'psDock'].forEach(id => { const st = $(id).style; st.width = st.minHeight = st.maxHeight = st.flex = st.alignSelf = ''; });
  sheetEl.style.height = '';
  rotTm = [0, 250, 700].map(t => setTimeout(() => { window.scrollTo(0, 0); document.documentElement.scrollLeft = document.body.scrollLeft = 0; if (isOpen()) refresh(); }, t));
}
window.addEventListener('orientationchange', onRotate);
if (screen.orientation) screen.orientation.addEventListener('change', onRotate);

/* ---------- 导出：电脑走浏览器下载；手机先调系统分享，分享弹不出时 PNG 铺满屏幕长按保存、PDF 给「保存 PDF」按钮再点一下 ---------- */
const IS_TOUCH = matchMedia('(pointer:coarse)').matches;
/* 下载格式：PNG（固定最高清，见 pngScale）/ PDF（单页，页面与海报同比例，内嵌按设备上限取的最高清位图）。
 * PDF 不做矢量：主图里的光效、烫后质感、原图本来就是位图，字体也无法原样嵌入，整页位图才能和预览一模一样。 */
let FMT = 'png';
const DL_LABEL = IS_TOUCH ? '保存' : '下载';
const dlLbl = $('psDl').querySelector('.lbl');
dlLbl.textContent = DL_LABEL;
/* 下载文件名：[A/B_]标题[_画风_备注]_任务ID_规格_色数色.png。
 * 任务 ID / 后端标识（A=经典版 val-perler.qq.com、B=自研 apinebula）/ 画风备注片段（如 _Q版_嘴巴改小）
 * 由产品服务端在对图纸页下发时注入 window.PIXELART_TASK_ID / PIXELART_BACKEND / PIXELART_SEG；
 * 本地直接打开这份 HTML 时没有这些变量，就退回「标题_规格_色数色」。 */
const TASK_ID = (window.PIXELART_TASK_ID || '').toString().trim();
const BACKEND_TAG = (window.PIXELART_BACKEND || '').toString().trim();
const SEG_TAG = (window.PIXELART_SEG || '').toString();
const fileName = (ext = 'png') => `${BACKEND_TAG ? BACKEND_TAG + '_' : ''}${state.title.replace(/[\\/:*?"<>|]/g, '')}${SEG_TAG}${TASK_ID ? '_' + TASK_ID : ''}_${PGW}x${PGH}_${PT.colors}色.${ext}`;
$('psFmt').addEventListener('click', e => {
  e.stopPropagation();
  FMT = FMT === 'png' ? 'pdf' : 'png';
  $('psFmtName').textContent = FMT.toUpperCase();
  $('psFmt').title = '切换为 ' + (FMT === 'png' ? 'PDF' : 'PNG');
});
const CANVAS_MAX_PX = IS_TOUCH ? 16e6 : 32e6;   // 手机（iOS Safari）单张 canvas 面积上限约 16.7M 像素；电脑端放宽，保证 PDF 不低于 4K PNG
/* 出图倍率梯度：每格像素 = 970 / 边长 × 倍率，倍率不变时大规格的格子和色号线性变小。
 * 分三档让色号在导出图里恒定 ≥8px 高（32% 格宽）：≤104 用 4K 已 ~21px；
 * 104–130 提到 4.6；>130 提到 6.0（156 每格 ~34px、色号 ~11px）。手机仍按画布面积封顶，到不了就到不了。 */
const pngGrade = () => Math.max(PGW, PGH) <= 104 ? PNG_SCALE : Math.max(PGW, PGH) <= 130 ? 4.6 : 6.0;
const pdfScale = () => Math.min(4, Math.sqrt(CANVAS_MAX_PX / (PW * PH)));
const pngScale = () => Math.min(pngGrade(), Math.sqrt(CANVAS_MAX_PX / (PW * PH)));   // 长海报在手机上超画布上限会导出空白，按上限封顶
function pdfFromJpeg(jpg, pxW, pxH) {
  const ptW = 595.28, ptH = +(ptW * pxH / pxW).toFixed(2);   // 宽取 A4 宽，高随海报比例
  const enc = t => new TextEncoder().encode(t);
  const parts = [], offs = []; let len = 0;
  const push = b => { parts.push(b); len += b.length; };
  push(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
  const obj = (n, body, stream) => {
    offs[n] = len;
    push(enc(`${n} 0 obj\n${body}\n`));
    if (stream) { push(enc('stream\n')); push(stream); push(enc('\nendstream\n')); }
    push(enc('endobj\n'));
  };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
  const cs = enc(`q ${ptW} 0 0 ${ptH} 0 0 cm /Im0 Do Q`);
  obj(5, `<< /Length ${cs.length} >>`, cs);
  const xref = len;
  let x = 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++) x += String(offs[n]).padStart(10, '0') + ' 00000 n \n';
  push(enc(x + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Blob(parts, { type: 'application/pdf' });
}
async function deliver(blob, name, size, mime) {
  if (!IS_TOUCH) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`已保存 · ${size}`); return;
  }
  const file = new File([blob], name, { type: mime });
  let canShare = false;
  try { canShare = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) {}
  if (canShare) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  /* 出高清图要好几秒，系统认定这次分享已不是玩家刚点的（iOS 报 NotAllowedError），面板弹不出来。
   * PNG 铺满屏幕长按存相册；PDF 存不进相册，就弹一个「保存 PDF」按钮，玩家再点一下用这次点按去分享。
   * App 内嵌页不让页面自己开新窗口，不再用新窗口打开 PDF。 */
  if (mime === 'application/pdf') {
    if (canShare) return showShareTap(file, size);
    toast('这里存不了 PDF，请切换成 PNG 保存', 4000); return;
  }
  await showSaveSheet(blob, size, '长按图片保存到相册');
}
function showShareTap(file, size) {
  const el = $('psSave'), go = el.querySelector('.go');
  el.querySelector('img').hidden = true; go.hidden = false;
  el.querySelector('b').textContent = 'PDF 已生成'; el.querySelector('.sz').textContent = size;
  go.onclick = async e => {
    e.stopPropagation();
    try { await navigator.share({ files: [file] }); }
    catch (err) { if (!err || err.name !== 'AbortError') toast('这里存不了 PDF，请切换成 PNG 保存', 4000); }
    el.classList.remove('show');
  };
  el.classList.add('show');
}
/* 把成品图铺满屏幕让玩家长按存相册 */
function showSaveSheet(blob, size, tip) {
  return new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => {
      const el = $('psSave'); el.querySelector('img').hidden = false; el.querySelector('.go').hidden = true; el.querySelector('img').src = fr.result; el.querySelector('.sz').textContent = size;
      el.querySelector('b').textContent = tip; el.classList.add('show'); res();
    };
    fr.readAsDataURL(blob);
  });
}
$('psDl').addEventListener('click', () => {
  const btn = $('psDl');
  btn.classList.add('busy'); dlLbl.textContent = '生成中…';
  const done = () => { btn.classList.remove('busy'); dlLbl.textContent = DL_LABEL; };
  setTimeout(() => {
    const off = document.createElement('canvas');
    const pdf = FMT === 'pdf', sc = pdf ? pdfScale() : pngScale();
    render(sc, off);
    off.toBlob(async blob => {
      try {
        if (pdf) {
          const jpg = new Uint8Array(await blob.arrayBuffer());
          await deliver(pdfFromJpeg(jpg, off.width, off.height), fileName('pdf'), `PDF · ${off.width}×${off.height}`, 'application/pdf');
        } else await deliver(blob, fileName('png'), `${off.width}×${off.height}`, 'image/png');
      } finally { done(); }
    }, pdf ? 'image/jpeg' : 'image/png', pdf ? .95 : undefined);
  }, 30);
});
$('psSave').addEventListener('click', e => { if (e.target.tagName !== 'IMG') $('psSave').classList.remove('show'); });

/* ---------- 抽屉开合 ---------- */
const sheetEl = $('ps');
function isOpen() { return document.body.classList.contains('ps-open'); }
function setOpen(on) {
  document.body.classList.toggle('ps-open', on);
  sheetEl.style.transform = '';
  if (!on) closeMenu();
}
function openPoster() {
  snapshot();
  if (typeof ironStyle !== 'undefined') {   // 默认跟图纸页「模拟烫豆」当前选的烫法：主图烫法总是跟随，底栏在玩家动过之前跟随
    P.ironStyle = ironStyle;
    if (!thumbsTouched) P.thumbs = [ironStyle];
    renderDD();
  }
  view.z = 1; view.tx = view.ty = 0;
  setOpen(true);
  requestAnimationFrame(() => { refresh(); applyView(); });
}
/* 存不了文件的内嵌页（WorkBuddy 产物区）里导出必然落不了盘，不开抽屉，直接引导去默认浏览器 */
$('flowExpBtn').onclick = PC_SANDBOX ? () => toast('导出需要用默认浏览器打开：点右上角「···」→「在外部浏览器打开」', 8000, true) : openPoster;
$('psClose').addEventListener('click', () => setOpen(false));
$('psMask').addEventListener('click', () => setOpen(false));
/* 抽屉打开时键盘只归抽屉：Esc 先收菜单再收抽屉；其他按键不触发图纸页快捷键 */
window.addEventListener('keydown', e => {
  if (!isOpen()) return;
  e.stopImmediatePropagation();
  if (document.activeElement === chipRng && chipKey(e)) return;
  if (e.key === 'Escape') { if (menuFor) closeMenu(); else setOpen(false); }
}, true);
const headEl = $('psHead');
let drag0 = null, dragRaf = 0;
const vhNow = () => window.visualViewport ? visualViewport.height : innerHeight;
headEl.addEventListener('pointerdown', e => {
  if (e.target.closest('#psClose')) return;
  drag0 = { y: e.clientY, h: sheetEl.getBoundingClientRect().height, down: 0, moved: false, r0: userSheetR };
  headEl.setPointerCapture(e.pointerId); sheetEl.style.transition = 'none';
});
headEl.addEventListener('pointermove', e => {
  if (!drag0) return;
  const dy = e.clientY - drag0.y;   // 往上拖为负：抽屉变高
  if (!drag0.moved && Math.abs(dy) < 6) return;
  drag0.moved = true;
  const vh = vhNow(), lo = vh * SHEET_DRAG_MIN, hi = vh * SHEET_DRAG_MAX;
  const h = Math.min(hi, drag0.h - dy);
  drag0.down = Math.max(0, lo - h);   // 比最矮还矮的部分转成下移，进入收起手势
  userSheetR = Math.max(lo, h) / vh;
  sheetEl.style.transform = drag0.down ? `translateY(${drag0.down}px)` : '';
  if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = 0; if (isOpen()) refresh(); });
});
const dragEnd = () => {
  if (!drag0) return;
  sheetEl.style.transition = '';
  if (drag0.moved) {
    const close = drag0.down > Math.min(90, sheetEl.clientHeight * .15);
    if (close) { userSheetR = drag0.r0; sheetEl.style.transform = ''; }   // 收起手势不改记住的高度，下次打开还是原来的高矮
    else try { localStorage.setItem(SHEET_KEY, userSheetR.toFixed(4)); } catch (e) {}
    setOpen(!close);
    if (close) setTimeout(() => { if (!isOpen()) sheetEl.style.height = ''; }, 400);
  }
  drag0 = null;
};
headEl.addEventListener('pointerup', dragEnd); headEl.addEventListener('pointercancel', dragEnd);
})();
/* ===== [POSTER] 导出图纸抽屉 END ===== */