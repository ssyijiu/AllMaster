/* =========================================================
 * 头像制作大师 · 应用层（风格 / 生成 / 历史，平台能力来自 /shared/platform.js）
 * ========================================================= */
(function () {
  'use strict';

  var Platform = window.Platform;
  if (!Platform) { throw new Error('platform.js 未加载'); }

    var LS_HISTORY_KEY = 'avatar-studio-history';
    var MAX_FILE_SIZE = 20 * 1024 * 1024;
    var UPLOAD_RESIZE_PX = 1024;
    var THUMB_PX = 512;
    var THUMB_QUALITY = 0.7;
    var HISTORY_MAX = 6;
    var CLOUD_HISTORY_MAX = 12;

    /* 线上地址：预览环境（127.0.0.1 / iframe）里用于引导用户跳转 */
    var PLATFORM_URL = 'https://ai-avatar-studio-50356.app.workbuddy.host/?sharecode=25HFTCUZ7J';
    /* 独立域名上线后填 'https://allmaster.art'（留空则仍引导到平台域名） */
    var CUSTOM_DOMAIN = '';
    var DEPLOYED_URL = CUSTOM_DOMAIN ? (CUSTOM_DOMAIN + '/apps/avatar/') : PLATFORM_URL;


    /* 兜底风格库：数据库配置加载失败或为空时使用（封面图由后台配置，未配置则显示占位） */
    var FALLBACK_STYLES = [
      { id: 'cartoon', name: '经典卡通', imageUrl: '',
        prompt: 'Turn this photo into a classic cartoon style portrait avatar. Bold clean outlines, flat vivid colors, friendly exaggerated features, simple solid color background. Keep the person\'s facial features, hairstyle and likeness clearly recognizable.' },
      { id: 'anime', name: '日系动漫', imageUrl: '',
        prompt: 'Redraw this photo as a Japanese anime style portrait avatar. Clean bold line art, vibrant cel shading, large expressive eyes, soft pastel gradient background. Keep the person\'s facial features, hairstyle and likeness clearly recognizable.' },
      { id: 'toon3d', name: '3D 立体', imageUrl: '',
        prompt: 'Turn this photo into a cute 3D cartoon character avatar, animation movie style. Soft studio lighting, smooth clay-like skin texture, big friendly eyes, gentle smile, simple warm-colored background. Preserve the person\'s likeness and hairstyle.' },
      { id: 'pixel', name: '像素风', imageUrl: '',
        prompt: 'Convert this photo into a retro pixel art avatar, 32-bit game character style. Crisp pixel blocks, limited retro color palette, simple background. Keep the hairstyle, face shape and overall likeness recognizable in pixel form.' },
      { id: 'watercolor', name: '水彩', imageUrl: '',
        prompt: 'Redraw this photo as a soft watercolor illustration portrait. Delicate brush strokes, translucent color washes, paper texture, artistic splashes around the edges, light and airy composition. Keep the facial features recognizable.' },
      { id: 'sketch', name: '素描线稿', imageUrl: '',
        prompt: 'Redraw this photo as a detailed pencil sketch portrait. Fine graphite hatching, soft shading, white paper background, elegant hand-drawn feel. Keep the facial features and expression accurate.' },
      { id: 'oil', name: '油画', imageUrl: '',
        prompt: 'Redraw this photo as a classical oil painting portrait in Renaissance style. Rich color depth, dramatic Rembrandt lighting, visible canvas texture, dark muted background. Preserve the person\'s likeness and dignified expression.' },
      { id: 'cyberpunk', name: '赛博朋克', imageUrl: '',
        prompt: 'Redraw this photo as a cyberpunk style portrait avatar. Neon cyan and teal rim lighting, futuristic tech accessories, glowing holographic elements, dark city bokeh background, cinematic atmosphere. Keep the person\'s facial features recognizable.' },
      { id: 'retro', name: '复古胶片', imageUrl: '',
        prompt: 'Redraw this photo as a vintage film photograph portrait from the 1970s. Warm faded tones, subtle film grain, soft vignette, slightly washed highlights, nostalgic analog atmosphere. Keep the person\'s facial features clearly recognizable.' },
      { id: 'flat', name: '极简扁平', imageUrl: '',
        prompt: 'Redraw this photo as a modern flat illustration avatar. Minimal geometric shapes, bold solid colors, clean vector style, simple two-tone background, trendy and minimal. Keep the hairstyle and key facial features recognizable.' },
      { id: 'illus', name: '欧美插画', imageUrl: '',
        prompt: 'Redraw this photo as a modern Western editorial illustration portrait. Expressive stylized shapes, textured brush strokes, bold complementary colors, trendy magazine art style. Keep the person\'s likeness and key facial features recognizable.' },
      { id: 'nebula', name: '梦幻星云', imageUrl: '',
        prompt: 'Redraw this photo as a dreamy cosmic fantasy portrait. Soft glowing starlight, nebula clouds in teal and cyan tones, subtle shimmer particles, ethereal atmosphere. Keep the person\'s facial features clearly recognizable.' }
    ];

    var COMMON_PROMPT_SUFFIX =
      ' Square 1:1 avatar composition, head and shoulders framing, high quality, detailed.';

    var AI_LOADING_TIPS = [
      'AI 绘制中，约需 10-20 秒',
      '正在勾勒轮廓与铺色…',
      '生成速度取决于服务商，请稍候…'
    ];

    /* =========================================================
     * Section J2: Store 层（state + 纯状态操作，不碰 DOM）
     * ========================================================= */
    var Store = {
      state: {
        config: { providers: [], styles: [] },
        configFromDb: false,  /* 配置是否来自数据库（false = 兜底内置库） */
        photoFile: null,      /* 原始 File */
        photoBlob: null,      /* 1024px PNG Blob（上传后自动生成） */
        photoUrl: '',         /* 原图预览 objectURL（移除/替换时 revoke） */
        compareUrl: '',       /* 对比原图专用 objectURL（独立生命周期） */
        currentOriginalSrc: '', /* 当前结果对应的原图地址（用于对比原图） */
        selectedStyle: 'cartoon',
        generating: false,
        history: [],          /* { src, thumb, styleName, mode, time } */
        cloudHistory: [],     /* 云端历史 { src, thumb, styleName, mode, time, cloud } */
        user: null,           /* 当前登录用户（session.user，未登录为 null） */
        currentResultUrl: '',
        loadingTimer: null
      },

      styles: function () {
        var s = this.state.config.styles;
        return (s && s.length) ? s : FALLBACK_STYLES;
      },
      getStyle: function (id) {
        var list = this.styles();
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === id) { return list[i]; }
        }
        return null;
      },
      getProviderFor: function (style) {
        if (!style || !style.providerId) { return null; }
        var providers = this.state.config.providers || [];
        for (var i = 0; i < providers.length; i++) {
          if (providers[i].id === style.providerId) { return providers[i]; }
        }
        return null;
      },

      /* 应用后台配置（管理后台保存后前端即可拿到最新风格与服务商） */
      applyConfig: function (data) {
        if (!data || typeof data !== 'object') { return false; }
        var styles = Array.isArray(data.styles) ? data.styles : [];
        var providers = Array.isArray(data.providers) ? data.providers : [];
        var valid = [];
        for (var i = 0; i < styles.length; i++) {
          var s = styles[i];
          if (!s || !s.id || !s.name) { continue; }
          /* 产品隔离：只要本产品的风格（历史数据无 product 字段视为 avatar） */
          if (s.product && s.product !== 'avatar') { continue; }
          valid.push({
            id: String(s.id),
            name: String(s.name),
            imageUrl: typeof s.imageUrl === 'string' ? s.imageUrl : '',
            prompt: typeof s.prompt === 'string' ? s.prompt : '',
            providerId: s.providerId || '',
            product: 'avatar'
          });
        }
        if (!valid.length) { return false; }
        this.state.config = {
          providers: providers,
          styles: valid
        };
        this.state.configFromDb = true;
        /* 当前选中风格不存在时回退到第一个 */
        if (!this.getStyle(this.state.selectedStyle)) {
          this.state.selectedStyle = valid[0].id;
        }
        return true;
      },

      addHistory: function (entry) {
        this.state.history.unshift(entry);
        if (this.state.history.length > HISTORY_MAX) {
          this.state.history.length = HISTORY_MAX;
        }
        this.persistHistory();
      },
      /* 持久化：优先存 512px JPEG 缩略图；配额满则静默降级为仅本次会话 */
      persistHistory: function () {
        var list = [];
        for (var i = 0; i < this.state.history.length; i++) {
          var h = this.state.history[i];
          var persistSrc = h.thumb || (h.src && h.src.indexOf('data:') === 0 ? h.src : '');
          if (!persistSrc) { continue; }
          list.push({ src: persistSrc, styleName: h.styleName, mode: h.mode, time: h.time });
        }
        storageService.writeHistory(list); /* 失败时静默：仅保留会话内历史 */
      },
      restoreHistory: function () {
        var saved = storageService.readHistory();
        var arr = [];
        for (var i = 0; i < saved.length; i++) {
          if (saved[i] && saved[i].src) {
            arr.push({
              src: saved[i].src, thumb: saved[i].src,
              styleName: saved[i].styleName || '历史头像',
              mode: saved[i].mode === 'ai' ? 'ai' : 'local',
              time: saved[i].time || 0
            });
          }
        }
        this.state.history = arr;
      }
    };

    /* =========================================================
     * Section J3: Services 层（不操作页面 DOM）
     * ========================================================= */

    /* --- storageService：localStorage 读写（try/catch 配额降级） --- */
    var storageService = {
      readHistory: function () {
        try {
          var v = JSON.parse(localStorage.getItem(LS_HISTORY_KEY) || '[]');
          return Array.isArray(v) ? v : [];
        } catch (_) { return []; }
      },
      writeHistory: function (list) {
        try {
          localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(list));
          return true;
        } catch (_) { return false; } /* 配额满 / 隐私模式：静默降级 */
      }
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

    /* --- imageService：图片编解码与缩放 --- */
    var imageService = {
      resizeImage: function (file, maxPx) {
        maxPx = maxPx || UPLOAD_RESIZE_PX;
        return new Promise(function (resolve, reject) {
          var img = new Image();
          var url = URL.createObjectURL(file);
          img.onload = function () {
            var scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            canvas.toBlob(function (blob) {
              if (blob) { resolve(blob); } else { reject(new Error('图片导出失败')); }
            }, 'image/png');
          };
          img.onerror = function () {
            URL.revokeObjectURL(url);
            reject(new Error('图片加载失败'));
          };
          img.src = url;
        });
      },
      blobToImage: function (blob) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          var url = URL.createObjectURL(blob);
          img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
          img.src = url;
        });
      },
      blobToDataURL: function (blob) {
        return new Promise(function (resolve, reject) {
          var r = new FileReader();
          r.onload = function () { resolve(r.result); };
          r.onerror = function () { reject(new Error('读取失败')); };
          r.readAsDataURL(blob);
        });
      },
      canvasToBlob: function (canvas) {
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (b) {
            if (b) { resolve(b); } else { reject(new Error('导出失败')); }
          }, 'image/png');
        });
      },
      loadImage: function (src) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () { resolve(img); };
          img.onerror = function () { reject(new Error('图片加载失败')); };
          img.src = src;
        });
      },
      /* 结果缩略图：512px JPEG（质量 0.7）用于历史持久化；跨域/污染画布时返回 null */
      makeThumbnail: function (src) {
        return imageService.loadImage(src).then(function (img) {
          var scale = Math.min(1, THUMB_PX / Math.max(img.naturalWidth, img.naturalHeight));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', THUMB_QUALITY);
        }).catch(function () { return null; });
      },
      /* 照片模式上传前的轻压缩：保持 1024px 与较高质量，将 PNG 原图转为
       * JPEG 以大幅减小上传体积（约 5 倍），加快移动端上传速度；
       * 画质足够 AI 理解人脸构图。压缩环境异常时由调用方回退原始 dataURL。 */
      compressForEdits: function (blob) {
        return imageService.blobToImage(blob).then(function (img) {
          var scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', 0.85);
        });
      }
    };

    /* --- aiService：OpenAI 兼容图像接口（provider 来自后台配置，显式传参） --- */
    var DEFAULT_STYLE_PROMPT =
      'Create a high quality portrait avatar suitable as a profile picture. Keep the subject\'s facial features and hairstyle natural and clearly recognizable.';
    var aiService = {
      /* 风格提示词可留空：留空则直接把用户填写的「补充描述」当作提示词；
         两者都为空时用通用人像提示词，保证始终有可发送的内容 */
      buildPrompt: function (style, extraText) {
        var base = String(style.prompt || '').trim();
        var extra = String(extraText || '').trim();
        var userExtra = '';
        if (base) {
          if (extra) {
            userExtra = '\nAdditional user requests (follow them, but never output text): ' + extra;
          }
        } else {
          base = extra || DEFAULT_STYLE_PROMPT;
        }
        return base + userExtra + COMMON_PROMPT_SUFFIX;
      },
      apiUrl: function (provider, path) {
        return provider.baseUrl.replace(/\/+$/, '') + path;
      },
      /* 同源代理 + 心跳流：请求发到本站 /api/ai，由服务端转发给服务商。
       * 服务端在等待期间每 2 秒写一个心跳注释，避免托管平台「空闲 30 秒即 524」，
       * 最终结果放在最后一行 data: 中，前端边读流边显示已等待秒数。 */
      postProxy: function (provider, apiPath, prompt, imageDataUrl) {
        /* Key 已下沉到服务器（按 providerId 解析），前端不再持有 */
        var payload = {
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          model: provider.model,
          path: apiPath,
          prompt: prompt
        };
        if (imageDataUrl) { payload.imageBase64 = imageDataUrl; }

        /* 带上登录令牌：服务端据此校验身份并扣费（扣费在服务端做，前端绕不过） */
        return getAuthToken().then(function (token) {
          var headers = { 'Content-Type': 'application/json' };
          if (token) { headers.Authorization = 'Bearer ' + token; }
          return fetch('/api/ai', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
          });
        }).then(function (res) {
          /* 服务端扣费后的余额 + 生成单号（P3：一次生成一单，失败由服务端退款） */
          var bal = res.headers && res.headers.get ? res.headers.get('X-Wallet-Balance') : null;
          if (bal !== null && bal !== '') { walletService.applyBalance(bal); }
          var orderId = res.headers && res.headers.get ? res.headers.get('X-Order-Id') : null;
          if (orderId) { Store.state.lastOrderId = orderId; }
          var ctype = (res.headers && res.headers.get ? res.headers.get('Content-Type') : '') || '';
          /* 参数错误 / 未登录 / 积分不足等快速失败：普通 JSON 响应 */
          if (ctype.indexOf('text/event-stream') === -1 || !res.body || !res.body.getReader) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              return { statusCode: res.status, data: body };
            });
          }
          return aiService.readHeartbeatStream(res);
        }).then(function (r) {
          var sc = r && r.statusCode ? r.statusCode : 502;
          if (sc < 200 || sc >= 300) {
            var info = (r.data && r.data.error) || {};
            var msg = info.message || ('HTTP ' + sc);
            var err = new Error(msg);
            err.status = sc;
            err.code = info.code || '';
            if (err.code === 'INSUFFICIENT_BALANCE') { err.insufficient = true; }
            if (err.code === 'AUTH_REQUIRED') { err.authRequired = true; }
            throw err;
          }
          return r.data;
        }).then(aiService.parseImageResponse).then(aiService.extractImageUrl);
      },
      /* 读取心跳流：注释行（以 : 开头）用于更新已等待秒数，data: 行为最终结果 */
      readHeartbeatStream: function (res) {
        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buf = '';
        var result = null;

        function handleLine(line) {
          line = line.trim();
          if (!line) { return; }
          if (line.indexOf('data:') === 0) {
            try {
              var obj = JSON.parse(line.slice(5).trim());
              if (obj && obj.statusCode) { result = obj; }
            } catch (_) { /* 心跳等非 JSON 行忽略 */ }
            return;
          }
          if (line.indexOf(':') === 0 && aiService.onProgress) {
            var m = /(\d+)/.exec(line);
            if (m) { aiService.onProgress(Number(m[1])); }
          }
        }

        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) {
              if (!result) {
                /* 连接断了不代表被扣钱：服务端会按投放结果决定 success 还是退款 */
                var e = new Error('生成连接被中断（未收到结果）。若已扣积分会自动退回，也可到「我的」看看是否已生成');
                e.status = 502;
                throw e;
              }
              return result;
            }
            buf += decoder.decode(chunk.value, { stream: true });
            var lines = buf.split('\n');
            buf = lines.pop();
            lines.forEach(handleLine);
            return pump();
          });
        }
        return pump();
      },
      callImageEdits: function (provider, photoBlob, prompt) {
        /* 轻压缩加快上传（不改变画质策略）；压缩环境异常时退回原始 dataURL。 */
        return imageService.compressForEdits(photoBlob)
          .catch(function () { return imageService.blobToDataURL(photoBlob); })
          .then(function (dataUrl) {
            return aiService.postProxy(provider, '/images/edits', prompt, dataUrl);
          });
      },
      callImageGenerations: function (provider, prompt) {
        return aiService.postProxy(provider, '/images/generations', prompt, '');
      },
      parseImageResponse: function (body) {
        if (!body || !body.data || !body.data.length) {
          throw new Error('接口返回为空，未生成任何图片');
        }
        return body.data[0];
      },
      extractImageUrl: function (item) {
        if (item.b64_json) { return 'data:image/png;base64,' + item.b64_json; }
        if (item.url) { return item.url; }
        throw new Error('接口返回中没有图片数据（既没有 b64_json 也没有 url）');
      },
      /* 生成进度回调（由页面在生成时注入，用于显示已等待秒数） */
      onProgress: null,
      /* 自动重试只用于「请求被直接拒收、不会计费」的瞬态错误（502 网关拒收 /
       * 503 账号池满）。超时类（504/524）绝不重试：服务商侧往往已成功计费，
       * 重试会造成重复扣费。 */
      RETRYABLE_STATUS: [502, 503],
      withRetry: function (fn, onRetry) {
        var MAX = 2;
        function tryOnce(i) {
          return fn().catch(function (err) {
            var retryable = aiService.RETRYABLE_STATUS.indexOf(err && err.status) !== -1;
            if (!retryable || i >= MAX - 1) { throw err; }
            if (onRetry) { onRetry(i + 1, MAX - 1 - i); }
            return new Promise(function (resolve) { setTimeout(resolve, 1500); })
              .then(function () { return tryOnce(i + 1); });
          });
        }
        return tryOnce(0);
      },
      explainError: function (err) {
        var status = err && err.status;
        if (err && err.jobLost) {
          return '生成任务已中断（服务重启或任务过期）。请重新点击生成；若服务商已计费，可稍后在服务商后台查看记录。';
        }
        /* 平台侧错误优先：这两种不是服务商问题，别误导用户去找管理员 */
        if (err && err.authRequired) {
          return '登录状态已失效，请重新登录后再生成（本次未扣积分）。';
        }
        if (status === 402 || (err && err.insufficient)) {
          return (err && err.message) || '积分不足：免费体验已用完，请充值或输入兑换码。';
        }
        if (status === 401 || status === 403) {
          return '鉴权失败（' + status + '）：该风格绑定的服务商 API Key 无效或没有权限，请站点管理员在后台检查配置。';
        }
        if (status === 404) {
          return '接口路径不存在（404）：请管理员检查服务商接口地址是否以 /v1 结尾，或该服务商是否支持此图像接口。';
        }
        if (status === 429) {
          return '请求太频繁或额度不足（429）。请稍后重试，或联系管理员更换有额度的 Key。';
        }
        if (status === 504) {
          return '生成超时（504）：服务商在 5 分钟内没有返回结果。服务商侧可能已生成并计费，请先稍等 1 分钟再重试，避免重复扣费。';
        }
        if (status === 524) {
          return '生成超时（524）：请求等待时间超过了网关上限。服务商侧可能已生成并计费，请不要连点重试，稍等 1 分钟后再试一次。';
        }
        if (status === 503) {
          return '服务商上游暂时没有可用资源（503）：中转站账号池已满或临时维护，请稍等几分钟再重试。';
        }
        if (status >= 500) {
          return 'AI 服务端暂时出错（' + status + '）：中转站服务波动或上游异常，与请求内容无关，请稍等几分钟再重试。';
        }
        if (err instanceof TypeError) {
          var diag = err && err.message ? err.message : 'Failed to fetch';
          return '请求没有发出去：本站的转发服务不可用（可能页面不是从线上站点打开的）。请通过线上地址访问后重试。'
            + '（诊断信息：' + diag + '）';
        }
        return (err && err.message) || '未知错误，请重试。';
      }
    };

    /* =========================================================
     * Section J4: UI 层（渲染 + 事件绑定）
     * ========================================================= */
    function $(id) { return document.getElementById(id); }

    var els = {
      uploadZone: $('uploadZone'), fileInput: $('fileInput'),
      uploadEmpty: $('uploadEmpty'), uploadMainText: $('uploadMainText'),
      uploadPreview: $('uploadPreview'), previewImg: $('previewImg'),
      fileName: $('fileName'), fileSize: $('fileSize'),
      btnRemovePhoto: $('btnRemovePhoto'),
      styleGrid: $('styleGrid'), extraInput: $('extraInput'),
      btnGenerate: $('btnGenerate'),
      btnGenIdle: $('btnGenIdle'), btnGenBusy: $('btnGenBusy'),
      genHint: $('genHint'),
      resultEmpty: $('resultEmpty'), resultLoading: $('resultLoading'),
      loadingSkeleton: $('loadingSkeleton'), loadingSpinner: $('loadingSpinner'),
      loadingTip: $('loadingTip'),
      resultShow: $('resultShow'), resultImg: $('resultImg'),
      resultError: $('resultError'), errorMsg: $('errorMsg'),
      btnRetry: $('btnRetry'),
      resultActions: $('resultActions'),
      btnDownload: $('btnDownload'), btnAgain: $('btnAgain'),
      btnMaximize: $('btnMaximize'), btnCompare: $('btnCompare'),
      historyWrap: $('historyWrap'), historyStrip: $('historyStrip'),
      previewNotice: $('previewNotice'), btnOpenNewTab: $('btnOpenNewTab'),
      lightbox: $('lightbox'), lightboxImg: $('lightboxImg'),
      btnCloseLightbox: $('btnCloseLightbox'),
      step1: $('step1'), step2: $('step2'), step3: $('step3'),
      /* 登录与云同步 */
      btnLogin: $('btnLogin'), btnSignOut: $('btnSignOut'),
      userChip: $('userChip'), userChipText: $('userChipText'),
      /* 积分钱包 */
      btnWallet: $('btnWallet'), walletBalance: $('walletBalance'),
      walletModal: $('walletModal'), btnCloseWallet: $('btnCloseWallet'),
      walletBalanceBig: $('walletBalanceBig'), productGrid: $('productGrid'),
      payChannelsNote: $('payChannelsNote'),
      redeemCode: $('redeemCode'), btnRedeem: $('btnRedeem'), walletMsg: $('walletMsg'),
      txnHistory: $('txnHistory'),
      loginModal: $('loginModal'), btnCloseLogin: $('btnCloseLogin'),
      loginPhone: $('loginPhone'), errPhone: $('errPhone'),
      loginCode: $('loginCode'), errCode: $('errCode'),
      btnSendCode: $('btnSendCode'), btnPhoneLogin: $('btnPhoneLogin'),
      btnWechatLogin: $('btnWechatLogin'), loginMsg: $('loginMsg')
    };

    /* ---------- 渲染：步骤条 ---------- */
    function updateSteps() {
      var st = Store.state;
      var hasResult = !!st.currentResultUrl && !st.resultErrorVisible;
      els.step1.classList.toggle('done', !!st.photoFile);
      els.step2.classList.toggle('done', !!st.selectedStyle);
      els.step3.classList.toggle('done', hasResult && !st.generating);
      els.step1.classList.toggle('active', !st.photoFile && !st.generating);
      els.step2.classList.toggle('active', !!st.photoFile && !st.generating);
      els.step3.classList.toggle('active', st.generating);
    }

    /* ---------- 渲染：提示 ---------- */
    function showHint(msg, warn) {
      els.genHint.textContent = msg;
      els.genHint.classList.toggle('warn', !!warn);
    }

    /* ---------- 渲染：风格网格（来自后台配置，radiogroup + 方向键） ---------- */
    function renderStyleGrid() {
      els.styleGrid.innerHTML = '';
      var list = Store.styles();
      list.forEach(function (style) {
        var card = document.createElement('div');
        card.className = 'style-card' +
          (style.id === Store.state.selectedStyle ? ' selected' : '');
        card.dataset.id = style.id;
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', style.id === Store.state.selectedStyle ? 'true' : 'false');
        card.setAttribute('tabindex', style.id === Store.state.selectedStyle ? '0' : '-1');

        var art = document.createElement('span');
        art.className = 'card-art';
        if (style.imageUrl) {
          art.style.backgroundImage = 'url("' + style.imageUrl + '")';
        } else {
          /* 未上传封面图：中性占位（不再使用内置图标与配色） */
          var ph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          ph.setAttribute('class', 'icon icon-20');
          ph.setAttribute('aria-hidden', 'true');
          var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
          use.setAttribute('href', '#i-image');
          ph.appendChild(use);
          art.appendChild(ph);
        }
        card.appendChild(art);

        var check = document.createElement('span');
        check.className = 'card-check';
        check.innerHTML = '<svg class="icon icon-12" aria-hidden="true"><use href="#i-check"/></svg>';
        card.appendChild(check);

        var name = document.createElement('span');
        name.className = 'card-name';
        name.textContent = style.name;
        card.appendChild(name);

        card.addEventListener('click', function () { selectStyle(style.id); });
        els.styleGrid.appendChild(card);
      });
    }

    function selectStyle(id) {
      Store.state.selectedStyle = id;
      var cards = els.styleGrid.querySelectorAll('[role="radio"]');
      cards.forEach(function (c) {
        var selected = c.dataset.id === id;
        c.classList.toggle('selected', selected);
        c.setAttribute('aria-checked', selected ? 'true' : 'false');
        c.setAttribute('tabindex', selected ? '0' : '-1');
      });
      updateSteps();
    }

    function handleStyleKeydown(e) {
      var cards = Array.prototype.slice.call(els.styleGrid.querySelectorAll('[role="radio"]'));
      var idx = cards.indexOf(document.activeElement);
      var next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { next = Math.min(cards.length - 1, idx + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { next = Math.max(0, idx - 1); }
      else if (e.key === 'Home') { next = 0; }
      else if (e.key === 'End') { next = cards.length - 1; }
      else if (e.key === 'Enter' || e.key === ' ') {
        if (idx >= 0) { selectStyle(cards[idx].dataset.id); e.preventDefault(); }
        return;
      } else { return; }
      e.preventDefault();
      if (idx < 0) { next = 0; }
      if (cards[next]) { selectStyle(cards[next].dataset.id); cards[next].focus(); }
    }

    /* ---------- 渲染：结果区四态 ---------- */
    function hideAllResultStates() {
      els.resultEmpty.hidden = true;
      els.resultLoading.hidden = true;
      els.resultShow.hidden = true;
      els.resultError.hidden = true;
      els.resultActions.hidden = true;
      Store.state.resultErrorVisible = false;
    }

    function setResultEmpty() {
      hideAllResultStates();
      els.resultEmpty.hidden = false;
    }

    function setResultLoading(styleName) {
      hideAllResultStates();
      els.resultLoading.hidden = false;
      els.loadingSkeleton.hidden = true;
      els.loadingSpinner.hidden = false;
      startLoadingTips(styleName);
    }

    function startLoadingTips(styleName) {
      stopLoadingTips();
      var i = 0;
      els.loadingTip.textContent =
        '正在生成「' + (styleName || '') + '」头像 · ' + AI_LOADING_TIPS[0];
      Store.state.loadingTimer = setInterval(function () {
        i = (i + 1) % AI_LOADING_TIPS.length;
        els.loadingTip.textContent = AI_LOADING_TIPS[i];
      }, 3000);
    }

    function stopLoadingTips() {
      if (Store.state.loadingTimer) {
        clearInterval(Store.state.loadingTimer);
        Store.state.loadingTimer = null;
      }
    }

    function setResultSuccess(url, opts) {
      hideAllResultStates();
      stopLoadingTips();
      opts = opts || {};
      Store.state.currentResultUrl = url;
      els.resultImg.src = url;
      els.resultShow.hidden = false;
      els.resultActions.hidden = false;
      els.btnCompare.hidden = opts.fromHistory || !Store.state.currentOriginalSrc;
      Store.state.resultErrorVisible = false;
    }

    function setResultError(msg) {
      hideAllResultStates();
      stopLoadingTips();
      els.errorMsg.textContent = msg;
      els.resultError.hidden = false;
      Store.state.resultErrorVisible = true;
    }

    /* ---------- 渲染：历史条（本地 + 云端合并，按时间倒序） ---------- */
    function renderHistory() {
      var st = Store.state;
      var all = st.history.concat(st.cloudHistory || []).sort(function (a, b) {
        return (b.time || 0) - (a.time || 0);
      });
      els.historyWrap.hidden = all.length === 0;
      els.historyStrip.innerHTML = '';
      all.forEach(function (h) {
        var btn = document.createElement('button');
        btn.className = 'history-item' + (h.src === st.currentResultUrl ? ' selected' : '');
        btn.type = 'button';
        btn.title = h.styleName + ' · ' + new Date(h.time).toLocaleTimeString();
        btn.setAttribute('aria-label', '回看：' + h.styleName);
        var img = document.createElement('img');
        img.src = h.src;
        img.alt = '';
        img.loading = 'lazy';
        btn.appendChild(img);
        var eye = document.createElement('span');
        eye.className = 'history-eye';
        eye.innerHTML = '<svg class="icon icon-16" aria-hidden="true"><use href="#i-eye"/></svg>';
        btn.appendChild(eye);
        if (h.mode === 'ai') {
          var badge = document.createElement('span');
          badge.className = 'history-ai-badge';
          badge.innerHTML = '<svg class="icon icon-12" aria-hidden="true"><use href="#i-sparkles"/></svg>';
          btn.appendChild(badge);
        }
        btn.addEventListener('click', function () {
          setResultSuccess(h.src, { fromHistory: true });
          renderHistory();
        });
        els.historyStrip.appendChild(btn);
      });
    }

    /* ---------- 生成中防重复提交 ---------- */
    function setGenerating(busy) {
      Store.state.generating = busy;
      els.btnGenerate.disabled = busy;
      els.btnGenerate.setAttribute('aria-busy', busy ? 'true' : 'false');
      els.btnGenIdle.hidden = busy;
      els.btnGenBusy.hidden = !busy;
      els.styleGrid.classList.toggle('is-busy', busy);
      els.styleGrid.setAttribute('aria-disabled', busy ? 'true' : 'false');
      updateSteps();
    }

    /* ---------- 照片接受 / 移除 ---------- */
    function formatBytes(bytes) {
      if (bytes >= 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
      if (bytes >= 1024) { return (bytes / 1024).toFixed(0) + ' KB'; }
      return bytes + ' B';
    }

    function acceptPhoto(file) {
      if (!file) { return; }
      if (!file.type || file.type.indexOf('image/') !== 0) {
        showHint('请选择图片文件（JPG / PNG / WebP）', true);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        showHint('图片太大了，请选择 20MB 以内的照片', true);
        return;
      }
      var st = Store.state;
      if (st.photoUrl) { URL.revokeObjectURL(st.photoUrl); }
      st.photoFile = file;
      st.photoUrl = URL.createObjectURL(file);
      st.photoBlob = null;
      els.previewImg.src = st.photoUrl;
      els.fileName.textContent = file.name;
      els.fileSize.textContent = formatBytes(file.size);
      els.uploadEmpty.hidden = true;
      els.uploadPreview.hidden = false;
      showHint('');
      updateSteps();
      /* 上传后自动缩放到 1024px PNG blob，供 /images/edits 使用 */
      imageService.resizeImage(file, UPLOAD_RESIZE_PX)
        .then(function (blob) { st.photoBlob = blob; })
        .catch(function () { st.photoBlob = null; });
    }

    function removePhoto() {
      var st = Store.state;
      st.photoFile = null;
      st.photoBlob = null;
      if (st.photoUrl) { URL.revokeObjectURL(st.photoUrl); }
      st.photoUrl = '';
      els.previewImg.src = '';
      els.uploadEmpty.hidden = false;
      els.uploadPreview.hidden = true;
      updateSteps();
    }

    /* 对比原图：独立 objectURL，不受移除照片影响 */
    function refreshCompareSource() {
      var st = Store.state;
      if (st.compareUrl) { URL.revokeObjectURL(st.compareUrl); st.compareUrl = ''; }
      if (st.photoFile) { st.compareUrl = URL.createObjectURL(st.photoFile); }
      st.currentOriginalSrc = st.compareUrl;
    }

    /* ---------- 生成主流程：按所选风格的提示词 + 绑定服务商/模型调用 AI ---------- */
    function handleGenerate() {
      var st = Store.state;
      if (st.generating) { return; }

      /* 预览环境（iframe / 本地 127.0.0.1）会注入 CSP，外部 AI 请求必被拦截：提前给出可操作提示 */
      if (isPreviewEnv()) {
        showPreviewNotice();
        showHint(isLocalPreview()
          ? '当前是本地预览地址（' + location.hostname + '），预览服务器不允许访问外部 AI 接口。请点顶部提示里的链接打开线上地址后生成'
          : '当前在预览面板中，外部 AI 请求会被安全策略拦截。请点顶部提示里的「在新标签页打开」后重新生成', true);
        return;
      }

      if (!Store.state.user) {
        showHint('为保护服务商 Key 安全，生成头像需先登录。点击右上角「登录」后再试', true);
        openLogin();
        return;
      }

      var style = Store.getStyle(st.selectedStyle);
      if (!style) {
        showHint('暂无可用风格，请站点管理员在后台配置', true);
        return;
      }
      var provider = Store.getProviderFor(style);
      if (!provider) {
        showHint('风格「' + style.name + '」尚未绑定 AI 服务商，请站点管理员在后台配置', true);
        return;
      }
      if (!provider.baseUrl || !provider.model) {
        showHint('服务商「' + provider.name + '」配置不完整（接口地址 / 模型名），请站点管理员在后台补全', true);
        return;
      }
      var pureText = provider.apiMode === 'generation';
      if (!pureText && !st.photoFile) {
        showHint('该风格基于照片生成，请先上传一张照片', true);
        return;
      }

      if (st.photoFile) { refreshCompareSource(); }

      setGenerating(true);
      showHint('');
      setResultLoading(style.name);

      var prompt = aiService.buildPrompt(style, els.extraInput.value.trim());
      /* 后台任务轮询期间持续显示已用时长，让用户知道没卡死 */
      aiService.onProgress = function (elapsed) {
        showHint('生成中… 已等待 ' + elapsed + ' 秒，请勿关闭页面（服务商出图通常需 20~90 秒）');
      };
      var run = Promise.resolve()
        /* 扣费已下沉到服务端 /api/ai：先扣后放行、上游失败自动退。
         * 前端不再自行扣减（2026-10-30 事故：前端扣费在会话过期后会扣到匿名账户上）。 */
        .then(function () {
          if (pureText) { return null; }
          return st.photoBlob || imageService.resizeImage(st.photoFile, UPLOAD_RESIZE_PX);
        })
        .then(function (blob) {
          if (blob) { st.photoBlob = blob; }
          var call = pureText
            ? function () { return aiService.callImageGenerations(provider, prompt); }
            : function () { return aiService.callImageEdits(provider, st.photoBlob, prompt); };
          return aiService.withRetry(call, function (n, left) {
            showHint('服务商波动，自动重试中（' + n + '/' + left + '）…');
          });
        });

      run.then(function (url) {
        st.currentResultUrl = url;
        setResultSuccess(url);
        updateSteps();
        /* 图片已经可见 = 这次生成结束了：立刻归还按钮。
         * 2026-10-30 实测问题：按钮复位原先挂在缩略图 + 云同步之后，1–2MB 原图
         * 在移动网络上传几十秒甚至一直不返回，按钮就永远停在「生成中」。 */
        finishGenerating();
        persistResultInBackground(url, style);
      }).catch(function (err) {
        /* 退费由服务端在生成失败时自动完成（RPC 幂等），前端不再单独退款 */
        if (err && err.authRequired) {
          applySession(null);
          showHint('登录状态已失效，请重新登录后再生成（本次未扣积分）', true);
          openLogin();
          updateSteps();
          finishGenerating();
          return;
        }
        setResultError(aiService.explainError(err));
        if (err && err.insufficient) { openWallet(err.message); }
        updateSteps();
        finishGenerating();
      });
    }

    /* 生成结束（成功或失败）：清进度回调、清「已等待 N 秒」提示、复位按钮与风格网格 */
    function finishGenerating() {
      aiService.onProgress = null;
      showHint('');
      setGenerating(false);
    }

    /* 带超时的 Promise 包装：超时按失败（resolve null）处理，绝不让人无限等。
     * 用于后台上传这类可能长时间挂起、且失败也不影响已展示结果的动作。 */
    function withTimeout(promise, ms) {
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) { return; }
          settled = true;
          resolve(null);
        }, ms);
        Promise.resolve(promise).then(function (v) {
          if (settled) { return; }
          settled = true; clearTimeout(timer); resolve(v);
        }, function () {
          if (settled) { return; }
          settled = true; clearTimeout(timer); resolve(null);
        });
      });
    }

    /* 结果落盘（后台）：本地缩略图历史 + 云端同步。任何失败都静默，不阻塞交互 */
    function persistResultInBackground(url, style) {
      withTimeout(imageService.makeThumbnail(url), 8000).then(function (thumb) {
        Store.addHistory({
          src: url, thumb: thumb,
          styleName: style.name,
          mode: 'ai', time: Date.now()
        });
        renderHistory();
      });

      if (!Store.state.user) { return; }
      withTimeout(syncResultToCloud(url, style), 25000).then(function (ok) {
        /* 用户可能已经开始下一次生成，别覆盖它正在显示的提示 */
        if (ok && !Store.state.generating) { showHint('已保存到「我的作品」。'); }
      });
    }

    /* ---------- 下载（dataURL 直接下载；url 先转 blob；失败兜底新窗口） ---------- */
    function downloadResult() {
      var url = Store.state.currentResultUrl;
      if (!url) { return; }
      var tempUrl = '';
      var href = url;
      var prepare = url.indexOf('data:') === 0
        ? Promise.resolve()
        : fetch(url).then(function (res) { return res.blob(); }).then(function (blob) {
            href = URL.createObjectURL(blob);
            tempUrl = href;
          });
      prepare.then(function () {
        var a = document.createElement('a');
        a.href = href;
        a.download = 'avatar-' + Date.now() + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (tempUrl) { setTimeout(function () { URL.revokeObjectURL(tempUrl); }, 1000); }
      }).catch(function () {
        window.open(url, '_blank');
      });
    }

    /* ---------- 弹窗：大图预览 ---------- */
    function openLightbox(src, label) {
      els.lightboxImg.src = src;
      els.lightboxImg.alt = label || '预览大图';
      els.lightbox.hidden = false;
      els.btnCloseLightbox.focus();
    }
    function closeLightbox() {
      els.lightbox.hidden = true;
      els.lightboxImg.src = '';
    }

    /* ---------- 事件绑定 ---------- */
    function bindEvents() {
      /* 上传：点击 / 拖拽 / 粘贴 */
      els.uploadZone.addEventListener('click', function () { els.fileInput.click(); });
      els.uploadZone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
      });
      els.fileInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files[0]) { acceptPhoto(e.target.files[0]); }
        els.fileInput.value = '';
      });

      /* 拖拽（计数器方案防子元素误触发 dragleave） */
      var dragDepth = 0;
      els.uploadZone.addEventListener('dragenter', function (e) {
        e.preventDefault();
        dragDepth++;
        els.uploadZone.classList.add('dragover');
        els.uploadMainText.textContent = '松开即可上传';
      });
      els.uploadZone.addEventListener('dragover', function (e) { e.preventDefault(); });
      els.uploadZone.addEventListener('dragleave', function (e) {
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
          els.uploadZone.classList.remove('dragover');
          els.uploadMainText.textContent = '拖拽照片到这里，或点击选择';
        }
      });
      els.uploadZone.addEventListener('drop', function (e) {
        e.preventDefault();
        dragDepth = 0;
        els.uploadZone.classList.remove('dragover');
        els.uploadMainText.textContent = '拖拽照片到这里，或点击选择';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          acceptPhoto(e.dataTransfer.files[0]);
        }
      });

      document.addEventListener('paste', function (e) {
        var items = e.clipboardData && e.clipboardData.items ? e.clipboardData.items : [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf('image/') === 0) {
            acceptPhoto(items[i].getAsFile());
            break;
          }
        }
      });

      els.btnRemovePhoto.addEventListener('click', function (e) {
        e.stopPropagation();
        removePhoto();
      });

      /* 风格选择 */
      els.styleGrid.addEventListener('keydown', handleStyleKeydown);

      /* 生成 / 结果操作：所有入口先复核会话（过期会话不能带着旧登录态继续扣费） */
      var startGenerate = function () {
        ensureAuth().then(function (user) {
          if (!user) {
            showHint('登录状态已失效，请重新登录后再生成', true);
            openLogin();
            return;
          }
          handleGenerate();
        });
      };
      els.btnGenerate.addEventListener('click', startGenerate);
      els.btnAgain.addEventListener('click', startGenerate);
      els.btnRetry.addEventListener('click', startGenerate);
      els.btnDownload.addEventListener('click', downloadResult);
      els.btnMaximize.addEventListener('click', function () {
        if (Store.state.currentResultUrl) {
          openLightbox(Store.state.currentResultUrl, '生成的头像大图');
        }
      });
      els.btnCompare.addEventListener('click', function () {
        if (Store.state.currentOriginalSrc) {
          openLightbox(Store.state.currentOriginalSrc, '原始上传照片');
        }
      });

      /* 大图预览 */
      els.btnCloseLightbox.addEventListener('click', closeLightbox);
      els.lightbox.addEventListener('click', function (e) {
        if (e.target === els.lightbox) { closeLightbox(); }
      });
      els.resultImg.addEventListener('click', function () {
        if (Store.state.currentResultUrl) {
          openLightbox(Store.state.currentResultUrl, '生成的头像大图');
        }
      });

      /* Esc：先关大图预览，再关登录弹窗 */
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') { return; }
        if (!els.lightbox.hidden) { closeLightbox(); }
        else if (!els.walletModal.hidden) { closeWallet(); }
        else if (!els.loginModal.hidden) { closeLogin(); }
      });
    }


    /* ---------- 云端历史：上传 / 拉取（全部 try/catch 静默降级） ---------- */
    function syncResultToCloud(resultUrl, style) {
      var user = Store.state.user;
      var cloud = cloudService.getClient();
      var mode = 'ai';
      if (!user || !cloud || !resultUrl) { return Promise.resolve(false); }
      return fetch(resultUrl).then(function (res) { return res.blob(); }).then(function (blob) {
        if (!blob) { return false; }
        var ext = blob.type && blob.type.indexOf('png') >= 0 ? 'png' : 'jpg';
        var path = cloud.storage.userPath(user.id,
          'history/' + Date.now() + '-' + mode + '-' + style.id + '.' + ext);
        return cloud.storage.upload(path, blob, {
          contentType: blob.type || 'image/jpeg',
          metadata: { style: style.name, mode: mode }
        }).then(function (res) { return !(res && res.error); }).catch(function () { return false; });
      }).catch(function () { return false; });
    }

    function restoreCloudHistory(uid) {
      var cloud = cloudService.getClient();
      if (!cloud || !uid) { return; }
      var prefix = 'users/' + uid + '/history/';
      cloud.storage.list(prefix, { limit: CLOUD_HISTORY_MAX, sortBy: { column: 'created_at', order: 'desc' } })
        .then(function (res) {
          if (!res || res.error) { return; }
          /* 条目可能是完整 key，也可能只有文件名：交给平台层归一化后再签名 */
          var keys = Platform.storageListKeys(prefix, res);
          if (!keys.length) { Store.state.cloudHistory = []; renderHistory(); return; }
          return Platform.storageSigned(cloud, keys, 3600).then(function (signed) {
            if (!signed.length) { return; }
            var cfgStyles = Store.styles();
            var arr = [];
            for (var i = 0; i < signed.length && i < CLOUD_HISTORY_MAX; i++) {
              /* 文件名携带元数据：<ts>-<mode>-<styleId>.<ext> */
              var name = signed[i].path.slice(prefix.length);
              var parts = name.split('-');
              var mode = parts[1] === 'ai' ? 'ai' : 'local';
              var styleId = parts.slice(2).join('-').replace(/\.(png|jpg|jpeg|webp)$/i, '');
              var styleName = '云端头像';
              for (var s = 0; s < cfgStyles.length; s++) {
                if (cfgStyles[s].id === styleId) { styleName = cfgStyles[s].name; break; }
              }
              arr.push({
                src: signed[i].url, thumb: signed[i].url,
                styleName: styleName + ' · 云端',
                mode: mode,
                time: parseInt(parts[0], 10) || 0,
                cloud: true
              });
            }
            Store.state.cloudHistory = arr;
            renderHistory();
          });
        }).catch(function () { /* 拉取失败静默：本地历史不受影响 */ });
    }

    /* ---------- 启动流程：OAuth 回调分发 → 常规启动 → 云引导 ---------- */
    function clearUrlCallbackParams() {
      var url = new URL(location.href);
      ['code', 'state', 'provider'].forEach(function (k) { url.searchParams.delete(k); });
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }

    function cloudBootstrap() {
      var cloud = cloudService.getClient();
      if (!cloud) { renderAuthUI(); return; }
      cloud.auth.getSession().then(function (res) {
        var session = res && res.data ? res.data : null;
        applySession(session);
        if (session && session.user) { restoreCloudHistory(session.user.id); }
      }).catch(function () { renderAuthUI(); });
      try {
        cloud.auth.onAuthStateChange(function (event, session) {
          applySession(session || null);
          if (event === 'SIGNED_OUT') {
            Store.state.cloudHistory = [];
            renderHistory();
          } else if (session && session.user) {
            restoreCloudHistory(session.user.id);
          }
        });
      } catch (_) { /* SDK 不支持订阅时忽略 */ }
    }

    /* ---------- 后台配置加载：app_config 单行 JSONB（风格 + 服务商），失败回退内置兜底 ---------- */
    function loadRemoteConfig() {
      var cloud = cloudService.getClient();
      if (!cloud || !cloud.database || !cloud.database.from) {
        return Promise.resolve(false);
      }
      return cloud.database.from(CONFIG_TABLE)
        .select('data')
        .eq('id', CONFIG_ID)
        .limit(1)
        .then(function (res) {
          if (!res || res.error) { return false; }
          var rows = res.data || [];
          var data = rows[0] && rows[0].data;
          if (!Store.applyConfig(data)) { return false; }
          /* 配置到位后重渲染风格卡与历史（云端历史风格名解析用最新配置） */
          renderStyleGrid();
          renderHistory();
          return true;
        })
        .catch(function () { return false; });
    }

    function init() {
      Store.restoreHistory();
      renderStyleGrid();
      renderHistory();
      updateSteps();
      bindEvents();
      bindAuthEvents();
      loadPayChannels();
      if (isEmbedded() || isLocalPreview()) { showPreviewNotice(); }
    }

    /* 是否运行在内嵌预览面板（iframe）或本地预览服务器中 */
    function isEmbedded() {
      try { return window.self !== window.top; } catch (_) { return true; }
    }
    function isLocalPreview() {
      return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    }
    /* 预览环境（含本地 127.0.0.1 静态服务）会注入 CSP，仅放行白名单域名，无法调外部 AI */
    function isPreviewEnv() {
      return isEmbedded() || isLocalPreview();
    }
    function showPreviewNotice() {
      if (!els.previewNotice) { return; }
      els.previewNotice.hidden = false;
      if (els.btnOpenNewTab) { els.btnOpenNewTab.href = DEPLOYED_URL; }
      var label = els.previewNotice.querySelector('span');
      if (label && isLocalPreview()) {
        label.textContent = '当前是本地预览地址，预览服务器只放行白名单域名，外部 AI 接口会被拦截，生成必然失败。';
      }
    }

    function continueNormalStartup() {
      init();
      cloudBootstrap();
      loadRemoteConfig();
    }

    /* 回调分发：先于一切路由/守卫处理 OAuth 回跳，随后清理 URL（code 单次有效） */
    function restoreAuth() {
      var url = new URL(location.href);
      if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
        continueNormalStartup();
        return;
      }
      var provider = url.searchParams.get('provider');
      var cloud = cloudService.getClient();
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
          restoreCloudHistory(res.data.user.id);
          showHint('登录成功，头像历史已接入云端同步');
          return;
        }
        continueNormalStartup();
      }).catch(function () {
        continueNormalStartup();
        showHint('登录回调处理失败，请重新登录', true);
      });
    }

  /* ---------- 接入平台层（登录 / 钱包 / 支付） ---------- */
  var PUBLIC_CONFIG = Platform.PUBLIC_CONFIG;
  var CONFIG_TABLE = Platform.CONFIG_TABLE;
  var CONFIG_ID = Platform.CONFIG_ID;
  var auth = Platform.setup({
    els: els,
    store: Store,
    showHint: showHint,
    callbackPath: '/apps/avatar/',
    userChipTitle: '已登录，头像历史云同步中',
    onLoginSuccess: function (user) { if (user) { restoreCloudHistory(user.id); } },
    onSignOut: function () {
      Store.state.cloudHistory = [];
      renderHistory();
    }
  });
  var applySession = auth.applySession;
  var ensureAuth = auth.ensureAuth;
  var getAuthToken = auth.getAuthToken;
  var openLogin = auth.openLogin;
  var closeLogin = auth.closeLogin;
  var openWallet = auth.openWallet;
  var closeWallet = auth.closeWallet;
  var walletService = auth.walletService;
  var loadPayChannels = auth.loadPayChannels;
  var handlePaidReturn = auth.handlePaidReturn;
  var bindAuthEvents = auth.bindAuthEvents;
  var renderAuthUI = auth.renderAuthUI;

  restoreAuth();
})();
