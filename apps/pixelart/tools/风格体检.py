#!/usr/bin/env python3
"""风格体检：逐组量化「生图观感」相关指标，并给出我方与参照端（val-perler）的差距画像。

与 tools/对比报表.py 的分工：
  对比报表.py  量的是**图纸成品件**（1/2.png，带表头/网格/色卡），需先裁网格再量；
  风格体检.py  量的是**转换图**（生图模型直接输出的底稿），不用裁，直接量观感相关项。

指标含义：
  fill      主体（不透明区）占画面比例 —— 取景松紧
  colors    8 级量化后的不同颜色数 —— 色彩的丰富度（不是最终豆色数）
  lvl10k    每万像素的色阶数（colors / 主体面积 × 1e4）—— 剔除面积影响后的「层次密度」
  flat      平坦度：相邻像素同色比例 —— 越高越像硬边平涂（过高=死板）
  dark      暗部（L*<38）占主体比例 —— 画面的重量感
  darkrim   外轮廓（距背景 ≤3px）里暗色像素占比 —— 描边连续性
  rimw      暗轮廓的平均厚度（px）—— 描边粗细
  edgeΔ     主体边界内外 4px 的平均色差 —— 轮廓是否干净（差越大越干净）

用法：
  python3 风格体检.py                 # 扫 assert/生图对比 下所有含 A_/B_ 转换图的组
  python3 风格体检.py 31 52           # 只扫指定组
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

Image.MAX_IMAGE_PIXELS = None
DATA = Path(__file__).resolve().parents[1] / "assert" / "生图对比"


def _lab_l(a: np.ndarray) -> np.ndarray:
    c = a / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    y = c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722
    eps, kap = 216 / 24389, 24389 / 27
    f = np.where(y > eps, np.cbrt(y), (kap * y + 16) / 116)
    return 116 * f - 16


def metrics(path: Path) -> dict | None:
    a = np.asarray(Image.open(path).convert("RGBA"))
    op = a[..., 3] > 128
    if op.sum() < 500:
        return None
    rgb = a[..., :3].astype(np.float32)
    L = _lab_l(rgb)
    d = distance_transform_edt(op)
    area = float(op.sum())

    q = (rgb // 16).astype(np.int64)
    colors = int(len(np.unique(q[op].reshape(-1, 3), axis=0)))

    sx = (np.diff(rgb[..., 0], axis=1) == 0) & (np.diff(rgb[..., 1], axis=1) == 0) \
        & (np.diff(rgb[..., 2], axis=1) == 0)
    sy = (np.diff(rgb[..., 0], axis=0) == 0) & (np.diff(rgb[..., 1], axis=0) == 0) \
        & (np.diff(rgb[..., 2], axis=0) == 0)
    mxm = op[:, :-1] & op[:, 1:]
    mym = op[:-1, :] & op[1:, :]
    flat = float((sx[mxm].mean() + sy[mym].mean()) / 2)

    dark = (L < 38) & op
    rim = (d <= 3) & op
    darkrim = float((dark & rim).sum() / max(int(rim.sum()), 1))
    rimw = float(d[dark & rim].mean()) if (dark & rim).any() else 0.0

    # 轮廓干净度：边界外 4px 与边界内 4px 的平均颜色差
    out = (d == 0) & (~op)
    band_out = (d <= 4) & (~op) & ~out
    band_in = (d > 0) & (d <= 4) & op
    edge_delta = 0.0
    if band_out.sum() > 50 and band_in.sum() > 50:
        edge_delta = float(np.linalg.norm(
            rgb[band_in].mean(axis=0) - rgb[band_out].mean(axis=0)))

    return {"fill": area / (a.shape[0] * a.shape[1]), "colors": colors,
            "lvl10k": colors / area * 1e4, "flat": flat,
            "dark": float(dark.sum() / area), "darkrim": darkrim,
            "rimw": rimw, "edgeΔ": edge_delta}


def find_pair(group: Path) -> tuple[Path | None, Path | None]:
    a = b = None
    for f in sorted(group.iterdir()):
        if not f.is_file() or f.name.startswith("."):
            continue
        if f.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            continue
        if f.name.startswith("A_"):
            a = a or f
        elif f.name.startswith("B_"):
            b = b or f
    return a, b


def tag_of(name: str) -> str:
    """从转换图文件名里取「标签 + 备注」（A_转换图_Q版_备注_xxx.png）。"""
    stem = Path(name).stem
    parts = stem.split("_")
    return parts[2] if len(parts) > 2 else "-"


def main(argv: list[str]) -> None:
    groups = argv if argv else sorted(
        [d.name for d in DATA.iterdir() if d.is_dir() and d.name != "raw"],
        key=lambda x: int(x))
    rows = []
    for g in groups:
        d = DATA / g
        a, b = find_pair(d)
        if not (a and b):
            continue
        ma, mb = metrics(a), metrics(b)
        if not (ma and mb):
            continue
        rows.append((g, tag_of(a.name), ma, mb))

    keys = ["fill", "colors", "lvl10k", "flat", "dark", "darkrim", "rimw", "edgeΔ"]
    print(f"组  标签      " + " ".join(f"{k:>7}" for k in keys) + "   （上=val-perler 下=我方）")
    for g, tag, ma, mb in rows:
        print(f"{g:>3} {tag:<8}" + " ".join(f"{ma[k]:>7.3f}" for k in keys))
        print(f"    {'':<8}" + " ".join(f"{mb[k]:>7.3f}" for k in keys))
    if not rows:
        print("没有找到成对的 A/B 转换图")
        return
    print("\n" + "=" * 96)
    print("汇总均值")
    for label, idx in (("val-perler", 2), ("我方", 3)):
        print(f"  {label:<12}" + " ".join(
            f"{k}={np.mean([r[idx][k] for r in rows]):.3f}" for k in keys))
    print("\n逐组 Δ（我方 − 参照端，>0 是我方更高）")
    for g, tag, ma, mb in rows:
        d = " ".join(f"{k}{mb[k] - ma[k]:+.2f}" for k in ("colors", "lvl10k", "flat", "darkrim"))
        print(f"  G{g:<3}{tag:<8}{d}")


if __name__ == "__main__":
    main(sys.argv[1:])
