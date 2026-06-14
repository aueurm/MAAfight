export type BattleTask =
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

export interface PressureWindow {
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

export interface PositionHint {
  task: BattleTask;
  row: number;
  col: number;
  score: number;
  reason: string;
}

export interface BattlePlan {
  difficulty: "easy" | "medium" | "hard" | "extreme";
  tacticType: string;
  pressureWindows: PressureWindow[];
  recommendedTasks: BattleTask[];
  positionHints: Record<string, PositionHint[]>;
  warnings: string[];
}

export interface PositionScore {
  row: number;
  col: number;
  buildableType: "melee" | "ranged";
  score: number;
  reasons: string[];
}

export interface PositionScoreSummary {
  operatorName: string;
  task: BattleTask;
  role: string;
  selected?: PositionScore;
  topCandidates: PositionScore[];
}

export interface DPTimelineEntry {
  operatorName: string;
  role: string;
  task: BattleTask;
  cost: number;
  earliestTime: number;
  deployTime: number;
  waitBefore: number;
  estimatedDP: number;
}

export interface DPTimelineSummary {
  initialDP: number;
  dpPerSecond: number;
  entries: DPTimelineEntry[];
  warnings: string[];
}

export interface OperatorSelectionCandidateTrace {
  name: string;
  score: number;
  strengthTier?: string;
  rejectedReason?: string;
}

export interface OperatorSelectionTrace {
  task: BattleTask;
  selected?: string;
  score?: number;
  reasons: string[];
  consideredCandidates: OperatorSelectionCandidateTrace[];
}
