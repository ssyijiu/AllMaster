#!/usr/bin/env python3
"""Search content resolution and sub-cell phase on square bead boards.

A board spec is a single edge length, BOARD_MIN–BOARD_MAX beads per side.
Input is a flat, near-white-background or transparent pixel-art draft. Every
candidate is sampled from the full-resolution image, then scored after mapping
to the physical palette. Empty cells use an empty CSV field, not a white bead.
Content grid n×n (equal x/y pitch) is placed centered on the board; n is
searched within a per-board range (fixed tiers by interval table, custom by
0.8× the board edge up to it).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from skimage.color import rgb2lab, deltaE_ciede2000

BOARDS = (36, 52, 78, 104, 156)
BOARD_MIN = 15        # 单边最小格数
BOARD_MAX = 156       # 单边最大格数
# 固定档内容格数 n 的下限（按档间间隔划分、互不重叠）；非固定档按 0.8×板宽取
TIER_MIN_N = {36: 25, 52: 37, 78: 53, 104: 79, 156: 105}
DEFAULT_PALETTE = Path(__file__).resolve().parent / "palette_mard221.csv"
SEARCH_THREADS = min(8, os.cpu_count() or 1)   # 候选并行取样打分的线程数
FAMILY_DE = 16.0      # 高光修正：格内 ΔE2000 小于此值的色号合成色族、合并计票
BRIGHT_L = 20.0       # 高光修正：代表色须比原赢家、8 邻域主流色都亮这么多（Lab L）
OUTLINE_L = 20.0      # 高光修正：原赢家明度低于此值视为描边，不改
OUTLINE_FAMILY_DE = 22.0   # 描边补齐：与外缘主色 ΔE2000 小于此值的色号算作描边色
OUTLINE_MIN_RING = 0.4     # 描边补齐：外缘一圈里描边色占比下限，不够则整张不补
OUTLINE_MIN_LIFT = 1.3     # 描边补齐：外缘占比须是全图占比的这么多倍
OUTLINE_PAIR = 0.1         # 描边补齐：外缘上相邻空格与填充格的描边面积合计下限（格）
OUTLINE_RECOLOR = 0.2      # 描边补齐：外缘填充格自身描边面积达到此值即改成描边色
OUTLINE_EXTRA_RING = 0.10  # 描边补齐：主描边色族之外，外缘占比达到此值（且满足 OUTLINE_MIN_LIFT）的色号也算描边色
STICKER_WHITE_L = 88.0     # 贴纸白边：近白的 Lab 明度下限
STICKER_WHITE_C = 8.0      # 贴纸白边：近白的 Lab 彩度上限
STICKER_DARK_L = 35.0      # 贴纸白边：内侧描边算深色的 Lab 明度上限
STICKER_BAND_MAX = 0.04    # 贴纸白边：白色带最大宽度，按前景外接框长边比例
STICKER_COVER = 0.6        # 贴纸白边：剪影最外两圈被白色带覆盖的比例下限
STICKER_INNER_DARK = 0.6   # 贴纸白边：白色带内侧一圈里深色像素占比下限
MAX_SIDE = 2048            # 输入图长边上限，超过则等比缩小后再处理
N4 = ((-1, 0), (1, 0), (0, -1), (0, 1))


def parse_board(text):
    """板规格：BOARD_MIN–BOARD_MAX 之间的整数边长（板为正方形）。"""
    token = str(text).strip()
    if not token.isdigit() or not BOARD_MIN <= int(token) <= BOARD_MAX:
        raise ValueError(f"板规格必须是 {BOARD_MIN}–{BOARD_MAX} 之间的整数边长：{text}")
    return int(token)


def board_name(board):
    return str(board)


def default_min_n(board):
    """内容格数 n 的下限：固定档查档位表，其余按 0.8×板宽。"""
    return TIER_MIN_N.get(board, math.floor(0.8 * board))


def load_palette(path):
    with Path(path).open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    return [r["色号"].strip() for r in rows], np.array(
        [[int(r[c]) for c in ("R", "G", "B")] for r in rows], dtype=np.uint8)


def open_image(path, max_side=MAX_SIDE):
    """读入图片；长边超过 max_side 时等比缩小（最近邻，保持像素画的色块与透明边界），避免大图耗尽内存。"""
    image = Image.open(path)
    image.load()
    side = max(image.size)
    if side > max_side:
        scale = max_side / side
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(size, Image.Resampling.NEAREST)
    return image

def sticker_band(rgba):
    """贴纸白边检测：返回 (白色带布尔掩码或 None, 诊断信息)。

    贴纸类底稿常在图案描边外再包一圈白色贴纸轮廓。白色带须同时满足：近白、离剪影外缘不超过外接框长边的
    STICKER_BAND_MAX、与剪影最外两圈连通；覆盖剪影最外两圈的比例 ≥ STICKER_COVER；紧贴其内侧一圈的深色
    像素占比 ≥ STICKER_INNER_DARK（即里面确实还有一圈图案描边）。只对带透明背景的底稿生效。"""
    alpha = rgba[..., 3] >= 128
    if alpha.all() or not alpha.any():
        return None, dict(reason="no transparent background")
    lab = rgb2lab(rgba[..., :3].astype(float) / 255)
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    white = alpha & (lab[..., 0] >= STICKER_WHITE_L) & (chroma <= STICKER_WHITE_C)
    ys, xs = np.where(alpha)
    side = max(xs.max() - xs.min(), ys.max() - ys.min()) + 1
    dist = cv2.distanceTransform(alpha.astype(np.uint8), cv2.DIST_L2, 5)
    outer = alpha & (dist <= 2)
    _, comp = cv2.connectedComponents((white & (dist <= STICKER_BAND_MAX * side)).astype(np.uint8), connectivity=8)
    touch = np.unique(comp[white & outer])
    band = np.isin(comp, touch[touch > 0])
    cover = (band & outer).sum() / max(outer.sum(), 1)
    inner = cv2.dilate(band.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & alpha & ~band
    dark = (lab[..., 0] < STICKER_DARK_L)[inner].mean() if inner.any() else 0.0
    info = dict(cover=round(float(cover), 3), inner_dark=round(float(dark), 3))
    if cover < STICKER_COVER or dark < STICKER_INNER_DARK:
        return None, info
    return band, info

def strip_sticker_border(src, dst):
    """检出贴纸白边则把它置为透明写到 dst，未检出原样写出。返回 (是否去除, 诊断信息)。"""
    image = Image.open(src)
    image.load()
    rgba = np.asarray(image.convert("RGBA")).copy()
    band, info = sticker_band(rgba)
    if band is not None:
        rgba[band, 3] = 0
        info["pixels"] = int(band.sum())
    Image.fromarray(rgba).save(dst)
    return band is not None, info

def foreground(image, white_threshold=245):
    rgba = np.asarray(image.convert("RGBA"))
    rgb = np.asarray(image.convert("RGB")).copy()
    if (rgba[..., 3] < 255).any():
        mask = rgba[..., 3] >= 128
    else:
        white = np.all(rgb >= white_threshold, axis=2).astype(np.uint8)
        _, labels = cv2.connectedComponents(white, connectivity=4)
        border = np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1])))
        background_ids = border[border != 0]
        mask = ~np.isin(labels, background_ids)
    if not mask.any():
        raise ValueError("No foreground found in the input image")
    rgb[~mask] = 255
    yy, xx = np.where(mask)
    return rgb, mask, (int(xx.min()), int(yy.min()), int(xx.max()) + 1, int(yy.max()) + 1)


MERGE_MAX_CODE_DE = 10.0   # 近色合并护栏：两簇映射到的色号之间 ΔE2000 不小于此值就不并（像素近、豆子差得远，如深靛蓝瞳孔并进深灰）


def merge_close_centers(centers, sizes, palette_path, threshold=3.0, max_code_de=MERGE_MAX_CODE_DE):
    """Map indistinguishable smaller clusters to the nearest larger cluster, unless their bead colors differ visibly."""
    _, colors = load_palette(palette_path)
    plabs = rgb2lab(colors.astype(float)[None, ...] / 255)[0]
    nearest = deltaE_ciede2000(centers[:, None, :], plabs[None, :, :]).argmin(axis=1)
    distances = deltaE_ciede2000(centers[:, None, :], centers[None, :, :])
    code_de = deltaE_ciede2000(plabs[nearest][:, None, :], plabs[nearest][None, :, :])
    merged = centers.copy()
    for i in np.argsort(sizes):
        near = [j for j in range(len(centers)) if distances[i, j] < threshold
                and sizes[j] > sizes[i] and nearest[j] != nearest[i] and code_de[i, j] < max_code_de]
        if near:
            j = min(near, key=lambda j: distances[i, j])
            nearest[i] = nearest[j]
            merged[i] = merged[j]
    return merged


def palette_labels(rgb, mask, palette_path, max_colors, merge_close_colors=False):
    """Choose one shared source palette, preserving full-resolution geometry."""
    codes, colors = load_palette(palette_path)
    from sklearn.cluster import KMeans
    pixels = rgb[mask]
    labs = rgb2lab(pixels.astype(float)[None, ...] / 255)[0]
    rng = np.random.default_rng(42)
    sample = labs[rng.choice(len(labs), min(50000, len(labs)), replace=False)]
    k = min(max_colors, len(np.unique(sample, axis=0)))
    model = KMeans(n_clusters=k, random_state=42, n_init=3).fit(sample)
    qlabels = model.predict(labs)
    plabs = rgb2lab(colors.astype(float)[None, ...] / 255)[0]
    centers = model.cluster_centers_
    if merge_close_colors:
        centers = merge_close_centers(centers, np.bincount(qlabels, minlength=k), palette_path)
    nearest = deltaE_ciede2000(centers[:, None, :], plabs[None, :, :]).argmin(axis=1)
    unique_palette, inverse = np.unique(nearest, return_inverse=True)
    labels = np.zeros(mask.shape, dtype=np.int32)
    labels[mask] = inverse[qlabels] + 1
    return labels, np.vstack(([255, 255, 255], colors[unique_palette])).astype(np.uint8), [""] + [codes[i] for i in unique_palette]


def geometry(bbox, n, dx, dy):
    """Equal x/y pitch; one cell of total slack permits phase ±0.5 safely."""
    x0, y0, x1, y1 = bbox
    pitch = max(x1 - x0, y1 - y0) / (n - 1)
    left = (x0 + x1 - n * pitch) / 2 + dx * pitch
    top = (y0 + y1 - n * pitch) / 2 + dy * pitch
    eps = 1e-7
    if left > x0 + eps or top > y0 + eps or left + n * pitch < x1 - eps or top + n * pitch < y1 - eps:
        raise ValueError("Candidate would crop the foreground")
    return left, top, pitch


class Sampler:
    def __init__(self, labels, color_count):
        self.h, self.w = labels.shape
        self.integrals = np.stack([
            cv2.integral((labels == k).astype(np.uint8), sdepth=cv2.CV_32S)
            for k in range(color_count)], axis=-1)

    def at(self, xs, ys):
        """Bilinear integral lookup gives exact fractional pixel-area coverage."""
        xs = np.clip(xs, 0, self.w)
        ys = np.clip(ys, 0, self.h)
        xi, yi = np.floor(xs).astype(int), np.floor(ys).astype(int)
        xj, yj = np.minimum(xi + 1, self.w), np.minimum(yi + 1, self.h)
        wx, wy = (xs - xi)[None, :, None], (ys - yi)[:, None, None]
        a = self.integrals[yi[:, None], xi[None, :]]
        b = self.integrals[yi[:, None], xj[None, :]]
        c = self.integrals[yj[:, None], xi[None, :]]
        d = self.integrals[yj[:, None], xj[None, :]]
        return (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy

    def votes(self, bbox, n, dx, dy):
        """每格各色的面积票数 [n, n, K]，0 号为背景。"""
        left, top, pitch = geometry(bbox, n, dx, dy)
        xs = left + np.arange(n + 1) * pitch
        ys = top + np.arange(n + 1) * pitch
        values = self.at(xs, ys)
        votes = values[1:, 1:] - values[:-1, 1:] - values[1:, :-1] + values[:-1, :-1]
        votes = np.maximum(votes, 0)
        votes[..., 0] += np.maximum(0, pitch * pitch - votes.sum(axis=-1))
        return votes, (left, top, pitch)

    def sample(self, bbox, n, dx, dy):
        votes, geom = self.votes(bbox, n, dx, dy)
        return votes.argmax(axis=-1).astype(np.int32), geom


def highlight_fix(grid, votes, lab, family_de=FAMILY_DE, bright=BRIGHT_L, outline=OUTLINE_L):
    """高光分票修正：小块高光由几档相近亮色组成，按单个色号计票会被拆票、输给一档暗的过渡色。

    grid 为每格赢家下标，votes 为每格各色票数 [n, n, K]，lab 为各色 Lab [K, 3]；0 号是背景，不参与。
    四条同时满足才把格子改成代表色：①格内 ΔE2000 < family_de 的色合成色族、合并计票；
    ②某个不含原赢家的色族合票超过原赢家所在色族；③该色族代表色（族内单票最多）比原赢家、
    也比 8 邻域主流色亮 bright 以上；④原赢家不是近黑描边（L ≥ outline）。只换颜色，不增删豆子。
    浏览器端 palette-resolve.js 的 highlightFix 与此一致。返回 (新网格, 改动格数)。
    """
    k = votes.shape[-1]
    light = lab[:, 0]
    same = (deltaE_ciede2000(lab[:, None], lab[None]) < family_de).astype(np.float32)
    same[0] = 0
    same[:, 0] = 0
    share = (votes / np.maximum(votes.sum(axis=-1, keepdims=True), 1e-9)).astype(np.float32)
    family = share @ same
    rep = np.argmax(np.where(same[None, None] > 0, share[:, :, None, :], -1), axis=-1)
    n0, n1 = grid.shape
    pad = np.pad(grid, 1)
    around = np.stack([pad[1 + dy:1 + dy + n0, 1 + dx:1 + dx + n1]
                       for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx], axis=-1)
    count = np.stack([(around == c).sum(axis=-1) for c in range(k)], axis=-1)
    count[..., 0] = 0
    mode, has_neighbor = count.argmax(axis=-1), count.max(axis=-1) > 0
    yy, xx = np.indices(grid.shape)
    ok = (family > family[yy, xx, grid][..., None]) & (same[grid] == 0) & (grid > 0)[..., None]
    rep_light = light[rep]
    ok &= (rep_light >= light[grid][..., None] + bright) & (rep_light >= light[mode][..., None] + bright)
    ok &= (has_neighbor & (light[grid] >= outline))[..., None]
    score = np.where(ok, family, -1)
    pick, hit = score.argmax(axis=-1), score.max(axis=-1) > 0
    out = grid.copy()
    out[hit] = rep[yy, xx, pick][hit]
    return out, int(hit.sum())


def outline_ring(labels, mask, color_count, pitch):
    """剪影外缘一圈（宽度按格距换算）与全图前景里各色的像素数，供描边色识别。"""
    r = max(2, round(pitch / 6))
    ring = cv2.dilate((~mask).astype(np.uint8), np.ones((2 * r + 1,) * 2, np.uint8)).astype(bool) & mask
    return (np.bincount(labels[ring], minlength=color_count).astype(float),
            np.bincount(labels[mask], minlength=color_count).astype(float))

def outline_family(ring, total, de):
    """描边色族（布尔向量，0 号恒 False）；外缘没有统一描边色时返回 None，这张图不做描边补齐。

    外缘一圈里像素最多的色号，连同与它 ΔE2000 < OUTLINE_FAMILY_DE 的色号合成主色族；主色族在外缘的占比
    要 ≥ OUTLINE_MIN_RING，且至少是它在全图占比的 OUTLINE_MIN_LIFT 倍。图案有多种描边色时（例如蝴蝶结紫描边、
    杆子灰青描边），外缘占比 ≥ OUTLINE_EXTRA_RING 且至少是全图占比 OUTLINE_MIN_LIFT 倍的其他色号，连同其
    ΔE2000 < OUTLINE_FAMILY_DE 的近色，也并入色族。de 为色号两两 ΔE2000。"""
    ring, total = np.array(ring, float), np.array(total, float)
    ring[0] = total[0] = 0
    if ring.sum() <= 0 or total.sum() <= 0:
        return None
    family = np.asarray(de)[int(ring.argmax())] < OUTLINE_FAMILY_DE
    family[0] = False
    share = ring[family].sum() / ring.sum()
    if share < OUTLINE_MIN_RING or share < OUTLINE_MIN_LIFT * total[family].sum() / total.sum():
        return None
    rs, ts = ring / ring.sum(), total / total.sum()
    extra = ~family & (rs >= OUTLINE_EXTRA_RING) & (rs >= OUTLINE_MIN_LIFT * ts)
    extra[0] = False
    if extra.any():
        family = family | (np.asarray(de)[extra] < OUTLINE_FAMILY_DE).any(axis=0)
        family[0] = False
    return family

def outside_background(grid):
    """从板边出发、4 连通能走到的空格。被豆子围住的空格是图案内部的留白，不算外部。"""
    count, comp = cv2.connectedComponents((grid == 0).astype(np.uint8), connectivity=4)
    edge = np.unique(np.concatenate((comp[0], comp[-1], comp[:, 0], comp[:, -1])))
    return np.isin(comp, edge[edge > 0]) & (grid == 0)

def outline_fix(grid, share, family):
    """描边断口补齐：外描边被相邻两格各分走一半面积、两格都没投成描边时，把描边还给面积更大的那一格。

    grid 为整块板的色号下标网格（0 为空格），share 为每格各色面积占比 [H, W, K]，family 为描边色族。
    只动与外部背景相邻的外缘格，内部留白不补；描边始终一格厚：改动格与它 3×3 内原本贴着外部背景的描边格
    改完都须仍贴着外部背景，也不出现 2×2 描边块，补豆不得把外部背景围成新的留白，否则撤销。
    先补断口：外部空格 e 与非描边格 f 相邻、两格描边面积合计 ≥ OUTLINE_PAIR 时，描边放进面积更大的一格；
    再改色：外缘非描边格自身描边面积 ≥ OUTLINE_RECOLOR 时改成描边色（内侧已是描边则不改）。
    颜色用该格里面积最大的描边色号。浏览器端 palette-resolve.js 的 outlineFix 与此一致。返回 (新网格, 改动格数)。"""
    g = grid.copy()
    h, w = g.shape
    osh = np.round(share[..., family].sum(axis=-1), 9)   # 舍到 1e-9，排序与阈值比较不受浮点求和顺序影响，与浏览器端逐格一致
    best = np.where(family[None, None], share, -1).argmax(axis=-1)
    outside = outside_background(g)

    def inb(y, x):
        return 0 <= y < h and 0 <= x < w

    def is_outline(y, x):
        return inb(y, x) and g[y, x] > 0 and family[g[y, x]]

    def solid(y, x):
        return inb(y, x) and g[y, x] > 0 and not family[g[y, x]]

    def is_out(y, x):
        return not inb(y, x) or outside[y, x]

    def on_rim(y, x):
        return any(is_out(y + dy, x + dx) for dy, dx in N4)

    def block2(y, x):
        return any(all(is_outline(y + oy + a, x + ox + b) for a in (0, 1) for b in (0, 1))
                   for oy, ox in ((-1, -1), (-1, 0), (0, -1), (0, 0)))

    def apply(y, x):
        nonlocal outside
        keep = [(yy, xx) for yy in range(y - 1, y + 2) for xx in range(x - 1, x + 2)
                if is_outline(yy, xx) and on_rim(yy, xx)]
        old = g[y, x]
        g[y, x] = best[y, x]
        if old == 0:
            after = outside_background(g)
            if after.sum() != outside.sum() - 1:
                g[y, x] = old
                return False
            outside = after
        if not on_rim(y, x) or any(not on_rim(yy, xx) for yy, xx in keep) or block2(y, x):
            g[y, x] = old
            if old == 0:
                outside = outside_background(g)
            return False
        return True

    pairs = []
    for y, x in zip(*np.where(outside)):
        for dy, dx in N4:
            fy, fx = y + dy, x + dx
            if solid(fy, fx) and osh[y, x] + osh[fy, fx] >= OUTLINE_PAIR:
                pairs.append((osh[y, x] + osh[fy, fx], y, x, fy, fx))
    pairs.sort(key=lambda p: -p[0])
    changed = 0
    for _, ey, ex, fy, fx in pairs:
        if not outside[ey, ex] or not solid(fy, fx):
            continue
        into_fill = osh[fy, fx] > osh[ey, ex]
        if into_fill and is_outline(2 * fy - ey, 2 * fx - ex):
            continue                                   # f 内侧已是描边，改 f 就是叠一层
        changed += apply(*((fy, fx) if into_fill else (ey, ex)))
    order = [(osh[y, x], y, x) for y in range(h) for x in range(w)
             if solid(y, x) and on_rim(y, x) and osh[y, x] >= OUTLINE_RECOLOR]
    order.sort(key=lambda p: -p[0])
    for _, y, x in order:
        if not solid(y, x):
            continue
        outward = [(dy, dx) for dy, dx in N4 if is_out(y + dy, x + dx)]
        if not outward or any(is_outline(y - dy, x - dx) for dy, dx in outward):
            continue
        changed += apply(y, x)
    return g, int(changed)

class Evaluator:
    def __init__(self, rgb, mask, bbox, evaluation_side=384):
        x0, y0, x1, y1 = bbox
        scale = min(1, evaluation_side / max(x1 - x0, y1 - y0))
        w, h = max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale))
        self.xs = x0 + (np.arange(w) + 0.5) * (x1 - x0) / w
        self.ys = y0 + (np.arange(h) + 0.5) * (y1 - y0) / h
        self.ref = rgb[self.ys.astype(int)[:, None], self.xs.astype(int)[None, :]].astype(np.float32) / 255
        self.mask = mask[self.ys.astype(int)[:, None], self.xs.astype(int)[None, :]]
        edge_x = np.max(np.abs(np.diff(self.ref, axis=1)), axis=2)
        edge_y = np.max(np.abs(np.diff(self.ref, axis=0)), axis=2)
        self.edges = np.zeros((h, w), np.float32)
        self.edges[:, 1:] += edge_x
        self.edges[1:] += edge_y
        self.edges = cv2.dilate(self.edges, np.ones((3, 3), np.uint8))
        self.tiles = [(slice(y, min(y + math.ceil(h / 8), h)), slice(x, min(x + math.ceil(w / 8), w)))
                      for y in range(0, h, math.ceil(h / 8)) for x in range(0, w, math.ceil(w / 8))]

    def error_maps(self, colors):
        """每个调色板色与参照图的逐像素误差（同 score 原式），按调色板缓存；score 只做查表。"""
        key = colors.tobytes()
        if getattr(self, "_error_key", None) != key:
            ref = self.ref.reshape(1, -1, 3)
            self._error_maps = np.mean(np.abs(colors.astype(np.float32)[:, None, :] / 255 - ref), axis=2)
            self._error_key = key
        return self._error_maps

    def score(self, grid, colors, geom, board, size_weight):
        left, top, pitch = geom
        xi = np.floor((self.xs - left) / pitch).astype(int)
        yi = np.floor((self.ys - top) / pitch).astype(int)
        restored = grid[yi[:, None], xi[None, :]]
        maps = self.error_maps(colors)
        error = maps[restored.ravel(), np.arange(restored.size)].reshape(restored.shape)
        support = self.mask | (restored != 0)
        color_error = float(error[support].mean())
        edge_error = float((error * self.edges).sum() / max(float(self.edges.sum()), 1e-9))
        local = [float(error[t][support[t]].mean()) for t in self.tiles if support[t].any()]
        local_error = float(np.mean(sorted(local)[-max(1, math.ceil(len(local) / 4)):]))
        yy, xx = np.where(grid != 0)
        content_w = int(xx.max() - xx.min() + 1) if len(xx) else 0
        content_h = int(yy.max() - yy.min() + 1) if len(yy) else 0
        utilization = max(content_w, content_h) / board
        quality = 0.5 * color_error + 0.3 * edge_error + 0.2 * local_error
        return dict(score=quality + size_weight * (1 - utilization), quality_loss=quality,
                    color_error=color_error, edge_error=edge_error, local_error=local_error,
                    utilization=utilization, content_width=content_w, content_height=content_h)


def search(sampler, evaluator, colors, bbox, board, min_n=None, phases=5, size_weight=0.025):
    """内容格数 n 在 [min_n, board] 内搜索；min_n 缺省按档位表或 0.8×板宽。"""
    if min_n is None:
        min_n = default_min_n(board)
    if board < 4 or not 1 <= min_n <= board or phases < 3 or phases % 2 == 0 or size_weight < 0:
        raise ValueError("Require board>=4, 1<=min_n<=board, odd phases>=3, size_weight>=0")
    evaluator.error_maps(colors)   # 先建好误差图缓存，线程里只读
    jobs = [(n, float(dx), float(dy)) for n in range(max(3, math.ceil(min_n)), board + 1)
            for dy in np.linspace(-0.5, 0.5, phases) for dx in np.linspace(-0.5, 0.5, phases)]

    def run(job):
        n, dx, dy = job
        grid, geom = sampler.sample(bbox, n, dx, dy)
        return dict(n=n, dx=dx, dy=dy, **evaluator.score(grid, colors, geom, board, size_weight))

    # numpy 大数组运算释放 GIL，候选之间互不依赖；map 保序，结果与串行逐项相同
    with ThreadPoolExecutor(SEARCH_THREADS) as pool:
        records = list(pool.map(run, jobs))
    records.sort(key=lambda r: (r["score"], -r["n"], abs(r["dx"]) + abs(r["dy"]), r["dy"], r["dx"]))
    return records


def board_grid(grid, board):
    """内容格 n×n 居中放上 board×board 板；板比内容大的格留空（自定义是上限）。"""
    n = len(grid)
    if n > board:
        raise ValueError("Content grid exceeds board size")
    result = np.zeros((board, board), dtype=np.int32)
    start = (board - n) // 2
    result[start:start + n, start:start + n] = grid
    return result


def preview(grid, colors, scale=8):
    return Image.fromarray(colors[grid]).resize((grid.shape[1] * scale, grid.shape[0] * scale), Image.Resampling.NEAREST)


def board_share(votes, board):
    """每格各色面积占比，按 board_grid 同样居中放上整块板，板边留白格是纯背景。"""
    n, k = votes.shape[0], votes.shape[-1]
    share = np.zeros((board, board, k))
    share[..., 0] = 1
    start = (board - n) // 2
    share[start:start + n, start:start + n] = votes / np.maximum(votes.sum(axis=-1, keepdims=True), 1e-9)
    return share

def save_result(path, board, record, sampler, bbox, colors, codes, metadata, labels, mask):
    path.mkdir(parents=True, exist_ok=True)
    votes, geom = sampler.votes(bbox, record["n"], record["dx"], record["dy"])
    lab = rgb2lab(colors.astype(float)[None] / 255)[0]
    raw, changed = highlight_fix(votes.argmax(axis=-1).astype(np.int32), votes, lab)
    grid = board_grid(raw, board)
    family = outline_family(*outline_ring(labels, mask, len(colors), geom[2]),
                            deltaE_ciede2000(lab[:, None], lab[None]))
    outlined = 0
    if family is not None:
        grid, outlined = outline_fix(grid, board_share(votes, board), family)
    with (path / "grid_mard.csv").open("w", newline="", encoding="utf-8") as f:
        csv.writer(f, lineterminator="\n").writerows([[codes[i] for i in row] for row in grid])
    preview(grid, colors).save(path / "recovered_mard.png")
    image = preview(grid, colors, 16)
    draw = ImageDraw.Draw(image)
    for i in range(board + 1):
        p = min(i * 16, image.width - 1)
        draw.line((p, 0, p, image.height - 1), fill=(190, 190, 190))
    for j in range(board + 1):
        p = min(j * 16, image.height - 1)
        draw.line((0, p, image.width - 1, p), fill=(190, 190, 190))
    image.save(path / "recovered_grid.png")
    counts = {codes[int(k)]: int((grid == k).sum()) for k in np.unique(grid) if k}
    metrics = dict(metadata, method="alignment_search", board=board, selected=record,
                   transform=dict(left=geom[0], top=geom[1], pitch=geom[2]), highlight_changed=changed,
                   outline_detected=family is not None, outline_changed=outlined,
                   distinct_mard=len(counts), bead_count=sum(counts.values()), counts=counts)
    (path / "metrics.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
    return grid, metrics


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--palette", type=Path, default=DEFAULT_PALETTE)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--boards", nargs="+", default=[str(b) for b in BOARDS],
                    help=f"板规格：{BOARD_MIN}–{BOARD_MAX} 之间的整数边长（板为正方形）")
    ap.add_argument("--min-n", type=int, nargs="*", default=None,
                    help="各板内容格数 n 下限（与 --boards 一一对应）；缺省按固定档表或 0.8×板宽")
    ap.add_argument("--max-colors", type=int, default=28)
    ap.add_argument("--merge-close-colors", action="store_true", help="合并近色簇，修复同一区域的交错色（默认关闭）")
    ap.add_argument("--phases", type=int, default=5)
    ap.add_argument("--size-weight", type=float, default=0.025)
    ap.add_argument("--white-threshold", type=int, default=245)
    args = ap.parse_args()
    if not 1 <= args.max_colors <= 256 or not 0 <= args.white_threshold <= 255:
        ap.error("Invalid color budget or white threshold")
    try:
        boards = [parse_board(b) for b in args.boards]
    except ValueError as e:
        ap.error(str(e))
    if args.min_n is not None and len(args.min_n) != len(boards):
        ap.error("--min-n 必须与 --boards 一一对应")
    started = time.monotonic()
    rgb, mask, bbox = foreground(open_image(args.input), args.white_threshold)
    # 切格位置按不合并的取色搜索（与现役一致），合并只改选定格位上的颜色，板子不会因为换色整体挪半格
    base_labels, base_colors, _ = palette_labels(rgb, mask, args.palette, args.max_colors, False)
    labels, colors, codes = palette_labels(rgb, mask, args.palette, args.max_colors, args.merge_close_colors)
    base_sampler, sampler, evaluator = Sampler(base_labels, len(base_colors)), Sampler(labels, len(colors)), Evaluator(rgb, mask, bbox)
    args.output.mkdir(parents=True, exist_ok=True)
    Image.fromarray((mask * 255).astype(np.uint8)).save(args.output / "foreground_mask.png")
    metadata = dict(source_sha256=hashlib.sha256(args.input.read_bytes()).hexdigest(),
                    palette_sha256=hashlib.sha256(args.palette.read_bytes()).hexdigest(),
                    foreground_bbox=bbox, max_colors=args.max_colors,
                    merge_close_colors=args.merge_close_colors, merge_max_code_de=MERGE_MAX_CODE_DE, geometry_from="unmerged",
                    search=dict(phases=args.phases, size_weight=args.size_weight,
                                white_threshold=args.white_threshold, evaluation_side=384,
                                loss_weights=dict(color=0.5, edge=0.3, local=0.2)),
                    highlight_fix=dict(family_de=FAMILY_DE, bright_l=BRIGHT_L, outline_l=OUTLINE_L),
                    outline_fix=dict(family_de=OUTLINE_FAMILY_DE, min_ring=OUTLINE_MIN_RING, min_lift=OUTLINE_MIN_LIFT,
                                     pair=OUTLINE_PAIR, recolor=OUTLINE_RECOLOR, extra_ring=OUTLINE_EXTRA_RING), max_side=MAX_SIDE)
    summary = []
    for bi, board in enumerate(boards):
        min_n = args.min_n[bi] if args.min_n is not None else None
        name = board_name(board)
        records = search(base_sampler, evaluator, base_colors, bbox, board, min_n,
                         args.phases, args.size_weight)
        target = args.output / f"{name}_k{args.max_colors}"
        _, metrics = save_result(target, board, records[0], sampler, bbox, colors, codes, metadata, labels, mask)
        with (target / "search.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(records[0]), lineterminator="\n")
            writer.writeheader()
            writer.writerows(records)
        baseline = next(r for r in records if r["n"] == board and r["dx"] == 0 and r["dy"] == 0)
        candidates = [records[0]]
        for record in records:
            if len(candidates) == 3:
                break
            if all(abs(record["n"] - r["n"]) >= 2 for r in candidates):
                candidates.append(record)
        candidates.append(baseline)
        sheet = Image.new("RGB", (512 * len(candidates), 550), "#eeeeee")
        draw = ImageDraw.Draw(sheet)
        for i, r in enumerate(candidates):
            raw, _ = sampler.sample(bbox, r["n"], r["dx"], r["dy"])
            image = preview(board_grid(raw, board), colors, 4).resize((512, 512), Image.Resampling.NEAREST)
            sheet.paste(image, (512 * i, 38))
            tag = "selected" if i == 0 else "center baseline" if i == len(candidates) - 1 else "alternative"
            draw.text((512 * i + 8, 5), f"{tag}: n={r['n']} phase=({r['dx']},{r['dy']})", fill="black")
            draw.text((512 * i + 8, 20), f"loss={r['score']:.5f} content={r['content_width']}x{r['content_height']}", fill="black")
        sheet.save(target / "candidates.png")
        used_min_n = args.min_n[bi] if args.min_n is not None else default_min_n(board)
        summary.append(dict(board=board, name=name, min_n=used_min_n,
                            candidates=len(records), selected=records[0], baseline=baseline,
                            distinct_mard=metrics["distinct_mard"], bead_count=metrics["bead_count"]))
        print(json.dumps(summary[-1], ensure_ascii=False), flush=True)
    report = dict(metadata, results=summary, elapsed_seconds=time.monotonic() - started)
    (args.output / "search_summary.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()