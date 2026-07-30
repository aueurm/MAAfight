# MAAfight 时空战术规划器设计

## 目标

在不改变 `generateCopilotScript(stageCode, mapData, options)`、CLI、GUI、反馈 JSONL 和 MAA Copilot v3 导出契约的前提下，将 v2 的“选完整队伍后静态落点”生成器升级为确定性的时空战术规划器。

候选分数始终只用于排序，不代表通关率或预计歼灭率。无法从关卡或干员数据确认的机制必须形成 `coverageGaps`，不能伪造精确模拟。

## 已确认边界

- adapter 只规范化数据，不生成部署顺序或战术结论。
- engine 不依赖 MAA runner；copilot 层不做战斗判断。
- 固定 12 人、`groups: []`、省略 `requirements`、内部 `[row, col]` 导出为 MAA `[x, y]` 的约束不变。
- 导出仅使用官方动作；内部事件不会导出 `Wait` 或 `SkillUse`。
- 模型、规划或协议校验失败时直接报错；合法静态候选不是演习通关证明。
- 现有 `schemaVersion` 1/2 反馈记录仍可读；新增字段一律可选。

## 总体架构

```text
PRTS.Map
  -> PRTSMapAdapter（路线 checkpoint、等待与敌人机制的结构化保留）
  -> RouteTimeline（每条路线的离散 cell/time 轨迹）
  -> TemporalPressure（time × cell × pressure）
  -> EncounterContext（需求、关键窗口、可信度缺口）
  -> JointPlanner（operator + skill + location + direction）
  -> TimelinePlanner / SkillPlanner（事件、费用、技能动作）
  -> Feasibility（硬约束）
  -> QualityScoring（只在可行候选间排序）
  -> ScriptValidator + MAAProtocolValidator + ScriptExporter

真实演习
  -> FeedbackStore
  -> FeedbackLearning（下一轮搜索偏置，不改变历史脚本）
```

`RouteTimeline`、`TemporalPressure`、`Feasibility`、`TimelinePlanner`、`SkillPlanner` 和 `FeedbackLearning` 都是纯函数模块。它们只接受规范化输入，输出可序列化数据，便于缓存、单元测试和确定性排序。

## 1. 路线与时空压力

### 规范化路线

`EnemyRoute` 保留当前 `id`、`motionMode`、起点、终点和可兼容的坐标 checkpoint，同时增加可选的 checkpoint 元数据：原始类型、等待秒数和是否可见。adapter 从 PRTS `MOVE`、`WAIT_FOR_SECONDS`、`WAIT_CURRENT_FRAGMENT_TIME`、`APPEAR_AT_POS` 与 `DISAPPEAR` 提取这些信息；无法换算为确定秒数的等待项记录为 `route_wait_unknown` coverage gap。

`RouteTimeline` 用曼哈顿相邻 cell 离散化起点、移动 checkpoint 和终点。每个 spawn 按敌人 `moveSpeed` 前进；显式等待会停留在 checkpoint。飞行路线同样产生位置轨迹，但不会产生阻挡压力。时间采用固定 1 秒 bucket，并只生成从最早出生到最晚离场的 bucket，避免无界状态。

### 压力图

每个 bucket/cell 保存以下累积量：

- `groundHp`、`airHp`、`incomingAttack`、`blockDemand`；
- `eliteWeight`、`bossWeight`、`goalThreat`、`mergeWeight`；
- 参与该压力的路线和敌人机制；
- `confidence` 与 `coverageGaps`。

临近蓝门的地面单位增加 `goalThreat`；多个路线同 bucket/cell 相交增加 `mergeWeight`；精英和 Boss 按固定、可测试的权重加权。`StageFacts.pressureWindows` 保留为兼容摘要，但改由压力图按 15 秒聚合生成，不能再只统计出生事件。

## 2. 敌人机制层

新增 `EnemyMechanics` 规范化类型：`stealth`、`unblockable`、`flying`、`invulnerable`、`multiPhase`、`revive`、`split`、`summon`、`deathExplosion`、`specialTargeting`、`antiHeal`、`elementalDamage`、`taunt`、`shiftImmune`、`tileInteraction`、`blockAmplified`、`damageReflect`。

机制来源按优先级为：已知 GameData 字段、项目静态标签、人工标签。不存在可信来源时不猜测；未知机制在 `coverageGaps` 中记录。机制转换成需求修正、位置惩罚、技能保留需求和硬约束，例如飞行提高对空门槛、不可阻挡降低纯阻挡收益、死亡爆炸惩罚近战密集部署、禁疗降低普通治疗的生存估计。

## 3. 联合部署搜索

替换“先完成 squad Beam，再逐人贪心落点”的主路径。`JointPlanner` 的一个 Beam 状态包含：

- 已选 `(operator, skill, location, direction)` 决策；
- 已占用格、部署顺序和费用余额；
- 按 bucket 计算的火力、对空、阻挡和治疗覆盖；
- 已满足与未满足的关键压力窗口；
- 机制风险、可信度缺口与确定性签名。

每个干员先用时空边际覆盖预选有限数量的高质量落点和朝向。Beam 扩展仅枚举这些局部候选，按位置冲突、火力重叠、医疗覆盖、前排保护、路线分散和关键格保留剪枝。保留低费先锋、快速复活和未部署后备作为时间线决策，而不是把所有 12 人同时视为场上单位。

固定 12 人的 `opers` 仍由最终选择的唯一干员填充；实际初始部署数受 `characterLimit` 约束。

## 4. 事件、费用与技能

`TimelinePlanner` 从压力图和联合计划生成内部事件：首批出生、首次进入火力区、关键压力开始、飞行波、蓝门威胁、Boss 出现/进入关键区、费用达标、部署冷却结束与覆盖即将消失。

费用时间线使用 `initialCost`、`maxCost`、`costIncreaseTime`、部署花费、部署顺序和冷却。干员回费能力仅在战斗模型或知识数据存在明确数值时加入；否则保持保守自然回复，并记录 `dp_recovery_unknown`。事件导出为合法的 `costs`、`kills`、`time_elapsed`、`cooling`、`pre_delay`、`post_delay` 和显式动作，不导出 `Wait`。

`ResolvedOperatorProfile` 暴露已有模型中的 `skillType`、`spType`、`spCost`、`initSp` 和 duration。`SkillPlanner` 将技能归类为自动循环、开局、持续暖机、爆发、Boss 保留、防御、紧急治疗、手动单次和被动：

- 没有手动保留需求的计划使用 `SkillDaemon` 处理普通自动循环；
- 有明确高压/Boss 事件的手动技能生成条件化 `Skill`；此时不混用 `SkillDaemon`，自动类型交由游戏原生触发；
- 无目标、无敌和低压窗口不会成为关键爆发触发点；
- 无法确认 SP 或机制的技能降级为覆盖缺口和保守评分，而非虚构可用时间。

## 5. 可行性优先评分

`Feasibility` 在质量评分前拒绝候选，至少校验：

1. 每个关键压力窗口的地面/空中有效伤害；
2. 地面路线的阻挡或替代控制；
3. 前排的治疗、生存或不可治疗机制处理；
4. 费用、部署顺序、格位和角色数量可执行；
5. 高优先级机制和关键技能有明确方案。

只有可行候选进入 `QualityScoring`。质量排序依次重视时空覆盖、战斗余量、生存/治疗、费用节奏、机制适配、协同、脚本稳定性，最后才使用轻量 corpus tie-breaker 和自动化便利性。`candidateScore` 继续写入 metadata，但说明仍为“候选排序”。

## 6. 反馈学习

反馈 schema 升为可兼容的 v3，保留现有 `killed / total / ratio`，并可选记录首次漏怪时间、路线/位置、干员死亡、部署失败、剩余敌人类型、Boss 阶段、技能错误时机、费用不足和失败机制标签。

`FeedbackLearning` 只从同关卡内容 hash、同干员库 hash、同引擎版本的可学习记录生成下一次 `SearchBias`：早期漏怪偏向低费/开局覆盖，路线漏怪提高对应 bucket/cell 权重，前排早死提高治疗/耐久，Boss 未击杀提高单体与保留技能，对空漏怪强化对空门槛，费用失败修正时间线。成功脚本复用与失败 hash 排除继续保留。

## 分阶段交付

1. **时空基础与可行性**：路线元数据、路线时间线、压力图、时空落点评分、费用时间线和硬约束；保持现有 squad Beam 作为过渡输入。
2. **联合规划与事件部署**：以 `(operator, skill, location, direction)` 扩展 Beam；由事件生成部署条件，删除固定 `0/250/500/750 ms` 变体。
3. **技能与机制适配**：暴露技能元数据、实现技能策略与机制标签/约束。
4. **反馈修正与收敛**：v3 反馈、失败分类、搜索偏置、缓存/版本隔离与端到端回归。

每阶段都维持 public API、CLI/GUI pipeline 和 MAA 导出测试通过；后续阶段只能替换 engine 内部实现，不能分叉生成入口。

## 验收证据

- 单元测试覆盖：等待 checkpoint、慢速/飞行路线、时间-cell 压力、Boss/汇流/蓝门权重、时空位置边际收益、费用不足拒绝、格位冲突、治疗/对空/阻挡硬约束、事件条件、技能互斥和机制 coverage gaps。
- `EngineV2` 证明同输入决定性，固定 12 人、空 groups、禁止动作和坐标转换不回归。
- `Pipeline`、`FeedbackStore`、`ScriptValidator`、`MAAProtocolValidator` 与 CLI 测试证明对外兼容。
- `npm run build:node`、`npm test`、`npm run corpus:audit` 和 `node scripts/benchmark.js --skip-build` 均通过；候选得分不得在文档或 CLI 表述为通关率。
