# 实测关卡列表

> 实测：2026-06-13 | `node scripts\benchmark.js --skip-build` | 38/38 checks passed | 10/10 关生成并验证通过 | 脚本验证均为 100/100

## 测试结果

`展示名` 来自 level index 的 `code` / `name` 字段；暂未映射游戏内关卡名的资源本、危机合约和 bossrush 关卡保留内部 ID 作为可用输入。

| # | 展示名 / 推荐输入 | 内部 ID | 类别 | 缓存路径 | 地图 | 部署点 | 路线 | 敌人总数 | 敌人种类 | 难度 | 验证 |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
| 1 | `GT-1` | `a001_01` | activity | `activities/a001/level_a001_01.json` | 7×10 | 24 | 18 | 42 | 2 | hard | 100 |
| 2 | `0-1`（坍塌） | `main_00-01` | main | `obt/main/level_main_00-01.json` | 6×9 | 28 | 7 | 11 | 2 | medium | 100 |
| 3 | `3-8`（黄昏） | `main_03-08` | main | `obt/main/level_main_03-08.json` | 8×11 | 38 | 22 | 63 | 8 | extreme | 100 |
| 4 | `H5-1`（炼狱行动-1） | `hard_05-01` | hard | `obt/hard/level_hard_05-01.json` | 8×12 | 30 | 48 | 62 | 7 | extreme | 100 |
| 5 | `weekly_armor_1` | `weekly_armor_1` | weekly | `obt/weekly/level_weekly_armor_1.json` | 7×8 | 30 | 9 | 22 | 4 | hard | 100 |
| 6 | `weekly_fly_1` | `weekly_fly_1` | weekly | `obt/weekly/level_weekly_fly_1.json` | 9×12 | 12 | 12 | 24 | 2 | medium | 100 |
| 7 | `乌萨斯` | `camp_01` | campaign | `obt/campaign/level_camp_01.json` | 8×11 | 41 | 112 | 400 | 19 | extreme | 100 |
| 8 | `crisis_v2_01-01` | `crisis_v2_01-01` | crisis | `obt/crisis/v2/level_crisis_v2_01-01.json` | 8×12 | 48 | 26 | 46 | 7 | extreme | 100 |
| 9 | `bossrush1_01` | `bossrush1_01` | activity | `activities/act1bossrush/level_bossrush1_01.json` | 10×18 | 58 | 34 | 57 | 9 | extreme | 100 |
| 10 | `GT-EX-1` | `a001_ex01` | activity | `activities/a001/level_a001_ex01.json` | 8×11 | 37 | 30 | 69 | 3 | hard | 100 |

## 类别覆盖

| 类别 | 关数 | 通过 |
| --- | ---: | --- |
| activity | 3 | 3/3 |
| main | 2 | 2/2 |
| hard | 1 | 1/1 |
| weekly | 2 | 2/2 |
| campaign | 1 | 1/1 |
| crisis | 1 | 1/1 |

## 运行方式

```bash
# 全量 benchmark
node scripts\benchmark.js --skip-build

# 单关测试
node dist/index.js generate --stage GT-1 --output out.json
node dist/index.js validate --file out.json
node dist/index.js info --stage bossrush1_01
```

## 数据真实性说明

- `GT-1`、`GT-EX-1`、`0-1`、`3-8`、`H5-1` 和 `乌萨斯` 已有游戏内展示名映射。
- `weekly_armor_1`、`weekly_fly_1`、`crisis_v2_01-01` 和 `bossrush1_01` 当前缺少完整展示名映射，因此文档保留内部 ID，避免伪造关卡名。
- 本轮修复了 PRTS.Map 数字枚举数据的解析：部分关卡使用 `0/1/2` 表示 tile、route、checkpoint 和 action 类型，不能只按字符串枚举读取。
