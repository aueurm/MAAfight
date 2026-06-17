// ====================== PRTS.Map 格式 (输入) ======================

import type {
  BattlePlan,
  BattleTask,
  DPTimelineSummary,
  OperatorSelectionTrace,
  PositionScoreSummary,
  PressureWindow,
} from "./battle/types";

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
  buildableType: "MELEE" | "RANGED" | "NONE" | 0 | 1 | 2;
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
  deploymentOrder?: DeploymentRecommendation[];
  runes?: PRTSRune[];
  _raw?: PRTSLevelData;
}

export interface TileInfo {
  key: string;
  heightType: "highland" | "lowland";
  buildableType: "melee" | "ranged" | "none";
  row: number;
  col: number;
}

export interface DeploymentPoint {
  row: number;
  col: number;
  buildableType: "melee" | "ranged";
}

export interface DeploymentRecommendation {
  position: { row: number; col: number };
  role: string;
  priority: number;
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

// ====================== 战术分析 ======================

export interface TacticalAnalysis {
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

export interface EnemyComposition {
  totalCount: number;
  normalCount: number;
  eliteCount: number;
  bossCount: number;
  compositionType: "single" | "swarm" | "mixed" | "boss_rush";
  totalHP?: number;
  totalDPS?: number;
  averageDEF?: number;
}

export interface OperatorRequirements {
  vanguardCount: number;
  guardCount: number;
  medicCount: number;
  tankCount: number;
  sniperCount: number;
  casterCount: number;
  supportCount: number;
  specialistCount: number;
  specialRequirements: string[];
  expectedCost: number;
  difficultyRating: "easy" | "medium" | "hard" | "extreme";
}

export interface DPSRequirement {
  totalBossHP: number;
  burstWindowSeconds: number;
  requiredDPS: number;
  recommendedOperators: string[];
}

export interface KeyTiming {
  time: number;
  description: string;
  recommendedAction: string;
  operatorType?: string;
}

export interface ThreatPriority {
  threatLevel: "critical" | "high" | "medium" | "low";
  targetDescription: string;
  counterRecommendation: string;
  priority: number;
}

export interface Strategy {
  name: string;
  description: string;
  corePrinciples: string[];
}

export interface MapRecommendation {
  position: { row: number; col: number };
  recommendedRole: string;
  priority: number;
  reason: string;
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
  | { type: "SkillUse"; name: string; skill: number }
  | { type: "Retreat"; name: string }
  | { type: "Wait"; time: number };

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
    squadMode?: "fixed" | "groups" | "hybrid";
    battlePlan?: BattlePlan;
    pressureWindows?: PressureWindow[];
    recommendedTasks?: BattleTask[];
    positionScoreSummary?: PositionScoreSummary[];
    dpTimelineSummary?: DPTimelineSummary;
    operatorSelectionTrace?: OperatorSelectionTrace[];
    warnings?: string[];
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
    skill_level: number;
    module: number;
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

export type SupportLevel = "supported" | "partial" | "experimental" | "unsupported";

export interface PlanningReport {
  stage: string;
  script_valid: boolean;
  deployable_tiles_used: number;
  enemy_data_used: boolean;
  boss_detected: boolean;
  planner_confidence: number;
  supportLevel: SupportLevel;
  known_risks: string[];
  protocolWarnings: ProtocolIssue[];
  validationScore: number;
  difficulty?: string;
  strategy?: string;
  operatorGaps: string[];
  actionCount: number;
  deployCount: number;
  generatedAt: string;
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
