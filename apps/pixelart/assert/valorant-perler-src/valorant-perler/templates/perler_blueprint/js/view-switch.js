/* ================= 视图切换 ================= */
document.querySelectorAll('.viewtab[data-view]').forEach(t => t.onclick = () => {
  ironExit(); // [IRON hook] 切到原图/转换图自动退出烫豆预览
  state.view = t.dataset.view;
  document.querySelectorAll('.viewtab[data-view]').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.canvas-wrap').forEach(v => v.classList.toggle('active', v.id === 'view-' + state.view));
  document.getElementById('modeSeg').classList.toggle('show', state.view === 'grid');
  document.getElementById('ironBtn').classList.toggle('show', state.view === 'grid'); // [IRON hook] 烫豆按钮跟着图纸看法显隐
  document.body.classList.toggle('mode3d', state.view === 'grid' && state.mode === '3d');
  if (state.view !== 'grid') { if (V3) V3.leave(); return; }
  if (state.mode === '3d') { V3.enter(); return; } // [VIEW-3D hook]
  resizeCanvas(); if (!state.scale) fitView(); else draw();
});
document.getElementById('mirrorBtn').onclick = e => {
  state.mirror = !state.mirror;
  e.currentTarget.classList.toggle('on', state.mirror);
  draw();
  toast(state.mirror ? '已镜像' : '已取消镜像');
};

/* [EXPORT] 转换图导出：图纸页内联的转换图 PNG 原样存盘（格式不变，供对比 / 二次加工） */
document.getElementById('pixelDl').onclick = async () => {
  const img = document.querySelector('#view-pixel .frame img');
  if (!img || !img.src) { toast('没有可导出的转换图', 4000, true); return; }
  try {
    const blob = await (await fetch(img.src)).blob();   // data URI → Blob，走对象 URL 下载（data: 直下会被部分浏览器拦）
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.title.replace(/[\\/:*?"<>|]/g, '')}_转换图.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('转换图已保存');
  } catch (e) { toast('导出失败，可长按图片直接保存', 4000, true); }
};

/* 无原图（文生图）：不出现「原图」页签，「转换图」成为第一个页签并做成平直矩形（样式见 css/stage.css 的 body.no-source） */
if (!(D.images && D.images.length)) {
  document.body.classList.add('no-source');
  const srcTab = document.querySelector('.viewtab[data-view="source"]');
  if (srcTab) srcTab.remove();
  if (state.view === 'source') document.querySelector('.viewtab[data-view="pixel"]').click();
}

