# v2 总体架构

## 核心原则

v2 只有一套生成引擎。`src/engine/` 不得依赖已删除的旧战斗模块，也不存在备用生成器或降级脚本。

```text
Stage code / local JSON
  -> PRTSMapLoader
  -> PRTSMapAdapter
  -> extractStageFacts
  -> CandidateBuilder
  -> Scoring
  -> Beam Search
  -> ScriptValidator + MAAProtocolValidator
  -> ScriptExporter
```

## 目录职责

```text
src/
  adapter/    PRTS.Map 到 MapData 的结构化转换
  copilot/    MAA 协议验证、内部验证和 JSON 导出
  core/       CLI / GUI 共享 pipeline
  engine/     v2 唯一战斗生成引擎
  feedback/   生成记录与实战反馈
  loader/     关卡、敌人数据库与索引加载
  player/     玩家干员库
  gui/        本地 HTTP API
```

## 引擎模块

- `StageFacts.ts`：从 `MapData` 提取敌人数、HP、路线、15 秒压力窗口和部署资源。
- `CandidateBuilder.ts`：独立完成选人、点位、朝向、费用条件和动作构造。
- `Scoring.ts`：计算局部交战、点位、费用、语料、功能覆盖与自动化评分。
- `index.ts`：评估 3 组选人、3 组点位、3 组时序组合，保留宽度 24 的 Beam。

引擎输出固定编队。任何候选若违反占位、声明干员、部署格或协议约束会被拒绝；所有候选均失败时抛出错误。

## 反馈

`.maafight/generations.jsonl` 保存脚本 hash、模型版本、分项评分和玩家库 hash。`.maafight/feedback.jsonl` 保存 `killed / total`。

同关卡、同玩家库的 100% 结果可以复用；低于 100% 的脚本 hash 被排除。反馈调整权重为 `min(0.35, n / (n + 10))`。

## 依赖边界

- engine 可以依赖规范化数据、语料模型、静态战斗数据、玩家库和 copilot exporter。
- adapter 不生成部署顺序或战术建议。
- copilot 层不做战斗判断。
- CLI 和 GUI 不实现自己的生成分支，只调用同一 pipeline / engine。
