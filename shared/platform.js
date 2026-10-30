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


    /* WorkBuddy 云服务 publicConfig（仅含可公开的前端配置，密钥在服务端）
       endpoint 用「本站源」：server.js 的 /.cloud/* 同源反代到 WorkBuddy 云，
       浏览器不触发 CORS 预检（云端对 OPTIONS 返回 403）。file:// 场景回退到云站。*/
    var CLOUD_FALLBACK_ENDPOINT = 'https://ai-avatar-studio-50356.app.workbuddy.host';
    var PUBLIC_CONFIG = {
      endpoint: (window.location && window.location.origin && window.location.origin !== 'null')
        ? window.location.origin : CLOUD_FALLBACK_ENDPOINT,
      oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
      publishableKey: 'wbpk_eoMql05K7PT2JgZUKFFOo9_9vLkFanCYcm67RRrIgxoEnsGnDS52YEM'
    };

    /* --- cloudService：WorkBuddy 云服务客户端（SDK 缺失/加载失败时优雅降级为 null） --- */
    var cloudService = {
      _client: null,
      getClient: function () {
        if (this._client) { return this._client; }
        if (!window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) { return null; }
        try {
          this._client = window.WorkBuddyCloud.createWorkBuddyCloud({
            endpoint: PUBLIC_CONFIG.endpoint,
            oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
            publishableKey: PUBLIC_CONFIG.publishableKey
          });
          return this._client;
        } catch (_) { return null; }
      }
    };

  var Platform = window.Platform = {
    cloud: cloudService,
    PUBLIC_CONFIG: PUBLIC_CONFIG,
    CONFIG_TABLE: CONFIG_TABLE,
    CONFIG_ID: CONFIG_ID
  };

  Platform.setup = function (ctx) {
    var els = ctx.els;
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

    /* ---------- 渲染：登录态（登录按钮 / 用户徽标 / 退出） ---------- */
    function renderAuthUI() {
      var user = Store.state.user;
      els.btnLogin.hidden = !!user;
      els.userChip.hidden = !user;
      els.btnSignOut.hidden = !user;
      if (user) {
        els.userChipText.textContent =
          user.name || maskIdentifier(user.phone) || maskIdentifier(user.email) || '已登录';
        els.userChip.title = ctx.userChipTitle || '已登录';
      }
    }

    /* ---------- 积分钱包（账本在云端，前端只调 RPC） ---------- */
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
      refresh: function () {
        if (!Store.state.user || this.refreshing) { return Promise.resolve(null); }
        this.refreshing = true;
        return walletRpc('wallet_balance').then(function (data) {
          walletService.balance = typeof data === 'number' ? data : parseInt(data, 10) || 0;
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
      /* 生成失败自动退回（静默，不影响主流程提示） */
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
      loadTxnHistory();
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
    /* 积分明细：读自己的账本流水（RLS 限制只能看本人，只读） */
    var TXN_KIND_TEXT = { consume: '生成消费', refund: '失败退回', redeem: '兑换码兑换', grant: '管理员赠送', pay: '充值到账' };
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
    function renderTxnHistory(rows) {
      els.txnHistory.innerHTML = '';
      if (!rows.length) {
        els.txnHistory.innerHTML = '<p class="hint">暂无积分记录</p>';
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
        var creditEl = item.querySelector('.t-credits');
        creditEl.textContent = (credits > 0 ? '+' : '') + credits;
        creditEl.classList.add(credits > 0 ? 'plus' : 'minus');
        item.querySelector('.t-time').textContent = fmtTxnTime(t.created_at);
        els.txnHistory.appendChild(item);
      });
    }
    function loadTxnHistory() {
      var cloud = cloudService.getClient();
      if (!cloud || !cloud.database || !cloud.database.from) {
        els.txnHistory.innerHTML = '<p class="hint">暂无积分记录</p>';
        return;
      }
      els.txnHistory.innerHTML = '<p class="hint">加载中…</p>';
      cloud.database.from('app_wallet_txns').select('*')
        .order('created_at', { ascending: false }).limit(30)
        .then(function (res) {
          renderTxnHistory((res && res.data) || []);
        }).catch(function () {
          els.txnHistory.innerHTML = '<p class="hint">明细加载失败，请稍后重试</p>';
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
        if (!els.walletModal.hidden) { loadTxnHistory(); }
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

    /* ---------- 登录弹窗 ---------- */
    function openLogin() {
      els.loginPhone.value = '';
      els.loginCode.value = '';
      showFieldErr(els.errPhone, '', false);
      showFieldErr(els.errCode, '', false);
      showLoginMsg('');
      pendingOtp = null;
      els.loginModal.hidden = false;
      els.loginPhone.focus();
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

    /* 获取验证码：先本地校验手机号，再调 sendOtp（发送与验证分离） */
    function sendCodeHandler() {
      var phone = els.loginPhone.value.trim();
      if (!/^1\d{10}$/.test(phone)) {
        showFieldErr(els.errPhone, '', true);
        return;
      }
      showFieldErr(els.errPhone, '', false);
      var cloud = cloudService.getClient();
      if (!cloud) { showLoginMsg('云服务未就绪，请刷新页面后重试', true); return; }
      els.btnSendCode.disabled = true;
      cloud.auth.sendOtp({ phone: phone }).then(function (res) {
        if (res && res.error) {
          els.btnSendCode.disabled = false;
          showLoginMsg((res.error && res.error.message) || '验证码发送失败，请稍后重试', true);
          return;
        }
        pendingOtp = {
          phone: phone,
          verificationId: res.data.verificationId,
          isExistingUser: res.data.isExistingUser
        };
        startCountdown(60);
        showLoginMsg('验证码已发送，请查收短信');
      }).catch(function () {
        els.btnSendCode.disabled = false;
        showLoginMsg('验证码发送失败，请检查网络后重试', true);
      });
    }

    /* 登录/注册：复用已保存的 challenge，提交验证码时不重新发送 */
    function submitPhoneLogin() {
      var phone = els.loginPhone.value.trim();
      var code = els.loginCode.value.trim();
      if (!pendingOtp || pendingOtp.phone !== phone) {
        showFieldErr(els.errPhone, '', true);
        showLoginMsg('请先为当前手机号获取验证码', true);
        return;
      }
      if (!/^\d{4,6}$/.test(code)) {
        showFieldErr(els.errCode, '', true);
        return;
      }
      showFieldErr(els.errCode, '', false);
      var cloud = cloudService.getClient();
      if (!cloud) { showLoginMsg('云服务未就绪，请刷新页面后重试', true); return; }
      els.btnPhoneLogin.disabled = true;
      cloud.auth.verifyOtp({
        phone: pendingOtp.phone,
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

    /* 微信网页登录：signInWithOAuth 返回跳转地址，同标签页前往 */
    function loginWithWechat() {
      var cloud = cloudService.getClient();
      if (!cloud) { showLoginMsg('云服务未就绪，请刷新页面后重试', true); return; }
      els.btnWechatLogin.disabled = true;
      var back = new URL(location.href);
      back.pathname = callbackPath; /* 回调落产品页，避免静态托管 404 丢单次 code */
      ['code', 'state', 'provider'].forEach(function (k) { back.searchParams.delete(k); });
      cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: back.toString() })
        .then(function (res) {
          els.btnWechatLogin.disabled = false;
          if (res && res.error) {
            showLoginMsg((res.error && res.error.message) || '暂时无法使用微信登录', true);
            return;
          }
          if (res && res.data && res.data.url) { location.assign(res.data.url); }
        }).catch(function () {
          els.btnWechatLogin.disabled = false;
          showLoginMsg('无法发起微信登录，请稍后重试', true);
        });
    }

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
      els.loginPhone.addEventListener('input', function () { showFieldErr(els.errPhone, '', false); });
      els.loginCode.addEventListener('input', function () { showFieldErr(els.errCode, '', false); });
      els.btnSendCode.addEventListener('click', sendCodeHandler);
      els.btnPhoneLogin.addEventListener('click', submitPhoneLogin);
      els.btnWechatLogin.addEventListener('click', loginWithWechat);
      els.btnSignOut.addEventListener('click', function () {
        var cloud = cloudService.getClient();
        Store.state.user = null;
        renderAuthUI();
        onSignOut();
        if (cloud && cloud.auth.signOut) { cloud.auth.signOut().catch(function () {}); }
      });
      /* 页面重新可见时复核会话：避免标签页放久了，过期会话还挂着「已登录」的假象 */
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { ensureAuth(); }
      });
    }

    return {
      applySession: applySession,
      ensureAuth: ensureAuth,
      getAuthToken: getAuthToken,
      openLogin: openLogin,
      closeLogin: closeLogin,
      openWallet: openWallet,
      closeWallet: closeWallet,
      walletService: walletService,
      loadPayChannels: loadPayChannels,
      handlePaidReturn: handlePaidReturn,
      bindAuthEvents: bindAuthEvents,
      renderAuthUI: renderAuthUI
    };
  };
})();
