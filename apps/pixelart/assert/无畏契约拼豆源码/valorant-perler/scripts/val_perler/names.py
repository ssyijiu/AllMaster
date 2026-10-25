"""名称处理（国服环境）。数据全部来自 aliases.json，没有这个文件时两个函数都原样返回。

  normalize(q)    入口：玩家怎么说都行（外号、英文名、港服译名、错别字、搭档、梗、技能黑话），换成资料里的正式写法。
  officialize(t)  出口：返回内容里的英文名、港服/繁体服译名、非官方称呼，统一成国服官方名；讲译名来历的句子整句去掉。

这两个函数和 aliases.json 是一组，整体搬到服务端时一起搬走即可，cli.py 不需要改。
"""
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
try:
    ALIASES = json.loads((HERE / "aliases.json").read_text(encoding="utf-8"))
except FileNotFoundError:
    ALIASES = {}


def _hero_ref(h):
    """单字英雄名（零）容易和普通词撞，统一写成「特工零」。"""
    return f"特工{h}" if len(h) == 1 else h


def _word(k):
    return r"(?<![A-Za-z])" + re.escape(k) + r"(?![A-Za-z])" if k.isascii() else re.escape(k)


def _build_rules():
    """叫法 -> 要注入的词。一次扫描，长的先匹配，替换结果不会被再次替换。"""
    A, rules = ALIASES, {}
    for hero, al in A.get("heroes", {}).items():
        for a in al:
            rules[a.lower()] = [_hero_ref(hero)]
    for k, (h1, h2) in A.get("combos", {}).items():
        rules[k.lower()] = [_hero_ref(h1), _hero_ref(h2), "人物关系"]
    for k, (h, part) in A.get("memes", {}).items():
        rules[k.lower()] = [_hero_ref(h), part]
    for k, (h, leaf) in A.get("slang_skills", {}).items():
        rules[k.lower()] = [_hero_ref(h), leaf]
    for k, v in A.get("generic", {}).items():
        rules[k.lower()] = [v]
    return rules


RULES = _build_rules()
_RX = re.compile("|".join(_word(k) for k in sorted(RULES, key=len, reverse=True)), re.I) if RULES else None
_KEY = re.compile(r"([QECX])\s*(?:技能|键)", re.I)
_ZERO = re.compile(r"(?<![特工])零(?=\s*(?:的|外观|技能|终结|大招|[123]技能|被动|人物|背景|玩法|变更|配色|发型|衣服|服饰|[QECX]\b)|$)")


def normalize(q):
    """把玩家的叫法换成资料里的写法。已经写在句子里的词不重复注入；同一个词只保留一次。"""
    if not _RX:
        return q

    def rep(m):
        rest = m.string[:m.start()] + m.string[m.end():]
        inject = [t for t in RULES[m.group(0).lower()] if t not in rest]
        return " " + " ".join(inject) + " " if inject else " "

    A = ALIASES
    out = _RX.sub(rep, q)
    out = _ZERO.sub(" 特工零 ", out)
    toks, seen = [], set()
    for t in out.split():
        if t in seen and (t in A["skills"] or t.startswith("特工") or t in ("人物关系", "外观", "终结技能")
                          or re.fullmatch(r"[123]技能|被动", t)):
            continue
        seen.add(t)
        toks.append(t)
    out = " ".join(toks)
    heroes = [h for h in A["skills"] if _hero_ref(h) in out]
    if len(heroes) == 1:
        h = heroes[0]
        for word, leaf in A["hero_slang"].get(h, {}).items():
            if word in out and leaf not in out:
                out += f" {leaf}"
        for leaf, (name, key) in A["skills"][h].items():
            if (name and name in out) or any(k.upper() == key for k in _KEY.findall(out) if key):
                if leaf not in out:
                    out += f" {leaf}"
    return out.strip()


# ---------------------------------------------------------------- 出口
def display_name(hero):
    """路径里的英雄名 -> 国服官方显示名（K-O -> K/O）。"""
    return ALIASES.get("display", {}).get(hero, hero)


def _build_scrub():
    A = ALIASES
    repl = {}
    for hero, names in A.get("foreign", {}).items():
        for n in names:
            repl[n.lower()] = display_name(hero)
    if not repl:
        return None
    alts = "|".join(_word(k) for k in sorted(repl, key=len, reverse=True))
    return {
        "repl": repl,
        "word": re.compile(alts, re.I),
        "paren": re.compile(r"\s*[（(]\s*(?:" + alts + r")\s*[)）]", re.I),
        "ctx": re.compile(A.get("scrub_ctx", "(?!)")),
        "nonoff": [x for x in A.get("non_official", [])],
    }


_S = _build_scrub()


def officialize(text):
    """返回内容里只留国服官方名：
    1. 括号里的英文名/港服译名直接去掉：不死鸟（Phoenix）-> 不死鸟
    2. 含非官方称呼（魏玲莹…）的句子整句去掉；同时含非国服叫法和「译名/音译/港服…」的句子（在讲叫法来历）整句去掉
    3. 其余位置的英文名/港服译名换成官方名：Jett diff -> 捷风 diff
    句子级处理：整行都被去掉才删行，其余句子保留。"""
    if not text or not _S:
        return text
    S, out = _S, []
    for line in text.split("\n"):
        line = S["paren"].sub("", line)
        if S["word"].search(line) or any(n in line for n in S["nonoff"]):
            parts = re.split(r"(?<=。)", line)
            kept = []
            for p in parts:
                bad = any(n in p for n in S["nonoff"]) or (S["word"].search(p) and S["ctx"].search(p))
                if not bad:
                    kept.append(p)
            if not any(re.sub(r"^\s*[-*]*\s*(\*\*[^*]*\*\*)?\s*[:：]?\s*", "", k).strip() for k in kept):
                continue  # 整行都在讲非官方叫法
            line = "".join(kept)
            line = S["word"].sub(lambda m: S["repl"][m.group(0).lower()], line)
        out.append(line)
    return "\n".join(out)
