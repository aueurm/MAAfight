# 文档索引

## 推荐阅读顺序

1. [算法边界与路线说明](algorithm-boundary.md)

   先读这篇。它定义 MAAfight 为什么不做完整战斗模拟，以及近期算法只做轻量规划和部分半模拟辅助。

2. [总体架构](architecture.md)

   了解 CLI、GUI、pipeline、loader、adapter、battle 和 exporter 的模块边界。

3. [CLI 与 GUI 使用说明](cli-design.md)

   了解命令、GUI、operators JSON、本地目录和 release preview。

4. [MAA Copilot 导出契约](maa-copilot-export-contract.md)

   修改 `ScriptGenerator`、`ScriptExporter`、`MAAProtocolValidator`、`pipeline` 或 GUI 导出入口前必须读。它规定默认 fixed 12 人编队、`name` 字段净化、`groups` 边界、模组推荐和必要测试。

5. [数据格式规范](data-format.md)

   了解 `MapData`、`TacticalAnalysis`、`BattleScript`、metadata 和 MAA copilot JSON。

6. [BattleAnalyzer 与轻量规划](battle-analyzer-v2.md)

   了解 `pressureWindows`、`recommendedTasks`、粗费用、部署点评分和 fallback。

## 数据与集成

- [PRTS.Map 适配器设计](prts-map-adapter.md)
- [MAA 干员练度导出格式](maa-operator-export.md)
- [MAA Copilot 格式理解与生成策略](maa-copilot-format-review.md)
- [干员强度数据维护说明](operator-strength-data.md)

## 质量与验证

- [实测关卡列表](test-levels.md)
- [审计与质量记录](audit-findings.md)

## 维护原则

- 文档应以当前代码和当前项目定位为准。
- 不再新增一次性 prompt 或执行计划到 `docs/`。
- 历史计划、临时修复清单和已完成任务 prompt 应通过 git 历史查询，不作为长期文档维护。
- 所有“可通关”“模拟证明”类表述都应避免；MAAfight 输出的是 MAA copilot 草稿。
- 所有 MAA copilot 导出规则以 [MAA Copilot 导出契约](maa-copilot-export-contract.md) 为准；复盘文档只能作为背景，不应覆盖契约。
