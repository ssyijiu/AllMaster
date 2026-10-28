#!/usr/bin/env python3
"""边缘剖面：量化「主体外圈是否有一圈不属于主体的颜色」（光晕/飞点）。

对每个像素求到背景的距离 d_bg，然后把 d_bg<=W 的像素与「更深处」的参照色比较：
  - delta_mean：与最近深处像素（d_bg>=REF_DEEP）的颜色差（三通道绝对值和）
  - missing：该像素的颜色在深处参照集里几乎不出现的比例（颜色是"外圈独有"）
不知道 declining 到多少算正常，所以按距离分档打印剖面 —— 哪几档明显偏高，
就是光晕带的厚度；跨ῶ多张图对比即可看出 v6 漏掉了多厚的环。

用法：python3 边缘剖面.py raw.png clean_v6.png clean_v7.png [vp_raw.png ...]
"""
import sys
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

REF_DEEP = 20          # 参照像素的最浅深度
BANDS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]
DEV_STRONG = 90        # 三通道绝对值和超过此值算明显偏色


def analyze(path: str):
    a = np.asarray(Image.open(path).convert("RGBA"))
    h, w = a.shape[:2]
    opaque = a[..., 3] > 128
    if not opaque.any() or opaque.all():
        print(f"{path}:无可比鉁的不透明区（opaque={opaque.mean():.3f}），跳过")
        return
    rgb = np.asarray(a[..., :3]).astype(np.int16)
    d_bg = distance_transform_edt(opaque)
    deep = d_bg >= REF_DEEP
    if deep.sum() < 50:
        print(f"{path}:深处参照像素不足（{int(deep.sum())}），跳过")
        return
    _, (iy, ix) = distance_transform_edt(~deep, return_indices=True)
    ref = rgb[iy, ix]                       # 每个像素最近的深处参照色
    dev = np.abs(rgb - ref).sum(axis=2)
    # 某颜色是否在深处出现：用量化后的颜色集合判断（量化步长 12，容忍轻微抖动）
    deep_colors = np.unique((rgb[deep] // 12), axis=0)
    key = (rgb // 12).reshape(-1, 3)
    # 用哈希集合判断 membership（比 np.isin 快很多）
    dc = deep_colors.astype(np.int64)
    dset = set((dc[:, 0] * 65536 + dc[:, 1] * 256 + dc[:, 2]).tolist())
    codes = key[:, 0].astype(np.int64) * 65536 + key[:, 1] * 256 + key[:, 2]
    in_deep = np.fromiter((c in dset for c in codes), dtype=bool, count=codes.size).reshape(h, w)

    # 平坦度 & 色数（与像素统计.py 同口径）
    sx = (np.diff(rgb[:, :, 0], axis=1) == 0) & (np.diff(rgb[:, :, 1], axis=1) == 0) \
        & (np.diff(rgb[:, :, 2], axis=1) == 0)
    sy = (np.diff(rgb[:, :, 0], axis=0) == 0) & (np.diff(rgb[:, :, 1], axis=0) == 0) \
        & (np.diff(rgb[:, :, 2], axis=0) == 0)
    mx = opaque[:, :-1] & opaque[:, 1:]
    my = opaque[:-1, :] & opaque[1:, :]
    flat = (sx[mx].mean() + sy[my].mean()) / 2
    colors = len(np.unique(rgb[opaque].reshape(-1, 3), axis=0))

    name = path.split("/")[-1]
    print(f"\n== {name}  平坦度={flat:.3f} 色数={colors} 不透明={opaque.mean():.3f}")
    print("  d_bg 档 | 像素占比 | 与深处参照 Δ均值 | 外圈独有色占比 | Δ>%d" % DEV_STRONG)
    worst = None
    for lo, hi in zip(BANDS[:-1], BANDS[1:]):
        m = opaque & (d_bg >= lo) & (d_bg < hi)
        if m.sum() < 30:
            continue
        d = dev[m]
        miss = (~in_deep[m]).mean()
        frac = m.sum() / opaque.sum()
        strong = (d > DEV_STRONG).mean()
        print(f"   {lo:>2}-{hi:<2} | {frac:>7.3f} | {d.mean():>15.1f} | {miss:>13.3f} | {strong:>6.3f}")
        if miss > 0.6 and d.mean() > DEV_STRONG:
            worst = hi
    print(f"  → 可疑外圈厚度≈{worst or 0}px（连续满足「颜色外圈独有>60% 且 Δ>{DEV_STRONG}」）")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        analyze(p)
