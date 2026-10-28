#!/usr/bin/env python3
"""从图纸渲染件中裁出人物区，生成 vp(1) vs ours(2) 并排对照长图。"""
import os
import glob
import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
ROOT = "/Users/kuigas/WorkBuddy/2026-10-23-22-39-05/apps/pixelart/assert/生图对比"
OUT = "/tmp/duibi"


def crop_char(path, out_h=460):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    # 网格大致占中间区域：x 6%~94%，y 6%~88%（避开表头与底部色卡）
    im2 = im.crop((int(w * 0.06), int(h * 0.06), int(w * 0.94), int(h * 0.88)))
    a = np.asarray(im2)
    # 人物 = 彩色或深色像素（排除白/灰网格与浅粉背景）
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    colored = ((mx - mn) > 40) | (mx < 140)
    ys, xs = np.where(colored)
    if len(xs) < 100:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    pad = 8
    im3 = im2.crop((max(0, x0 - pad), max(0, y0 - pad), min(im2.width, x1 + pad), min(im2.height, y1 + pad)))
    s = out_h / im3.height
    return im3.resize((max(1, round(im3.width * s)), out_h), Image.LANCZOS)


def pick(folder):
    d = {"1": None, "2": None}
    for f in glob.glob(os.path.join(folder, "*")):
        if not os.path.isfile(f):
            continue
        base = os.path.splitext(os.path.basename(f))[0]
        if base in ("1", "2"):
            d[base] = f
    return d


os.makedirs(OUT, exist_ok=True)
out_h = 460
groups = [i for i in range(1, 31) if os.path.isdir(os.path.join(ROOT, str(i)))]
per_sheet = 5
for si in range(0, len(groups), per_sheet):
    chunk = groups[si:si + per_sheet]
    tiles = []
    for i in chunk:
        d = pick(os.path.join(ROOT, str(i)))
        c1 = crop_char(d["1"]) if d["1"] else None
        c2 = crop_char(d["2"]) if d["2"] else None
        label_h = 28
        tile_w = sum((c.width if c else 100) for c in (c1, c2)) + 60
        tile = Image.new("RGB", (tile_w, out_h + label_h), "white")
        dr = ImageDraw.Draw(tile)
        x = 0
        for tag, c in (("vp", c1), ("ours", c2)):
            if c:
                tile.paste(c, (x, label_h))
            dr.text((x + 4, 6), f"G{i} {tag}", fill=("blue" if tag == "vp" else "red"))
            x += (c.width if c else 100) + 30
        tiles.append(tile)
    W = max(t.width for t in tiles)
    H = sum(t.height for t in tiles) + 4 * len(tiles)
    sheet = Image.new("RGB", (W, H), "#ddd")
    y = 0
    for t in tiles:
        sheet.paste(t, (0, y))
        y += t.height + 4
    p = f"{OUT}/sheet_{chunk[0]:02d}_{chunk[-1]:02d}.png"
    sheet.save(p)
    print(p, sheet.size)
