# 数据格式规范

## PRTS.Map 格式 (输入)

来自 PRTS.Map 的游戏引擎原始关卡导出格式。

### 顶层结构

```typescript
interface PRTSLevelData {
  options: PRTSOptions;
  mapData: PRTSMapData;
  routes: PRTSRoute[];
  waves: PRTSWave[];
  enemyDbRefs: PRTSEnemyDbRef[];
  runes: PRTSRune[];
  predefines: PRTSPredefines;
  tilesDisallowToLocate: number[];
  randomSeed: number;
}
```

### options — 关卡配置

```typescript
interface PRTSOptions {
  characterLimit: number;     // 最大部署数
  maxLifePoint: number;       // 生命值
  initialCost: number;        // 初始费用
  maxCost: number;            // 最大费用
  costIncreaseTime: number;   // 费用回复间隔(秒)
  isTrainingLevel: boolean;
  isHardTrainingLevel: boolean;
}
```

### mapData — 瓦片地图

```typescript
interface PRTSMapData {
  map: number[][];             // 7×10 或更大, 每个值是 tiles 数组的索引
  tiles: PRTSTile[];           // 瓦片定义数组
}

interface PRTSTile {
  tileKey: string;             // "tile_road" | "tile_wall" | "tile_floor" |
                               // "tile_start" | "tile_end" | "tile_forbidden"
  heightType: "HIGHLAND" | "LOWLAND";
  buildableType: "MELEE" | "RANGED" | "NONE";
  passableMask: "ALL" | "FLY_ONLY";
  playerSideMask: "ALL";
  effects: PRTSTileEffect[] | null;
}
```

### routes — 敌人路径

```typescript
interface PRTSRoute {
  motionMode: "WALK" | "FLY" | "E_NUM";
  startPosition: { row: number; col: number };
  endPosition: { row: number; col: number };
  checkpoints: PRTSCheckpoint[] | null;
  spawnRandomRange: { x: number; y: number };
}

interface PRTSCheckpoint {
  type: "MOVE" | "WAIT_CURRENT_FRAGMENT_TIME" | "WAIT_FOR_SECONDS";
  time: number;                // 等待时间(秒)
  position: { row: number; col: number };
}
```

### waves — 波次

```typescript
interface PRTSWave {
  preDelay: number;            // 本波开始前延迟(秒)
  postDelay: number;
  maxTimeWaitingForNextWave: number;
  fragments: PRTSFragment[];
}

interface PRTSFragment {
  preDelay: number;            // 本片段延迟(秒)
  actions: PRTSSpawnAction[];
}

interface PRTSSpawnAction {
  actionType: "SPAWN" | "STORY";
  key: string;                 // enemy ID (对应 enemyDbRefs.id)
  count: number;               // 该批数量
  preDelay: number;            // 该批内延迟
  interval: number;            // 连续出怪间隔(秒)
  routeIndex: number;          // 使用哪条路线(对应 routes[index])
  blockFragment: boolean;
  randomType: "ALWAYS";
  refreshType: "ALWAYS";
}
```

### enemyDbRefs — 敌人属性

```typescript
interface PRTSEnemyDbRef {
  useDb: boolean;              // true = 使用敌人数据库, 覆写指定字段
  id: string;                  // 敌人 ID, 如 "enemy_1027_mob"
  level: number;
  overwrittenData: {
    attributes: {
      maxHp: { m_defined: boolean; m_value: number };
      atk: { m_defined: boolean; m_value: number };
      def: { m_defined: boolean; m_value: number };
      magicResistance: { m_defined: boolean; m_value: number };
      moveSpeed: { m_defined: boolean; m_value: number };
      attackSpeed: { m_defined: boolean; m_value: number };
      massLevel: { m_defined: boolean; m_value: number };
      // ... 其他属性
    };
  };
}
```

### predefines — 预设部署

```typescript
interface PRTSPredefines {
  characterInsts: PRTSCharacterInst[];
}

interface PRTSCharacterInst {
  position: { row: number; col: number };
  direction: "LEFT" | "RIGHT" | "UP" | "DOWN";
  inst: {
    characterKey: string;      // 干员 ID, 如 "char_220_grani"
    level: number;
    phase: string;
  };
  skillIndex: number;
}
```

---

## MAAfight 内部格式 (中间层)

### MapData

适配后的统一格式，BattleAnalyzer 的输入。

```typescript
interface MapData {
  stageId: string;
  name: string;                    // 关卡名称(可选)
  tiles: TileInfo[][];             // 二维瓦片数组 [row][col]
  deploymentPoints: DeploymentPoint[];
  strategicPoints: StrategicPoint[];
  highThreatAreas: HighThreatArea[];
  routes: EnemyRoute[];
  waves: WaveInfo[];
  enemyDetails: EnemyDetail[];
  spawnTimeline: SpawnEvent[];
  options: MapOptions;
}

interface TileInfo {
  key: string;                     // 瓦片类型: "road" | "wall" | "floor" | "start" | "end" | "forbidden"
  heightType: "highland" | "lowland";
  buildableType: "melee" | "ranged" | "none";
  row: number;
  col: number;
}

interface DeploymentPoint {
  row: number;
  col: number;
  buildableType: "melee" | "ranged";
}

interface StrategicPoint {
  type: "chokepoint" | "start" | "end";
  row: number;
  col: number;
  routeCount: number;              // 经过的路线数 (用于识别关键位置)
  description?: string;
}

interface HighThreatArea {
  row: number;
  col: number;
  enemyTypes: string[];            // 出怪类型列表
  spawnCount: number;              // 总出怪数
  firstSpawnTime: number;          // 首次出怪时间(秒)
}

interface EnemyRoute {
  id: number;
  motionMode: "walk" | "fly";
  startPosition: Position;
  endPosition: Position;
  checkpoints: Position[];         // 化简后的路径点
}

interface WaveInfo {
  index: number;
  preDelay: number;                // 本波开始延迟
  fragments: FragmentInfo[];
}

interface FragmentInfo {
  preDelay: number;
  enemySpawns: EnemySpawn[];
}

interface EnemySpawn {
  enemyId: string;
  count: number;
  interval: number;
  routeIndex: number;
}

interface EnemyDetail {
  id: string;
  name: string;                    // 从 enemy_database.json 查得
  maxHp: number;
  atk: number;
  def: number;
  magicResistance: number;
  moveSpeed: number;
  isBoss: boolean;
  isElite: boolean;
}

interface SpawnEvent {
  time: number;                    // 出现时间(秒)
  enemyId: string;
  count: number;
  routeIndex: number;
}

interface MapOptions {
  characterLimit: number;
  maxLifePoint: number;
  initialCost: number;
  maxCost: number;
  costIncreaseTime: number;
}
```

### TacticalAnalysis (不变, v1 兼容)

与 b `battle-ipc.js:analyzeBattle` 返回结构一致，增加可选字段：

```typescript
interface TacticalAnalysis {
  summary: string;
  enemyComposition: EnemyComposition;
  requirements: OperatorRequirements;
  keyTimings: KeyTiming[];
  threatPriorities: ThreatPriority[];
  suggestedStrategy: Strategy;
  // v2 新增
  dpsRequirement?: DPSRequirement;
  spawnTimeline?: SpawnEvent[];
  mapRecommendations?: MapRecommendation[];
}

interface EnemyComposition {
  totalCount: number;
  normalCount: number;
  eliteCount: number;
  bossCount: number;
  compositionType: "single" | "swarm" | "mixed" | "boss_rush";
  // v2 新增: 精确统计
  totalHP?: number;
  totalDPS?: number;
  averageDEF?: number;
}

interface OperatorRequirements {
  vanguardCount: number;
  medicCount: number;
  tankCount: number;
  sniperCount: number;
  casterCount: number;
  supportCount: number;
  specialRequirements: string[];
  expectedCost: number;
  difficultyRating: "easy" | "medium" | "hard" | "extreme";
}

interface DPSRequirement {
  totalBossHP: number;
  burstWindowSeconds: number;      // Boss 关键输出窗口
  requiredDPS: number;
  recommendedOperators: string[];
}

interface KeyTiming {
  time: number;
  description: string;
  recommendedAction: string;
  operatorType?: string;
}

interface ThreatPriority {
  threatLevel: "critical" | "high" | "medium" | "low";
  targetDescription: string;
  counterRecommendation: string;
  priority: number;
}

interface Strategy {
  name: string;
  description: string;
  corePrinciples: string[];
}

interface MapRecommendation {
  position: Position;
  recommendedRole: string;
  priority: number;
  reason: string;
}
```

---

## MAA copilot JSON 格式 (输出)

```typescript
interface CopilotOutput {
  stage_name: string;
  minimum_required: string;        // MAA 最低版本
  doc: {
    title: string;
    details: string;
  };
  opers: CopilotOperator[];        // 固定空数组(按 MAA 惯例)
  groups: CopilotGroup[];
  actions: CopilotAction[];
  version: number;                 // 固定 3
}

interface CopilotGroup {
  name: string;                    // "先锋" / "重装" / ...
  opers: { name: string; skill: number; skill_usage: number }[];
}

type CopilotAction =
  | { type: "SpeedUp" }
  | { type: "SkillDaemon" }
  | { type: "Deploy"; name: string; location: [number, number]; direction: string }
  | { type: "SkillUse"; name: string; skill: number }
  | { type: "Retreat"; name: string }
  | { type: "Wait"; time: number };
```
