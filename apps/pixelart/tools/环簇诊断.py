#!/usr/bin/env python3
"""环簇诊断：把「贴着主体边缘、颜色只出现在外圈」的色簇挑出来，判它是光晕还是合法描边。

给 block_cleanup 的判据调参用 —— 先看真实输出里到底有哪些"环簇"，以及 v6 为什么放过/吃掉它。

每张图按内部 clean-up 的口径做一次聚类（颜色<2000 时用精确色，否则 KMeans k=24），
然后对每个簇报告：
  area%     簇面积占不透明区比例
  rim%      簇内 d_bg<=8 的像素占比（贴边程度）
  meanD     簇内到背景的平均距离
  deep%     簇内 d_bg>=20 的像素占比（有没有"长到里面去"）
  ΔL/ΔS     与该簇内侧参照色（最近的非本簇像群内部像素）的亮度差与饱和度差
最后给出 v6 现行判据的命中情况（HIT=会被抑制 / miss=保留及其原因）。

用法：python3 环簇诊断.py img1.png [img2.png ...]
"""
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from sklearn.cluster import KMeans

Image_MAX = None
RIM_D = 8          # 「贴边」距离
DEEP_D = 20        # 「深入内部」距离
MIN_AREA = 0.0008  # 小于该面积占比的簇不打印
V6 = dict(mean_d=9.0, near_frac=0.6, near=8, max_frac=0.18, lum_min=6.0, sat_min=0.15)


def clusters_of(a, opaque, k=24):
    rgb = a[..., :3].astype(np.float32)
    h, w = rgb.shape[:2]
    px = rgb[opaque]
    n_uniq = len(np.unique(px.reshape(-1, 3), axis=0))
    if n_uniq <= 2000:                      # 已经规整过：用精确颜色做簇
        codes = (px // 4).astype(np.int64)
        key = codes[:, 0] * 65536 + codes[:, 1] * 256 + codes[:, 2]
        uniq, inv = np.unique(key, return_inverse=True)
        centers = np.zeros((len(uniq), 3), np.float32)
        for c in range(3):
            centers[:, c] = np.bincount(inv, weights=px[:, c], minlength=len(uniq)) / np.bincount(inv, minlength=len(uniq))
        lab = np.full((h, w), 255, np.uint8)
        lab[opaque] = inv.astype(np.uint8)
        return lab, centers, len(uniq)
    km = KMeans(n_clusters=k, n_init=4, random_state=42).fit(px[::max(1, px.shape[0] // 20000)])
    lab = np.full((h, w), 255, np.uint8)
    lab[opaque] = km.predict(px).astype(np.uint8)
    return lab, km.cluster_centers_, k


def diagnose(path):
    a = np.asarray(Image.open(path).convert("RGBA"))
    opaque = a[..., 3] > 128
    if not opaque.any() or opaque.all():
        print(f"\n== {path}:不透明区不可用（{opaque.mean():.3f}）")
        return
    rgb = a[..., :3].astype(np.float32)
    h, w = opaque.shape
    total = float(opaque.sum())
    d_bg = distance_transform_edt(opaque)
    lab, centers, k = clusters_of(a, opaque)
    # 每个像素最近的非本簇、且更靠内的参照像素
    print(f"\n== {path.split('/')[-1]}  不透明={opaque.mean():.3f}  簇数={k}")
    print(" 簇 | 颜色(RGB)        | area% | rim% | meanD | deep% | ΔL    | ΔS    | v6判定")
    rows = []
    for c in range(k):
        m = op = opaque & (lab == c)
        n = int(m.sum())
        if n < 150 or n / total < MIN_AREA:
            continue
        mean_d = float(d_bg[m].mean())
        rim = float((d_bg[m] <= RIM_D).mean())
        deep = float((d_bg[m] >= DEEP_D).mean())
        if rim < 0.5 and deep > 0.2:      # 明显是正文色，跳过
            continue
        # 参照：不透明区里属于别的簇且 d_bg>=12 的最近像素
        ref_src = opaque & (lab != c) & (d_bg >= 12)
        if not ref_src.any():
            continue
        _, (iy, ix) = distance_transform_edt(~ref_src, return_indices=True)
        ref = rgb[iy[m], ix[m]]
        cur = rgb[m]
        dl = float(cur.mean() - ref.mean())
        sat_c = (cur.max(axis=1) - cur.min(axis=1)) / np.maximum(cur.max(axis=1), 1)
        sat_r = (ref.max(axis=1) - ref.min(axis=1)) / np.maximum(ref.max(axis=1), 1)
        ds = float(sat_c.mean() - sat_r.mean())
        glow = ((cur.mean(axis=1) > ref.mean(axis=1) + V6["lum_min"]) |
                (sat_c > sat_r + V6["sat_min"])).mean()
        hits = []
        if mean_d <= V6["mean_d"]:
            hits.append("meanD")
        if float((d_bg[m] <= V6["near"]).mean()) >= V6["near_frac"]:
            hits.append("near%")
        if n / total <= V6["max_frac"]:
            hits.append("area")
        if glow >= 0.6:
            hits.append("glow")
        verdict = "HIT" if len(hits) >= 4 else f"miss({'|'.join(hits) or '无'})"
        color = centers[c].astype(int)
        rows.append((n / total, c, color, rim, mean_d, deep, dl, ds, verdict))
    for frac, c, color, rim, mean_d, deep, dl, ds, verdict in sorted(rows, reverse=True)[:10]:
        print(f" {c:>2} | {str(tuple(color)):<16}| {frac*100:>5.2f} | {rim*100:>4.0f} | "
              f"{mean_d:>5.1f} | {deep*100:>4.0f} | {dl:>+5.1f} | {ds:>+5.2f} | {verdict}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        diagnose(p)
