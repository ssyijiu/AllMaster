/* 验证 handleTaskHtml 下发结果：注入（含画风/备注）+ 四代图纸补丁 → 文件名表达式求值
 * 命名规则：A_<标题>_<画风>_<备注>_<ID>_<规格>_<色数>色.png / A_转换图_<画风>_<备注>_<ID>.png */
const fs = require('fs'), path = require('path'), vm = require('vm');

const REPO = require('path').resolve(__dirname, '../../..');
const GEN = path.join(REPO, 'apps/pixelart/generate.js');
const src = fs.readFileSync(GEN, 'utf8');
const start = src.indexOf('function handleTaskHtml');
const end = src.indexOf('/* POST /regen');
if (start < 0 || end < 0) { console.log('FAIL 提取 handleTaskHtml 失败'); process.exit(1); }
const fnSrc = src.slice(src.lastIndexOf('\n', start) + 1, end);
/* 依赖的两个模块级函数从源码里抽（保持被测代码与线上一致） */
const segStart = src.indexOf('function segOf');
const segSrc = src.slice(src.lastIndexOf('\n', segStart) + 1, src.indexOf('\n}', src.indexOf('return [clean')) + 2);

function mockRes() {
  return { headers: null, body: null,
    writeHead(code, h) { this.code = code; this.headers = h; },
    end(b) { this.body = b; } };
}
const sendJson = (res, code, obj) => { res.code = code; res.json = obj; };

const STYLE_LABEL = 'Q版';
const NOTE = '嘴巴稍微改小一些，换成微笑';

function serve(htmlFile, backend, id, notes) {
  const t = { status: 'done', htmlPath: htmlFile, styleId: 'chibi', notes: notes === undefined ? NOTE : notes };
  const sandbox = { fs, path, Buffer, console, backend, STYLE_LABEL,
    findStyle: (sid) => (sandbox.STYLE_LABEL && { label: sandbox.STYLE_LABEL } || null),
    resolveTask: (x) => (x === id ? t : null), sendJson, URL };
  vm.createContext(sandbox);
  vm.runInContext(segSrc + '\n' + fnSrc + '\nthis.__h = handleTaskHtml;', sandbox);
  const req = { on: (ev, cb) => {} };
  const res = mockRes();
  sandbox.__h(req, res, new URL('http://x/api/pixelart/task/html?id=' + id), sendJson);
  return res;
}

const head = '<!DOCTYPE html><html><head><title>t</title></head><body>';
const F = require('os').tmpdir() + '/pixelart-naming-test';
fs.rmSync(F, { recursive: true, force: true }); fs.mkdirSync(F, { recursive: true });

/* gen4（本代新模板：自带 SEG 插槽）——直接取真实模板代码片段，防止测试与线上脱节 */
const realPoster = fs.readFileSync(path.join(REPO, 'apps/pixelart/assert/valorant-perler-src/valorant-perler/templates/perler_blueprint/js/poster.js'), 'utf8');
const realSwitch = fs.readFileSync(path.join(REPO, 'apps/pixelart/assert/valorant-perler-src/valorant-perler/templates/perler_blueprint/js/view-switch.js'), 'utf8');
const posterBlock = realPoster.match(/const TASK_ID = [\s\S]*?const fileName = [^\n]+/)[0];
const switchBlock = realSwitch.match(/const BE_TAG = [\s\S]*?a\.download = [^\n]+/)[0];
const gen4 = head + '<script>\n' + posterBlock + '\n' + switchBlock + '\n</script></body></html>';

/* gen3 上一代：无 SEG 插槽（应被下发补丁补上画风/备注） */
const gen3 = head + '<script>\n' + [
  "const TASK_ID = (window.PIXELART_TASK_ID || '').toString().trim();",
  "const BACKEND_TAG = (window.PIXELART_BACKEND || '').toString().trim();",
  "const fileName = (ext = 'png') => `${BACKEND_TAG ? BACKEND_TAG + '_' : ''}${state.title.replace(/[\\\\/:*?\"<>|]/g, '')}${TASK_ID ? '_' + TASK_ID : ''}_${PGW}x${PGH}_${PT.colors}色.${ext}`;",
].join('\n') + '\nconst BE_TAG = (window.PIXELART_BACKEND || \'\').toString().trim();\n' +
 "const TASK_TAG = (window.PIXELART_TASK_ID || '').toString().trim();\n" +
 "a.download = `${BE_TAG ? BE_TAG + '_' : ''}转换图${TASK_TAG ? '_' + TASK_TAG : ''}.png`;\n</script></body></html>";

/* gen2 带 const TASK_ID 一代：旧 fileName 无前缀 + 旧转换图名 */
const gen2 = head + '<script>\n' + [
  "const TASK_ID = (window.PIXELART_TASK_ID || '').toString().trim();",
  "const fileName = (ext = 'png') => `${state.title.replace(/[\\\\/:*?\"<>|]/g, '')}${TASK_ID ? '_' + TASK_ID : ''}_${PGW}x${PGH}_${PT.colors}色.${ext}`;",
  "a.download = `${state.title.replace(/[\\\\/:*?\"<>|]/g, '')}_转换图.png`;",
].join('\n') + '\n</script></body></html>';

/* gen1 更早一代：无任务 ID 插槽 */
const gen1 = head + '<script>\n' +
  "const fileName = (ext = 'png') => `${state.title.replace(/[\\\\/:*?\"<>|]/g, '')}_${PGW}x${PGH}_${PT.colors}色.${ext}`;\n</script></body></html>";

for (const [n, s] of [['gen4', gen4], ['gen3', gen3], ['gen2', gen2], ['gen1', gen1]]) fs.writeFileSync(path.join(F, n + '.html'), s);

/* 求值注入后 HTML 里的 fileName 与转换图 download */
function evalNames(html, backend, id) {
  const w = { PIXELART_TASK_ID: id, PIXELART_BACKEND: backend, PIXELART_SEG: '_' + STYLE_LABEL + '_' + NOTE };
  /* 注入的 SEG 从页面里取真值，确保与线上注入一致 */
  const segM = html.match(/window\.PIXELART_SEG="([^"]*)"/);
  if (segM) w.PIXELART_SEG = segM[1];
  const state = { title: '拼豆图纸' }, PGW = 104, PGH = 104, PT = { colors: 17 }, a = {};
  const pre = 'const TASK_ID = (window.PIXELART_TASK_ID || "").toString().trim();'
    + 'const BACKEND_TAG = (window.PIXELART_BACKEND || "").toString().trim();'
    + 'const SEG_TAG = (window.PIXELART_SEG || "").toString();';
  let posterName = null, pixelName = null;
  const mp = html.match(/const fileName = [^\n]+/);
  if (mp) posterName = vm.runInNewContext(pre + mp[0] + '; fileName("png")', { window: w, state, PGW, PGH, PT });
  const mx = html.match(/a\.download = [^\n]+/);
  if (mx) {
    const pre2 = pre
      + 'const BE_TAG = (window.PIXELART_BACKEND || "").toString().trim();'
      + 'const TASK_TAG = (window.PIXELART_TASK_ID || "").toString().trim();';
    const ctx = { window: w, a: {}, state, PGW, PGH, PT };
    vm.runInNewContext(pre2 + mx[0], ctx);
    pixelName = ctx.a.download;
  }
  return { posterName, pixelName };
}

const SEG = '_' + STYLE_LABEL + '_' + NOTE;
const results = [];
for (const gen of ['gen4', 'gen3', 'gen2', 'gen1']) {
  for (const [bk, want] of [['valperler', 'A'], ['apinebula', 'B']]) {
    const html = serve(path.join(F, gen + '.html'), bk, '9236f85966554a01').body.toString('utf8');
    const injected = html.includes('window.PIXELART_TASK_ID="9236f85966554a01"')
      && html.includes('window.PIXELART_BACKEND="' + want + '"')
      && html.includes('window.PIXELART_STYLE="' + STYLE_LABEL + '"')
      && html.includes('window.PIXELART_NOTE="' + NOTE + '"')
      && html.includes('window.PIXELART_SEG="' + SEG + '"');
    const { posterName, pixelName } = evalNames(html, want, '9236f85966554a01');
    const wantPoster = `${want}_拼豆图纸${SEG}_9236f85966554a01_104x104_17色.png`;
    const wantPixel = `${want}_转换图${SEG}_9236f85966554a01.png`;
    results.push([`${gen}/${bk} 注入(含画风备注)`, injected]);
    results.push([`${gen}/${bk} 图纸名=${posterName}`, posterName === wantPoster]);
    if (gen !== 'gen1') results.push([`${gen}/${bk} 转换图名=${pixelName}`, pixelName === wantPixel]);
  }
}
/* 无备注时不应出现空段 */
const noNote = serve(path.join(F, 'gen4.html'), 'apinebula', 'abc', '').body.toString('utf8');
const noNoteName = evalNames(noNote, 'B', 'abc').posterName;
results.push([`空备注不产生双下划线 =${noNoteName}`, noNoteName === 'B_拼豆图纸_Q版_abc_104x104_17色.png']);
/* 备注里的非法字符被清掉（/ : ? * " < > |） */
const dirty = serve(path.join(F, 'gen4.html'), 'apinebula', 'abc', '改小/嘴巴:换微笑?').body.toString('utf8');
const dirtySeg = (dirty.match(/window\.PIXELART_SEG="([^"]*)"/) || [])[1];
results.push([`非法字符已清理 seg=${dirtySeg}`, dirtySeg === '_Q版_改小嘴巴换微笑']);
/* 备注截断到 40 字 */
const longNote = '啊'.repeat(60);
const longSeg = (serve(path.join(F, 'gen4.html'), 'apinebula', 'abc', longNote).body.toString().match(/window\.PIXELART_SEG="([^"]*)"/) || [])[1];
results.push([`长备注截断 40 字（seg 长度 ${(longSeg || '').length}，应为 44 = _Q版 + _ + 40）`, (longSeg || '').length === 3 + 1 + 40]);
/* 备注含 </script> 不能提前闭合注入脚本 */
const xss = serve(path.join(F, 'gen4.html'), 'apinebula', 'abc', '坏</script><b>x').body.toString();
results.push(['备注 </script> 已转义', !/PIXELART_NOTE="[^"]*<\/script>/.test(xss)]);
/* 新模板不能被二次加前缀（防 A_A_） */
const g4 = serve(path.join(F, 'gen4.html'), 'valperler', 'x1').body.toString();
results.push(['gen4 无重复前缀', (g4.match(/BACKEND_TAG \? BACKEND_TAG/g) || []).length === 1]);

let pass = true;
for (const [n, v] of results) { console.log((v ? 'PASS' : 'FAIL') + '  ' + n); if (!v) pass = false; }
process.exit(pass ? 0 : 1);
