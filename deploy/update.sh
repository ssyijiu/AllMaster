#!/usr/bin/env bash
# 全员大师 — 更新上线脚本（服务器上执行）
# 用法：sudo bash /opt/allmaster/deploy/update.sh
set -euo pipefail
APP_DIR="/opt/allmaster"
APP_USER="allmaster"

cd "$APP_DIR"

echo "==> 1/4 同步代码（git pull）"
sudo -u "$APP_USER" git pull --ff-only

echo "==> 2/4 校验密钥文件权限（600，属主 $APP_USER）"
chown "$APP_USER:$APP_USER" .ai-config.json .pay-config.json 2>/dev/null || true
chmod 600 .ai-config.json .pay-config.json 2>/dev/null || true

echo "==> 3/4 语法检查"
node --check server.js
node --check shared/platform.js
node --check apps/avatar/app.js

echo "==> 4/4 重启服务"
systemctl restart allmaster
sleep 2
systemctl --no-pager --lines=3 status allmaster || true
curl -s -o /dev/null -w "  自检 /apps/avatar/ → HTTP %{http_code}\n" http://127.0.0.1:3000/apps/avatar/
