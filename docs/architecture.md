# v2 总体架构

## 核心原则

GUI / pipeline 只提供两条显式路线：`rule-core` 使用 v2 确定性引擎；`deepseek-core` 使用 DeepSeek API 规划、再由本地确定性编译器校验。两者共用 copilot 导出与验证，任何 DeepSeek 候选都不能绕过本地校验或演习发布门槛。

默认关卡、敌人、干员战斗数据与生成知识固定到同一 GameData commit。加载器按快照隔离旧缓存；上游缺失关卡文件或不支持的路径语义会明确报错。

```text
Stage code / local JSON
  -> PRTSMapLoader
  -> PRTSMapAdapter
  -> RouteTimeline + temporal StageFacts
  -> EncounterContext
  -> squad Beam (operator + skill)
  -> joint deployment Beam (operator + skill + cell + direction)
  -> manual Skill plan or SkillDaemon
  -> final deployment timeline + feasibility gates
  -> bounded skill engagement scoring
  -> ScriptValidator + MAAProtocolValidator
  -> ScriptExporter
```

```text
deepseek-core
  -> 固定应用层 Prompt + 关卡 / 地图 / 玩家干员上下文
  -> DeepSeek chat completions
  -> BattleDSL + ScriptValidator + MAAProtocolValidator
  -> output/.candidates/（静态合法的内部候选）
  -> GUI 三星演习后发布到 output/
```

执行评估层独立于生成链路：

```text
BattleScript
  -> Navigator
  -> SafetyGate
  -> MAA Executor
  -> Observer
  -> FeedbackStore
```

该层用于真实评测生成结果，不改变 `src/engine/` 的职责。详见 [MAA 执行评估层](maa-execution.md)。

## 目录职责

```text
src/
  adapter/    PRTS.Map 到 MapData 的结构化转换
  copilot/    MAA 协议验证、内部验证和 JSON 导出
  core/       CLI / GUI 共享 pipeline
  engine/     v2 唯一战斗生成引擎
  feedback/   生成记录与实战反馈
  runner/     MAA 探测、执行边界、演习保护和结果观测
  loader/     关卡、敌人数据库与索引加载
  player/     玩家干员库
  gui/        本地 HTTP API
  deepseek-core/ 固定 Prompt、API 调用与候选确定性编译
```

## 引擎模块

- `StageFacts.ts`、`RouteTimeline.ts`、`TemporalPressure.ts`：从 `MapData` 逐秒展开出生、移动和等待，汇总 15 秒关键压力窗口与未知路线覆盖缺口。
- `CombatModel.ts`：严格加载 `operatorCombat.v2.json`，解析默认或玩家 E2 档案，并提供进程内缓存。
- `SkillWindow.ts`：按部署、撤退、初始 SP、完整回转和显式开技时刻，计算窗口内常态 / 技能秒数及总伤；常态与技能范围分开使用，未知机制保留 gap。
- `OperatorKnowledge.ts`：加载可选的 `operatorKnowledge.v1.json`，提供策略、空间、向量与相似回退；新干员可继承相似战斗档案而不改 planner。
- `EncounterContext.ts`、`EnemyMechanics.ts`：从时序压力和敌人机制构造能力需求，不可建模的机制保留为 coverage gap。
- `JointPlanner.ts`、`CandidateBuilder.ts`：先搜索不冲突的 `(operator, skill, cell, direction)` 联合位置，再编码前线职责、医疗覆盖、撤退、已知冷却的再部署和官方 MAA 动作。
- `DefensePlanner.ts`：从实际 WALK 路径提取拦截点，保留同一蓝门的多个入口，按首敌到达时限、初始费用上限和自然回费预算安排防线；输出 `metadata.defensePlan` 供核查。1.5 真实秒的单次部署余量是规划假设。
- `TimelinePlanner.ts`、`Feasibility.ts`：从出生、火力区、蓝门、飞行、Boss 和费用事件推导条件时间线；检查费用、位置与部分火力 / 路线门槛。生存风险和防线到位时限保留缺口，不作为精确战斗结论。
- `SkillPlanner.ts`：仅在技能类型、SP 与关键窗口均可验证时输出条件 `Skill`；否则使用 `SkillDaemon`，两者互斥。
- `Scoring.ts`、`index.ts`：对已通过硬约束的候选执行确定性排序；`candidateScore` 仅用于候选排序。

引擎输出固定编队。任何候选若违反占位、声明干员、部署格或协议约束会被拒绝；所有候选均失败时抛出错误。

## 反馈

`.maafight/generations.jsonl` 保存脚本 hash、stage 内容 hash、GameData commit、模型版本、分项评分和玩家库 hash。`.maafight/feedback.jsonl` 的 v3 记录可额外保存首次漏怪、干员死亡、部署失败、剩余敌人与机制标签。

只有同关卡内容、同玩家库、同 GameData commit 和同 `v2-defense-skill-window-v3` 引擎版本的 100% 结果可以复用；旧记录仍可读取。相同 revision 的失败反馈只形成有限的开局、对空、爆发、治疗、费用和路线排序偏置，不能绕过可行性硬约束；低于 100% 的脚本 hash 被排除。

## 依赖边界

- engine 可以依赖规范化数据、语料模型、静态战斗数据、玩家库和 copilot exporter。
- adapter 不生成部署顺序或战术建议。
- copilot 层不做战斗判断。
- runner 层可以调用外部 MAA，但不得被 engine 依赖。
- 默认执行评估必须走演习保护；普通理智作战只能显式开启。
- CLI 和 GUI 不实现自己的生成分支，只调用同一 pipeline / engine。
- DeepSeek 连接直接使用原生 `fetch` 和 `.env` 中的 `DEEPSEEK_API_KEY`，不引入 Provider 抽象或外部 SDK。
- DeepSeek 的固定 Prompt 不接受用户自由战术要求；输入只包含关卡事实、合法部署点、路线、敌人和当前玩家干员 / 技能。
- `deepseek-core` 将 `MANUAL`、`AUTO`、`PASSIVE` 技能类型提供给规划模型：仅手动技能可生成 `Skill`；条件撤退和手动技能条件使用 MAA 原生字段，含 `elapsed_time` 的候选在编译时自动从 `ResetStopwatch` 开始计时。
