# 总体架构

## 定位

MAAfight 是基于 PRTS.Map 的规则化 MAA copilot JSON 草稿生成器。

它读取真实关卡数据，生成可导入 MAA 的 copilot JSON v3。它不是 AI / LLM 脚本生成器，也不是明日方舟战斗模拟器。

MAAfight 不负责：

- 控制 ADB 或模拟器。
- 图像识别。
- 执行战斗任务队列。
- 证明脚本一定通关。
- 复刻 MAA 已有的执行层能力。

生成结果应被视为脚本草稿，需要人工检查，并以 MAA 实际执行结果为准。

## 主链路

```text
关卡输入
  -> PRTSMapLoader
  -> PRTSMapAdapter
  -> BattleAnalyzer
  -> ScriptGenerator
  -> ScriptValidator / MAAProtocolValidator
  -> PlanningReport
  -> ScriptExporter
  -> MAA copilot JSON v3
```

同一条主链路被 CLI、GUI 和 `src/core/pipeline.ts` 复用。

## 模块分层

```text
src/index.ts
  CLI 入口。负责参数解析、命令分发、stdout / stderr 输出。

src/core/pipeline.ts
  GUI / SDK 复用的生成流水线。负责串联加载、分析、生成、验证、导出和写文件。

src/loader/
  PRTS.Map 关卡索引、关卡 JSON 下载、本地缓存、敌人数据库加载。

src/adapter/
  PRTS.Map 原始 JSON -> MAAfight 内部 MapData。

src/battle/
  BattleAnalyzer       关卡敌人、路线、压力、任务分析。
  BattlePlanner        pressureWindows、recommendedTasks、positionHints。
  ScriptGenerator      干员选择、部署顺序、粗费用时间线、动作生成。
  PositionScorer       部署点评分。
  DPTimeline           粗费用估算。
  OperatorStrengthScorer 规则化干员强度先验评分。
  ScriptValidator      内部 BattleScript 合法性检查。
  MAAProtocolValidator MAA copilot 协议兼容性 warning / error。
  PlanningReport       explain 文本、confidence、known risks。
  ScriptExporter       导出 MAA copilot JSON v3。

src/player/
  MAA operators JSON 解析、本地干员库初始化与加载。

src/gui/
  Fastify 本地 GUI server 与 API。

src/runtime/
  MAAFIGHT_HOME、output/cache/logs 路径和 GUI 日志。

web/
  Vite + React 本地 Web GUI。
```

## 数据流

### 1. 关卡加载

`PRTSMapLoader` 支持：

- 按 `stageId`、游戏内关卡代号或索引路径加载关卡。
- 从 `https://map.ark-nights.com` 下载 PRTS.Map JSON。
- 将关卡 JSON 缓存在 `MAAFIGHT_CACHE_DIR`。
- 加载 `enemy_database.json`，供适配器补齐敌人名称和属性。

CLI 还支持 `--data <本地 PRTS.Map JSON>`，用于调试未收录或索引不完整的关卡。

### 2. 地图适配

`PRTSMapAdapter` 将 PRTS.Map 的游戏引擎格式转换为内部 `MapData`：

- `tiles`：二维瓦片、可部署类型。
- `deploymentPoints`：可部署坐标。
- `routes`：敌人路线，包含行走 / 飞行路线。
- `strategicPoints`：红门、蓝门、隘口。
- `waves` 和 `spawnTimeline`：波次和出怪时间线。
- `enemyDetails`：敌人 HP / ATK / DEF / RES / Boss / Elite 信息。
- `deploymentOrder`：启发式部署点推荐。
- `runes` / `_raw`：保留必要的原始调试信息。

适配器需要兼容 PRTS.Map 中字符串枚举和数字枚举两种数据形态。

### 3. 战斗分析

`BattleAnalyzer` 输出 `TacticalAnalysis`：

- 敌人组成和难度评级。
- 职业数量需求。
- 关键时机、威胁优先级和推荐策略。
- `battlePlan`、`pressureWindows`、`recommendedTasks` 等轻量规划信息。

当前分析是规则和启发式，不是战斗模拟。

### 4. 脚本生成

`ScriptGenerator` 根据 `MapData`、`TacticalAnalysis` 和可选玩家干员库生成内部 `BattleScript`。

当前生成器会优先消费 `recommendedTasks`，并在缺失时回退到旧的 `requirements` / `deploymentOrder` 逻辑。它会把以下信息写入 `metadata`，供 GUI 和调试使用：

- `battlePlan`
- `pressureWindows`
- `recommendedTasks`
- `positionScoreSummary`
- `dpTimelineSummary`
- `operatorSelectionTrace`
- `operatorGaps`
- `deploymentReasons`
- `warnings`

这些 metadata 不改变 MAA copilot JSON 的执行语义。

### 5. 验证、解释和导出

`ScriptValidator` 检查内部脚本结构、坐标、action 合法性。

`MAAProtocolValidator` 检查导出协议兼容性，对 `Wait`、`SkillUse`、`requirements` 等兼容性风险给出 warning。

`PlanningReport` 汇总验证分数、协议 warning、operator gaps、known risks 和 explain 文本。

`ScriptExporter` 保持 MAA copilot JSON v3 导出兼容。

MAA copilot 字段级导出规则由 [MAA Copilot 导出契约](maa-copilot-export-contract.md) 统一维护。涉及 `opers`、`groups`、`actions[].name`、`requirements`、默认编队模式或文件命名的改动，必须先对照该契约。

## CLI 和 GUI

CLI 支持：

- `generate`
- `analyze`
- `validate`
- `list`
- `info`
- `init`
- `operators info`
- `gui`

GUI 通过 `maafight gui` 或 `npm run gui` 启动，本质上调用同一套 `src/core/pipeline.ts`。

Windows 内测包由 `npm run release:preview` 生成，会把 app、output、cache、logs、examples 和启动脚本打包到 release 目录。

## 关键约束

1. 主链路不得依赖完整战斗模拟。

2. 新分析字段必须有 fallback。

3. 玩家干员库不足时，继续保留 `operatorGaps` 和默认池兜底行为。

4. 导出的 JSON 必须继续兼容 MAA copilot v3。

5. 半模拟或评分结果只能用于排序、warning、metadata 和 GUI 展示，不能作为通关承诺。

6. CLI stdout 在输出 JSON 时应保持可解析，解释文本和 warning 走 stderr。

7. 默认导出 fixed 12 人编队；不得把职业、候选列表、练度或模组展示文本写入协议 `name` 字段。

## 相关文档

- [算法边界与路线说明](algorithm-boundary.md)
- [MAA Copilot 导出契约](maa-copilot-export-contract.md)
- [数据格式规范](data-format.md)
- [PRTS.Map 适配器](prts-map-adapter.md)
- [BattleAnalyzer 与轻量规划](battle-analyzer-v2.md)
- [CLI 与 GUI 使用](cli-design.md)
- [MAA 干员导出格式](maa-operator-export.md)
- [干员强度数据维护说明](operator-strength-data.md)
- [实测关卡列表](test-levels.md)
