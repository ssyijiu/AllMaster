#!/usr/bin/env python3
"""像素底稿的多数投票恢复。

grid_recover 的格心中位采样在「格子尺寸 ≈ 底稿色块尺寸」时会对相位误差
拍频：同一色块被格线切成两半，两侧格子各采到一种颜色，成品出现碎片噪点
（52/78 格实测）。本脚本先对全图做粗量化，再对每格内
像素做多数投票取主色——只要格内过半像素属于同一色块，相位误差不影响结果。

适用：像素风硬边底稿（02 阶段产物）。高清带渐变图请用 direct_pixelize，
格子远大于色块（角色题材大规格）时 grid_recover 的棋盘分数可直接信任。

用法与 grid_recover 相同：
    python3 quantize_vote.py --input 转换图.png --size 52 \
        --palette palette_mard221.csv --max-colors 21 --output 52_k21

产物集合与 grid_recover 一致（recovered_rgb/mard/grid、alignment、
grid_mard.csv、metrics.json）；metrics 顶层不含 cell_w / x_score /
y_score——投票恢复使用等距采样，不依赖棋盘拟合分数，门禁按非棋盘路线
（只查色数预算）判定；几何方式、补白量与等距采样参数写入 metrics 供诊断。
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import numpy as np
from PIL import Image

EXPERT_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERT_SCRIPTS))
from grid_recover import (  # noqa: E402
    GridFit,
    map_palette,
    parse_canvas,
    save_alignment,
    save_preview,
)

DEFAULT_PALETTE = EXPERT_SCRIPTS / "palette_mard221.csv"


def square_canvas(rgb: np.ndarray, canvas=None) -> tuple[np.ndarray, dict]:
    """把选定画布等比放进居中的正方形，不拉伸、不裁切。

    最终豆板固定为正方形，因此非方底稿必须在短边方向补白。采样格必须为
    正方形；若分别把宽、高都切成 N 份，矩形采样格写回正方形豆位时会改变
    主体比例。
    """
    height, width = rgb.shape[:2]
    if canvas is None:
        x, y, crop_w, crop_h = 0, 0, width, height
    else:
        x, y, crop_w, crop_h = canvas
        if crop_w <= 0 or crop_h <= 0 or x < 0 or y < 0 or x + crop_w > width or y + crop_h > height:
            raise ValueError("--canvas 超出输入图片范围")
    crop = rgb[y:y + crop_h, x:x + crop_w]
    side = max(crop_w, crop_h)
    left = (side - crop_w) // 2
    top = (side - crop_h) // 2
    padded = np.full((side, side, 3), 255, dtype=np.uint8)
    padded[top:top + crop_h, left:left + crop_w] = crop
    metadata = {
        "source_canvas": [x, y, crop_w, crop_h],
        "square_canvas": [side, side],
        "padding": {"left": left, "top": top,
                    "right": side - crop_w - left, "bottom": side - crop_h - top},
    }
    return padded, metadata


def quantize_labels(rgb: np.ndarray, k: int = 28) -> tuple:
    """全图中位切分量化为 k 个颜色簇，返回 (逐像素簇标签, 簇中心RGB)。
    不用精确色直方图：底稿的色块内部常带轻微渐变，精确色会把一个色块
    打散成大量微差色，逐格众数被渐变端夺走；先聚成少数簇再投票才稳。"""
    q = Image.fromarray(rgb).quantize(colors=k, method=Image.Quantize.MEDIANCUT)
    labels = np.asarray(q, dtype=np.int32)
    palette = np.asarray(q.getpalette(), dtype=np.uint8).reshape(-1, 3)[:k]
    return labels, palette


def vote_grid(labels: np.ndarray, palette: np.ndarray, rgb: np.ndarray,
              fit: GridFit, inset: float = 0.10) -> np.ndarray:
    """每格取簇标签的多数票，格内颜色取该簇的量化中心色。
    不取簇内像素中位数：渐变位置不同会让同簇各格的中位数互有微差，
    后续按出现次数砍色数时，碎片色会被数量占优的背景色吞掉。"""
    h, w = labels.shape
    grid = np.empty((fit.size, fit.size, 3), dtype=np.uint8)
    for row in range(fit.size):
        for col in range(fit.size):
            xa = fit.x0 + col * fit.cell_w
            xb = xa + fit.cell_w
            ya = fit.y0 + row * fit.cell_h
            yb = ya + fit.cell_h
            ix0 = max(0, int(np.ceil(xa + fit.cell_w * inset)))
            ix1 = min(w, int(np.floor(xb - fit.cell_w * inset)))
            iy0 = max(0, int(np.ceil(ya + fit.cell_h * inset)))
            iy1 = min(h, int(np.floor(yb - fit.cell_h * inset)))
            if ix1 <= ix0 or iy1 <= iy0:
                raise ValueError(f"格内投票区域为空：row={row}, col={col}")
            patch = labels[iy0:iy1, ix0:ix1]
            label = Counter(patch.ravel().tolist()).most_common(1)[0][0]
            grid[row, col] = palette[label]
    return grid


def merge_close(grid: np.ndarray, threshold: int = 16) -> np.ndarray:
    """感知近色合并：按出现次数降序保留代表色，RGB 距离小于阈值的颜色
    并入最近的代表色。底稿的背景/白色常带轻微暖渐变，量化后分裂成
    多个近白簇，不合并会在背景留下斑驳的杂色斑块。"""
    counts = Counter(map(tuple, grid.reshape(-1, 3)))
    kept: list[tuple] = []
    remap: dict[tuple, tuple] = {}
    for color, _ in counts.most_common():
        if kept:
            arr = np.array(kept, dtype=np.int32)
            dist = ((arr - np.array(color, dtype=np.int32)) ** 2).sum(axis=1)
            nearest = int(dist.argmin())
            if dist[nearest] < threshold * threshold:
                remap[color] = kept[nearest]
                continue
        kept.append(color)
    if not remap:
        return grid
    out = grid.copy()
    for y in range(grid.shape[0]):
        for x in range(grid.shape[1]):
            px = tuple(grid[y, x])
            if px in remap:
                out[y, x] = remap[px]
    return out


def cap_colors(grid: np.ndarray, max_colors: int | None) -> np.ndarray:
    """按出现次数保留前 max_colors 种颜色，其余并入 RGB 最近的保留色。
    不用 KMeans：投票后主色已经真实存在，聚类反而会挪动主体色。"""
    flat = grid.reshape(-1, 3)
    counts = Counter(map(tuple, flat))
    if max_colors is None or len(counts) <= max_colors:
        return grid
    kept = np.array([c for c, _ in counts.most_common(max_colors)], dtype=np.int32)
    kept_labels = {tuple(c) for c in kept}
    grid_out = grid.copy()
    for y in range(grid.shape[0]):
        for x in range(grid.shape[1]):
            px = tuple(grid[y, x])
            if px in kept_labels:
                continue
            dist = ((kept - np.array(px, dtype=np.int32)) ** 2).sum(axis=1)
            grid_out[y, x] = kept[int(dist.argmin())]
    return grid_out


def run(src: Path, size: int, palette: Path, output: Path,
        canvas=None, max_colors: int | None = None) -> GridFit:
    source_rgb = np.array(Image.open(src).convert("RGB"))
    rgb, geometry_metadata = square_canvas(source_rgb, canvas)
    pitch = rgb.shape[0] / size
    fit = GridFit(0.0, 0.0, pitch, pitch, size,
                  (0, 0, rgb.shape[1], rgb.shape[0]), 0.0, 0.0)
    # 量化簇数固定：它是逐格投票的票仓粒度，与最终色数预算无关。
    # 若 k 随预算压缩（如 52 格用 21），金色等占比小的主色会失去簇而退成卡其色。
    k = 28
    labels, qpalette = quantize_labels(rgb, k)
    raw_grid = vote_grid(labels, qpalette, rgb, fit)
    raw_grid = merge_close(raw_grid)
    reduced_grid = cap_colors(raw_grid, max_colors)
    mard_grid, codes = map_palette(reduced_grid, palette)
    output.mkdir(parents=True, exist_ok=True)
    save_preview(raw_grid, output / "recovered_rgb.png")
    save_preview(mard_grid, output / "recovered_mard.png")
    save_preview(mard_grid, output / "recovered_grid.png", lines=True)
    save_alignment(rgb, fit, output / "alignment.png")
    with (output / "grid_mard.csv").open("w", newline="", encoding="utf-8") as f:
        csv.writer(f, lineterminator="\n").writerows(codes)
    metadata = {
        "method": "quantize_vote",
        "source": str(src),
        "size": size,
        "geometry": "aspect_fit_with_square_padding",
        **geometry_metadata,
        "quantization": f"median_cut_k{k}",
        "fit": asdict(fit),
        "max_colors": max_colors,
        "distinct_reduced": int(len(np.unique(reduced_grid.reshape(-1, 3), axis=0))),
        "distinct_mard": int(len({code for row in codes for code in row})),
    }
    (output / "metrics.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return fit


def main() -> None:
    parser = argparse.ArgumentParser(description="像素底稿多数投票恢复拼豆矩阵")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--size", type=int, required=True)
    parser.add_argument("--palette", type=Path, default=DEFAULT_PALETTE)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--canvas", help="可选处理区域 x,y,w,h；不传则使用完整输入画布")
    parser.add_argument("--max-colors", type=int, help="可选颜色预算；不传则忠实恢复原色")
    args = parser.parse_args()
    fit = run(args.input, args.size, args.palette, args.output,
              parse_canvas(args.canvas), args.max_colors)
    print(json.dumps({"size": args.size, "distinct_mard": None,
                      "cell_w": round(fit.cell_w, 3), "cell_h": round(fit.cell_h, 3),
                      "x_score": round(fit.x_score, 2), "y_score": round(fit.y_score, 2)},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()