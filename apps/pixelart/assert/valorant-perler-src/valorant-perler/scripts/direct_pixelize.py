#!/usr/bin/env python3
"""
动漫/卡通造型图 → 拼豆矩阵（直接缩放路径）

与 grid_recover.py（棋盘搜索路径）互补：当效果图不含隐含豆位网格时，
用高质量缩放 + KMeans 减色 + MARD 色板映射 直接产出逻辑豆位矩阵。

输出格式与 grid_recover.py 完全一致，方便并排对比。

用法：
    python3 direct_pixelize.py --input anime.png --size 52 --palette palette_mard221.csv --output ./out
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from sklearn.cluster import KMeans
from skimage.color import deltaE_ciede2000, lab2rgb, rgb2lab

SHARED = Path(__file__).resolve().parent
DEFAULT_PALETTE = SHARED / "palette_mard221.csv"


def resize_to_grid(img: Image.Image, size: int) -> np.ndarray:
    """高质量缩放到 NxN。对缩小用 LANCZOS，效果优于 BOX/NEAREST。"""
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    return np.array(resized.convert("RGB"))


def reduce_colors(grid: np.ndarray, max_colors: int | None) -> np.ndarray:
    """KMeans 在 CIELAB 空间聚类减色。"""
    unique = np.unique(grid.reshape(-1, 3), axis=0)
    if max_colors is None or len(unique) <= max_colors:
        return grid
    lab = rgb2lab(grid.astype(np.float64) / 255.0).reshape(-1, 3)
    model = KMeans(n_clusters=max_colors, random_state=42, n_init=10)
    labels = model.fit_predict(lab)
    centers = np.clip(np.rint(lab2rgb(model.cluster_centers_) * 255), 0, 255).astype(np.uint8)
    return centers[labels].reshape(grid.shape)


def load_palette(path: Path) -> tuple[list[str], np.ndarray]:
    with path.open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    codes = [row["色号"].strip() for row in rows]
    colors = np.array([[int(row["R"]), int(row["G"]), int(row["B"])] for row in rows], dtype=np.uint8)
    return codes, colors


def map_palette(grid: np.ndarray, palette_path: Path) -> tuple[np.ndarray, list[list[str]]]:
    codes, colors = load_palette(palette_path)
    grid_lab = rgb2lab(grid.astype(np.float64) / 255.0)
    palette_lab = rgb2lab(colors.astype(np.float64) / 255.0)
    distance = deltaE_ciede2000(grid_lab[:, :, None, :], palette_lab[None, None, :, :])
    indices = distance.argmin(axis=2)
    return colors[indices], [[codes[index] for index in row] for row in indices]


def save_preview(grid: np.ndarray, path: Path, scale: int = 20, lines: bool = False) -> None:
    image = Image.fromarray(grid).resize(
        (grid.shape[1] * scale, grid.shape[0] * scale), Image.Resampling.NEAREST
    )
    if lines:
        draw = ImageDraw.Draw(image)
        for i in range(grid.shape[0] + 1):
            pos = min(i * scale, image.height - 1)
            draw.line((0, pos, image.width - 1, pos), fill=(175, 175, 175), width=1)
        for i in range(grid.shape[1] + 1):
            pos = min(i * scale, image.width - 1)
            draw.line((pos, 0, pos, image.height - 1), fill=(175, 175, 175), width=1)
    image.save(path)


def run(src: Path, size: int, palette: Path, output: Path, max_colors: int | None = None) -> dict:
    img = Image.open(src).convert("RGB")
    raw_grid = resize_to_grid(img, size)
    reduced_grid = reduce_colors(raw_grid, max_colors)
    mard_grid, codes = map_palette(reduced_grid, palette)

    output.mkdir(parents=True, exist_ok=True)
    save_preview(raw_grid, output / "recovered_rgb.png")
    save_preview(mard_grid, output / "recovered_mard.png")
    save_preview(mard_grid, output / "recovered_grid.png", lines=True)

    with (output / "grid_mard.csv").open("w", newline="", encoding="utf-8") as f:
        csv.writer(f, lineterminator="\n").writerows(codes)

    metadata = {
        "method": "direct_pixelize",
        "source": str(src),
        "size": size,
        "resample": "LANCZOS",
        "distinct_rgb": int(len(np.unique(raw_grid.reshape(-1, 3), axis=0))),
        "max_colors": max_colors,
        "distinct_reduced": int(len(np.unique(reduced_grid.reshape(-1, 3), axis=0))),
        "distinct_mard": int(len({code for row in codes for code in row})),
    }
    (output / "metrics.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description="动漫/卡通图直接缩放为拼豆矩阵")
    parser.add_argument("--input", type=Path, required=True, help="造型图路径")
    parser.add_argument("--size", type=int, required=True, help="目标豆位规格（如 52）")
    parser.add_argument("--palette", type=Path, default=DEFAULT_PALETTE, help="MARD 色板 CSV")
    parser.add_argument("--output", type=Path, required=True, help="输出目录")
    parser.add_argument("--max-colors", type=int, default=None, help="颜色预算")
    args = parser.parse_args()

    metadata = run(args.input, args.size, args.palette, args.output, args.max_colors)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
