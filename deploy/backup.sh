#!/usr/bin/env bash
# 自建数据备份（账本/用户/订单 + 用户文件）
# ---------------------------------------------------------------
# 为什么要单独备份：自建之后数据只有一份，就在这台机器上。
# 每天 03:20 由 root 的 crontab 调用，保留 14 天。
#   库：用 SQLite 的 VACUUM INTO 做一致性快照（不用停服，不会拷到半截事务）
#   文件：用户上传的头像/图纸元数据，跟着同一天打包；磁盘紧张可关掉 FILES=0
#
# 安装：
#   sudo install -m 750 deploy/backup.sh /opt/allmaster-data/backup.sh
#   (crontab -l 2>/dev/null; echo "20 3 * * * /opt/allmaster-data/backup.sh >> /var/log/allmaster-backup.log 2>&1") | crontab -
set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/allmaster-data}"
DB="$DATA_DIR/dotbeads.db"
BK="$DATA_DIR/backups"
KEEP_DAYS="${KEEP_DAYS:-14}"
FILES="${FILES:-1}"
TS="$(date +%Y%m%d-%H%M)"

mkdir -p "$BK"

if [ -f "$DB" ]; then
  # 用 heredoc 传脚本，避免在 bash 双引号里嵌套 JS 模板字符串
  node - "$DB" "$BK/db-$TS.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const src = process.argv[2];
const out = process.argv[3];
const db = new DatabaseSync(src);
db.exec("VACUUM INTO '" + out + "'");
db.close();
NODE
  echo "[backup] db → $BK/db-$TS.db ($(du -h "$BK/db-$TS.db" | cut -f1))"
else
  echo "[backup] 没有找到 $DB，跳过"
fi

if [ "$FILES" = "1" ] && [ -d "$DATA_DIR/storage" ]; then
  tar czf "$BK/files-$TS.tar.gz" -C "$DATA_DIR" storage
  echo "[backup] files → $BK/files-$TS.tar.gz ($(du -h "$BK/files-$TS.tar.gz" | cut -f1))"
fi

# 只保留最近 N 天（按文件名日期判断，不依赖 mtime —— rsync/tar 恢复会改 mtime）
find "$BK" -type f -name 'db-*.db' -mtime +"$KEEP_DAYS" -delete
find "$BK" -type f -name 'files-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "[backup] 当前备份：$(ls -1 "$BK" | wc -l | tr -d ' ') 个文件，占用 $(du -sh "$BK" | cut -f1)"
