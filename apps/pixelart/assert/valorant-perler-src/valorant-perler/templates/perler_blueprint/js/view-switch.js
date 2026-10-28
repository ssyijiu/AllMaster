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

/* [EXPORT] 转换图导出：图纸页内联的转换图 PNG 原样存盘（格式不变，供对比 / 二次加工）。
 * 沙箱预览（WorkBuddy 产物区 srcdoc）会静默拦掉页面发起的下载，与导出海报同一处理：引导去外部浏览器；手机 WorkBuddy 浏览器则引导长按保存 */
const pixelDlBtn = document.getElementById('pixelDl');
if (NO_DOWNLOAD) {
  pixelDlBtn.onclick = () => toast(PC_SANDBOX
    ? '导出需要用默认浏览器打开：点右上角「···」→「在外部浏览器打开」，进去后再点「⤓ 导出」'
    : '长按转换图图片，可直接保存到相册', 8000, true);
} else {
  /* 全同步：data URI → atob → Blob → a.click()。不能用 fetch/await——Safari 在异步之后
   * 用户手势（transient activation）已失效，a.click() 的下载会被静默拦掉（控制台也不报错） */
  pixelDlBtn.onclick = () => {
    const img = document.querySelector('#view-pixel .frame img');
    if (!img || !img.src) { toast('没有可导出的转换图', 4000, true); return; }
    try {
      const parts = img.src.split(',');
      const mime = (parts[0].match(/data:([^;]+)/) || [0, 'image/png'])[1];
      const bin = atob(parts[1]);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([u8], { type: mime }));
      a.download = `${state.title.replace(/[\\/:*?"<>|]/g, '')}_转换图.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('转换图已保存');
    } catch (e) { toast('导出失败，可长按图片直接保存', 4000, true); }
  };
};

/* 无原图（文生图）：不出现「原图」页签，「转换图」成为第一个页签并做成平直矩形（样式见 css/stage.css 的 body.no-source） */
if (!(D.images && D.images.length)) {
  document.body.classList.add('no-source');
  const srcTab = document.querySelector('.viewtab[data-view="source"]');
  if (srcTab) srcTab.remove();
  if (state.view === 'source') document.querySelector('.viewtab[data-view="pixel"]').click();
}

