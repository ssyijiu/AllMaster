/* ================= 侧边栏渲染 ================= */
const CS_CARD = document.getElementById('csRow'); // [CUSTOM-SIZE] 输入卡常驻第一位：重绘时摘下再放回，保留输入内容与事件
function renderSizes() {
  const el = document.getElementById('sizeGrid'); el.innerHTML = ''; el.appendChild(CS_CARD);
  for (const s of D.sizes) {
    const b = document.createElement('div');
    b.className = 'size-card' + (s.key === state.size ? ' active' : '');
    b.dataset.key = s.key; if (s.page) b.dataset.page = '1';
    b.dataset.vk = verCombo(s.key, state.palette, state.budget); // [VERSIONS hook]
    b.title = imgSizeOf(s.key).replace('<br>', '').trim(); // 图案实际占格放进悬停提示，卡面只留尺寸与颗数
    b.innerHTML = `
      ${s.key === D.defaultSize ? '<div class="badge">推荐</div>' : ''}
      <img src="${thumb(s.key)}" alt="${s.w}×${s.h} 尺寸预览">
      <div class="nm"><span class="n">${s.isCustom ? '自定义 ' : ''}${s.w}×${s.h}</span><span class="meta">(${beadsOf(s.key)}颗)</span></div>`;
    b.onclick = () => { state.size = s.key; parseGrid(); buildColorMap(); loadProgress(); refreshAll(); fitView(); };
    el.appendChild(b);
  }
  csRenderCards(el); // [CUSTOM-SIZE hook] 页面自定义卡的删除钮 + 计算中的卡
}

/* 规格卡：按当前色板画缩略图（内存缓存） */
const THUMBS = {};
function beadsOf(key) {
  const g = key === state.size ? grid : resolveGrid(key, state.palette, state.budget);
  let n = 0; for (const r of g) for (const c of r) if (c) n++; return n;
}
/* 尺寸卡上的图像尺寸：图案实际占用的格数（拼豆板尺寸是上限，图案按比例缩放后可能小于它） */
function imgSizeOf(key) {
  const sp = D.specs[key];
  return sp && sp.contentW ? `图像 ${sp.contentW}×${sp.contentH}<br>` : '';
}
function thumb(key) {
  const tk = key + '|' + state.palette + '|' + state.budget + (key === state.size ? '|' + JSON.stringify(D.specs[key].counts) : '');
  if (THUMBS[tk]) return THUMBS[tk];
  const g = key === state.size ? grid : resolveGrid(key, state.palette, state.budget);
  const w = g[0].length, h = g.length;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); const img = x.createImageData(w, h);
  g.forEach((row, j) => row.forEach((code, i) => {
    const o = (j * w + i) * 4, rgb = code ? PAL[code].rgb : [255, 255, 255];
    img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
  }));
  x.putImageData(img, 0, 0);
  return THUMBS[tk] = c.toDataURL();
}

function switchBudget(k) {
  k = Number(k);
  if (k === state.budget) return;
  state.budget = k;
  parseGrid(); loadProgress(); refreshAll();
  const sp = D.specs[state.size];
  toast(`已调整为 ${sp.colors} 色 · ${sp.beads} 颗` + (k === 0 ? ' · 推荐值' : ''));
}
function levelColors(step) {
  const g = resolveGrid(state.size, state.palette, step);
  const s = new Set(); for (const r of g) for (const c of r) if (c) s.add(c); return s.size;
}
function renderBudget() {
  const sl = document.getElementById('budgetSlider');
  sl.max = D.levels.length - 1;
  sl.value = D.levels.findIndex(l => l.step === state.budget);
  document.getElementById('budgetTicks').innerHTML = D.levels.map(l =>
    `<span data-vk="${verCombo(state.size, state.palette, l.step)}" class="${l.step === state.budget ? 'on' : ''} ${l.step === 0 ? 'def' : ''}">${levelColors(l.step)}<i>色</i></span>`).join('');
  document.getElementById('budgetHint').textContent = `${D.specs[state.size].colors} 色`;
}
document.getElementById('budgetSlider').oninput = e => switchBudget(D.levels[Number(e.target.value)].step);

function switchPalette(id) {
  if (id === state.palette) return;
  state.palette = id; buildColorMap();
  parseGrid(); loadProgress(); refreshAll();
  const p = PALS[id], sp = D.specs[state.size];
  toast(`已切换至 ${p.label} · ${sp.colors} 色 · ${sp.beads} 颗`);
}
function renderPalettes() {
  const el = document.getElementById('palList'); el.innerHTML = '';
  const groups = {};
  D.palettes.forEach(p => (groups[p.group] = groups[p.group] || []).push(p));
  for (const [g, list] of Object.entries(groups)) {
    const h = document.createElement('div'); h.className = 'pal-group'; h.textContent = g;
    el.appendChild(h);
    const tiers = list.filter(p => p.tier);
    if (tiers.length) {   // MARD 按套装色数卖：一排档位芯片，按玩家手里那盒选
      const row = document.createElement('div'); row.className = 'tier-row';
      tiers.sort((a, b) => a.tier - b.tier).forEach(p => {
        const b = document.createElement('button');
        b.className = 'tier-chip' + (p.id === state.palette ? ' active' : '') + (p.id === DEFAULT_PAL ? ' def' : '');
        b.dataset.vk = verCombo(state.size, p.id, state.budget); // [VERSIONS hook]
        b.textContent = p.tier; b.title = `${p.label} · ${p.sub}`;
        b.onclick = () => switchPalette(p.id);
        row.appendChild(b);
      });
      el.appendChild(row);
    }
    for (const p of list.filter(p => !p.tier)) {
      const b = document.createElement('div');
      b.className = 'pal-btn' + (p.id === state.palette ? ' active' : '');
      b.dataset.vk = verCombo(state.size, p.id, state.budget); // [VERSIONS hook]
      b.innerHTML = `<span>${p.label}</span><span class="sub">${p.sub}</span>`;
      b.onclick = () => switchPalette(p.id);
      el.appendChild(b);
    }
  }
  const cur = PALS[state.palette];
  document.getElementById('palNote').textContent = cur.tier ? '只用套装内的色号' : '按原图颜色匹配';
}

/* 拼豆进度记录表排序：用量降序 / 色号自然序（字母段 + 数字段），偏好按任务存 localStorage */
const codeCollator = new Intl.Collator('en', { numeric: true });
function sortRows(rows) {
  return state.sortKey === 'code'
    ? rows.sort((a, b) => codeCollator.compare(a[0], b[0]))
    : rows.sort((a, b) => b[1] - a[1] || codeCollator.compare(a[0], b[0]));
}
const SKEY = `perler-sort-${TASK_KEY}`;
try { state.sortKey = localStorage.getItem(SKEY) || 'count'; } catch (e) {}
function setSort(key) {
  state.sortKey = key;
  try { localStorage.setItem(SKEY, key); } catch (e) {}
  document.querySelectorAll('.sortseg button').forEach(b => b.classList.toggle('on', b.dataset.key === key));
  renderColors();
}
document.querySelectorAll('.sortseg button').forEach(b => {
  b.classList.toggle('on', b.dataset.key === state.sortKey);
  b.onclick = () => setSort(b.dataset.key);
});

/* [TRACK-HOVER] 进度表悬停预览：鼠标移到某色那一行，图纸上该色像「正在拼」一样亮起、其余淡下去（与图纸编辑选色的悬停反馈同一观感）；
 * 移开回到原样。只是预览，不改 state.highlight、不存档；触屏不触发（点按就是真的选为在拼色） */
let trackHover = null;
function trackHL() { return trackHover !== null && colorMap[trackHover] ? trackHover : state.highlight; }
function trackPreview(code) { if (trackHover === code) return; trackHover = code; if (typeof edRequestDraw === 'function') edRequestDraw(); else draw(); }

function renderColors() {
  const counts = D.specs[state.size].counts;
  const total = D.specs[state.size].beads;
  const rows = sortRows(Object.entries(counts));
  const max = Math.max(...rows.map(r => r[1]));
  const el = document.getElementById('colorRows'); el.innerHTML = '';
  for (const [code, n] of rows) {   // 行位置只由排序键决定：打卡不换位，同一个方框连点只切换这一色
    const c = colorMap[code];
    const r = document.createElement('div');
    r.className = 'crow' + (state.highlight === code ? ' hl' : '') + (state.done.has(code) ? ' done' : '');
    r.title = `${c.code} · ${c.name} · ${c.hex}`;
    const name = c.name.startsWith('≈') ? '' : c.name;   // 非 MARD 色板的名字只是「≈ MARD xx」映射，不占行宽
    r.innerHTML = `
      <div class="sw" style="background:${c.hex}"></div>
      <div class="ci"><span class="code">${c.code}${state.highlight === code ? '<i class="now">正在拼</i>' : ''}</span><span class="name">${state.done.has(code) ? '已拼完' : name}</span></div>
      <div class="use">${n}<small>颗</small></div>
      <button class="tick" title="${state.done.has(code) ? '取消打卡' : '这色拼完了，打卡'}" aria-label="${state.done.has(code) ? '取消打卡' : '打卡'}">✓</button>
      <div class="bar"><i style="width:${(n/max*100).toFixed(1)}%"></i></div>`;
    r.querySelector('.tick').onclick = e => { e.stopPropagation(); toggleDone(code); };
    r.onclick = () => { trackHover = null; setCurrent(code); };
    r.onpointerenter = e => { if (e.pointerType !== 'touch') trackPreview(code); };
    r.onpointerleave = () => trackPreview(null);
    el.appendChild(r);
  }
  document.getElementById('hlHint').textContent = state.highlight ? '◉ 正在下豆：' + colorMap[state.highlight].code : '';
  renderProgress(rows, total);
}

function renderProgress(rows, total) {
  const doneBeads = rows.reduce((s, [code, n]) => s + (state.done.has(code) ? n : 0), 0);
  const pct = total ? doneBeads / total * 100 : 0;
  document.querySelector('#progBar i').style.width = pct.toFixed(1) + '%';
  document.getElementById('progPct').textContent = (state.done.size === rows.length && rows.length ? 100 : Math.floor(pct)) + '%';
  document.getElementById('progTxt').textContent =
    `已拼 ${doneBeads.toLocaleString()} / ${total.toLocaleString()} 颗 · 打卡 ${state.done.size} / ${rows.length} 色`;
  // 总勾选框三态：一个没打 → 空；打了一部分 → −；全打 → ✓，文案变「全不选」
  const nDone = rows.filter(([code]) => state.done.has(code)).length, all = rows.length > 0 && nDone === rows.length;
  const box = document.getElementById('crowAll');
  box.classList.toggle('all', all); box.classList.toggle('some', nDone > 0 && !all);
  box.textContent = all ? '✓' : nDone ? '−' : '';
  box.setAttribute('aria-label', all ? '全不选' : '全选');
  document.getElementById('crowAllTxt').textContent = all ? '全不选' : '全选';
}
/* 总勾选框：没全打时点 = 全部打勾；全打了再点 = 全部取消（成熟三态复选框的做法，部分选中时先补齐为全选） */
document.querySelector('.crow-all').onclick = () => {
  const codes = Object.keys(D.specs[state.size].counts), all = codes.every(c => state.done.has(c));
  if (all) codes.forEach(c => state.done.delete(c)); else codes.forEach(c => state.done.add(c));
  saveProgress(); renderColors(); renderHlStatus(); draw();
  toast(all ? '已全部取消打勾' : `已全部打勾 · 共 ${codes.length} 色`);
};
/* 用法提示：关掉后本机记住，不再出现 */
(() => {
  const tip = document.getElementById('crowTip'), K = 'perler-tracker-tip-closed';
  try { if (localStorage.getItem(K) === '1') tip.classList.add('closed'); } catch (e) {}
  document.getElementById('crowTipX').onclick = () => { tip.classList.add('closed'); try { localStorage.setItem(K, '1'); } catch (e) {} };
})();
document.getElementById('progReset').onclick = () => {
  state.done.clear(); state.highlight = null;
  saveProgress(); renderColors(); renderHlStatus(); draw();
  toast('拼豆记录已清空');
};

function renderHlStatus() {
  const el = document.getElementById('hlStatus');
  if (state.highlight) {
    const c = colorMap[state.highlight];
    el.innerHTML = `◉ 正在下豆：${c.code} · ${D.specs[state.size].counts[state.highlight]} 颗 ✕`;
    el.classList.add('show');
    el.onclick = () => setCurrent(state.highlight);
  } else el.classList.remove('show');
  window.dispatchEvent(new Event('resize')); // 提示条显隐会改变顶栏高度，画布按新高度重排标尺与图纸
}

function renderSourceCards() {
  const el = document.getElementById('sourceCards');
  const sources = D.images && D.images.length ? D.images : [];
  el.classList.toggle('multi', sources.length > 1);
  el.innerHTML = sources.map((src, i) => `
    <div class="frame"><img src="${src}" alt="原图${sources.length > 1 ? ' ' + (i + 1) : ''}"></div>
    <div class="cap">原图${sources.length > 1 ? ' ' + (i + 1) : ''}</div>`).join('');
}
renderSourceCards();

function refreshAll() {
  renderBudget(); renderSizes(); renderPalettes(); renderColors(); renderHlStatus();
  islandRender(); // [ISLANDS hook] 附属岛区块（无岛自动隐藏）
  verDecorate(); // [VERSIONS hook] 侧栏红点 + 版本按钮
  draw();
}

