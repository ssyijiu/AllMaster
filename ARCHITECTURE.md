# 「全员大师」平台 — 架构文档

> 本文档面向：新会话的 AI 助手、后续维护者。目标：让任何人（或任何 Agent）在不了解历史的情况下，
> 照着「新增产品的 6 步清单」即可基于本平台搭建下一个产品，且不影响已有产品。
>
> **平台名称：「全员大师」**（多产品 AI 工具平台，共用后端/支付/积分体系）。
> **第一个产品：「头像制作大师」**（apps/avatar，已上线）。

## 1. 项目概览

- **平台**：全员大师（多产品平台仓库，一个后端 + 一套积分/支付 + 一个部署域名）
- **第一个产品**：头像制作大师（AI Avatar Studio，`apps/avatar/`）
- **部署链接**：https://ai-avatar-studio-50356.app.workbuddy.host/?sharecode=25HFTCUZ7J
- **形态**：单端口 Node HTTP 服务（server.js），发布于 WorkBuddy sites，云端数据用 WorkBuddy 云服务（Genie-BaaS）
- **核心能力**：AI 头像生成（多 Provider）、积分钱包（云端账本 RPC）、登录/云同步、虎皮椒支付、后台配置

### 目录结构（2026-10-25 拆分后）

```
server.js                    # HTTP 服务：静态路由 + /api/ai 代理 + 支付回调 + 密钥下发
shared/                      # ★ 平台层：所有产品共用，改动需评估对全部产品的影响
  platform.js                #   登录/钱包/支付/云服务客户端，window.Platform.setup(ctx)
  base.css                   #   设计 token + 通用组件样式（按钮/弹窗/输入框等）
apps/avatar/                 # ★ 产品层：头像产品专属
  index.html                 #   页面骨架（head + body 结构 + 3 个 script 引入）
  app.js                     #   应用逻辑（Store/风格/生成/历史），IIFE，调用 Platform.setup
  avatar.css                 #   产品页专属样式
admin.html                   # 平台后台（配置 Provider/风格/套餐/密钥，暂在根目录，未拆分）
package.json                 # 无依赖，start = node server.js
.pay-config.json             # 支付通道状态（本地缓存，勿删）
```

## 2. 分层规则（最重要）

| 层 | 位置 | 内容 | 改动原则 |
|---|---|---|---|
| 平台层 | `shared/` | 登录、钱包、支付、云服务客户端、设计 token | **谨慎**：影响所有产品，改前跑全部测试 |
| 产品层 | `apps/<slug>/` | 页面结构、产品逻辑、产品样式 | 自由：只影响本产品 |
| 服务层 | `server.js` | 路由、AI 代理、支付回调、密钥 | 平台级，多产品共用一份 |

**依赖方向**：`apps/<slug>/app.js` → `shared/platform.js` → 云服务 SDK。平台层**禁止**反向引用产品层。

### platform.js 接口（Platform.setup）

```js
var auth = Platform.setup({
  els: els,                  // 应用侧 DOM 元素集合（含登录/钱包弹窗元素）
  store: Store,              // 应用状态对象（至少有 state.user / state.cloudHistory）
  showHint: showHint,        // 应用侧消息提示函数 (msg, isError)
  callbackPath: '/apps/avatar/',   // OAuth 回跳路径（各产品不同！）
  userChipTitle: '已登录，…',       // 用户徽标 hover 提示文案
  onLoginSuccess: function (user) { ... },  // 登录成功钩子（如拉云历史）
  onSignOut: function () { ... }            // 退出钩子（如清空云历史）
});
// auth = { applySession, openLogin, closeLogin, openWallet, closeWallet,
//          walletService, loadPayChannels, handlePaidReturn,
//          bindAuthEvents, renderAuthUI }
```

平台层还导出：`Platform.cloud`（云服务客户端工厂）、`Platform.PUBLIC_CONFIG`、
`Platform.CONFIG_TABLE` / `Platform.CONFIG_ID`（云端配置表名，产品共用同一张 `app_config` 表）。

**app.js 必须在 glue 处解构这些符号**（CONFIG_TABLE/CONFIG_ID/PUBLIC_CONFIG 已定义在平台层，app 内直接用会 ReferenceError 且被 catch 静默吞掉——拆分时踩过此坑）。

### 执行顺序约定（app.js 尾部）

```
… 全部函数定义（含 restoreAuth）…
var auth = Platform.setup({ … });        // glue：先初始化平台
var CONFIG_TABLE = Platform.CONFIG_TABLE; // 解构平台符号
var … = auth.xxx;                         // 解构平台返回的 10 个符号
restoreAuth();                            // 最后才执行入口（→ continueNormalStartup → init）
```
**顺序错了会报 `bindAuthEvents is not a function`**（init 在 glue 前执行时平台符号还是 undefined）。

## 3. 服务端路由（server.js）

| 路由 | 说明 |
|---|---|
| `GET /`、`/index.html` | 302 → `/apps/avatar/`（保留 query；平台门禁会消费 sharecode，属预期） |
| `GET /apps/*`、`/shared/*` | 静态文件；目录请求自动找目录下 index.html |
| `POST /api/ai` | AI 生成代理：服务端取密钥、调 Provider、SSE 透传 |
| `GET /api/pay/config` | 支付通道可用性 |
| `POST /api/pay/order` | 创建支付订单（虎皮椒） |
| `GET /api/pay/notify` | 支付异步回调（验签 → RPC 入账） |
| `GET /api/pay/return` | 支付同步回跳 → 302 产品页 `?paid=<base64>` |
| `POST /api/orders/settle` | 登录后补退：把本人被遗弃的 pending 单结掉（`order_reap(30min)`） |
| `GET /api/orders/get?id=` | 查单（本人，401 基线） |
| `GET /api/admin/orders/health?hours=` | 生成单运维快照（header `x-access-key`）；聚合数据来自云端 `order_health()`，云端内部再比一次 accessKey |
| 密钥下发 | `app_secrets` 表经 DB 端 RPC 管理，**密钥永不进前端**（admin 保存走 base64 参数化 + md5 校验） |

**生成单（P3）与巡检**：所有扣积分生成必须走 `建单 → 扣费 → 成功/失败结算`（`server/orders.js`，产品代码不得自己调 `wallet_refund`）。服务端每 30 分钟把健康快照写入 `/opt/allmaster/.health/latest.json`（隐藏目录，静态服务 403；已 gitignore），超阈值同时打 `[health] WARN` 到 journalctl；每日巡视 automation 直接 ssh 读这个文件，无需把 accessKey 写进任何脚本。

**⚠️ 发布与密钥覆盖（重要教训，2026-10-26 手机 401 事故）**：deploy 工具全量上传本地目录，
本地 `.ai-config.json` 会**覆盖**线上服务器文件——而后台保存 Key 时是先更新线上（sync-key）再写 DB，
本地文件不会自动跟上。**每次发布前必须**：从云端 `app_secrets` 以 base64 读出 providerKeys、
本地解码写入 `.ai-config.json`、md5 校验一致后再 deploy。DB `app_secrets` 是密钥唯一权威源，
本地文件只是镜像。（未来可选的根治：server.js 启动时自愈同步，需引入服务端读密钥通道，暂缓。）

## 4. 云端数据模型（WorkBuddy 云服务）

| 表 | 用途 |
|---|---|
| `app_config` | 全站配置（providers / styles / products / siteSharecode 等），id=default |
| `app_secrets` | Provider 密钥（providerKeys），仅服务端经 RPC 读取 |
| `app_wallet_txns` | 积分流水账本 |
| `app_products` | 积分套餐（也可只放在 app_config.products，当前以 app_config 为准） |

云端 RPC（DB 端函数）：`wallet_balance` / `wallet_consume` / `wallet_refund` /
`wallet_redeem` / `admin_save_provider_keys`（用 jsonb_set 只更新 providerKeys，**防止保存配置时抹掉密钥**——历史上踩过两次）。

## 5. 测试

测试文件在 `/tmp/`（jsdom 30.1.3，`NODE_PATH=/Users/kuigas/.workbuddy/binaries/node/workspace/node_modules`）：

| 测试 | 覆盖 |
|---|---|
| `style-prompt-test.js` | 风格卡渲染（封面图/占位）、提示词三组合（留空用补充描述/有值追加/全空默认词） |
| `wallet-test.js` | 余额不足拦截、兑换码兑换、积分明细渲染 |
| `retry-test.js` | 524/超时不重试（防重复扣费） |
| `avatar-postgen-test.js` | 生成后按钮复位、错误文案 |
| `cloud-gate-test.js` | 无 SDK 降级、mock SDK 登录态自动恢复（外置脚本异步加载，断言前需等待 ≥600ms） |

（`badge-test.js` 已删除：其测试对象——本机/AI 模式徽标与设置面板——在 UI 换肤时被后台配置取代。）

拆分后页面为外置脚本，测试用 `requestInterceptor` 从磁盘喂 `platform.js`/`app.js`（见各测试文件 `localResources()`）。

## 6. 多 agent 协作约定

多个 agent 会话可能并行开发不同产品，共享同一仓库与工作空间：

- **提交署名**：多个会话共享同一个 `.git/config`，仓库级 `user.name` 会被最后设置的会话覆盖。
  **每次提交都用单次指定**，不要依赖持久配置：
  ```bash
  git -c user.name="platform-dev" -c user.email="platform-dev@users.noreply.github.com" commit -m "..."
  ```
  命名：平台层 `platform-dev`、产品 `<slug>-dev`（如 `pixelart-dev`）。推送认证共用用户 SSH key，作者名区分 agent。
- **改动边界**：产品 agent 只动 `apps/<slug>/`；动 `shared/` 或 `server.js` 前在回复里说明影响面并跑全量测试。
- **冲突处理**：`git pull --rebase` 优先；如果发现提交作者写错（未推送），用
  `git commit --amend --author="<名> <邮箱>" --no-edit` 修正。
- **发布**：多 agent 交替执行 deploy 时，**每次发布前先从 `app_secrets` 同步密钥到本地**（见第 3 节发布与密钥覆盖）。

## 7. 自建服务器部署（独立域名 allmaster.art）

详见 `deploy/README.md`。要点：

- 服务器常驻 Node（systemd）+ Caddy 自动 HTTPS，反代 `127.0.0.1:3000`
- 初始化：`bash deploy/install.sh`；更新：`bash deploy/update.sh`
- 独立域名上线后，把 `apps/avatar/app.js` 的 `CUSTOM_DOMAIN` 填成 `https://allmaster.art`
- `PUBLIC_CONFIG.endpoint`（云服务域名）保持不变；支付回调由 host 自动跟随
- 需要 ICP 备案（境内服务器），DNS A 记录指向服务器 IP

## 8. 新增产品的 6 步清单

假设要新增产品 `poster`（AI 海报）：

1. **建产品目录**：`mkdir apps/poster`，写 `index.html`（可拷 `apps/avatar/index.html` 骨架改 body）、
   `app.js`（产品逻辑，IIFE 内引入 `var Platform = window.Platform`）、`poster.css`。
   - index.html 的 3 个 script 顺序固定：云 SDK CDN → `/shared/platform.js` → `/apps/poster/app.js`
2. **接入平台层**：app.js 尾部按第 2 节模板调 `Platform.setup`，
   **`callbackPath` 必须传 `/apps/poster/`**，实现自己的 `onLoginSuccess` / `onSignOut`。
3. **后台登记产品**：在 `admin.html` 的风格/套餐配置中区分产品（如 styles 加 `product: 'poster'` 字段，
   产品端加载时按 `product` 过滤；当前单产品未启用该字段，第二个产品上线时必须加）。
4. **路由**：server.js 静态目录路由天然支持 `/apps/poster/`，无需改代码；
   如需「根路径切流到新产品」或按域名分流，再改 server.js 的 302 逻辑。
5. **测试**：拷贝 `/tmp/` 中任意测试改 HTML/JS 路径与 mock 数据，先 `node --check` 两个 JS，
   再跑测试到全绿；本地 `PORT=3399 node server.js` 用 curl 验证端点。
6. **发布与记忆**：用 sites 发布（同一目录，链接不变）；在 `.workbuddy/memory/` 新建
   `products/poster.md` 产品分册（现状/配置/坑/待办），更新 `MEMORY.md` 产品索引表。

**红线**：
- 不改 `shared/` 与 `server.js` 的公共行为（确需改，先跑全部 5 套测试）；
- 密钥只进 `app_secrets`，经 RPC 读写，任何「保存配置」代码不得整表覆盖；
- 新会话先读 `.workbuddy/memory/MEMORY.md`，再读本文件，再读对应 `products/<slug>.md`。
