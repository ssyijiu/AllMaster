/* ================= 初始化 ================= */
parseGrid(); buildColorMap(); loadProgress(); refreshAll();
requestAnimationFrame(() => { fitView(); if (new URLSearchParams(location.search).get('mode') === '3d') setMode('3d'); });
