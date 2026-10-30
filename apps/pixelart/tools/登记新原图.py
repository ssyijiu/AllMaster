#!/usr/bin/env python3
"""把 `assert/算法测试原图/` 下的新原图登记进对比数据集（分配组号 + 就位）。

用户给的新图按「分类目录 / 序号_标签[_备注].png」命名，标签是画风、备注是玩家备注，
但**不含 subject**（人物/道具）——那得看图才能判，所以落在 manifest 里人工维护。

本脚本做的事：
  1. 扫描源目录，解析文件名 → (序号, 画风标签, 备注)
  2. 分配组号（从 54 起，已登记过的沿用原号），写/更新 manifest.json
  3. 把原图复制到 `生图对比/G<组号>/`（现有取材工具认这个结构）
  4. 打印可直接喂给 `批量取材.py` 的 spec 列表

manifest.json 的 subject 字段首次生成时是 "?"，需要人工判读后改成 character/prop；
已存在的条目不会被覆盖，所以改完再跑一次本脚本是安全的。

用法：
  python3 登记新原图.py                 # 扫描 + 就位 + 打印 spec
  python3 登记新原图.py --print-only     # 只看会做什么，不写文件
"""
import json
import re
import shutil
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
SRC = APP / "assert" / "算法测试原图"
DATA = APP / "assert" / "生图对比"
MANIFEST = SRC / "manifest.json"
START_GROUP = 54            # 31~53 已被上一批占用
IMGS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

# 用户文件名里的中文画风标签 → 链路里的画风目录名
STYLE_MAP = {
    "还原": "original",
    "Q版": "chibi", "q版": "chibi",
    "官方同款": "official",
    "贴纸": "mini-sticker",
    "像素大头": "pixel-head", "像素大头小图": "pixel-head",
    "手绘头像": "hand-avatar",
    "柔彩手绘": "soft-color", "粉彩手绘": "soft-color",
    "低饱和彩铅": "low-sat-pencil",
    "手绘小人": "chibi", "简笔小人": "chibi", "手绘表情包": "chibi",
}


def parse_name(stem: str) -> tuple[str, str, str]:
    """`序号_标签[_备注]` → (序号, 画风 id, 备注)。

    用户是从别处拷文件改的名，有时会把手写残留带进来（例如 `05_还原png`、
    `13_还原_完全保留所有元素png`）——末尾那个孤立的 png 要清掉。
    """
    # 用户是从别处拷文件改的名，残留的扩展名可能贴在标签后面（05_还原png），
    # 也可能粘在备注末尾且没有下划线分隔（13_还原_完全保留所有元素png）
    strip = lambda s: re.sub(r"(?:^|_)?(png|jpg|jpeg|webp)$", "", s, flags=re.I).strip("_")
    parts = stem.split("_")
    seq = parts[0].lstrip("0") or "0"
    tag = strip(parts[1]) if len(parts) > 1 else ""
    notes = strip("_".join(parts[2:])) if len(parts) > 2 else ""
    return seq, STYLE_MAP.get(tag, tag), notes


def main(argv=None):
    argv = list(argv or [])
    dry = "--print-only" in argv
    if not SRC.is_dir():
        raise SystemExit(f"源目录不存在：{SRC}")

    man = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    used = {v["group"] for v in man.values()}
    next_g = START_GROUP

    items = []
    for cat in sorted(p for p in SRC.iterdir() if p.is_dir() and not p.name.startswith(".")):
        for f in sorted(cat.iterdir()):
            if not f.is_file() or f.name.startswith(".") or f.suffix.lower() not in IMGS:
                continue
            seq, style, notes = parse_name(f.stem)
            key = f"{seq}_{style}"                     # 同一序号可能有多个画风（09_Q版 / 09_还原）
            if key in man:
                man[key]["file"] = f"{cat.name}/{f.name}"
                man[key]["cat"] = cat.name
                man[key].setdefault("notes", notes)
            else:
                while next_g in used:
                    next_g += 1
                man[key] = {"group": next_g, "seq": seq, "style": style, "subject": "?",
                            "notes": notes, "cat": cat.name, "file": f"{cat.name}/{f.name}"}
                used.add(next_g)
                next_g += 1
            items.append((key, man[key], SRC / cat.name / f.name))

    if not dry:
        MANIFEST.write_text(json.dumps(man, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for key, meta, src in items:
            # 注意是纯数字目录（生图对比/54），不带 G 前缀——那只是 raw 输出目录的写法
            dst_dir = DATA / str(meta["group"])
            dst_dir.mkdir(parents=True, exist_ok=True)
            dst = dst_dir / f"原图{src.suffix.lower()}"
            if not dst.is_file():
                shutil.copy2(src, dst)

    print(f"{'key':<14} {'组':>4} {'subject':<10} {'画风':<10} 备注")
    for key, meta, _ in sorted(items, key=lambda x: x[1]["group"]):
        print(f"{key:<14} {meta['group']:>4} {meta['subject']:<10} {meta['style']:<10} {meta['notes']}")
    need = [k for k, m in man.items() if m["subject"] not in ("character", "prop")]
    gs = [m["group"] for _, m, _ in items]
    print(f"\n共 {len(items)} 张；组号 {min(gs)}-{max(gs)}")
    if need:
        print(f"⚠️  {len(need)} 张还没判 subject：{' '.join(sorted(need))}")
        print("   改 manifest.json 里的 subject 字段（character/prop），再跑一次本脚本")
    else:
        specs = " ".join(
            f"{m['group']}:{m['subject']}:{m['style']}:{m['notes']}"
            for _, m, _ in sorted(items, key=lambda x: x[1]["group"]))
        print("\n取材命令：")
        print(f"  python3 批量取材.py {specs} --no-vp --workers=1")


if __name__ == "__main__":
    main(sys.argv[1:])
