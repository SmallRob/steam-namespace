# market-ratio-index-v1 —— 跨平台挂刀比价 ID 索引（分发副本）

> **源脚本在私有仓库** `SmallRob/steam-userscripts` 的 `scripts-tools/build-market-ratio-index.js`。
> 本目录是**分发副本**，供油猴脚本（steam-market-enhancer v1.9.0+）通过 jsDelivr 拉取。
> 改流程：先改源脚本并跑通，再覆盖本目录副本。
> 数据源：[SteamTradingSite-ID-Mapper](https://github.com/EricZhu-42/SteamTradingSite-ID-Mapper)（CC BY 4.0，2026-05 仍活跃维护）。

## 是什么

把 CS2(730) / DOTA2(570) 饰品在 **BUFF** 与 **悠悠有品(UUYP)** 的商品 ID 按
Steam `market_hash_name` 索引，供插件在市场详情页按需查平台在售价、算挂刀比例。
解决的场景：插件只有 Steam 单边价格，缺「Steam 挂单 vs 撤单转第三方平台」的判断依据。

## 文件

| 文件 | appid | 条数 | 原始体积 |
|---|---|---|---|
| `market-ratio-index-v1.730.json` | 730 | 34,402 | 2.16 MB |
| `market-ratio-index-v1.570.json` | 570 | 45,172 | 2.03 MB |
| `market-ratio-index-v1.manifest.json` | — | 构建元信息 | — |

结构：

```json
{ "ver": "2026-10-28T13:36:05.887Z", "count": 34402, "digest": "4d5174e3543f447b",
  "items": { "AK-47 | Redline (Field-Tested)": { "b": 33960, "u": 1414 } } }
```

- key 是 `market_hash_name`；value 里 `b`=BUFF goods_id，`u`=UUYP templateId（**可缺省**，570 无 u）
- `digest` = sha256(`name\tb\tu` 按名排序拼接) 前 16 位，只判内容不含时间；客户端据此换缓存
- UUYP 仅覆盖 730（mapper 侧如此）

## ⚠️ 缺值语义

**不在索引里 ≠ 该物品无第三方数据源故障，表示 mapper 未收录该映射**（如涂鸦/徽章类）。
客户端应如实提示「无第三方平台数据」，不得把缺值渲染成 0 或报错。

## 使用注意

- BUFF/UUYP 价格恒为 **CNY**；非 CNY 钱包需自行汇率换算后再算比例
- 平台接口可能变化（IGXE/C5 2026 年实测已要求登录）；接入方必须有熔断与如实降级
- 请求限速建议 ≥1500ms/件，429/403 立即熔断
