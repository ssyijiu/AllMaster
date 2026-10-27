#!/usr/bin/env python3
"""
将图片转成拼豆（perler beads / fuse beads）像素网格图纸。

功能：
  1. 把输入图片降采样到 N×N 像素网格；
  2. 将每个网格像素的颜色映射到拼豆标准色号（最近邻匹配）；
  3. 输出可视化网格图、逐格色号矩阵、色号用量明细与汇总。

依赖：Pillow（pip install Pillow）

内置色号表为「近似参考色」，具体请以 Artkal / Hama 官方色卡为准。
"""

import argparse
import csv
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("缺少依赖 Pillow，请先安装：pip install Pillow")
    sys.exit(1)


# 内置近似参考色号表（HEX 为近似值，仅供图纸配色参考，非官方精确色值）
PALETTES = {
    "artkal": [
        ("S01", "白", "#FFFFFF"),
        ("S02", "黑", "#1A1A1A"),
        ("S03", "浅灰", "#C8C8C8"),
        ("S04", "中灰", "#9A9A9A"),
        ("S05", "深灰", "#5A5A5A"),
        ("S06", "红", "#E53935"),
        ("S07", "深红", "#B71C1C"),
        ("S08", "橙", "#FB8C00"),
        ("S09", "黄", "#FDD835"),
        ("S10", "浅黄", "#FFF59D"),
        ("S11", "绿", "#43A047"),
        ("S12", "深绿", "#1B5E20"),
        ("S13", "浅绿", "#A5D6A7"),
        ("S14", "蓝", "#1E88E5"),
        ("S15", "深蓝", "#0D47A1"),
        ("S16", "浅蓝", "#90CAF9"),
        ("S17", "紫", "#8E24AA"),
        ("S18", "浅紫", "#CE93D8"),
        ("S19", "粉", "#F48FB1"),
        ("S20", "棕", "#795548"),
        ("S21", "米色", "#F5F0E1"),
        ("S22", "金", "#FFC107"),
        ("S23", "银", "#B0BEC5"),
        ("S24", "青", "#00BCD4"),
        ("S25", "军绿", "#556B2F"),
        ("S26", "肤色", "#FFCCBC"),
        ("S27", "桃", "#FFAB91"),
        ("S28", "薄荷", "#B2DFDB"),
    ],
    "hama": [
        ("01", "白", "#FFFFFF"),
        ("02", "奶油", "#FDF5E6"),
        ("03", "黄", "#FFD700"),
        ("04", "橙", "#FF8C00"),
        ("05", "红", "#E60000"),
        ("06", "深红", "#8B0000"),
        ("07", "粉", "#FFB6C1"),
        ("08", "紫", "#800080"),
        ("09", "浅蓝", "#ADD8E6"),
        ("10", "蓝", "#0000FF"),
        ("11", "深蓝", "#000080"),
        ("12", "绿", "#008000"),
        ("13", "深绿", "#006400"),
        ("14", "浅绿", "#90EE90"),
        ("15", "棕", "#8B4513"),
        ("16", "深棕", "#5C4033"),
        ("17", "灰", "#808080"),
        ("18", "浅灰", "#C0C0C0"),
        ("19", "黑", "#000000"),
        ("20", "青", "#00FFFF"),
    ],
}


def hex_to_rgb(hex_str: str):
    hex_str = hex_str.lstrip("#")
    return tuple(int(hex_str[i : i + 2], 16) for i in (0, 2, 4))


def closest_color(rgb, palette):
    """在调色板中找与 rgb 最接近的颜色（欧氏距离）。"""
    best = None
    best_d = float("inf")
    for code, name, hex_val in palette:
        pr, pg, pb = hex_to_rgb(hex_val)
        d = (rgb[0] - pr) ** 2 + (rgb[1] - pg) ** 2 + (rgb[2] - pb) ** 2
        if d < best_d:
            best_d = d
            best = (code, name, hex_val)
    return best


def main():
    parser = argparse.ArgumentParser(description="图片转拼豆像素网格图纸")
    parser.add_argument("image_path", help="输入图片路径")
    parser.add_argument("--size", type=int, default=29, help="目标网格边长 N（默认 29）")
    parser.add_argument("--palette", choices=list(PALETTES.keys()), default="artkal", help="色号体系（默认 artkal）")
    parser.add_argument("--out", default="", help="输出目录（默认图片同目录下 perler_out/）")
    parser.add_argument("--cell", type=int, default=20, help="输出网格图每个格子的像素大小（默认 20）")
    args = parser.parse_args()

    if not os.path.isfile(args.image_path):
        print(f"图片不存在：{args.image_path}")
        sys.exit(1)

    palette = PALETTES[args.palette]
    out_dir = args.out or os.path.join(os.path.dirname(os.path.abspath(args.image_path)), "perler_out")
    os.makedirs(out_dir, exist_ok=True)

    img = Image.open(args.image_path).convert("RGB")
    small = img.resize((args.size, args.size), Image.LANCZOS)

    # 逐格映射色号
    grid = []  # size x size，每项 (code, name, hex)
    for y in range(args.size):
        row = []
        for x in range(args.size):
            rgb = small.getpixel((x, y))
            row.append(closest_color(rgb, palette))
        grid.append(row)

    # 输出 grid.csv（逐格色号矩阵）
    csv_path = os.path.join(out_dir, "grid.csv")
    with open(csv_path, "w", newline="") as f:
        w = csv.writer(f)
        for row in grid:
            w.writerow([cell[0] for cell in row])

    # 统计用量
    from collections import Counter

    counter = Counter(cell[0] for row in grid for cell in row)
    code_info = {}
    for row in grid:
        for code, name, hex_val in row:
            code_info[code] = (name, hex_val)

    colors_path = os.path.join(out_dir, "colors.csv")
    with open(colors_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["色号", "颜色名", "HEX", "用量"])
        for code, cnt in sorted(counter.items(), key=lambda kv: -kv[1]):
            name, hex_val = code_info[code]
            w.writerow([code, name, hex_val, cnt])

    summary_path = os.path.join(out_dir, "summary.txt")
    total = args.size * args.size
    lines = [
        f"拼豆图纸汇总（{args.size} x {args.size} = {total} 豆）",
        f"色号体系：{args.palette}（近似参考色，以官方色卡为准）",
        f"用色数：{len(counter)}",
        "",
        "逐色用量（从多到少）：",
    ]
    for code, cnt in sorted(counter.items(), key=lambda kv: -kv[1]):
        name, hex_val = code_info[code]
        lines.append(f"  {code}\t{name}\t{hex_val}\t{cnt} 颗")
    with open(summary_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    # 输出 grid.png（放大网格 + 网格线）
    cell = args.cell
    big = small.resize((args.size * cell, args.size * cell), Image.NEAREST)
    draw = ImageDraw.Draw(big)
    line_color = (200, 200, 200)
    for i in range(1, args.size):
        draw.line([(i * cell, 0), (i * cell, args.size * cell)], fill=line_color, width=1)
        draw.line([(0, i * cell), (args.size * cell, i * cell)], fill=line_color, width=1)
    png_path = os.path.join(out_dir, "grid.png")
    big.save(png_path)

    print(f"✅ 生成完成，输出目录：{out_dir}")
    print(f"  - {os.path.basename(png_path)}  可视化网格图")
    print(f"  - {os.path.basename(csv_path)}  逐格色号矩阵")
    print(f"  - {os.path.basename(colors_path)}  色号用量明细")
    print(f"  - {os.path.basename(summary_path)}  用量汇总")


if __name__ == "__main__":
    main()
