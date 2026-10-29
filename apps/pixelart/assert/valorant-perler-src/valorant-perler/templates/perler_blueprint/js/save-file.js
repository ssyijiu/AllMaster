/* =====================================================================
 * [SAVE-FILE] 存档随文件走 BEGIN
 * 编辑记录平时存在浏览器本地（localStorage），但企业微信等内置浏览器关掉页面就可能清空。
 * 所以点「保存」时，除了存本地，还把本任务的全部本地存档（图纸改动、版本、拼豆进度、标题、自定义规格）
 * 写进一份新的单文件 HTML 交给玩家（电脑直接下载，手机走系统分享 / 存到文件）。
 * 打开这份新文件时，页面先把文件里带的存档写回本地，再按存档渲染：手机关机、换浏览器、发给别人都还在。
 * 新旧判断：每份存档带保存时刻 savedAt；本地记下最近一次写入的时刻，文件里的更新才覆盖本地，
 * 所以打开一份旧文件不会冲掉本地更新的改动。
 * 页面副本取自脚本开始执行时的 DOM（此刻还没有任何脚本改过页面），只替换 #perlerSaved 里的存档。
 * 与其他模块的接点：edSave() → saveFileExport()；本文件须在读本地存档的模块（title / palette-resolve 等）之前载入。
 * ===================================================================== */
const SAVE_STAMP_KEY = `perler-saved-at-${TASK_KEY}`;
const PAGE_SRC = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;   // 未被脚本改动过的页面原样
const SAVED_TAG = /<script id="perlerSaved" type="application\/json">[\s\S]*?<\/script>/;

/* 本任务的本地存档键：perler-*-<任务名>[-…]；全局偏好（编辑栏位置、宽度等）不随文件走 */
function saveFileKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('perler-') && k !== SAVE_STAMP_KEY && (k.endsWith('-' + TASK_KEY) || k.includes('-' + TASK_KEY + '-'))) keys.push(k);
    }
  } catch (e) {}
  return keys;
}

/* 打开时：文件里的存档比本地新，就写回本地 */
(() => {
  let snap = null;
  try { snap = JSON.parse(document.getElementById('perlerSaved').textContent || 'null'); } catch (e) {}
  if (!snap || !snap.savedAt || !snap.items) return;
  try {
    if (Number(localStorage.getItem(SAVE_STAMP_KEY) || 0) >= snap.savedAt) return;
    for (const k of saveFileKeys()) if (!(k in snap.items)) localStorage.removeItem(k);   // 以文件为准：文件里没有的旧存档清掉
    for (const [k, v] of Object.entries(snap.items)) localStorage.setItem(k, v);
    localStorage.setItem(SAVE_STAMP_KEY, String(snap.savedAt));
  } catch (e) {}
})();

/* 文件名：【点豆】标题-v版本号-保存时刻.html；版本号取当前规格 × 色板 × 色数下最新的版本（与「已保存 · vN」一致） */
function saveFileName() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getMonth() + 1}月${d.getDate()}日_${d.getHours()}点${d.getMinutes()}分${d.getSeconds()}秒`;
  const name = (state.title || D.taskName).replace(/[\\/:*?"<>|]/g, '').trim() || '拼豆图纸';
  const vl = verList(), ver = vl.length ? `-v${vl[vl.length - 1].n}` : '';
  return `【点豆】${name}${ver}-${stamp}.html`;
}

/* 页面被嵌在 srcdoc 沙盒里（如 WorkBuddy 产物区）时，页面发起的下载、另存为窗口都会被静默拦掉；
 * 这时不发下载：点导出直接提示用默认浏览器打开，保存只存页面内的版本。普通浏览器（含本地 file://）不受影响。 */
const NO_DOWNLOAD = location.protocol === 'about:';
/* 「在外部浏览器打开」只有电脑端产物区有；手机端只有 WorkBuddy 自带浏览器，不给这条引导 */
const PC_SANDBOX = NO_DOWNLOAD && !matchMedia('(pointer:coarse)').matches;

/* 点「保存」后调用：把当前本地存档写进一份新 HTML 交给玩家 */
async function saveFileExport() {
  const savedAt = Date.now(), items = {};
  try {
    for (const k of saveFileKeys()) items[k] = localStorage.getItem(k);
    localStorage.setItem(SAVE_STAMP_KEY, String(savedAt));
  } catch (e) {}
  const json = JSON.stringify({ savedAt, items }).replace(/</g, '\\u003c');   // 防止存档内容提前闭合 <script>
  const html = PAGE_SRC.replace(SAVED_TAG, () => `<script id="perlerSaved" type="application/json">${json}<\/script>`);
  const name = saveFileName(), file = new File([html], name, { type: 'text/html' });
  if (isCoarse()) {
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return 'shared'; }
    } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
  }
  if (NO_DOWNLOAD) return 'blocked';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'download';
}
/* [SAVE-FILE] 存档随文件走 END ======================================================= */
