# 独立域名接入手册（allmaster.art）

> 目标：把「全员大师」平台从 `ai-avatar-studio-50356.app.workbuddy.host` 迁到自有域名 `allmaster.art`，
> 服务器常驻 Node 进程（现有代码零改动），Caddy 自动 HTTPS。

## 一、前置：域名与备案

1. **注册域名** `allmaster.art`（腾讯云 / 阿里云均可，约 ¥30~80/年）
2. **ICP 备案**：必须在**服务器所在云厂商**备案（境内服务器强制，约 5~7 个工作日）
   - 备案主体、域名实名信息需一致
   - 备案未通过前，80/443 端口会被云厂商拦截，网站打不开属正常
3. **DNS 解析**（备案通过后配置）：
   ```
   A     @       <服务器公网 IP>
   A     www     <服务器公网 IP>
   ```
   > 若用 Caddy 自动签证书，解析必须先生效；Caddy 需要 80 端口做 ACME 验证。

## 二、服务器初始化（一次性）

```bash
# 1. 登录服务器（Ubuntu 22.04 / Debian 12）
ssh root@<服务器IP>

# 2. 拉代码（仓库私有，需先在该服务器配好 GitHub SSH key）
git clone git@github.com:ssyijiu/AllMaster.git /opt/allmaster

# 3. 放置密钥文件（从本地 scp 上去，切勿进 git）
scp .ai-config.json .pay-config.json root@<服务器IP>:/opt/allmaster/

# 4. 执行初始化脚本
cd /opt/allmaster && bash deploy/install.sh
```

脚本会：装 Node 22 + Caddy → 建 `allmaster` 用户 → 装 systemd 服务 → 起服务 → 装 Caddy 配置 → 自检。

## 三、日常更新上线

```bash
cd /opt/allmaster && sudo bash deploy/update.sh
```

脚本会：`git pull` → 修密钥文件权限 → `node --check` 三个入口 → 重启服务 → 自检。

## 四、域名切换时需要改的代码点

| 位置 | 现状 | 说明 |
|---|---|---|
| `apps/avatar/app.js` 的 `CUSTOM_DOMAIN` | `''`（空 = 未启用） | 上线后填 `'https://allmaster.art'`，预览环境的「新标签打开」就指向新域名 |
| `shared/platform.js` 的 `PUBLIC_CONFIG.endpoint` | 平台云服务域名 | **不要改**，云数据库/登录/支付都依赖它；已验证 CORS 回显任意 Origin，新域名可正常调用 |
| `admin.html` 的 endpoint | 同上 | **不要改** |
| 支付 `notify_url` / `return_url` | 由 `req.headers.host` 动态推导 | 自动跟随域名，无需改代码；但需在**虎皮椒商户后台**确认回调域名未被白名单限制 |
| OAuth 回跳 | `callbackPath` 相对路径 | 自动跟随域名；首次用新域名登录需实测回调是否成功 |

## 五、上线验证清单

```bash
curl -I https://allmaster.art/                     # 302 → /apps/avatar/
curl -I https://allmaster.art/apps/avatar/         # 200
curl -I https://allmaster.art/shared/platform.js   # 200
curl -I https://allmaster.art/admin.html           # 200
curl -s https://allmaster.art/api/pay/config       # 支付通道可用性
```
浏览器端再验：① 手机号登录 ② 生成一张头像（含 20~90s 等待心跳提示）③ 积分扣减与明细 ④ 后台改配置生效。

## 六、回滚

WorkBuddy 线上版本保持不动即可作为兜底：新域名出问题时改 DNS 或直接让用户访问原链接。
两边共用同一套云端数据库（`app_secrets` / `app_config` / 钱包账本），数据天然一致。

## 七、注意

- **密钥文件永不进 git**（`.gitignore` 已排除）；服务器上权限 `600`、属主 `allmaster`
- 服务器上线后，**WorkBuddy 侧的 deploy 发布不再需要同步密钥**（那份是另一套运行时）；但若继续用 WorkBuddy 版本对外服务，仍需遵守「发布前同步密钥」约定
- Caddy 证书自动续期（到期前 30 天自动续），无需手动维护
