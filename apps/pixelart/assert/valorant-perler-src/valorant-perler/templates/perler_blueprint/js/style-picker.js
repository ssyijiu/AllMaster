/* ================= [STYLE-PICKER] 规格页人像模板选择条 ================= */
/* 数据：assets/style_guide.json（构建期内联为 STYLE_GUIDE_JSON）。
   交互：点模板卡弹出大图层（效果图居中，左侧小图是原图）→ 点「复制提示词」把该模板的话术复制到剪贴板 → 玩家回 WorkBuddy 对话粘贴发送。
   人像选择器控制模板可见性；切换分类只调整入口，重做仍走对话。
   只复制不改图：风格转换仍走对话链路，本区是引导入口，不属于编辑流程。 */
const STYLE_GUIDE = Object.assign({ hint: '', styles: [] }, window.STYLE_GUIDE_JSON || {});
const styleViewer = document.getElementById('styleViewer');
const styleViewerImg = document.getElementById('styleViewerImg');
const styleViewerEffectImg = document.getElementById('styleViewerEffectImg');
const styleViewerCap = document.getElementById('styleViewerCap');
const spEffectTag = document.getElementById('spEffectTag');
const styleCopyBtn = document.getElementById('styleCopyBtn');
let styleViewing = null;
const portraitSelect = document.getElementById('portraitSelect');
let portraitSubject = ['character', 'character-prop'].includes(D.subject) ? 'character' : 'prop';

/* 大图层：效果图居中放大，左侧小图是同一张捷风原图，箭头从原图指向效果；说明只写模板名。
   本图按该预设画风生成时（D.artStyle）效果图带「本图」标。Esc 或点空白关闭 */
function openStyleViewer(item) {
  styleViewing = item;
  styleViewerImg.src = STYLE_GUIDE.officialThumb || '';
  styleViewerEffectImg.src = item.thumb;
  styleViewerCap.textContent = `${item.label}模板`;
  spEffectTag.style.display = item.id === D.artStyle ? '' : 'none';
  styleViewer.classList.add('show');
}
function closeStyleViewer() {
  styleViewer.classList.remove('show');
  styleViewing = null;
  styleViewerImg.src = '';
  styleViewerEffectImg.src = '';
}
styleViewer.addEventListener('click', e => { if (e.target === styleViewer) closeStyleViewer(); });
document.getElementById('styleViewerClose').onclick = closeStyleViewer;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && styleViewer.classList.contains('show')) closeStyleViewer(); });

/* 复制提示词：clipboard API 优先（file:// 下不可用时退回 execCommand），成功后 toast 指路 */
async function copyStyleMsg(msg) {
  let ok = false;
  try { await navigator.clipboard.writeText(msg); ok = true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = msg; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  toast(ok ? '已复制，回到对话框粘贴发送' : '复制失败，长按话术文本手动复制');
}

/* 模板区渲染：模板卡横向一排可滑动。
   每张卡都是同一张捷风原图按该画风的效果演示，与本图无关；本图按预设画风生成时（D.artStyle），对应卡标「本图」 */
function renderStyles() {
  document.getElementById('styleSec').hidden = portraitSubject === 'prop';
  document.getElementById('portraitTemplates').hidden = portraitSubject === 'prop';
  const el = document.getElementById('styleStrip');
  document.getElementById('styleHint').textContent = STYLE_GUIDE.hint;
  el.innerHTML = STYLE_GUIDE.styles.map(s => `
      <div class="style-card${s.id === D.artStyle ? ' cur' : ''}" data-sid="${s.id}">
        <img src="${s.thumb}" alt="${s.label}模板预览">
        <div class="nm">${s.label}</div>${s.id === D.artStyle ? '<span class="tag">本图</span>' : ''}
      </div>`).join('');
  el.querySelectorAll('.style-card[data-sid]').forEach(card => {
    const s = STYLE_GUIDE.styles.find(x => x.id === card.dataset.sid);
    card.onclick = () => openStyleViewer(s);
  });
  styleCopyBtn.onclick = () => { if (styleViewing) copyStyleMsg(styleViewing.msg); };
}
/* 顶栏副标题注明本图画风（只标预设画风；自定义画风、修改过的图不标） */
function renderArtStyleMark() {
  const s = portraitSubject === 'prop' ? null : STYLE_GUIDE.styles.find(x => x.id === D.artStyle);
  const el = document.getElementById('artStyleMark');
  if (el) { el.textContent = s ? ` · ${s.label}模板` : ''; }
}
portraitSelect.value = portraitSubject;
portraitSelect.onchange = () => {
  portraitSubject = portraitSelect.value;
  closeStyleViewer();
  renderStyles();
  renderArtStyleMark();
};
renderStyles();
renderArtStyleMark();
