# 数据格式规范

## 范围

本文记录 MAAfight 主链路中最重要的数据结构：

```text
PRTS.Map JSON -> MapData -> TacticalAnalysis -> BattleScript -> MAA copilot JSON v3
```

类型事实源以 `src/types.ts` 和 `src/battle/types.ts` 为准。本文用于解释字段语义和边界。

## PRTS.Map 输入

PRTS.Map 输入是游戏引擎导出的关卡 JSON。不同关卡可能使用字符串枚举或数字枚举，适配层必须同时兼容。

核心结构：

```typescript
interface PRTSLevelData {
  options: PRTSOptions;
  mapData: PRTSMapData;
  routes: Array<PRTSRoute | null>;
  waves: PRTSWave[];
  enemyDbRefs: PRTSEnemyDbRef[];
  runes: PRTSRune[];
  predefines: PRTSPredefines;
  tilesDisallowToLocate: number[];
  randomSeed: number;
}
```

重要字段：

- `options`：部署上限、生命值、初始费用、费用上限、自然回费间隔。
- `mapData.map`：二维地图索引。
- `mapData.tiles`：瓦片定义，包含高度、可部署类型、通行类型。
- `routes`：敌人路线，可能包含 `null` 条目和非真实路径。
- `waves`：波次、片段和出怪 action。
- `enemyDbRefs`：关卡内敌人属性覆写。
- `runes`：关卡特殊规则，当前主要保留给 warning 和 metadata。

## MapData

`MapData` 是 MAAfight 内部地图格式，也是 `BattleAnalyzer` 的输入。

```typescript
interface MapData {
  stageId: string;
  name: string;
  tiles: TileInfo[][];
  deploymentPoints: DeploymentPoint[];
  strategicPoints: StrategicPoint[];
  highThreatAreas: HighThreatArea[];
  routes: EnemyRoute[];
  waves: WaveInfo[];
  enemyDetails: EnemyDetail[];
  spawnTimeline: SpawnEvent[];
  options: MapOptions;
  deploymentOrder?: DeploymentRecommendation[];
  runes?: PRTSRune[];
  _raw?: PRTSLevelData;
}
```

关键说明：

- `deploymentPoints` 只记录可部署点，不代表生成器一定会使用。
- `strategicPoints` 包含起点、终点和隘口。
- `routes[].motionMode` 归一化为 `walk` 或 `fly`。
- `spawnTimeline` 是粗粒度出怪时间线，按秒估算。
- `enemyDetails` 来自关卡覆写和敌人数据库合并。
- `deploymentOrder` 是适配器启发式推荐，生成器会在点位评分失败时回退使用。
- `_raw` 只用于调试，不应被主算法依赖为唯一事实源。

## TacticalAnalysis

`TacticalAnalysis` 是 `BattleAnalyzer` 的输出。

```typescript
interface TacticalAnalysis {
  summary: string;
  enemyComposition: EnemyComposition;
  requirements: OperatorRequirements;
  keyTimings: KeyTiming[];
  threatPriorities: ThreatPriority[];
  suggestedStrategy: Strategy;
  dpsRequirement?: DPSRequirement;
  spawnTimeline?: SpawnEvent[];
  mapRecommendations?: MapRecommendation[];
  notes?: string[];
  battlePlan?: BattlePlan;
  pressureWindows?: PressureWindow[];
  recommendedTasks?: BattleTask[];
}
```

兼容性要求：

- `requirements` 仍然保留，用于旧逻辑和 fallback。
- `pressureWindows` 和 `recommendedTasks` 是新规划逻辑的主输入。
- 新字段缺失时，`ScriptGenerator` 必须能回退到旧的职业需求和部署顺序。

## 轻量规划类型

轻量规划类型定义在 `src/battle/types.ts`。

### BattleTask

```typescript
type BattleTask =
  | "early_dp"
  | "lane_block"
  | "lane_hold"
  | "anti_air"
  | "physical_dps"
  | "arts_damage"
  | "healing"
  | "boss_kill"
  | "elite_control"
  | "support"
  | "fast_redeploy";
```

`BattleTask` 是生成器选择干员和部署点的主要语义。它比固定职业顺序更接近战术意图，但仍然是规则化标签，不是完整战斗模拟。

### PressureWindow

```typescript
interface PressureWindow {
  start: number;
  end: number;
  laneId?: string;
  enemyCount: number;
  totalHp: number;
  totalAtk: number;
  hasFlying: boolean;
  hasElite: boolean;
  hasBoss: boolean;
  pressureScore: number;
}
```

`pressureScore` 用于排序和提示，不是胜率或通关概率。

### BattlePlan

```typescript
interface BattlePlan {
  difficulty: "easy" | "medium" | "hard" | "extreme";
  tacticType: string;
  pressureWindows: PressureWindow[];
  recommendedTasks: BattleTask[];
  positionHints: Record<string, PositionHint[]>;
  warnings: string[];
}
```

`BattlePlan` 可写入 `analysis.battlePlan` 和 `script.metadata.battlePlan`，便于 GUI 展示与调试。

## BattleScript

`BattleScript` 是导出前的内部脚本格式。

```typescript
interface BattleScript {
  stage_name: string;
  minimum_required: string;
  actions: BattleScriptAction[];
  doc: {
    title: string;
    details: string;
  };
  groups: BattleScriptGroup[];
  opers: BattleScriptOper[];
  generatedAt: string;
  metadata: BattleScriptMetadata;
  version?: number;
}
```

`metadata` 当前用于调试和 GUI：

```typescript
interface BattleScriptMetadata {
  source: string;
  difficulty?: string;
  estimatedCost?: number;
  playerOperatorsUsed?: boolean;
  operatorGaps?: string[];
  deploymentReasons?: Record<string, string>;
  squadMode?: "fixed" | "groups" | "hybrid";
  battlePlan?: BattlePlan;
  pressureWindows?: PressureWindow[];
  recommendedTasks?: BattleTask[];
  positionScoreSummary?: PositionScoreSummary[];
  dpTimelineSummary?: DPTimelineSummary;
  operatorSelectionTrace?: OperatorSelectionTrace[];
  warnings?: string[];
}
```

`metadata` 不应被视为 MAA 执行协议的一部分。导出器可以保留必要说明，但不能让 metadata 破坏 MAA copilot v3 兼容性。

## MAA copilot JSON 输出

导出格式保持 MAA copilot JSON v3 兼容。

字段级硬约束见 [MAA Copilot 导出契约](maa-copilot-export-contract.md)。修改导出结构时，以该契约为准。

```typescript
interface CopilotOutput {
  stage_name: string;
  minimum_required: string;
  doc: {
    title: string;
    details: string;
  };
  opers: CopilotOperator[];
  groups: CopilotGroup[];
  actions: CopilotAction[];
  version: number;
}
```

常见 action：

```typescript
type CopilotAction =
  | { type: "SpeedUp" }
  | { type: "SkillDaemon" }
  | { type: "Deploy"; name: string; location: [number, number]; direction: string }
  | { type: "SkillUse"; name: string; skill: number }
  | { type: "Retreat"; name: string }
  | { type: "Wait"; time: number };
```

注意：

- `Wait` 和 `SkillUse` 在当前项目中可能作为内部或兼容 action 出现，应由 `MAAProtocolValidator` 给出协议 warning。
- `requirements` 是干员要求说明，不应当成 MAA 执行约束。
- `groups` / `opers` 会随编队模式变化。
- 默认 `fixed` 模式下，`groups` 为空，`opers` 尽量补满 12 名真实干员。
- `opers[].name` 和 `groups[].opers[].name` 必须是真实干员名，不能包含职业前缀、候选列表、练度说明或模组说明。
- `actions[].name` 必须匹配真实干员名，或在显式 `groups` 模式下匹配 `groups[].name`。

## PlayerOperator

MAA operators JSON 经 `OperatorBox` 解析后会转成玩家干员数据。

```typescript
interface PlayerOperator {
  id: string;
  name: string;
  rarity: number;
  own: boolean;
  elite: number;
  level: number;
  potential: number;
  skillLevel?: number;
  module?: number;
  moduleLevel?: number;
  cost?: number;
}
```

生成器有玩家干员库时优先选择玩家拥有干员；干员库不足时通过 `operatorGaps` 输出缺口，并保留兜底生成能力。

默认 `fixed` 模式下，生成器会尽量把 `opers` 补到 12 名真实干员。未部署的补位干员只进入编队，不自动生成 `Deploy` 动作。

如果玩家干员数据缺少模组字段，生成器允许根据离线强度数据里的 `modulePriority` 输出推荐 `requirements.module` 和 `requirements.module_level`。

如果输入样本包含 `stage_name`、`actions` 或 `groups`，它是 MAA copilot 作业文件，不是 operators JSON。不要把作业文件当成玩家干员库解析。

## PlanningReport

`PlanningReport` 是 explain 和 GUI 调试用的汇总结果。

它会综合：

- 内部验证结果。
- MAA 协议验证结果。
- 敌人数据是否完整。
- Boss / 符文 / 高难风险。
- operator gaps。
- 部署动作数量和部署点使用情况。

`planner_confidence` 是规划支持度评分，不是通关概率。
