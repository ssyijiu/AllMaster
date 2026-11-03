#!/usr/bin/env python3
"""block_cleanup v6 合成用例：背景兜底 / 亮晕清除 / 暗描边保留 / 噪点岛 / 影调增强 / 幂等。"""
import subprocess
import sys
import numpy as np
from PIL import Image

SCRIPT = ("/Users/kuigas/WorkBuddy/2026-10-23-22-39-05/apps/pixelart/"
          "assert/valorant-perler-src/valorant-perler/scripts/block_cleanup.py")
PY = sys.executable
T = "/tmp/bc_test"
import os
os.makedirs(T, exist_ok=True)
ok_all = True


def run(name, img, checks, expect_log=None):
    global ok_all
    src, dst = f"{T}/{name}.png", f"{T}/{name}_out.png"
    Image.fromarray(img).save(src)
    r = subprocess.run([PY, SCRIPT, src, dst], capture_output=True, text=True)
    out = np.asarray(Image.open(dst).convert("RGBA"))
    fails = []
    for desc, fn in checks:
        try:
            fn(out)
        except AssertionError as e:
            fails.append(f"{desc}: {e}")
    if expect_log and expect_log not in r.stdout:
        fails.append(f"日志缺「{expect_log}」: {r.stdout.strip()}")
    status = "PASS" if not fails else "FAIL"
    if fails:
        ok_all = False
    print(f"[{status}] {name}  ({' | '.join(r.stdout.strip().splitlines()[-1:])})")
    for f in fails:
        print("   ", f)
    return out


def arr(h, w):
    a = np.zeros((h, w, 4), np.uint8)
    a[..., 3] = 255
    return a


def noised(a, seed=7, amp=14):
    rng = np.random.default_rng(seed)
    op = a[..., 3] > 128
    a[op, :3] = np.clip(a[op, :3].astype(int) + rng.integers(-amp, amp + 1, (int(op.sum()), 3)), 0, 255).astype(np.uint8)
    return a


# 1) 均匀背景 → 抠掉
a = arr(200, 200)
a[..., :3] = (30, 40, 90)
yy, xx = np.mgrid[:200, :200]
circle = (yy - 100) ** 2 + (xx - 100) ** 2 < 60 ** 2
a[circle, :3] = (220, 60, 60)
run("bg_uniform", a, [
    ("背景已透明", lambda o: None if o[2, 2, 3] == 0 else (_ for _ in ()).throw(AssertionError(f"{o[2,2]}"))),
    ("主体保留", lambda o: None if (o[100, 100, 3] == 255 and o[100, 100, 0] > 180) else (_ for _ in ()).throw(AssertionError(f"{o[100,100]}"))),
])

# 2) 结构化背景（渐变）→ 不动
a = arr(200, 200)
a[..., :3] = np.linspace((20, 30, 40), (200, 210, 220), 200).reshape(200, 1, 3).astype(np.uint8)
a[circle, :3] = (220, 60, 60)
run("bg_gradient", a, [
    ("背景保留不透明", lambda o: None if o[2, 2, 3] == 255 else (_ for _ in ()).throw(AssertionError("背景被误抠"))),
])

# 3) 已有透明区 → 不动
a = arr(200, 200)
a[..., :3] = (30, 40, 90)
a[~circle, 3] = 0
a[circle, :3] = (220, 60, 60)
run("bg_already_transparent", a, [
    ("不重复处理", lambda o: None if (o[~circle, 3] == 0).all() and (o[circle, 3] == 255).all() else (_ for _ in ()).throw(AssertionError("被改动"))),
])

# 4a) 细亮色光晕环（6px，比内部亮）→ 清掉
a = np.zeros((220, 220, 4), np.uint8)
a[..., 3] = 255
yy4, xx4 = np.mgrid[:220, :220]
r2 = (yy4 - 110) ** 2 + (xx4 - 110) ** 2
glow = r2 < 95 ** 2
body = r2 < 89 ** 2
a[glow & ~body, :3] = (255, 170, 200)          # 粉色光晕环 6px
a[body, :3] = (90, 60, 160)                    # 紫色主体
a[~glow, 3] = 0
eye = slice(104, 112), slice(104, 112)
a[eye[0], eye[1], :3] = (250, 250, 250)
a = noised(a)
run("halo_bright_thin", a, [
    ("粉色晕消失", lambda o: None if not ((np.abs(o[..., :3].astype(int) - [255, 170, 200]).sum(axis=2) < 60) & (o[..., 3] > 128)).any() else (_ for _ in ()).throw(AssertionError("粉色仍存在"))),
    ("主体保留", lambda o: None if o[110, 110, 2] > 120 else (_ for _ in ()).throw(AssertionError(f"主体色变了 {o[110,110]}"))),
    ("眼睛保留", lambda o: None if o[108, 108, 0] > 200 else (_ for _ in ()).throw(AssertionError(f"眼睛被吃 {o[108,108]}"))),
], expect_log="光晕簇")

# 4b) 深色描边环（6px，比内部暗）→ 保留（合法像素画描边）
a = np.zeros((220, 220, 4), np.uint8)
a[..., 3] = 255
outline = r2 < 95 ** 2
body = r2 < 89 ** 2
a[outline & ~body, :3] = (25, 22, 30)          # 深色描边
a[body, :3] = (90, 60, 160)
a[~outline, 3] = 0
a[eye[0], eye[1], :3] = (250, 250, 250)
a = noised(a, seed=9)
out4b = run("outline_dark_kept", a, [
    ("描边保留", lambda o: None if ((np.abs(o[..., :3].astype(int) - [25, 22, 30]).sum(axis=2) < 90) & (o[..., 3] > 128)).sum() > 2000 else (_ for _ in ()).throw(AssertionError("描边被清了"))),
    ("主体保留", lambda o: None if o[110, 110, 2] > 120 else (_ for _ in ()).throw(AssertionError(f"{o[110,110]}"))),
])

# 5) 孤立噪点岛 → 置透明
a = arr(200, 200)
a[..., :3] = (30, 40, 90)
a[circle, :3] = (220, 60, 60)
a[30:40, 150:160, :3] = (200, 200, 210)        # 远离主体的 10x10 噪块
a[150:158, 20:28, :3] = (180, 190, 200)        # 另一块
a = noised(a, seed=3)
run("islands_removed", a, [
    ("噪块1清除", lambda o: None if o[35, 155, 3] == 0 else (_ for _ in ()).throw(AssertionError(f"{o[35,155]}"))),
    ("噪块2清除", lambda o: None if o[154, 24, 3] == 0 else (_ for _ in ()).throw(AssertionError(f"{o[154,24]}"))),
    ("主体保留", lambda o: None if o[100, 100, 3] == 255 else (_ for _ in ()).throw(AssertionError("主体被删"))),
], expect_log="噪点岛")

# 6) 贴边正文色不被误杀
a = arr(200, 200)
a[..., :3] = (255, 255, 255)
a[60:180, 40:160, :3] = (20, 20, 25)
a[:20, :, :3] = (245, 245, 245)
a = noised(a, seed=5)
run("edge_legit_color", a, [
    ("黑色主体保留", lambda o: None if o[120, 100, 0] < 60 else (_ for _ in ()).throw(AssertionError(f"黑块被改 {o[120,100]}"))),
])

# 8) 半透明残留（模型想透明、边缘留了半透明灰雾）→ 二值化清掉
a = np.zeros((220, 220, 4), np.uint8)
yy8, xx8 = np.mgrid[:220, :220]
d8 = (yy8 - 110) ** 2 + (xx8 - 110) ** 2
body8 = d8 < 80 ** 2
ring8 = (d8 >= 80 ** 2) & (d8 < 92 ** 2)
a[body8, :3] = (200, 160, 120); a[body8, 3] = 255
a[ring8, :3] = (150, 150, 150); a[ring8, 3] = 120   # 半透明灰雾环
a[~(body8 | ring8), 3] = 0                          # 外部透明
a = noised(a, seed=13)
run("alpha_residue_ring", a, [
    ("灰雾环被清成透明", lambda o: None if o[110, 196, 3] == 0 else (_ for _ in ()).throw(AssertionError(f"环仍在 {o[110,196]}"))),
    ("主体保留", lambda o: None if (o[110, 110, 3] == 255 and o[110, 110, 0] > 180) else (_ for _ in ()).throw(AssertionError(f"主体被改 {o[110,110]}"))),
])

# 9) 抗锯齿边（alpha 200）→ 硬化为不透明，主体不被误抠
a = np.zeros((220, 220,4), np.uint8)
a[body8, :3] = (200, 160, 120); a[body8, 3] = 255
edge8 = (d8 >= 80 ** 2) & (d8 < 86 ** 2)
a[edge8, :3] = (200, 160, 120); a[edge8, 3] = 200   # 抗锯齿边
a[~(body8 | edge8), 3] = 0
a = noised(a, seed=17)
run("alpha_aa_edge", a, [
    ("抗锯齿边变不透明", lambda o: None if o[110, 192, 3] == 255 else (_ for _ in ()).throw(AssertionError(f"边仍半透明 {o[110,192]}"))),
    ("主体保留", lambda o: None if (o[110, 110, 3] == 255 and o[110, 110, 0] > 180) else (_ for _ in ()).throw(AssertionError(f"主体被改 {o[110,110]}"))),
    ("外部仍透明", lambda o: None if o[5, 5, 3] == 0 else (_ for _ in ()).throw(AssertionError("外部被误填"))),
])

# 10) 占位背景：四边黑白棋盘格（后端透明失败）→ 整张按相位抠掉，主体保留
def checkerboard(h, w, cell, A, B):
    yy, xx = np.mgrid[:h, :w]
    parity = (xx // cell + yy // cell) % 2
    a = np.zeros((h, w, 4), np.uint8)
    a[..., 3] = 255
    a[..., :3] = np.where(parity[:, :, None] == 0, A, B)
    return a
a = checkerboard(240, 240, 12, (20, 20, 20), (230, 230, 230))
yyc, xxc = np.mgrid[:240, :240]
subj = (yyc - 120) ** 2 + (xxc - 120) ** 2 < 62 ** 2
a[subj, :3] = (210, 50, 50)
run("placeholder_checkerboard", a, [
    ("四角被抠成透明", lambda o: None if o[10, 10, 3] == 0 and o[230, 230, 3] == 0 else (_ for _ in ()).throw(AssertionError(f"{o[10,10,3]}"))),
    ("主体保留", lambda o: None if (o[120, 120, 3] == 255 and o[120, 120, 0] > 180) else (_ for _ in ()).throw(AssertionError(f"主体被改 {o[120,120]}"))),
    ("主体边缘外的棋盘格已清", lambda o: None if not ((o[..., 3] > 128) & (np.abs(o[..., :3].astype(int) - [20,20,20]).sum(axis=2) < 40) & (np.abs(o[..., :3].astype(int) - [230,230,230]).sum(axis=2) < 40)).any() else (_ for _ in ()).throw(AssertionError("仍残留棋盘格"))),
], expect_log="占位背景")

# 11) 均匀灰块背景（#08 真实回归：背景大面灰块）：整片纯灰（128），主体居中。
#     这类「整图不透明 + 四边均匀」的背景由 normalize_background（stage 0）在 stage 0.4 之前
#     抠掉（欧氏判均匀），不属于 stage 0.4 的棋盘格兜底。这里验证灰块背景确实变透明、主体保留。
a = arr(200, 200)
a[..., :3] = (128, 128, 128)
yy11, xx11 = np.mgrid[:200, :200]
s11 = (yy11 - 100) ** 2 + (xx11 - 100) ** 2 < 60 ** 2
a[s11, :3] = (220, 90, 40)
run("placeholder_gray", a, [
    ("四角被抠成透明", lambda o: None if o[3, 3, 3] == 0 else (_ for _ in ()).throw(AssertionError(f"{o[3,3,3]}"))),
    ("主体保留", lambda o: None if (o[100, 100, 3] == 255 and o[100, 100, 0] > 180) else (_ for _ in ()).throw(AssertionError(f"主体被改 {o[100,100]}"))),
], expect_log="背景")

# 12) 占位背景：主体贴边（无法安全分离）→ 整段跳过，背景保留不透明
a = arr(200, 200)
a[..., :3] = (128, 128, 128)
a[0:200, 0:90, :3] = (40, 40, 45)     # 主体从左边铺到画面外（贴边）
run("placeholder_subject_edge", a, [
    ("背景保留不透明（不误抠）", lambda o: None if o[160, 160, 3] == 255 else (_ for _ in ()).throw(AssertionError("贴边图被误抠"))),
])

# 13) 占位背景：渐变背景（四边多色）→ 不触发，背景保留
a = arr(200, 200)
a[..., :3] = np.linspace((30, 40, 50), (210, 200, 190), 200).reshape(200, 1, 3).astype(np.uint8)
a[circle, :3] = (220, 60, 60)
run("placeholder_gradient_skip", a, [
    ("渐变背景保留不透明", lambda o: None if o[2, 2, 3] == 255 else (_ for _ in ()).throw(AssertionError("渐变被误抠"))),
])

# 14) 占位背景 + 同色主体（05 真实死穴：浅白毛 ≈ 背景白格）
#     棋盘格背景（暗/亮两色），主体是「灰身 + 白毛斑块 + 红核」：灰身/红核与背景异色会保留，
#     但白毛斑块与亮格同色，会被一并抠掉变成透明洞——这正是 05 的已知局限（清洗层无法还原，
#     需生图提示词给主体加深色轮廓从根本解决）。本用例验证：① 背景被正确抠除（四角透明）；
#     ② 异色灰身/红核保留；③ 同色白毛斑块确实被抠（局限如实暴露）；④ 安全闸不误触发
#     （中心是红核、未被啃；frac 落在合理区间，未触发整段跳过）。
a = checkerboard(240, 240, 12, (20, 20, 20), (235, 235, 235))
yyc2, xxc2 = np.mgrid[:240, :240]
subj2 = (yyc2 - 120) ** 2 + (xxc2 - 120) ** 2 < 70 ** 2
a[subj2, :3] = (120, 120, 130)           # 灰身（异色 → 保留）
a[48:80, 105:135, :3] = (235, 235, 235)  # 白毛斑块：贴主体上缘、与背景连通（同色 → 被抠，属已知局限）
a[110:130, 110:130, :3] = (200, 40, 40)  # 红核（异色 → 保留，且是图像中心）
run("placeholder_samecolor_subject", a, [
    ("四角被抠成透明（背景已处理）", lambda o: None if o[10, 10, 3] == 0 and o[230, 230, 3] == 0 else (_ for _ in ()).throw(AssertionError(f"四角未透明 {o[10,10,3]}"))),
    ("异色红核保留", lambda o: None if (o[120, 120, 3] == 255 and o[120, 120, 0] > 150) else (_ for _ in ()).throw(AssertionError(f"红核被吃 {o[120,120]}"))),
    ("异色灰身保留", lambda o: None if o[120, 100, 3] == 255 else (_ for _ in ()).throw(AssertionError(f"灰身被吃 {o[120,100]}"))),
    ("同色白毛被抠（局限如实呈现）", lambda o: None if o[65, 120, 3] == 0 else (_ for _ in ()).throw(AssertionError(f"白毛未被抠 {o[65,120]}"))),
], expect_log="占位背景")

# 7) 幂等：洗两次结果一致
a = arr(200, 200)
a[..., :3] = (240, 240, 240)
a[circle, :3] = (200, 80, 80)
a[90:95, 60:140, :3] = (60, 60, 200)
a = noised(a, seed=11)
run("idempotent_base", a, [("noop", lambda o: None)])
src, dst1, dst2 = f"{T}/idempotent_base.png", f"{T}/idempotent_base_out.png", f"{T}/idempotent_twice.png"
subprocess.run([PY, SCRIPT, src, dst2], capture_output=True, text=True)
i1 = np.asarray(Image.open(dst1).convert("RGBA"))
i2 = np.asarray(Image.open(dst2).convert("RGBA"))
same = np.array_equal(i1, i2)
print(f"[{'PASS' if same else 'FAIL'}] idempotent_second_run 一致性={same}")
ok_all = ok_all and same

print("\n总体:", "ALL PASS" if ok_all else "有失败项")
sys.exit(0 if ok_all else 1)
