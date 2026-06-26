// ====================== PRTS.Map 格式 (输入) ======================

export interface PRTSLevelData {
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

export interface PRTSOptions {
  characterLimit: number;
  maxLifePoint: number;
  initialCost: number;
  maxCost: number;
  costIncreaseTime: number;
  isTrainingLevel: boolean;
  isHardTrainingLevel: boolean;
}

export interface PRTSMapData {
  map: number[][];
  tiles: PRTSTile[];
}

export interface PRTSTile {
  tileKey: string;
  heightType: "HIGHLAND" | "LOWLAND" | 0 | 1;
  buildableType: "MELEE" | "RANGED" | "ALL" | "NONE" | 0 | 1 | 2;
  passableMask: "ALL" | "FLY_ONLY" | number;
  playerSideMask: "ALL" | number;
  effects: PRTSTileEffect[] | null;
}

export interface PRTSTileEffect {
  type: string;
  [key: string]: unknown;
}

export interface PRTSRoute {
  motionMode: "WALK" | "FLY" | "E_NUM" | 0 | 1 | 2;
  startPosition: { row: number; col: number };
  endPosition: { row: number; col: number };
  checkpoints: PRTSCheckpoint[] | null;
  spawnRandomRange: { x: number; y: number };
}

export interface PRTSCheckpoint {
  type: "MOVE" | "WAIT_CURRENT_FRAGMENT_TIME" | "WAIT_FOR_SECONDS" | "DISAPPEAR" | "APPEAR_AT_POS" | 0 | 1 | 5 | 6;
  time: number;
  position: { row: number; col: number };
}

export interface PRTSWave {
  preDelay: number;
  postDelay: number;
  maxTimeWaitingForNextWave: number;
  fragments: PRTSFragment[];
}

export interface PRTSFragment {
  preDelay: number;
  actions: PRTSSpawnAction[];
}

export interface PRTSSpawnAction {
  actionType: "SPAWN" | "STORY" | "DISPLAY_ENEMY_INFO" | "PREVIEW_CURSOR" | 0 | 6 | 8;
  key: string;
  count: number;
  preDelay: number;
  interval: number;
  routeIndex: number;
  blockFragment: boolean;
  randomType: "ALWAYS";
  refreshType: "ALWAYS";
}

export interface PRTSEnemyDbRef {
  useDb: boolean;
  id: string;
  level: number;
  overwrittenData: {
    attributes: PRTSAttributeOverrides;
  };
}

export interface PRTSAttributeOverrides {
  maxHp: { m_defined: boolean; m_value: number };
  atk: { m_defined: boolean; m_value: number };
  def: { m_defined: boolean; m_value: number };
  magicResistance: { m_defined: boolean; m_value: number };
  moveSpeed: { m_defined: boolean; m_value: number };
  attackSpeed: { m_defined: boolean; m_value: number };
  massLevel: { m_defined: boolean; m_value: number };
}

export interface PRTSRune {
  key: string;
  position?: { row: number; col: number };
  direction?: string;
  [key: string]: unknown;
}

export interface PRTSPredefines {
  characterInsts: PRTSCharacterInst[];
}

export interface PRTSCharacterInst {
  position: { row: number; col: number };
  direction: "LEFT" | "RIGHT" | "UP" | "DOWN";
  inst: {
    characterKey: string;
    level: number;
    phase: string;
  };
  skillIndex: number;
}

// ====================== MAAfight 内部格式 ======================

export interface MapData {
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
  runes?: PRTSRune[];
  _raw?: PRTSLevelData;
}

export interface TileInfo {
  key: string;
  heightType: "highland" | "lowland";
  buildableType: "melee" | "ranged" | "all" | "none";
  row: number;
  col: number;
}

export interface DeploymentPoint {
  row: number;
  col: number;
  buildableType: "melee" | "ranged" | "all";
}

export interface StrategicPoint {
  type: "chokepoint" | "start" | "end";
  row: number;
  col: number;
  routeCount: number;
  description?: string;
}

export interface HighThreatArea {
  row: number;
  col: number;
  enemyTypes: string[];
  spawnCount: number;
  firstSpawnTime: number;
}

export interface EnemyRoute {
  id: number;
  motionMode: "walk" | "fly";
  startPosition: { row: number; col: number };
  endPosition: { row: number; col: number };
  checkpoints: { row: number; col: number }[];
}

export interface WaveInfo {
  index: number;
  preDelay: number;
  postDelay: number;
  fragments: FragmentInfo[];
}

export interface FragmentInfo {
  preDelay: number;
  enemySpawns: EnemySpawn[];
}

export interface EnemySpawn {
  enemyId: string;
  count: number;
  interval: number;
  routeIndex: number;
}

export interface EnemyDetail {
  id: string;
  name: string;
  maxHp: number;
  atk: number;
  def: number;
  magicResistance: number;
  moveSpeed: number;
  isBoss: boolean;
  isElite: boolean;
}

export interface SpawnEvent {
  time: number;
  enemyId: string;
  count: number;
  routeIndex: number;
}

export interface MapOptions {
  characterLimit: number;
  maxLifePoint: number;
  initialCost: number;
  maxCost: number;
  costIncreaseTime: number;
}

// ====================== Copilot 输出 ======================

export interface CopilotOperator {
  name: string;
  skill?: number;
  skill_usage?: number;
}

export interface CopilotOutput {
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

export interface CopilotGroup {
  name: string;
  opers: { name: string; skill: number; skill_usage: number }[];
}

export type CopilotAction =
  | { type: "SpeedUp" }
  | { type: "SkillDaemon" }
  | { type: "Deploy"; name: string; location: [number, number]; direction: string }
  | { type: "Skill"; name: string }
  | { type: "Retreat"; name: string };

// ====================== 战斗脚本 (内部) ======================

export interface BattleScript {
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
  metadata: {
    source: string;
    difficulty?: string;
    estimatedCost?: number;
    playerOperatorsUsed?: boolean;
    operatorGaps?: string[];
    deploymentReasons?: Record<string, string>;
    warnings?: string[];
    candidateScore?: number;
    candidateScoreBreakdown?: Record<string, number>;
    corpusModelVersion?: string;
    combatModelVersion?: string;
    combatCoverage?: number;
    skillCoverage?: number;
    coverageGaps?: string[];
    squadSignature?: string;
    stageContentHash?: string;
    searchStats?: {
      expandedSquads: number;
      cheapCompleteCandidates: number;
      fullyScoredCandidates: number;
      rejectedCandidates: number;
      budgetTier: 64 | 192 | 384;
      terminationReason: "converged" | "default-budget" | "maximum-budget" | "deadline" | "frontier-exhausted";
      elapsedMs: number;
    };
    generationId?: string;
    scriptHash?: string;
  };
  version?: number;
}

export interface BattleScriptGroup {
  name: string;
  opers: BattleScriptOper[];
}

export interface BattleScriptOper {
  name: string;
  skill?: number;
  skill_usage?: number;
  skill_times?: number;
  requirements?: {
    elite: number;
    level: number;
    skill_level?: number;
    module?: number;
    module_level?: number;
    potential: number;
  };
}

export interface BattleScriptAction {
  type: string;
  name?: string;
  location?: [number, number];
  direction?: string;
  skill?: number;
  skill_usage?: number;
  skill_times?: number;
  target?: string;
  time?: number;
  pre_delay?: number;
  post_delay?: number;
  costs?: number;
  cost_changes?: number;
  kills?: number;
  time_elapsed?: number;
  cooling?: number;
  skip_if_not_ready?: boolean;
  distance?: [number, number];
  doc?: string;
  doc_color?: string;
}

// ====================== 验证 ======================

export interface ValidationResult {
  valid: boolean;
  errors: ValidationErrorItem[];
  warnings: ValidationWarningItem[];
  score: number;
}

export interface ValidationErrorItem {
  code: string;
  message: string;
  location?: {
    actionIndex?: number;
    groupIndex?: number;
    field?: string;
  };
}

export interface ValidationWarningItem {
  code: string;
  message: string;
  suggestion?: string;
}

// ====================== 玩家干员 ======================

export interface ProtocolValidationResult {
  valid: boolean;
  errors: ProtocolIssue[];
  warnings: ProtocolIssue[];
  score: number;
}

export interface ProtocolIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  actionIndex?: number;
  suggestion?: string;
}

export interface PlayerOperator {
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

// ====================== 关卡索引 ======================

export interface StageIndexEntry {
  stageId: string;
  filePath: string;
  category: string;
  code?: string;
  name?: string;
  levelId?: string;
}
