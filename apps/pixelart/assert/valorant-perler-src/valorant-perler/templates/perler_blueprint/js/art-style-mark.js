/* ================= [ART-STYLE-MARK] 顶栏副标题的画风标记 ================= */
/* 原来这里还有一条「模板重做」的画风选择条（js/style-picker.js）：展示五个画风的示意大图、
   点「复制提示词」回对话重做。2026-11-06 按产品决定整条删掉 —— 它只是引导入口，不参与生成，
   而且为了那 5 张示意大图，每份图纸都要多内联 130KB（jpeg 压不动）。删掉后只留顶栏这一处标记。
   画风名由服务端下发时注入（window.PIXELART_STYLE = style_guide 的 label，如「Q版」）；
   本地直接打开静态文件、自定义画风、改过的图都没有这个值，标记留空。 */
(() => {
  const el = document.getElementById('artStyleMark');
  if (!el) return;
  const label = String(window.PIXELART_STYLE || '').trim();
  const subject = String((window.DEMO_DATA || {}).subject || '');
  const isProp = !!subject && subject !== 'character' && subject !== 'character-prop';
  el.textContent = (label && !isProp) ? ` · ${label}模板` : '';
})();
