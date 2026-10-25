#!/usr/bin/env python3
"""无畏契约拼豆图纸随机抽签：抽一个英雄。

权重表在 assets/hero_weights.json：每位英雄一个 1-9 的整数，脚本相加后归一化为抽中
概率；调整直接改 JSON 数值。英雄名用国服官方名，与素材接口一致，抽中后可以直接取图。
画风不在这里抽，由专家按英雄的造型挑选。

用法：
  python3 random_draw.py            # 抽一个英雄
  python3 random_draw.py --seed 42  # 复现某次结果
"""

import argparse
import json
import random
import sys
from pathlib import Path

HERO_WEIGHTS = Path(__file__).resolve().parent.parent / "assets" / "hero_weights.json"


def load_weights():
    data = json.loads(HERO_WEIGHTS.read_text(encoding="utf-8"))
    weights = data["weights"]
    if any(not isinstance(w, int) or w < 1 for w in weights.values()):
        raise SystemExit("权重表异常：权重应为 1-9 的整数。请检查 hero_weights.json")
    return data, weights


def draw(seed=None):
    data, weights = load_weights()
    hero = random.Random(seed).choices(list(weights), weights=list(weights.values()), k=1)[0]
    return {"hero": hero, "version": data["version"]}


def main():
    ap = argparse.ArgumentParser(description="随机抽一个无畏契约英雄")
    ap.add_argument("--seed", type=int, help="随机种子，用于复现结果")
    args = ap.parse_args()
    print(json.dumps(draw(args.seed), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
