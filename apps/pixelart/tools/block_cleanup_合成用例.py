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
