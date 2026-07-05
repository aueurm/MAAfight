import type { BattleScript, DeploymentPoint, MapData, PlayerOperator } from "../types";

export type EngineRole = "vanguard" | "guard" | "tank" | "sniper" | "caster" | "medic" | "support" | "specialist";

export interface PressureWindow {
  start: number;
  end: number;
  enemyCount: number;
  totalHp: number;
  totalAttack: number;
  flyingCount: number;
  eliteCount: number;
  bossCount: number;
}

export interface StageFacts {
  stageId: string;
  rows: number;
  cols: number;
  enemyCount: number;
  totalHp: number;
  totalAttack: number;
  averageDefense: number;
  averageResistance: number;
  eliteCount: number;
  bossCount: number;
  flyingRouteCount: number;
  groundRouteCount: number;
  laneCount: number;
  routeCells: Array<{ row: number; col: number }>;
  goalCells: Array<{ row: number; col: number }>;
  chokeCells: Array<{ row: number; col: number }>;
  deploymentPoints: DeploymentPoint[];
  initialCost: number;
  characterLimit: number;
  pressureWindows: PressureWindow[];
  difficulty: "easy" | "medium" | "hard" | "extreme";
  summary: string;
}

export interface EnginePick {
  operatorId: string;
  name: string;
  role: EngineRole;
  skill: number;
  skillRank: number;
  profile: ResolvedOperatorProfile;
  player?: PlayerOperator;
}

export interface CombatAttributes {
  hp: number;
  atk: number;
  def: number;
  res: number;
  cost: number;
  block: number;
  attackInterval: number;
  attackSpeed: number;
}

export interface CombatMetrics {
  normalDps: number;
  burstDps: number;
  cycleDps: number | null;
  healingHps: number;
  physicalEhp: number;
  artsEhp: number;
  controlSeconds: number;
}

export interface ResolvedOperatorProfile {
  operatorId: string;
  name: string;
  role: EngineRole;
  subProfession: string | null;
  position: "MELEE" | "RANGED";
  damageType: "physical" | "arts" | "heal";
  skill: number;
  skillRank: number;
  baseRangeId: string | null;
  skillRangeId: string | null;
  range: Array<[number, number]>;
  attributes: CombatAttributes;
  metrics: CombatMetrics;
  maxTargets: number;
  confidence: "exact" | "partial" | "base";
  modelCoverageGaps: string[];
}

export interface CandidateScoreBreakdown {
  publicPrior: number;
  placement: number;
  direction: number;
  timing: number;
  operatorPower: number;
  feedbackPenalty: number;
}

export interface LegacyScoreBreakdown {
  combat: number;
  position: number;
  timing: number;
  corpus: number;
  tasks: number;
  automation: number;
}

export type ScoreBreakdown = CandidateScoreBreakdown;

export interface EngineOptions {
  playerOperators?: Map<string, PlayerOperator>;
  excludedHashes?: Set<string>;
  feedbackPenalty?: (script: BattleScript, scriptHash: string, breakdown: ScoreBreakdown) => number;
  feedbackAdjustment?: (script: BattleScript, scriptHash: string, breakdown: ScoreBreakdown) => number;
  now?: () => number;
  search?: Partial<SearchConfig>;
}

export interface SearchConfig {
  squadBeamWidth: number;
  candidateFrontierLimit: number;
  candidatePoolLimit: number;
  completeCandidateLimit?: number;
  candidateVariantLimit?: number;
  positionVariantCount: number;
  directionVariantCount: number;
  timingVariantCount: number;
  orderVariantCount: number;
  skillVariantCount: number;
  minimumFullCandidates: number;
  defaultFullCandidates: number;
  maximumFullCandidates: number;
  deadlineMs: number;
  deadlineCheckInterval: number;
  diversityFirstDeployLimit: number;
  diversityFirstThreeLimit: number;
  diversityDeployCellsLimit: number;
  diversityDirectionLimit: number;
  diversityTimingLimit: number;
  diversitySkillStrategyLimit: number;
  diversitySquadLimit: number;
  diversityReservedPerGroup: number;
}

export interface SearchStats {
  expandedSquads: number;
  cheapCompleteCandidates: number;
  fullyScoredCandidates: number;
  rejectedCandidates: number;
  budgetTier: 64 | 192 | 384;
  terminationReason: "converged" | "default-budget" | "maximum-budget" | "deadline" | "frontier-exhausted";
  elapsedMs: number;
}

export interface EngineResult {
  script: BattleScript;
  facts: StageFacts;
  scriptHash: string;
  score: number;
  breakdown: ScoreBreakdown;
  modelVersion: string;
  combatModelVersion: string;
  combatCoverage: number;
  skillCoverage: number;
  coverageGaps: string[];
  evaluatedCandidates: number;
  rejectedCandidates: number;
  stageContentHash: string;
  gameDataCommit: string;
  searchStats: SearchStats;
  warnings: string[];
}

export interface CandidateBuildInput {
  stageCode: string;
  mapData: MapData;
  facts: StageFacts;
  picks: EnginePick[];
  positionVariant: number;
  directionVariant?: number;
  timingVariant: number;
  timingDelayMs?: number;
  orderVariant?: number;
  skillVariant?: number;
  options: EngineOptions;
}

export interface EncounterEnemyGroup {
  enemyId: string;
  routeIndex: number;
  motionMode: "walk" | "fly";
  count: number;
  hp: number;
  atk: number;
  def: number;
  res: number;
  moveSpeed: number;
  elite: boolean;
  boss: boolean;
}

export interface EncounterWindow {
  start: number;
  end: number;
  groups: EncounterEnemyGroup[];
  totalHp: number;
  totalAttack: number;
}

export interface CapabilityDemand {
  physical: number;
  arts: number;
  burst: number;
  sustain: number;
  healing: number;
  block: number;
  control: number;
  antiAir: number;
  coverage: number;
  singleTarget: number;
  area: number;
  laneHold: number;
  support: number;
  deployment: number;
}

export interface EncounterContext {
  hash: string;
  windows: EncounterWindow[];
  demand: CapabilityDemand;
  averageDefense: number;
  averageResistance: number;
  routeCells: Array<{ row: number; col: number }>;
}
