#!/usr/bin/env python3
"""30 组对比数据体检：原图 / val-perler(1) / 当前链路(2) 量化指标对比。

大图（3840x5390+）先 NEAREST 降采样到最长边 1024 —— 最近邻只抽样不混色，
像素块结构与平坦度语义保持。
"""
import os
import glob
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = "/Users/kuigas/WorkBuddy/2026-10-23-22-39-05/apps/pixelart/assert/生图对比"
MAXSIDE = 1024


def load(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    s = MAXSIDE / max(w, h)
    if s < 1:
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.NEAREST)
    return np.asarray(im)


def metrics(path):
    a = load(path)
    h, w = a.shape[:2]
    alpha = a[..., 3]
    opaque = alpha > 128
    rgb = a[..., :3]
    out = {"w": w, "h": h, "opaque": float(opaque.mean())}
    if opaque.sum() < 100:
        return out
    px = rgb[opaque]
    out["colors"] = int(len(np.unique(px.reshape(-1, 3), axis=0)))
    # 平坦度：不透明相邻像素完全同色比例
    dx = np.any(rgb[:, 1:] != rgb[:, :-1], axis=2)
    dy = np.any(rgb[1:, :] != rgb[:-1, :], axis=2)
    mx = opaque[:, 1:] & opaque[:, :-1]
    my = opaque[1:, :] & opaque[:-1, :]
    out["flat"] = float(((~dx)[mx].mean() + (~dy)[my].mean()) / 2)
    out["alpha_hard"] = float((alpha[opaque] == 255).mean())
    out["alpha_soft"] = float(((alpha > 0) & (alpha < 250)).mean())
    # 网格周期（颜色变化列的间隔中位数）
    change_x = np.any(rgb[:, 1:] != rgb[:, :-1], axis=2).sum(axis=0) > 0
    idx = np.where(change_x)[0]
    gaps = np.diff(idx)
    gaps = gaps[(gaps > 3) & gaps < 120]
    out["pitch"] = int(np.median(gaps)) if len(gaps) > 20 else -1
    # 轮廓内侧边缘平均亮度（像素画通常有深色描边）
    pad = np.pad(opaque, 1, constant_values=False)
    inner_edge = opaque & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
    if inner_edge.sum():
        out["edge_lum"] = float(rgb[inner_edge].mean())
    mx_ = px.max(axis=1).astype(np.float32)
    mn_ = px.min(axis=1).astype(np.float32)
    out["sat"] = float(np.where(mx_ > 0, (mx_ - mn_) / np.maximum(mx_, 1), 0).mean())
    return out


def pick(folder):
    d = {"1": None, "2": None, "orig": None}
    for f in glob.glob(os.path.join(folder, "*")):
        if not os.path.isfile(f):
            continue
        base = os.path.splitext(os.path.basename(f))[0]
        d[base if base in ("1", "2") else "orig"] = f
    return d


if __name__ == "__main__":
    import json
    import sys
    rows = []
    for i in range(1, 31):
        folder = os.path.join(ROOT, str(i))
        if not os.path.isdir(folder):
            continue
        d = pick(folder)
        rows.append({"group": i, **{k: (metrics(p) if p else None) for k, p in d.items()}})
    json.dump(rows, open("/tmp/dataset_metrics.json", "w"), ensure_ascii=False)

    keys = ["opaque", "colors", "flat", "alpha_hard", "alpha_soft", "pitch", "edge_lum", "sat"]

    def fmt(v):
        if isinstance(v, float):
            return f"{v:.3f}"
        return f"{v}" if v is not None else "-"

    for r in rows:
        print(f"组 {r['group']:>2}")
        for label, tag in (("原图", "orig"), ("vp ", "1"), ("ours", "2")):
            m = r[tag]
            if not m:
                continue
            print(f"  {label} " + "  ".join(f"{k}={fmt(m.get(k))}" for k in keys))

    print("=" * 100)
    print("汇总均值")
    for label, tag in (("原图", "orig"), ("val-perler", "1"), ("当前链路", "2")):
        vals = {k: [] for k in keys}
        for r in rows:
            m = r[tag]
            if not m:
                continue
            for k in keys:
                v = m.get(k)
                if isinstance(v, (int, float)) and v >= 0:
                    vals[k].append(v)
        print(f"{label:>11} | " + " | ".join(f"{k}={np.mean(vals[k]):.3f}" if vals[k] else f"{k}=-" for k in keys))
