#!/bin/bash
# 本地 A/B 取材：对 3 张典型受害原图真实生图（PERLER_BLOCK_CLEANUP=0 保留原始输出）
set -u
ROOT=/Users/kuigas/WorkBuddy/2026-10-23-22-39-05
SRC=$ROOT/apps/pixelart/assert/valorant-perler-src/valorant-perler/scripts
DATA=$ROOT/apps/pixelart/assert/生图对比
PY="$HOME/.workbuddy/binaries/python/envs/default/bin/python"
export NO_PROXY='*'

KEY=$("$PY" -c "import json;print(json.load(open('$ROOT/.pixelart-config.json'))['promptLLM']['apiKey'])")
export PERLER_IMAGE_API_KEY="$KEY"
export PERLER_IMAGE_BASE_URL="https://apinebula.ai/v1"
export PERLER_IMAGE_MODEL="gpt-image-2.5"
export PERLER_BLOCK_CLEANUP=0

run_one() {
  local g="$1" SUBJ="$2" DESC="$3"
  local orig wd
  orig=$(ls "$DATA/$g"/* | grep -v '/[12]\.png$' | head -1)
  wd=/tmp/pixelart_ab/g$g
  rm -rf "$wd"; mkdir -p "$wd/原图"
  cp "$orig" "$wd/原图/原图.png"
  "$PY" - "$wd/prompt.json" "$DESC" <<'EOF'
import json, sys
desc = sys.argv[2]
slots = {
    "game_knowledge": "",
    "subject_description": desc,
    "image_analysis": "参考图为用户上传的原图。保留主体轮廓、主色分区与标志细节。舍弃：背景、阴影与无关内容。",
    "composition": "正方形画面，主体居中完整入画，主体高约占画面 85%，四周留少量透明空白。",
}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(slots, ensure_ascii=False, indent=2))
EOF
  echo "=== G$g 启动（subject=$SUBJ, 原图=${orig}）==="
  (cd "$SRC" && "$PY" val_perler.py generate "$wd/原图/原图.png" \
      --work-dir "$wd" --prompt "$wd/prompt.json" \
      --subject "$SUBJ" --task-name "AB取材G$g" > "$wd/chain.log" 2>&1)
  echo "=== G$g 退出码 $? ==="
  tail -3 "$wd/chain.log"
}

run_one 20 prop "参考图是一个游戏道具蛋：蛋形主体、蓝色主体配金色顶饰与粉猫爪纹章，造型圆润。保留轮廓、比例、主色分区与纹章细节。舍弃：背景。"
run_one 26 character "保留参考图男性人物的身份辨识点：黑色短发发型剪影、脸型、灰色外套结构与主色。舍弃：背景、山石湖水等环境内容。"
run_one 28 prop "参考图是一只白色博美犬站在白色圆桌上。保留：犬只的蓬蓬体型剪影、奶油白主色、脸部五官。舍弃：背景商场环境。"
echo "ALL DONE"
