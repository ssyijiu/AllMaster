/* =========================================================
 * 拼豆大师 · 产品层逻辑
 * - 平台层接入：登录 / 积分钱包 / 支付，全部复用 window.Platform
 * - 核心流程：上传图 → 选主体/画风 → 扣 1 积分 → SSE 心跳流跟踪任务（降级轮询）→ 打开图纸
 * - 生成失败自动退回积分（平台层 wallet.refund）
 * ========================================================= */
(function () {
  'use strict';
/* API base：主页默认 /api/pixelart；经典版页面由服务端注入 window.PIXELART_API_BASE 切到 /api/pixelart-vp */
var PIXELART_API = (typeof window !== 'undefined' && window.PIXELART_API_BASE) || '/api/pixelart';

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
    loginPhone: $('loginPhone'),
    errPhone: $('errPhone'),
    loginCode: $('loginCode'),
    errCode: $('errCode'),
    btnSendCode: $('btnSendCode'),
    btnPhoneLogin: $('btnPhoneLogin'),
    btnWechatLogin: $('btnWechatLogin'),
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
    walletMsg: $('walletMsg'),
    txnHistory: $('txnHistory')
  };

  /* ---------- 产品状态 ---------- */
  var Store = {
    state: {
      user: null          /* 当前登录用户（session.user，未登录为 null） */
    },
    /* 工作台状态 */
    imgDataUrl: null,     /* 处理后的 dataURL（≤1024px PNG） */
    subject: 'character', /* character | prop */
    styles: [],           /* [{id,label,scope,thumb}] */
    styleId: 'original',
    generating: false,
    pollTimer: null,
    watchToken: 0,        /* SSE 观察轮次：每轮生成 +1，回调对不上号即视为已取消 */
    watchAbort: null,     /* SSE 连接的 AbortController（浏览器不支持时为 null） */
    lastTaskId: null,
    regenActive: false,   /* 本轮观察的是「一键重转」任务（不扣积分，文案不同） */
    lastTxnId: null
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
    fetch(PIXELART_API + '/styles').then(function (r) { return r.json(); }).then(function (data) {
      var list = (data && data.styles) || [];
      if (!list.length) { $('styleStrip').innerHTML = '<p class="hint">画风加载失败，刷新重试</p>'; return; }
      Store.styles = list;
      var hintEl = $('styleHint');
      if (hintEl && data.hint) { hintEl.textContent = data.hint; }
      renderStyleStrip();
    }).catch(function () {
      $('styleStrip').innerHTML = '<p class="hint">画风加载失败，刷新重试</p>';
    });
  }

  function renderStyleStrip() {
    var strip = $('styleStrip');
    var avail = Store.styles.filter(function (s) {
      return Store.subject === 'prop' ? s.scope !== 'character' : true;
    });
    if (!avail.some(function (s) { return s.id === Store.styleId; })) {
      Store.styleId = avail.length ? avail[0].id : 'original';
    }
    strip.innerHTML = avail.map(function (s) {
      var art = s.thumb
        ? '<img src="' + s.thumb + '" alt="' + s.label + '画风预览" />'
        : '<span class="style-letter">' + s.label.charAt(0) + '</span>';
      return '<button type="button" class="style-card' + (s.id === Store.styleId ? ' cur' : '') + '" data-sid="' + s.id + '" title="' + s.label + '">'
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
        Store.imgDataUrl = dataUrl;
        $('previewImg').src = dataUrl;
        $('fileName').textContent = file.name || '未命名图片';
        $('fileSize').textContent = formatSize(file.size) + '（上传前自动压缩到 1024px）';
        $('dzEmpty').hidden = true;
        $('dzPreview').hidden = false;
        updateSteps();
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

  function downscale(dataUrl, cb) {
    var img = new Image();
    img.onload = function () {
      var long = Math.max(img.width, img.height);
      if (long <= 1024) { cb(dataUrl); return; }
      var ratio = 1024 / long;
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      try { cb(canvas.toDataURL('image/png')); }
      catch (_) { cb(dataUrl); }
    };
    img.onerror = function () { cb(dataUrl); };
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

  /* ---------- 主体类型切换 ---------- */
  function bindSubject() {
    var segC = $('segCharacter');
    var segP = $('segProp');
    function setSubject(v) {
      Store.subject = v;
      segC.classList.toggle('cur', v === 'character');
      segP.classList.toggle('cur', v === 'prop');
      segC.setAttribute('aria-checked', String(v === 'character'));
      segP.setAttribute('aria-checked', String(v === 'prop'));
      renderStyleStrip();
    }
    segC.addEventListener('click', function () { setSubject('character'); });
    segP.addEventListener('click', function () { setSubject('prop'); });
  }

  /* ---------- 生成流程 ---------- */
  var GEN_POLL_INTERVAL = 4000;
  var GEN_POLL_MAX = 150;          /* 4s × 150 = 10 分钟上限 */
  var STAGE_HINTS = [
    [0,  'AI 正在读懂你的图片…'],
    [20, '正在生成像素底稿…'],
    [50, '正在切格与配色（五档规格）…'],
    [85, '正在拼装可编辑图纸…']
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
      /* 关掉 SSE 观察连接（token 失配让 pump 循环自行退出，AbortController 直接断流） */
      Store.watchToken += 1;
      if (Store.watchAbort) { try { Store.watchAbort.abort(); } catch (_) {} Store.watchAbort = null; }
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

  function openTaskHtml(taskId) {
    window.open(PIXELART_API + '/task/html?id=' + encodeURIComponent(taskId), '_blank');
  }

  function showDone(taskId) {
    Store.lastTaskId = taskId;
    $('genStatus').hidden = true;
    $('genDone').hidden = false;
    var wasRegen = Store.regenActive;
    Store.regenActive = false;
    $('genDoneMsg').textContent = wasRegen
      ? '重转完成！近色已合并，原图纸仍保留。'
      : '图纸已生成！新标签页可能被拦截，也可以点这里打开。';
    studioMsg(wasRegen ? '重转完成，未消耗积分。图纸页里可切规格、改色号、导出。' : '生成完成，消耗 1 积分。图纸页里可切规格、改色号、导出。', false);
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
    $('genDone').hidden = true;
    $('genStatusText').textContent = '正在扣除积分…';
    var startedAt = Math.floor(Date.now() / 1000);

    /* 1. 先扣积分（余额不足 → 打开钱包） */
    wallet.consume().then(function (r) {
      Store.lastTxnId = r && r.txnId;
      $('genStatusText').textContent = '正在提交任务…';
      /* 2. 提交生成任务 */
      return fetch(PIXELART_API + '/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: Store.imgDataUrl,
          subject: Store.subject,
          styleId: Store.styleId,
          notes: notes
        })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || !data.taskId) {
            var e = new Error((data.error && data.error.message) || '提交失败，请稍后重试');
            throw e;
          }
          return data.taskId;
        });
      });
    }).then(function (taskId) {
      /* 3. SSE 心跳流跟踪任务（对齐 /api/ai 防 524 的成熟方案）：
            服务端每 2s 写心跳注释，连接永不空闲，托管平台 30s 空闲 524 不会触发；
            心跳顺便驱动「已等待 N 秒」提示，status 事件驱动完成/失败。
            流不可用时自动降级为 4s 轮询。 */
      watchTask(taskId, startedAt);
      updateSteps();
    }).catch(function (err) {
      setGenerating(false);
      if (err && err.insufficient) {
        studioMsg(err.message, true);
        auth.openWallet();
        return;
      }
      /* 扣费成功但提交失败 → 退回 */
      if (Store.lastTxnId) { wallet.refund(Store.lastTxnId); }
      studioMsg((err && err.message) || '生成失败，请稍后重试（已扣积分将自动退回）', true);
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
      watchTask(taskId, startedAt);
      updateSteps();
    }).catch(function (err) {
      setGenerating(false);
      Store.regenActive = false;
      studioMsg((err && err.message) || '重转失败，请稍后重试', true);
    });
  }

  /* ---------- 任务观察：SSE 心跳流（首选） + 轮询（降级） ---------- */

  function onTaskDone(taskId) {
    setGenerating(false);
    openTaskHtml(taskId);
    showDone(taskId);
    updateSteps();
  }

  function onTaskFailed(st) {
    setGenerating(false);
    updateSteps();
    var wasRegen = Store.regenActive;
    Store.regenActive = false;
    if (wasRegen) {
      studioMsg('重转失败：' + (st.error || '未知错误').slice(0, 160) + '（未扣积分，原图纸不受影响）', true);
      return;
    }
    wallet.refund(Store.lastTxnId);
    studioMsg('生成失败：' + (st.error || '未知错误').slice(0, 160) + '（1 积分已退回）', true);
  }

  /* SSE 流：每 2s 一行 ": wait Ns" 心跳（驱动阶段提示），状态变化推 event: status */
  function watchTask(taskId, startedAt) {
    var token = ++Store.watchToken;
    var ac = (typeof window.AbortController === 'function') ? new window.AbortController() : null;
    Store.watchAbort = ac;
    var opts = ac ? { signal: ac.signal } : undefined;
    fetch(PIXELART_API + '/task/stream?id=' + encodeURIComponent(taskId), opts)
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.getReader) { throw new Error('stream unavailable'); }
        var reader = res.body.getReader();
        var decoder = (typeof TextDecoder === 'function') ? new TextDecoder('utf-8') : null;
        var buf = '';
        function pump() {
          if (token !== Store.watchToken) { try { reader.cancel(); } catch (_) {} return; }
          return reader.read().then(function (r) {
            if (r.done) { return; }
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
                    if (st.status === 'done') { try { reader.cancel(); } catch (_) {} return onTaskDone(taskId); }
                    if (st.status === 'failed') { try { reader.cancel(); } catch (_) {} return onTaskFailed(st); }
                  }
                }
              }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        if (token !== Store.watchToken) { return; } /* 已取消/已开新一轮 */
        startPolling(taskId, startedAt);            /* 流不可用 → 降级轮询 */
      });
  }

  /* 降级：4s 间隔轮询（旧行为，SSE 不可用时兜底） */
  function startPolling(taskId, startedAt) {
    var polls = 0;
    Store.pollTimer = setInterval(function () {
      polls += 1;
      var sec = Math.floor(Date.now() / 1000) - startedAt;
      $('genStatusText').textContent = stageText(sec);
      if (polls > GEN_POLL_MAX) {
        setGenerating(false);
        studioMsg('生成超时，积分将在确认失败后自动退回；也可联系管理员处理', true);
        wallet.refund(Store.lastTxnId);
        return;
      }
      fetch(PIXELART_API + '/task?id=' + encodeURIComponent(taskId))
        .then(function (r) { return r.json(); })
        .then(function (st) {
          if (st.status === 'done') { onTaskDone(taskId); }
          else if (st.status === 'failed') { onTaskFailed(st); }
        }).catch(function () { /* 单次轮询失败忽略，下一轮再试 */ });
    }, GEN_POLL_INTERVAL);
  }

  function bindGenerate() {
    $('btnGenerate').addEventListener('click', generateFlow);
    $('btnCancelPoll').addEventListener('click', function () {
      setGenerating(false);
      studioMsg('已切到后台等待，完成后不会自动弹出；本轮积分不退，图纸请稍后重试或联系管理员', true);
    });
    $('btnOpenResult').addEventListener('click', function () {
      if (Store.lastTaskId) { openTaskHtml(Store.lastTaskId); }
    });
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
    bindSubject();
    bindGenerate();
    loadStyles();
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

  /* 测试钩子：jsdom 测试直接驱动内部状态与流程（线上无依赖方，仅挂 window 属性） */
  window.__pixelart = { store: Store, generateFlow: generateFlow, regenFlow: regenFlow, acceptFile: acceptFile, renderStyleStrip: renderStyleStrip };

  restoreAuth();
})();
