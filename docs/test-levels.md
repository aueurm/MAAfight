# 实测关卡列表

> 实测: 2026-05-23 | 10/10 全通过 | 平均验证 100/100

## 测试结果

| # | 关卡 ID | 类别 | 地图 | 路线 | 敌人 | 难度 | 验证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `a001_01` | activity | 7×10 | 20 | 2 | hard | 100 |
| 2 | `main_00-01` | main | 6×9 | 7 | 2 | easy | 100 |
| 3 | `main_03-08` | main | 8×11 | 26 | 8 | extreme | 100 |
| 4 | `hard_05-01` | hard | 8×12 | 51 | 7 | hard | 100 |
| 5 | `weekly_armor_1` | weekly | 7×8 | 9 | 4 | easy | 100 |
| 6 | `weekly_fly_1` | weekly | 9×12 | 12 | 2 | easy | 100 |
| 7 | `camp_01` | campaign | 8×11 | 177 | 19 | extreme | 100 |
| 8 | `crisis_v2_01-01` | crisis | 8×12 | 30 | 7 | extreme | 100 |
| 9 | `bossrush1_01` | activity | — | — | — | hard | 100 |
| 10 | `a001_ex01` | activity | 8×11 | 41 | 3 | hard | 100 |

## 类别覆盖

| 类别 | 关数 | 通过 |
| --- | --- | --- |
| activity | 3 | 3/3 |
| main | 2 | 2/2 |
| hard | 1 | 1/1 |
| weekly | 2 | 2/2 |
| campaign | 1 | 1/1 |
| crisis | 1 | 1/1 |

## 运行方式

```bash
# 全量测试
bash scripts/test-pipeline.sh

# 单关测试
node dist/index.js generate --stage a001_01 --output out.json
node dist/index.js validate --file out.json
```
