/* =========================================================
 * 平台层（所有产品共用）：云服务 / 登录 / 积分钱包 / 支付
 * - 本文件不含任何产品业务；产品通过 Platform.setup(ctx) 接入
 *   ctx: { els, store, showHint, callbackPath, userChipTitle, productSlug,
 *          onLoginSuccess(user), onSignOut() }
 *     productSlug（可选）：产品隔离标识。传入后钱包套餐只显示
 *     本产品（app_products.product === slug）或未标注产品的通用套餐；
 *     不传则显示全部套餐（单产品向后兼容）。
 * - 返回: { applySession, openLogin, closeLogin, openWallet, closeWallet,
 *           walletService, loadPayChannels, handlePaidReturn,
 *           bindAuthEvents, renderAuthUI }
 * ========================================================= */
(function () {
  'use strict';

    /* 风格/服务商配置存于云数据库（管理后台维护）：
     * app_config —— 风格与服务商元信息，公开只读，仅管理员账号可写
     * app_secrets —— 管理专用（Key 备份与支付密钥），仅管理员可读；
     *                生成用 Key 已下沉到服务器 .ai-config.json，前端不再持有 */
    var CONFIG_TABLE = 'app_config';
    var CONFIG_ID = 'default';


    /* 2026-10-31 起不再依赖 WorkBuddy 云：登录/账本/文件全部由本站 server/ 提供，
     * 浏览器侧通过 shared/local-cloud.js 暴露同名 SDK（auth/database/storage）。
     * 保留变量名 PUBLIC_CONFIG 只为不打断已有调用点（如产品页读 productSlug）。 */
    var PUBLIC_CONFIG = {
      endpoint: (window.location && window.location.origin && window.location.origin !== 'null')
        ? window.location.origin : '',
      selfHosted: true
    };

    /* --- cloudService：自建服务客户端（SDK 缺失时优雅降级为 null） ---
     * 主路径是 shared/local-cloud.js；保留 WorkBuddyCloud 分支只为两件事：
     * ① 旧测试夹具（mock 的是 window.WorkBuddyCloud）仍可复用；
     * ② 万一 local-cloud.js 版本没跟上，页面不至于整块功能塌掉。 */
    var cloudService = {
      _client: null,
      getClient: function () {
        if (this._client) { return this._client; }
        try {
          if (window.LocalCloud && window.LocalCloud.createClient) {
            this._client = window.LocalCloud.createClient();
            return this._client;
          }
          if (window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud) {
            /* 旧 SDK 形状要求三个字段都在（缺一会直接抛错）。这里用占位值满足它，
             * 实际不会发出任何云端请求 —— 只是为了旧夹具/旧缓存页面不整块塌掉。 */
            this._client = window.WorkBuddyCloud.createWorkBuddyCloud({
              endpoint: PUBLIC_CONFIG.endpoint || 'http://localhost',
              oauthRelayBaseUrl: 'legacy',
              publishableKey: 'legacy'
            });
            return this._client;
          }
        } catch (_) { return null; }
        return null;
      }
    };

  var Platform = window.Platform = {
    cloud: cloudService,
    PUBLIC_CONFIG: PUBLIC_CONFIG,
    CONFIG_TABLE: CONFIG_TABLE,
    CONFIG_ID: CONFIG_ID
  };

  /* =========================================================
   * 存储列表：条目 → 完整 object key
   * ---------------------------------------------------------
   * 云端 list 返回的条目字段并不稳定：有时给完整 key
   * （users/<uid>/history/a.png），有时只给相对名（a.png 或 history/a.png）。
   * 2026-10-30 线上问题：/my「我的作品」与头像「云端历史」都把 it.path 当完整
   * 路径用，再按 indexOf(prefix) === 0 过滤 —— 相对名全被丢掉，paths 变空，
   * 于是**一次签名请求都不会发出**，页面永远显示“没有作品”。
   * 统一在这里归一化：能识别的绝对 key 原样保留，否则按 prefix + basename 拼。
   * ========================================================= */
  /* 列表响应的「数组」可能被包在任何一层：{items}/{entries}/{objects}/
   * {files}/{rows}/{list}/{data}。2026-10-31 又踩了一次：只认 data.items，
   * 服务端回的是 data.entries 时整页静默空态。这里统一逐层解包。 */
  var LIST_KEYS = ['items', 'entries', 'objects', 'files', 'rows', 'list', 'data'];

  Platform.storageItems = function (res) {
    var d = res;
    for (var i = 0; i < 5; i++) {
      if (Array.isArray(d)) { return d; }
      if (!d || typeof d !== 'object') { return []; }
      var next = null;
      for (var k = 0; k < LIST_KEYS.length; k++) {
        var v = d[LIST_KEYS[k]];
        if (Array.isArray(v) || (v && typeof v === 'object')) { next = v; break; }
      }
      if (!next) { return []; }
      d = next;
    }
    return Array.isArray(d) ? d : [];
  };

  Platform.storageItemKey = function (prefix, item) {
    if (!item) { return ''; }
    /* 也允许条目就是一个字符串（路径本身） */
    var raw = (typeof item === 'string')
      ? item
      : (item.path || item.objectKey || item.object_key || item.filePath ||
         item.file_path || item.key || item.name || '');
    raw = String(raw || '').replace(/^\/+/, '');
    if (!raw) { return ''; }
    if (raw.indexOf('users/') === 0 || raw.indexOf('shared/') === 0) { return raw; }
    var base = raw.split('/').pop();
    if (!base) { return ''; }
    var p = String(prefix || '');
    if (p && p.slice(-1) !== '/') { p += '/'; }
    return p + base;
  };

  /* 列表响应 → 文件 key 数组（跳过子目录占位项、去重） */
  Platform.storageListKeys = function (prefix, res) {
    var items = Platform.storageItems(res);
    if (!items.length) { return []; }
    var out = [], seen = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) { continue; }
      if (typeof it === 'string') {
        var sk = Platform.storageItemKey(prefix, it);
        if (sk && !seen[sk]) { seen[sk] = 1; out.push(sk); }
        continue;
      }
      if (it.type === 'folder' || it.isFolder === true || it.is_folder === true) { continue; }
      /* 子目录占位项：id 为 null 且没有 metadata；带 metadata 的才是文件 */
      if (Object.prototype.hasOwnProperty.call(it, 'id') && it.id === null && !it.metadata) { continue; }
      var key = Platform.storageItemKey(prefix, it);
      if (!key || seen[key]) { continue; }
      seen[key] = 1;
      out.push(key);
    }
    return out;
  };

  /* 批量签名 → [{ path, url }]（容忍 signedUrl / signed_url / url / 纯字符串） */
  Platform.storageSigned = function (cloud, keys, ttl) {
    if (!cloud || !cloud.storage || !cloud.storage.createSignedUrls || !keys || !keys.length) {
      return Promise.resolve([]);
    }
    return Promise.resolve(cloud.storage.createSignedUrls(keys, ttl || 3600))
      .then(function (res) {
        if (!res || res.error) { return []; }
        var list = Platform.storageItems(res);
        if (!list.length) { return []; }
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          var url = typeof e === 'string'
            ? e
            : (e && (e.signedUrl || e.signed_url || e.url || e.signedURL));
          if (!url) { continue; }
          var p = (e && typeof e === 'object' && (e.path || e.key)) || keys[i] || keys[0];
          if (p && p.indexOf('users/') !== 0 && p.indexOf('shared/') !== 0) { p = keys[i] || p; }
          out.push({ path: p, url: String(url) });
        }
        return out;
      })
      .catch(function () { return []; });
  };

  /* ---------- 缩略图（2026-10-31 性能修复） ----------
   * 背景：头像作品是 1–2MB 原图，/my 一页 30 张 ≈ 60MB，跨境链路（dotbeads.online
   * 在雅加达）下要好几分钟。约定：<原文件>.thumb.jpg 是它的 400px JPEG 缩略图；
   * 展示用缩略图，点开大图/下载才用原图。 */
  var THUMB_SUFFIX = '.thumb.jpg';

  /* 从列表 keys 里分离缩略图与原图配对。
   * 返回 { photos: [原图key], thumbFor(key) → 缩略图key 或 '' } */
  Platform.pairThumbs = function (keys) {
    var isThumb = {}, baseOf = {};
    if (keys && keys.length) {
      for (var i = 0; i < keys.length; i++) {
        var k = String(keys[i] || '');
        if (k.length > THUMB_SUFFIX.length &&
            k.slice(-THUMB_SUFFIX.length).toLowerCase() === THUMB_SUFFIX) {
          isThumb[k] = 1;
          baseOf[k.slice(0, -THUMB_SUFFIX.length)] = k;
        }
      }
    }
    var photos = [];
    if (keys && keys.length) {
      for (var j = 0; j < keys.length; j++) {
        if (!isThumb[keys[j]]) { photos.push(keys[j]); }
      }
    }
    return {
      photos: photos,
      thumbFor: function (p) { return baseOf[p] || ''; }
    };
  };

  /* 把图片（blob 或 URL）缩成 maxW 宽的 JPEG blob。失败返回 null，绝不抛。
   * URL 方式需要云端带 CORS 头（canvas 读跨域像素要求），没有就失败——
   * 调用方按 null 降级即可，不影响图片本身展示。 */
  Platform.makeThumb = function (source, maxW) {
    return new Promise(function (resolve) {
      /* 环境探测：无 canvas（老浏览器/测试环境）直接降级，绝不挂起调用方 */
      try {
        var probe = document.createElement('canvas');
        var ctx = probe.getContext && probe.getContext('2d');
        if (!ctx) { return resolve(null); }
      } catch (_) { return resolve(null); }
      var objUrl = '';
      var created = false;
      var settled = false;
      var done = function (b) {
        if (settled) { return; }
        settled = true;
        if (created && objUrl) { try { URL.revokeObjectURL(objUrl); } catch (_) {} }
        resolve(b || null);
      };
      /* Image 加载事件丢失（极端网络/实现差异）的兜底：8 秒后放弃 */
      var guard = null;
      try { guard = setTimeout(done, 8000); } catch (_) {}
      var finish = function (b) { if (guard) { try { clearTimeout(guard); } catch (_) {} } done(b); };
      try {
        if (typeof source === 'string') { objUrl = source; }
        else { objUrl = URL.createObjectURL(source); created = true; }
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width || (maxW || 400);
            var h = img.naturalHeight || img.height || (maxW || 400);
            var scale = Math.min(1, (maxW || 400) / w);
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(w * scale));
            c.height = Math.max(1, Math.round(h * scale));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            c.toBlob(function (b) { finish(b); }, 'image/jpeg', 0.82);
          } catch (_) { finish(null); }
        };
        img.onerror = function () { finish(null); };
        img.src = objUrl;
      } catch (_) { finish(null); }
    });
  };

  /* =========================================================
   * 积分钱包弹窗：全平台唯一一份标记
   * ---------------------------------------------------------
   * 2026-10-31：这份 HTML 原来在 avatar / pixelart / my 三个页面各抄一份，
   * 改一处漏两处——/my 的钱包因此一直和首页长得不一样（余额卡没黄底、
   * 兑换按钮样式不同）。现在由平台层生成并挂到 body，页面只留一个
   * #btnWallet 入口，结构只有一个来源。
   * 本文件以 defer 加载，执行时 body 已解析完；万一没有（老式同步引用），
   * 退到 DOMContentLoaded 再挂。
   * ========================================================= */
  var WALLET_MODAL_HTML = [
    '<div class="modal-mask" id="walletModal" hidden>',
    '  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="walletTitle">',
    '    <div class="modal-head">',
    '      <h3 id="walletTitle">积分钱包</h3>',
    '      <button class="btn ghost wallet-close" id="btnCloseWallet" type="button" aria-label="关闭钱包">',
    '        <svg class="icon icon-16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4 L12 12 M12 4 L4 12"/></svg>',
    '      </button>',
    '    </div>',
    '    <p class="modal-desc">积分全平台通用：1 积分 = 生成 1 次；生成失败自动退回；新用户有 2 次免费体验。</p>',
    '    <p class="wallet-balance">',
    '      <span class="wb-label">当前余额</span>',
    '      <span class="wb-num"><b id="walletBalanceBig">–</b>积分</span>',
    '    </p>',
    '    <span class="group-label">充值套餐</span>',
    '    <div class="product-grid" id="productGrid"></div>',
    '    <p class="hint" id="payChannelsNote"></p>',
    '    <div class="login-divider"><span>或</span></div>',
    '    <span class="group-label">兑换码兑换</span>',
    '    <div class="phone-row">',
    '      <input type="text" id="redeemCode" class="text-input mono" placeholder="输入兑换码，如 AVXXXXXXXX" />',
    '      <button class="btn primary" id="btnRedeem" type="button">兑换</button>',
    '    </div>',
    '    <p class="hint" id="walletMsg"></p>',
    '    <a class="btn wallet-more" id="walletMore" href="/my#txns">查看积分明细 →</a>',
    '  </div>',
    '</div>'
  ].join('\n');

  Platform.mountWalletModal = function () {
    if (!document.body) { return false; }
    var old = document.getElementById('walletModal');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    var host = document.createElement('div');
    host.innerHTML = WALLET_MODAL_HTML;
    var node = host.firstElementChild;
    if (!node) { return false; }
    document.body.appendChild(node);
    return true;
  };
  if (!Platform.mountWalletModal()) {
    document.addEventListener('DOMContentLoaded', function () { Platform.mountWalletModal(); });
  }

  Platform.setup = function (ctx) {
    var els = ctx.els;
    /* 登录方式从「手机号」换成「邮箱」：旧页面/旧测试仍传 loginPhone/errPhone，
     * 这里做一次别名，避免任何一处漏改就白屏。 */
    if (!els.loginEmail && els.loginPhone) { els.loginEmail = els.loginPhone; }
    if (!els.errEmail && els.errPhone) { els.errEmail = els.errPhone; }
    /* 钱包弹窗的节点由平台层生成，页面不必再逐个列出它们的 id；
       页面漏了（或以后新增节点）就在这里补齐，避免「点开是空弹窗」。 */
    ['walletModal', 'btnCloseWallet', 'walletBalanceBig', 'productGrid',
     'payChannelsNote', 'redeemCode', 'btnRedeem', 'walletMsg', 'walletMore'
    ].forEach(function (id) {
      if (!els[id]) { els[id] = document.getElementById(id); }
    });
    var Store = ctx.store;
    var cloudService = Platform.cloud;
    var showHint = ctx.showHint || function () {};
    var callbackPath = ctx.callbackPath || '/';
    var productSlug = ctx.productSlug || '';
    var onLoginSuccess = ctx.onLoginSuccess || function () {};
    var onSignOut = ctx.onSignOut || function () {};

    /* =========================================================
     * Section J5: 登录与云同步（Auth + Storage，全部守卫式调用）
     * 规则：登录可选，不打断游客；云端失败静默降级本地模式
     * ========================================================= */
    var pendingOtp = null;      /* { phone, verificationId, isExistingUser } */
    var countdownTimer = null;

    function maskIdentifier(id) {
      if (typeof id !== 'string' || !id) { return ''; }
      if (/^1\d{10}$/.test(id)) { return id.slice(0, 3) + '****' + id.slice(-4); }
      if (id.indexOf('@') > 0) {
        var at = id.indexOf('@');
        return id.slice(0, 2) + '***' + id.slice(at);
      }
      return '';
    }

    /* ---------- 渲染：登录态（登录按钮 / 我的入口 / 退出） ----------
     * 三种顶栏形态：
     *   「我的」入口（userChip 是 <a href="/my">）：常驻可见，文案固定「我的」，
     *     登录人标识放 title；未登录点进去由 /my 给登录引导。
     *   用户徽标（userChip 是 <span class="user-chip">）：登录后显示身份。
     *   没有 userChip（/my 顶栏不放身份徽标）：只切换登录/退出按钮。
     * 用结构与 tagName 判断而不是新增 ctx 开关：页面结构自己就说明了意图。 */
    function renderAuthUI() {
      var user = Store.state.user;
      els.btnLogin.hidden = !!user;
      /* 首页不再放「退出」按钮（两个产品页已删），/my 顶栏保留；
         这里按节点是否存在决定，缺了不影响其它按钮渲染。 */
      if (els.btnSignOut) { els.btnSignOut.hidden = !user; }
      var chip = els.userChip;
      if (!chip) { return; }
      if (chip.tagName === 'A') {
        chip.hidden = false;
        if (els.userChipText) { els.userChipText.textContent = '我的'; }
        var who = user
          ? (user.name || maskIdentifier(user.phone) || maskIdentifier(user.email) || '')
          : '';
        chip.title = (who ? who + ' · ' : '') + '我的作品与积分明细';
        return;
      }
      chip.hidden = !user;
      if (user) {
        els.userChipText.textContent =
          user.name || maskIdentifier(user.phone) || maskIdentifier(user.email) || '已登录';
        chip.title = ctx.userChipTitle || '已登录';
      }
    }

    /* ---------- 积分钱包（账本在云端，前端只调 RPC） ---------- */
    /* 余额变动广播：产品页（如 /my 的积分明细）监听后刷新各自视图 */
    function notifyBalanceChanged() {
      try { document.dispatchEvent(new CustomEvent('platform:balance-changed')); } catch (_) {}
    }
    function walletRpc(name, params) {
      var cloud = cloudService.getClient();
      if (!cloud || !cloud.database || !cloud.database.rpc) {
        return Promise.reject(new Error('云服务不可用'));
      }
      return Promise.resolve(cloud.database.rpc(name, params || {})).then(function (res) {
        if (res && res.error) {
          var e = new Error((res.error && res.error.message) || '钱包服务异常');
          e.rawMessage = e.message;
          throw e;
        }
        return res ? res.data : null;
      });
    }

    var walletService = {
      balance: null,
      refreshing: false,
      /* 余额本地缓存：跨境 RPC 要 0.3~0.6s，二次打开先用缓存把数字亮出来，
         再后台刷新覆盖。只按用户 id 存，不跨账号串味。 */
      cacheKey: function () {
        return 'platform.balance.' + (Store.state.user ? Store.state.user.id : 'anon');
      },
      readCache: function () {
        try {
          var raw = localStorage.getItem(this.cacheKey());
          var c = raw ? JSON.parse(raw) : null;
          if (c && typeof c.balance === 'number') { return c.balance; }
        } catch (_) {}
        return null;
      },
      writeCache: function (balance) {
        try {
          localStorage.setItem(this.cacheKey(), JSON.stringify({ balance: balance, ts: Date.now() }));
        } catch (_) {}
      },
      refresh: function () {
        if (!Store.state.user || this.refreshing) { return Promise.resolve(null); }
        if (this.balance === null) {
          var cached = this.readCache();
          if (cached !== null) { this.balance = cached; this.renderChip(); }
        }
        this.refreshing = true;
        return walletRpc('wallet_balance').then(function (data) {
          walletService.balance = typeof data === 'number' ? data : parseInt(data, 10) || 0;
          walletService.writeCache(walletService.balance);
          walletService.renderChip();
          return walletService.balance;
        }).catch(function () {
          return null;
        }).then(function (v) {
          walletService.refreshing = false;
          return v;
        });
      },
      renderChip: function () {
        var has = !!Store.state.user && walletService.balance !== null;
        els.btnWallet.hidden = !has;
        if (has) {
          els.walletBalance.textContent = String(walletService.balance);
          els.walletBalanceBig.textContent = String(walletService.balance);
        }
      },
      /* 生成前扣 1 积分；余额不足（含免费额度用尽）时抛 insufficient */
      consume: function () {
        var ref = 'gen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        return walletRpc('wallet_consume', { p_credits: -1, p_ref: ref }).then(function (rows) {
          var row = Array.isArray(rows) ? rows[0] : rows;
          walletService.balance = row && typeof row.balance === 'number' ? row.balance : walletService.balance;
          walletService.renderChip();
          return { txnId: row && row.txn_id != null ? String(row.txn_id) : null };
        }).catch(function (err) {
          if (String(err.message || '').indexOf('INSUFFICIENT_BALANCE') !== -1) {
            err.insufficient = true;
            err.message = '积分不足：免费体验已用完，请充值或输入兑换码。';
          }
          throw err;
        });
      },
      /* 生成失败退回（静默，不影响主流程提示）
       * ⚠️ 2026-10-30 起产品代码不要再调它：退款已归服务端生成单
       * （server/orders.js → order_fail，与状态变更同事务且幂等）。
       * 保留此方法仅为平台层兼容与后台工具使用。 */
      refund: function (txnId) {
        if (!txnId) { return Promise.resolve(null); }
        return walletRpc('wallet_refund', { p_ref: String(txnId) }).then(function (balance) {
          walletService.balance = typeof balance === 'number' ? balance : walletService.balance;
          walletService.renderChip();
          return balance;
        }).catch(function () { return null; });
      },
      redeem: function (code) {
        return walletRpc('wallet_redeem', { p_code: code }).then(function (balance) {
          walletService.balance = typeof balance === 'number' ? balance : walletService.balance;
          walletService.renderChip();
          return balance;
        }).catch(function (err) {
          var msg = String(err.message || '');
          if (msg.indexOf('CODE_INVALID') !== -1) { err.message = '兑换码无效或已被使用'; }
          throw err;
        });
      },
      /* 服务端扣费后回写余额（/api/ai 响应头 X-Wallet-Balance） */
      applyBalance: function (n) {
        var v = typeof n === 'number' ? n : parseInt(n, 10);
        if (typeof n === 'number' || (typeof n === 'string' && n !== '' && !isNaN(v))) {
          walletService.balance = v;
          walletService.renderChip();
        }
      }
    };

    /* ---------- 钱包弹窗 ---------- */
    var payChannelState = { xunhupay: false };
    function showWalletMsg(msg, warn) {
      els.walletMsg.textContent = msg;
      els.walletMsg.classList.toggle('warn', !!warn);
    }
    function openWallet(presetMsg) {
      if (!Store.state.user) { openLogin(); return; }
      showWalletMsg(presetMsg || '', !!presetMsg);
      els.walletModal.hidden = false;
      walletService.refresh();
      loadWalletProducts();
    }
    function closeWallet() {
      els.walletModal.hidden = true;
      els.btnWallet.focus();
    }
    function loadWalletProducts() {
      var cloud = cloudService.getClient();
      if (!cloud || !cloud.database || !cloud.database.from) { return; }
      cloud.database.from('app_products').select('*').eq('active', true).order('sort').then(function (res) {
        var list = (res && res.data) || [];
        /* 产品隔离：传了 productSlug 只显示本产品（或未标注 product 的通用）套餐 */
        if (productSlug) {
          list = list.filter(function (p) { return !p.product || p.product === productSlug; });
        }
        els.productGrid.innerHTML = '';
        if (!list.length) {
          els.productGrid.innerHTML = '<p class="hint">暂无可售套餐</p>';
          return;
        }
        list.forEach(function (p) {
          var card = document.createElement('div');
          card.className = 'product-card';
          var price = '¥' + (p.price_cents / 100).toFixed(2).replace(/\.00$/, '');
          card.innerHTML =
            '<div class="p-name"></div><div class="p-credits"></div><div class="p-price"></div>';
          card.querySelector('.p-name').textContent = p.name || '';
          card.querySelector('.p-credits').textContent = p.credits + ' 积分';
          card.querySelector('.p-price').textContent = price;
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn primary small';
          btn.textContent = '购买';
          btn.addEventListener('click', function () { startPay(p); });
          card.appendChild(btn);
          els.productGrid.appendChild(card);
        });
        els.payChannelsNote.textContent = payChannelState.xunhupay
          ? '' : '线上支付即将开通，当前请使用兑换码兑换。';
      }).catch(function () {
        els.productGrid.innerHTML = '<p class="hint">套餐加载失败，请稍后重试</p>';
      });
    }
    /* 积分明细：读自己的账本流水（RLS 限制只能看本人，只读）
     * 渲染只此一份：弹窗里的明细已去掉（底部改成去 /my 的入口），
     * /my 的「积分明细」tab 复用这里，避免两处各写一套条目结构。 */
    var TXN_KIND_TEXT = { consume: '生成消费', refund: '失败退回', redeem: '兑换码兑换', grant: '管理员赠送', pay: '充值到账' };
    /* 生成消费的 ref 就是服务端单号，单号前缀标了产品
       （server/orders.js 的 PRODUCT_PREFIX：avatar→av、pixelart→px）。
       老流水（P3 之前的 gen-…）没有产品信息，就不显示这一行。 */
    var TXN_PRODUCT_TEXT = { av: '成像 · 头像', px: '点豆 · 图纸' };
    function txnProduct(ref) {
      return TXN_PRODUCT_TEXT[String(ref || '').slice(0, 2)] || '';
    }
    function fmtTxnTime(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) { return ''; }
      var p = function (n) { return n < 10 ? '0' + n : String(n); };
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function maskRedeemCode(ref) {
      var s = String(ref || '');
      if (s.length <= 4) { return s; }
      return s.slice(0, 2) + '****' + s.slice(-2);
    }
    function renderTxnList(container, rows) {
      if (!container) { return; }
      rows = rows || [];
      container.innerHTML = '';
      if (!rows.length) {
        container.innerHTML = '<p class="hint">暂无积分记录</p>';
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
        /* 副标题优先级：云端备注 → 生成消费的产品 → 兑换码（打码） */
        var note = t.note || '';
        if (!note && t.kind === 'consume') { note = txnProduct(t.ref); }
        if (!note && t.kind === 'redeem') { note = '兑换码 ' + maskRedeemCode(t.ref); }
        item.querySelector('.t-note').textContent = note;
        var creditEl = item.querySelector('.t-credits');
        creditEl.textContent = (credits > 0 ? '+' : '') + credits;
        creditEl.classList.add(credits > 0 ? 'plus' : 'minus');
        item.querySelector('.t-time').textContent = fmtTxnTime(t.created_at);
        container.appendChild(item);
      });
    }
    function startPay(product) {
      if (!Store.state.user) { openLogin(); return; }
      if (!payChannelState.xunhupay) {
        showWalletMsg('线上支付尚未开通，请使用兑换码兑换。', true);
        return;
      }
      fetch('/api/pay/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'xunhupay',
          productId: product.id,
          credits: product.credits,
          amountCents: product.price_cents,
          userId: Store.state.user.id,
          title: product.name || '积分充值'
        })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.payUrl) {
          showWalletMsg('已创建订单，正在跳转支付…');
          window.location.href = data.payUrl;
        } else {
          showWalletMsg((data && data.error && data.error.message) || '下单失败，请稍后重试', true);
        }
      }).catch(function () {
        showWalletMsg('下单失败，请稍后重试', true);
      });
    }
    function doRedeem() {
      var code = els.redeemCode.value.trim();
      if (!code) { showWalletMsg('请输入兑换码', true); return; }
      els.btnRedeem.disabled = true;
      walletService.redeem(code).then(function (balance) {
        els.redeemCode.value = '';
        showWalletMsg('兑换成功，当前余额 ' + balance + ' 积分');
        notifyBalanceChanged();
      }).catch(function (err) {
        showWalletMsg(err.message || '兑换失败', true);
      }).then(function () {
        els.btnRedeem.disabled = false;
      });
    }
    /* 支付回跳：?paid=ORDERNO → 向服务器领取签名凭证 → 云端 RPC 幂等入账 */
    var paidClaimHandled = {};
    function handlePaidReturn() {
      var m = /[?&]paid=([A-Za-z0-9]+)/.exec(location.search);
      if (!m || !Store.state.user || paidClaimHandled[m[1]]) { return; }
      paidClaimHandled[m[1]] = true;
      var orderNo = m[1];
      var tries = 0;
      function attempt() {
        tries++;
        fetch('/api/pay/claim?orderNo=' + encodeURIComponent(orderNo))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.error) { throw new Error(data.error.code || 'ORDER_NOT_PAID'); }
            if (!data || data.userId !== Store.state.user.id) { throw new Error('USER_MISMATCH'); }
            return walletRpc('wallet_pay_claim', {
              p_order_no: data.orderNo, p_user: data.userId, p_credits: data.credits,
              p_ts: data.ts, p_sig: data.sig
            });
          })
          .then(function (balance) {
            walletService.balance = typeof balance === 'number' ? balance : walletService.balance;
            walletService.renderChip();
            notifyBalanceChanged();
            showHint('充值成功，积分已到账，当前余额 ' + balance + '。');
          })
          .catch(function (err) {
            var msg = String(err.message || '');
            if (msg === 'ORDER_NOT_PAID' && tries < 12) { setTimeout(attempt, 5000); return; }
            if (msg === 'ALREADY_CREDITED' || msg.indexOf('pay') !== -1) { return; }
            if (tries >= 12) { showHint('支付确认超时，如积分未到账请联系管理员（订单号 ' + orderNo + '）', true); }
          });
      }
      attempt();
    }
    function loadPayChannels() {
      fetch('/api/pay/config').then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.channels) { payChannelState.xunhupay = !!data.channels.xunhupay; }
      }).catch(function () {});
    }

    /* 云端在「未登录 / 会话过期」时会自动建匿名会话：sub='anon'、is_anonymous=true。
     * 匿名会话不是登录态。若把它当成已登录，钱包 RPC 会打在共享的 anon 账本上
     * （2026-10-30 事故：界面显示「已登录 · 积分 -2」，生成照跑，实际扣的是所有人
     *  公共的那份余额，额度墙形同虚设）。 */
    function sessionUser(session) {
      var u = session && session.user ? session.user : null;
      if (!u || u.isAnonymous || u.id === 'anon') { return null; }
      return u;
    }

    function applySession(session) {
      Store.state.user = sessionUser(session);
      renderAuthUI();
      /* 登录：初始化积分钱包并处理支付回跳；退出：隐藏钱包并清零余额 */
      if (Store.state.user) {
        walletService.refresh().then(function () { handlePaidReturn(); });
        /* 顺手把上次没结算完的生成单退掉（关页/崩溃/断网的残留） */
        settleStaleOrders();
      } else {
        walletService.balance = null;
        els.btnWallet.hidden = true;
      }
    }

    /* 复核会话：关键操作（生成）前调用。会话过期 / 被撤销 / 只剩匿名会话时
     * 一律按未登录处理，并清理界面上的「已登录 + 积分」假象。
     * 网络异常不误踢（继续用内存里的登录态，服务端仍会把关）。 */
    function ensureAuth() {
      var cloud = cloudService.getClient();
      if (!cloud || !cloud.auth || !cloud.auth.getSession) {
        return Promise.resolve(Store.state.user || null);
      }
      return Promise.resolve(cloud.auth.getSession()).then(function (res) {
        var u = sessionUser(res && res.data ? res.data : null);
        if (!u) {
          if (Store.state.user) {
            applySession(null);
            onSignOut();
          }
          return null;
        }
        if (!Store.state.user || Store.state.user.id !== u.id) { applySession({ user: u }); }
        return u;
      }).catch(function () { return Store.state.user || null; });
    }

    /* 当前 access token：/api/ai 由服务端按此校验身份并扣费，前端不再自己扣 */
    function getAuthToken() {
      var cloud = cloudService.getClient();
      if (!cloud || !cloud.auth || !cloud.auth.getAccessToken) { return Promise.resolve(''); }
      return Promise.resolve(cloud.auth.getAccessToken())
        .then(function (t) { return t || ''; })
        .catch(function () { return ''; });
    }

    /* 生成单补退（P3）：登录态一建立就结算本人被遗弃的 pending 单。
     * 覆盖服务端来不及结算的场景——生成中关页、服务重启、响应丢了但扣费成了。
     * 云端 order_reap 幂等，多调无副作用；失败静默，不干扰正常流程。 */
    function settleStaleOrders() {
      if (!Store.state.user) { return Promise.resolve({ refunded: 0 }); }
      return getAuthToken().then(function (token) {
        if (!token) { return { refunded: 0 }; }
        return fetch('/api/orders/settle', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token }
        }).then(function (res) {
          return res.json().catch(function () { return {}; });
        }).then(function (data) {
          var refunded = Number(data && data.refunded) || 0;
          if (data && typeof data.balance === 'number') {
            walletService.balance = data.balance;
            walletService.renderChip();
          }
          if (refunded > 0) {
            showHint('已为你补退 ' + refunded + ' 个未完成生成的积分');
          }
          return { refunded: refunded, balance: data ? data.balance : null };
        });
      }).catch(function () { return { refunded: 0 }; });
    }

    /* ---------- 登录弹窗 ---------- */
    var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    function openLogin() {
      els.loginEmail.value = '';
      els.loginCode.value = '';
      showFieldErr(els.errEmail, '', false);
      showFieldErr(els.errCode, '', false);
      showLoginMsg('');
      pendingOtp = null;
      els.loginModal.hidden = false;
      els.loginEmail.focus();
    }
    function closeLogin() {
      els.loginModal.hidden = true;
      els.btnLogin.focus();
    }
    function showLoginMsg(msg, warn) {
      els.loginMsg.textContent = msg;
      els.loginMsg.classList.toggle('warn', !!warn);
    }
    function showFieldErr(errEl, msg, show) {
      errEl.textContent = msg || errEl.textContent;
      errEl.hidden = !show;
    }

    function startCountdown(sec) {
      var remain = sec;
      els.btnSendCode.disabled = true;
      if (countdownTimer) { clearInterval(countdownTimer); }
      var tick = function () {
        if (remain <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          els.btnSendCode.disabled = false;
          els.btnSendCode.textContent = '获取验证码';
          return;
        }
        els.btnSendCode.textContent = remain + 's 后重发';
        remain--;
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
    }

    /* 获取验证码：先本地校验邮箱，再调 sendOtp（发送与验证分离） */
    function sendCodeHandler() {
      var email = els.loginEmail.value.trim();
      if (!EMAIL_RE.test(email)) {
        showFieldErr(els.errEmail, '', true);
        return;
      }
      showFieldErr(els.errEmail, '', false);
      var cloud = cloudService.getClient();
      if (!cloud) { showLoginMsg('服务未就绪，请刷新页面后重试', true); return; }
      els.btnSendCode.disabled = true;
      cloud.auth.sendOtp({ email: email }).then(function (res) {
        if (res && res.error) {
          els.btnSendCode.disabled = false;
          showLoginMsg((res.error && res.error.message) || '验证码发送失败，请稍后重试', true);
          return;
        }
        pendingOtp = {
          email: email,
          verificationId: res.data.verificationId,
          isExistingUser: res.data.isExistingUser
        };
        startCountdown(60);
        showLoginMsg('验证码已发送，请查收邮箱（含垃圾邮件箱）');
      }).catch(function () {
        els.btnSendCode.disabled = false;
        showLoginMsg('验证码发送失败，请检查网络后重试', true);
      });
    }

    /* 登录/注册：复用已保存的 challenge，提交验证码时不重新发送 */
    function submitPhoneLogin() {
      var email = els.loginEmail.value.trim();
      var code = els.loginCode.value.trim();
      if (!pendingOtp || pendingOtp.email !== email) {
        showFieldErr(els.errEmail, '', true);
        showLoginMsg('请先为当前邮箱获取验证码', true);
        return;
      }
      if (!/^\d{6}$/.test(code)) {
        showFieldErr(els.errCode, '', true);
        return;
      }
      showFieldErr(els.errCode, '', false);
      var cloud = cloudService.getClient();
      if (!cloud) { showLoginMsg('服务未就绪，请刷新页面后重试', true); return; }
      els.btnPhoneLogin.disabled = true;
      cloud.auth.verifyOtp({
        email: pendingOtp.email,
        verificationId: pendingOtp.verificationId,
        isExistingUser: pendingOtp.isExistingUser,
        token: code
      }).then(function (res) {
        els.btnPhoneLogin.disabled = false;
        if (res && res.error) {
          showLoginMsg((res.error && res.error.message) || '验证码错误或已过期，请重试', true);
          return;
        }
        pendingOtp = null;
        applySession(res && res.data ? { user: res.data.user } : null);
        closeLogin();
        onLoginSuccess(Store.state.user);
      }).catch(function () {
        els.btnPhoneLogin.disabled = false;
        showLoginMsg('登录失败，请稍后重试', true);
      });
    }

    /* 第三方登录（微信/WorkBuddy）已随云服务下线：只保留邮箱验证码一种入口 */

    function bindAuthEvents() {
      els.btnLogin.addEventListener('click', openLogin);
      els.btnCloseLogin.addEventListener('click', closeLogin);
      els.loginModal.addEventListener('click', function (e) {
        if (e.target === els.loginModal) { closeLogin(); }
      });
      /* 积分钱包 */
      els.btnWallet.addEventListener('click', function () { openWallet(''); });
      els.btnCloseWallet.addEventListener('click', closeWallet);
      els.walletModal.addEventListener('click', function (e) {
        if (e.target === els.walletModal) { closeWallet(); }
      });
      els.btnRedeem.addEventListener('click', doRedeem);
      els.redeemCode.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { doRedeem(); }
      });
      /* 弹窗底部「查看积分明细」：在 /my 上就不用再跳一次页，
         关掉弹窗直接切到明细 tab；其它页面按 href 正常导航到 /my#txns */
      if (els.walletMore) {
        els.walletMore.addEventListener('click', function (e) {
          if (location.pathname !== '/my') { return; }
          e.preventDefault();
          closeWallet();
          if (typeof ctx.onViewTxns === 'function') { ctx.onViewTxns(); }
        });
      }
      els.loginEmail.addEventListener('input', function () { showFieldErr(els.errEmail, '', false); });
      els.loginCode.addEventListener('input', function () { showFieldErr(els.errCode, '', false); });
      els.btnSendCode.addEventListener('click', sendCodeHandler);
      els.btnPhoneLogin.addEventListener('click', submitPhoneLogin);
      /* 退出只在 /my 顶栏提供（产品页不放入口）；节点缺失就跳过绑定 */
      if (els.btnSignOut) {
        els.btnSignOut.addEventListener('click', function () {
          var cloud = cloudService.getClient();
          Store.state.user = null;
          renderAuthUI();
          onSignOut();
          if (cloud && cloud.auth.signOut) { cloud.auth.signOut().catch(function () {}); }
        });
      }
      /* 页面重新可见时复核会话：避免标签页放久了，过期会话还挂着「已登录」的假象 */
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { ensureAuth(); }
      });
    }

    return {
      applySession: applySession,
      ensureAuth: ensureAuth,
      getAuthToken: getAuthToken,
      settleStaleOrders: settleStaleOrders,
      openLogin: openLogin,
      closeLogin: closeLogin,
      openWallet: openWallet,
      closeWallet: closeWallet,
      walletService: walletService,
      loadPayChannels: loadPayChannels,
      handlePaidReturn: handlePaidReturn,
      bindAuthEvents: bindAuthEvents,
      renderAuthUI: renderAuthUI,
      renderTxnList: renderTxnList
    };
  };
})();
