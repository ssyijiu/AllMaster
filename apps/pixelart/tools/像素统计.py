#!/usr/bin/env python3
"""拼豆底稿体检：网格规整度 / 色块平坦度 / 颜色数 / 透明底"""
import sys
import numpy as np
from PIL import Image

def stats(path):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.int32)
    h, w = a.shape[:2]
    opaque = a[..., 3] > 128
    rgb = a[..., :3]
    # 1) 不透明区颜色数（量化到 16 级防噪点虚高 & 原始数）
    q = (rgb[opaque] // 16)
    uniq_q = len(np.unique(q, axis=0))
    uniq_raw = len(np.unique(rgb[opaque].reshape(-1, 3), axis=0))
    # 2) 平坦度：不透明像素中，与右/下邻颜色完全一致的比例（硬边平涂 → 高）
    same_x = (np.diff(rgb[:, :, 0], axis=1) == 0) & (np.diff(rgb[:, :, 1], axis=1) == 0) & (np.diff(rgb[:, :, 2], axis=1) == 0)
    same_y = (np.diff(rgb[:, :, 0], axis=0) == 0) & (np.diff(rgb[:, :, 1], axis=0) == 0) & (np.diff(rgb[:, :, 2], axis=0) == 0)
    mask_x = opaque[:, :-1] & opaque[:, 1:]
    mask_y = opaque[:-1, :] & opaque[1:, :]
    flat = (same_x[mask_x].mean() + same_y[mask_y].mean()) / 2
    # 3) 网格周期检测：对「颜色变化行/列」做间隔统计
    change_x = (np.abs(np.diff(rgb.astype(int), axis=1)).sum(axis=(0, 2)) > 0)
    idx = np.where(change_x)[0]
    gaps = np.diff(idx)
    gaps = gaps[(gaps > 4) & (gaps < 100)]
    pitch = int(np.median(gaps)) if len(gaps) > 20 else -1
    pitch_std = float(np.std(gaps)) if len(gaps) > 20 else -1
    print(f"{path.split('/')[-1]}:")
    print(f"  尺寸 {w}x{h}  不透明占比 {opaque.mean():.0%}")
    print(f"  颜色数(原始) {uniq_raw}   颜色数(16级量化) {uniq_q}")
    print(f"  平坦度(相邻同色比例) {flat:.1%}   ← 越高越接近硬边平涂")
    print(f"  网格周期 ~{pitch}px (std {pitch_std:.1f})  → 估算网格 {w//pitch if pitch>0 else '?'}x{h//pitch if pitch>0 else '?'}")

for p in sys.argv[1:]:
    stats(p)
