# v2 总体架构

## 核心原则

v2 只有一套生成引擎。`src/engine/` 不得依赖已删除的旧战斗模块，也不存在备用生成器或降级脚本。

```text
Stage code / local JSON
  -> PRTSMapLoader
  -> PRTSMapAdapter
  -> extractStageFacts
  -> EncounterContext
  -> squad Beam (operator + skill)
  -> deployment Beam + cheap scoring
  -> bounded skill engagement scoring
  -> ScriptValidator + MAAProtocolValidator
  -> ScriptExporter
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
```

## 引擎模块

- `StageFacts.ts`：从 `MapData` 提取敌人数、HP、路线、15 秒压力窗口和部署资源。
- `CombatModel.ts`：严格加载 `operatorCombat.v2.json`，解析默认或玩家 E2 档案，并提供进程内缓存。
- `EncounterContext.ts`：保留 15 秒窗口内的敌人、路线、防御、法抗和移动模式，构造能力需求。
- `CandidateBuilder.ts`：从完整模型目录按队伍边际收益搜索 `(operator, skill)`，再构造点位、朝向和动作。
- `Scoring.ts`：计算基础交战与技能交战，以及点位、费用、语料、功能覆盖和自动化评分。
- `index.ts`：使用宽度 32 的 squad Beam 和最多 512 个廉价完整候选；昂贵层按 64 / 192 / 384 自适应预算评分。

引擎输出固定编队。任何候选若违反占位、声明干员、部署格或协议约束会被拒绝；所有候选均失败时抛出错误。

## 反馈

`.maafight/generations.jsonl` 保存脚本 hash、stage 内容 hash、GameData commit、模型版本、分项评分和玩家库 hash。`.maafight/feedback.jsonl` 保存 `killed / total`。

只有同关卡内容、同玩家库和同 `v2-skill-v1` 引擎版本的 100% 结果可以复用；旧 v2 记录可读取但不会作为新引擎成功缓存。低于 100% 的脚本 hash 被排除。

## 依赖边界

- engine 可以依赖规范化数据、语料模型、静态战斗数据、玩家库和 copilot exporter。
- adapter 不生成部署顺序或战术建议。
- copilot 层不做战斗判断。
- runner 层可以调用外部 MAA，但不得被 engine 依赖。
- 默认执行评估必须走演习保护；普通理智作战只能显式开启。
- CLI 和 GUI 不实现自己的生成分支，只调用同一 pipeline / engine。
