import type { OperatorStrengthProfile, OperatorStrengthTier } from "../data/operatorStrength.schema";
import { getOperatorStrengthProfile } from "./OperatorStrength";
import type { BattleTask } from "./types";

interface StrengthScoreContext {
  skillDaemonMode?: boolean;
}

export interface OperatorStrengthScore {
  score: number;
  strengthScore: number;
  roleStrengthScore: number;
  automationScore: number;
  strengthTier?: OperatorStrengthTier;
  profile?: OperatorStrengthProfile;
  reasons: string[];
}

const CONFIDENCE_FACTOR: Record<OperatorStrengthProfile["confidence"], number> = {
  high: 1,
  medium: 0.9,
  low: 0.75,
};

const TIER_FALLBACK_SCORE: Record<OperatorStrengthTier, number> = {
  SS: 96,
  S: 88,
  A: 78,
  B: 64,
  C: 48,
  D: 32,
};

export function scoreOperatorStrength(
  operator: { name: string },
  task: BattleTask,
  context: StrengthScoreContext = {}
): OperatorStrengthScore {
  const profile = getOperatorStrengthProfile(operator.name);
  if (!profile) {
    return {
      score: 50,
      strengthScore: 50,
      roleStrengthScore: 50,
      automationScore: 50,
      reasons: [`${operator.name}: no strength profile, neutral fallback`],
    };
  }

  const confidence = CONFIDENCE_FACTOR[profile.confidence] || 0.85;
  const baseScore = clamp(profile.globalPowerScore || TIER_FALLBACK_SCORE[profile.globalTier] || 50);
  const roleScore = clamp(profile.roleScores[task] ?? 0);
  let automationScore = clamp(profile.automationScore ?? 50);
  const reasons: string[] = [
    `${profile.name}: strength ${profile.globalTier} ${baseScore}`,
    `${task}: role strength ${roleScore}`,
  ];

  if (profile.tags.includes("afk_friendly")) {
    automationScore += 5;
    reasons.push("afk friendly");
  }
  if (profile.tags.includes("skill_daemon_friendly")) {
    automationScore += 8;
    reasons.push("SkillDaemon friendly");
  }
  if (context.skillDaemonMode && profile.tags.includes("high_precision_required")) {
    automationScore -= 14;
    reasons.push("high precision timing is less stable with SkillDaemon");
  }

  const strengthScore = clamp(baseScore * confidence);
  const roleStrengthScore = clamp(roleScore * confidence);
  automationScore = clamp(automationScore * confidence);
  const score = clamp(strengthScore * 0.45 + roleStrengthScore * 0.45 + automationScore * 0.1);

  if (profile.lowRarityValueScore !== undefined) {
    reasons.push(`low rarity value ${profile.lowRarityValueScore}`);
  }
  if (profile.confidence !== "high") {
    reasons.push(`confidence ${profile.confidence}`);
  }

  return {
    score,
    strengthScore,
    roleStrengthScore,
    automationScore,
    strengthTier: profile.globalTier,
    profile,
    reasons,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
