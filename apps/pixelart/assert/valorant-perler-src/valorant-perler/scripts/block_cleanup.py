#!/usr/bin/env python3
"""block_cleanup.py — 生图后端的色块规整（拼豆底稿净化）。

背景：生图后端换成通用模型（gpt-image 系）后，输出带有纹理噪点、抗锯齿混色和
边缘光晕，平坦度只有 ~25%（旧专用后端 ~68%），下游切格量化会出现杂色和条纹。
本脚本把底稿「洗」成硬边平涂：平坦度可达 ~95%，颜色数收敛到 20 左右。

处理步骤（v7 = v6 + 影调按参照带校准；2026-10-29 用 8 组同源真实数据标定）：
  0. 背景兜底透明化：模型应输出透明底但偶尔画成不透明均匀背景（线上 G9/G29：
     背景整片变豆子）。全图不透明且四边颜色均匀时，把与边界连通的均匀色块
     （颜色贴近边界中位色）置为透明；背景有结构的（海报/场景）不动，已有
     透明的输出不动。放在幂等跳过**之前**，保证干净图也能被修背景。
  0.5 孤立噪点岛清除：生图偶尔在背景区残留小片不透明噪块（飞点）。与主体
     不相连且面积小于约两颗豆的岛直接置透明；迷你贴纸画风的小贴纸远大于
     阈值，不受影响。
  1. 影调校准（v7）：不再无条件提亮，而是把动态范围与饱和度补齐到
     「参照后端 val-perler 的实测带」（8 组同源真实数据标定：我方原始输出
     饱和度 0.327 与参照 0.332 持平，动态范围 62.5 却窄于参照 73.3）。
     所以：饱和度只在偏灰时补（上限 1.25），拉伸倍数 = 73 / 实测范围（封顶
     1.6）；两项都达标就整段跳过。先于聚类执行，后续阶段基于校准后的颜色。
  2. 不透明区向内腐蚀 erode px，用纯内部像素 KMeans 拟合 k 色调色板
     （边缘混色不进训练集，避免光晕自成颜色簇）；
  3. 光晕簇抑制：生图模型爱在主体外圈画一圈彩色光晕/描边（线上 G20 深色
     描边环、G21 粉晕、G23/G26/G30 边缘杂斑、G28 灰晕）。这类簇的特征是
     整簇都贴着背景（平均离背景距离小、贴边占比高、面积占比小），与「恰好
     靠近边缘的正文色」（如黑外套边缘）不同——后者的簇同时覆盖大片内部。
     命中的簇整体用 EDT 从最近的正常簇取色，细节不受影响。
  4. 边界带用距离变换（EDT）继承最近内部像素的 label（无投票污染）；
  5. 自适应检测色块颗粒度 pitch，用 pitch 尺寸窗口做**单轮**众数滤波
     抹平残余纹理（窗口跟随颗粒度，不会吃掉细小特征；透明区保持哨兵值
     255，被 f<255 守卫挡在投票外，不会污染边界）；
  6. 按最终 label 贴回调色板中心色，透明区原样保留。

幂等保护：背景兜底永远执行；平坦度已 ≥ FLAT_SKIP（0.85）时跳过 1-5（一键
重转等场景不重复洗）。环境变量 PERLER_BLOCK_CLEANUP=0 时调用方跳过整个脚本。

诊断埋点（2026-10-29）：每次都会把「光晕候选簇的量测 + 为什么没动手」记进
halo_scan；开关如下（都可选，不开就不落任何东西）：
  PERLER_CLEANUP_JSON=<路径>   写完整诊断 JSON，链路侧据此决定是否留 RAW
  PERLER_CLEANUP_TRACE=<路径>  追加一行 JSONL，长期统计触发率
用法：
  python3 block_cleanup.py <in.png>              # 原地清洗
  python3 block_cleanup.py <in.png> <out.png>    # 清洗到新文件
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, label as nd_label
from sklearn.cluster import KMeans
from skimage.filters.rank import modal
from skimage.morphology import erosion, footprint_rectangle

# 调色板簇数：2026-10-30 由 24 提到 96。理由：24 会把生图画出的 2~3 档硬边明暗
# 全并成一档，观感比参照后端（val-perler）死板得多；实测提 k 不会增加图纸豆色
# （切格受 --max-colors 28 约束：k24→17 色、k48→23、k96→24，参照端自己就是 23），
# 但 k≥256 会在皮肤/衬衫上留下散点杂色，96 是「够细腻 + 够干净」的实测平衡点。
K_DEFAULT = 96
ERODE_DEFAULT = 3     # 边缘腐蚀半径：抗锯齿混色带的典型宽度
WIN_SCALE = 1.0       # 众数滤波窗口 = 颗粒度 pitch × 该系数（调小=多留细节但也多留散点；实测 0.7 与 1.0
                      # 的色数/层次密度完全一致，只是散点从 0.033 涨到 0.040，故保持 1.0）
SENTINEL = 255        # 未填充/透明的 label 哨兵
FLAT_SKIP = 0.85      # 输入平坦度已达标时跳过 1-5（幂等保护）
PITCH_MIN, PITCH_MAX = 5, 32   # 色块颗粒度检测的合理区间（px）

# —— 背景兜底透明化参数 ——
BG_TOL = 42.0         # 与边界中位色的 RGB 欧氏距离容差
BG_BORDER_UNIFORM = 0.55   # 四边至少这么多比例贴近中位色才认为背景均匀
# —— 光晕簇抑制参数 ——
HALO_MEAN_D = 9.0     # 簇内像素到背景的平均距离上限（贴背景才算）
HALO_NEAR = 8         # 「贴背景」的判定距离（须 ≥ 腐蚀半径 3 + 抗锯齿带，否则永远够不着）
HALO_NEAR_FRAC = 0.6  # 簇内贴背景像素（距背景 ≤HALO_NEAR）占比下限
HALO_MAX_FRAC = 0.18  # 簇面积占不透明区比例上限（大簇是正文不是晕）
HALO_LUM_MIN = 6.0    # 光晕须比相邻内部亮这么多（Lab L）；更暗的是合法描边，保留
HALO_SAT_MIN = 0.15   # 或饱和度比相邻内部高这么多（粉/橙荧光晕）
HALO_SCAN_MAX = 8     # 诊断 JSON 里最多记录几个簇（按面积降序，够判调优用）

# —— 诊断埋点（默认全关，环境变量开启）——
# PERLER_CLEANUP_JSON=<path>   写完整诊断 JSON（链路侧据此决定是否留 RAW）
# PERLER_CLEANUP_TRACE=<path>  追加一行 JSONL，长期统计「光晕触发率」
DIAG_TRIM_KEYS = ("ver", "halo_clusters", "halo_pixels", "halo_near", "halo_all_candidates",
                  "islands_removed", "island_pixels", "bg_mode", "bg_ratio", "skipped",
                  "flatness_before", "flatness", "colors", "opaque_ratio",
                  "stretch", "sat_boost", "sat_before", "l_range_before")
# —— 孤立噪点岛参数 ——
ISLAND_MAX_FRAC = 0.0004   # 岛面积上限（占全图比例；1024² 时约 420px ≈ 2 颗豆）
# —— 影调校准参数（v7：目标值来自 2026-10-29 的 8 组同源真实标定） ——
REF_SAT = 0.33        # 参照后端（val-perler）交付图的平均饱和度实测值
REF_L_RANGE = 73.0    # 参照后端交付图的动态范围（L* p5~p95）实测值
TONE_TRIGGER = 0.95   # 实测值低于目标这么多比例才动手（留一点余量，防来回抖）
SAT_MAX_BOOST = 1.25  # 饱和度补齐倍数上限（v6 的无条件 1.12 会让比参照更艳）
STRETCH_LO, STRETCH_HI = 5.0, 95.0   # 动态范围测量百分位（与标定时用的 p5~p95 同口径）
STRETCH_MAX = 1.15        # 拉伸倍数上限：实测 1.25 起会把合成用例里的深色描边判成光晕（见 tools/block_cleanup_合成用例.py）


def flatness_of(rgb: np.ndarray, opaque: np.ndarray) -> float:
    """平坦度 = 相邻同色比例，越高越接近硬边平涂。"""
    sx = (np.diff(rgb[..., 0], axis=1) == 0) & (np.diff(rgb[..., 1], axis=1) == 0) \
        & (np.diff(rgb[..., 2], axis=1) == 0)
    sy = (np.diff(rgb[..., 0], axis=0) == 0) & (np.diff(rgb[..., 1], axis=0) == 0) \
        & (np.diff(rgb[..., 2], axis=0) == 0)
    mx = opaque[:, :-1] & opaque[:, 1:]
    my = opaque[:-1, :] & opaque[1:, :]
    return float((sx[mx].mean() + sy[my].mean()) / 2)


def normalize_background(a: np.ndarray) -> tuple[np.ndarray, dict]:
    """背景兜底透明化（stage 0）：只处理「整图不透明 + 四边均匀」的输出。

    返回 (新 RGBA 数组, 诊断)。已有透明区的输出视为模型自己抠好了，不动；
    四边颜色杂（场景/海报背景）不动。
    """
    info: dict = {"bg_mode": "skip"}
    alpha = a[..., 3]
    opaque = alpha > 128
    if opaque.all():
        info["bg_mode"] = "opaque_input"
    elif (alpha == 0).any():
        info["bg_mode"] = "has_transparent"
        return a, info
    else:
        # 只有半透明抗锯齿、没有真正的透明区：同样视为未抠底
        info["bg_mode"] = "opaque_input"

    h, w = a.shape[:2]
    rgb = a[..., :3].astype(np.float32)
    frame = np.concatenate([rgb[0, :], rgb[-1, :], rgb[:, 0], rgb[:, -1]])
    med = np.median(frame, axis=0)
    dist = np.sqrt(((rgb - med) ** 2).sum(axis=2))
    border_ok = np.concatenate([(dist[0, :] <= BG_TOL), (dist[-1, :] <= BG_TOL),
                                (dist[:, 0] <= BG_TOL), (dist[:, -1] <= BG_TOL)])
    if border_ok.mean() < BG_BORDER_UNIFORM:
        info["bg_mode"] = "border_varied"
        return a, info

    cand = dist <= BG_TOL
    lab, n = nd_label(cand)
    touching = set(np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])))
    touching.discard(0)
    if not touching:
        info["bg_mode"] = "no_border_component"
        return a, info
    bg = np.isin(lab, list(touching))
    ratio = float(bg.mean())
    if ratio < 0.01 or ratio > 0.97:
        info["bg_mode"] = "coverage_out_of_range"
        return a, info
    out = a.copy()
    out[..., 3][bg] = 0
    info.update(bg_mode="cut", bg_ratio=round(ratio, 3),
                bg_color=[int(c) for c in med])
    return out, info


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


def remove_islands(a: np.ndarray) -> tuple[np.ndarray, dict]:
    """孤立噪点岛清除：与主体不相连的小片不透明噪块（生图背景残留、飞点）置透明。

    只删明显小于主体的小岛（ISLAND_MAX_FRAC），迷你贴纸等画风里的小贴纸
    远大于该阈值，不受影响。
    """
    info: dict = {"islands_removed": 0}
    opaque = a[..., 3] > 128
    lab, n = nd_label(opaque)
    if n <= 1:
        return a, info
    sizes = np.bincount(lab.ravel())
    main = int(np.argmax(sizes[1:]) + 1)
    max_area = max(120, int(ISLAND_MAX_FRAC * a.shape[0] * a.shape[1]))
    small = [i for i in range(1, n + 1) if i != main and sizes[i] < max_area]
    if not small:
        return a, info
    mask = np.isin(lab, small)
    out = a.copy()
    out[..., 3][mask] = 0
    info["islands_removed"] = len(small)
    info["island_pixels"] = int(mask.sum())
    return out, info


def suppress_halo(lab: np.ndarray, inner: np.ndarray, opaque: np.ndarray,
                  rgb: np.ndarray, k: int) -> tuple[np.ndarray, dict]:
    """光晕簇抑制：识别整簇贴着背景的亮色/高饱和光晕，EDT 从正常簇取色。

    几何条件（整簇贴背景）+ 颜色条件（比相邻内部更亮或更饱和）。比内部
    更暗的贴边簇是合法描边（像素画常规风格），保留不动。

    每个候选簇都留一份量测（halo_scan，按面积降序留前 HALO_SCAN_MAX 个），
    连同「为什么没动手」的原因一起写进诊断：v6/v7 判据在真实数据上很保守
    （厚环不触发），只有拿到这些近候选数据才能安全地把判据放开。
    """
    info: dict = {"halo_clusters": 0}
    if not opaque.any():
        return lab, info
    d_bg = distance_transform_edt(opaque)   # 每个不透明像素到最近背景/边界的距离
    total = max(float(opaque.sum()), 1.0)
    cand = np.zeros(k, bool)
    scan: list[dict] = []
    for c in range(k):
        m = inner & (lab == c)
        n = int(m.sum())
        if n < 16:                       # 连记录价值都没有的碎簇
            continue
        frac = n / total
        mean_d = float(d_bg[m].mean())
        near_frac = float((d_bg[m] <= HALO_NEAR).mean())
        rec = {"cluster": int(c), "px": n, "frac": round(frac, 4),
               "mean_d": round(mean_d, 2), "near_frac": round(near_frac, 3)}
        if n < 30:
            rec["skip"] = "too_small"
        elif frac > HALO_MAX_FRAC:
            rec["skip"] = "too_big"      # 正文色（如整片外套），不是晕
        else:
            rec["geometry"] = bool(mean_d <= HALO_MEAN_D and near_frac >= HALO_NEAR_FRAC)
            if rec["geometry"]:
                cand[c] = True
            elif mean_d <= HALO_MEAN_D * 2 and near_frac >= HALO_NEAR_FRAC * 0.5:
                rec["near"] = True   # 判据放宽一点点就该命中：调参时优先看这批数据
        scan.append(rec)
    # 诊断清单按「与判据的相关性」排：命中/近候选在前，其余按面积降序
    scan.sort(key=lambda r: (0 if (r.get("geometry") or r.get("near")) else 1, -r["px"]))
    info["halo_scan"] = scan[:HALO_SCAN_MAX]
    if not cand.any() or bool(cand.all()):
        if cand.any():                   # 全簇都贴边：多半是整体小图，动手会全图重涂
            info["halo_all_candidates"] = True
        else:
            info["halo_near"] = sum(1 for r in scan if r.get("near"))
        return lab, info
    halo_px = inner & np.isin(lab, np.where(cand)[0])
    keep = inner & ~np.isin(lab, np.where(cand)[0])
    if keep.sum() < 30 or not halo_px.any():
        return lab, info
    # 颜色条件：与最近正常簇比较亮度/饱和度，更暗更灰的簇是合法描边，不杀
    _, (iy, ix) = distance_transform_edt(~keep, return_indices=True)
    nb_rgb = rgb[iy[halo_px], ix[halo_px]]
    halo_rgb = rgb[halo_px]
    lum_h = halo_rgb.mean(axis=1)
    lum_n = nb_rgb.mean(axis=1)
    sat_h = (halo_rgb.max(axis=1) - halo_rgb.min(axis=1)) / np.maximum(halo_rgb.max(axis=1), 1)
    sat_n = (nb_rgb.max(axis=1) - nb_rgb.min(axis=1)) / np.maximum(nb_rgb.max(axis=1), 1)
    glow = (lum_h > lum_n + HALO_LUM_MIN) | (sat_h > sat_n + HALO_SAT_MIN)
    # 每个候选簇单独的「像不像光晕」占比（诊断用，决定是否动手仍按全局口径）
    cls = lab[halo_px]
    cnt = np.bincount(cls, minlength=k).astype(float)
    with np.errstate(invalid="ignore", divide="ignore"):
        g_frac = np.where(cnt > 0, np.bincount(cls, weights=glow.astype(float), minlength=k) / np.maximum(cnt, 1), 0.0)
        d_lum = np.where(cnt > 0, np.bincount(cls, weights=(lum_h - lum_n), minlength=k) / np.maximum(cnt, 1), 0.0)
        d_sat = np.where(cnt > 0, np.bincount(cls, weights=(sat_h - sat_n), minlength=k) / np.maximum(cnt, 1), 0.0)
    def _audit() -> None:
        """把每个候选簇的实际量测贴回诊断清单（后续两处都会调用）。"""
        for rec in info["halo_scan"]:
            c = rec["cluster"]
            if cand[c]:
                rec.update(glow_frac=round(float(g_frac[c]), 3),
                           mean_dL=round(float(d_lum[c]), 2),
                           mean_dS=round(float(d_sat[c]), 3))
    if glow.mean() < 0.6:   # 该候选簇大半像素不像光晕：整簇保留
        _audit()
        for rec in info["halo_scan"]:
            if cand[rec["cluster"]]:
                rec["skip"] = "color"   # 不够亮也不够艳：是描边/暗边，不是光晕
        info["halo_near"] = int(cand.sum())
        return lab, info
    fixed = lab.copy()
    fixed[halo_px] = lab[iy[halo_px], ix[halo_px]]
    _audit()
    for rec in info["halo_scan"]:
        if cand[rec["cluster"]]:
            rec["hit"] = True
    info["halo_clusters"] = int(cand.sum())
    info["halo_pixels"] = int(halo_px.sum())
    return fixed, info


def _lab_lightness(rgb01: np.ndarray) -> np.ndarray:
    """sRGB(0~1) → CIE L*（只要 L，用来判断动态范围）。"""
    c = np.where(rgb01 <= 0.04045, rgb01 / 12.92, ((rgb01 + 0.055) / 1.055) ** 2.4)
    y = c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722
    eps, kappa = 216 / 24389, 24389 / 27
    f = np.where(y > eps, np.cbrt(y), (kappa * y + 16) / 116)
    return 116 * f - 16


def enhance_tone(rgb: np.ndarray, opaque: np.ndarray) -> tuple[np.ndarray, dict]:
    """影调校准（v7）：把动态范围与饱和度补齐到「参照后端的实测带」，不再无条件提亮。

    v6 是无条件 ×SAT_BOOST(1.12) + 分位拉伸。2026-10-29 用 8 组同源真实数据
    （同一张原图分别过我方链路与参照后端 val-perler）标定：
      · 我方生图原始输出饱和度均值 0.327，参照后端 0.332 —— 本就持平，
        再乘 1.12 会跑到 0.406（比参照更艳），且生成图主色偏离原图约 29%；
      · 我方原始输出动态范围（L* p5~p95）62.5，参照后端 73.3 —— 确实偏窄，
        这部分该补。
    于是改成「按目标补齐」：拉伸倍数 = 目标范围 / 实测范围（封顶 STRETCH_MAX），
    饱和度只在低于目标时补（封顶 SAT_MAX_BOOST）；两项都达标就整段跳过。

    rgb 为 float32 [0,255]；返回（可能新建的）数组与诊断。
    """
    info: dict = {"enhanced": False}
    px = rgb[opaque]
    mx = px.max(axis=1)
    mn = px.min(axis=1)
    sat = np.divide(mx - mn, np.maximum(mx, 1.0),
                    out=np.zeros_like(mx), where=mx > 0)
    cur_sat = float(sat.mean())
    lum = _lab_lightness(px / 255.0)
    cur_range = float(np.percentile(lum, STRETCH_HI) - np.percentile(lum, STRETCH_LO))

    scale = 1.0
    if cur_range < REF_L_RANGE * TONE_TRIGGER:
        scale = min(REF_L_RANGE / max(cur_range, 1.0), STRETCH_MAX)
    boost = 1.0
    if cur_sat < REF_SAT * TONE_TRIGGER:
        boost = min(REF_SAT / max(cur_sat, 1e-3), SAT_MAX_BOOST)
    if scale <= 1.0 + 1e-3 and boost <= 1.0 + 1e-3:
        info.update(stretch=1.0, sat_boost=1.0, sat_before=round(cur_sat, 3),
                    l_range_before=round(cur_range, 1))
        return rgb, info

    out = rgb.copy()
    if scale > 1.0:
        # 围绕分区均值做线性对比扩张（不用分位做偏移，避免暗部一片压到 0）
        center = px.mean(axis=0).astype(np.float32)
        out[opaque] = np.clip(center + (out[opaque] - center) * scale, 0, 255)
    if boost > 1.0:
        sel = out[opaque]
        mid = sel.mean(axis=1, keepdims=True)
        out[opaque] = np.clip(mid + (sel - mid) * boost, 0, 255)
    info.update(enhanced=True, stretch=round(float(scale), 3),
                sat_boost=round(float(boost), 3), sat_before=round(cur_sat, 3),
                l_range_before=round(cur_range, 1))
    return out, info

def emit_diagnostics(info: dict) -> None:
    """诊断落盘（默认不落任何东西，环境变量开启）：

    PERLER_CLEANUP_JSON=<path>    写完整 JSON，链路侧据此决定是否留 RAW
    PERLER_CLEANUP_TRACE=<path>   追加一行 JSONL，长期统计「光晕触发率」

    写失败只打一行提示，绝不影响出图。
    """
    jpath = os.environ.get("PERLER_CLEANUP_JSON")
    if jpath:
        try:
            Path(jpath).write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
        except Exception as e:      # noqa: BLE001 - 诊断失败不许中断链路
            print(f"[色块规整] 诊断写盘失败：{e}", flush=True)
    tpath = os.environ.get("PERLER_CLEANUP_TRACE")
    if tpath:
        try:
            line = {"ts": datetime.now(timezone.utc).isoformat(),
                    **{k: info.get(k) for k in DIAG_TRIM_KEYS if k in info}}
            with open(tpath, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(line, ensure_ascii=False) + "\n")
        except Exception as e:      # noqa: BLE001
            print(f"[色块规整] 追踪日志写入失败：{e}", flush=True)


def clean_image(src: Path, dst: Path, k: int = K_DEFAULT, erode: int = ERODE_DEFAULT,
                win_scale: float = WIN_SCALE) -> dict:
    """清洗一张底稿，返回统计信息（供运行记录），并顺带落诊断。"""
    try:
        info = _clean_image(src, dst, k, erode, win_scale)
        emit_diagnostics(info)
        return info
    except Exception as e:          # noqa: BLE001 - 诊断侧：原样抛出，但先留个记录
        emit_diagnostics({"error": f"{type(e).__name__}: {e}", "src": str(src)})
        raise


def _clean_image(src: Path, dst: Path, k: int = K_DEFAULT, erode: int = ERODE_DEFAULT,
                 win_scale: float = WIN_SCALE) -> dict:
    a = np.asarray(Image.open(src).convert("RGBA"))
    info: dict = {"ver": 7, "size": [a.shape[1], a.shape[0]]}

    # 0) 背景兜底透明化（在幂等跳过之前：干净图也可能带不透明背景）
    a, bg_info = normalize_background(a)
    bg_cut = bg_info.get("bg_mode") == "cut"
    # 0.5) 孤立噪点岛清除（生图残留的飞点、背景噪块）
    a, island_info = remove_islands(a)
    if island_info.get("islands_removed"):
        bg_cut = True   # 有改动就需要落盘
    info.update(bg_info)
    info.update(island_info)

    h, w = a.shape[:2]
    opaque = a[..., 3] > 128
    info["opaque_ratio"] = round(float(opaque.mean()), 3)
    if not opaque.any():                       # 全透明：无话可洗
        if bg_cut:
            Image.fromarray(a).save(dst)
        info["skipped"] = "全透明"
        return info

    rgb0 = a[..., :3].astype(np.int32)
    info["flatness_before"] = round(flatness_of(rgb0, opaque), 3)
    if info["flatness_before"] >= FLAT_SKIP:   # 已经够干净：不洗（幂等）
        if src != dst or bg_cut:
            Image.fromarray(a).save(dst)
        info["skipped"] = "已达标"
        return info

    rgb = a[..., :3].astype(np.float32)

    # 1) 影调增强（先于聚类：KMeans/label/众数滤波全部基于增强后的颜色）
    rgb, enh_info = enhance_tone(rgb, opaque)
    info.update(enh_info)

    inner = erosion(opaque, footprint_rectangle((erode * 2 + 1, erode * 2 + 1)))
    if inner.sum() < k:                        # 图太小：不值得聚类，原样保存
        Image.fromarray(a).save(dst)
        info["skipped"] = "不透明区过小"
        return info

    # 2) 内部像素拟合调色板
    km = KMeans(n_clusters=k, n_init=4, random_state=42).fit(
        rgb[inner][::max(1, int(inner.sum()) // 20000)])
    lab = np.full((h, w), SENTINEL, np.uint8)
    lab[inner] = km.predict(rgb[inner])

    # 3) 光晕簇抑制：整簇贴背景的亮色/高饱和光晕从正常簇取色（合法深色描边保留）
    lab, halo_info = suppress_halo(lab, inner, opaque, rgb, k)
    info.update(halo_info)

    # 4) 边界带：EDT 最近邻继承（零点集只含已填充像素，透明区不会串色）
    unfilled = opaque & (lab == SENTINEL)
    if unfilled.any():
        _, (iy, ix) = distance_transform_edt(lab == SENTINEL, return_indices=True)
        lab[unfilled] = lab[iy[unfilled], ix[unfilled]]

    # 5) 自适应窗口单轮众数滤波（窗口跟随颗粒度 × win_scale，细小特征不被吃掉）
    pitch = detect_pitch(lab, opaque)
    win = max(3, int(round(pitch * win_scale)))
    if win % 2 == 0:
        win += 1
    f = modal(lab, footprint_rectangle((win, win)))
    cur = lab.copy()
    o = opaque & (f < SENTINEL)
    cur[o] = f[o]

    # 6) 贴回调色板中心色
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
    parts = [f"平坦度 {info.get('flatness_before', '?')} → {info.get('flatness', '?')}",
             f"颜色数 {info.get('colors', '?')}", f"颗粒度 ~{info.get('pitch', '?')}px"]
    if info.get("bg_mode") == "cut":
        parts.append(f"背景已抠（{info['bg_ratio']:.0%}）")
    if info.get("islands_removed"):
        parts.append(f"噪点岛 {info['islands_removed']} 片已清")
    if info.get("halo_clusters"):
        parts.append(f"光晕簇 {info['halo_clusters']} 个/{info.get('halo_pixels', 0)}px 已清")
    else:
        # 未触发也报个数：哪天真出光晕，靠这行能算出触发率和近候选量
        near = info.get("halo_near", 0)
        parts.append(f"光晕 0 簇（近候选 {near}）")
    if info.get("enhanced"):
        parts.append(f"影调增强 ×{info.get('stretch', 1)}")
    if "skipped" in info:
        print(f"[色块规整] 跳过 1-5（{info['skipped']}）；背景：{info.get('bg_mode', '-')}"
              f"；光晕 0 簇（近候选 {info.get('halo_near', 0)}）")
        return
    print("[色块规整] " + "，".join(parts))


if __name__ == "__main__":
    main(sys.argv[1:])
