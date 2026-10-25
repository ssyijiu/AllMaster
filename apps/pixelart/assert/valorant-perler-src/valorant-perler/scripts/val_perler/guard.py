#!/usr/bin/env python3
"""出口门禁：检查要发给玩家的文本里有没有泄露内部用语（知识库/叶子/节点/路径名/命令/置信度…）。

用法：
  python3 scripts/val_perler.py search guard --file draft.txt      # 或 --text "..." 或 stdin
  退出码 0=通过；2=不通过（stdout 为 JSON：ok/hits/rewrite）
由知识检索 CLI 的 search guard 子命令调用。
"""
import argparse
import json
import re
import sys

LEAVES = r"外观|[123]技能|终结技能|被动|人物关系|玩法与定位|背景故事与设定|变更历史|概览|参赛队伍与阵容|赛程与赛果|数据与复盘"

# (类别, 正则)。注意：「外观、技能、人物关系、背景故事」是玩家能理解的词，不禁；禁的是内部结构用语。
NUM = r"[\d一二三四五六七八九十两]+"
IMG = r"(?!.{0,12}(图|头像|立绘|照片|素材|参考|小红书|抖音|B站|b站|视频|色|豆))"  # 找参考图是正常话术，不拦
RULES = [
    ("结构用语", r"叶子|节点|知识路径|快照|标签|摘要|文档|词条|条目|索引"),
    ("资料来源", r"(?!(?<=存在|存进|放进|放在|存到|放到)资料库|(?<=存在你的|存进你的|放进你的|放在你的|存到你的|放到你的)资料库)(?:知识库|资料库|数据库|资料|检索|召回|入库|出库|查库|库里|库内|库中|内部|后台|系统里|系统中|系统记录|"
                r"我们的(库|知识|数据)|联网(查证|查资料|查询|搜资料|搜索资料)|去网上(查|搜)(了|一下)?(资料|知识))"),
    # 交付话术「存进（你的）资料库」指 WorkBuddy 资料库，放行；「查了资料库」类仍拦
    # 「在网上搜到/查了」是要求说出的来源标注，放行；没找到类仍拦
    ("检索过程", rf"(没查到|查不到|没找到|没有找到|未找到|找不到){IMG}|(?<!网上)(?<!联网)(查到|查了|查过|搜了|搜到|搜过|翻了|翻到){IMG}|"
                r"置信度|命中(了)?(第|前)?"+NUM+r"(篇|条|个结果)|返回了"+NUM+r"|(读|看)了"+NUM+r"篇|"+NUM+r"篇|"
                rf"[英雄特工]\w{{0,4}}有{NUM}个?(页面|条|篇)|一共有{NUM}个?(页面|结果|条目)"),
    ("内部英文", r"(?i)\b(leaf|leaves|node|nodes|query|queries|snapshot|labels?|filter|gamedb|val-perler|kb-ingest-search|"
                r"manifest|embedding|confidence|skills?|list|mcp|rag|api|top\s?-?\d+)\b"),
    ("内部标识", r"(?i)\bids?\b|\bdoc_?ids?\b|conf\s*[=:：]\s*0?\.\d+|--platform"),
    ("命令参数", r"search\s+(query|list|get)|--(filter|part|leaf|match|offset)\b"),
    ("路径名", rf"[\u4e00-\u9fa5A-Za-z\-]+/[^\s/，。,]+/(?:{LEAVES})|gamedb-[^\s，。,]+|mb[-_][^\s，。,]+|英雄-[^\s，。,]+-(?:{LEAVES})"),
]


def _foreign_pattern():
    """国服环境：回复里不能出现英文名、港服译名、非官方称呼。名单来自 aliases.json（没有就不查这一类）。"""
    import json
    import pathlib
    try:
        A = json.loads((pathlib.Path(__file__).resolve().parent / "aliases.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    names = [n for ns in A.get("foreign", {}).values() for n in ns] + A.get("non_official", [])
    if not names:
        return None
    # 英文名出现在路径、文件名、标识符里（/work/jett_peri/、jett.png）不算，只查正文里单独出现的
    return "|".join((r"(?<![A-Za-z0-9_/\\])" + re.escape(n) + r"(?![A-Za-z0-9_/\\])(?!\.[A-Za-z])") if n.isascii() else re.escape(n)
                    for n in sorted(names, key=len, reverse=True))


_F = _foreign_pattern()
if _F:
    RULES.append(("非国服叫法", r"(?i)" + _F))
COMPILED = [(c, re.compile(p)) for c, p in RULES]

REWRITE = ("上一条要发给玩家的内容里出现了不该出现的用语：{hits}。英文名、港服译名、非官方称呼一律换成国服官方中文名（如捷风、贤者）。"
           "直接重写这条回复并发出：保留给玩家的全部实际内容（设计判断、配色、下一步要做什么、需要玩家确认的问题），"
           "去掉这些词；库里查到的内容当作你本来就懂，不引用来源、不报数量、不说「没找到」；网上搜来的内容保留「在网上搜到」这类说明。"
           "不要提到重写、检查、这些词，也不要道歉或解释。")


def check(text):
    hits = []
    for cat, rx in COMPILED:
        for m in rx.finditer(text or ""):
            h = m.group(0)
            if h not in [x["term"] for x in hits]:
                hits.append({"term": h, "type": cat})
    return hits


def verdict(text):
    hits = check(text)
    if not hits:
        return {"ok": True}
    terms = "、".join(f"「{h['term']}」" for h in hits[:8])
    return {"ok": False, "hits": hits, "rewrite": REWRITE.format(hits=terms)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--text")
    a = ap.parse_args()
    text = a.text if a.text is not None else (open(a.file, encoding="utf-8").read() if a.file else sys.stdin.read())
    v = verdict(text)
    print(json.dumps(v, ensure_ascii=False))
    sys.exit(0 if v["ok"] else 2)


if __name__ == "__main__":
    main()
