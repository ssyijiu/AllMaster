# 布锅锅资产 ID 速查

> 数据源 `val-api.buguoguo.cn/v1`（无畏协议库）。本文件是接口数据的**只读快照**，供检索时手工对 ID 用；正常运行用 `scripts/buguoguo_asset.py`，它实时调接口并带缓存。快照与真实库不一致时以脚本输出为准，`--refresh` 后仍对不上再查本文件是否过期。

- 接口版本：`release-china-13.08`（internal `13.08.00.5627795`，build 2026-10-01）
- 快照时间：2026-10-21
- 规模：英雄 29（+1 即将上线） · 武器 21 · 武器皮肤 1459 · 地图 27 · 主题 465 · 喷漆 929 · 卡面 1020 · 挂饰 890

## 接口端点

| 端点 | 内容 |
|---|---|
| `GET {base}/version` | 游戏版本（`data.branch` / `data.internalVersion`） |
| `GET {base}/agents?language=zh-CN` | 全部英雄（含外观、技能图标、能力） |
| `GET {base}/weapons?language=zh-CN` | 全部武器，`skins[]` 内嵌全部皮肤（含炫彩 `chromas[]` 与等级 `levels[]`），约 4.6 MB |
| `GET {base}/maps?language=zh-CN` | 全部地图 |
| `GET {base}/sprays / playercards / buddies` | 喷漆 / 卡面 / 挂饰，逐条平铺 |
| `GET {base}/themes?language=zh-CN` | 全部皮肤主题（系列） |
| `GET {base}/contenttiers?language=zh-CN` | 品阶 |

`{base}` = `https://val-api.buguoguo.cn/v1`。所有响应都是 `{"status":200,"data":...}`，`language` 不传时字段名偏英文。条目内所有图链字段值都是 `val-cdn.buguoguo.cn` 的直链。

## ID 规则

- 每类资产一条记录一个 **uuid**（小写、带连字符，Riot 原生格式），是全局唯一键：英雄 `agents[].uuid`、皮肤 `weapons[].skins[].uuid`、炫彩 `chromas[].uuid`、等级 `levels[].uuid`、地图/喷漆/卡面/挂饰/主题同理。
- 皮肤名以 **武器名结尾**（`2024全球冠军赛 幻影`），按武器查皮肤先定位武器再扫 `skins[]`；同一系列的皮肤分布在不同武器下（例如 2024 全球冠军赛系列 = 幻影 + 战刀 两款）。
- 英雄与皮肤靠 `contentTierUuid`（皮肤）/ `role`（英雄）关联品阶与定位，对应关系见下方常用值。
- 皮肤主题 uuid 在 `themeUuid` 字段：皮肤系列归属靠它权威判定；喷漆/挂饰/卡面的 `themeUuid` 多为空，只能按名称前缀归系列。
- 没有独立 roles 端点：定位信息在 `agents[].role`（uuid + displayName + displayIcon）。

## 图链规律（val-cdn）

```
https://val-cdn.buguoguo.cn/agents/{agent_uuid}/fullportrait.png        # 英雄立绘
https://val-cdn.buguoguo.cn/agents/{agent_uuid}/displayicon.png         # 英雄头像
https://val-cdn.buguoguo.cn/agents/{agent_uuid}/abilities/{slot}/displayicon.png
https://val-cdn.buguoguo.cn/skins/{skin_uuid}/displayicon.png           # 皮肤本体图
https://val-cdn.buguoguo.cn/skins/{skin_uuid}/chromas/{chroma_uuid}/fullrender.png
https://val-cdn.buguoguo.cn/skins/{skin_uuid}/{level_uuid}/displayicon.png
https://val-cdn.buguoguo.cn/contenttiers/{tier_uuid}/displayicon.png
```

皮肤常见图字段：`displayIcon`（图库小图）、`fullRender`（横版完整渲染，适合当生图参考）；等级字段 `levelItem` 是档位说明（检视与击杀特效等）。同为「图同本体」的炫彩/等级图链与本体相同，不必重复下载。视频字段（`streamedVideo` 等）一律不用。

## 常用值

### 品阶（contentTierUuid → 名称）

| 名称 | devName | uuid | |
|---|---|---| |
| 传奇 | Exclusive | `e046854e-406c-37f4-6607-19a9ba8426fc` | |
| 卓越 | Premium | `60bca009-4182-7998-dee7-b8a2558dc369` | |
| 精选 | Select | `12683d76-48d7-84a3-4e09-6985794f0445` | |
| 豪华 | Deluxe | `0cebb8be-46d7-c12a-d306-e9907bfc5a25` | |
| 终极 | Ultra | `411e4a55-4e59-7757-41f0-86a53f101bb5` | |

### 全球冠军赛主题 uuid

| 主题 | uuid |
|---|---|
| 2021全球冠军赛 | `ccf31eeb-429f-52dc-8447-dfb620ef6ffb` |
| 2022全球冠军赛 | `362829cc-4fe4-fcda-98e7-0dbdb4b3bea5` |
| 2023全球冠军赛 | `64934312-45d4-705f-dcf6-34b253ab1d67` |
| 2024全球冠军赛 | `577697d4-4b60-bbb1-4e36-3e8464b3a83e` |
| 2025全球冠军赛 | `3eca6fe2-4a8a-4fda-a27c-89b9c8c75d8f` |
| 2026全球冠军赛 | `e7d3ab91-4bc8-5f70-04aa-35b21a7962e7` |

### 英雄（29 位，1 位即将上线）

| uuid | 名称 | 定位 |
| --- | --- | --- |
| `0e38b510-41a8-5780-5e8f-568b2a4f2d6c` | 壹决 | 决斗 |
| `117ed9e3-49f3-6512-3ccf-0cada7e3823b` | 零 | 哨卫 |
| `1dbf2edd-4729-0984-3115-daa5eed44993` | 暮蝶 | 控场 |
| `1e58de9c-4950-5125-93e9-a0aee9f98746` | 奇乐 | 哨卫 |
| `22697a3d-45bf-8dd7-4fec-84a9e28c69d7` | 尚勃勒 | 哨卫 |
| `320b2a48-4d9b-a075-30f1-1f93a9b638fa` | 猎枭 | 先锋 |
| `41fb69c1-4189-7b37-f117-bcaf1e96f1bf` | 星礈 | 控场 |
| `569fdd95-4d10-43ab-ca70-79becc718b46` | 贤者 | 哨卫 |
| `5f8d3a7f-467b-97f3-062c-13acf203c006` | 铁臂 | 先锋 |
| `601dbbe7-43ce-be57-2a40-4abd24953621` | K/O | 先锋 |
| `6f2a04ca-43e0-be17-7f36-b3908627744d` | 斯凯 | 先锋 |
| `707eab51-4836-f488-046a-cda6bf494859` | 蝰蛇 | 控场 |
| `7c8a4701-4de6-9355-b254-e09bc2a34b72` | 迷核 | 控场 |
| `7f94d92c-4234-0a36-9646-3a87eb8b5c89` | 夜露 | 决斗 |
| `8e253930-4c05-31dd-1b6c-968525494517` | 幽影 | 控场 |
| `92eeef5d-43b5-1d4a-8d03-b3927a09034b` | 禁灭 | 哨卫 |
| `95b78ed7-4637-86d9-7e41-71ba8c293152` | 海神 | 控场 |
| `9f0d8ba9-4140-b941-57d3-a7ad57c6b417` | 炼狱 | 控场 |
| `a3bfb853-43b2-7238-a4f1-ad90e9e46bcc` | 芮娜 | 决斗 |
| `add6443a-41bd-e414-f6ad-e58d267f4e95` | 捷风 | 决斗 |
| `b444168c-4e35-8076-db47-ef9bf368f384` | 钛狐 | 先锋 |
| `bb2a4828-46eb-8cd1-e765-15848195d751` | 霓虹 | 决斗 |
| `cc8b64c8-4b25-4ff9-6e7f-37b4da43d235` | 钢锁 | 哨卫 |
| `dade69b4-4f5a-8528-247b-219e5a1facd6` | 黑梦 | 先锋 |
| `df1cb487-4902-002e-5c17-d28e83e78588` | 幻棱 | 决斗 |
| `e370fa57-4757-3604-3648-499e1f642d3f` | 盖可 | 先锋 |
| `eb93336a-449b-9c1b-0a54-a891f7921d69` | 不死鸟 | 决斗 |
| `efba5359-4016-a1e5-7626-b1ae76895940` | 维斯 | 哨卫 |
| `f94c3b30-42be-e959-889c-5aa313dba261` | 雷兹 | 决斗 |

> **即将上线**：Hush（第 31 号特工），决斗位，来自广东。2026-10-18 Champions 上海总决赛公布，预计 10 月 27 日上线（S26 Act VI）。国服中文名待官宣，上线后资产接口更新再补本表。

### 武器（21 类）

| uuid | 名称 | 皮肤数 |
| --- | --- | --- |
| `1baa85b4-4c70-1284-64bb-6481dfc3bb4e` | 鬼魅 | 69 |
| `29a0cfab-485b-f5d5-779a-b59f85e204a8` | 标配 | 202 |
| `2f59173c-4bed-b6c3-2191-dea9b58be9c7` | 近战武器 | 180 |
| `410b2e0b-4ceb-1321-1727-20858f7f3477` | 追猎 | 11 |
| `42da8ccc-40d5-affc-beec-15aa47b42eda` | 短炮 | 42 |
| `44d4e95c-4157-0037-81b2-17841bf2e8e3` | 狂怒 | 57 |
| `462080d1-4035-2937-7c09-27aa2a5c27a7` | 骇灵 | 78 |
| `4ade7faa-4cf1-8376-95ef-39884480959b` | 戍卫 | 70 |
| `55d8a0f4-4274-ca67-fe2c-06ab45efdf58` | 战神 | 49 |
| `5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c` | 莽侠 | 25 |
| `63e6c2b6-4a8e-869c-3d4c-e38355226584` | 奥丁 | 42 |
| `8db0a1bf-4a50-832a-4566-faaaa6d250ca` | 悍狼 | 5 |
| `910be174-449b-c412-ab22-d0873436b21b` | 雄鹿 | 46 |
| `9c82e19d-4575-0200-1a81-3eacf00cf872` | 狂徒 | 109 |
| `a03b24d3-4319-996d-0f8c-94bbfba1dfc7` | 冥驹 | 68 |
| `ae3de142-4d85-2547-dd26-4e90bed35cf7` | 獠犬 | 64 |
| `c4883e50-4494-202c-3ec3-6b8a9284f00b` | 飞将 | 53 |
| `e336c6b8-418d-9340-d77f-7a9e4cfe0702` | 正义 | 72 |
| `ec845bf4-4f79-ddda-a3da-0db3774b2794` | 判官 | 59 |
| `ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a` | 幻影 | 109 |
| `f7e1b454-4ad4-1063-ec0a-159e56b58941` | 蜂刺 | 49 |

## 与知识检索的关联

实体含义、国服正式名和端游/手游归属由 `无畏契约知识检索` 的原文确认。此表只保存端游资产名称与 uuid 的技术对应，不能证明玩家叫法、社区梗或赛事简称的含义。

知识条目已明确对应素材 uuid 时直接取图；否则用其正式名检索资产候选，核对英雄、系列、武器和具体图片类型后取图。知识路径与素材 uuid 是两个标识，通过命令的 `--knowledge-id` 随结果记录关联，名称相近本身不构成同一实体的证据。
