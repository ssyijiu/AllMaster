#!/usr/bin/env python3
"""30 组对比数据体检：原图 / val-perler(1) / 当前链路(2) 量化指标对比。

⚠️ 图纸渲染件（1.png / 2.png）自带表头、网格、色卡，直接全图量化会被版面吃掉信号，
所以先 **裁出网格区** 再量化：
  1. 四角取页面底色 → 非底色掩膜 → 最大连通域（版面正文块）
  2. 行宽/列宽稳定性过滤（≥0.75×最大跨距）→ 网格矩形（自动适配浅色/深色两套皮肤）
指标在「彩色/深色」像素上计算（排除空格子与页面底色）， finally 报告按 Employ...

用法：
  python3 对比报表.py                    # 全部组
  python3 对比报表.py 20 21 26           # 只看这几组
  python3 对比报表.py --dump-crop 20     # 额外把裁好的网格区存到 /tmp/duibi_crop
"""
import glob
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import label as nd_label

Image.MAX_IMAGE_PIXELS = None
ROOT = "/Users/kuigas/WorkBuddy/2026-10-23-22-39-05/apps/pixelart/assert/生图对比"
DETECT_SIDE = 600      # 版面检测用的缩略图边长
MAXSIDE = 1024         # 量化用的最长边


# ---------- 版面检测 ----------

def detect_grid(path):
    """返回 (x0, y0, x1, y1) 网格矩形，坐标为原图像素；检测失败返回 None。"""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    s = DETECT_SIDE / max(w, h)
    if s > 1:
        s = 1
    a = np.asarray(im.resize((round(w * s), round(h * s)), Image.LANCZOS)).astype(np.int16)
    H, W = a.shape[:2]
    corners = np.concatenate([a[:6, :6].reshape(-1, 3), a[:6, -6:].reshape(-1, 3),
                              a[-6:, :6].reshape(-1, 3), a[-6:, -6:].reshape(-1, 3)])
    page = np.median(corners, axis=0)
    nonpage = np.abs(a - page).sum(axis=2) > 28
    if not nonpage.any():
        return None
    lab, n = nd_label(nonpage)
    if n == 0:
        return None
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    main = int(np.argmax(sizes))
    m = lab == main
    rows = m.sum(axis=1)
    cols = m.sum(axis=0)
    if rows.max() < 10 or cols.max() < 10:
        return None
    good_r = rows >= 0.75 * rows.max()
    good_c = cols >= 0.75 * cols.max()
    ys = np.where(good_r)[0]
    xs = np.where(good_c)[0]
    if len(ys) < 20 or len(xs) < 20:
        return None
    y0, y1 = ys[0], ys[-1] + 1
    x0, x1 = xs[0], xs[-1] + 1
    inv = 1.0 / s
    return int(x0 * inv), int(y0 * inv), min(w, int(x1 * inv)), min(h, int(y1 * inv))


def load_grid(path, dump=False):
    im = Image.open(path).convert("RGB")
    box = detect_grid(path)
    if box is None:
        return None, None
    x0, y0, x1, y1 = box
    crop = im.crop((x0, y0, x1, y1))
    if dump:
        os.makedirs("/tmp/duibi_crop", exist_ok=True)
        crop.save(f"/tmp/duibi_crop/{os.path.basename(os.path.dirname(path))}_"
                  f"{os.path.basename(path)}")
    if max(crop.size) > MAXSIDE:
        t = MAXSIDE / max(crop.size)
        crop = crop.resize((max(1, round(crop.width * t)), max(1, round(crop.height * t))),
                           Image.NEAREST)
    return np.asarray(crop).astype(np.int16), box


# ---------- 指标 ----------

def _count_colored_neighbors(colored):
    """每个像素四邻中有色邻居的个数（边缘像素自然少于内部）。"""
    up = np.zeros_like(colored)
    dn = np.zeros_like(colored)
    lf = np.zeros_like(colored)
    rt = np.zeros_like(colored)
    up[1:, :] = colored[:-1, :]
    dn[:-1, :] = colored[1:, :]
    lf[:, 1:] = colored[:, :-1]
    rt[:, :-1] = colored[:, 1:]
    return up.astype(np.int8) + dn + lf + rt


def metrics(path, dump=False):
    a, box = load_grid(path, dump)
    out = {"grid": box}
    if a is None:
        return out
    h, w = a.shape[:2]
    out["gw"] = w
    out["gh"] = h
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    colored = ((mx - mn) > 40) | (mx < 140)      # 有色的豆子 / 深色块
    out["fill"] = float(colored.mean())
    if colored.sum() < 200:
        return out
    px = a[colored].reshape(-1, 3)
    out["colors"] = int(len(np.unique((px // 8), axis=0)))
    # 平坦度：相邻同为「有色」且颜色一致的比例（像素/纹理噪点会让这个值掉下来）
    same = lambda x, y: (x == y).all(axis=2)
    sx = same(a[:, 1:], a[:, :-1])
    sy = same(a[1:, :], a[:-1, :])
    cx = colored[:, 1:] & colored[:, :-1]
    cy = colored[1:, :] & colored[:-1, :]
    out["flat"] = float(((sx[cx].mean() if cx.any() else 0) +
                         (sy[cy].mean() if cy.any() else 0)) / 2)
    # 孤立格率：有色像素里有多少是「四周同色邻居少于 2 个」的椒盐飞点
    d_up = np.zeros_like(colored)
    d_dn = np.zeros_like(colored)
    d_lf = np.zeros_like(colored)
    d_rt = np.zeros_like(colored)
    d_up[1:, :] = ~same(a[1:, :], a[:-1, :]) & colored[:-1, :]
    d_dn[:-1, :] = ~same(a[:-1, :], a[1:, :]) & colored[1:, :]
    d_lf[:, 1:] = ~same(a[:, 1:], a[:, :-1]) & colored[:, :-1]
    d_rt[:, :-1] = ~same(a[:, :-1], a[:, 1:]) & colored[:, 1:]
    nb_diff = d_up.astype(np.int8) + d_dn + d_lf + d_rt
    nb_col = _count_colored_neighbors(colored)
    solo = colored & (nb_col >= 3) & (nb_diff >= 3)
    out["solo"] = float(solo.sum() / max(int(colored.sum()), 1))
    # 边缘：距背景（非有色区）≤2px 的有色像素里，颜色在内部（深入≥6px）不出现的比例
    inside = colored
    d_bg = _edt_bg(inside)
    rim = inside & (d_bg <= 2)
    deep = inside & (d_bg >= 6)
    if rim.any() and deep.any():
        q = lambda arr: arr[..., 0].astype(np.int64) * 65536 + arr[..., 1].astype(np.int64) * 256 + arr[..., 2]
        dset = set(q(a[deep] // 8).tolist())
        codes = q(a // 8)
        miss = np.array([c not in dset for c in codes.ravel()], dtype=bool).reshape(h, w)
        out["rim_only"] = float(miss[rim].mean())
        out["rim_frac"] = float(rim.sum() / max(int(colored.sum()), 1))
    out["sat"] = float(((mx - mn) / np.maximum(mx, 1))[colored].mean())
    out["lum"] = float(mx[colored].mean())
    return out


def _edt_bg(mask):
    from scipy.ndimage import distance_transform_edt
    return distance_transform_edt(mask)


def pick(folder):
    d = {"1": None, "2": None, "orig": None}
    for f in glob.glob(os.path.join(folder, "*")):
        if not os.path.isfile(f):
            continue
        base = os.path.splitext(os.path.basename(f))[0]
        d[base if base in ("1", "2") else "orig"] = f
    return d


KEYS = ["fill", "colors", "flat", "solo", "rim_only", "rim_frac", "sat", "lum"]


def main(argv):
    dump = "--dump-crop" in argv
    argv = [x for x in argv if not x.startswith("--")]
    groups = argv or [str(i) for i in range(1, 31)]
    rows = []
    for g in groups:
        folder = os.path.join(ROOT, g)
        if not os.path.isdir(folder):
            continue
        d = pick(folder)
        rows.append({"group": int(g), **{k: (metrics(p, dump) if p else None) for k, p in d.items()}})
    json.dump(rows, open("/tmp/dataset_metrics.json", "w"), ensure_ascii=False)

    def fmt(v):
        return f"{v:.3f}" if isinstance(v, float) else (str(v) if v is not None else "-")

    for r in rows:
        print(f"组 {r['group']:>2}")
        for label, tag in (("原图", "orig"), ("vp ", "1"), ("ours", "2")):
            m = r[tag]
            if not m:
                continue
            print(f"  {label} " + "  ".join(f"{k}={fmt(m.get(k))}" for k in KEYS))

    print("=" * 110)
    print("汇总均值（fill=有色占比 colors=色数/8级量化 flat=相邻同色 solo=孤立像素 "
          "rim_only=边缘色内部不出现 rim_frac=边缘像素占比 sat=饱和 lum=亮度）")
    for label, tag in (("val-perler", "1"), ("当前链路", "2")):
        vals = {k: [] for k in KEYS}
        n = 0
        for r in rows:
            m = r[tag]
            if not m:
                continue
            n += 1
            for k in KEYS:
                v = m.get(k)
                if isinstance(v, (int, float)):
                    vals[k].append(v)
        if not n:
            continue
        print(f"{label:>11}({n}组) | " +
              " | ".join(f"{k}={np.mean(vals[k]):.3f}" if vals[k] else f"{k}=-" for k in KEYS))


if __name__ == "__main__":
    main(sys.argv[1:])
