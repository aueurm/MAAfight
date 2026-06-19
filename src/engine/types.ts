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
  name: string;
  role: EngineRole;
  skill: number;
  tier: number;
  player?: PlayerOperator;
}

export interface ScoreBreakdown {
  combat: number;
  position: number;
  timing: number;
  corpus: number;
  tasks: number;
  automation: number;
}

export interface EngineOptions {
  playerOperators?: Map<string, PlayerOperator>;
  requirementsMode?: "none" | "player";
  excludedHashes?: Set<string>;
  feedbackAdjustment?: (script: BattleScript, scriptHash: string, breakdown: ScoreBreakdown) => number;
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
  evaluatedCandidates: number;
  rejectedCandidates: number;
  warnings: string[];
}

export interface CandidateBuildInput {
  stageCode: string;
  mapData: MapData;
  facts: StageFacts;
  operatorVariant: number;
  positionVariant: number;
  timingVariant: number;
  options: EngineOptions;
}
