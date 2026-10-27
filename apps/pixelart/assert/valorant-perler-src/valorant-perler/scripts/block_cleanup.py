#!/usr/bin/env python3
"""block_cleanup.py — 生图后端的色块规整（拼豆底稿净化）。

背景：生图后端换成通用模型（gpt-image 系）后，输出带有纹理噪点、抗锯齿混色和
边缘光晕，平坦度只有 ~25%（旧专用后端 ~68%），下游切格量化会出现杂色和条纹。
本脚本把底稿「洗」成硬边平涂：平坦度可达 ~95%，颜色数收敛到 20 左右。

处理步骤（v5，经 A/B 链路对照验证）：
  1. 不透明区向内腐蚀 erode px，用纯内部像素 KMeans 拟合 k 色调色板
     （边缘混色不进训练集，避免光晕自成颜色簇）；
  2. 边界带用距离变换（EDT）继承最近内部像素的 label（无投票污染）；
  3. 自适应检测色块颗粒度 pitch，用 pitch 尺寸窗口做**单轮**众数滤波
     抹平残余纹理（窗口跟随颗粒度，不会吃掉细小特征；透明区保持哨兵值
     255，被 f<255 守卫挡在投票外，不会污染边界）；
  4. 按最终 label 贴回调色板中心色，透明区原样保留。

幂等保护：输入平坦度已 ≥ FLAT_SKIP（0.85）时直接跳过（一键重转等场景不重复洗）。

用法：
  python3 block_cleanup.py <in.png>              # 原地清洗
  python3 block_cleanup.py <in.png> <out.png>    # 清洗到新文件

环境变量 PERLER_BLOCK_CLEANUP=0 时调用方跳过（产品链路默认开启）。
"""

from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from sklearn.cluster import KMeans
from skimage.filters.rank import modal
from skimage.morphology import erosion, footprint_rectangle

K_DEFAULT = 24        # 调色板簇数：覆盖主色 + 大对比细节，切格阶段还会再归并
ERODE_DEFAULT = 3     # 边缘腐蚀半径：抗锯齿混色带的典型宽度
SENTINEL = 255        # 未填充/透明的 label 哨兵
FLAT_SKIP = 0.85      # 输入平坦度已达标时跳过（幂等保护）
PITCH_MIN, PITCH_MAX = 5, 32   # 色块颗粒度检测的合理区间（px）


def flatness_of(rgb: np.ndarray, opaque: np.ndarray) -> float:
    """平坦度 = 相邻同色比例，越高越接近硬边平涂。"""
    sx = (np.diff(rgb[..., 0], axis=1) == 0) & (np.diff(rgb[..., 1], axis=1) == 0) \
        & (np.diff(rgb[..., 2], axis=1) == 0)
    sy = (np.diff(rgb[..., 0], axis=0) == 0) & (np.diff(rgb[..., 1], axis=0) == 0) \
        & (np.diff(rgb[..., 2], axis=0) == 0)
    mx = opaque[:, :-1] & opaque[:, 1:]
    my = opaque[:-1, :] & opaque[1:, :]
    return float((sx[mx].mean() + sy[my].mean()) / 2)


def detect_pitch(lab: np.ndarray, opaque: np.ndarray) -> int:
    """色块颗粒度：label 竖向切换列的间隔中位数；检不出回落 13。"""
    diff = np.diff(lab, axis=1)
    change = (diff != 0) & opaque[:, 1:] & opaque[:, :-1]
    idx = np.where(change.sum(axis=0) > 2)[0]   # 该列有 ≥2 处颜色切换才算边界
    gaps = np.diff(idx)
    gaps = gaps[(gaps >= PITCH_MIN) & (gaps <= 60)]
    if len(gaps) < 30:
        return 13
    return int(np.clip(np.median(gaps), PITCH_MIN, PITCH_MAX))


def clean_image(src: Path, dst: Path, k: int = K_DEFAULT, erode: int = ERODE_DEFAULT) -> dict:
    """清洗一张底稿，返回统计信息（供运行记录）。"""
    a = np.asarray(Image.open(src).convert("RGBA"))
    h, w = a.shape[:2]
    opaque = a[..., 3] > 128
    info: dict = {"size": [w, h], "opaque_ratio": round(float(opaque.mean()), 3)}
    if not opaque.any():                       # 全透明：无话可洗
        Image.fromarray(a).save(dst)
        info["skipped"] = "全透明"
        return info

    rgb0 = a[..., :3].astype(np.int32)
    info["flatness_before"] = round(flatness_of(rgb0, opaque), 3)
    if info["flatness_before"] >= FLAT_SKIP:   # 已经够干净：不洗（幂等）
        if src != dst:
            Image.fromarray(a).save(dst)
        info["skipped"] = "已达标"
        return info

    rgb = a[..., :3].astype(np.float32)
    inner = erosion(opaque, footprint_rectangle((erode * 2 + 1, erode * 2 + 1)))
    if inner.sum() < k:                        # 图太小：不值得聚类，原样保存
        Image.fromarray(a).save(dst)
        info["skipped"] = "不透明区过小"
        return info

    # 1) 内部像素拟合调色板
    km = KMeans(n_clusters=k, n_init=4, random_state=42).fit(
        rgb[inner][::max(1, int(inner.sum()) // 20000)])
    lab = np.full((h, w), SENTINEL, np.uint8)
    lab[inner] = km.predict(rgb[inner])

    # 2) 边界带：EDT 最近邻继承（零点集只含已填充像素，透明区不会串色）
    unfilled = opaque & (lab == SENTINEL)
    if unfilled.any():
        _, (iy, ix) = distance_transform_edt(lab == SENTINEL, return_indices=True)
        lab[unfilled] = lab[iy[unfilled], ix[unfilled]]

    # 3) 自适应窗口单轮众数滤波（窗口跟随颗粒度，细小特征不被吃掉）
    pitch = detect_pitch(lab, opaque)
    win = max(3, pitch if pitch % 2 == 1 else pitch + 1)
    f = modal(lab, footprint_rectangle((win, win)))
    cur = lab.copy()
    o = opaque & (f < SENTINEL)
    cur[o] = f[o]

    # 4) 贴回颜色
    out = a.copy()
    out[..., :3][opaque] = km.cluster_centers_[cur[opaque]].astype(np.uint8)
    Image.fromarray(out).save(dst)

    rgb2 = out[..., :3].astype(np.int32)
    info["flatness"] = round(flatness_of(rgb2, opaque), 3)
    info["colors"] = int(len(np.unique(rgb2[opaque].reshape(-1, 3), axis=0)))
    info["pitch"] = pitch
    return info


def main(argv: list[str]) -> None:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return
    src = Path(argv[0]).resolve()
    if not src.is_file():
        raise SystemExit(f"输入文件不存在：{src}")
    dst = Path(argv[1]).resolve() if len(argv) > 1 else src
    info = clean_image(src, dst)
    if "skipped" in info:
        print(f"[色块规整] 跳过（{info['skipped']}，平坦度 {info.get('flatness_before', '?')}）")
    else:
        print(f"[色块规整] 平坦度 {info['flatness_before']} → {info['flatness']}，"
              f"颜色数 {info['colors']}，颗粒度 ~{info['pitch']}px")


if __name__ == "__main__":
    main(sys.argv[1:])
