# name-cn-index-v1 —— Steam appid → 中文名 索引（分发副本）

> **源文件与构建流程在私有仓库** `SmallRob/steam-userscripts` 的 `data-hub/scripts/build-name-cn-index.js`。
> 本目录是**分发副本**，供油猴脚本通过 jsDelivr 拉取。
> 改流程：先改源脚本并跑通，再覆盖本目录的副本。

## 是什么

把 data-hub 里**已确证是中文**的游戏名按 Steam appid 索引，给插件做「零请求取中文名」兜底。
解决的场景：hub 不可达 / 未配置 hub / 首屏抢跑 / 不想为一个名字打一次 appdetails。

## 文件

| 文件 | 内容 | 条数 | gzip |
|---|---|---|---|
| `name-cn-index-v1.json` | **hot**（owned ∪ wishlist），插件首屏默认用这个 | 4,535 | 62.6 KB |
| `name-cn-index-v1.all.json` | 全库，只在「全库补名」场景用 | 10,738 | 152.4 KB |
| `name-cn-index-v1.manifest.json` | 构建元信息：`digest` / 条数 / 体积 / 覆盖率 | — | — |

结构：

```json
{ "ver": "2026-10-26T00:33:28.619Z", "count": 4535, "digest": "df195549abd760f2",
  "names": { "10": "反恐精英", "220": "半条命2", "292030": "巫师3：狂猎 — 重制版" } }
```

- key 是 **appid 的字符串形式**（JSON 键只能是字符串），value 是中文名；
- `digest` 是 `appid\t名字` 全量拼接后的 sha256 前 16 位 —— **只判内容，不含时间**。
  同一份数据重跑 digest 不变，客户端据此决定是否替换本地缓存（别用 `ver` 判，`ver` 每次都变）；
- 用对象而不是数组对，客户端 `map[appid]` 直接 O(1)，解析后不需要再建索引。

## ⚠️ 缺值语义：不在表里 ≠ 名字为空

**不在索引里的 appid 表示「库里没有确证的中文名」，不是「这游戏叫空字符串」。**
客户端必须回退到 `app.name`（英文名）或占位名，不能把缺值渲染成空白。

## 覆盖率与天花板

| 口径 | 值 |
|---|---|
| 热集（热集 9,052 个 appid） | **4,535 = 50.1%** |
| 全库（160,704 行 app） | 10,738 = 6.7% |

全库只有 6.7% 不奇怪：`app` 表 16 万行里绝大多数 appid 从没采过 appdetails，`name_cn` 本来就是 NULL。
**热集 50.1% 才是插件该看的数字。**

这 50.1% 已经是当前数据条件下的上限附近：

- 2026-10-26 做过一次清洗，`app.name_cn` 非空 19,405 行里有 **8,667 行（44.7%）根本不含中文**
  （值是英文 fallback）。清洗后非空 10,738 行**全部确证含中文**，本索引就是基于清洗后的数据导出。
- `IStoreBrowseService/GetItems(language=schinese)` 对**没做本地化**的游戏会回英文
  （Balatro / Stardew Valley / Terraria / Hades 实测均回英文）。随机抽 300 个热集 appid 实测，
  只有 **29.3%** 返回中文名 —— 所以「靠 Steam 官方接口预热」最多把热集从 50.1% 推到约 60%。
- 剩下约 40% 只存在于社区/第三方来源（库里 `半条命2`、`传送门2`、`反恐精英` 这批就是历史导入的）。
  **Steam 官方永远不会给这些老游戏返回中文名**，别再试图用接口补。

## 用法

jsDelivr（**用 `@main`，不要钉 commit**）：

```
https://cdn.jsdelivr.net/gh/SmallRob/steam-namespace@main/data/name-cn-index-v1.json
```

这里是**数据**索引，每天随 hub 同步变化 —— 钉死某个 commit 就等于永远停在发布当天的条数。
（和 lib 类代码相反：代码要钉 commit 保证行为不变，数据要跟分支才能更新。）
jsDelivr 对分支引用缓存约 12 小时，配合客户端 7 天 TTL + `digest` 比对，实际最坏晚 7 天跟进，
对「游戏中文名」这种低频变化的字段完全够。

**不要用 `@require`** —— `@require` 要求 JS，这是纯 JSON；而且 85 KB 的同步阻塞加载
会拖慢插件启动。正确姿势是运行时异步拉 + 本地缓存。

客户端参考实现（SWE 1.4.18 起）：

```js
// 1) 先读 GM 缓存，同步可用、零请求（首屏就能用上）
// 2) 过期（TTL 7 天）后后台静默更新；失败就用旧缓存，绝不阻塞 UI
// 3) digest 相同 → 只刷新 fetchedAt，不做无谓写盘
// 4) 查名优先级：缓存中文 > 索引中文 > 缓存英文 > 批量 GetItems
// 5) 不把整表灌进名字缓存（否则每次 save 都要序列化 200 KB+），只按需单条写
```

## 重新生成

```bash
node data-hub/scripts/build-name-cn-index.js --emit=namespace --out=C:/workspace/steam-namespace/data
# 同源脚本不带 --emit 时仍输出到 <dataDir>/exports/name-cn-index/（本地调试用）
```

前置条件：先跑 `node data-hub/scripts/clean-name-cn.js --apply` 完成英文污染清洗，
**否则等于把英文名当中文名分发给所有插件**（这也是当初先清洗后导出的原因）。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-26 | 首次上架。hot 4,535 / all 10,738，均已剔除 8,667 条英文污染 |
