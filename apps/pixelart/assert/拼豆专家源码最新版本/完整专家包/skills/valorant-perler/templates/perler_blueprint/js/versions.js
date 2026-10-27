/* =====================================================================
 * [VERSIONS] 版本
 * 每次在编辑态点保存，就把当前矩阵存成一个小版本 v1、v2…，按「规格 × 色板 × 颜色数量」各自一套编号。
 * 回到某个版本 = 一次编辑：进入编辑态，把矩阵改成那个版本，算一步可撤销的操作并标为未保存；
 * 不保存就不产生版本，保存后得到新的版本号（在 v3 回到 v2 再保存得到 v4），已有版本只增不减。
 * 侧栏里存过版本的规格 / 色板 / 颜色数量带红点，悬停显示这里手动保存了几个版本。
 * 存储：localStorage 键 perler-vers-{任务}-{规格}-{色板}[-b{档位}]，值 = [{ n, t, cells, rows }]，rows 为整幅矩阵快照。
 * 「初始」= 没有存档时打开看到的图纸：管线解析矩阵再按孤立像素默认移除。
 * 接点 [VERSIONS hook]：edSave() 调 verSave()；refreshAll() 调 verDecorate()；侧栏三类选择器写 data-vk。
 * ===================================================================== */
function verCombo(size, pal, budget) { return `${size}-${pal}${budget ? '-b' + budget : ''}`; }
function VKEY(combo) { return `perler-vers-${TASK_KEY}-${combo}`; }
function verList(combo = verCombo(state.size, state.palette, state.budget)) {
  try { return JSON.parse(localStorage.getItem(VKEY(combo)) || '[]'); } catch (e) { return []; }
}
function verRows() { return grid.map(r => r.join(',')); }
function verDiff(fromRows, toRows) { // 返回 [[idx, from, to], ...]
  const out = [];
  for (let j = 0; j < toRows.length; j++) {
    const a = fromRows[j].split(','), b = toRows[j].split(',');
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) out.push([j * b.length + i, a[i], b[i]]);
  }
  return out;
}
function verInitRows() {
  const g = resolveGrid(state.size, state.palette, state.budget).map(r => r.slice()), w = g[0].length;
  for (const isl of curIslands()) for (const idx of isl.cells) g[(idx / w) | 0][idx % w] = '';
  return g.map(r => r.join(','));
}
function verSave() {
  const list = verList(), rows = verRows();
  const prev = list.length ? list[list.length - 1].rows : verInitRows();
  const v = { n: list.length ? list[list.length - 1].n + 1 : 1, t: Date.now(), cells: verDiff(prev, rows).length, rows };
  if (list.length && !v.cells) return null; // 和最新版本一样，不重复记
  list.push(v);
  try { localStorage.setItem(VKEY(verCombo(state.size, state.palette, state.budget)), JSON.stringify(list)); }
  catch (e) { toast('本机空间不足，未记录新版本'); return null; }
  verDecorate();
  return v;
}
function verTime(t) { const d = new Date(t), p = x => String(x).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; }

/* ---------- 侧栏红点 + 版本按钮 ---------- */
function verDecorate() {
  document.querySelectorAll('[data-vk]').forEach(el => {
    const n = verList(el.dataset.vk).length;
    el.classList.toggle('has-ver', n > 0); el.dataset.vn = n;
  });
  const list = verList(), btn = document.getElementById('verBtn');
  btn.classList.toggle('show', list.length > 0);
  const cur = verCurrent(list);
  btn.textContent = list.length ? `${cur ? 'v' + cur.n : 'v' + list[list.length - 1].n + '*'} ▾` : '';
  if (document.getElementById('verPanel').classList.contains('show')) verRender();
}
/* 有未保存改动时不算任何版本 */
function verCurrent(list) { if (ed.on && ed.dirty) return null; const s = JSON.stringify(verRows()); return [...list].reverse().find(v => JSON.stringify(v.rows) === s) || null; }
const verTip = document.createElement('div'); verTip.id = 'verTip'; document.body.appendChild(verTip);
document.querySelector('aside').addEventListener('mouseover', e => {
  const el = e.target.closest('[data-vk].has-ver');
  if (!el) { verTip.classList.remove('show'); return; }
  const list = verList(el.dataset.vk), last = list[list.length - 1];
  verTip.innerHTML = `已手动保存 <b>${list.length}</b> 个版本 · 最新 v${last.n}（${verTime(last.t)}）`;
  const r = el.getBoundingClientRect();
  verTip.style.left = r.left + 'px'; verTip.style.top = (r.bottom + 6) + 'px'; verTip.classList.add('show');
});
document.querySelector('aside').addEventListener('mouseleave', () => verTip.classList.remove('show'));

/* ---------- 版本面板：悬停预览，点击回到该版本 ---------- */
function verRender() {
  const list = verList(), cur = verCurrent(list);
  const el = document.getElementById('verList'); el.innerHTML = '';
  const item = (label, note, rows, isCur, title) => {
    const d = document.createElement('div'); d.className = 'it' + (isCur ? ' cur' : ''); d.title = title;
    d.innerHTML = `<span class="v">${label}</span><span class="t">${note}</span>`;
    d.onmouseenter = () => verPreview(rows()); d.onmouseleave = () => verPreview(null);
    d.onclick = () => verApply(rows(), label);
    el.appendChild(d);
  };
  for (const v of [...list].reverse()) {
    item('v' + v.n, `${verTime(v.t).split(' ')[1]} · 修改 ${v.cells} 格`, () => v.rows, cur === v, verTime(v.t));
  }
  const init = verInitRows();
  item('初始版本', '初始图纸', () => init, false, '');
}
function verPreview(rows) {
  ed.preview = rows ? new Map(verDiff(verRows(), rows).map(([k, , to]) => [k, to])) : null;
  if (ed.on) ed.hoverCell = null;
  draw();
}
function verApply(rows, label) {
  verPreview(null); verShow(false);
  if (!ed.on) edEnter();
  const changes = verDiff(verRows(), rows);
  if (!changes.length) return;
  for (const [idx, , to] of changes) edSetCell(idx, to);
  edCommit(changes, `恢复到 ${label}`); // 一次编辑：可撤销、标未保存；保存后才成为新版本
}
function verShow(v) {
  document.getElementById('verPanel').classList.toggle('show', v);
  document.getElementById('verBtn').classList.toggle('open', v);
  if (v) verRender(); else verPreview(null);
}
document.getElementById('verBtn').onclick = e => { e.stopPropagation(); verShow(!document.getElementById('verPanel').classList.contains('show')); };
document.addEventListener('mousedown', e => { if (!e.target.closest('#verPanel, #verBtn')) verShow(false); });
