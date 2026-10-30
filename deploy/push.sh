#!/usr/bin/env bash
# 全员大师 — 一键发布到自有服务器（在本地 Mac 执行：bash deploy/push.sh）
# 做了什么：打包 → 上传 → 服务器解压覆盖 → 修正属主与密钥权限 → 重启 → 自检
set -euo pipefail

HOST="${HOST:-ubuntu@123.207.22.47}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/allmaster_deploy}"
REMOTE_DIR="${REMOTE_DIR:-/opt/allmaster}"
APP_PORT="${APP_PORT:-8080}"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# —— 发布前置校验：本脚本打包的是「工作树」而不是 git HEAD，未提交的改动会被静默带上生产 ——
# 2026-10-30 事故：block_cleanup.py 的 grid_snap()（3px 方格吸附）未提交，却被 03:35 的发布
# 一起带到两台机器，两小时后才在 review 时发现，期间生产一直在跑未 review 的算法改动。
DIRTY="$(git status --porcelain --untracked-files=normal 2>/dev/null | grep -v '\.DS_Store$' || true)"
if [ -n "$DIRTY" ]; then
  echo "==> 0/4 工作区检查：发现未提交改动，以下内容会随 tar 一起上线"
  echo "$DIRTY" | sed 's/^/      /'
  if [ "${ALLOW_DIRTY:-0}" != "1" ]; then
    echo "    已中止。若确认要连这些未提交改动一起发布（含他人进行中的代码），执行："
    echo "      ALLOW_DIRTY=1 bash deploy/push.sh"
    exit 1
  fi
  echo "    ALLOW_DIRTY=1 → 按原样发布"
fi

echo "==> 1/4 打包 $ROOT"
tar czf /tmp/allmaster.tgz \
  --exclude='.git' --exclude='.workbuddy' --exclude='node_modules' \
  --exclude='.DS_Store' --exclude='*.genie' --exclude='.pay-state.json' \
  --exclude='.pixelart-config.json' --exclude='.pixelart-tasks' --exclude='.pixelart-tasks-vp' \
  --exclude='.pixelart-samples' --exclude='.pixelart-cleanup-trace.jsonl' --exclude='.venv' \
  --exclude='apps/pixelart/assert/生图对比' \
  -C "$ROOT" .
ls -lh /tmp/allmaster.tgz | awk '{print "    包大小:", $5}'

echo "==> 2/4 上传到 $HOST"
scp -q -i "$SSH_KEY" -o StrictHostKeyChecking=no /tmp/allmaster.tgz "$HOST:/tmp/"

echo "==> 3/4 服务器：解压 + 修权限 + 重启"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$HOST" "
  set -e
  sudo tar xzf /tmp/allmaster.tgz -C $REMOTE_DIR
  sudo chown -R allmaster:allmaster $REMOTE_DIR
  sudo chmod 600 $REMOTE_DIR/.ai-config.json $REMOTE_DIR/.pay-config.json 2>/dev/null || true
  node --check $REMOTE_DIR/server.js
  sudo systemctl restart allmaster
  sleep 2
  systemctl is-active allmaster
"

echo "==> 4/4 自检"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$HOST" "
  for p in / /apps/avatar/ /shared/platform.js /shared/workbuddy-cloud.global.js; do
    printf '    %s %s\n' \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$APP_PORT\$p)\" \"\$p\"
  done
  printf '    云服务反代 → '
  curl -s -o /dev/null -w '%{http_code}\n' -H 'x-wb-webapp-access-key: wbpk_eoMql05K7PT2JgZUKFFOo9_9vLkFanCYcm67RRrIgxoEnsGnDS52YEM' http://127.0.0.1:$APP_PORT/.cloud/database/rest/app_products?select=id\&limit=1
"
echo "发布完成 → $HOST:$APP_PORT"
echo "  目标机器：$HOST  目录：$REMOTE_DIR  端口：$APP_PORT"
