/* =====================================================================
 * [STORAGE] 本地存储兜底
 * 图纸的改动、版本、进度都记在 localStorage。部分内嵌浏览器（应用内预览面板、沙箱 iframe、隐私模式）
 * 里 localStorage 访问即报错、为 null 或写不进去，各模块的 try/catch 会把错误吞掉，表现为「点保存没有 v1」。
 * 这里在所有模块之前试写一次：能用就什么都不做；不能用就把 window.localStorage 换成一份内存存储，
 * 页面开着期间版本、撤销、进度照常可用；关掉页面后靠「保存」另存的新图纸文件把存档带走（[SAVE-FILE]）。
 * 内存存储的条目是对象自身属性，Object.keys(localStorage) 与 key(i) / length 的遍历写法都照常工作。
 * ===================================================================== */
(() => {
  try {
    const s = window.localStorage, k = '__perler_probe__';
    s.setItem(k, '1'); s.removeItem(k);
    return;
  } catch (e) {}
  function MemStorage() {}
  Object.defineProperties(MemStorage.prototype, {
    getItem: { value(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; } },
    setItem: { value(k, v) { this[String(k)] = String(v); } },
    removeItem: { value(k) { delete this[k]; } },
    clear: { value() { Object.keys(this).forEach(k => delete this[k]); } },
    key: { value(i) { const ks = Object.keys(this); return i < ks.length ? ks[i] : null; } },
    length: { get() { return Object.keys(this).length; } },
  });
  try { Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemStorage() }); } catch (e) {}
})();
