/* =========================================================
 * 拼豆大师 · 产品层逻辑（占位骨架）
 * - 平台层接入：登录 / 积分钱包 / 支付，全部复用 window.Platform
 * - productSlug: 'pixelart' —— 钱包套餐按产品过滤（平台层支持）
 * - 产品核心功能（AI 生成拼豆图纸）待需求详述后在本次本文件内扩展
 * ========================================================= */
(function () {
  'use strict';

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

  /* ---------- 产品状态（占位：核心功能开发后在此扩展） ---------- */
  var Store = {
    state: {
      user: null   /* 当前登录用户（session.user，未登录为 null） */
    }
  };

  /* ---------- 产品侧提示（复用 hero 下方 hint；弹窗内提示由平台层负责） ---------- */
  function showHint(msg, isError) {
    var el = document.querySelector('.coming-panel .hint');
    if (!el) { return; }
    el.textContent = msg || el.getAttribute('data-default') || el.textContent;
    el.classList.toggle('warn', !!isError);
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
    onLoginSuccess: function () { /* 云历史等钩子待核心功能开发后接入 */ },
    onSignOut: function () { /* 清理产品侧登录态（当前占位页无需） */ }
  });
  var applySession = auth.applySession;
  var bindAuthEvents = auth.bindAuthEvents;
  var loadPayChannels = auth.loadPayChannels;
  var renderAuthUI = auth.renderAuthUI;

  restoreAuth();
})();
