#!/usr/bin/env python3
"""val-perler：无畏契约资料查询。

  val-perler search query "检索语句"            找资料：返回前3篇原文、前10篇摘要、前20个编号
  val-perler search list [路径]                 看有哪些（可加 --part 外观 / --match 关键词 / --offset 翻页）
  val-perler search get <编号或路径>            取全文
  val-perler search alias 奶妈                  查一个叫法是什么（外号、英文名、梗、技能黑话）
  val-perler search guard --text "草稿"         发给玩家前检查有没有不该出现的词

端游（pc）和手游（mb）是两套互相隔离的资料：query/list/get 用 --platform pc|mb 指定查哪一套；
不指定时 query 按问句里有没有「手游/手瓦…」自动判断，list/get 默认查端游。环境变量 VAL_PLATFORM 可设默认。
结果是 JSON，只给 agent 自己用。退出码：0 成功；1 出错；2 草稿检查不通过。
"""
import argparse
import json
import os
import pathlib
import re
import sys
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

HOST = "https://val-perler.qq.com"
# 平台 -> 类目。类目同时是标签前缀（gamedb_*）和文档名前缀（gamedb-*），两套资料靠它隔离、互不召回
PLATFORMS = {"pc": "gamedb", "mb": "mb"}
CATEGORY = PLATFORMS["pc"]  # 当前查询的类目；main() 按 --platform 重设
PLATFORM = "pc"
# 问句里点明是手游/端游时，直接路由；都没点明就当端游（默认）
MB_HINT = re.compile(r"手游|手瓦|手机版|手机端|手机上|移动端|端手游|源能行动|安卓|iOS|苹果手机|\bmobile\b|\bmb\b", re.I)
PC_HINT = re.compile(r"端游|电脑版|电脑上|PC端|\bpc\b|客户端|Steam", re.I)


class BusyError(requests.ConnectionError):
    """429 限流：同时检索的人太多。等待交给调用方，CLI 不长时间阻塞。"""


# ---- 调用方身份（后端监控用）：X-WB-Id + X-UUID，缺失不阻塞检索，按匿名继续 ----
# wb_id 与生图同一获取链：ACC_USER_ID 环境变量 → ~/.workbuddy 下 user-<ID>-personal 目录名（取最新）→
# credentials.json 的 workbuddy_id 缓存；uuid 取 credentials.json 里 auth_key.uuid（login.py 扫码授权后写入）。
_ID_ENV = "ACC_USER_ID"
_WB_CONFIG_ENV = "WORKBUDDY_CONFIG_DIR"
_CONFIG_DIR_ENV = "PERLER_CONFIG_DIR"
_CRED_FILE = "credentials.json"
_ID_HEADER = "X-WB-Id"
_UUID_HEADER = "X-UUID"
_UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def _norm_uuid(value):
    value = (value or "").strip()
    return value.lower() if _UUID_RE.fullmatch(value) else None


def _cred_path():
    override = os.environ.get(_CONFIG_DIR_ENV, "").strip()
    base = pathlib.Path(override) if override else pathlib.Path.home() / ".config" / "valorant-perler"
    return base / _CRED_FILE


def _read_wb_id():
    """X-WB-Id：环境变量 → WorkBuddy 个人配置目录名 → 本地缓存，任一环节失败都静默降级到下一段。"""
    value = _norm_uuid(os.environ.get(_ID_ENV))
    if value:
        return value
    root = pathlib.Path(os.environ.get(_WB_CONFIG_ENV, "").strip() or pathlib.Path.home() / ".workbuddy")
    found = []
    try:
        for path in root.glob("user-*-personal"):
            v = _norm_uuid(path.name[len("user-"):-len("-personal")])
            if v and path.is_dir():
                found.append((path.stat().st_mtime, v))
    except OSError:
        pass
    if found:
        return max(found)[1]
    try:
        data = json.loads(_cred_path().read_text(encoding="utf-8"))
        entry = data.get("workbuddy_id") if isinstance(data, dict) else None
        return _norm_uuid(entry.get("id") if isinstance(entry, dict) else None)
    except (OSError, ValueError, AttributeError):
        return None


def _read_client_uuid():
    """X-UUID：credentials.json 里 auth_key 条目的 uuid（login.py 扫码授权后写入）。没有就匿名。"""
    try:
        data = json.loads(_cred_path().read_text(encoding="utf-8"))
        entry = data.get("auth_key") if isinstance(data, dict) else None
        return _norm_uuid(entry.get("uuid") if isinstance(entry, dict) else None)
    except (OSError, ValueError, AttributeError):
        return None


def _apply_client_headers():
    wb_id, client_uuid = _read_wb_id(), _read_client_uuid()
    if wb_id:
        S.headers[_ID_HEADER] = wb_id
    if client_uuid:
        S.headers[_UUID_HEADER] = client_uuid


def detect_platform(text):
    """按玩家原话判断问的是手游还是端游：点明端游 → pc；点明手游 → mb；都没有 → pc。"""
    if PC_HINT.search(text):
        return "pc", "问句点明端游"
    if MB_HINT.search(text):
        return "mb", "问句点明手游"
    return "pc", "默认端游"
N_TEXT, N_SUMM, N_IDS = 3, 10, 20  # 契约：最多 前3原文、前10摘要、前20 id
LOW_CONF = 0.4  # 低于它只提示「多半没有」，不删结果：是否采用由调用方看摘要判断
# 玩家要的是「一批」（合照、全部英雄……）：query 只能找最像的几篇，该走 list 取全集
BATCH = re.compile(r"合照|合影|全员|全部|所有|每个|每位|各个|\d+\s*个(英雄|特工|选手|战队)|[一二三四五六七八九十]+个(英雄|特工|选手|战队)")
LIST_PAGE = 30  # list 每页固定 30 条，翻页用 --offset
SRV_MAX = 15  # 服务单次最多返回约 15 片；limit 取 15（或 20）时片段才带标签，路径据此还原，所以统一用 15


from .names import ALIASES, display_name, normalize, officialize  # noqa: E402


def clean(text):
    """对外正文：去掉入库抬头里的「知识路径」「摘要」两行，并且只留国服官方名。"""
    head, rest = text[:900], text[900:]
    head = re.sub(r"知识路径：[^\n]*?(?=摘要：|\n|$)", "", head, count=1)
    head = re.sub(r"摘要：[^\n]*\n?", "", head, count=1)
    return officialize(head + rest)




S = requests.Session()


# 检索服务底层有账号级限流（约 20 次/秒，所有调用方共用）。
# 本进程内所有线程共用一个节拍：任意两次 /search 至少间隔 MIN_GAP 秒（约 8 次/秒），给其他调用方留足余量
MIN_GAP = 0.12
_gate, _last = threading.Lock(), [0.0]


def unavailable(r):
    """服务不可用：带上服务返回的说明（统一错误结构的 msg），没有就只说暂时不可用。"""
    msg = ""
    if r is not None:
        try:
            body = r.json()
            msg = str(body.get("msg") or "").strip() if isinstance(body, dict) else ""
        except ValueError:
            pass
    if r is not None and r.status_code == 429:   # 限流单独成 BusyError，提示与普通不可用区分
        return BusyError(f"检索限流，服务说明：{msg}" if msg else "检索限流")
    return requests.ConnectionError(f"检索服务暂时不可用，服务说明：{msg}" if msg else "检索服务暂时不可用")


def _service_note(e):
    return str(e).split("服务说明：", 1)[1] if "服务说明：" in str(e) else ""


def _throttle():
    with _gate:
        wait = _last[0] + MIN_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()


def srv_search(host, category, q, flt=None, limit=SRV_MAX):
    body = {"query": q, "limit": limit, "category": category}
    if flt:
        body["label_filter"] = flt
    r = None
    for i in range(3):  # 失败最多重试 2 次，间隔带随机抖动，避免多个会话同时重试
        try:
            _throttle()
            r = S.post(host + "/search", json=body, timeout=60)
            if r.status_code == 200:
                break
        except requests.RequestException:
            r = None
        time.sleep(min(1.5 * 2 ** i, 6) * (0.5 + random.random()))  # 约 1.5 / 3 秒，各 ±50%
    if r is None or r.status_code != 200:
        raise unavailable(r)
    out = []
    for s in r.json().get("snippets", []):
        out.append({"name": s["doc_name"], "conf": round(s.get("confidence", 0), 3), "content": s.get("content", ""),
                    "labels": [{"name": x["name"], "values": list(x.get("values", []))} for x in s.get("labels") or []]})
    return out


def strip_head(c):
    return re.sub(r"^文档名：.*?\n文档片段：\n?", "", c, count=1, flags=re.S)


def _order(chunk, heads=None):
    """片在整篇里的粗略位置。后端不返回片的序号，返回顺序只看相关度，所以只能靠内容结构判断：
    带「知识路径」抬头的是首片 → 其次是 H1 标题片 → 其余小节片（H2/H3 起头）保持后端返回顺序。
    长文（>2 片）里 H2 小节之间的先后无法还原，所以对外只保证「整篇都在、不截断」，不保证小节顺序。"""
    if "知识路径：" in chunk[:400]:
        return 0
    for line in chunk.split("\n"):
        line = line.strip()
        if re.match(r"^#\s", line):
            return 1
        if line:
            break
    return 2


# ====================================================================================
# 检索服务访问层：目录、路径、全文都实时向服务要，本地不保存知识数据。
# 用到两个读接口：GET /label/list（全部标签与取值）、POST /search（带标签过滤）。
# ====================================================================================
_JUNK = re.compile(r"probe|test|测试|冒烟|^x$|^zz|tmp|demo|^nk_|验证", re.I)  # 名字带这些词的标签不属于知识内容


def _retry_search(q, flt, tries=3):
    """检索。服务偶有「200 但没有片段」（限流降级会持续几秒），空结果按 2s/5s 带抖动重试，仍为空才算没有。"""
    out = []
    for i in range(tries):
        out = srv_search(HOST, CATEGORY, q, flt, limit=SRV_MAX)
        if out:
            return out
        time.sleep((2.0, 5.0)[i % 2] * (0.5 + random.random()))
    return out


def fetch_labels(query):
    """取标签目录。只请求名字含 query 的标签（服务支持 ?query= 子串过滤），请求和响应都尽量小；
    缓存由服务端负责，这里不做。"""
    r = None
    for i in range(3):
        try:
            r = S.get(HOST + "/label/list", params={"query": query}, timeout=20)
            if r.status_code == 200:
                break
        except requests.RequestException:
            r = None
        time.sleep(0.8 * (i + 1))
    if r is None or r.status_code != 200:
        raise unavailable(r)
    return [{"name": x["name"], "terms": list(x["terms"])} for x in r.json()]


class Remote:
    """本平台（类目）的标签视图。给了 domain 只取这个域的标签（按路径的 get/list，1 次 /label/list）；
    不给则取本平台全部标签（顶层 list、--match、跨域 --part 需要）。"""

    def __init__(self, domain=None):
        pre = CATEGORY + "_"
        raw = {}

        def load(q):
            for x in fetch_labels(q):  # 服务按子串匹配：再严格按前缀筛一遍，并去掉非知识标签
                if x["name"].startswith(pre) and not _JUNK.search(x["name"][len(pre):]):
                    raw[x["name"]] = x["terms"]

        self.labels, self.domains, self.domain_label = {}, [], None
        dom_label = CATEGORY + "_域"
        if domain is None:
            load(pre)
            dom_terms = raw.get(dom_label, [])
        else:  # 域值就是路径第一段，标签名是约定的 <类目>_域：不用再为取域列表多调一次
            for fam in sorted(self._families([domain])):
                load(pre + fam)
            dom_terms = [domain] if any(self.family(n) in self._families([domain]) for n in raw) else []
        if dom_terms:
            self.domain_label = dom_label
            self.domains = list(dom_terms)
            self.labels[dom_label] = list(dom_terms)
        fams = set()
        for d in self.domains:
            fams |= self._families([d])
        for name, terms in raw.items():  # 其余标签：家族在名单里就收
            if name not in self.labels and self.family(name) in fams:
                self.labels[name] = terms

    @staticmethod
    def _families(values):
        """域值 -> 家族词：『赛事与电竞』的标签家族是『电竞』，其余就是域值本身。"""
        out = set()
        for v in values:
            out.add(v)
            out.add(v[-2:])
        return out

    # ---- 标签角色：按名字后缀判断，不依赖任何打包清单
    @staticmethod
    def is_leaf(name):
        return name.endswith("叶子") or re.search(r"叶子\d+$", name) is not None

    @staticmethod
    def is_series(name):
        return name.endswith("系列") or re.search(r"系列\d+$", name) is not None

    def family(self, name):
        """标签所属域家族：gamedb_英雄/英雄叶子/英雄2 -> 英雄；gamedb_电竞_战队/电竞系列/电竞叶子 -> 电竞。"""
        n = name[len(CATEGORY) + 1:]
        n = re.sub(r"叶子\d*$|系列\d*$", "", n)
        n = re.sub(r"_.*$", "", n)
        return re.sub(r"\d+$", "", n)

    def entity_labels(self, domain=None):
        """某个域下的「实体标签」（特工名、战队、选手分桶、赛事…）：非域、非叶子、非系列。"""
        out = {}
        for n, terms in self.labels.items():
            if n == self.domain_label or self.is_leaf(n) or self.is_series(n):
                continue
            if domain is None or self._domain_of_family(self.family(n)) == domain:
                out[n] = terms
        return out

    def _domain_of_family(self, fam):
        """家族 -> 域名。英雄->英雄；电竞->赛事与电竞；其他（如 地图）家族名就是域名。"""
        if fam in self.domains:
            return fam
        for d in self.domains:
            if fam in d:  # 电竞 in 赛事与电竞
                return d
        return fam

    def series_values(self, domain):
        """某个域下的「系列」取值（如 赛事与电竞 -> VCT国际赛、战队、电竞人物…）；英雄域没有系列。"""
        return {v for n, t in self.labels.items() if self.is_series(n)
                and self._domain_of_family(self.family(n)) == domain for v in t}

    def entity_labels_of_series(self, domain, series):
        """系列对应的实体标签：命名约定 `电竞_<系列>`、`电竞_<系列>2`、`电竞_<系列>_1`（分桶/新建标签都包含在内）。"""
        out = {}
        for n, t in self.entity_labels(domain).items():
            tail = n.split("_", 2)[-1] if n.count("_") >= 2 else ""
            if re.fullmatch(rf"{re.escape(series)}(_?\d+)?", tail):
                out[n] = t
        return out

    def holder(self, value, role):
        """持有取值 value 的标签。role: domain / series / entity / leaf。"""
        c = [n for n, t in self.labels.items() if value in t]
        if role == "domain":
            c = [n for n in c if n == self.domain_label]
        elif role == "leaf":
            c = [n for n in c if self.is_leaf(n)]
        elif role == "series":
            c = [n for n in c if self.is_series(n)]
        else:
            c = [n for n in c if n != self.domain_label and not self.is_leaf(n) and not self.is_series(n)]
        return c

    def filter_for(self, path):
        """知识路径 -> 完整标签过滤。每段按位置分配角色（域/系列或实体/叶子），同一家族内取标签，
        所以「概览」「外观」这种在多个域出现的值不会串。认不出的段返回 None。"""
        flt, used, fam = [], set(), None
        n = len(path)
        for i, seg in enumerate(path):
            if i == 0:
                cand = self.holder(seg, "domain")
            else:
                last = i == n - 1 and n > 2
                roles = ["leaf"] if last else ["series", "entity"]
                cand = [c for r in roles for c in self.holder(seg, r)]
                if not cand and last:  # 电竞单篇实体没有叶子段，末段其实是实体
                    cand = self.holder(seg, "entity") + self.holder(seg, "series")
                # 路径第一段就是域：同名的实体（如「捷风」既是英雄也是游戏梗页）按这个域取标签
                in_dom = [c for c in cand if self._domain_of_family(self.family(c)) == path[0]]
                cand = in_dom or cand
                if fam:
                    same = [c for c in cand if self.family(c) == fam]
                    cand = same or cand
            cand = [c for c in cand if c not in used]
            if not cand:
                return None
            if i == 1:
                fam = self.family(cand[0])
            used.add(cand[0])
            flt.append({"name": cand[0], "values": [seg]})
        return flt


def doc_path(content):
    """文档正文抬头的「知识路径：英雄 / 捷风 / 外观」就是权威路径（入库规范里每篇都有）。"""
    m = re.search(r"知识路径：([^\n]+?)(?=摘要：|\n|$)", content)
    return [x.strip() for x in m.group(1).split("/") if x.strip()] if m else None


def doc_summary(content):
    m = re.search(r"摘要：([^\n]+)", content)
    if m:
        return m.group(1).strip()
    # 兜底：切片没有「摘要：」行时，取正文第一个非标题、非抬头的句子当摘要，
    # 保证 query 返回的 summary 不为空——摘要全空会逼着调用方逐篇取全文，检索路径整体变慢
    body = content
    body = re.sub(r"^文档名：[^\n]*\n", "", body)
    body = re.sub(r"^文档片段：[^\n]*\n", "", body)
    body = re.sub(r"知识路径：[^\n]*?(?=摘要：|\n|$)", "", body, count=1)
    for line in body.split("\n"):
        line = officialize(line).strip()
        if not line or line.startswith("#") or line.startswith("<small>"):
            continue
        m2 = re.search(r"(.{20,80}?[。！？；])", line)
        return m2.group(1) if m2 else line[:80]
    return ""


def labels_path(labels):
    """每个片段都带 labels（域 / 系列 / 实体 / 叶子）：按 域→系列→实体→叶子 还原知识路径。
    后续切片没有「知识路径」抬头、文档名里的连字符（K-O）也不能拆，所以以标签为准。
    叶子叫「本篇」表示单篇实体（战队、选手、单届赛事），路径到实体为止。"""
    dom, ser, ent, leaf = [], [], [], []
    for l in labels or []:
        n, vs = l["name"], l["values"][:1]
        if n.endswith("_域"):
            dom = vs
        elif Remote.is_series(n):
            ser = vs
        elif Remote.is_leaf(n):
            leaf = [] if vs == ["本篇"] else vs
        else:
            ent = vs
    return dom + ser + ent + leaf or None


def path_of(h):
    """一个检索片段对应的知识路径：优先标签，其次正文抬头，最后才用文档名拆。"""
    return (labels_path(h.get("labels")) or doc_path(h["content"])
            or h["name"][len(CATEGORY) + 1:-3].split("-"))


def docs_in(R, flt, q=None):
    """某个标签范围内的全部文档 -> [{path, summary, name, labels}]。
    服务单次最多返回约 15 片，而长文（如贤者的玩法与定位）一篇就占好几片：范围内片数顶到上限时，
    有些文档会被挤出去。这时按范围内没出现过的叶子逐个补查，直到取全。"""
    q = q or " ".join(f["values"][0] for f in flt)
    hs = _retry_search(q, flt)
    if len(hs) >= SRV_MAX:
        hs += _fill_saturated(R, flt, q, hs)
    out, seen = [], {}
    for h in hs:
        nm = h["name"]
        if not nm.startswith(CATEGORY + "-") or nm.endswith("INDEX.md"):
            continue
        d = seen.get(nm)
        if d is None:
            d = seen[nm] = {"name": nm, "path": path_of(h), "summary": "", "labels": h["labels"]}
            out.append(d)
        d["summary"] = d["summary"] or doc_summary(h["content"])
    return out


def _fill_saturated(R, flt, q, hs):
    """范围内的片数顶到服务单次上限（约 15 片），部分文档被挤出去了。按没见过的叶子标签补查：
    每个叶子标签带一批取值，一次检索返回片数没撑满就说明这批取全了；撑满了就把取值对半拆开再查，
    直到每一批都没撑满。一个取值只对应一篇文档，所以一定收敛，调用次数约为 文档数/12 的两倍。
    家族取自过滤里的实体标签或域值（不能取第一个过滤——那永远是域标签）。"""
    have = {f["name"] for f in flt}
    fams = set()
    for f in flt:
        if f["name"] == R.domain_label:
            for v in f["values"]:
                fams |= R._families([v])
        else:
            fams.add(R.family(f["name"]))
    tasks = []
    for n, vals in R.labels.items():
        if Remote.is_leaf(n) and n not in have and R.family(n) in fams:
            tasks.append((n, list(vals)))  # 不剔除首查见过的取值：首查只有 15 片，剔除会让同桶其余取值漏查

    def ask(n, values):
        return srv_search(HOST, CATEGORY, q, flt + [{"name": n, "values": values}], limit=SRV_MAX)

    def fetch(n, values):
        r = ask(n, values)
        if not r:  # 并发时偶有 200 但空结果（不会触发重试）：空结果再确认一次
            time.sleep(0.3)
            r = ask(n, values)
        if len(r) >= SRV_MAX and len(values) > 1:  # 撑满：对半拆开各查一遍（调用方按文档名去重）
            mid = len(values) // 2
            return r + fetch(n, values[:mid]) + fetch(n, values[mid:])
        return r

    with ThreadPoolExecutor(2) as ex:  # 并发保持在 2：更高时空结果明显增多
        return [h for r in ex.map(lambda t: fetch(*t), tasks) for h in r]


def expand_values(R, jobs, extra=None, workers=4):
    """对一批 (标签, 取值) 并发穷举文档。服务偶有「200 但没有片段」或超时：
      · 报错或返回空的取值先降并发重试两轮（标签里有这个取值，下面通常就有文档）；
      · 重试后仍报错的占比超过 10%，整体按「服务不可用」处理，不把偶发失败当作「没有」；
      · 重试后仍为空，视为这个取值下没有文档（如文档已删除、取值残留在标签里）。"""
    def one(j):
        try:
            return j, docs_in(R, [{"name": j[0], "values": [j[1]]}] + (extra or []), q=j[1])
        except requests.RequestException:
            return j, None
    with ThreadPoolExecutor(workers) as ex:
        res = dict(ex.map(one, jobs))
    for delay in (1.0, 2.0):
        redo = [j for j, d in res.items() if not d]  # None（报错）和 []（空）都再试
        if not redo:
            break
        time.sleep(delay)
        with ThreadPoolExecutor(2) as ex:
            for j, d in ex.map(one, redo):
                if d:
                    res[j] = d
                elif res[j] is None:
                    res[j] = d
    failed = [j for j, d in res.items() if d is None]
    if jobs and len(failed) / len(jobs) > 0.1:
        raise requests.ConnectionError("检索服务暂时不可用")
    return [d for ds in res.values() if ds for d in ds]


def fetch_doc(R, path):
    """按路径取一篇全文（整篇，切片拼回）。找不到返回 None。"""
    flt = R.filter_for(path)
    if not flt:
        return None
    body = path[1:] if len(path) > 1 else path
    q = " ".join(body)
    for h in _retry_search(q, flt):
        if path_of(h) == path or h["name"] == CATEGORY + "-" + "-".join(path) + ".md":
            return h["name"], fetch_full(q, flt, h["name"])
    return None


def _assemble(got):
    """一篇文档的全部切片 -> 整篇正文（去掉每片的入库抬头，按内容结构还原顺序）。"""
    parts = [strip_head(c["content"]) for c in got]
    parts.sort(key=_order)  # 稳定排序：同级的片保持服务返回顺序
    out = []
    for p in parts:
        first = p.lstrip().split("\n", 1)[0].strip()
        if out and re.match(r"^#{1,6}\s", first):
            i = out[-1].rfind("\n" + first)
            if i >= 0 and out[-1][i:].count("\n#") <= 1:
                out[-1] = out[-1][:i]
        out.append(p)
    return "\n".join(x for x in out if x.strip())


def fetch_full(q, flt, doc_name):
    """取指定文档的全部切片并按原文顺序拼回整篇。服务单次最多返回约 15 片，一般文档（<1 万字）几片就够；
    flt 是这篇自己的标签，范围内只有这一篇，所以不会被别的文档挤掉。"""
    got = []
    for i in range(3):
        got = [c for c in srv_search(HOST, CATEGORY, q, flt, limit=SRV_MAX) if c["name"] == doc_name]
        if got:
            break
        time.sleep(1.0 * (i + 1) * (0.5 + random.random()))
    if not got:
        raise requests.ConnectionError("检索服务暂时不可用")
    return _assemble(got)


def fetch_full_many(items, q):
    """items: [(文档名, 这篇的标签)]。几篇文档的标签名相同时，每个标签名取各篇取值的并集，一次检索全取回
    （同一标签内多值是 OR）。并集可能多带进别的文档，所以：返回片数撑满、或有一篇没取到，就整体放弃，
    由调用方逐篇回退。这样 query 的取全文由 3 次检索降到 1 次，给后端（腾讯云 ADP 账号级 20 次/秒）减压。
    返回 {文档名: 整篇文本}；放弃时返回 None。"""
    if len(items) < 2 or any(not lab for _, lab in items):
        return None
    names = [frozenset(l["name"] for l in lab) for _, lab in items]
    if len(set(names)) != 1:
        return None
    union = {}
    for _, lab in items:
        for l in lab:
            vs = union.setdefault(l["name"], [])
            vs += [v for v in l["values"] if v not in vs]
    flt = [{"name": n, "values": vs} for n, vs in union.items()]
    r = srv_search(HOST, CATEGORY, q, flt, limit=SRV_MAX)
    if len(r) >= SRV_MAX:
        return None
    by = {}
    for c in r:
        by.setdefault(c["name"], []).append(c)
    if any(n not in by for n, _ in items):
        return None
    return {n: _assemble(by[n]) for n, _ in items}


# ====================================================================================
# 命令
# ====================================================================================
OTHER_GAME = re.compile(r"王者荣耀|KPL|原神|英雄联盟|LOL|CSGO|CS2|穿越火线|和平精英|绝地求生|守望先锋|APEX|蛋仔|崩坏|明日方舟|我的世界", re.I)
SELF_GAME = re.compile(r"无畏契约|瓦罗兰特|valorant|VCT", re.I)


_OTHER = {"pc": "手游", "mb": "端游"}
_OTHER_KEY = {"pc": "mb", "mb": "pc"}


def cmd_query(a):
    """纯 embedding 召回，不替调用方做决定：不自动限定范围、不置顶叶子、不按置信度砍结果。
    一次给「前 3 篇原文 + 前 10 条摘要 + 前 20 个编号」，每条带置信度；读哪篇、够不够用、要不要联网，
    由调用方看了摘要和清单自己判断。--filter 仍可手动限定范围。
    正常路径不读标签目录（0 次 /label/list）：取全文的过滤直接用命中片段自带的标签。"""
    qs = [x.strip() for x in [a.q] + (a.q2 or [])]
    joined = " ".join(qs)
    flt = []
    if a.filter:  # 只有手动限定才需要标签目录
        R = Remote()
        for f in a.filter:
            k, v = f.split("=", 1)
            c = R.holder(v, "entity") or R.holder(v, "series")
            if c:
                flt.append({"name": c[0], "values": v.split(",")})
    ents = [v for f in flt for v in f["values"]]
    with ThreadPoolExecutor(4) as ex:
        res = list(ex.map(lambda q: srv_search(HOST, CATEGORY, q, flt or None), qs))
    if not any(res):
        # 首轮全空：可能是限流降级（会持续几秒），不是真的没召回——等几秒带抖动重试一次再下结论
        time.sleep(3.0 * (0.5 + random.random()))
        with ThreadPoolExecutor(4) as ex:
            res = list(ex.map(lambda q: srv_search(HOST, CATEGORY, q, flt or None), qs))
    score, seen, hits = {}, {}, {}
    for hs in res:
        uniq = []
        for h in hs:
            nm = h["name"]
            if not nm.startswith(CATEGORY + "-") or nm.endswith("INDEX.md"):
                continue
            seen[nm] = max(seen.get(nm, 0), h["conf"])  # 同一篇多片时取最高分：服务端返回的是切片顺序
            m = hits.setdefault(nm, {"path": None, "summary": "", "labels": None})
            # 去重只是评分口径（每篇计一次名次），路径/标签/摘要的提取必须每片都做：
            # 首片可能是纯抬头片（无正文），正文在后续切片，提前 continue 会漏掉摘要
            if nm not in uniq:
                uniq.append(nm)
            if m["path"] is None:
                m["path"] = labels_path(h.get("labels")) or doc_path(h["content"])
            if not m["labels"] and h.get("labels"):
                m["labels"] = h["labels"]
            m["summary"] = m["summary"] or doc_summary(h["content"])
        for i, n in enumerate(uniq, 1):
            score[n] = score.get(n, 0) + 1 / (60 + i)
    for nm, m in hits.items():  # 标签和抬头都没有（后续切片且未带标签）：从文档名兜底
        if m["path"] is None:
            m["path"] = nm[len(CATEGORY) + 1:-3].split("-")
    # 多条检索语句用名次融合（RRF）合并；只有一条时直接按置信度排
    rank = sorted(score, key=(lambda n: (-score[n], -seen.get(n, 0))) if len(qs) > 1
                  else (lambda n: -seen.get(n, 0)))
    if OTHER_GAME.search(joined) and not SELF_GAME.search(joined):
        rank = []  # 别的游戏的问题
    top3 = rank[:N_TEXT]

    def lab_of(n):
        lab = hits[n]["labels"]
        return [{"name": l["name"], "values": l["values"]} for l in lab if l["values"]] if lab else None

    def full(n):
        p = hits[n]["path"]
        f = lab_of(n)  # 命中片段自带这篇的全部标签，直接当过滤；标签是精确值匹配，能唯一定位到这一篇
        if not f:  # 片段没带标签时，读本域的标签目录还原
            f = Remote(domain=p[0] if p else None).filter_for(p) if p else None
        return fetch_full(" ".join(p[1:]) if p and len(p) > 1 else joined, f, n)

    merged = fetch_full_many([(n, lab_of(n)) for n in top3],
                             " ".join(" ".join(hits[n]["path"][1:]) for n in top3)) if len(top3) > 1 else None
    texts = [merged[n] for n in top3] if merged else [full(n) for n in top3]  # 逐篇串行：避免同一瞬间并发 3 次
    ref_ = lambda n: "/".join(hits[n]["path"])
    best = max((seen.get(n, 0) for n in rank), default=0)
    out = {"platform": PLATFORM, "queries": qs, "scope": [display_name(v) for v in ents], "found": len(rank),
           "text": [{"id": ref_(n), "conf": seen.get(n, 0), "text": clean(t)} for n, t in zip(top3, texts)],
           "summary": [{"id": ref_(n), "conf": seen.get(n, 0), "summary": officialize(hits[n]["summary"])}
                       for n in rank[:N_SUMM]],
           "ids": [ref_(n) for n in rank[:N_IDS]]}
    if not rank:
        if BATCH.search(joined):
            out["next"] = "要的是一批：用 search list 英雄 --part 外观 列出全部，挑要用的再逐个 get"
        else:
            out["next"] = ("没有召回：换个说法再查，或 search list --match 关键词 核对；"
                           f"玩家说的若其实是{_OTHER[PLATFORM]}，加 --platform {_OTHER_KEY[PLATFORM]} 再查；仍没有就自己联网补充")
    elif best < LOW_CONF:
        out["next"] = (f"最高置信度只有 {best:.2f}，看摘要对不对得上：对得上就用，对不上就当没有——"
                       f"换成正式名再查，或玩家说的若其实是{_OTHER[PLATFORM]}就加 --platform {_OTHER_KEY[PLATFORM]} 再查，"
                       "或 search list --match 关键词 核对，仍没有就自己联网补充")
    print(json.dumps(out, ensure_ascii=False, indent=1 if a.pretty else None))


def _page(items, a, path, part, extra=None):
    total = len(items)
    page = items[a.offset:a.offset + LIST_PAGE]
    out = {"platform": PLATFORM, "path": "/".join(path), "part": part, "total": total, "returned": len(page), "items": page}
    if total == 0:
        out["found"] = False
        out["next"] = ("没有这条：若用的是外号（奶妈、火男），先换成正式名再试一次；"
                       "仍没有就自己联网补充（搜「无畏契约」+正式名+想了解的方面），结果只作本次参考")
    if a.offset + LIST_PAGE < total:
        out["next"] = f"--offset {a.offset + LIST_PAGE}"
    print(json.dumps(out, ensure_ascii=False, indent=1 if a.pretty else None))


def _doc_items(docs):
    return [{"path": "/".join(d["path"]), "summary": officialize(d["summary"])[:80], "type": "doc"} for d in docs]


def _dir_item(name, path, children):
    return {"name": name, "path": "/".join(path + [name]), "type": "dir", "children": sorted(children)[:12]}


def cmd_list(a):
    path = [x for x in a.path.split("/") if x] if a.path else []
    part = a.part
    # 只有看某个域/实体（给了路径、没用 --match/--part）时才只取这个域的标签；其余要全量
    R = Remote(domain=path[0] if path and not a.match and not part else None)

    # ---- 顶层：有哪些域（直接读标签，0 次检索）
    if not path and not part and not a.match:
        items = []
        for d in sorted(R.domains):
            series = R.series_values(d)
            kids = series or {v for n, t in R.entity_labels(d).items() for v in t}
            items.append({"name": d, "path": d, "type": "dir", "children": sorted(kids)[:12]})
        return _page(items, a, path, part)

    # ---- 按关键词找（--match）：先在标签取值里找，每个命中的取值 1 次检索并发穷举；
    #      取值里没有再对文档摘要匹配（用关键词本身检索一次）
    if a.match:
        rx = re.compile(normalize(a.match), re.I)
        jobs = [(n, v) for n, terms in R.labels.items()
                if n != R.domain_label and not R.is_leaf(n) and not R.is_series(n)
                for v in terms if rx.search(v)]
        docs, seen = [], set()

        def take(ds):
            for d in ds:
                if d["name"] not in seen and d["path"][:len(path)] == path and (not part or d["path"][-1] == part):
                    seen.add(d["name"])
                    docs.append(d)

        take(expand_values(R, jobs))
        # 文本命中：关键词本身语义检索一次，留下路径或摘要里确实含它的。
        # 服务不支持按摘要内容过滤，这里只补语义检索排在前面的（≤15 篇）；
        # 「提到了这个关键词的其他条目」请用 query，不要指望 list --match 穷举
        try:
            take([d for d in docs_in(R, None, q=a.match) if rx.search(d["summary"]) or rx.search("/".join(d["path"]))])
        except requests.RequestException:
            pass
        return _page(_doc_items(sorted(docs, key=lambda d: d["path"])), a, path, part)

    # ---- 跨实体取同名叶子（如所有英雄的外观页）：按实体分批，每批 1 次检索
    if part:
        domain = path[0] if path else None
        ents = R.entity_labels(domain)
        lf = R.holder(part, "leaf")
        docs, seen = [], set()
        if lf:
            jobs = [(n, v) for n, terms in ents.items() for v in terms]
            for d in expand_values(R, jobs, extra=[{"name": lf[0], "values": [part]}]):
                if d["name"] not in seen and d["path"][-1] == part and d["path"][:len(path)] == path:
                    seen.add(d["name"])
                    docs.append(d)
        docs.sort(key=lambda d: d["path"])
        return _page(_doc_items(docs), a, path, part)

    # ---- 域下的全部实体（如 list 英雄 = 全部特工；list 赛事与电竞 = 全部系列）：读标签，0 次检索
    if len(path) == 1:
        d = path[0]
        if d not in R.domains:
            return _page([], a, path, part)
        series = R.series_values(d)
        if series:  # 电竞域：先列系列
            items = [_dir_item(x, path, []) for x in sorted(series)]
        else:  # 英雄域：直接列特工
            items = [{"name": display_name(v), "path": "/".join(path + [v]), "type": "dir", "children": []}
                     for n, terms in R.entity_labels(d).items() for v in sorted(terms)]
        return _page(items, a, path, part)

    # ---- 路径更深
    # 3a 系列下的实体（赛事与电竞/战队 -> 全部战队）：该系列对应的实体标签，每个取值 1 次检索并发展开，拿全
    if len(path) == 2:
        labs = R.entity_labels_of_series(path[0], path[1])
        if labs:
            jobs = [(n, v) for n, terms in labs.items() for v in terms]
            docs, seen = [], set()
            for d in expand_values(R, jobs):
                if d["name"] not in seen and d["path"][:2] == path:
                    seen.add(d["name"])
                    docs.append(d)
            if docs:
                return _page(_doc_items(sorted(docs, key=lambda d: d["path"])), a, path, part)
    # 3b 实体下的文档（英雄/捷风、赛事/.../2024上海大师赛）：一次过滤检索（≤15 片，一个实体不会超）
    flt = R.filter_for(path)
    docs = [d for d in (docs_in(R, flt, q=" ".join(path[1:])) if flt else []) if d["path"][:len(path)] == path]
    return _page(_doc_items(sorted(docs, key=lambda d: d["path"])), a, path, part)


def cmd_get(a):
    segs = [x for x in a.id.split("/") if x]
    R = Remote(domain=segs[0] if segs else None)
    got = fetch_doc(R, segs)
    if not got:
        print(json.dumps({"platform": PLATFORM, "id": a.id, "found": False}, ensure_ascii=False))
        sys.exit(1)
    name, t = got
    t = clean(t)
    print(json.dumps({"platform": PLATFORM, "id": "/".join(segs), "found": bool(t), "chars": len(t), "text": t}, ensure_ascii=False,
                     indent=1 if a.pretty else None))


def cmd_alias(a):
    """查一个叫法对应什么（只给国服官方名）；不带词则列出常用外号。"""
    A = ALIASES
    if not A:
        print(json.dumps({"term": a.term, "note": "叫法在服务端处理，直接用玩家原话查询即可"}, ensure_ascii=False))
        return
    foreign = {n.lower() for ns in A.get("foreign", {}).values() for n in ns} | {n.lower() for n in A.get("non_official", [])}
    if not a.term:
        slang = {display_name(h): [x for x in al if x.lower() not in foreign and not x.isascii()]
                 for h, al in A["heroes"].items()}
        print(json.dumps({"英雄外号": {h: al for h, al in slang.items() if al}, "搭档": A["combos"],
                          "梗": A["memes"], "技能黑话": A["slang_skills"], "通用": A["generic"]},
                         ensure_ascii=False, indent=1 if a.pretty else None))
        return
    t = a.term.strip().lower()
    for hero, al in A["heroes"].items():
        if t == hero.lower() or t in [x.lower() for x in al]:
            print(json.dumps({"term": a.term, "meaning": display_name(hero), "type": "英雄",
                              "note": "本地叫法表仅提供检索线索，实体含义和正式名以知识检索原文为准"}, ensure_ascii=False))
            return
    for kind, table in (("搭档", A["combos"]), ("梗", A["memes"]), ("技能黑话", A["slang_skills"])):
        for k, v in table.items():
            if t == k.lower():
                print(json.dumps({"term": a.term, "meaning": [display_name(x) for x in v], "type": kind}, ensure_ascii=False))
                return
    print(json.dumps({"term": a.term, "found": False,
                      "next": "这个叫法不在对照表里：自己联网搜一下是什么意思，搜到的只作本次参考"}, ensure_ascii=False))
    sys.exit(1)


def cmd_guard(a):
    """对要发给玩家的草稿做出口检查：通过 exit 0；不通过 exit 2，stdout 给出改写指令。"""
    from . import guard
    text = a.text if a.text is not None else (open(a.file, encoding="utf-8").read() if a.file else sys.stdin.read())
    v = guard.verdict(text)
    print(json.dumps(v, ensure_ascii=False))
    sys.exit(0 if v["ok"] else 2)


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # argparse 默认退出码 2，会和「guard 不通过=2」冲突，统一成 1
        self.print_usage(sys.stderr)
        print(f"val-perler: {message}", file=sys.stderr)
        sys.exit(1)


PLAT_HELP = ("查哪一套资料：pc=端游，mb=手游。不传则看环境变量 VAL_PLATFORM；"
             "仍没有时 query 按问句自动判断（点明手游/手瓦就查手游），list/get 默认端游。get/list 要和刚才 query 用同一个")


def set_platform(a):
    """确定本次查哪个平台，并重设模块级 CATEGORY（所有检索函数读它）。"""
    global CATEGORY, PLATFORM
    import os
    want = getattr(a, "platform", None) or os.environ.get("VAL_PLATFORM") or "auto"
    why = "--platform" if getattr(a, "platform", None) else ("环境变量" if os.environ.get("VAL_PLATFORM") else "")
    if want == "auto":
        if getattr(a, "q", None) is not None:
            want, why = detect_platform(" ".join([a.q] + (getattr(a, "q2", None) or [])))
        else:
            want, why = "pc", "默认端游"
    if want not in PLATFORMS:
        want = "pc"
    PLATFORM, CATEGORY = want, PLATFORMS[want]
    a.platform_why = why


def main(argv=None):
    ap = _Parser(prog="val-perler", description=__doc__,
                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="grp", required=True, metavar="search")
    sp.parser_class = _Parser
    sh = sp.add_parser("search", help="找资料、列清单、取全文", description="找资料、列清单、取全文")
    s = sh.add_subparsers(dest="cmd", required=True, metavar="{query,list,get,alias,guard}", parser_class=_Parser)
    q = s.add_parser("query", help="按检索语句找资料", description="按检索语句找资料。一次返回前3篇原文(text)、前10篇摘要(summary)、前20个id(ids)；多个 -q 合并后去重。")
    q.add_argument("q", help="玩家原话；实体与正式名依据召回原文确认")
    q.add_argument("-q", dest="q2", action="append", metavar="另一条", help="再加一条检索语句，可重复")
    q.add_argument("--filter", action="append", metavar="维度=值", help="手动限定范围，如 英雄=捷风；一般不用（不传就是全库语义召回）")
    q.add_argument("--pretty", action="store_true", help="缩进输出")
    q.add_argument("--platform", choices=["pc", "mb", "auto"], help=PLAT_HELP)
    q.set_defaults(fn=cmd_query)
    l = s.add_parser("list", help="列出有哪些", description="列出有哪些。每页固定 30 条，用 --offset 翻页。路径为空列出顶层，英雄=全部特工，英雄/捷风=该特工的全部部分。")
    l.add_argument("path", nargs="?", default="", help="如 英雄、英雄/捷风、赛事与电竞/战队")
    l.add_argument("--part", "--leaf", dest="part", metavar="名称", help="跨所有下级取同名部分，如 --part 外观")
    l.add_argument("--match", metavar="正则", help="按名称或摘要搜整棵树")
    l.add_argument("--offset", type=int, default=0, help="翻页起点")
    l.add_argument("--pretty", action="store_true", help="缩进输出")
    l.add_argument("--platform", choices=["pc", "mb", "auto"], help=PLAT_HELP)
    l.set_defaults(fn=cmd_list)
    g = s.add_parser("get", help="按 id 或路径取全文", description="取整篇全文。第一次 query 给的前 3 篇也是整篇，一般直接读那批就够了。")
    g.add_argument("id", help="id，或 英雄/捷风/外观 这样的路径")
    g.add_argument("--pretty", action="store_true", help="缩进输出")
    g.add_argument("--platform", choices=["pc", "mb", "auto"], help=PLAT_HELP)
    g.set_defaults(fn=cmd_get)
    al = s.add_parser("alias", help="查一个叫法是什么", description="查玩家的叫法（外号、英文名、梗、技能黑话）对应什么；不带词则列出全部。")
    al.add_argument("term", nargs="?", help="如 奶妈、风姐、颗秒、弯闪")
    al.add_argument("--pretty", action="store_true", help="缩进输出")
    al.set_defaults(fn=cmd_alias)
    gd = s.add_parser("guard", help="发给玩家前自检", description="检查草稿里有没有不能让玩家看到的内部用语。通过退出码 0，不通过 2 并给出改写指令。")
    gd.add_argument("--text", help="草稿文字；不给则读 --file 或标准输入")
    gd.add_argument("--file", help="草稿文件")
    gd.set_defaults(fn=cmd_guard)
    a = ap.parse_args(argv)
    if a.fn in (cmd_query, cmd_list, cmd_get):
        set_platform(a)
    _apply_client_headers()  # 带上 X-WB-Id / X-UUID 供后端监控；拿不到就匿名检索
    try:
        a.fn(a)
    except SystemExit:
        raise
    except FileNotFoundError as e:
        print(f"val-perler: 找不到文件 {e.filename}", file=sys.stderr)
        sys.exit(1)
    except BusyError as e:
        note = _service_note(e)
        print("val-perler: 现在查的人有点多（不代表没有这条资料）"
              + (f"；服务说明：{note}" if note else "；等十几秒再试一次就好"), file=sys.stderr)
        sys.exit(1)
    except requests.RequestException as e:
        note = _service_note(e)
        print("val-perler: 检索服务暂时不可用（这不代表没有这条资料）"
              + (f"；服务说明：{note}" if note else "；稍后重试"), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
