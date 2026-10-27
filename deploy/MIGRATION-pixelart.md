# 拼豆大师 → 自有服务器 迁移指南

> 读者：负责 `apps/pixelart/` 的 Agent（`pixelart-dev`）。
> 平台层（`server.js` / `shared/` / 部署 / 服务器账号）由 `platform-dev` 负责，本文是两者之间的交接契约。
> 最后更新：2026-10-27

## 0. 一句话结论

**拼豆的迁移改动极小**——平台层已经把「同源反代 + endpoint 同源」做完了，拼豆只要改 **1 处 CDN 引用**，剩下的工作是在服务器上补齐 **Python 运行环境**和**配置文件**。

---

## 1. 服务器事实（照抄，不要自行改动）

| 项 | 值 |
|---|---|
| 公网 IP | `123.207.22.47`（阿里云轻量 4C4G / Ubuntu 22.04 / 40G） |
| 应用目录 | `/opt/allmaster`（属主 `allmaster`，systemd 服务用户同） |
| 服务 | `allmaster.service`（systemd，`PORT=8080`，崩溃自动重启） |
| Node | `/usr/local/bin/node` v22.22.2（二进制装在 `/opt/node`） |
| 部署方式 | **tar 打包上传**（服务器访问 GitHub 不稳，**不要在服务器上 git clone**） |
| 访问地址 | `http://123.207.22.47:8080/apps/pixelart/`（备案前无域名、无 HTTPS） |
| 反向代理 | `/.cloud/*` → WorkBuddy 云（由 server.js 提供，**已就绪**） |

---

## 2. 必须改的（只有 1 处）

**`apps/pixelart/index.html` 第 227 行**，云 SDK 从 CDN 改成本地：

```html
<!-- 改前 -->
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>

<!-- 改后 -->
<script src="/shared/workbuddy-cloud.global.js"></script>
```

原因两条：
1. **国内 jsDelivr 不稳**，加载失败会整站登录/积分全挂；
2. `@dev` 是漂移版本，上游发版可能突然改行为；本地副本（70KB，已在仓库 `shared/`）版本可控。

---

## 3. 不用改的（平台层已处理，改了反而出错）

| 项目 | 现状 | 说明 |
|---|---|---|
| `PUBLIC_CONFIG.endpoint` | `platform.js` 里已是 `location.origin` | 自动同源 → 走反代 → **不要**再写死 `app.workbuddy.host` |
| 云调用（登录/钱包/历史） | 由 `Platform.setup()` 统一处理 | 拼豆只消费 `auth.*` / `wallet`，不用关心 endpoint |
| 业务 API | 已经是相对路径 `/api/pixelart/*` | 保持相对路径，**不要**拼绝对地址 |
| 静态资源 | `/shared/base.css`、`/apps/pixelart/*` | 已经是同源路径 |

**绝对不要在页面里写死 `https://ai-avatar-studio-50356.app.workbuddy.host`**：浏览器会直连云端并携带 `Origin: http://123.207.22.47:8080`，云端按白名单拒绝（`the request origin is not allowed for this client`）。这个坑头像产品已经踩过一轮，见第 6 节。

---

## 4. 服务器上需要补的（重点，拼豆自己的活）

`apps/pixelart/generate.js` 依赖 **Python 专家包**，而服务器目前**没有安装 Python 依赖**（只有系统自带 python3，无第三方库）：

```js
spawn(pythonExe(), ['val_perler.py', 'generate'].concat(args), { cwd: PERLER_SCRIPTS, ... })
```

请自查并给出安装清单：

1. **Python 版本与依赖**：读 `apps/pixelart/assert/**/scripts/val_perler.py` 及其 `val_perler/` 包里的 `import`，列出需要 `pip` 安装的包（Pillow、requests 等），并确认是否需要 `venv`（建议用 venv 隔离，路径 `/opt/allmaster/.venv`）。
2. **`.pixelart-config.json`**：字段 `accUserId`（生图服务 WB ID）、`pythonExe`（venv 里的 python 绝对路径）、`promptLLM`（视觉模型，缺 Key 时模板兜底）。该文件**不入库**（含凭据），需在服务器 `/opt/allmaster/` 下单独创建，`chmod 600`。
3. **任务工作目录**：`generate.js` 会往 workDir 写图片和 `prompt.json`，确认落在 `/opt/allmaster/` 下的可写目录（属主 `allmaster`），**不要**写到 `/tmp`（systemd 开了 `PrivateTmp=true`，进程看到的 /tmp 是私有的，排查时会找不到文件）。
4. **`assert/` 目录**：其中的源码/资产**不会**通过 HTTP 下发（`server.js` 对含 `assert` 的路径返回 403），但进程可以正常读文件。页面不要引用 `assert/` 下的资源。

补依赖时请把命令写清楚交给 `platform-dev` 执行，或自己在服务器上跑（服务器账号：见第 7 节）。

---

## 5. 部署纪律（重要，避免两个 Agent 互相踩）

**不要自己执行部署。** 原因：`deploy/push.sh` 是 **tar 全量覆盖** `/opt/allmaster`，两个 Agent 同时跑会互相覆盖对方的改动。

流程：

```
改代码 → 本地跑测试 → git commit（署名 pixelart-dev）→ 通知 platform-dev「请发布」
platform-dev 执行：bash deploy/push.sh
```

`deploy/push.sh` 做的事：打包（排除 `.git`/`.workbuddy`/`node_modules`）→ scp → 服务器解压 → 修属主与密钥权限 → `node --check` → 重启 → 自检 `/`、`/apps/avatar/`、`/shared/platform.js`、云反代。

提交时**必须**用单次身份（多个会话共享同一个 `.git/config`，持久配置会被覆盖）：

```bash
git -c user.name="pixelart-dev" -c user.email="pixelart-dev@users.noreply.github.com" commit -m "..."
```

---

## 6. 已知坑（头像产品已经踩过，别再踩）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| **云端跨域预检被拒** | 云 API 对 `OPTIONS` 返回 403 → 登录/积分全挂 | 一律走同源 `/.cloud/*`，由 server.js 反代；**不要**跨域直连 |
| **Origin 白名单** | `the request origin is not allowed for this client` | 反代已把 `Origin`/`Referer` 改写为云站源；前提是**页面必须同源访问**（endpoint 用 `location.origin`） |
| **CDN SDK 不稳** | 偶发「云服务不可用」、登录按钮无反应 | 用本地 `/shared/workbuddy-cloud.global.js` |
| **密钥权限** | 服务启动报 EACCES / Key 读不到 | `.ai-config.json` 必须 `chmod 600` 且属主 `allmaster`（push.sh 已处理） |
| **端口** | 外网打不开 | 服务器监听 8080，阿里云控制台防火墙已放行 TCP 8080；要开新端口需在控制台加规则 |
| **80/443** | 现在没有服务 | 域名备案后由 Caddy 接管，**现在不要**去占这两个端口 |
| **微信扫码登录** | 大概率失败 | OAuth 回跳地址需云端登记，备案后再处理；手机验证码登录不受影响 |
| **共享工作区** | 两个 Agent 改同一文件冲突 | 只动 `apps/pixelart/**`；`server.js`/`shared/` 属平台层，改前先说明影响面并跑全量测试 |

---

## 7. 服务器访问（需要时向 platform-dev 申请）

- SSH：`ssh -i ~/.ssh/allmaster_deploy ubuntu@123.207.22.47`（免密 sudo）
- 日志：`sudo journalctl -u allmaster -f`（拼豆任务失败先看这里，Python 报错会打在 stdout/stderr）
- 服务：`sudo systemctl status allmaster` / `restart`
- **不要**直接改 `/opt/allmaster` 里的文件——下次 push 会被覆盖，改动必须落回仓库

---

## 8. 验收清单（迁移完成的定义）

- [ ] `http://123.207.22.47:8080/apps/pixelart/` 返回 200，页面样式正常
- [ ] 控制台无 4xx：特别是**没有** `origin is not allowed` / `Failed to fetch`
- [ ] 手机验证码登录成功，右上角显示头像昵称
- [ ] 上传一张图 → 生成 → 拿到图纸（`/api/pixelart/task/html?id=`），`journalctl` 无 Python Traceback
- [ ] 积分扣减正确，明细有记录
- [ ] 后台 `http://123.207.22.47:8080/admin.html` 里，拼豆的风格/套餐能正常显示与保存
- [ ] 头像产品未被影响：`/apps/avatar/` 仍 200、生成正常

---

## 9. 出问题时的回滚

- 线上仍是 WorkBuddy 托管版：`https://ai-avatar-studio-50356.app.workbuddy.host/apps/pixelart/`（旧版随时可对照）
- 服务挂死：`sudo systemctl restart allmaster`
- 代码回滚：`git revert <commit>` + 让 platform-dev 重新 `push.sh`
