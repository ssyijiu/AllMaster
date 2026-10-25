
/* 点击换色（区分拖拽：位移 <5px 才算点击；双击留给适配视图） */
function cellAt(e) {
  if (state.mode === '3d') return V3.cell(e); // [VIEW-3D hook] 3D 看法：射线打到豆顶平面换算格位
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const vi = Math.floor((mx - state.ox) / state.scale), vj = Math.floor((my - state.oy) / state.scale);
  if (vi < 0 || vj < 0 || vi >= GW || vj >= GH) return null;
  return [state.mirror ? GW - 1 - vi : vi, vj];
}
canvas.addEventListener('click', e => edBrowseClick(e)); // [EDIT-MODE hook] 浏览态点击：放大时单击编辑，缩小时提示长按
canvas.addEventListener('mousemove', e => {
  if (ed.on) { if (!drag) edHover(e); return; } // [EDIT-MODE hook] 编辑态悬停预览
  edBrowseHover(e);                               // [EDIT-MODE hook] 浏览态：可单击的格子描边 + 提示
});

document.getElementById('zoomIn').onclick = () => zoomBtn(1.3);
document.getElementById('zoomOut').onclick = () => zoomBtn(1 / 1.3);
document.getElementById('zoomFit').onclick = fitView;
function zoomBtn(f) {
  const cx = canvas.width / dpr / 2, cy = canvas.height / dpr / 2;
  zoomAt(cx, cy, f); // [VIEW-SMOOTH] 与滚轮共用缩放、限位与合帧
}
window.addEventListener('resize', () => { if (state.view !== 'grid') return; if (state.mode === '3d') V3.resize(); else resizeCanvas(); requestView(); });
/* 外框尺寸变了但窗口没发 resize（App 内置浏览器的工具栏、字体、提示条晚到）：画布按外框重量尺寸，
 * 否则画布比外框高、被居中裁掉上下各一截，顶部标尺只剩半行。适配态重新适配，已缩放平移的保持视图 */
new ResizeObserver(() => {
  const p = canvas.parentElement;
  if (state.view !== 'grid' || state.mode !== '2d' || !state.scale) return;
  if (Math.round(p.clientWidth * dpr) === canvas.width && Math.round(p.clientHeight * dpr) === canvas.height) return;
  if (isFitView()) fitView(); else { resizeCanvas(); clampView(); requestView(); }
}).observe(canvas.parentElement);

