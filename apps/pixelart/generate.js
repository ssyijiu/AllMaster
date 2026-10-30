/* 拼豆大师：生成链路（产品层模块，server.js 挂载路由）
 *
 * 流程：POST /api/pixelart/generate（上传图 + 画风 + 备注）
 *   → 落盘工作目录 → 组装提示词四槽位（LLM 优先，未配置时模板兜底）
 *   → 后台 spawn val_perler.py generate（生图 → 切格 → 单文件图纸 HTML）
 *   → 立即返回 taskId；GET /api/pixelart/task?id= 轮询；完成后 GET /api/pixelart/task/html?id= 取图纸
 *
 * 多实例（双后端并存，2026-10-28）：createEngine({ backend, taskRoot }) 每个实例有独立任务表与任务目录，
 *   - backend 'apinebula'（默认）：生图走 OpenAI Images 兼容 API（主页 / 用）
 *   - backend 'valperler'：生图走 val-perler.qq.com 经典后端（/pixelart 经典版用），
 *     spawn 时 PERLER_IMAGE_SCRIPT=image_render_vp.py 选用旧生图客户端、
 *     PERLER_BLOCK_CLEANUP=0 保留经典后端原始输出（不洗色块）、ACC_USER_ID 走活动池额度
 *
 * 配置读服务器本地 .pixelart-config.json：
 *   accUserId  经典版（valperler）后端的生图服务 WB ID（spawn 时注入 ACC_USER_ID）
 *   pythonExe  解释器路径（不存在回落 python3；自建服务器指向 venv：/opt/allmaster/.venv/bin/python）
 *   promptLLM  { baseUrl, model, apiKey?, providerId?, imageModel? } —— chat 写提示词槽位；
 *              baseUrl/apiKey 同时作为 apinebula 生图后端（OpenAI Images 兼容）凭据注入环境变量；null/缺 Key = 模板兜底 + 生图失败
 *   imageModel 生图模型（可选，默认 gpt-image-2.5）
 * 任务工作目录：各实例 taskRoot 下 <taskId>/（主实例默认 $ROOT/.pixelart-tasks，可用环境变量 PIXELART_TASK_ROOT 覆盖），72h 后自动清理
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, '.pixelart-config.json');
const AI_CONFIG_FILE = path.join(ROOT, '.ai-config.json');
const PERLER_DIR = path.join(ROOT, 'apps/pixelart/assert/valorant-perler-src/valorant-perler');
const PERLER_SCRIPTS = path.join(PERLER_DIR, 'scripts');
const STYLE_GUIDE_JSON = path.join(PERLER_DIR, 'assets', 'style_guide.json');
/* 任务目录：不用 os.tmpdir() —— 自建服务器 systemd 开了 PrivateTmp=true（排查时找不到文件），
   且 /tmp 可能被定期清理导致图纸丢失。默认落仓库根 /opt/allmaster/.pixelart-tasks（属主 allmaster 可写），
   可用环境变量 PIXELART_TASK_ROOT 覆盖。 */
const DEFAULT_TASK_ROOT = process.env.PIXELART_TASK_ROOT || path.join(ROOT, '.pixelart-tasks');
/* 色块规整诊断采样：任务目录 72h 后会被 GC，而光晕/背景兜底这类偶发触发要靠真数据攒样本，
   所以触发时把「规整前底稿」额外存到这两个长期位置（不受任务清理影响，可用环境变量改路径）：
   .pixelart-samples/           触发样本：*_raw.png / *_cleaned.png / *.json（同名的诊断）
   .pixelart-cleanup-trace.jsonl 每行一次规整的摘要，用来统计「光晕触发率 / 近候选分布」 */
const SAMPLE_DIR = process.env.PIXELART_SAMPLE_DIR || path.join(ROOT, '.pixelart-samples');
const TRACE_LOG = process.env.PIXELART_CLEANUP_TRACE || path.join(ROOT, '.pixelart-cleanup-trace.jsonl');
try { fs.mkdirSync(SAMPLE_DIR, { recursive: true }); } catch (_) {}
const GEN_TIMEOUT_MS = 8 * 60 * 1000;   // 生图+切格上限（实测约 1 分钟）
const TASK_TTL_MS = 2 * 60 * 60 * 1000; // 渲染服务只保留 2 小时，任务记录同步过期
/* 磁盘任务目录保留时长：过期后 pruneTasks 连盘一起删（tmpdir 时代由系统清理兜底，落仓库后必须自己 GC，
   否则每单 5~10MB 图纸会慢慢吃满 40G 盘）。已完成图纸的分享链接在此窗口内仍可访问。 */
const TASK_DISK_TTL_MS = (parseInt(process.env.PIXELART_TASK_RETENTION_HOURS, 10) || 72) * 60 * 60 * 1000;

/* ---------- 作品归档（P2：让「我的作品」里的图纸长期可打开） ----------
 * 任务目录 72h 就 GC，而用户在「我的作品」里点的图纸必须一直能打开，所以生成成功后
 * 把图纸压一份到长期归档：.pixelart-archive/<taskId>/
 *   drawing.html.gz  图纸 HTML（gzip：实测 4.5MB → 2.3MB）
 *   cover.jpg        封面（转换图缩到 640px，约 50KB，给 /my 卡片用）
 *   meta.json        元数据（画风/主体/备注/时间），重启后靠它恢复任务上下文
 * 容量策略：云端只存 <1KB 的作品行 JSON，大文件全部留服务器；归档总量上限默认 2GB
 *   （≈800 张图纸），超限按 mtime 删最旧的整目录——云端作品行还在，卡片仍显示，
 *   只是点开提示「图纸已归档清理」。磁盘剩余不足 2GB 时直接停止归档，不冒险写满。 */
const DEFAULT_ARCHIVE_ROOT = process.env.PIXELART_ARCHIVE_ROOT || path.join(ROOT, '.pixelart-archive');
const ARCHIVE_MAX_BYTES = (parseFloat(process.env.PIXELART_ARCHIVE_MAX_GB) || 2) * 1024 * 1024 * 1024;
const ARCHIVE_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const ARCHIVE_COVER_PX = 640;
/* 归档保留期（与产品保留策略一致：每产品最近 30 张 / 90 天）。
   云端作品行由 /my 按同一规则物理清理，服务器归档在这里按目录 mtime 兜底。 */
const ARCHIVE_TTL_DAYS = (parseFloat(process.env.PIXELART_ARCHIVE_TTL_DAYS) || 90);

function dirSize(dir) {
  let total = 0;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    try {
      if (it.isDirectory()) { total += dirSize(p); }
      else { total += fs.statSync(p).size; }
    } catch (_) { /* 单个文件消失不影响整体统计 */ }
  }
  return total;
}

/* 归档 GC：
 * 1) 超保留期（默认 90 天）的整目录直接删——与产品保留策略对齐，避免归档无限长大
 * 2) 总量超上限时按目录 mtime 从旧到新删到 80% 水位
 */
function pruneArchive(archiveRoot) {
  let names = [];
  try { names = fs.readdirSync(archiveRoot).filter((n) => /^[0-9a-f]{16}$/.test(n)); } catch (_) { return; }
  if (!names.length) { return; }
  const entries = [];
  let total = 0;
  for (const name of names) {
    const dir = path.join(archiveRoot, name);
    const size = dirSize(dir);
    total += size;
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs; } catch (_) {}
    entries.push({ name, dir, size, mtime });
  }
  const ttlMs = ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const e of entries) {
    if (!e.mtime || now - e.mtime <= ttlMs) { continue; }
    try { fs.rmSync(e.dir, { recursive: true, force: true }); total -= e.size; e.removed = true; } catch (_) {}
  }
  if (total <= ARCHIVE_MAX_BYTES) { return; }
  const target = ARCHIVE_MAX_BYTES * 0.8;
  for (const e of entries) {
    if (total <= target) { break; }
    if (e.removed) { continue; }
    try { fs.rmSync(e.dir, { recursive: true, force: true }); total -= e.size; } catch (_) {}
  }
}

function freeBytes() {
  try {
    const st = fs.statfsSync(ROOT);
    return Number(st.bavail) * Number(st.bsize);
  } catch (_) { return Infinity; }
}

function readArchivedMeta(archiveRoot, taskId) {
  try {
    const raw = fs.readFileSync(path.join(archiveRoot, taskId, 'meta.json'), 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (_) { return null; }
}

function readArchivedHtml(archiveRoot, taskId) {
  try {
    return zlib.gunzipSync(fs.readFileSync(path.join(archiveRoot, taskId, 'drawing.html.gz'))).toString('utf8');
  } catch (_) { return null; }
}


function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; } }
function readAiKeys() { try { return (JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8')) || {}).providerKeys || {}; } catch (_) { return {}; } }
function pythonExe() {
  const wanted = (readConfig().pythonExe || '').trim();
  if (wanted) { try { fs.accessSync(wanted, fs.constants.X_OK); return wanted; } catch (_) {} }
  return 'python3';
}

function loadStyleGuide() {
  try { return JSON.parse(fs.readFileSync(STYLE_GUIDE_JSON, 'utf8')); } catch (_) { return { styles: [] }; }
}
function findStyle(styleId) {
  return loadStyleGuide().styles.find((s) => s.id === styleId) || null;
}

/* 导出文件名里的「画风_备注」片段：A_转换图_Q版_嘴巴改小_ID.png。
   规则：去掉文件名非法字符与换行、压缩空白；备注最多留 40 字（防止中文长备注把文件名撑爆）；
   画风或备注缺省时该段自动跳过，由模板拼在类型名之后、任务 ID 之前。 */
function segOf(styleLabel, notes) {
  const clean = (v) => String(v == null ? '' : v)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/\s+/g, ' ').trim();
  return [clean(styleLabel), clean(notes).slice(0, 40)].filter(Boolean).map((s) => '_' + s).join('');
}

/* ---------- 提示词四槽位 ---------- */

/* 模板兜底：无 LLM 配置时按主体类型 + 用户备注拼出四槽位（口径对齐 SKILL.md 的槽位定义） */
function templateSlots(subject, styleLabel, notes) {
  const note = (notes || '').trim();
  if (subject === 'prop') {
    return {
      game_knowledge: '',
      subject_description: '参考图中的道具按原有造型、比例和主色重画，标志性特征与纹样保留清楚。'
        + (note ? '玩家要求：' + note : ''),
      image_analysis: '参考图为用户上传的原图。保留：道具的轮廓造型、主色分区和标志细节。舍弃：背景、阴影和与道具无关的内容。',
      composition: '正方形画面，道具居中，主体占画面约三分之二，主体外透明背景。'
    };
  }
  return {
    game_knowledge: '',
    subject_description: '保留参考图人物或人形角色的身份辨识点：发型剪影与发色分区、脸型或面罩特征、服装结构与主色、标志配饰。'
      + (note ? '玩家要求：' + note : ''),
    image_analysis: '参考图为用户上传的原图。保留：发型、脸型、服装主色与标志配饰等身份特征。舍弃：背景、武器、手持物与身外特效。',
    composition: '正方形画面，人物居中完整入画，主体高约占画面 85%，四周留少量透明空白。'
  };
}

/* LLM 读图写槽位：返回 null 表示未配置/失败（调用方回落模板）。
   图先压到 512px JPEG 再上传（出口链路对大上传不稳，压图 + 重试双保险）。 */
function shrinkImage(pngPath, cb) {
  const script = [
    'import sys, base64, io',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGB")',
    'im.thumbnail((512, 512))',
    'buf = io.BytesIO()',
    'im.save(buf, "JPEG", quality=75)',
    'print("data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode())'
  ].join('\n');
  execFile(pythonExe(), ['-c', script, pngPath], { timeout: 20000 }, (err, stdout) => {
    cb(err ? null : String(stdout).trim() || null);
  });
}

/* 单次 LLM 请求：返回 { slots } 成功 / { retryable } 可安全重试 / {} 终态失败。
   重试纪律（对齐头像大师 /api/ai 的教训）：
   - 可重试：连接层失败（请求未送达，必然未计费）、502/503（网关拒收，不会计费）
   - 绝不重试：超时/504/524（上游可能已成功计费，自动重试会重复扣费）、其余状态码（确定性失败） */
function llmAttempt(cfg, apiKey, imageBase64, system) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  return fetch(String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: system },
          { type: 'image_url', image_url: { url: imageBase64 } }
        ]
      }],
      max_tokens: 1500
    }),
    signal: ctrl.signal
  }).then(async (res) => {
    if (res.status === 502 || res.status === 503) { return { retryable: true }; }
    if (!res.ok) { return {}; }
    let data;
    try { data = await res.json(); } catch (_) { return {}; } /* 响应中途断流，可能已计费，不重试 */
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '') : '';
    const m = text.indexOf('{') >= 0 ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : '';
    let slots;
    try { slots = JSON.parse(m); } catch (_) { return {}; }
    const out = {};
    for (const k of ['game_knowledge', 'subject_description', 'image_analysis', 'composition']) {
      const v = slots[k];
      if (typeof v !== 'string' || !v.trim()) { return {}; }
      out[k] = v.trim();
    }
    return { slots: out };
  }).catch((err) => ({ retryable: !!(err && err.name !== 'AbortError') }))
    .finally(() => clearTimeout(timer));
}

async function llmSlots(imageBase64, subject, notes) {
  const cfg = readConfig().promptLLM;
  if (!cfg || !cfg.baseUrl || !cfg.model) { return null; }
  const keys = readAiKeys();
  const apiKey = (cfg.providerId && keys[cfg.providerId]) || cfg.apiKey || '';
  if (!apiKey) { return null; }
  const system = [
    '你是拼豆图纸（像素画底稿）的提示词专家。用户会上传一张图，请分析图片并输出四个提示词段落，最终 JSON 只含这四个键：',
    'game_knowledge：角色/道具的身份与可核对的辨识点（发型剪影、发色分区、肤色、标志服饰配件）；从图里读，读不出就留空字符串。',
    'subject_description：具体比例、动作、表情、道具与配饰，保留图中原有特征。',
    'image_analysis：分清参考图要保留的身份辨识点与要舍弃的内容（背景、武器、特效等）。',
    'composition：取景——主体位置、占画面比例、完整入画范围，主体外透明背景。',
    '要求：全部中文；每段 1~3 句、具体可执行；不写画风与像素化要求（由其他段落负责）；',
    '玩家备注优先于图片内容。' + (subject === 'prop' ? '主体是道具/物品，不是人像。' : '主体是人物/人形角色。'),
    (notes || '').trim() ? '玩家备注：' + notes.trim() : '',
    '只输出 JSON 对象本身，不要 markdown 代码块。'
  ].filter(Boolean).join('\n');
  /* 只对「必然未计费」的失败重试：最多 2 次、间隔 1.5s；超时等不重试，直接回落模板 */
  for (let i = 0; i <= 2; i++) {
    const r = await llmAttempt(cfg, apiKey, imageBase64, system);
    if (r && r.slots) { return r.slots; }
    if (!r || !r.retryable || i === 2) { return null; }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

/* ---------- 任务生命周期 ---------- */

function findOutputHtml(workDir) {
  const outDir = path.join(workDir, 'output');
  try {
    /* 一次任务目录里可能有多份 html（一键重转会再产出一份）：
       取 mtime 最新的那份，否则重转后可能打开的还是旧图纸。 */
    const list = fs.readdirSync(outDir).filter((f) => f.endsWith('.html'));
    if (!list.length) { return null; }
    let best = null;
    let bestMs = -1;
    for (const f of list) {
      const p = path.join(outDir, f);
      let ms = 0;
      try { ms = fs.statSync(p).mtimeMs; } catch (_) {}
      if (ms > bestMs) { bestMs = ms; best = p; }
    }
    return best;
  } catch (_) { return null; }
}

const MIME_RE = /^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/;

/* ---------- 引擎工厂：每个实例独立任务表 / 任务目录 / 生图后端 ---------- */

function createEngine(options) {
  const opts = options || {};
  const backend = opts.backend === 'valperler' ? 'valperler' : 'apinebula';
  const taskRoot = opts.taskRoot || DEFAULT_TASK_ROOT;
  const archiveRoot = opts.archiveRoot || DEFAULT_ARCHIVE_ROOT;
  /* 任务结束回调（P3 生成单结算用）：由服务端注入 (taskId, status, orderId) => void。
     引擎只负责「告诉外面这一单成没成」，退款/结算策略全在服务端，引擎不碰钱。 */
  const onTaskFinish = typeof opts.onTaskFinish === 'function' ? opts.onTaskFinish : null;

  /* 内存任务表：{ id: { status, error?, htmlPath?, workDir, startedAt, orderId } } */
  const tasks = new Map();

  /* 通知结算方并等它回话（最长 6 秒）：失败要「先退款、再对外报失败」，
   * 前端看到 failed 时余额已经回来了，文案才敢直说「已退回」。 */
  function notifyFinish(id, status, orderId) {
    if (!onTaskFinish) { return Promise.resolve(null); }
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) { return; } done = true; resolve(v); };
      const timer = setTimeout(() => finish(null), 6000);
      if (timer.unref) { timer.unref(); }
      Promise.resolve()
        .then(() => onTaskFinish(id, status, orderId || ''))
        .then((v) => { clearTimeout(timer); finish(v); })
        .catch(() => { clearTimeout(timer); finish(null); });
    });
  }

  /* 任务失败统一出口：先挂 settling（前端只认 done/failed，不会误判终态）→
   * 结算退款 → 再置 failed。任何绕过这里的失败都会让单据停在 pending 等补退。 */
  async function failTask(id, message) {
    const t = tasks.get(id);
    if (!t) { return; }
    if (t.status === 'done' || t.status === 'failed' || t.status === 'settling') { return; }
    t.status = 'settling';
    t.error = String(message || '生成失败').slice(0, 600).trim();
    const settle = await notifyFinish(id, 'failed', t.orderId);
    t.refunded = !!(settle && settle.refunded);
    t.status = 'failed';
  }

  function pruneTasks() {
    const now = Date.now();
    for (const [id, t] of tasks) {
      if (now - t.startedAt > TASK_TTL_MS) { tasks.delete(id); }
    }
    /* 磁盘 GC：删掉超过保留期的任务目录（正在跑的不动）。每次 generate 触发一次，量小无压力。 */
    try {
      for (const name of fs.readdirSync(taskRoot)) {
        if (!/^[0-9a-f]{16}$/.test(name)) { continue; }
        let live = false;
        for (const t of tasks.values()) {
          if (t.workDir === path.join(taskRoot, name) && t.status === 'running') { live = true; break; }
        }
        if (live) { continue; }
        try {
          const st = fs.statSync(path.join(taskRoot, name));
          if (now - st.mtimeMs > TASK_DISK_TTL_MS) { fs.rmSync(path.join(taskRoot, name), { recursive: true, force: true }); }
        } catch (_) {}
      }
    } catch (_) {} // taskRoot 尚不存在等场景静默跳过
  }

  /* 生成成功后立即归档：图纸 gzip + 封面 + 元数据。任何一步失败都只影响归档，不影响任务本身。 */
  function archiveWork(id) {
    const t = resolveTask(id);   /* 兼容「任务目录还在但内存表没了」的补录场景 */
    if (!t || !t.htmlPath) { return; }
    if (freeBytes() < ARCHIVE_MIN_FREE_BYTES) { return; }   /* 盘快满了绝不落地 */
    const dir = path.join(archiveRoot, id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      /* 图纸：读一次原文，既算大小也压进归档 */
      const raw = fs.readFileSync(t.htmlPath);
      fs.writeFileSync(path.join(dir, 'drawing.html.gz'), zlib.gzipSync(raw, { level: 9 }));

      const styleLabel = (findStyle(t.styleId) || {}).label || '';
      const meta = {
        taskId: id,
        kind: 'pixelart',
        backend,
        styleId: t.styleId || '',
        styleLabel,
        subject: t.subject === 'prop' ? 'prop' : 'character',
        notes: t.notes || '',
        title: styleLabel ? styleLabel + '拼豆图纸' : '拼豆图纸',
        createdAt: t.finishedAt || Date.now(),
        regenFrom: t.regenFrom || null,
        htmlBytes: raw.length
      };
      /* 运行记录里有色数等统计，能读到就一起存（BOM 要剥掉，python 写的是 utf-8-sig） */
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(t.workDir, '.wip', '运行记录.json'), 'utf8').replace(/^\uFEFF/, ''));
        if (rec && rec.cleanup && rec.cleanup.colors) { meta.colors = rec.cleanup.colors; }
        if (rec && Array.isArray(rec.boards)) { meta.boards = rec.boards.length; }
      } catch (_) {}
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

      /* 封面：转换图（拼豆效果图）缩到 640px JPEG，给「我的作品」卡片用 */
      const conv = path.join(t.workDir, '.wip', '转换图', '转换图.png');
      if (fs.existsSync(conv)) { makeCover(conv, dir); }
      pruneArchive(archiveRoot);
    } catch (_) { /* 归档失败不影响生成结果，图纸仍在任务目录里（72h 内可看） */ }
  }

  /* 封面缩图：优先 python(Pillow)，失败就原样拷 PNG（封面接口两种都认） */
  function makeCover(convPath, dir) {
    const out = path.join(dir, 'cover.jpg');
    const script = [
      'import sys',
      'from PIL import Image',
      'im = Image.open(sys.argv[1])',
      'bg = Image.new("RGBA", im.size, (255, 255, 255, 255))',
      'bg.alpha_composite(im.convert("RGBA"))',
      'im = bg.convert("RGB")',
      'im.thumbnail((' + ARCHIVE_COVER_PX + ', ' + ARCHIVE_COVER_PX + '))',
      'im.save(sys.argv[2], "JPEG", quality=85)'
    ].join('\n');
    execFile(pythonExe(), ['-c', script, convPath, out], { timeout: 20000 }, (err) => {
      if (err) {
        try { fs.copyFileSync(convPath, path.join(dir, 'cover.png')); } catch (_) {}
      }
    });
  }

  /* 任务完成后收尾：判 done/failed → 成功即归档 → 通知结算方（生成单） */
  async function finishTask(id, code, stderrTail, stdoutTail) {
    const t = tasks.get(id);
    if (!t) { return; }
    if (t.status === 'done' || t.status === 'failed' || t.status === 'settling') { return; }
    t.finishedAt = Date.now();
    const html = findOutputHtml(t.workDir);
    if (code === 0 && html) {
      /* 成功：先让用户能打开图纸，再定格账单（succeed 失败只会留 pending，
         下次登录补退时对用户有利，不会多扣） */
      t.status = 'done';
      t.htmlPath = html;
      try { archiveWork(id); } catch (_) {}
      notifyFinish(id, 'done', t.orderId);
      return;
    }
    await failTask(id, ('退出码 ' + code + ' ' + stderrTail + ' ' + stdoutTail).slice(-600).trim());
  }

  function startTask(id, workDir, imagePath, promptPath, subject, styleId) {
    const args = [imagePath, '--work-dir', workDir, '--prompt', promptPath,
      '--subject', subject, '--task-name', '拼豆图纸'];
    if (styleId && styleId !== 'original') { args.push('--art-style', styleId); }
    if (styleId === 'pixel-big-head') { args.push('--boards', '36', '52', '78'); }
    launchPerler(id, args);
  }

  /* 一键重转：底稿不变（--skip-gen 复用原底稿），切格阶段合并近色后重建图纸。
     不调生图服务、不重新组装提示词，秒级完成，不消耗积分；原图纸保留。
     链路校验要求 --prompt 必传（仅修改模式可省），复用原任务的提示词即可。 */
  function startRegenTask(id, workDir, effectImage, promptPath, styleId) {
    const args = ['--work-dir', workDir, '--prompt', promptPath,
      '--skip-gen', '--effect-image', effectImage, '--merge-close-colors',
      '--task-name', '拼豆图纸'];
    if (styleId === 'pixel-big-head') { args.push('--boards', '36', '52', '78'); }
    launchPerler(id, args);
  }

  /* 生成/重转共用的链路启动器：spawn val_perler.py，超时守护，收尾判定 done/failed */
  function launchPerler(id, args) {
    const t = tasks.get(id);
    const workDir = t.workDir;
    const cfg = readConfig();
    const env = Object.assign({}, process.env);
    if (backend === 'valperler') {
      /* 经典后端：选用旧生图客户端（val-perler.qq.com）、关闭色块规整（保留其原始输出）、
         WB ID 经环境变量下发走活动池额度（密钥/身份不进代码/命令行） */
      env.PERLER_IMAGE_SCRIPT = 'image_render_vp.py';
      env.PERLER_BLOCK_CLEANUP = '0';
      if (cfg.accUserId) { env.ACC_USER_ID = cfg.accUserId; }
    } else {
      /* apinebula 后端：生图凭据经环境变量下发（复用 promptLLM 的 baseUrl/apiKey，imageModel 可单独指定） */
      const pLLM = cfg.promptLLM || {};
      const keys = readAiKeys();
      const imgKey = (pLLM.providerId && keys[pLLM.providerId]) || pLLM.apiKey || '';
      if (pLLM.baseUrl) { env.PERLER_IMAGE_BASE_URL = pLLM.baseUrl; }
      if (imgKey) { env.PERLER_IMAGE_API_KEY = imgKey; }
      if (cfg.imageModel || pLLM.imageModel) { env.PERLER_IMAGE_MODEL = cfg.imageModel || pLLM.imageModel; }
      // 规整诊断：默认开（只是把触发样本存下来 + 追加一行追踪日志，不会污染正常日志）
      env.PERLER_HALO_SAMPLE_DIR = SAMPLE_DIR;
      env.PERLER_CLEANUP_TRACE = TRACE_LOG;
    }
    const child = spawn(pythonExe(), ['val_perler.py', 'generate'].concat(args), {
      cwd: PERLER_SCRIPTS,
      env: env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderrTail = '';
    let stdoutTail = '';
    t.pid = child.pid;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, GEN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdoutTail = (stdoutTail + d).slice(-4000); });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finishTask(id, code, stderrTail, stdoutTail);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      failTask(id, '启动失败：' + String(err.message || err).slice(0, 300));
    });
  }

  /* 内存查不到时从磁盘/归档恢复已完成任务（重启、任务目录 72h GC 后兜底，四个任务接口共用） */
  function resolveTask(id) {
    let t = tasks.get(id);
    if (t) { return t; }
    if (!id || !/^[0-9a-f]{16}$/.test(id)) { return null; }
    const workDir = path.join(taskRoot, id);
    const html = findOutputHtml(workDir);
    const meta = readArchivedMeta(archiveRoot, id);
    const archived = html ? false : !!readArchivedHtml(archiveRoot, id);
    if (!html && !archived) { return null; }
    t = {
      status: 'done',
      htmlPath: html || '',
      workDir,
      startedAt: 0,
      recovered: true,
      /* 任务目录被 GC 后内存表也早没了：画风/备注只能从归档 meta 里捞回来
         （下发图纸要注入导出文件名，一键重转也要用） */
      styleId: (meta && meta.styleId) || '',
      subject: (meta && meta.subject === 'prop') ? 'prop' : 'character',
      notes: (meta && meta.notes) || ''
    };
    tasks.set(id, t);
    return t;
  }

  /* POST /generate { imageBase64, subject, styleId, notes } → { taskId } */
  async function handleGenerate(req, res, sendJson) {
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 12 * 1024 * 1024) { throw new Error('图片过大（上限 12MB）'); }
        chunks.push(c);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (err) {
      return sendJson(res, 400, { error: { message: (err && err.message) || '请求解析失败' } });
    }

    const m = MIME_RE.exec(String(body.imageBase64 || ''));
    if (!m) { return sendJson(res, 400, { error: { message: '缺少图片或格式不支持（png/jpeg/webp）' } }); }
    const subject = body.subject === 'prop' ? 'prop' : 'character';
    const styleId = String(body.styleId || 'original');
    if (!findStyle(styleId)) { return sendJson(res, 400, { error: { message: '未知画风：' + styleId } }); }
    if (subject === 'prop' && findStyle(styleId).scope === 'character') {
      return sendJson(res, 400, { error: { message: '该画风只支持人像主体' } });
    }

    pruneTasks();
    const id = crypto.randomBytes(8).toString('hex');
    const workDir = path.join(taskRoot, id);
    const imgDir = path.join(workDir, '原图');
    try {
      fs.mkdirSync(imgDir, { recursive: true });
      fs.writeFileSync(path.join(imgDir, '原图.png'), Buffer.from(m[3], 'base64'));
    } catch (err) {
      return sendJson(res, 500, { error: { message: '落盘失败：' + String(err.message || err).slice(0, 120) } });
    }
    tasks.set(id, {
      status: 'running', workDir, startedAt: Date.now(), styleId, subject,
      /* 备注存下来：下发图纸页时要注入到 window.PIXELART_NOTE，供导出文件名使用 */
      notes: String(body.notes || '').trim().slice(0, 200),
      /* 生成单号（服务端在调用本函数前挂在 req 上）：任务结束据此结算 */
      orderId: String(req.orderId || '')
    });

    /* 立即返回 taskId；压图 → LLM 槽位（失败回落模板）→ 写配置 → 起链路 全部在后台做。
       LLM 含重试最长约 3 分钟，若阻塞 HTTP 响应会被平台网关 502；前端靠轮询任务状态推进。 */
    const imagePath = path.join(imgDir, '原图.png');
    sendJson(res, 200, { taskId: id });
    shrinkImage(imagePath, (smallDataUrl) => {
      const llmInput = smallDataUrl || body.imageBase64;
      llmSlots(llmInput, subject, body.notes)
        .then((slots) => slots || templateSlots(subject, findStyle(styleId).label, body.notes))
        .then((slots) => {
          try {
            const promptPath = path.join(workDir, 'prompt.json');
            fs.writeFileSync(promptPath, JSON.stringify(slots, null, 2));
            startTask(id, workDir, imagePath, promptPath, subject, styleId);
          } catch (err) {
            /* 走统一失败出口：否则生成单停在 pending，用户要等补退才拿回积分 */
            failTask(id, '启动失败：' + String(err.message || err).slice(0, 200));
          }
        });
    });
  }

  /* GET /task?id= → { status, error?, refunded? }；重启后从磁盘恢复已完成的任务 */
  function handleTaskStatus(req, res, fullUrl, sendJson) {
    const id = String(fullUrl.searchParams.get('id') || '');
    const t = resolveTask(id);
    if (!t) { return sendJson(res, 404, { error: { message: '任务不存在或已过期' } }); }
    return sendJson(res, 200, {
      status: t.status,
      error: t.error || undefined,
      /* 失败单是否真的退到了钱：前端据此决定说「已退回」还是「将自动补退」 */
      refunded: t.refunded === true ? true : undefined
    });
  }

  /* GET /task/stream?id= → SSE 心跳流（对齐 /api/ai 防 524 的成熟方案）：
     每 2 秒写一行 ": wait Ns" 心跳注释，连接永不「空闲」，托管平台 30 秒空闲 524 永不触发；
     任务状态变化推 event: status，done/failed 后关流；前端 getReader() 解析，心跳顺便驱动「已等待 N 秒」提示。 */
  function handleTaskStream(req, res, fullUrl) {
    const id = String(fullUrl.searchParams.get('id') || '');
    const t = resolveTask(id);
    if (!t) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { message: '任务不存在或已过期' } }));
    }
    const from = t.startedAt > 0 ? t.startedAt : Date.now();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    let lastSent = '';
    const sendStatus = () => {
      if (t.status === lastSent) { return; }
      lastSent = t.status;
      res.write('event: status\ndata: ' + JSON.stringify({
        status: t.status,
        error: t.error || undefined,
        refunded: t.refunded === true ? true : undefined
      }) + '\n\n');
    };
    sendStatus();
    const hb = setInterval(() => {
      res.write(': wait ' + Math.max(0, Math.floor((Date.now() - from) / 1000)) + 's\n\n');
      sendStatus();
      if (t.status === 'done' || t.status === 'failed') { clearInterval(hb); clearTimeout(cap); res.end(); }
    }, 2000);
    const cap = setTimeout(() => { clearInterval(hb); try { res.end(); } catch (_) {} }, GEN_TIMEOUT_MS + 30000);
    req.on('close', () => { clearInterval(hb); clearTimeout(cap); });
    res.on('error', () => { clearInterval(hb); clearTimeout(cap); });
  }

  /* GET /task/html?id= → 单文件图纸 HTML（任务目录没了就读长期归档，图纸永久可打开） */
  function handleTaskHtml(req, res, fullUrl, sendJson) {
    const id = String(fullUrl.searchParams.get('id') || '');
    const t = resolveTask(id);
    if (!t || t.status !== 'done') {
      return sendJson(res, 404, { error: { message: '任务未完成或不存在' } });
    }
    /* 原文：优先任务目录（还带着 .wip 现场），其次归档（gzip） */
    let source = null;
    if (t.htmlPath) {
      try { source = fs.readFileSync(t.htmlPath, 'utf8'); } catch (_) { source = null; }
    }
    if (source == null) { source = readArchivedHtml(archiveRoot, id); }
    if (source == null) {
      return sendJson(res, 410, { error: { message: '图纸文件已清理' } });
    }
    /* 图纸页里「导出」的下载文件名要带 任务 ID + 后端标识 + 画风 + 备注
       （A_标题_Q版_把嘴改小_ID_规格_色数色.png / A_转换图_Q版_把嘴改小_ID.png）。
       图纸是 build_html_blueprint 预先产出的静态单文件，构建时不知道我们的 taskId / 用哪个后端，
       所以在下发时注入到页面里，模板从 window.PIXELART_* 读取。
       后端标识：A = 经典版（val-perler.qq.com，/pixelart）  B = 自研（apinebula，主页 /）。
       画风取 style_guide 的 label（如 chibi → Q版）；备注用玩家填的「想调整的地方」。 */
    const BACKEND_TAG = backend === 'valperler' ? 'A' : 'B';
    const styleLabel = (t.styleId && (findStyle(t.styleId) || {}).label) || '';
    /* 注入到 <script> 里：把 < 转义掉，防止备注里出现 </script> 提前闭合标签 */
    const jsStr = (v) => JSON.stringify(String(v == null ? '' : v)).replace(/</g, '\\u003c');
    const SEG_PATCH = "${window.PIXELART_SEG || ''}";   // 旧图纸补丁用（画风_备注片段）
    let body;
    try {
      let html = source;
      const inject = '<script>window.PIXELART_TASK_ID=' + jsStr(id) +
        ';window.PIXELART_BACKEND=' + jsStr(BACKEND_TAG) +
        ';window.PIXELART_STYLE=' + jsStr(styleLabel) +
        ';window.PIXELART_NOTE=' + jsStr(t.notes || '') +
        ';window.PIXELART_SEG=' + jsStr(segOf(styleLabel, t.notes)) + ';</script>';
      /* 本次改动之前产出的图纸，下载命名是 `${state.title}_${PGW}x${PGH}_${PT.colors}色`，
         里面没有任务 ID 的插槽。对这些旧文件在下发时补上插槽，避免老链接必须重新生成才能带上 ID；
         新图纸自带 `const TASK_ID`，不进这段。命中不到就原样下发，不会破坏旧文件。 */
      if (!html.includes('const TASK_ID =') && html.includes('_${PGW}x${PGH}_${PT.colors}色')) {
        html = html.replace('_${PGW}x${PGH}_${PT.colors}色',
          "${(window.PIXELART_TASK_ID ? '_' + window.PIXELART_TASK_ID : '')}_${PGW}x${PGH}_${PT.colors}色");
      }
      /* 旧图纸的文件名模板没有「A/B 后端」前缀插槽（本代改动之前构建的），下发时按三代形态各打一个
         补丁兜底；新图纸自带 const BACKEND_TAG / BE_TAG 插槽，整段跳过。命中不到就原样跳过。 */
      if (!html.includes('BACKEND_TAG') && !html.includes('BE_TAG')) {
        const HEAD = "${state.title.replace(/[\\\\/:*?\"<>|]/g, '')}";
        const TAGX = "${(window.PIXELART_BACKEND ? window.PIXELART_BACKEND + '_' : '')}";
        /* 转换图导出名（曾用 `标题_转换图.png`）→ `A_转换图_任务ID.png` */
        html = html.replace(HEAD + '_转换图.png',
          TAGX + "转换图${(window.PIXELART_TASK_ID ? '_' + window.PIXELART_TASK_ID : '')}.png");
        /* 成品图纸导出名（带 const TASK_ID 的一代模板）：前缀插槽 */
        html = html.replace(HEAD + '${TASK_ID', TAGX + HEAD + '${TASK_ID');
        /* 更早一代（上面旧文件补丁刚注入 window.PIXELART_TASK_ID 插槽的）同理 */
        html = html.replace(HEAD + '${(window.PIXELART_TASK_ID',
          TAGX + HEAD + '${(window.PIXELART_TASK_ID');
      }
      /* 本代之前构建的图纸（导出名里还没有画风/备注片段）：下发时把 PIXELART_SEG 插进文件名插槽，
         老任务不用重新生成也能拿到新命名。新图纸自带该插槽，命中不到原样跳过。 */
      if (!html.includes('PIXELART_SEG')) {
        html = html.replace("转换图${TASK_TAG ? '_' + TASK_TAG : ''}.png",
          '转换图' + SEG_PATCH + "${TASK_TAG ? '_' + TASK_TAG : ''}.png");
        html = html.replace("转换图${(window.PIXELART_TASK_ID ? '_' + window.PIXELART_TASK_ID : '')}.png",
          '转换图' + SEG_PATCH + "${(window.PIXELART_TASK_ID ? '_' + window.PIXELART_TASK_ID : '')}.png");
        html = html.replace("${TASK_ID ? '_' + TASK_ID : ''}_${PGW}x${PGH}",
          SEG_PATCH + "${TASK_ID ? '_' + TASK_ID : ''}_${PGW}x${PGH}");
        html = html.replace("${(window.PIXELART_TASK_ID ? '_' + window.PIXELART_TASK_ID : '')}_${PGW}x${PGH}",
          SEG_PATCH + "${(window.PIXELART_TASK_ID ? '_' + window.PIXELART_TASK_ID : '')}_${PGW}x${PGH}");
      }
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html;
      body = Buffer.from(html, 'utf8');
    } catch (err) {
      return sendJson(res, 410, { error: { message: '图纸文件已清理' } });
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  /* POST /regen { id } → { taskId }：对已完成任务做「一键重转」。
     复用原底稿（--skip-gen --effect-image）+ --merge-close-colors 在切格阶段合并近色后重建图纸；
     不重新生图、不重新组装提示词、不扣积分，原图纸保留不受影响。 */
  async function handleRegen(req, res, sendJson) {
    let body = {};
    try {
      const chunks = [];
      for await (const c of req) { chunks.push(c); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (_) { /* 空/坏 body 按缺 id 处理 */ }

    const id = String(body.id || '');
    const t = resolveTask(id);
    if (!t || t.status !== 'done') {
      return sendJson(res, 404, { error: { message: '原任务未完成或不存在' } });
    }
    const effectImage = path.join(t.workDir, '.wip', '转换图', '转换图.png');
    if (!fs.existsSync(effectImage)) {
      return sendJson(res, 410, { error: { message: '原始底稿已清理，无法重转，请重新生成' } });
    }

    pruneTasks();
    const newId = crypto.randomBytes(8).toString('hex');
    const workDir = path.join(taskRoot, newId);
    try {
      fs.mkdirSync(workDir, { recursive: true });
    } catch (err) {
      return sendJson(res, 500, { error: { message: '落盘失败：' + String(err.message || err).slice(0, 120) } });
    }
    /* 提示词优先复用原任务的 prompt.json；丢失时模板兜底写一份（切格阶段只用其中的基础段） */
    let promptPath = path.join(t.workDir, 'prompt.json');
    if (!fs.existsSync(promptPath)) {
      promptPath = path.join(workDir, 'prompt.json');
      const slots = templateSlots(t.subject === 'prop' ? 'prop' : 'character', '', '');
      fs.writeFileSync(promptPath, JSON.stringify(slots, null, 2));
    }
    tasks.set(newId, {
      status: 'running', workDir, startedAt: Date.now(), styleId: t.styleId, subject: t.subject,
      notes: t.notes || '', regenFrom: id
    });
    sendJson(res, 200, { taskId: newId });
    startRegenTask(newId, workDir, effectImage, promptPath, t.styleId);
  }

  /* GET /task/cover?id= → 作品封面（归档的 640px JPEG；没有则回落到任务目录的转换图 PNG）
     「我的作品」卡片直接 <img src> 引用，同源、无需签名，长缓存。 */
  function handleTaskCover(req, res, fullUrl) {
    const id = String(fullUrl.searchParams.get('id') || '');
    if (!/^[0-9a-f]{16}$/.test(id)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { message: '缺少任务 id' } }));
    }
    const candidates = [
      path.join(archiveRoot, id, 'cover.jpg'),
      path.join(archiveRoot, id, 'cover.png'),
      path.join(taskRoot, id, '.wip', '转换图', '转换图.png')
    ];
    for (const file of candidates) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) { continue; }
      const type = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': size,
        'Cache-Control': 'public, max-age=604800'
      });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { message: '封面不存在或已清理' } }));
  }

  /* GET /task/meta?id= → 作品元数据（前端写「我的作品」行时取画风/备注/标题） */
  function handleTaskMeta(req, res, fullUrl, sendJson) {
    const id = String(fullUrl.searchParams.get('id') || '');
    if (!/^[0-9a-f]{16}$/.test(id)) {
      return sendJson(res, 400, { error: { message: '缺少任务 id' } });
    }
    const meta = readArchivedMeta(archiveRoot, id);
    if (meta) { return sendJson(res, 200, meta); }
    const t = tasks.get(id);
    if (t && t.status === 'done') {
      const styleLabel = (findStyle(t.styleId) || {}).label || '';
      return sendJson(res, 200, {
        taskId: id, kind: 'pixelart', backend,
        styleId: t.styleId || '', styleLabel,
        subject: t.subject === 'prop' ? 'prop' : 'character',
        notes: t.notes || '',
        title: styleLabel ? styleLabel + '拼豆图纸' : '拼豆图纸',
        createdAt: t.finishedAt || t.startedAt || Date.now()
      });
    }
    return sendJson(res, 404, { error: { message: '任务不存在或未归档' } });
  }

  /* GET /styles → 画风列表（缩略图服务端读 assert 资产转 base64，前端无需直访 assert 目录） */
  function handleStyles(res, sendJson) {
    const guide = loadStyleGuide();
    const styles = (guide.styles || []).map((s) => {
      let thumb = null;
      try {
        thumb = 'data:image/png;base64,' + fs.readFileSync(path.join(PERLER_DIR, 'assets', 'style-picker', s.id + '.png')).toString('base64');
      } catch (_) { /* 缩略图缺失时前端降级为首字母块 */ }
      return { id: s.id, label: s.label, tip: s.tip || '', scope: s.scope || 'all', thumb: thumb };
    });
    return sendJson(res, 200, { styles: styles, hint: guide.hint || '' });
  }

  return {
    backend, taskRoot, archiveRoot,
    handleGenerate, handleTaskStatus, handleTaskStream, handleTaskHtml,
    handleTaskCover, handleTaskMeta, handleStyles, handleRegen,
    /* 手动归档（补录历史作品 / 运维脚本用）：返回归档后的 meta，失败返回 null */
    archiveTask: (id) => { archiveWork(id); return readArchivedMeta(archiveRoot, id); }
  };
}

module.exports = { createEngine, loadStyleGuide };
