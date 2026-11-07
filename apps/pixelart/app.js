/* =========================================================
 * 点豆（原拼豆大师） · 产品层逻辑
 * - 平台层接入：登录 / 积分钱包 / 支付，全部复用 window.Platform
 * - 核心流程：上传图 → 选主体/画风 → 服务端建单扣 1 积分 → SSE 心跳流跟踪任务（降级轮询）→ 打开图纸
 * - 失败退款全部在服务端完成（生成单 order_fail，幂等）；前端只做补退触发与文案
 * ========================================================= */
(function () {
  'use strict';
/* API base：主页默认 /api/pixelart；经典版页面由服务端注入 window.PIXELART_API_BASE 切到 /api/pixelart-vp */
var PIXELART_API = (typeof window !== 'undefined' && window.PIXELART_API_BASE) || '/api/pixelart';

/* 引擎归一：/api/pixelart2 是「固定腾讯」入口，服务端把 /api/pixelart2/* 内部改写成
   /api/pixelart-vp/*，两者是**同一个引擎实例、同一份任务目录**（shared/my.js 用同一约定）。
   做通道比对时必须归一，否则「在 / 上生成、从 /apps/pixelart2 打开」会被误判成跨通道而丢弃。 */
function engineKey(base) {
  var v = String(base || '');
  if (v === '/api/pixelart2' || v === '/api/pixelart-vp') { return '/api/pixelart-vp'; }
  return v;
}
function sameEngine(a, b) { return engineKey(a) === engineKey(b); }

/* ---------- 生图通道提示点（左下角 7px 圆点） ----------
 * 腾讯 = 灰蓝，自研 = 琥珀。刻意不写字、不参与布局：它是给「知道的人」看的运维标记，
 * 不是给用户读的说明（2026-11-04 定：所有人可见但不显眼）。
 * 固定通道的页面（/apps/pixelart、/apps/pixelart2）以页面实际用的 base 为准，
 * 不看服务端状态 —— 它们的通道永不切换。 */
var CHANNEL_DOT = {
  vp: { color: '#8aa1bb', label: '腾讯 VP' },
  self: { color: '#d9953c', label: '自研' }
};
var channelDotEl = null;

function channelOfPage() {
  if (window.PIXELART_CHANNEL_FIXED) {
    return /pixelart-vp|pixelart2/.test(PIXELART_API) ? 'vp' : 'self';
  }
  return window.PIXELART_CHANNEL_ACTIVE === 'self' ? 'self' : 'vp';
}

function paintChannelDot(which) {
  var el = channelDotEl;
  if (!el) { return; }
  var info = CHANNEL_DOT[which] || CHANNEL_DOT.vp;
  var text = '生图通道：' + info.label + (window.PIXELART_CHANNEL_FIXED ? '（固定）' : '');
  el.setAttribute('data-ch', which);
  el.style.background = info.color;
  el.setAttribute('title', text);
  el.setAttribute('aria-label', text);
}

function mountChannelDot() {
  if (channelDotEl || !document.body) { return; }
  var el = document.createElement('span');
  el.className = 'ch-dot';
  el.setAttribute('role', 'img');
  document.body.appendChild(el);
  channelDotEl = el;
  paintChannelDot(channelOfPage());
}

/* 非固定通道的页面：我们开着页面的时候服务端可能已经切走了（自动切换）。
 * 切回标签页时问一次，别让圆点说谎。固定通道不问，它不会变。 */
function refreshChannelDot() {
  if (!channelDotEl || window.PIXELART_CHANNEL_FIXED) { return; }
  fetch('/api/channel', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || !d.active) { return; }
      window.PIXELART_CHANNEL_ACTIVE = d.active;
      paintChannelDot(d.active);
    })
    .catch(function () { /* 网络抖动就不动它，保持原样 */ });
}

  var Platform = window.Platform;
  if (!Platform || typeof Platform.setup !== 'function') {
    /* 平台层未加载（如 CDN 被拦截）时给出可见提示，不做任何后续初始化 */
    document.addEventListener('DOMContentLoaded', function () {
      var h = document.querySelector('.hero p');
      if (h) { h.textContent = '页面组件加载不完整，请刷新重试。'; }
    });
    return;
  }

  /* ---------- 平台层所需的 DOM 元素集合（id 与 index.html 一一对应） ---------- */
  function $(id) { return document.getElementById(id); }
  var els = {
    /* 登录态 */
    btnLogin: $('btnLogin'),
    userChip: $('userChip'),
    userChipText: $('userChipText'),
    btnSignOut: $('btnSignOut'),
    /* 登录弹窗 */
    loginModal: $('loginModal'),
    btnCloseLogin: $('btnCloseLogin'),
    loginEmail: $('loginEmail'),
    errEmail: $('errEmail'),
    loginCode: $('loginCode'),
    errCode: $('errCode'),
    btnSendCode: $('btnSendCode'),
    btnPhoneLogin: $('btnPhoneLogin'),
    loginMsg: $('loginMsg'),
    /* 积分钱包 */
    btnWallet: $('btnWallet'),
    walletBalance: $('walletBalance'),
    walletBalanceBig: $('walletBalanceBig'),
    walletModal: $('walletModal'),
    btnCloseWallet: $('btnCloseWallet'),
    productGrid: $('productGrid'),
    payChannelsNote: $('payChannelsNote'),
    redeemCode: $('redeemCode'),
    btnRedeem: $('btnRedeem'),
    walletMsg: $('walletMsg')
  };

  /* ---------- 产品状态 ---------- */
  var Store = {
    state: {
      user: null          /* 当前登录用户（session.user，未登录为 null） */
    },
    /* 工作台状态 */
    imgDataUrl: null,     /* 处理后的 dataURL（≤1024px PNG） */
    subject: 'character', /* 仅作请求兜底：主体类型由服务端 LLM 读图判定（2026-11-02 移除人物/道具选项卡） */
    styles: [],           /* [{id,label,tip,scope,thumb,demo}] demo=示例图纸任务 ID */
    styleHint: '',        /* /styles 下发的全局兜底文案：选中画风无 tip 时显示 */
    styleId: 'original',   /* 默认「还原」，与画风列表首位一致；人物道具不再分栏，全部画风常显 */
    generating: false,
    pollTimer: null,
    watchToken: 0,        /* SSE 观察轮次：每轮生成 +1，回调对不上号即视为已取消 */
    watchAbort: null,     /* SSE 连接的 AbortController（浏览器不支持时为 null） */
    watchTaskId: null,    /* 本轮正在观察的任务 id（回前台对账 / 断线自愈都要用） */
    watchStartAt: 0,      /* 本轮任务开始时间（epoch 秒）：恢复后秒数从它回算 */
    watchRetry: 0,        /* 连续重连次数（活过 20 秒的连接会把计数清零） */
    watchdogTimer: null,  /* 心跳看门狗计时器 */
    lastTaskId: null,
    regenActive: false,   /* 本轮观察的是「一键重转」任务（不扣积分，文案不同） */
    recent: [],           /* 最近生成：[{ id, thumb, style, time }]，最多 RECENT_MAX 条 */
    lastTxnId: null,
    lastOrderId: null     /* 生成单号：服务端建单扣费时下发，用于对账/补退排查 */
  };

  /* ---------- 产品侧提示（平台层弹窗内提示走 showHint，工作台提示走 studioMsg） ---------- */
  function showHint(msg, isError) {
    var el = $('studioMsg');
    if (!el) { return; }
    el.textContent = msg || '';
    el.classList.toggle('warn', !!isError);
  }
  function studioMsg(msg, isError) { showHint(msg, isError); }

  /* ---------- 画风列表 ---------- */
  function loadStyles() {
    var strip = $('styleStrip');
    /* 首屏是骨架屏（index.html 里 5 个 .style-skel），这里只在失败时换成可点的重试 */
    fetch(PIXELART_API + '/styles').then(function (r) { return r.json(); }).then(function (data) {
      var list = (data && data.styles) || [];
      if (!list.length) { return styleLoadFailed('画风加载失败'); }
      Store.styles = list;
      Store.styleHint = (data && data.hint) || '';
      renderStyleStrip();
    }).catch(function () { styleLoadFailed('画风加载失败'); });
  }
  function styleLoadFailed(msg) {
    var strip = $('styleStrip');
    if (!strip) { return; }
    strip.setAttribute('aria-busy', 'false');
    strip.innerHTML = '<p class="hint">' + msg + ' · <button type="button" class="link-btn" id="styleRetry">重试</button></p>';    var btn = $('styleRetry');
    if (btn) { btn.addEventListener('click', function () { strip.setAttribute('aria-busy', 'true'); strip.innerHTML = SKELETON_HTML; loadStyles(); }); }
  }
  var SKELETON_HTML = new Array(6).join('<span class="style-skel"></span>');

  /* 画风说明行：选中谁就显示谁的 tip（点选可见，移动端不依赖悬停）；无 tip 回落全局文案。
     有示例图纸（demo 任务 ID）时在说明后跟「查看示例图纸」链接，指向该画风的样例图纸页。 */
  function updateStyleHint() {
    var hintEl = $('styleHint');
    if (!hintEl) { return; }
    var cur = null;
    for (var i = 0; i < Store.styles.length; i++) {
      if (Store.styles[i].id === Store.styleId) { cur = Store.styles[i]; break; }
    }
    if (cur && cur.tip) {
      var html = '「' + cur.label + '」' + cur.tip;
      if (cur.demo) {
        html += ' <a class="style-demo-link" href="/api/pixelart-vp/task/html?id=' + encodeURIComponent(cur.demo)
          + '" target="_blank" rel="noopener">查看示例图纸</a>';
      }
      hintEl.innerHTML = html;
    } else {
      hintEl.textContent = Store.styleHint || '';
    }
  }

  function renderStyleStrip() {
    var strip = $('styleStrip');
    var avail = Store.styles;   /* 主体选项卡已移除：画风全量常显，顺序由 /styles 下发 */
    if (!avail.some(function (s) { return s.id === Store.styleId; })) {
      Store.styleId = avail.length ? avail[0].id : 'original';
    }
    updateStyleHint();
    strip.setAttribute('aria-busy', 'false');
    strip.innerHTML = avail.map(function (s) {
      var art = s.thumb
        ? '<img src="' + s.thumb + '" alt="' + s.label + '画风预览" width="260" height="260" decoding="async" />'
        : '<span class="style-letter">' + s.label.charAt(0) + '</span>';
      return '<button type="button" class="style-card' + (s.id === Store.styleId ? ' cur' : '') + '" data-sid="' + s.id + '" title="' + (s.tip || s.label) + '">'
        + '<span class="card-art">' + art
        + '<span class="card-check"><svg class="icon icon-12" aria-hidden="true"><use href="#i-check"/></svg></span></span>'
        + '<span class="card-name">' + s.label + '</span></button>';
    }).join('');
    strip.querySelectorAll('.style-card[data-sid]').forEach(function (card) {
      card.onclick = function () {
        Store.styleId = card.dataset.sid;
        renderStyleStrip();
      };
    });
  }

  /* ---------- 上传与图片处理 ---------- */
  function acceptFile(file) {
    var errEl = $('errFile');
    errEl.hidden = true;
    if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      errEl.textContent = '只支持 PNG / JPG / WebP 图片';
      errEl.hidden = false;
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      errEl.textContent = '图片过大（上限 12MB）';
      errEl.hidden = false;
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      downscale(String(reader.result), function (dataUrl) {
        if (!dataUrl) {
          errEl.textContent = '这张图打不开，请换一张，或先截图再上传';
          errEl.hidden = false;
          return;
        }
        Store.imgDataUrl = dataUrl;
        $('previewImg').src = dataUrl;
        $('fileName').textContent = file.name || '未命名图片';
        $('fileSize').textContent = formatSize(file.size) + '（上传前自动压缩到 1024px）';
        $('dzEmpty').hidden = true;
        $('dzPreview').hidden = false;
        updateSteps();
        /* 埋点：看板漏斗「打开页面 → 完成登录 → 上传图片 → 首次出图」的第三步 */
        if (typeof Platform.track === 'function') { Platform.track('upload'); }
      });
    };
    reader.onerror = function () {
      errEl.textContent = '图片读取失败，请重试';
      errEl.hidden = false;
    };
    reader.readAsDataURL(file);
  }

  /* 长边压到 1024（链路底稿就是 1024，原图更大只是白传）；PNG 保留透明背景 */
  function formatSize(bytes) {
    if (!bytes && bytes !== 0) { return ''; }
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(0) + ' KB'; }
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* 长边压到 1024（链路底稿就是 1024，原图更大只是白传）；PNG 保留透明背景。
   *
   * 2026-11-04：这里以前「原图 ≤1024 就直接原样上传、解码失败也原样上传」，
   * 而客户端只校验文件 ≤12MB、服务端校验的是 base64 后的 body ≤12MB（膨胀 4/3），
   * 于是 9MB 以上的图会被服务端拒成 400。现在一律重编码；PNG 压不下来（照片类）
   * 就退回 JPEG；实在还是太大就报错，不把一张注定被拒的图发出去。
   * 返回 null 表示这张图处理不了（前端提示换图，不再提交）。 */
  function downscale(dataUrl, cb) {
    var img = new Image();
    img.onload = function () {
      var long = Math.max(img.width, img.height);
      var ratio = long > 1024 ? 1024 / long : 1;
      var w = Math.max(1, Math.round(img.width * ratio));
      var h = Math.max(1, Math.round(img.height * ratio));
      var cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      var out = null;
      try { out = cv.toDataURL('image/png'); } catch (_) { out = null; }
      if (!out || out.length > 6 * 1024 * 1024) {
        /* 照片类内容压不成小 PNG：垫白底再转 JPEG（不然透明区会变黑） */
        try {
          var flat = document.createElement('canvas');
          flat.width = w;
          flat.height = h;
          var ctx = flat.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(cv, 0, 0);
          out = flat.toDataURL('image/jpeg', 0.9);
        } catch (_) { /* 保持 PNG 结果 */ }
      }
      if (!out || out.length > 11 * 1024 * 1024) { cb(null); return; }
      cb(out);
    };
    /* 解码失败（极端尺寸 / 特殊编码）以前是原样上传 → 服务端必拒且白扣一单，现在直接拦下 */
    img.onerror = function () { cb(null); };
    img.src = dataUrl;
  }

  function bindUpload() {
    var dz = $('dropzone');
    var input = $('fileInput');
    dz.addEventListener('click', function (e) {
      if (e.target.closest('#btnRemoveImg')) { return; }
      input.click();
    });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) { acceptFile(input.files[0]); }
      input.value = '';
    });
    ['dragover', 'dragenter'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { acceptFile(f); }
    });
    $('btnRemoveImg').addEventListener('click', function (e) {
      e.stopPropagation();
      Store.imgDataUrl = null;
      $('previewImg').src = '';
      $('fileName').textContent = '';
      $('fileSize').textContent = '';
      $('dzPreview').hidden = true;
      $('dzEmpty').hidden = false;
      updateSteps();
    });
  }

  /* ---------- 生成流程 ---------- */
  var GEN_POLL_INTERVAL = 4000;
  var GEN_POLL_MAX = 150;          /* 4s × 150 = 10 分钟上限 */
  /* 阶段文案分档（秒）：按线上 40 个已完成任务的 P50 分段实测校准（C0，2026-11-07）：
     读图+提示词 22s / 生图 58s（累计 80s）/ 切格+排版 54s（累计 132s）。
     旧档位 0/20/50/85 会在 85 秒后永久冻在最后一句，而真实 P50 是 132 秒 ——
     用户看到的就是「卡住不动」，这也是「看起来失败」的一大来源。 */
  var STAGE_HINTS = [
    [0,   'AI 正在读懂你的图片…'],
    [22,  '正在生成像素底稿…'],
    [80,  '正在切格与配色（五档规格）…'],
    [118, '正在拼装可编辑图纸…'],
    [175, '图纸还在生成，这单比平时慢一些…']
  ];

  function setGenerating(on) {
    Store.generating = on;
    $('btnGenerate').disabled = on;
    $('btnGenerate').setAttribute('aria-busy', String(on));
    $('btnGenIdle').hidden = on;
    $('btnGenBusy').hidden = !on;
    $('genStatus').hidden = !on;
    updateSteps();
    if (!on) {
      if (Store.pollTimer) { clearInterval(Store.pollTimer); Store.pollTimer = null; }
      if (Store.watchdogTimer) { clearInterval(Store.watchdogTimer); Store.watchdogTimer = null; }
      /* 关掉 SSE 观察连接（token 失配让 pump 循环自行退出，AbortController 直接断流） */
      Store.watchToken += 1;
      if (Store.watchAbort) { try { Store.watchAbort.abort(); } catch (_) {} Store.watchAbort = null; }
      Store.watchTaskId = null;
      Store.watchStartAt = 0;
      Store.watchRetry = 0;
    }
  }

  function stageText(sec) {
    var text = STAGE_HINTS[0][1];
    for (var i = 0; i < STAGE_HINTS.length; i++) {
      if (sec >= STAGE_HINTS[i][0]) { text = STAGE_HINTS[i][1]; }
    }
    return text + '（已 ' + sec + ' 秒，页面可最小化）';
  }

  /* ---------- 步骤条状态联动（对齐头像页：done 绿色 / active 深色） ---------- */
  function updateSteps() {
    var hasImg = !!Store.imgDataUrl;
    var hasResult = !!Store.lastTaskId;
    var gen = Store.generating;
    /* 1 上传图片 / 2 选择画风（默认已选中，与头像页一致常绿）/ 3 生成图纸 */
    var states = [
      { done: hasImg, active: !hasImg && !gen },
      { done: true, active: hasImg && !gen },
      { done: hasResult && !gen, active: gen }
    ];
    for (var i = 0; i < states.length; i++) {
      var el = $('step' + (i + 1));
      if (!el) { continue; }
      el.classList.toggle('done', states[i].done);
      el.classList.toggle('active', states[i].active);
    }
  }

  /* 老条目（本次改动前存的）没有 api 字段，回落当前 base —— 它们在切换前生成，
     当时 base 恰好就是 vp，绝大多数情况下仍然点得开。 */
  function taskHtmlUrl(taskId, api) {
    return (api || PIXELART_API) + '/task/html?id=' + encodeURIComponent(taskId);
  }

  function openTaskHtml(taskId, api) {
    window.open(taskHtmlUrl(taskId, api), '_blank');
  }

  /* 出图收尾的主按钮走同标签跳转：async 回调里 window.open 会被移动端拦掉
     （iOS Safari / Android Chrome 都拦），同标签导航不依赖弹窗权限，一次点击必定进得去。 */
  function gototaskHtml(taskId, api) {
    location.href = taskHtmlUrl(taskId, api);
  }

  function showDone(taskId) {
    Store.lastTaskId = taskId;
    $('genStatus').hidden = true;
    $('genDone').hidden = false;
    var wasRegen = Store.regenActive;
    Store.regenActive = false;
    /* 页内结果卡（A4）：缩略图先给个「出图了」的实感，主按钮同标签进图纸页，
       不再依赖 window.open —— 异步回调里开新窗口在移动端会被拦成「没反应」。 */
    var cover = PIXELART_API + '/task/cover?id=' + encodeURIComponent(taskId);
    var thumb = $('doneThumb'), thumbLink = $('doneThumbLink'), tabLink = $('btnOpenResultTab');
    if (thumb) {
      thumb.hidden = false;
      thumb.setAttribute('src', cover);
    }
    if (thumbLink) {
      thumbLink.hidden = false;
      thumbLink.setAttribute('href', taskHtmlUrl(taskId));
    }
    if (tabLink) {
      tabLink.hidden = false;
      tabLink.setAttribute('href', taskHtmlUrl(taskId));
    }
    $('genDoneMsg').textContent = wasRegen
      ? '重转完成！近色已合并，原图纸仍保留。'
      : '图纸已生成！点下面的按钮打开。';
    studioMsg(wasRegen ? '重转完成，未消耗积分。图纸页里可切规格、改色号、导出。' : '生成完成，消耗 1 积分。图纸页里可切规格、改色号、导出。', false);
  }

  /* ---------- 最近生成（本地回看入口，最多 6 条） ----------
   * 缩略图取自本次上传图（canvas 压到 200px JPEG），任务 ID 指向图纸页；
   * 服务端图纸已长期归档（P2），这里只过滤本地记录本身的 72 小时窗口；
     真正长期可用的入口是「我的作品」（/my）。 */
  var RECENT_MAX = 6;
  var RECENT_TTL_MS = 72 * 60 * 60 * 1000;
  var RECENT_LS_KEY = 'pixelart-recent-v1';

  function makeThumb(dataUrl, cb) {
    try {
      var img = new Image();
      img.onload = function () {
        try {
          var side = Math.min(img.width, img.height);
          var cv = document.createElement('canvas');
          cv.width = 200; cv.height = 200;
          var ctx = cv.getContext('2d');
          /* 居中方形裁剪，避免缩略图变形 */
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 200, 200);
          cb(cv.toDataURL('image/jpeg', 0.8));
        } catch (_) { cb(null); }
      };
      img.onerror = function () { cb(null); };
      img.src = dataUrl;
    } catch (_) { cb(null); }
  }

  function styleLabel() {
    for (var i = 0; i < Store.styles.length; i++) {
      if (Store.styles[i].id === Store.styleId) { return Store.styles[i].label; }
    }
    return '';
  }

  /* thumbOverride：恢复出来的任务没有本地原图（页面重开过），优先用它落盘的缩略图；
     再退一步用服务端封面地址（同源、长缓存），保证「最近生成」里的条目看得见。 */
  function addRecent(taskId, thumbOverride) {
    /* api：记下这单是在哪个通道生成的。任务 id 只在自己的引擎实例里有效，
       通道切过之后用当前 base 去点会 404 —— 存下来才能一直点得开。 */
    var fallback = PIXELART_API + '/task/cover?id=' + encodeURIComponent(taskId);
    var entry = {
      id: taskId,
      api: PIXELART_API,
      thumb: thumbOverride || (Store.imgDataUrl ? null : fallback),
      style: styleLabel(),
      time: Date.now()
    };
    Store.recent.unshift(entry);
    if (Store.recent.length > RECENT_MAX) { Store.recent.length = RECENT_MAX; }
    renderRecent();
    if (entry.thumb || !Store.imgDataUrl) { persistRecent(); return; }
    makeThumb(Store.imgDataUrl, function (small) {
      if (!small) { return; }
      entry.thumb = small;
      persistRecent();
      renderRecent();
    });
  }

  function persistRecent() {
    try {
      var now = Date.now();
      localStorage.setItem(RECENT_LS_KEY, JSON.stringify(
        Store.recent.filter(function (r) {
          return r && r.thumb && (now - (r.time || 0)) < RECENT_TTL_MS;
        })
      ));
    } catch (_) { /* 配额满/隐私模式：静默，仅会话内可见 */ }
  }

  function restoreRecent() {
    try {
      var saved = JSON.parse(localStorage.getItem(RECENT_LS_KEY) || '[]');
      var now = Date.now();
      /* 恢复时就地清掉过期条目（persistRecent 随后写回时会一并清出 LS） */
      Store.recent = Array.isArray(saved)
        ? saved.filter(function (r) {
            return r && r.id && r.thumb && (now - (r.time || 0)) < RECENT_TTL_MS;
          })
        : [];
    } catch (_) { Store.recent = []; }
    renderRecent();
  }

  function renderRecent() {
    var wrap = $('recentWrap'), strip = $('recentStrip');
    if (!wrap || !strip) { return; }
    var now = Date.now();
    /* 只过滤显示（过期/无缩略图的不渲染），不改写 Store.recent ——
     * 缩略图由 makeThumb 异步回填，破坏性过滤会把没回填完的条目误删 */
    var visible = Store.recent.filter(function (r) {
      return r && r.id && r.thumb && (now - (r.time || 0)) < RECENT_TTL_MS;
    });
    if (!visible.length) {
      wrap.hidden = true;
      strip.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    strip.innerHTML = '';
    for (var i = 0; i < visible.length; i++) {
      (function (r) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'recent-item';
        btn.title = (r.style ? r.style + ' · ' : '') +
          new Date(r.time).toLocaleString() + ' · 点击回看图纸（已长期保存）';
        var img = document.createElement('img');
        img.src = r.thumb;
        img.alt = '最近生成的图纸缩略图';
        btn.appendChild(img);
        btn.addEventListener('click', function () { openTaskHtml(r.id, r.api); });
        strip.appendChild(btn);
      })(visible[i]);
    }
  }

  function generateFlow() {
    if (Store.generating) { return; }
    studioMsg('');
    if (!Store.state.user) {
      studioMsg('请先登录再生成（生成消耗 1 积分）', true);
      auth.openLogin();
      return;
    }
    if (!Store.imgDataUrl) {
      studioMsg('请先上传一张图片', true);
      return;
    }
    var notes = ($('notesInput').value || '').trim();
    setGenerating(true);
    Store.regenActive = false;   /* 上一次重转被中途放走时别把「重转」的状态带进这一单 */
    $('genDone').hidden = true;
    $('genStatusText').textContent = '正在提交任务…';
    var startedAt = Math.floor(Date.now() / 1000);

    /* 扣费在服务端完成（生成单：先建单再扣费，失败自动退款，前端绕不过）：
       前端只带令牌提交，凭响应头 X-Order-Id / X-Wallet-Balance 记账与刷新积分 chip。
       任务期失败的退款由服务端在任务收尾时完成，前端不再自己退——关掉页面也会退。 */
    getAuthToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) { headers.Authorization = 'Bearer ' + token; }
      return fetch(PIXELART_API + '/generate', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          imageBase64: Store.imgDataUrl,
          subject: Store.subject,
          styleId: Store.styleId,
          notes: notes
        })
      });
    }).then(function (res) {
      var orderId = res.headers && res.headers.get ? res.headers.get('X-Order-Id') : null;
      if (orderId) { Store.lastOrderId = orderId; }
      var txn = res.headers && res.headers.get ? res.headers.get('X-Wallet-Txn-Id') : null;
      if (txn) { Store.lastTxnId = txn; }
      var bal = res.headers && res.headers.get ? res.headers.get('X-Wallet-Balance') : null;
      if (bal !== null && bal !== '') { wallet.applyBalance(bal); }
      return res.json().then(function (data) {
        if (!res.ok || !data.taskId) {
          var info = (data && data.error) || {};
          var e = new Error(info.message || '提交失败，请稍后重试');
          e.status = res.status;
          e.code = info.code || '';
          e.base = info.base || '';
          if (e.code === 'INSUFFICIENT_BALANCE') { e.insufficient = true; }
          if (e.code === 'AUTH_REQUIRED') { e.authRequired = true; }
          throw e;
        }
        return data.taskId;
      });
    }).then(function (taskId) {
      /* 2. SSE 心跳流跟踪任务（对齐 /api/ai 防 524 的成熟方案）：
            服务端每 2s 写心跳注释，连接永不空闲，托管平台 30s 空闲 524 不会触发；
            心跳顺便驱动「已等待 N 秒」提示，status 事件驱动完成/失败。
            流不可用时自动降级为 4s 轮询。
         3. 任务号落盘（A3）：标签页被系统回收 / 用户强杀重开，回来还能接上这一单。 */
      savePending(taskId, startedAt);
      watchTask(taskId, startedAt);
      updateSteps();
    }).catch(function (err) {
      setGenerating(false);
      /* 通道已被服务端自动切到备用（腾讯额度耗尽）：这一单在建单扣费之前就被挡了，
         没有产生任何流水。这里静默换到服务端给的 base 重提一次，用户看到的只是
         「正在提交任务…」多转几秒 —— 不提示、不解释。
         只重试一次；固定通道的页面（/apps/pixelart2）不参与，那边的契约是永不切换。 */
      if (err && err.code === 'CHANNEL_SWITCHED' && !window.PIXELART_CHANNEL_FIXED && !Store.channelFallback) {
        Store.channelFallback = true;
        PIXELART_API = err.base || '/api/pixelart';
        window.PIXELART_API_BASE = PIXELART_API;
        /* 圆点跟着换色：这一页从这一刻起确实走的是自研了 */
        window.PIXELART_CHANNEL_ACTIVE = 'self';
        paintChannelDot('self');
        return generateFlow();
      }
      if (err && err.insufficient) {
        studioMsg(err.message, true);
        auth.openWallet();
        return;
      }
      /* 会话失效（服务端 401，未产生扣费）：清掉「已登录」假象并引导重登 */
      if (err && (err.authRequired || err.status === 401 || err.status === 403)) {
        auth.applySession(null);
        studioMsg('登录状态已失效，请重新登录后再生成', true);
        auth.openLogin();
        return;
      }
      /* 其余的提交期失败（参数 / 落盘）服务端已在扣费后自动退款 */
      /* 网络层面断掉（上传中被切网、页面被切走）：fetch 抛的是英文 TypeError，
         直接甩给用户看不懂，这里换成中文；这类请求服务端不会出图，也不会扣钱 */
      if (err && (err.name === 'TypeError' || /failed to fetch|networkerror|load failed|network request failed/i.test(err.message || ''))) {
        studioMsg('上传中断了，请检查网络后重试', true);
        return;
      }
      studioMsg((err && err.message) || '生成失败，请稍后重试', true);
    });
  }

  /* 一键重转：对上一次生成的图纸做「合并近色重新转图」，不重新生图、不扣积分 */
  function regenFlow() {
    if (Store.generating) { return; }
    if (!Store.lastTaskId) {
      studioMsg('还没有可重转的图纸，请先生成一张', true);
      return;
    }
    studioMsg('');
    setGenerating(true);
    Store.lastTxnId = null;   /* 重转不扣积分，失败也无需退回 */
    Store.lastOrderId = null;
    Store.regenActive = true;
    $('genDone').hidden = true;
    $('genStatusText').textContent = '正在重转图纸（合并近色，不重新生图）…';
    var startedAt = Math.floor(Date.now() / 1000);
    fetch(PIXELART_API + '/regen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Store.lastTaskId })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data.taskId) {
          var e = new Error((data.error && data.error.message) || '重转提交失败，请稍后重试');
          throw e;
        }
        return data.taskId;
      });
    }).then(function (taskId) {
      savePending(taskId, startedAt);
      watchTask(taskId, startedAt);
      updateSteps();
    }).catch(function (err) {
      setGenerating(false);
      Store.regenActive = false;
      studioMsg((err && err.message) || '重转失败，请稍后重试', true);
    });
  }

  /* ---------- 任务观察：SSE 心跳流（首选） + 轮询（降级） ---------- */

  /* ---------- 云端留存（P2）：作品行写入 users/<uid>/pixelart/ ----------
   * 只写元数据 JSON（<1KB）：图纸（gzip 后 ~2.3MB）与封面体积大，留在服务器长期归档，
   * 「我的作品」用 /api/pixelart/task/cover|html?id= 同源取，所以云端存储不背容量包袱。
   * 整条链路 fire-and-forget + 超时，绝不阻塞 UI
   * （2026-10-30 头像页「图出来了按钮还在转」的教训：辅助动作不能串在交互主链上）。 */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, ms);
      Promise.resolve(promise).then(function (v) {
        if (settled) { return; }
        settled = true; clearTimeout(timer); resolve(v);
      }, function () {
        if (settled) { return; }
        settled = true; clearTimeout(timer); resolve(null);
      });
    });
  }

  function saveWorkToCloud(taskId) {
    var user = Store.state.user;
    var cloud = Platform.cloud.getClient();
    if (!taskId || !user || !user.id || !cloud || !cloud.storage) { return; }
    var ts = Date.now();
    var localStyle = styleLabel();
    var metaP = fetch(PIXELART_API + '/task/meta?id=' + encodeURIComponent(taskId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    withTimeout(metaP, 6000).then(function (meta) {
      var label = (meta && meta.styleLabel) || localStyle;
      var payload = {
        kind: 'pixelart',
        taskId: taskId,
        styleId: (meta && meta.styleId) || Store.styleId,
        styleLabel: label,
        subject: (meta && meta.subject) || Store.subject,
        notes: (meta && meta.notes) || ($('notesInput') ? $('notesInput').value.trim() : ''),
        title: (meta && meta.title) || (label ? label + '拼豆图纸' : '拼豆图纸'),
        colors: (meta && meta.colors) || null,
        createdAt: ts,
        apiBase: PIXELART_API
      };
      var path;
      try { path = cloud.storage.userPath(user.id, 'pixelart/' + ts + '-' + taskId + '.json'); } catch (_) { return null; }
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      return withTimeout(cloud.storage.upload(path, blob, { contentType: 'application/json' }), 15000);
    }).catch(function () { /* 留存失败静默：本地「最近生成」仍可回看 72 小时 */ });
  }

  function onTaskDone(taskId, thumbOverride) {
    var wasRegen = Store.regenActive;
    setGenerating(false);
    clearPending();
    showDone(taskId);   /* 不再自动 window.open：页内结果卡，用户点一下才跳（移动端不会被拦） */
    addRecent(taskId, thumbOverride);
    updateSteps();
    /* 重转是同一张图的另一种切法，不新增作品行（避免列表里堆重复卡片） */
    if (!wasRegen) { saveWorkToCloud(taskId); }
  }

  /* 失败原因由服务端组装好：结论在前、真因在括号里（服务器路径已隐去）。
     排查期原文全量显示（含上游 JSON），不再按 200 字截断；只压空白免撑破提示条。 */
  function failReason(st) {
    var s = String((st && st.error) || '未知错误').replace(/\s+/g, ' ').trim();
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  }

  function onTaskFailed(st) {
    setGenerating(false);
    clearPending();
    updateSteps();
    var wasRegen = Store.regenActive;
    Store.regenActive = false;
    if (wasRegen) {
      studioMsg('重转没成功，' + failReason(st) + '。原图纸不受影响，也未扣积分', true);
      return;
    }
    /* 退款由服务端在任务收尾时完成（order_fail 与状态变更同事务、幂等），
       前端只负责如实描述结果：refunded=true 说明钱已经回来了。 */
    studioMsg(failReason(st) + (st.refunded ? '，1 积分已退回' : '，积分将自动退回，可在「我的 → 积分明细」核对'), true);
    if (!st.refunded) {
      /* 服务端没来得及结算（进程重启 / 内存里没这单）：立刻触发一次补退 */
      settleOrders();
    }
  }

  /* 补退入口：把本人被遗弃的 pending 单结掉（服务端幂等，失败静默）
     cb 可选：调用方已经写了结论文案时，用它把「已退回 N 积分」补进同一句，
     否则这里默认的提示会把上一条更重要的话（比如「已中断」）顶掉。 */
  function settleOrders(cb) {
    if (!auth || typeof auth.settleStaleOrders !== 'function') { return; }
    auth.settleStaleOrders().then(function (r) {
      if (typeof cb === 'function') { cb(r); return; }
      if (r && r.refunded > 0) {
        studioMsg('已退回 ' + r.refunded + ' 积分（余额 ' + r.balance + '）');
      }
    });
  }

  /* =========================================================
   * 任务观察（A 组，2026-11-07）
   * 数据依据见 .workbuddy/docs/出图等待体验-方案.md 第 10 节：真实 P50 132 秒，
   * 用户切到别的 App 再回来、地铁里断网、系统回收标签页都会让「流」先死，
   * 而任务其实还在服务端跑。这一段的全部目的就是：别让观察线死得比任务早。
   *  ① 流干净关闭 / 读失败不再「就地放弃」：先查一次终态，没终态按 3s/6s/12s 退避重连，
   *     三次都不成才降级 4s 轮询（旧行为只做最后一步）。
   *  ② 看门狗：心跳 2s 一行，连续 15s 一行都没收到 = 连接挂死，主动断流走同一条自愈路径。
   *  ③ /task?id= 404（服务重启 / 任务被清理）说人话：已中断、积分自动退回，并立刻补退。
   *  ④ 任务号落盘：重开页面能回到「正在生成（已 N 秒）」接着看。
   * ========================================================= */
  var WATCH = {
    ms: 15000,                    /* 连续这么久没收到任何一行（心跳 2s 一行）= 连接挂死 */
    tick: 5000,                   /* 看门狗检查间隔 */
    delays: [3000, 6000, 12000]   /* 重连退避；三次都失败才降级轮询 */
  };
  var PENDING_LS_KEY = 'pixelart-pending-v1';
  var PENDING_MAX_AGE = 15 * 60 * 1000;

  /* ---------- 任务号落盘（A3） ---------- */
  function readPending() {
    try {
      var rec = JSON.parse(localStorage.getItem(PENDING_LS_KEY) || 'null');
      return rec && typeof rec === 'object' ? rec : null;
    } catch (_) { return null; }
  }

  function writePending(rec) {
    try { localStorage.setItem(PENDING_LS_KEY, JSON.stringify(rec)); } catch (_) { /* 隐私模式：只影响恢复能力 */ }
  }

  function savePending(taskId, startedAt) {
    var rec = {
      taskId: taskId,
      startedAt: startedAt,
      apiBase: PIXELART_API,
      styleId: Store.styleId,
      style: styleLabel(),
      regen: !!Store.regenActive,
      thumb: null,
      savedAt: Date.now()
    };
    writePending(rec);
    /* 缩略图异步补进来：恢复后的「最近生成」条目也有图，不必再等一次上传 */
    if (!Store.imgDataUrl) { return; }
    makeThumb(Store.imgDataUrl, function (small) {
      if (!small) { return; }
      var cur = readPending();
      if (!cur || cur.taskId !== taskId) { return; }
      cur.thumb = small;
      writePending(cur);
    });
  }

  function clearPending() {
    try { localStorage.removeItem(PENDING_LS_KEY); } catch (_) { /* 忽略 */ }
  }

  /* ---------- 查一次终态 ---------- */
  /* cb(st, code)：st = 任务状态对象（null 表示没查到），code = HTTP 状态（0 = 网络失败） */
  function checkTaskOnce(taskId, cb) {
    var settled = false;
    function fin(st, code) {
      if (settled) { return; }
      settled = true;
      cb(st, code || 0);
    }
    fetch(PIXELART_API + '/task?id=' + encodeURIComponent(taskId), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) { return fin(null, 404); }
        if (!r.ok) { return fin(null, r.status); }
        return r.json().then(function (st) { fin(st, r.status); }, function () { fin(null, r.status); });
      })
      .catch(function () { fin(null, 0); });
  }

  /* 任务在服务端没了（重启 / 被清理）：这不是「网络慢」，要明确说清并补退 */
  function onTaskMissing() {
    setGenerating(false);
    clearPending();
    updateSteps();
    Store.regenActive = false;
    var head = '本次生成已中断（服务重启或任务已过期），';
    studioMsg(head + '积分将自动退回，可在「我的 → 积分明细」核对', true);
    settleOrders(function (r) {
      if (r && r.refunded > 0) {
        studioMsg(head + r.refunded + ' 积分已退回（余额 ' + r.balance + '）', true);
      }
    });
  }

  /* 断流后的统一收口：先查终态 → 有终态收尾；还在跑就退避重连，用尽转轮询 */
  function resumeWatch(taskId, startedAt) {
    if (!Store.generating || Store.watchTaskId !== taskId) { return; }
    checkTaskOnce(taskId, function (st, code) {
      if (!Store.generating || Store.watchTaskId !== taskId) { return; }
      if (st) {
        if (st.status === 'done') { onTaskDone(taskId); return; }
        if (st.status === 'failed') { onTaskFailed(st); return; }
      } else if (code === 404) {
        onTaskMissing();
        return;
      }
      var n = Store.watchRetry || 0;
      if (n >= WATCH.delays.length) { startPolling(taskId, startedAt); return; }
      Store.watchRetry = n + 1;
      var delay = WATCH.delays[n];
      $('genStatusText').textContent = '连接中断，' + Math.round(delay / 1000) + ' 秒后自动重连…（已 '
        + Math.max(0, Math.floor(Date.now() / 1000) - startedAt) + ' 秒）';
      setTimeout(function () {
        if (!Store.generating || Store.watchTaskId !== taskId) { return; }
        watchTask(taskId, startedAt, true);
      }, delay);
    });
  }

  /* SSE 流：每 2s 一行 ": wait Ns" 心跳（驱动阶段提示），状态变化推 event: status */
  function watchTask(taskId, startedAt, isReconnect) {
    var token = ++Store.watchToken;
    Store.watchTaskId = taskId;
    Store.watchStartAt = startedAt;
    if (!isReconnect) { Store.watchRetry = 0; }
    if (Store.pollTimer) { clearInterval(Store.pollTimer); Store.pollTimer = null; }
    if (Store.watchdogTimer) { clearInterval(Store.watchdogTimer); Store.watchdogTimer = null; }
    var ac = (typeof window.AbortController === 'function') ? new window.AbortController() : null;
    Store.watchAbort = ac;
    var opts = ac ? { signal: ac.signal } : undefined;

    var closed = false;
    var connAt = 0;
    var lastDataAt = Date.now();
    var myTimer = null;

    /* 这一轮观察结束（任务本身没结束）：清计时器，交给 resumeWatch 决定重连还是轮询 */
    function bail() {
      if (closed) { return true; }
      closed = true;
      if (myTimer) {
        clearInterval(myTimer);
        if (Store.watchdogTimer === myTimer) { Store.watchdogTimer = null; }
        myTimer = null;
      }
      /* 连接活过 20 秒又断：链路本来是好的，退避计数从头算，不要越重连越慢 */
      if (connAt && Date.now() - connAt > 20000) { Store.watchRetry = 0; }
      return false;
    }

    myTimer = setInterval(function () {
      if (token !== Store.watchToken || closed) {
        if (myTimer) { clearInterval(myTimer); myTimer = null; }
        return;
      }
      if (Date.now() - lastDataAt < WATCH.ms) { return; }
      /* 心跳 2s 一行，连续 WATCH.ms 一行都没到 = 连接挂死（切后台回来最典型） */
      if (bail()) { return; }
      if (ac) { try { ac.abort(); } catch (_) {} }
      resumeWatch(taskId, startedAt);
    }, Math.min(WATCH.tick, WATCH.ms));
    Store.watchdogTimer = myTimer;

    fetch(PIXELART_API + '/task/stream?id=' + encodeURIComponent(taskId), opts)
      .then(function (res) {
        if (res.status === 404) {
          var gone = new Error('task gone');
          gone.gone = true;
          throw gone;
        }
        if (!res.ok || !res.body || !res.body.getReader) { throw new Error('stream unavailable'); }
        connAt = Date.now();
        lastDataAt = Date.now();
        var reader = res.body.getReader();
        var decoder = (typeof TextDecoder === 'function') ? new TextDecoder('utf-8') : null;
        var buf = '';
        function pump() {
          if (token !== Store.watchToken) { try { reader.cancel(); } catch (_) {} return; }
          return reader.read().then(function (r) {
            if (token !== Store.watchToken) { try { reader.cancel(); } catch (_) {} return; }
            if (r.done) {
              /* 干净关闭但没等到终态：会话被系统掐了 / 网关断流（最常见），走自愈 */
              if (bail()) { return; }
              resumeWatch(taskId, startedAt);
              return;
            }
            lastDataAt = Date.now();
            if (decoder) { buf += decoder.decode(r.value, { stream: true }); }
            else { for (var i = 0; i < r.value.length; i++) { buf += String.fromCharCode(r.value[i]); } }
            var idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              var lines = buf.slice(0, idx).split('\n');
              buf = buf.slice(idx + 2);
              for (var j = 0; j < lines.length; j++) {
                var line = lines[j];
                if (line.charAt(0) === ':') {
                  var m = line.match(/^:\s*wait\s+(\d+)/);
                  if (m) { $('genStatusText').textContent = stageText(parseInt(m[1], 10)); }
                } else if (line.indexOf('event:') === 0 && line.slice(6).trim() === 'status') {
                  var dl = lines[j + 1];
                  if (dl && dl.indexOf('data:') === 0) {
                    var st;
                    try { st = JSON.parse(dl.slice(5).trim()); } catch (_) { st = null; }
                    if (!st) { continue; }
                    if (st.status === 'done') {
                      try { reader.cancel(); } catch (_) {}
                      if (bail()) { return; }
                      return onTaskDone(taskId);
                    }
                    if (st.status === 'failed') {
                      try { reader.cancel(); } catch (_) {}
                      if (bail()) { return; }
                      return onTaskFailed(st);
                    }
                  }
                }
              }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (err) {
        if (token !== Store.watchToken) { return; }   /* 已取消 / 已开新一轮 */
        if (bail()) { return; }
        if (err && err.gone) { onTaskMissing(); return; }
        resumeWatch(taskId, startedAt);               /* 流不可用 → 自愈（重连 → 轮询） */
      });
  }

  /* 兜底：4s 间隔轮询（旧行为）。只在重连用尽后启用 */
  function startPolling(taskId, startedAt) {
    if (Store.pollTimer) { clearInterval(Store.pollTimer); }
    var polls = 0;
    Store.pollTimer = setInterval(function () {
      polls += 1;
      var sec = Math.floor(Date.now() / 1000) - startedAt;
      $('genStatusText').textContent = stageText(sec);
      if (polls > GEN_POLL_MAX) {
        setGenerating(false);
        /* 只是前端不再等：任务在服务端还会继续，最终失败会自动退款，
           这里顺手触发一次补退（幂等），并如实说明 */
        studioMsg('等待超时，图纸仍在后台生成；若最终失败，积分会自动退回（可在「我的」核对）', true);
        settleOrders();
        return;
      }
      checkTaskOnce(taskId, function (st, code) {
        if (!Store.generating) { return; }
        if (!st) {
          if (code === 404) { onTaskMissing(); }
          return; /* 单次查询失败忽略，下一轮再试 */
        }
        if (st.status === 'done') { onTaskDone(taskId); }
        else if (st.status === 'failed') { onTaskFailed(st); }
      });
    }, GEN_POLL_INTERVAL);
  }

  /* ---------- 回前台 / 恢复网络立刻对账（A2） ----------
     visibilitychange（切回标签页）、pageshow（bfcache 返回）、online（断网恢复）
     都会让「上一条流」变成尸体：先查一次终态，还在跑就重建流，别让用户盯着一具尸体。 */
  function recheckGeneration() {
    if (!Store.generating || !Store.watchTaskId) { return; }
    if (typeof document !== 'undefined' && document.hidden) { return; }   /* 隐藏态不查，省电 */
    var taskId = Store.watchTaskId;
    var startedAt = Store.watchStartAt;
    checkTaskOnce(taskId, function (st, code) {
      if (!Store.generating || Store.watchTaskId !== taskId) { return; }
      if (st) {
        if (st.status === 'done') { onTaskDone(taskId); return; }
        if (st.status === 'failed') { onTaskFailed(st); return; }
      } else if (code === 404) {
        onTaskMissing();
        return;
      }
      Store.watchRetry = 0;
      watchTask(taskId, startedAt, true);
    });
  }

  /* ---------- 启动时恢复（A3） ---------- */
  function restorePending() {
    var rec = readPending();
    if (!rec) { return; }
    if (!rec.taskId || !/^[0-9a-f]{16}$/.test(String(rec.taskId))) { clearPending(); return; }
    /* 通道切过：任务 id 只在建它的那个引擎实例里有效，跨引擎查不到，丢弃即可。
       /api/pixelart2 与 /api/pixelart-vp 是同一引擎（服务端改写），必须归一后再比。 */
    if (rec.apiBase && !sameEngine(rec.apiBase, PIXELART_API)) { clearPending(); return; }
    var startedAt = Number(rec.startedAt) || Math.floor((Number(rec.savedAt) || Date.now()) / 1000);
    var age = Date.now() - (Number(rec.savedAt) || 0);
    if (!(age >= 0) || age > PENDING_MAX_AGE) {
      /* 超过 15 分钟：多半早就出图了，只核对一次，不把「正在生成」的假象摆出来 */
      checkTaskOnce(rec.taskId, function (st) {
        if (st && st.status === 'done') {
          addRecent(rec.taskId, rec.thumb);
          $('genStatus').hidden = true;
          $('genDone').hidden = false;
          Store.lastTaskId = rec.taskId;
          $('genDoneMsg').textContent = '上次的图纸已经生成好了。';
          var cover = PIXELART_API + '/task/cover?id=' + encodeURIComponent(rec.taskId);
          if ($('doneThumb')) { $('doneThumb').hidden = false; $('doneThumb').setAttribute('src', cover); }
          if ($('doneThumbLink')) { $('doneThumbLink').hidden = false; $('doneThumbLink').setAttribute('href', taskHtmlUrl(rec.taskId)); }
          if ($('btnOpenResultTab')) { $('btnOpenResultTab').hidden = false; $('btnOpenResultTab').setAttribute('href', taskHtmlUrl(rec.taskId)); }
          updateSteps();
          studioMsg('上次的图纸已经生成好了，点「打开图纸」查看。');
        }
        clearPending();
      });
      return;
    }
    /* 15 分钟内：直接回到「正在生成」，秒数按 startedAt 回算（不从头计数） */
    Store.regenActive = !!rec.regen;
    if (rec.styleId) { Store.styleId = rec.styleId; }
    setGenerating(true);
    $('genDone').hidden = true;
    $('genStatusText').textContent = stageText(Math.max(0, Math.floor(Date.now() / 1000) - startedAt));
    checkTaskOnce(rec.taskId, function (st, code) {
      if (!Store.generating) { return; }
      if (st && st.status === 'done') { onTaskDone(rec.taskId, rec.thumb); return; }
      if (st && st.status === 'failed') { onTaskFailed(st); return; }
      if (!st && code === 404) { onTaskMissing(); return; }
      Store.watchRetry = 0;
      watchTask(rec.taskId, startedAt, true);
    });
  }

  function bindGenerate() {
    $('btnGenerate').addEventListener('click', generateFlow);
    $('btnCancelPoll').addEventListener('click', function () {
      /* 不删 pending：后台等待期间重开页面还能接回来（15 分钟内） */
      setGenerating(false);
      studioMsg('已切到后台等待，页面刷新后 15 分钟内还能接回来；本轮积分不退，失败会自动退回', true);
    });
    /* 出图收尾：主按钮同标签进图纸页（用户手势，移动端不会被拦）；
       「新标签打开」是 <a target="_blank">，缩略图点击等同主按钮。 */
    $('btnOpenResult').addEventListener('click', function () {
      if (Store.lastTaskId) { gototaskHtml(Store.lastTaskId); }
    });
    if ($('doneThumbLink')) {
      $('doneThumbLink').addEventListener('click', function (e) {
        e.preventDefault();
        if (Store.lastTaskId) { gototaskHtml(Store.lastTaskId); }
      });
    }
    if ($('doneThumb')) {
      /* 封面还没归档好（极少数）时把整块缩略图收起来，不留一个破图 */
      $('doneThumb').addEventListener('error', function () {
        if ($('doneThumbLink')) { $('doneThumbLink').hidden = true; }
      });
    }
    $('btnRegen').addEventListener('click', regenFlow);
    $('btnDismissDone').addEventListener('click', function () {
      $('genDone').hidden = true;
    });
  }

  /* ---------- 启动：OAuth 回调分发 → 常规启动 ---------- */
  function clearUrlCallbackParams() {
    var url = new URL(location.href);
    ['code', 'state', 'provider'].forEach(function (k) { url.searchParams.delete(k); });
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  function continueNormalStartup() {
    bindAuthEvents();
    loadPayChannels();
    cloudBootstrap();
    bindUpload();
    bindGenerate();
    loadStyles();
    restoreRecent();
    restorePending();   /* A3：上个页面留下的未完成任务，回来接着看 */
    mountChannelDot();
    /* A2：切回标签页 / bfcache 返回 / 网络恢复 → 先对一次账，再决定要不要重建流 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { return; }
      refreshChannelDot();
      recheckGeneration();
    });
    window.addEventListener('pageshow', function (e) {
      if (e && e.persisted) { recheckGeneration(); }
    });
    window.addEventListener('online', recheckGeneration);
  }

  function cloudBootstrap() {
    var cloud = Platform.cloud.getClient();
    if (!cloud || !cloud.auth) { renderAuthUI(); return; }
    cloud.auth.getSession().then(function (res) {
      var session = res && res.data ? res.data : null;
      applySession(session);
    }).catch(function () { renderAuthUI(); });
    try {
      cloud.auth.onAuthStateChange(function (event, session) {
        applySession(session || null);
      });
    } catch (_) { /* SDK 不支持订阅时忽略 */ }
  }

  function restoreAuth() {
    var url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
      continueNormalStartup();
      return;
    }
    var provider = url.searchParams.get('provider');
    var cloud = Platform.cloud.getClient();
    if ((provider !== 'workbuddy' && provider !== 'wechat') || !cloud) {
      continueNormalStartup();
      return;
    }
    var handleCallback = provider === 'workbuddy'
      ? cloud.auth.handleWorkBuddyCallback
      : cloud.auth.handleWechatWebCallback;
    if (typeof handleCallback !== 'function') {
      continueNormalStartup();
      showHint('登录组件加载不完整，请刷新页面后重新登录', true);
      return;
    }
    handleCallback.call(cloud.auth).then(function (res) {
      if (res && res.error) {
        continueNormalStartup();
        showHint('登录失败：' + ((res.error && res.error.message) || '请重新登录'), true);
        return;
      }
      if (res && res.data && res.data.user) {
        clearUrlCallbackParams();
        continueNormalStartup();
        applySession(res.data);
        showHint('登录成功，积分全平台通用');
        return;
      }
      continueNormalStartup();
    }).catch(function () {
      continueNormalStartup();
      showHint('登录回调处理失败，请重新登录', true);
    });
  }

  /* ---------- 接入平台层（登录 / 钱包 / 支付） ----------
   * callbackPath：OAuth 回跳必须落本产品页（/apps/pixelart/）
   * productSlug：产品隔离 —— 钱包套餐只显示本产品/通用套餐            */
  var auth = Platform.setup({
    els: els,
    store: Store,
    showHint: showHint,
    callbackPath: '/apps/pixelart/',
    userChipTitle: '已登录，积分全平台通用',
    productSlug: 'pixelart',
    onLoginSuccess: function () { /* 登录后平台层自动刷新余额 */ },
    onSignOut: function () {
      /* 退出登录清空工作台提交态（上传的图保留在本地，无需清） */
      Store.generating = false;
    }
  });
  var applySession = auth.applySession;
  var bindAuthEvents = auth.bindAuthEvents;
  var loadPayChannels = auth.loadPayChannels;
  var renderAuthUI = auth.renderAuthUI;
  var wallet = auth.walletService;
  var getAuthToken = auth.getAuthToken;

  /* 测试钩子：jsdom 测试直接驱动内部状态与流程（线上无依赖方，仅挂 window 属性） */
  window.__pixelart = {
    store: Store,
    generateFlow: generateFlow,
    regenFlow: regenFlow,
    acceptFile: acceptFile,
    renderStyleStrip: renderStyleStrip,
    addRecent: addRecent,
    renderRecent: renderRecent,
    restoreRecent: restoreRecent,
    persistRecent: persistRecent,
    makeThumb: makeThumb,
    /* A 组观察线（断流接管 / 回前台对账 / 任务号落盘恢复） */
    stageText: stageText,
    watchTask: watchTask,
    startPolling: startPolling,
    checkTaskOnce: checkTaskOnce,
    recheckGeneration: recheckGeneration,
    onTaskDone: onTaskDone,
    onTaskFailed: onTaskFailed,
    onTaskMissing: onTaskMissing,
    restorePending: restorePending,
    savePending: savePending,
    readPending: readPending,
    clearPending: clearPending,
    watch: WATCH
  };

  restoreAuth();
})();
