# 实现路线图

## 当前状态

MAAfight 当前是预览版本地工具，提供 CLI、Web GUI 和 Windows-first 内测包。

已经具备：

- PRTS.Map 关卡加载和缓存。
- PRTS.Map -> `MapData` 适配。
- 规则化战斗分析。
- `pressureWindows`、`recommendedTasks`、粗费用和部署点评分。
- 玩家 operators JSON 集成。
- 离线干员强度先验。
- MAA copilot JSON v3 导出。
- 内部脚本验证和 MAA 协议兼容性 warning。
- Planning report / explain / GUI 调试信息。

项目近期定位保持不变：

> MAAfight 是基于 PRTS.Map 的规则化 MAA copilot 草稿生成器，而不是 AI / LLM 生成器，也不是明日方舟战斗模拟器。

## 已完成阶段

### 阶段 1：核心流水线

- TypeScript / Jest 项目骨架。
- `BattleAnalyzer`、`ScriptGenerator`、`ScriptValidator`、`ScriptExporter`。
- MAA copilot JSON v3 导出。

### 阶段 2：PRTS.Map 集成

- `PRTSMapLoader`：关卡 JSON 下载、缓存、敌人数据库加载。
- `PRTSMapAdapter`：瓦片、路线、波次、敌人属性、部署点转换。
- `levelIndex`：多类别关卡索引和搜索。
- 支持字符串枚举和数字枚举两类 PRTS.Map 数据。

### 阶段 3：玩家干员库

- `OperatorBox` 解析 MAA operators JSON。
- `.maafight/operators.json` 本地干员库。
- `init` / `operators info` 命令。
- GUI 粘贴和保存 operators JSON。

### 阶段 4：解释与验证

- `MAAProtocolValidator`。
- `PlanningReport`。
- `--explain`。
- benchmark 和 GUI 调试信息。

### 阶段 5：轻量规划

- `BattlePlanner` 生成 `pressureWindows` 和 `recommendedTasks`。
- `ScriptGenerator` 优先按任务队列选人。
- `DPTimeline` 粗费用估算。
- `PositionScorer` 部署点评分。
- `OperatorStrengthScorer` 干员强度和任务适配评分。
- 新增信息写入 `metadata`，供 GUI 展示和调试。

## 近期优先级

1. 稳定轻量规划结果。

   持续修正 `recommendedTasks` 的任务数量、排序和 fallback，避免小关卡过度部署、大关卡漏掉关键任务。

2. 提升 metadata 可读性。

   让 GUI 能更清楚展示为什么选某个干员、为什么选某个点、哪里存在费用或协议 warning。

3. 补强实测集。

   扩展 `docs/test-levels.md` 和 benchmark 关卡覆盖，优先覆盖飞行、高防、Boss、多路线和特殊地块关卡。

4. 改善 MAA 协议兼容性。

   对 `Wait`、`SkillUse`、`requirements`、编队模式等输出保持 warning 透明，逐步减少不必要的协议风险。导出结构改动必须遵守 [MAA Copilot 导出契约](maa-copilot-export-contract.md)，避免再次把展示文本写入协议 `name` 字段。

5. 打磨 GUI 内测体验。

   保持本地运行、日志可复制、输出路径明确、operators JSON 不泄漏到日志。

## 不进入近期主链路的方向

- 完整战斗模拟。
- AI / LLM 自动策略生成。
- 全量干员属性、技能轴、天赋、模组、召唤物规则维护。
- 把半模拟结果当成通关证明。
- 替代 MAA 执行层。

这些方向不是绝对不可研究，但不应成为当前生成脚本的必要前置。

## 后续可扩展方向

- 更细的半模拟 warning：治疗覆盖不足、Boss 窗口前缺核心输出、飞行路线缺防空等。
- 关卡可视化：展示路线、压力窗口、部署点评分。
- 干员强度数据维护工具：校验 schema、查看低置信度条目、生成变更摘要。
- 批量生成和批量 benchmark。
- 更完整的 release preview 验收脚本。
- 外部数据源对照，但必须保持离线可运行和 fallback。
