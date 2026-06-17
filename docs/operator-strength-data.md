# 干员强度数据维护说明

## 定位

`src/data/operatorStrength.cn.json` 是 MAAfight 的离线强度先验数据。

它不是游戏官方数据，也不是通关证明。它只用于脚本生成阶段的干员选择排序、metadata 调试信息和 warning 提示。

MAAfight 仍然不做完整战斗模拟，不模拟普攻、技能轴、天赋、模组、索敌或治疗目标，也不承诺生成脚本一定通关。

## 数据来源

强度数据来自社区资料和玩家共识的人工整理，采用版本化 seed 数据维护。

不同榜单、不同环境、不同练度和不同关卡会有争议，因此本项目不采用单一全局榜作为唯一依据，而是同时维护：

- `globalTier`：泛用强度档位。
- `globalPowerScore`：0-100 的全局强度先验。
- `roleScores`：按 `BattleTask` 记录任务适配强度。
- `tags`：描述爆发、站场、回费、治疗、控制、自动化友好度等能力。
- `automationScore`：对 MAA 自动作业和 SkillDaemon 的适配度。
- `confidence`：当前资料可信度。低置信度数据会被降权。

## 为什么按任务给分

同一个干员在不同任务上的价值差异很大。

例如：

- 玛恩纳适合 `physical_dps` 和 `boss_kill`，但不应被用于 `healing`。
- 纯烬艾雅法拉适合 `healing`，但不应被用于 `boss_kill`。
- 伊内丝适合 `early_dp`，同时也能提供一定 `elite_control`。
- 桃金娘星级低，但 `early_dp` 和低星高价值评分很高。

因此强度数据必须维护 `roleScores`，而不是只写一个总榜。

## 修改方法

新增或修改干员时，编辑 `src/data/operatorStrength.cn.json`。

最小条目示例：

```json
{
  "name": "示例干员",
  "aliases": ["Example"],
  "sourceVersion": "cn-community-seed-2026-06",
  "sourceNotes": ["人工整理，需随社区共识更新。"],
  "globalTier": "A",
  "globalPowerScore": 82,
  "roleScores": {
    "physical_dps": 86,
    "boss_kill": 76
  },
  "tags": ["physical_dps", "burst_dps"],
  "automationScore": 78,
  "modulePriority": "recommended",
  "skillPriority": ["S3"],
  "confidence": "medium"
}
```

维护规则：

- `globalPowerScore` 和 `roleScores` 都必须在 0-100。
- 只给真实适配的任务打高分，不要所有任务都填高。
- 自动技能稳定、挂机友好的干员可加 `afk_friendly` 或 `skill_daemon_friendly`。
- 依赖精确开技能、站位或手动轴的干员应加 `high_precision_required`。
- 低星但实战价值高的干员可加 `low_rarity_core` 和 `lowRarityValueScore`。
- 争议较大的条目使用 `confidence: "medium"` 或 `"low"`。

## 生成器如何使用

`ScriptGenerator` 会综合：

- 任务匹配度
- 强度先验
- 当前任务强度
- 玩家养成练度
- 自动化适配度
- 粗费用 / 部署成本

有玩家干员库时，只会从玩家拥有干员中选择。没有高强度候选时，仍允许低强度或缺数据干员兜底，但会在 `metadata.warnings` 和 `metadata.operatorSelectionTrace` 中说明原因。

`metadata.operatorSelectionTrace` 用于 GUI 展示和调试，不会写入 MAA copilot 导出 JSON 的协议字段。

强度数据也会影响默认技能和推荐模组：

- `skillPriority` 用于优先选择导出的 `skill`。
- `modulePriority` 可转成推荐 `requirements.module` / `requirements.module_level`。
- `high_precision_required` 只能用于风险提示和排序，不得单独作为“禁止交给 `SkillDaemon`”的理由。

具体导出约束见 [MAA Copilot 导出契约](maa-copilot-export-contract.md)。
