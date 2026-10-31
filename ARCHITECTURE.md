# 「全员大师」平台 — 架构文档

> 本文档面向：新会话的 AI 助手、后续维护者。目标：让任何人（或任何 Agent）在不了解历史的情况下，
> 照着「新增产品的 6 步清单」即可基于本平台搭建下一个产品，且不影响已有产品。
>
> **平台名称：「全员大师」**（多产品 AI 工具平台，共用后端/支付/积分体系）。
> **第一个产品：「头像制作大师」**（apps/avatar，已上线）。

---

## 0. 2026-10-31 架构变更：脱离 WorkBuddy 云，改为自建服务

**为什么**：云端资源点耗尽 → 云服务整项目被暂停（`auth/v1/*` 返回 401 `invalid_client`、`rest/v1/*` 返回 404），
登录、余额、明细、生成扣费、支付入账全停。继续把账号与账本寄生在别人的额度上不可接受。

**现在是什么**：所有数据与登录都在自己的服务器上，**不再依赖任何第三方云**。

| 原来 | 现在 | 代码 |
|---|---|---|
| 云端 auth（手机验证码 + 微信/WorkBuddy 登录） | **邮箱验证码登录**（6 位、10 分钟、同邮箱 60s 冷却） | `server/auth.js` + `server/mail.js` |
| 云端 PG（`app_wallet_txns` / `app_orders` / …） | **SQLite**（Node 22 内置 `node:sqlite`，WAL 模式） | `server/db.js` |
| 云端 RPC（wallet_* / order_*） | 本地同名实现，**返回形状完全一致** | `server/wallet.js` + `server/local-cloud.js` |
| 云端 storage + 签名 URL | 本机磁盘 + 本站签名直链 `/files/<key>?e=&s=` | `server/storage.js` |
| 浏览器 云 SDK（`workbuddy-cloud.global.js`） | 同名「假 SDK」`shared/local-cloud.js`（auth/database/storage 形状不变） | — |

**关键设计**：`server/local-cloud.js` 让 `server/orders.js`（生成单状态机）与前端业务代码**一行都不用改**，
只换底层数据源。这是迁移能在一晚完成、且回归全绿的原因。

**数据位置**：`DATA_DIR`（生产 `systemctl cat allmaster | grep DATA_DIR` → `/opt/allmaster-data`），
刻意放在代码目录之外 —— `deploy/push.sh` 是覆盖式解压，业务数据绝不能跟着代码被覆盖。

**运维必读**：
- 备份：`deploy/backup.sh`（crontab 每日，库用 `VACUUM INTO` 一致性快照，保留 14 天）
- 运营命令行：`node server/admin-cli.js help`（发兑换码 / 人工充值 / 巡检 / 查订单 / 查余额）
- 邮件通道：`.mail-config.json`（`smtp` 465 或 `resend` HTTP）；**未配置时验证码只写 `$DATA_DIR/outbox/`，用户收不到**
- 回滚：`LEGACY_CLOUD=1` 可让 `/.cloud/*` 反代重新生效（云服务恢复时用于对账，平时不要开）

### 0.1 过渡架构：雅加达反代 —— 临时设施，备案通过后拆除

**决策（2026-10-31，用户拍板）**：数据库继续放广州，不搬到境外；
`dotbeads.online` 在备案期通过反代连广州的库；**备案通过后下掉反代**。

```
用户浏览器 ──①──> 雅加达 163.7.10.124 (dotbeads.online)   静态页面 / JS / CSS，本机出
                        │
                        └──②──> 广州 123.207.22.47:8080     /api/* + /files/*
                                 SQLite 主库 + 用户文件（全网唯一一份）
```

- **为什么不能两台各跑一套库**：SQLite 是磁盘文件，两台各一份就是两个平行世界 ——
  在 `dotbeads.online` 注册的账号，去 IP 站看不到自己的积分和作品。
- **为什么反代要改写 Host**（`deploy/Caddyfile-jakarta` 的 `header_up Host`）：
  广州是境内机器且域名未备案，腾讯云对「Host 里带域名」的入站一律 302 到
  `dnspod.qcloud.com/static/webblock.html`（**8080 端口同样拦**，与端口无关）。
  改写成 `IP:端口` 才能过；这不是正常做法，是备案前的临时绕过。
- **连带约束**（改 Host 带来的，已处理但不要忘）：
  1. 支付回调不能用 Host 头拼 → 必须用 `PUBLIC_ORIGIN`（广州 systemd drop-in）；
  2. 真实客户端 IP 靠 `X-Forwarded-For`，而 `clientIp()` **只在对端 ∈ `TRUSTED_PROXIES`** 时才信，
     否则公网伪造该头就能绕开发码限流。
- **铁律**：这是过渡设施，**不要在反代这一层加任何功能**（不加路由、不加缓存、不加限流、
  不加鉴权）。所有能力都应在广州的应用里实现，否则拆除时会被一起带走。

**备案通过那天的拆除清单**（一次做完，跑完即删本节）：

1. 广州装 Caddy（`deploy/Caddyfile` 已写好）+ Let's Encrypt 证书，80/443 开站
2. `PUBLIC_ORIGIN` 改成 https 正式域名；`deploy/install.sh` 按 `DOMAIN` 自动写入
3. 虎皮椒后台把回调域名换成正式域名
4. `dotbeads.online` 改为 **301 → 正式域名**（不要留空壳站）；
   注意：**发信不受影响** —— Resend 的发件域名是 `dotbeads.online`，
   只要 DNS 记录（DKIM/SPF）还在，站点 301 后邮件照发；
   若要一并换成 `.com`，需在 Resend 重新验证域名并改 `.mail-config.json` 的 `MAIL_FROM`
5. 删除 `deploy/Caddyfile-jakarta` 与雅加达的 Caddy 站点；雅加达可下线或降级为纯静态镜像
6. 从 `deploy/install.sh` 里去掉「按域名选分流 Caddyfile」的分支
7. 页脚加备案号并链接 `beian.miit.gov.cn`

---

## 1. 项目概览

- **平台**：全员大师（多产品平台仓库，一个后端 + 一套积分/支付 + 一个部署域名）
- **第一个产品**：头像制作大师（AI Avatar Studio，`apps/avatar/`）
- **部署链接**：https://dotbeads.online（雅加达备用）/ `http://123.207.22.47:8080`（广州主生产）
- **形态**：单端口 Node HTTP 服务（server.js），**自建数据层**（SQLite + 本机文件，见第 0 节）
- **核心能力**：AI 头像生成（多 Provider）、积分钱包（本地账本事务）、邮箱验证码登录、支付、运营 CLI

### 目录结构（2026-10-31 自建服务）

```
server.js                    # HTTP 服务：静态路由 + /api/ai 代理 + 支付回调 + 自建 API 分发
server/                      # ★ 自建后端（不进静态下发，serveStatic 对 server/ 返回 403）
  db.js                      #   SQLite 建库/schema/事务/会话密钥
  wallet.js                  #   账本：consume/refund/redeem/payCredit/grant（幂等 + -2 免费下限）
  auth.js                    #   邮箱验证码 + HMAC 会话（sessions 表可吊销）
  mail.js                    #   邮件通道：dev outbox / SMTP 465 / Resend HTTP
  storage.js                 #   本机文件存储 + HMAC 签名直链
  local-cloud.js             #   RPC 兼容层：让 orders.js 零改动切到本地库
  api.js                     #   /api/auth/* /api/db/query /api/rpc/* /api/storage/* /files/*
  orders.js                  #   生成单状态机（不变）
  admin-cli.js               #   运营命令行（兑换码/充值/巡检）
shared/                      # ★ 平台层：所有产品共用，改动需评估对全部产品的影响
  platform.js                #   登录/钱包/支付，window.Platform.setup(ctx)
  local-cloud.js             #   浏览器端「假 SDK」：auth/database/storage 同名 API
  base.css                   #   设计 token + 通用组件样式
apps/avatar/                 # ★ 产品层：头像产品专属
admin.html                   # 平台后台（仍是云端版本，暂不可用，见页首提示）
deploy/                      # install.sh / push.sh / backup.sh / allmaster.service
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
