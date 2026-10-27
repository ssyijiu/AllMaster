#!/usr/bin/env bash
# 全员大师 — 服务器初始化脚本（Ubuntu 22.04 / Debian 12 适用）
# 用法：sudo bash deploy/install.sh
# 前置：域名 allmaster.art 已解析到本机公网 IP；备案已通过（否则 80/443 会被云厂商拦截）
set -euo pipefail

DOMAIN="allmaster.art"
APP_DIR="/opt/allmaster"
APP_USER="allmaster"

echo "==> 1/6 安装 Node.js 22 与 Caddy"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
node -v && caddy version

echo "==> 2/6 创建运行用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" /var/log/caddy
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> 3/6 部署代码（首次请先把仓库 clone/rsync 到 $APP_DIR）"
if [ ! -f "$APP_DIR/server.js" ]; then
  echo "!! $APP_DIR/server.js 不存在，请先执行："
  echo "   git clone git@github.com:ssyijiu/AllMaster.git $APP_DIR && chown -R $APP_USER:$APP_USER $APP_DIR"
  exit 1
fi
chmod 600 "$APP_DIR/.ai-config.json" 2>/dev/null || true
chmod 600 "$APP_DIR/.pay-config.json" 2>/dev/null || true
chown "$APP_USER:$APP_USER" "$APP_DIR"/.ai-config.json "$APP_DIR"/.pay-config.json 2>/dev/null || true

echo "==> 4/6 安装 systemd 服务"
cp "$APP_DIR/deploy/allmaster.service" /etc/systemd/system/allmaster.service
systemctl daemon-reload
systemctl enable --now allmaster
sleep 2
systemctl --no-pager --lines=5 status allmaster || true

echo "==> 5/6 本机自检"
curl -s -o /dev/null -w "  本地 :3000 → HTTP %{http_code}\n" http://127.0.0.1:3000/apps/avatar/ || true

echo "==> 6/6 安装 Caddy 配置（需域名已解析，否则证书签发会失败）"
cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy
sleep 3
curl -s -o /dev/null -w "  https://$DOMAIN/apps/avatar/ → HTTP %{http_code}\n" "https://$DOMAIN/apps/avatar/" || true

echo
echo "完成。常用命令："
echo "  systemctl status allmaster     # 服务状态"
echo "  journalctl -u allmaster -f     # 实时日志"
echo "  systemctl reload caddy         # 改 Caddyfile 后重载"
echo "  bash $APP_DIR/deploy/update.sh # 拉最新代码并重启"
