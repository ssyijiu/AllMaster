/* =========================================================
 * local-cloud：自建云服务客户端（替代 WorkBuddy 云 SDK）
 * ---------------------------------------------------------
 * 为什么保留这层「假 SDK」：platform.js / my.js / 两个产品的 app.js 里已经有
 * 30+ 处 cloud.auth / cloud.database / cloud.storage 调用，而且都写得很稳。
 * 与其把这些调用点全部重写（风险高、回归面大），不如实现一套同名同形状的
 * 客户端 —— 上层代码一行不改，底层从「第三方云」换成「自己的服务器」。
 *
 * 与云 SDK 的差异（刻意保留差异，不假装兼容）：
 * - 没有匿名会话：没登录就是没登录，避免重演 2026-10-30「匿名账本被扣费」事故
 * - 没有第三方 OAuth：只保留邮箱验证码
 * - 签名 URL 是本机的 /files/...，不带任何第三方域名
 * ========================================================= */
(function () {
  'use strict';

  var TOKEN_KEY = 'localcloud.token';
  var listeners = [];

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
  }
  function writeToken(t) {
    try {
      if (t) { localStorage.setItem(TOKEN_KEY, t); } else { localStorage.removeItem(TOKEN_KEY); }
    } catch (_) {}
  }

  function api(path, opts) {
    var o = opts || {};
    var headers = o.headers || {};
    var token = readToken();
    if (token) { headers.Authorization = 'Bearer ' + token; }
    var init = { method: o.method || 'GET', headers: headers };
    if (o.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.json);
    }
    if (o.body !== undefined) { init.body = o.body; }
    return fetch(path, init).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') === -1) {
        if (!res.ok) { throw new Error('HTTP_' + res.status); }
        return null;
      }
      return res.json().then(function (body) {
        if (!res.ok) {
          var e = new Error((body && body.error && (body.error.message || body.error.code)) || ('HTTP_' + res.status));
          e.status = res.status;
          e.code = body && body.error && body.error.code;
          e.body = body;
          throw e;
        }
        return body;
      });
    });
  }

  function emit(event, session) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](event, session); } catch (_) {}
    }
  }

  /* ---------- auth ---------- */
  var auth = {
    /* 返回 {data:{user}}——与云 SDK 一致；未登录返回 {data:null} */
    getSession: function () {
      var token = readToken();
      if (!token) { return Promise.resolve({ data: null, error: null }); }
      return api('/api/auth/session').then(function (body) {
        if (!body || !body.user) { writeToken(''); return { data: null, error: null }; }
        return { data: { user: body.user, balance: body.balance }, error: null };
      }).catch(function (e) {
        /* 网络异常不当作未登录（服务端仍会把关），但 token 明显无效时清掉 */
        if (e && (e.status === 401 || e.status === 403)) { writeToken(''); return { data: null, error: null }; }
        throw e;
      });
    },

    getAccessToken: function () { return Promise.resolve(readToken()); },

    /* 发验证码：参数用 email（兼容旧的 phone 字段名，避免旧调用直接炸） */
    sendOtp: function (opts) {
      var o = opts || {};
      var email = o.email || o.phone || '';
      return api('/api/auth/send-code', { method: 'POST', json: { email: email } })
        .then(function (body) {
          return {
            data: {
              verificationId: 'email',
              isExistingUser: !!body.isExisting,
              expiresIn: body.expiresIn,
              /* 服务器未配置邮件通道时（开发态）服务端会回传验证码，生产不会 */
              devCode: body.devCode
            },
            error: null
          };
        })
        .catch(function (e) {
          return { data: null, error: { code: (e && e.code) || 'SEND_FAILED', message: (e && e.message) || '验证码发送失败' } };
        });
    },

    verifyOtp: function (opts) {
      var o = opts || {};
      var email = o.email || o.phone || '';
      return api('/api/auth/verify', { method: 'POST', json: { email: email, code: o.token || o.code || '' } })
        .then(function (body) {
          writeToken(body.token);
          var session = { user: body.user };
          emit('SIGNED_IN', session);
          return { data: { user: body.user, session: session }, error: null };
        })
        .catch(function (e) {
          return { data: null, error: { code: (e && e.code) || 'VERIFY_FAILED', message: (e && e.message) || '验证码错误或已过期' } };
        });
    },

    signOut: function () {
      return api('/api/auth/signout', { method: 'POST' }).catch(function () {}).then(function () {
        writeToken('');
        emit('SIGNED_OUT', null);
        return { error: null };
      });
    },

    onAuthStateChange: function (cb) {
      listeners = listeners.concat([cb]);
      return function () {
        listeners = listeners.filter(function (f) { return f !== cb; });
      };
    },

    /* 第三方登录已下线：保留空实现，让调用方老代码走到「未登录」分支而不是报错 */
    signInWithOAuth: function () { return Promise.resolve({ data: null, error: { message: '已停用第三方登录' } }); },
    handleWorkBuddyCallback: function () { return Promise.resolve({ data: null }); },
    handleWechatWebCallback: function () { return Promise.resolve({ data: null }); }
  };

  /* ---------- database ---------- */
  function queryBuilder(table) {
    var q = { table: table, action: 'select', filters: [], limit: null, order: null };
    function run() {
      return api('/api/db/query', { method: 'POST', json: q });
    }
    var b = {
      select: function () { return b; },
      eq: function (col, val) { q.filters.push({ col: col, op: 'eq', val: val }); return b; },
      in: function (col, val) { q.filters.push({ col: col, op: 'in', val: val }); return b; },
      order: function (col, opts) {
        q.order = { col: col, ascending: !(opts && opts.ascending === false) };
        return b;
      },
      limit: function (n) { q.limit = Number(n) || null; return b; },
      then: function (ok, ko) { return run().then(ok, ko); },
      catch: function (ko) { return run().catch(ko); }
    };
    return b;
  }

  var database = {
    from: function (table) { return queryBuilder(table); },
    rpc: function (name, params) {
      return api('/api/rpc/' + encodeURIComponent(name), { method: 'POST', json: params || {} })
        .then(function (body) { return { data: body ? body.data : null, error: null }; })
        .catch(function (e) {
          return { data: null, error: { code: (e && e.code) || 'RPC_FAILED', message: (e && e.message) || '服务异常' } };
        });
    }
  };

  /* ---------- storage ---------- */
  var storage = {
    /* 与云 SDK 同规则：users/<uid>/<name>，name 可以带子目录 */
    userPath: function (uid, name) {
      var n = String(name || '').replace(/^\/+/, '');
      if (!uid || !n) { throw new Error('storage path 参数缺失'); }
      return 'users/' + uid + '/' + n;
    },

    upload: function (key, blob, opts) {
      var o = opts || {};
      var mime = o.contentType || (blob && blob.type) || 'application/octet-stream';
      var url = '/api/storage/upload?key=' + encodeURIComponent(key) + '&mime=' + encodeURIComponent(mime);
      return api(url, { method: 'POST', body: blob, headers: { 'Content-Type': mime } })
        .then(function (body) { return { data: body ? body.data : null, error: null }; })
        .catch(function (e) { return { data: null, error: { message: (e && e.message) || '上传失败' } }; });
    },

    list: function (prefix, opts) {
      var o = opts || {};
      var qs = '?prefix=' + encodeURIComponent(prefix || '') +
        (o.limit ? '&limit=' + encodeURIComponent(o.limit) : '');
      return api('/api/storage/list' + qs)
        .then(function (body) { return { data: (body && body.data) || [], error: null }; })
        .catch(function (e) { return { data: [], error: { message: (e && e.message) || '读取失败' } }; });
    },

    remove: function (keys) {
      return api('/api/storage/remove', { method: 'POST', json: { keys: keys || [] } })
        .then(function (body) { return { data: (body && body.data) || [], error: null }; })
        .catch(function (e) { return { data: [], error: { message: (e && e.message) || '删除失败' } }; });
    },

    /* 读文件 → {data: Blob}（/my 读拼豆图纸元数据用） */
    download: function (key) {
      return storage.createSignedUrls([key], 300).then(function (res) {
        var item = res && res.data && res.data[0];
        if (!item || !item.signedUrl) { return { data: null, error: { message: '签名失败' } }; }
        return fetch(item.signedUrl).then(function (r) {
          if (!r.ok) { return { data: null, error: { message: 'HTTP_' + r.status } }; }
          return r.blob().then(function (b) { return { data: b, error: null }; });
        });
      }).catch(function (e) { return { data: null, error: { message: (e && e.message) || '下载失败' } }; });
    },

    createSignedUrls: function (keys, ttl) {
      return api('/api/storage/sign', { method: 'POST', json: { keys: keys || [], ttl: ttl || 3600 } })
        .then(function (body) { return { data: (body && body.data) || [], error: null }; })
        .catch(function (e) { return { data: [], error: { message: (e && e.message) || '签名失败' } }; });
    }
  };

  window.LocalCloud = {
    createClient: function () {
      return { auth: auth, database: database, storage: storage };
    }
  };
})();
