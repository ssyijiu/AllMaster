#!/usr/bin/env bash
# 全员大师 — 服务器初始化脚本（Ubuntu 22.04 / 24.04、Debian 12 适用）
# 用法：
#   sudo bash deploy/install.sh                        # 默认 dotbeads.com（广州生产机）
#   sudo DOMAIN=demo.example.com bash deploy/install.sh  # 雅加达等第二台机器，传自己的域名
# 前置：域名已解析到本机公网 IP。中国大陆机房还需备案通过（否则 80/443 被云厂商拦截）；境外机房无此限制。
set -euo pipefail

DOMAIN="${DOMAIN:-dotbeads.com}"
APP_DIR="${APP_DIR:-/opt/allmaster}"
APP_USER="${APP_USER:-allmaster}"
APP_PORT="${APP_PORT:-8080}"

echo "==> 0/8 小内存机型补 swap（2G 以内且无 swap 时创建 2G，防 OOM）"
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

echo "==> 1/8 安装 Node.js 22 与 Caddy"
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

echo "==> 2/8 创建运行用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" /var/log/caddy
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> 3/8 部署代码（首次请先把仓库 clone/rsync 到 $APP_DIR）"
HAVE_CODE=1
if [ ! -f "$APP_DIR/server.js" ]; then
  HAVE_CODE=0
  echo "  !! $APP_DIR/server.js 不存在：先装好运行环境，代码稍后用 deploy/push.sh 首次下发"
  echo "     本机也可以：git clone git@github.com:ssyijiu/AllMaster.git $APP_DIR && chown -R $APP_USER:$APP_USER $APP_DIR"
fi
chmod 600 "$APP_DIR/.ai-config.json" 2>/dev/null || true
chmod 600 "$APP_DIR/.pay-config.json" 2>/dev/null || true
chown "$APP_USER:$APP_USER" "$APP_DIR"/.ai-config.json "$APP_DIR"/.pay-config.json 2>/dev/null || true

echo "==> 4/8 安装 systemd 服务"
if [ -f "$APP_DIR/deploy/allmaster.service" ]; then
  # unit 模板里写死 /opt/allmaster + /usr/local/bin/node；按本机实际情况改写
  # （广州机 node 由 nvm 装在 /usr/local/bin，apt 装的在 /usr/bin，必须探测）
  NODE_BIN="$(command -v node || echo /usr/bin/node)"
  sed -e "s#/opt/allmaster#$APP_DIR#g" \
      -e "s#^ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/server.js#" \
      "$APP_DIR/deploy/allmaster.service" > /etc/systemd/system/allmaster.service
  echo "  ExecStart=$NODE_BIN $APP_DIR/server.js"
  systemctl daemon-reload
  if [ "$HAVE_CODE" = "1" ]; then
    systemctl enable --now allmaster
    sleep 2
    systemctl --no-pager --lines=5 status allmaster || true
  else
    systemctl enable allmaster
    echo "  已设为开机自启，等代码下发后再 start"
  fi
else
  echo "  !! 未找到 deploy/allmaster.service：先下发代码再回来跑本脚本"
fi

echo "==> 5/8 本机自检"
curl -s -o /dev/null -w "  本地 :$APP_PORT → HTTP %{http_code}\n" "http://127.0.0.1:$APP_PORT/apps/avatar/" || true

echo "==> 6/8 安装 Caddy 配置（需域名 $DOMAIN 已解析到本机，否则证书签发会失败）"
if [ -f "$APP_DIR/deploy/Caddyfile" ]; then
  sed "s/dotbeads\.com/$DOMAIN/g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
  sleep 3
  curl -s -o /dev/null -w "  https://$DOMAIN/apps/avatar/ → HTTP %{http_code}\n" "https://$DOMAIN/apps/avatar/" || true
else
  echo "  !! 未找到 deploy/Caddyfile：先下发代码再回来跑本脚本"
fi

echo "==> 7/8 拼豆算法链 Python 环境（venv，依赖见 deploy/pixelart-requirements.txt）"
if [ -f "$APP_DIR/deploy/pixelart-requirements.txt" ]; then
  if ! dpkg -s python3-venv >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y python3-venv python3-pip
  fi
  if [ ! -x "$APP_DIR/.venv/bin/python" ]; then
    sudo -u "$APP_USER" python3 -m venv "$APP_DIR/.venv"
  fi
  # PIP_INDEX_URL 可覆盖：国内机器建议清华源，境外机器留空走官方源
  sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -q --upgrade pip
  sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -q ${PIP_INDEX_URL:+-i "$PIP_INDEX_URL"} \
    -r "$APP_DIR/deploy/pixelart-requirements.txt"
  sudo -u "$APP_USER" "$APP_DIR/.venv/bin/python" -c "import numpy, scipy, PIL, cv2, skimage, sklearn, requests; print('  依赖导入 OK')"
else
  echo "  跳过（未找到依赖清单，通常说明代码还没下发）"
fi

echo "==> 8/8 本机防火墙检查"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  echo "  ufw 已放行 22/80/443"
else
  echo "  ufw 未启用（云控制台的「防火墙/安全组」请放行 22/80/443）"
fi

echo
echo "完成。常用命令："
echo "  systemctl status allmaster     # 服务状态"
echo "  journalctl -u allmaster -f     # 实时日志"
echo "  systemctl reload caddy         # 改 Caddyfile 后重载"
echo "  bash $APP_DIR/deploy/update.sh # 拉最新代码并重启"
