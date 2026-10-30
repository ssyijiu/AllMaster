#!/usr/bin/env python3
"""图纸级对比：把「我方底稿 / 参照端底稿」分别切格成图纸，并拼成目检图。

为什么必须比图纸而不是比底稿：用户最终看到、拿来拼的是**图纸**，不是底稿。
底稿级的碎度差别（flat 0.7 vs 0.36）在切格时会被每格取主色抹平，
所以底稿指标差一倍，图纸观感可能完全同级——判据只能是图纸。

对每组做三件事：
  1. 我方 raw（raw/G<组>/ours_*_raw.png，取最新）跑色块规整 → 底稿
  2. 我方底稿、参照端底稿（生图对比/<组>/A_*.png，没有就跳过）分别跑 alignment_search
  3. 读回 metrics.json 的豆色数，并把图纸拼成一张目检图

用法：
  python3 图纸对比.py 54 55 60         # 指定组
  python3 图纸对比.py 54 55 --boards 58   # 换规格（默认 36）
"""
from __future__ import annotations

import argparse
import glob
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "assert" / "生图对比"
SCRIPTS = ROOT / "assert" / "valorant-perler-src" / "valorant-perler" / "scripts"
PY = str(Path.home() / ".workbuddy/binaries/python/envs/default/bin/python")


def latest_ours(group: str):
    d = DATA / "raw" / f"G{group}"
    if not d.is_dir():
        return None
    c = sorted(d.glob("ours_*_raw.png"), key=lambda p: p.stat().st_mtime)
    return c[-1] if c else None


def ref_of(group: str):
    fs = sorted(f for f in (DATA / group).iterdir()
                if f.is_file() and f.name.startswith("A_"))
    return fs[0] if fs else None


def cut(input_png: Path, out_dir: Path, boards: int, colors: int) -> dict | None:
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run([PY, str(SCRIPTS / "alignment_search.py"),
                    "--input", str(input_png), "--palette", "palette_mard221.csv",
                    "--output", str(out_dir), "--boards", str(boards),
                    "--max-colors", str(colors)],
                   cwd=str(SCRIPTS), capture_output=True, text=True, check=False)
    fs = glob.glob(str(out_dir / f"{boards}_k{colors}" / "metrics.json"))
    return json.loads(Path(fs[0]).read_text(encoding="utf-8")) if fs else None


def drawing(out_dir: Path, boards: int, colors: int):
    fs = glob.glob(str(out_dir / f"{boards}_k{colors}" / "recovered_mard.png"))
    return Path(fs[0]) if fs else None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("groups", nargs="+")
    ap.add_argument("--boards", type=int, default=36)
    ap.add_argument("--max-colors", type=int, default=28)
    ap.add_argument("--out", default="/tmp/图纸对比")
    a = ap.parse_args()

    work = Path(a.out)
    work.mkdir(parents=True, exist_ok=True)
    # 我方底稿先过一遍色块规整（与线上链路一致）
    import importlib.util
    spec = importlib.util.spec_from_file_location("bc", SCRIPTS / "block_cleanup.py")
    bc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bc)

    rows = []
    for g in a.groups:
        src = latest_ours(g)
        if not src:
            print(f"[G{g}] 跳过：没有 raw/G{g}/ours_*_raw.png")
            continue
        mine = work / f"G{g}_ours.png"
        bc.clean_image(src, mine)
        m_mine = cut(mine, work / f"cut_{g}_ours", a.boards, a.max_colors)
        ref = ref_of(g)
        m_ref = cut(ref, work / f"cut_{g}_ref", a.boards, a.max_colors) if ref else None
        rows.append((g, m_mine, m_ref,
                     drawing(work / f"cut_{g}_ours", a.boards, a.max_colors),
                     drawing(work / f"cut_{g}_ref", a.boards, a.max_colors)))
        dm = m_mine.get("distinct_mard") if m_mine else "?"
        dr = m_ref.get("distinct_mard") if m_ref else "（无参照）"
        print(f"[G{g}] 豆色数 我方={dm}  参照端={dr}")

    if not rows:
        print("没有可比的数据")
        return

    # 目检拼版：每行一组，列 = [我方, 参照端]
    H, pad, lab = 260, 10, 20
    tiles = []
    for g, _, _, d_mine, d_ref in rows:
        cols = []
        for name, p in (("我方", d_mine), ("参照端", d_ref)):
            if not p:
                continue
            im = Image.open(p).convert("RGB")
            s = H / im.height
            cols.append((name, im.resize((max(1, round(im.width * s)), H), Image.LANCZOS)))
        if cols:
            tiles.append((g, cols))
    if tiles:
        W = max(sum(t.width for _, t in cs) + pad * (len(cs) + 1) for _, cs in tiles) + 70
        sheet = Image.new("RGB", (W, (H + pad + lab) * len(tiles) + 6), "white")
        d = ImageDraw.Draw(sheet)
        y = 3
        for g, cols in tiles:
            x = 70
            d.text((4, y + H // 2), f"G{g}", fill="black")
            for name, t in cols:
                sheet.paste(t, (x, y + lab))
                d.text((x + 2, y + 3), name, fill="black")
                x += t.width + pad
            y += H + pad + lab
        out = work / "目检.png"
        sheet.save(out)
        print(f"\n目检图 -> {out}  ({sheet.size[0]}x{sheet.size[1]})")


if __name__ == "__main__":
    main()
