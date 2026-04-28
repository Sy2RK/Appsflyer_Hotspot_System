# AppsFlyer 数据对齐口径

## 总原则

- 与 AppsFlyer Dashboard/Pivot 对齐的数据统一使用 Master/Pivot 口径。
- 每个对外展示的官方指标必须能追溯 `snapshot_id`、`metric_scope`、`source_surface`、`window_from`、`window_to`、`timezone`、`currency`、`is_provisional`。
- 每日 10:00 推送允许使用当时可用的官方快照；如果 AppsFlyer 后续修正，系统必须用新的快照刷新飞书表并保留对账记录。

## 窗口矩阵

| metric_scope | 对齐面 | 用途 | 口径说明 |
| --- | --- | --- | --- |
| `dashboard_selected_window` | Master/Pivot | Dashboard/Pivot 任意日期范围对齐 | 使用用户选择的闭区间日期，`timezone=preferred`，`currency=preferred` |
| `daily_push_d1` | Master/Pivot 或 Daily Report | 每日 10:00 推送和飞书多维表格 | 默认前一自然日，必须标注快照版本 |
| `recent_unstable_window` | Master/Pivot + checksum | D-1 至 D-7 自动修正 | 10:00-18:00 每 30 分钟对账 |
| `retro_window` | Master/Pivot | D-8 至 D-35 历史追溯 | 每日回刷，覆盖 7/14/30 日看板 |
| `mature_d7_roas` | Cohort API | D7 ROAS / CPP 决策 | 默认排除最近 7 天未成熟 install date |
| `raw_realtime_window` | Raw Data / Push API | 实时观测和事件补充 | 不承诺与 Dashboard 完全一致 |
| `decision_window` | System derived | 投放建议 current eCPI/current cost | 只用于决策，不能命名为官方 Dashboard 指标 |

## ASA 关键词

- Dashboard 对齐使用 Master API: `groupings=pid,c,af_adset,af_keywords`，`kpis=cost,installs,average_ecpi`，`pid=Apple Search Ads`。
- `cost / installs / average_ecpi` 来自 Master/Pivot；Raw Data 只补充 keyword、事件和收入。
- 推荐系统的 `current_ecpi` 是决策窗口指标，默认不是当前 Dashboard 选择窗口。
- D7 ROAS 只在成熟窗口展示；本地事件回退必须标为 fallback。

## 同步状态

- `ready`: 快照已获取且当前不是易变窗口。
- `provisional`: 快照来自近两天，AppsFlyer 仍可能修正。
- `corrected`: 同一窗口后续快照 checksum 发生变化。
- `stale`: 当前窗口没有可用官方快照。
- `failed`: AppsFlyer 请求失败或被限流。
