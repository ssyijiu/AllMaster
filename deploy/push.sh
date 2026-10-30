#!/usr/bin/env bash
# 全员大师 — 一键发布到自有服务器（在本地 Mac 执行：bash deploy/push.sh）
#
# 发布原则：**只发布已提交的代码**。发布包由 `git archive HEAD` 生成，
# 工作区里未提交的改动（含其他 agent 进行中的代码）一律不会上线。
# 服务器上运行的确切版本号写在 $REMOTE_DIR/.deployed-commit，随时可核对。
#
# 2026-10-30 事故：旧版用 tar 打包工作树，把未提交的 grid_snap() 静默带进了生产。
#
# 步骤：列未提交改动 → 取 HEAD 快照打包 → 上传 → 解压覆盖 → 修权限 → 重启 → 自检

set -euo pipefail

HOST="${HOST:-ubuntu@123.207.22.47}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/allmaster_deploy}"
REMOTE_DIR="${REMOTE_DIR:-/opt/allmaster}"
APP_PORT="${APP_PORT:-8080}"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# —— 0/5：未提交的改动本次不会上线（只提示不阻断，避免"以为改了就会上线"的新误解）
UNCOMMITTED="$(git status --porcelain --untracked-files=normal 2>/dev/null | grep -v '\.DS_Store$' || true)"
if [ -n "$UNCOMMITTED" ]; then
  echo "==> 0/5 注意：以下改动未提交，本次不会上线"
  echo "$UNCOMMITTED" | sed 's/^/      /'
fi

COMMIT="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SUBJECT="$(git log -1 --format=%s HEAD | cut -c1-64)"
echo "==> 1/5 从 $BRANCH@$COMMIT 生成发布包（仅已提交内容）"
echo "    $SUBJECT"
git archive --format=tar.gz -o /tmp/allmaster.tgz HEAD
ls -lh /tmp/allmaster.tgz | awk '{print "    包大小:", $5}'

echo "==> 2/5 上传到 $HOST"
scp -q -i "$SSH_KEY" -o StrictHostKeyChecking=no /tmp/allmaster.tgz "$HOST:/tmp/"

echo "==> 3/5 服务器：解压 + 记录版本 + 修权限 + 重启"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  "$HOST" "REMOTE_DIR='$REMOTE_DIR' COMMIT='$COMMIT' SUBJECT='$SUBJECT' bash -s" <<'REMOTE'
set -e
sudo tar xzf /tmp/allmaster.tgz -C "$REMOTE_DIR"
printf '%s  %s  %s\n' "$COMMIT" "$(date '+%Y-%m-%d %H:%M:%S')" "$SUBJECT" | sudo tee "$REMOTE_DIR/.deployed-commit" >/dev/null
sudo chmod 644 "$REMOTE_DIR/.deployed-commit"
sudo chown -R allmaster:allmaster "$REMOTE_DIR"
sudo chmod 600 "$REMOTE_DIR/.ai-config.json" "$REMOTE_DIR/.pay-config.json" 2>/dev/null || true
node --check "$REMOTE_DIR/server.js"
sudo systemctl restart allmaster
sleep 2
systemctl is-active allmaster
REMOTE

echo "==> 4/5 自检"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  "$HOST" "REMOTE_DIR='$REMOTE_DIR' APP_PORT='$APP_PORT' bash -s" <<'REMOTE'
printf '    服务器版本 → '; cat "$REMOTE_DIR/.deployed-commit"
for p in / /apps/avatar/ /shared/platform.js /shared/workbuddy-cloud.global.js; do
  printf '    %s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT$p")" "$p"
done
printf '    云服务反代 → '
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-wb-webapp-access-key: wbpk_eoMql05K7PT2JgZUKFFOo9_9vLkFanCYcm67RRrIgxoEnsGnDS52YEM' "http://127.0.0.1:$APP_PORT/.cloud/database/rest/app_products?select=id&limit=1"
REMOTE

echo "==> 5/5 完成 $COMMIT → $HOST:$APP_PORT"
echo "  解压是覆盖式的：从仓库删掉的文件不会自动从服务器上消失"
