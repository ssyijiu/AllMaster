/* ===== [TITLE] 作品标题：顶栏点铅笔原地改名 =====
 * 改名只改「显示 / 导出用」的标题（state.title，存本机），不改 TASK_KEY——图纸改动、版本、拼豆进度都按 TASK_KEY 存，
 * 改名后这些都还在。导出文件名、导出图里的标题、页面 <title> 读 state.title。
 * 交互：点铅笔 → 标题变输入框并全选；Enter / 失焦 = 保存，Esc = 取消；清空 = 恢复原名。 */
const TITLE_KEY = `perler-title-${TASK_KEY}`;
const TITLE_SFX = ' · 交互拼豆图纸';
function titleGet() { try { return localStorage.getItem(TITLE_KEY) || D.taskName; } catch (e) { return D.taskName; } }
function titleFile() { return state.title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-'); }
function titleApply() {
  document.getElementById('taskTitle').textContent = state.title;
  document.title = state.title + TITLE_SFX;
}
state.title = titleGet();
titleApply();
document.getElementById('titleEdit').onclick = () => {
  const span = document.getElementById('taskTitle');
  if (document.getElementById('taskTitleIn')) return;
  const inp = document.createElement('input');
  inp.id = 'taskTitleIn'; inp.value = state.title; inp.maxLength = 40; inp.setAttribute('aria-label', '作品标题');
  span.replaceWith(inp);
  document.querySelector('.title-sfx').style.display = 'none';
  inp.focus(); inp.select();
  let done = false;
  const finish = save => {
    if (done) return; done = true;
    if (save) {
      const v = inp.value.trim().replace(/\s+/g, ' ');
      state.title = v || D.taskName;
      try { v && v !== D.taskName ? localStorage.setItem(TITLE_KEY, state.title) : localStorage.removeItem(TITLE_KEY); } catch (e) {}
    }
    inp.replaceWith(span);
    document.querySelector('.title-sfx').style.display = '';
    titleApply();
    if (save) toast('标题已更新');
  };
  inp.addEventListener('keydown', e => {
    e.stopPropagation(); // 输入时不触发编辑快捷键
    if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
};
/* ===== [TITLE] END ===== */
