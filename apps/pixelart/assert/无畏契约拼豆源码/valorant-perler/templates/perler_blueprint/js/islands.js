/* =====================================================================
 * [ISLANDS] 附属岛模块 BEGIN
 * 生图底稿常带与主体不相连的小元素（气泡、爱心、速度线、苦无）。前景按 8 连通拆块，
 * 最大块是主体，其余面积 < 主体 × RATIO 的块是「附属岛」，出图纸时默认整块剔除。
 * 岛判定锚定玩家所见矩阵：在当前 (size,palette) 的默认色数档（budget=0）解析矩阵上做 8 连通检测并缓存；
 * 尺寸/色板各自独立判定。这套逻辑与 island_probe.mjs / 专家包 postprocess.py 的 drop_islands 同源。
 *
 * 玩家侧叫「孤立像素」，按钮用「移除 / 恢复」；ISLANDS / 附属岛只是代码内部名。
 * 剔除 / 恢复都走编辑台：改的是 grid（唯一事实源），经 edCommit() 记一步可撤销操作 + 标未保存；
 * 浏览态点击先弹确认说明会进入编辑模式，确认后进入；编辑态下本区块不随侧栏锁定，可连续处理多块。
 * 与编辑态共用撤销与保存；「还原初始图纸」清存档回到默认剔除态。
 * 岛状态不单独持久化：从当前 grid 反推 —— 岛格全为空 = 已剔除，否则 = 已恢复。
 * 接点 [ISLANDS hook]：parseGrid() 无存档时调 islandDefaultCull()；refreshAll() 调 islandRender()；draw() 调 islandDrawHover()。
 * ===================================================================== */
const ISLAND_RATIO = 0.1;              // 附属块面积 < 主体面积 × 该值即为岛（与管线默认一致）
const ISLAND_CACHE = {};               // 键 size|palette -> 岛数组（锚定 budget=0 解析矩阵）
let islandHover = null;                // 侧栏悬停中的岛（画布高亮用）

/* 8 连通拆块 + 附属岛判定，纯 BFS，与 postprocess.drop_islands 等价 */
function islandDetect(g) {
  const GHl = g.length, GWl = g[0].length, comp = new Int32Array(GWl * GHl).fill(-1), comps = [];
  for (let j = 0; j < GHl; j++) for (let i = 0; i < GWl; i++) {
    const idx = j * GWl + i;
    if (!g[j][i] || comp[idx] >= 0) continue;
    const cells = [idx]; comp[idx] = comps.length; let head = 0;
    while (head < cells.length) {
      const cur = cells[head++], ci = cur % GWl, cj = (cur / GWl) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= GWl || nj >= GHl) continue;
        const nidx = nj * GWl + ni;
        if (g[nj][ni] && comp[nidx] < 0) { comp[nidx] = comps.length; cells.push(nidx); }
      }
    }
    comps.push(cells);
  }
  if (comps.length <= 1) return [];
  let main = 0;
  for (let c = 1; c < comps.length; c++) if (comps[c].length > comps[main].length) main = c;
  const mainSize = comps[main].length, out = [];
  for (let c = 0; c < comps.length; c++) {
    if (c === main || comps[c].length >= ISLAND_RATIO * mainSize) continue;
    out.push(islandInfo(comps[c], g, GWl, GHl));
  }
  out.sort((a, b) => b.size - a.size || a.cells[0] - b.cells[0]);
  return out;
}
function islandInfo(cells, g, GWl, GHl) {
  let sumI = 0, sumJ = 0; const cc = new Map();
  for (const idx of cells) {
    const i = idx % GWl, j = (idx / GWl) | 0; sumI += i; sumJ += j;
    const code = g[j][i]; cc.set(code, (cc.get(code) || 0) + 1);
  }
  let mainCode = '', mc = -1;
  for (const [code, n] of cc) if (n > mc) { mc = n; mainCode = code; }
  const cx = sumI / cells.length, cy = sumJ / cells.length;
  return { cells: cells.slice().sort((a, b) => a - b), size: cells.length, mainCode, cx, cy, pos: islandPos(cx, cy, GWl, GHl) };
}
function islandPos(cx, cy, GWl, GHl) {
  const col = cx < GWl / 3 ? '左' : cx < GWl * 2 / 3 ? '中' : '右';
  const row = cy < GHl / 3 ? '上' : cy < GHl * 2 / 3 ? '中' : '下';
  if (row === '中' && col === '中') return '中部';
  if (row === '中') return col + '侧';
  if (col === '中') return row === '上' ? '顶部' : '底部';
  return row + col;
}
/* 当前 (size,palette) 的岛列表：锚定 budget=0 解析矩阵，缓存 */
function curIslands() {
  const key = state.size + '|' + state.palette;
  if (ISLAND_CACHE[key]) return ISLAND_CACHE[key];
  return ISLAND_CACHE[key] = islandDetect(resolveGrid(state.size, state.palette, 0));
}
/* 已剔除 = 岛格全为空；已恢复 = 至少一格非空 */
function islandCulled(isl) { return isl.cells.every(idx => grid[(idx / GW) | 0][idx % GW] === ''); }

/* 无存档基线：默认把所有岛格删成背景（不写 localStorage，玩家未操作） */
function islandDefaultCull() {
  for (const isl of curIslands()) for (const idx of isl.cells) grid[(idx / GW) | 0][idx % GW] = '';
}

/* 剔除 / 恢复：改 grid，走编辑台记一步可撤销操作 */
function islandChanges(isl, restore) {
  const res = restore ? resolveGrid(state.size, state.palette, state.budget) : null;
  const changes = [];
  for (const idx of isl.cells) {
    const i = idx % GW, j = (idx / GW) | 0, from = grid[j][i];
    const to = restore ? (res[j][i] || '') : ''; // 恢复取当前 budget 该格解析色；解析为空则保持空
    if (from !== to) changes.push([idx, from, to]);
  }
  return changes;
}
async function islandOp(changes, label) {
  if (!changes.length) return;
  if (!ed.on) {                         // 浏览态点击：先说明会进入编辑模式，玩家确认后再进
    if (state.view !== 'grid') document.querySelector('.viewtab[data-view="grid"]').click(); // 确认框挂在图纸视图里
    const go = await edConfirm('进入图纸编辑', '恢复或移除孤立像素需进入编辑模式。可连续处理多处、随时撤销，保存后生效。', [
      { label: '取消', value: null },
      { label: '进入编辑', value: true, primary: true },
    ]);
    if (!go) return;
    edEnter();
  }
  for (const [idx, , to] of changes) edSetCell(idx, to); // 先写入 grid，再 edCommit 记步
  edCommit(changes, label);             // 记一步可撤销 + 标未保存
}
function islandRestoreOne(isl) { islandOp(islandChanges(isl, true), '恢复孤立像素'); }
function islandCullOne(isl) { islandOp(islandChanges(isl, false), '移除孤立像素'); }
function islandRestoreAll() {
  const all = []; for (const isl of curIslands()) if (islandCulled(isl)) all.push(...islandChanges(isl, true));
  islandOp(all, '恢复全部孤立像素');
}
function islandCullAll() {
  const all = []; for (const isl of curIslands()) if (!islandCulled(isl)) all.push(...islandChanges(isl, false));
  islandOp(all, '移除全部孤立像素');
}

/* ---------- 侧栏区块渲染 ---------- */
function islandRender() {
  const sec = document.getElementById('islandSec');
  const islands = curIslands();
  const note = document.getElementById('islandNote'), btn = document.getElementById('islandAllBtn');
  sec.classList.toggle('none', !islands.length);
  if (!islands.length) {                             // 没有孤立像素：区块常驻，计数显示 0
    document.getElementById('islandHint').textContent = '0';
    note.textContent = '这张图纸没有与主体不相连的小色块';
    document.getElementById('islandList').innerHTML = '';
    btn.style.display = 'none';
    return;
  }
  note.textContent = '与主体不相连的小色块，已默认移除，可逐个恢复';
  btn.style.display = '';
  const culled = islands.filter(islandCulled);
  const M = culled.reduce((a, x) => a + x.size, 0);
  document.getElementById('islandHint').textContent = culled.length
    ? `已移除 ${culled.length} 处（共 ${M} 颗）` : '已全部恢复';
  const list = document.getElementById('islandList'); list.innerHTML = '';
  islands.forEach((isl, k) => {
    const gone = islandCulled(isl), col = PALS[state.palette].byCode[isl.mainCode];
    const row = document.createElement('div');
    row.className = 'island-row' + (gone ? '' : ' restored');
    row.innerHTML = `
      <div class="isw" style="background-color:${col ? col.hex : '#888'}"></div>
      <div class="ii"><b>${isl.size} 颗 · ${isl.pos}</b><span>主要颜色 ${isl.mainCode}${col ? ' · ' + col.name : ''}</span></div>
      <button class="ibtn">${gone ? '恢复' : '移除'}</button>`;
    row.querySelector('.ibtn').onclick = e => { e.stopPropagation(); gone ? islandRestoreOne(isl) : islandCullOne(isl); };
    row.onmouseenter = () => { islandHover = isl; draw(); };
    row.onmouseleave = () => { if (islandHover === isl) { islandHover = null; draw(); } };
    list.appendChild(row);
  });
  const allRestored = islands.every(isl => !islandCulled(isl));
  btn.textContent = allRestored ? '全部移除' : '全部恢复';
  btn.onclick = () => allRestored ? islandCullAll() : islandRestoreAll();
}

/* ---------- 画布悬停高亮：半透明遮罩 + 虚线框，不改 draw 主流程 ---------- */
function islandDrawHover(s) {
  if (state.view !== 'grid' || state.mode === '3d' || !islandHover) return;
  const isl = islandHover;
  ctx.save();
  ctx.fillStyle = 'rgba(43,214,196,.32)';
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const idx of isl.cells) {
    const i = idx % GW, j = (idx / GW) | 0, x0 = state.mirror ? (GW - 1 - i) : i;
    const x = state.ox + x0 * s, y = state.oy + j * s;
    ctx.fillRect(x, y, s + 0.5, s + 0.5);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x + s);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y + s);
  }
  ctx.strokeStyle = '#2BD6C4'; ctx.lineWidth = Math.max(1.5, s * 0.12);
  ctx.setLineDash([Math.max(4, s * 0.5), Math.max(3, s * 0.35)]);
  const pad = ctx.lineWidth;
  ctx.strokeRect(minX - pad, minY - pad, (maxX - minX) + pad * 2, (maxY - minY) + pad * 2);
  ctx.restore();
}
/* [ISLANDS] 附属岛模块 END ======================================================== */
