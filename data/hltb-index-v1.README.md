# hltb-index-v1 —— HLTB ↔ Steam appid 索引（分发副本）

> **源文件与构建流程在私有仓库** `SmallRob/steam-userscripts` 的 `hltb-scraper/` 目录。
> 本目录是**分发副本**，供油猴脚本 / 浏览器扩展通过 jsDelivr 拉取。
> 改流程：先改源文件并跑测试，再覆盖本目录的副本。

## 是什么

把 HowLongToBeat 的游戏数据（发行年份 + 剧情时长）按 **Steam appid** 索引，
供 SGLV「库分析 / 游玩分析」Tab 做年代分布与剧情完成度（SCI）分析。

## 文件

| 文件 | 内容 |
|---|---|
| `hltb-index-v1.0.json` … `.7.json` | 8 个分片，列存三数组 `ids` / `years` / `story` |
| `hltb-index-v1.manifest.json` | 构建元信息：条目数、覆盖率、`shardRule`、分片清单 |
| `hltb-index-v1.reference.json` | **参考分布**：HLTB 全人口年代分布 + 样本偏差表 |

分片结构（每片）：

```json
{ "v":1, "builtAt":"...", "shard":0, "count":4421,
  "ids":[...], "years":[...], "story":[...] }
```

- `ids`   —— Steam appid（升序）
- `years` —— HLTB 发行年份
- `story` —— 主线剧情时长（小时）；**0 表示 HLTB 无此数据**，不是「剧情 0 小时」

## ⚠️ 分片规则：`shard = (appid >> 1) % 8`

**不要改成 `appid % 8`。**

Steam 全量 82,494 个 appid 中 **99.90% 是偶数**（只有 86 个奇数）。
用 `appid % 8` 会让 1/3/5/7 四片几乎为空（离散度 99.9%）；
用 `(appid >> 1) % 8` 离散度仅 **2.9%**。

`manifest.shardRule` 字段记录了这条规则，运行时（`PTW_HOST.hltb`）按同一公式算分片。
**两边不一致 = 静默查不到数据**，所以这个字段是硬约束，不是元信息。

## 覆盖率与样本偏差

| 指标 | 值 |
|---|---|
| HLTB 唯一记录 | 73,282 |
| 匹配到 Steam appid | 38,124（52.0%） |
| 索引内条目（按年-有效键口径） | 35,272（**54.6%**） |
| **理论覆盖率上限** | **55.3%**（再人工处理 unmatched 也只多 3.3pt） |
| 结构性缺失 | 32,763（44.7%）= 主机独占游戏，**无 Steam 版，永久缺口** |

**⚠️ 年代分布有系统性偏差**（已匹配 − HLTB 全人口）：

| 年代桶 | 已匹配 | 全人口 | 偏差 |
|---|---|---|---|
| pre04（2004 前） | 3.6% | 18.4% | **−14.8pt** |
| 04-14 | 9.6% | 18.3% | **−8.7pt** |
| 15-24 | 68.3% | 49.5% | **+18.8pt** |
| 25+ | 18.4% | 11.1% | **+7.3pt** |

⇒ 直接画「已匹配部分」的年代环会**系统性夸大近年占比**（最大 18.8pt）。
⇒ UI 必须用**双环对照**（外环 = 已匹配 / 内环 = 全人口参考），本目录的
`reference.json` 就是内环数据源。

## 重新构建

在私有仓库 `SmallRob/steam-userscripts` 根目录：

```bash
# ① 从匹配表生成 appmap（hltbId + appid）
python3 -c "
import csv, json
with open('/tmp/full-appmap.jsonl','w') as w:
    for r in csv.DictReader(open('hltb-scraper/hltb-steam-map.csv')):
        if r.get('steamAppid'):
            w.write(json.dumps({'hltbId':int(r['hltbId']),'appid':int(r['steamAppid']),'name':r.get('name','')})+'\n')
"

# ② 构建（--unmatched 用于产出参考分布，抵消年代偏差）
node hltb-scraper/build-index.js --mode appid \
     --appmap /tmp/full-appmap.jsonl \
     --unmatched hltb-scraper/hltb-steam-unmatched.jsonl \
     --outdir <steam-namespace>/data \
     --prefix hltb-index-v1
```

构建脚本幂等：重复执行产出相同内容（`builtAt` 时间戳除外）。

## 消费方

`steam-game-library-viewer` 的 `PTW_HOST.hltb`（v2.32.0）：

```
https://cdn.jsdelivr.net/gh/SmallRob/steam-namespace@main/data/hltb-index-v1.{0..7}.json
https://cdn.jsdelivr.net/gh/SmallRob/steam-namespace@main/data/hltb-index-v1.manifest.json
https://cdn.jsdelivr.net/gh/SmallRob/steam-namespace@main/data/hltb-index-v1.reference.json
```

CDN 根路径可用 GM 值 `sglv_hltb_base` 覆盖（自建镜像 / 换源）。
