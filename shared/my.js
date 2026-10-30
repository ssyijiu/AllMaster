/* 我的作品（平台层共享页 /my）
 * 数据来源：
 *   头像作品 → 云存储 users/<uid>/history/（app.js 生成成功即上传，文件名带时间/模式/画风）
 *   拼豆图纸 → 云存储 users/<uid>/pixelart/<ts>-<taskId>.json（元数据）
 *              + 服务器长期归档 /api/pixelart/task/cover|html?id=（封面与图纸本体）
 *   积分明细 → 云数据库 app_wallet_txns（RLS 只读本人）
 * 展示上限：每个产品最近 30 条 / 90 天（老于 90 天的不显示，物理清理随 P3 落地）
 */
(function () {
  'use strict';

  var WORK_LIMIT = 30;
  var WORK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  var AVATAR_PREFIX = 'users/';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    /* 平台层（Platform.setup）需要的元素 */
    btnLogin: $('btnLogin'),
    userChip: $('userChip'),
    userChipText: $('userChipText'),
    btnSignOut: $('btnSignOut'),
    btnWallet: $('btnWallet'),
    walletBalance: $('walletBalance'),
    loginModal: $('loginModal'),
    btnCloseLogin: $('btnCloseLogin'),
    loginPhone: $('loginPhone'),
    loginCode: $('loginCode'),
    errPhone: $('errPhone'),
    errCode: $('errCode'),
    btnSendCode: $('btnSendCode'),
    btnPhoneLogin: $('btnPhoneLogin'),
    btnWechatLogin: $('btnWechatLogin'),
    loginMsg: $('loginMsg'),
    walletModal: $('walletModal'),
    btnCloseWallet: $('btnCloseWallet'),
    walletBalanceBig: $('walletBalanceBig'),
    productGrid: $('productGrid'),
    payChannelsNote: $('payChannelsNote'),
    redeemCode: $('redeemCode'),
    btnRedeem: $('btnRedeem'),
    walletMsg: $('walletMsg'),
    txnHistory: $('txnHistory'),
    /* 本页自有 */
    tabWorks: $('tabWorks'),
    tabTxns: $('tabTxns'),
    panelWorks: $('panelWorks'),
    panelTxns: $('panelTxns'),
    workFilters: $('workFilters'),
    worksGrid: $('worksGrid'),
    worksEmpty: $('worksEmpty'),
    txnList: $('txnList'),
    lightbox: $('lightbox'),
    lightboxImg: $('lightboxImg'),
    btnCloseLightbox: $('btnCloseLightbox')
  };

  var Store = { state: { user: null, works: [], filter: 'all', loading: false, error: '' } };

  function showHint(msg, isError) {
    /* 页面无独立提示条，借钱包弹窗提示位（不打开弹窗时静默） */
    if (els.walletMsg && !els.walletModal.hidden) { els.walletMsg.textContent = msg || ''; }
    if (msg && isError) { console.warn('[my] ' + msg); }
  }

  var auth = Platform.setup({
    els: els,
    store: Store,
    showHint: showHint,
    callbackPath: '/my',
    userChipTitle: '已登录，作品与积分全平台通用',
    productSlug: '',
    onLoginSuccess: function () { loadAll(); },
    onSignOut: function () { Store.state.works = []; renderWorks(); renderTxnsEmpty(); }
  });

  /* ---------- 标签切换 ---------- */
  function switchTab(name) {
    var works = name === 'works';
    els.tabWorks.classList.toggle('cur', works);
    els.tabTxns.classList.toggle('cur', !works);
    els.tabWorks.setAttribute('aria-selected', works ? 'true' : 'false');
    els.tabTxns.setAttribute('aria-selected', works ? 'false' : 'true');
    els.panelWorks.hidden = !works;
    els.panelTxns.hidden = works;
    if (!works) { loadTxns(); }
  }

  /* ---------- 云端作品：头像（storage 列表 + 签名 URL） ---------- */
  function parseAvatarName(path, prefix) {
    var name = path.slice(prefix.length);
    var parts = name.split('-');
    return {
      time: parseInt(parts[0], 10) || 0,
      mode: parts[1] === 'ai' ? 'ai' : 'local',
      styleId: parts.slice(2).join('-').replace(/\.(png|jpg|jpeg|webp)$/i, '')
    };
  }

  function loadAvatarWorks(uid) {
    var cloud = Platform.cloud.getClient();
    if (!cloud || !cloud.storage || !uid) { return Promise.resolve([]); }
    var prefix = AVATAR_PREFIX + uid + '/history/';
    return Promise.resolve(cloud.storage.list(prefix, {
      limit: WORK_LIMIT,
      sortBy: { column: 'created_at', order: 'desc' }
    })).then(function (res) {
      if (!res || res.error) { Store.state.error = '云端列表读取失败'; return []; }
      /* 条目字段不稳定（可能是完整 key，也可能只有文件名），统一由平台层归一化 */
      var keys = Platform.storageListKeys(prefix, res);
      if (!keys.length) { return []; }
      return Platform.storageSigned(cloud, keys, 3600).then(function (signed) {
        if (!signed.length) { Store.state.error = '作品图片地址生成失败'; return []; }
        var out = [];
        for (var i = 0; i < signed.length; i++) {
          var meta = parseAvatarName(signed[i].path, prefix);
          out.push({
            kind: 'avatar',
            title: '成像头像',
            styleId: meta.styleId,
            mode: meta.mode,
            time: meta.time || Date.now(),
            src: signed[i].url,
            path: signed[i].path
          });
        }
        return out;
      });
    }).catch(function () { Store.state.error = '云端读取异常'; return []; });
  }

  /* ---------- 云端作品：拼豆图纸 ----------
   * 云端只存一行几百字节的元数据（users/<uid>/pixelart/<ts>-<taskId>.json）；
   * 封面和图纸都是大文件，留在服务器长期归档，这里用同源接口取（无需签名、长缓存）。 */
  function pixelartApiBase(v) {
    return v === '/api/pixelart-vp' ? '/api/pixelart-vp' : '/api/pixelart';
  }

  function blobText(blob) {
    if (!blob) { return Promise.resolve(''); }
    if (typeof blob.text === 'function') { return blob.text(); }
    return new Promise(function (resolve) {
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { resolve(''); };
        fr.readAsText(blob);
      } catch (_) { resolve(''); }
    });
  }

  function mapPixelartRow(prefix, key, meta) {
    var name = key.slice(prefix.length).replace(/\.json$/i, '');
    var bits = name.split('-');
    var ts = parseInt(bits[0], 10) || 0;
    var taskId = (meta && meta.taskId) || bits[1] || '';
    var apiBase = pixelartApiBase(meta && meta.apiBase);
    var label = (meta && meta.styleLabel) || '';
    return {
      kind: 'pixelart',
      path: key,
      taskId: taskId,
      apiBase: apiBase,
      styleLabel: label,
      notes: (meta && meta.notes) || '',
      title: (meta && meta.title) || (label ? label + '拼豆图纸' : '拼豆图纸'),
      time: (meta && meta.createdAt) || ts || Date.now(),
      src: taskId ? apiBase + '/task/cover?id=' + encodeURIComponent(taskId) : '',
      openUrl: taskId ? apiBase + '/task/html?id=' + encodeURIComponent(taskId) : ''
    };
  }

  function loadPixelartWorks(uid) {
    var cloud = Platform.cloud.getClient();
    if (!cloud || !cloud.storage || !uid) { return Promise.resolve([]); }
    var prefix = AVATAR_PREFIX + uid + '/pixelart/';
    return Promise.resolve(cloud.storage.list(prefix, {
      limit: WORK_LIMIT,
      sortBy: { column: 'created_at', order: 'desc' }
    })).then(function (res) {
      if (!res || res.error) { return []; }
      var keys = Platform.storageListKeys(prefix, res).filter(function (k) { return /\.json$/i.test(k); });
      if (!keys.length) { return []; }
      return Promise.all(keys.map(function (key) {
        var read;
        try { read = cloud.storage.download(key); } catch (_) { read = null; }
        return Promise.resolve(read).then(function (r) {
          if (!r || r.error || !r.data) { return mapPixelartRow(prefix, key, null); }
          return blobText(r.data).then(function (txt) {
            var meta = null;
            try { meta = JSON.parse(txt); } catch (_) { meta = null; }
            /* 读不到内容也照常显示卡片：文件名里就带着时间与 taskId，图纸仍能打开 */
            return mapPixelartRow(prefix, key, meta);
          });
        }).catch(function () { return mapPixelartRow(prefix, key, null); });
      }));
    }).catch(function () { return []; });
  }

  function loadWorks() {
    var user = Store.state.user;
    if (!user) { Store.state.works = []; renderWorks(); return Promise.resolve(); }
    Store.state.loading = true;
    Store.state.error = '';
    renderWorks();
    return Promise.all([loadAvatarWorks(user.id), loadPixelartWorks(user.id)])
      .then(function (lists) {
        var all = lists[0].concat(lists[1]);
        var now = Date.now();
        all = all.filter(function (w) { return now - w.time <= WORK_TTL_MS; });
        all.sort(function (a, b) { return b.time - a.time; });
        Store.state.works = all;
        Store.state.loading = false;
        renderWorks();
      })
      .catch(function () {
        Store.state.loading = false;
        Store.state.works = [];
        renderWorks();
      });
  }

  function fmtTime(ts) {
    if (!ts) { return ''; }
    var d = new Date(ts);
    if (isNaN(d.getTime())) { return ''; }
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderWorks() {
    var grid = els.worksGrid;
    var empty = els.worksEmpty;
    grid.innerHTML = '';
    var user = Store.state.user;
    if (!user) {
      empty.hidden = false;
      empty.innerHTML = '<b>登录后查看你的作品</b>生成过的头像与图纸会保存在云端，换设备也不丢。<br /><button class="btn primary" type="button" id="emptyLogin" style="margin-top:14px;">立即登录</button>';
      var b = $('emptyLogin');
      if (b) { b.addEventListener('click', function () { auth.openLogin(); }); }
      return;
    }
    if (Store.state.loading) {
      empty.hidden = false;
      empty.innerHTML = '<b>加载中…</b>正在同步云端作品';
      return;
    }
    var filter = Store.state.filter;
    var list = Store.state.works.filter(function (w) { return filter === 'all' || w.kind === filter; });
    if (!list.length) {
      empty.hidden = false;
      /* 读取失败不再伪装成“没有作品”：否则线上故障永远看不见 */
      if (Store.state.error) {
        empty.innerHTML = '<b>' + Store.state.error + '</b>作品保存在云端，网络或登录状态异常时会取不到。' +
          '<br /><button class="btn secondary" type="button" id="emptyRetry" style="margin-top:14px;">重新加载</button>';
        var rb = $('emptyRetry');
        if (rb) { rb.addEventListener('click', function () { loadWorks(); }); }
        return;
      }
      empty.innerHTML = filter === 'pixelart'
        ? '<b>还没有拼豆图纸</b>生成完成会自动保存到这里，图纸长期可打开。<br /><a class="btn primary" style="margin-top:14px;display:inline-block;text-decoration:none;" href="/">去生成一张</a>'
        : '<b>还没有作品</b>生成结果会自动保存到这里。<br /><a class="btn primary" style="margin-top:14px;display:inline-block;text-decoration:none;" href="' + (filter === 'avatar' ? '/apps/avatar/' : '/') + '">去生成</a>';
      return;
    }
    empty.hidden = true;
    list.forEach(function (w) {
      if (w.kind === 'pixelart') { renderPixelartCard(w, grid); return; }
      var card = document.createElement('div');
      card.className = 'work-card';
      card.innerHTML =
        '<button class="work-thumb" type="button" aria-label="查看大图"><img alt="作品缩略图" /></button>' +
        '<div class="work-meta">' +
          '<div class="work-title"></div>' +
          '<div class="work-sub"></div>' +
        '</div>' +
        '<div class="work-actions">' +
          '<button class="btn secondary small" type="button" data-act="download">下载</button>' +
          '<button class="btn ghost small" type="button" data-act="delete">删除</button>' +
        '</div>';
      var img = card.querySelector('img');
      img.src = w.src;
      card.querySelector('.work-title').textContent = w.kind === 'pixelart' ? '拼豆图纸' : (w.styleId ? '头像 · ' + w.styleId : '头像');
      card.querySelector('.work-sub').textContent = fmtTime(w.time);
      card.querySelector('.work-thumb').addEventListener('click', function () { openLightbox(w.src); });
      card.querySelector('[data-act="download"]').addEventListener('click', function () { downloadWork(w); });
      card.querySelector('[data-act="delete"]').addEventListener('click', function () { deleteWork(w, card); });
      grid.appendChild(card);
    });
  }

  /* 拼豆卡片：封面 + 点开图纸（图纸本身是交互 HTML，新标签打开） */
  function renderPixelartCard(w, grid) {
    var card = document.createElement('div');
    card.className = 'work-card work-card--pixelart';
    card.innerHTML =
      '<button class="work-thumb" type="button" aria-label="打开拼豆图纸"><img alt="拼豆图纸封面" loading="lazy" /></button>' +
      '<div class="work-meta">' +
        '<div class="work-title"></div>' +
        '<div class="work-sub"></div>' +
      '</div>' +
      '<div class="work-actions">' +
        '<button class="btn primary small" type="button" data-act="open">打开图纸</button>' +
        '<button class="btn ghost small" type="button" data-act="delete">删除</button>' +
      '</div>';
    var img = card.querySelector('img');
    if (w.src) {
      img.src = w.src;
      img.addEventListener('error', function () { card.classList.add('no-cover'); });
    } else {
      card.classList.add('no-cover');
    }
    card.querySelector('.work-title').textContent = w.title || '拼豆图纸';
    card.querySelector('.work-sub').textContent =
      (w.notes ? w.notes + ' · ' : '') + fmtTime(w.time);
    var open = function () { if (w.openUrl) { window.open(w.openUrl, '_blank', 'noopener'); } };
    card.querySelector('.work-thumb').addEventListener('click', open);
    card.querySelector('[data-act="open"]').addEventListener('click', open);
    card.querySelector('[data-act="delete"]').addEventListener('click', function () { deleteWork(w, card); });
    grid.appendChild(card);
  }

  function openLightbox(src) {
    els.lightboxImg.src = src;
    els.lightbox.hidden = false;
  }

  function downloadWork(w) {
    /* 签名 URL 带参数，用 a[download] 会被忽略跨域限制，直接新窗口打开由浏览器接管 */
    var a = document.createElement('a');
    a.href = w.src;
    a.target = '_blank';
    a.rel = 'noopener';
    a.download = (w.kind === 'avatar' ? 'avatar-' : 'pixelart-') + w.time + '.png';
    a.click();
  }

  function deleteWork(w, card) {
    var cloud = Platform.cloud.getClient();
    if (!cloud || !cloud.storage || !cloud.storage.remove) { return; }
    var tip = w.kind === 'pixelart'
      ? '从作品列表移除？图纸在服务器仍保留一段时间，用原链接还能打开。'
      : '删除后不可恢复，确定删除这个作品？';
    if (!window.confirm(tip)) { return; }
    card.style.opacity = '0.4';
    Promise.resolve(cloud.storage.remove([w.path])).then(function (res) {
      if (res && res.error) { card.style.opacity = '1'; showHint('删除失败，请稍后重试', true); return; }
      Store.state.works = Store.state.works.filter(function (x) { return x.path !== w.path; });
      renderWorks();
    }).catch(function () { card.style.opacity = '1'; showHint('删除失败，请稍后重试', true); });
  }

  /* ---------- 积分明细 ---------- */
  var TXN_KIND_TEXT = { consume: '生成消费', refund: '失败退回', redeem: '兑换码兑换', grant: '管理员赠送', pay: '充值到账' };

  function fmtTxnTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function maskRedeemCode(ref) {
    var s = String(ref || '');
    return s.length <= 4 ? s : s.slice(0, 2) + '****' + s.slice(-2);
  }

  function renderTxns(rows) {
    els.txnList.innerHTML = '';
    if (!rows.length) {
      els.txnList.innerHTML = '<p class="hint">暂无积分记录</p>';
      return;
    }
    rows.forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'txn-item';
      item.innerHTML =
        '<div class="t-main"><div class="t-kind"></div><div class="t-note"></div></div>' +
        '<div class="t-credits"></div><div class="t-time"></div>';
      var credits = Number(t.credits) || 0;
      item.querySelector('.t-kind').textContent = TXN_KIND_TEXT[t.kind] || t.kind || '记录';
      item.querySelector('.t-note').textContent =
        t.note || (t.kind === 'redeem' ? '兑换码 ' + maskRedeemCode(t.ref) : '');
      var c = item.querySelector('.t-credits');
      c.textContent = (credits > 0 ? '+' : '') + credits;
      c.classList.add(credits > 0 ? 'plus' : 'minus');
      item.querySelector('.t-time').textContent = fmtTxnTime(t.created_at);
      els.txnList.appendChild(item);
    });
  }

  function renderTxnsEmpty() { els.txnList.innerHTML = '<p class="hint">登录后查看积分明细</p>'; }

  function loadTxns() {
    var cloud = Platform.cloud.getClient();
    if (!Store.state.user) { renderTxnsEmpty(); return; }
    if (!cloud || !cloud.database || !cloud.database.from) { els.txnList.innerHTML = '<p class="hint">云端未就绪，请刷新重试</p>'; return; }
    els.txnList.innerHTML = '<p class="hint">加载中…</p>';
    Promise.resolve(cloud.database.from('app_wallet_txns').select('*')
      .order('created_at', { ascending: false }).limit(50))
      .then(function (res) { renderTxns((res && res.data) || []); })
      .catch(function () { els.txnList.innerHTML = '<p class="hint">明细加载失败，请稍后重试</p>'; });
  }

  /* ---------- 启动 ---------- */
  function loadAll() { loadWorks(); if (!els.panelTxns.hidden) { loadTxns(); } }

  function boot() {
    els.tabWorks.addEventListener('click', function () { switchTab('works'); });
    els.tabTxns.addEventListener('click', function () { switchTab('txns'); });
    els.workFilters.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chip') : null;
      if (!btn || !btn.dataset.filter) { return; }
      Store.state.filter = btn.dataset.filter;
      Array.prototype.forEach.call(els.workFilters.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('cur', c === btn);
      });
      renderWorks();
    });
    els.btnCloseLightbox.addEventListener('click', function () { els.lightbox.hidden = true; els.lightboxImg.src = ''; });
    els.lightbox.addEventListener('click', function (e) {
      if (e.target === els.lightbox) { els.lightbox.hidden = true; els.lightboxImg.src = ''; }
    });

    /* OAuth 回调：带了 code/provider 说明是登录回跳，先交给平台层处理再启动 */
    var url = new URL(location.href);
    var provider = url.searchParams.get('provider');
    var cloud = Platform.cloud.getClient();
    if ((provider === 'workbuddy' || provider === 'wechat') && cloud && cloud.auth) {
      var fn = provider === 'workbuddy' ? cloud.auth.handleWorkBuddyCallback : cloud.auth.handleWechatWebCallback;
      if (typeof fn === 'function') {
        Promise.resolve(fn.call(cloud.auth)).then(function (res) {
          ['code', 'state', 'provider'].forEach(function (k) { url.searchParams.delete(k); });
          history.replaceState(null, '', url.pathname + url.search + url.hash);
          if (res && res.data && res.data.user) { auth.applySession(res.data); }
          auth.ensureAuth().then(function () { loadAll(); });
        }).catch(function () { auth.ensureAuth().then(function () { loadAll(); }); });
        return;
      }
    }

    if (!cloud || !cloud.auth) { auth.renderAuthUI(); renderWorks(); renderTxnsEmpty(); return; }
    Promise.resolve(cloud.auth.getSession()).then(function (res) {
      auth.applySession(res && res.data ? res.data : null);
      loadAll();
    }).catch(function () { auth.renderAuthUI(); renderWorks(); renderTxnsEmpty(); });
    try {
      cloud.auth.onAuthStateChange(function (event, session) {
        auth.applySession(session || null);
        loadAll();
      });
    } catch (_) { /* SDK 不支持订阅时忽略 */ }
  }

  boot();
})();
