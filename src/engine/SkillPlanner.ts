import type { BattleScript, MapOptions } from "../types";
import { planDeploymentTimeline } from "./TimelinePlanner";
import type { EncounterContext, EnginePick } from "./types";

export type SkillStrategy = "daemon" | "opening" | "sustain" | "burst" | "boss" | "defense" | "emergency" | "passive";

export interface SkillPlan {
  actions: BattleScript["actions"];
  strategies: Record<string, SkillStrategy>;
  coverageGaps: string[];
  usesDaemon: boolean;
}

function strategyFor(pick: EnginePick, window: EncounterContext["criticalWindows"][number]): SkillStrategy {
  if (pick.profile.skillType !== "MANUAL") return "passive";
  if (window.bossWeight > 0) return "boss";
  if (pick.profile.metrics.healingHps > 0) return "defense";
  if (pick.profile.metrics.burstDps > pick.profile.metrics.normalDps * 1.2) return "burst";
  return "sustain";
}

function triggerWindows(encounter: EncounterContext): EncounterContext["criticalWindows"] {
  return encounter.criticalWindows.filter(window => window.bossWeight > 0 || window.severity >= 60_000);
}

export function planSkillActions(
  actions: BattleScript["actions"],
  picks: EnginePick[],
  encounter: EncounterContext,
  options: MapOptions
): SkillPlan {
  const windows = triggerWindows(encounter);
  if (!windows.length) return { actions: [], strategies: {}, coverageGaps: [], usesDaemon: true };
  const timeline = planDeploymentTimeline({ actions }, options);
  const deployedAt = new Map(timeline.deployments
    .filter(deployment => deployment.affordable && deployment.name)
    .map(deployment => [deployment.name!, deployment]));
  const lastActionTime = timeline.time;
  const coverageGaps = new Set<string>();
  const planned: Array<{ action: BattleScript["actions"][number]; strategy: SkillStrategy; benefit: number }> = [];

  for (const pick of picks) {
    const deployment = deployedAt.get(pick.name);
    if (!deployment) continue;
    const skillType = pick.profile.skillType || "UNKNOWN";
    if (skillType !== "MANUAL") {
      if (skillType === "UNKNOWN") coverageGaps.add(`skill_type_unknown:${pick.operatorId}`);
      continue;
    }
    const spType = pick.profile.spType || "UNKNOWN";
    if (spType !== "INCREASE_WITH_TIME") {
      coverageGaps.add(`manual_skill_timing_unknown:${pick.operatorId}`);
      continue;
    }
    if (pick.profile.spCost === undefined || pick.profile.initSp === undefined) {
      coverageGaps.add(`manual_skill_sp_unknown:${pick.operatorId}`);
      continue;
    }
    const readyAt = deployment.time + Math.max(0, pick.profile.spCost - pick.profile.initSp);
    const window = windows.find(candidate => candidate.start >= readyAt && candidate.start < deployment.endTime);
    if (!window) {
      coverageGaps.add(`manual_skill_window_unready:${pick.operatorId}`);
      continue;
    }
    // ponytail: MAA serializes actions; add an interleaving scheduler only when a safe native condition supports it.
    if (window.start < lastActionTime) {
      coverageGaps.add(`manual_skill_ordering_unverified:${pick.operatorId}`);
      continue;
    }
    const strategy = strategyFor(pick, window);
    const benefit = Math.max(0, pick.profile.metrics.burstDps - pick.profile.metrics.normalDps)
      + pick.profile.metrics.healingHps + pick.profile.metrics.controlSeconds * 100
      + window.bossWeight * 1_000;
    planned.push({
      action: { type: "Skill", name: pick.name, elapsed_time: Math.round((timeline.wallTime
        + (window.start - timeline.time) / timeline.speedMultiplier - (timeline.stopwatchWallTime || 0)) * 1000) },
      strategy,
      benefit,
    });
  }
  const selected = planned.sort((left, right) => right.benefit - left.benefit || String(left.action.name).localeCompare(String(right.action.name)))
    .slice(0, 2)
    .sort((left, right) => (left.action.elapsed_time || 0) - (right.action.elapsed_time || 0)
      || String(left.action.name).localeCompare(String(right.action.name)));
  const strategies = Object.fromEntries(selected.map(item => [item.action.name!, item.strategy]));
  return {
    actions: selected.map(item => item.action),
    strategies,
    coverageGaps: [...coverageGaps].sort(),
    usesDaemon: selected.length === 0,
  };
}
