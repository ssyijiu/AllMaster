#!/usr/bin/env bash
# 全员大师 — 服务器初始化脚本（Ubuntu 22.04 / 24.04、Debian 12 适用）
# 用法：sudo bash deploy/install.sh
# 前置：域名 allmaster.art 已解析到本机公网 IP；备案已通过（否则 80/443 会被云厂商拦截）
set -euo pipefail

DOMAIN="allmaster.art"
APP_DIR="/opt/allmaster"
APP_USER="allmaster"

echo "==> 0/7 小内存机型补 swap（2G 以内且无 swap 时创建 2G，防 OOM）"
MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
if [ "$MEM_MB" -lt 3000 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  已创建 2G swap（内存 ${MEM_MB}MB）"
else
  echo "  跳过（内存 ${MEM_MB}MB，swap $(swapon --show | tail -n +2 | wc -l) 个）"
fi

echo "==> 1/7 安装 Node.js 22 与 Caddy"
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

echo "==> 2/7 创建运行用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" /var/log/caddy
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> 3/7 部署代码（首次请先把仓库 clone/rsync 到 $APP_DIR）"
if [ ! -f "$APP_DIR/server.js" ]; then
  echo "!! $APP_DIR/server.js 不存在，请先执行："
  echo "   git clone git@github.com:ssyijiu/AllMaster.git $APP_DIR && chown -R $APP_USER:$APP_USER $APP_DIR"
  exit 1
fi
chmod 600 "$APP_DIR/.ai-config.json" 2>/dev/null || true
chmod 600 "$APP_DIR/.pay-config.json" 2>/dev/null || true
chown "$APP_USER:$APP_USER" "$APP_DIR"/.ai-config.json "$APP_DIR"/.pay-config.json 2>/dev/null || true

echo "==> 4/7 安装 systemd 服务"
cp "$APP_DIR/deploy/allmaster.service" /etc/systemd/system/allmaster.service
systemctl daemon-reload
systemctl enable --now allmaster
sleep 2
systemctl --no-pager --lines=5 status allmaster || true

echo "==> 5/7 本机自检"
curl -s -o /dev/null -w "  本地 :3000 → HTTP %{http_code}\n" http://127.0.0.1:3000/apps/avatar/ || true

echo "==> 6/7 安装 Caddy 配置（需域名已解析，否则证书签发会失败）"
cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy
sleep 3
curl -s -o /dev/null -w "  https://$DOMAIN/apps/avatar/ → HTTP %{http_code}\n" "https://$DOMAIN/apps/avatar/" || true

echo "==> 7/7 本机防火墙检查"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  echo "  ufw 已放行 22/80/443"
else
  echo "  ufw 未启用（阿里云轻量请到控制台「防火墙」放行 22/80/443）"
fi

echo
echo "完成。常用命令："
echo "  systemctl status allmaster     # 服务状态"
echo "  journalctl -u allmaster -f     # 实时日志"
echo "  systemctl reload caddy         # 改 Caddyfile 后重载"
echo "  bash $APP_DIR/deploy/update.sh # 拉最新代码并重启"
