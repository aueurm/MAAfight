import type { BattleTask } from "../battle/types";

export type OperatorStrengthTier = "SS" | "S" | "A" | "B" | "C" | "D";

export type OperatorStrengthTag =
  | "burst_dps"
  | "sustained_dps"
  | "physical_dps"
  | "arts_dps"
  | "true_damage"
  | "boss_killer"
  | "elite_killer"
  | "lane_holder"
  | "blocker"
  | "healer"
  | "burst_healer"
  | "dp_engine"
  | "anti_air"
  | "crowd_control"
  | "fragile"
  | "buffer"
  | "debuffer"
  | "fast_redeploy"
  | "summon"
  | "afk_friendly"
  | "skill_daemon_friendly"
  | "high_precision_required"
  | "low_rarity_core";

export interface OperatorStrengthProfile {
  name: string;
  aliases?: string[];
  sourceVersion: string;
  sourceNotes?: string[];
  globalTier: OperatorStrengthTier;
  globalPowerScore: number;
  roleScores: Partial<Record<BattleTask, number>>;
  tags: OperatorStrengthTag[];
  automationScore?: number;
  lowRarityValueScore?: number;
  modulePriority?: "core" | "recommended" | "optional" | "none";
  skillPriority?: string[];
  confidence: "high" | "medium" | "low";
}
