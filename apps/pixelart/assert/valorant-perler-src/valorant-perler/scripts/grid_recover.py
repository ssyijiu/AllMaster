#!/usr/bin/env python3
"""从高清像素效果图中搜索隐含棋盘并恢复拼豆矩阵。"""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from sklearn.cluster import KMeans
from skimage.color import deltaE_ciede2000, lab2rgb, rgb2lab

SHARED = Path(__file__).resolve().parent
DEFAULT_PALETTE = SHARED / "palette_mard221.csv"


@dataclass(frozen=True)
class GridFit:
    x0: float
    y0: float
    cell_w: float
    cell_h: float
    size: int
    canvas_bbox: tuple[int, int, int, int]
    x_score: float
    y_score: float

    @property
    def x1(self) -> float:
        return self.x0 + self.size * self.cell_w

    @property
    def y1(self) -> float:
        return self.y0 + self.size * self.cell_h


def find_canvas(rgb: np.ndarray) -> tuple[int, int, int, int]:
    """找近白正方形画布；方图默认整图就是画布。"""
    h, w = rgb.shape[:2]
    if 0.98 <= w / h <= 1.02:
        return 0, 0, w, h

    near_white = np.all(rgb >= 248, axis=2).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(near_white, 8)
    candidates = []
    for x, y, cw, ch, area in stats[1:count]:
        side = min(cw, ch)
        if side < min(w, h) * 0.25:
            continue
        square_error = abs(cw - ch) / max(cw, ch)
        fill = area / (cw * ch)
        score = side * side * fill * (1.0 - square_error)
        candidates.append((score, int(x), int(y), int(cw), int(ch)))
    if not candidates:
        raise ValueError("未找到近白正方形画布；请用 --canvas x,y,w,h 指定")
    _, x, y, cw, ch = max(candidates)
    side = min(cw, ch)
    return x, y, side, side


def edge_projection(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    work = rgb.astype(np.float32)
    x_edges = np.abs(np.diff(work, axis=1)).mean(axis=(0, 2))
    y_edges = np.abs(np.diff(work, axis=0)).mean(axis=(1, 2))
    return x_edges, y_edges


def fit_axis(projection: np.ndarray, seed_start: int, seed_span: int, size: int) -> tuple[float, float, float]:
    """搜索棋盘相位与格距，让图像边缘尽量落在格线而不是格心。"""
    nominal = seed_span / size
    starts = np.linspace(seed_start - nominal * 0.75, seed_start + nominal * 0.75, 121)
    steps = np.linspace(nominal * 0.97, nominal * 1.03, 121)
    best = None
    for step in steps:
        offsets = np.arange(size + 1) * step
        for start in starts:
            boundaries = start + offsets
            if boundaries[0] < 0 or boundaries[-1] > len(projection) + 1:
                continue
            ids = np.rint(boundaries[1:-1]).astype(int)
            if ids[0] < 1 or ids[-1] >= len(projection) - 1:
                continue
            edge_strength = np.mean([projection[i - 1:i + 2].max() for i in ids])
            center_ids = np.rint(start + (np.arange(size) + 0.5) * step).astype(int)
            center_strength = np.mean(projection[np.clip(center_ids, 0, len(projection) - 1)])
            end_error = abs(boundaries[0] - seed_start) + abs(boundaries[-1] - (seed_start + seed_span))
            score = edge_strength - 0.35 * center_strength - 0.08 * end_error
            if best is None or score > best[0]:
                best = score, start, step
    if best is None:
        raise ValueError("棋盘搜索范围超出图像")
    return float(best[1]), float(best[2]), float(best[0])


def fit_grid(rgb: np.ndarray, size: int, canvas: tuple[int, int, int, int] | None = None) -> GridFit:
    bbox = canvas or find_canvas(rgb)
    x, y, w, h = bbox
    crop = rgb[y:y + h, x:x + w]
    x_projection, y_projection = edge_projection(crop)
    local_x0, cell_w, x_score = fit_axis(x_projection, 0, w, size)
    local_y0, cell_h, y_score = fit_axis(y_projection, 0, h, size)
    return GridFit(x + local_x0, y + local_y0, cell_w, cell_h, size, bbox, x_score, y_score)


def recover_rgb(rgb: np.ndarray, fit: GridFit, inset: float = 0.25) -> np.ndarray:
    """读取每格内部中位色，避开边界抗锯齿和图纸网格线。"""
    grid = np.empty((fit.size, fit.size, 3), dtype=np.uint8)
    h, w = rgb.shape[:2]
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
                raise ValueError(f"格心采样区域为空：row={row}, col={col}")
            grid[row, col] = np.rint(np.median(rgb[iy0:iy1, ix0:ix1], axis=(0, 1))).astype(np.uint8)
    return grid


def reduce_colors(grid: np.ndarray, max_colors: int | None) -> np.ndarray:
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
    image = Image.fromarray(grid).resize((grid.shape[1] * scale, grid.shape[0] * scale), Image.Resampling.NEAREST)
    if lines:
        draw = ImageDraw.Draw(image)
        for i in range(grid.shape[0] + 1):
            pos = min(i * scale, image.height - 1)
            draw.line((0, pos, image.width - 1, pos), fill=(175, 175, 175), width=1)
        for i in range(grid.shape[1] + 1):
            pos = min(i * scale, image.width - 1)
            draw.line((pos, 0, pos, image.height - 1), fill=(175, 175, 175), width=1)
    image.save(path)


def save_alignment(rgb: np.ndarray, fit: GridFit, path: Path) -> None:
    image = Image.fromarray(rgb)
    draw = ImageDraw.Draw(image)
    for i in range(fit.size + 1):
        x = round(fit.x0 + i * fit.cell_w)
        y = round(fit.y0 + i * fit.cell_h)
        draw.line((x, fit.y0, x, fit.y1), fill=(255, 0, 0), width=1)
        draw.line((fit.x0, y, fit.x1, y), fill=(255, 0, 0), width=1)
    image.save(path)


def parse_canvas(value: str | None) -> tuple[int, int, int, int] | None:
    if value is None:
        return None
    parts = tuple(int(part) for part in value.split(","))
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--canvas 必须是 x,y,w,h")
    return parts


def run(src: Path, size: int, palette: Path, output: Path, canvas=None, max_colors: int | None = None) -> GridFit:
    rgb = np.array(Image.open(src).convert("RGB"))
    fit = fit_grid(rgb, size, canvas)
    raw_grid = recover_rgb(rgb, fit)
    reduced_grid = reduce_colors(raw_grid, max_colors)
    mard_grid, codes = map_palette(reduced_grid, palette)
    output.mkdir(parents=True, exist_ok=True)
    save_preview(raw_grid, output / "recovered_rgb.png")
    save_preview(mard_grid, output / "recovered_mard.png")
    save_preview(mard_grid, output / "recovered_grid.png", lines=True)
    save_alignment(rgb, fit, output / "alignment.png")
    with (output / "grid_mard.csv").open("w", newline="", encoding="utf-8") as f:
        csv.writer(f, lineterminator="\n").writerows(codes)
    metadata = asdict(fit) | {
        "source": str(src),
        "distinct_rgb": int(len(np.unique(raw_grid.reshape(-1, 3), axis=0))),
        "max_colors": max_colors,
        "distinct_reduced": int(len(np.unique(reduced_grid.reshape(-1, 3), axis=0))),
        "distinct_mard": int(len({code for row in codes for code in row})),
    }
    (output / "metrics.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return fit


def main() -> None:
    parser = argparse.ArgumentParser(description="搜索高清像素效果图的隐含棋盘并恢复拼豆矩阵")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--size", type=int, required=True)
    parser.add_argument("--palette", type=Path, default=DEFAULT_PALETTE)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--canvas", help="可选画布初值 x,y,w,h；不传则自动检测")
    parser.add_argument("--max-colors", type=int, help="可选颜色预算；不传则忠实恢复原色")
    args = parser.parse_args()
    fit = run(
        args.input, args.size, args.palette, args.output,
        parse_canvas(args.canvas), args.max_colors,
    )
    print(json.dumps(asdict(fit), ensure_ascii=False))


if __name__ == "__main__":
    main()
