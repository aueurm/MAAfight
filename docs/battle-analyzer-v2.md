# BattleAnalyzer 与轻量规划

## 背景

早期 `BattleAnalyzer` 主要根据出怪数量和高威胁区域做职业需求估算。当前版本已经扩展为“分析 + 轻量规划”两段：

```text
MapData
  -> BattleAnalyzer
  -> TacticalAnalysis
  -> BattlePlanner
  -> pressureWindows / recommendedTasks / positionHints
```

这仍然是规则化分析，不是 AI / LLM，也不是完整战斗模拟。

## 输入

`BattleAnalyzer` 的输入是 `MapData`：

- 地图瓦片和可部署点。
- 敌人路线。
- 出怪时间线。
- 敌人 HP / ATK / DEF / RES / Boss / Elite 信息。
- 关卡部署上限、初始费用、自然回费间隔。

当敌人详情缺失时，分析器使用保守默认值，保证仍能生成合法 JSON。

## 输出

核心输出是 `TacticalAnalysis`：

- `enemyComposition`：敌人总数、普通 / 精英 / Boss 数、总 HP、平均 DEF。
- `requirements`：职业数量需求，作为 fallback 继续保留。
- `keyTimings`：首批敌人、高压窗口、Boss 等关键时机。
- `threatPriorities`：高防、高攻、飞行、Boss 等威胁提示。
- `suggestedStrategy`：规则化策略标签和说明。
- `dpsRequirement`：Boss 输出窗口的粗略估算。
- `battlePlan`：轻量规划结果。
- `pressureWindows`：按时间窗口聚合的压力信息。
- `recommendedTasks`：供生成器消费的任务队列。

## Pressure Windows

`pressureWindows` 按固定时间窗口统计出怪压力。

每个窗口记录：

- 开始和结束时间。
- 敌人数。
- 总 HP。
- 总 ATK。
- 是否有飞行敌人。
- 是否有精英敌人。
- 是否有 Boss。
- 压力分数。

示意：

```typescript
{
  start: 30,
  end: 45,
  enemyCount: 8,
  totalHp: 24000,
  totalAtk: 2800,
  hasFlying: true,
  hasElite: false,
  hasBoss: false,
  pressureScore: 63
}
```

压力分数只用于排序、提示和任务推导，不代表通关概率。

## Recommended Tasks

`recommendedTasks` 用任务队列替代固定职业顺序。

当前任务类型：

- `early_dp`
- `lane_block`
- `lane_hold`
- `anti_air`
- `physical_dps`
- `arts_damage`
- `healing`
- `boss_kill`
- `elite_control`
- `support`
- `fast_redeploy`

推导依据包括：

- 职业需求 fallback。
- 高压窗口数量。
- 飞行路线或飞行敌人窗口。
- 高 DEF / 高 HP / Boss。
- 精英敌人窗口。
- 多路线压力。
- 部署上限。

任务队列会按优先级排序，并截断到关卡部署上限附近，避免生成过长队列。

## 与 ScriptGenerator 的关系

`ScriptGenerator` 优先使用：

1. `analysis.battlePlan.recommendedTasks`
2. `analysis.recommendedTasks`
3. `analysis.requirements`
4. `mapData.deploymentOrder`

这保证了新增规划信息缺失时仍能回退到旧逻辑。

生成器会根据任务选择候选职业和功能标签。例如：

- `early_dp` 更偏向先锋和回费。
- `anti_air` 更偏向狙击、防空和空中目标。
- `arts_damage` 更偏向术师和法伤。
- `healing` 更偏向医疗。
- `boss_kill` 更偏向爆发输出。

## 粗费用时间线

生成器使用 `DPTimeline` 做粗费用估算。

估算规则：

- 初始费用来自 `mapData.options.initialCost`。
- 自然回费由 `costIncreaseTime` 估算。
- 干员费用优先读取玩家干员数据中的 `cost`，否则使用职业默认费用。
- 如果连续部署会明显费用不足，则推迟下一个部署时间。

该时间线用于减少明显不合理的连续部署动作，不模拟击杀回费、先锋技能回费或关卡特殊费用规则。

## 部署点评分

`PositionScorer` 为部署点打分：

- 地面单位优先靠近敌人路径、蓝门和隘口。
- 远程单位优先覆盖更多敌人路线。
- 医疗优先覆盖已规划的核心阻挡位。
- 已使用点位会被跳过。
- 点位不足时回退到 `deploymentOrder`。

评分结果写入 `metadata.positionScoreSummary` 和 `metadata.deploymentReasons`。

## 干员选择

干员选择综合：

- 当前任务。
- 候选职业。
- 功能标签。
- 离线强度先验。
- 玩家干员库练度。
- 自动化适配度。
- 粗费用。

如果玩家干员库不足，生成器保留 `operatorGaps` 行为，并继续尽量生成可验证的 JSON。

## 边界

当前分析器不做：

- 干员攻击循环模拟。
- 技能轴模拟。
- 天赋、模组、召唤物模拟。
- 连续敌人移动与真实阻挡模拟。
- 索敌、治疗目标、前摇和攻速模拟。
- 击杀回费和先锋技能回费模拟。

完整边界见 [算法边界与路线说明](algorithm-boundary.md)。

## 测试关注点

测试应覆盖：

- 敌人详情完整时，HP / ATK / DEF 参与分析。
- 敌人详情缺失时，fallback 不崩溃。
- `pressureWindows` 能统计飞行、精英、Boss。
- `recommendedTasks` 能根据飞行、Boss、高防等压力变化。
- 生成器在新字段缺失时仍能生成合法 JSON。
- `operatorGaps`、费用时间线、点位评分写入 metadata。
