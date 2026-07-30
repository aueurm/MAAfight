import type { BattleScript, MapData } from "../types";
import { rotateDirection } from "./helpers";
import { planDeploymentTimeline } from "./TimelinePlanner";
import type { EncounterContext, EnginePick, StageFacts, TemporalCellPressure } from "./types";

export interface FeasibilityResult {
  feasible: boolean;
  reasons: string[];
  coverageGaps: string[];
}

interface DeploymentPair {
  action: BattleScript["actions"][number];
  pick: EnginePick;
  time: number;
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function covers(action: DeploymentPair["action"], pick: EnginePick, cell: TemporalCellPressure): boolean {
  if (!action.location) return false;
  return pick.profile.range.some(offset => {
    const [row, col] = rotateDirection(offset, action.direction || "Right");
    return action.location![0] + row === cell.row && action.location![1] + col === cell.col;
  });
}

function stageDps(pick: EnginePick, encounter: EncounterContext): number {
  const profile = pick.profile;
  const modeled = profile.metrics.cycleDps ?? profile.metrics.normalDps;
  const confidence = profile.confidence === "exact" ? 1 : profile.confidence === "partial" ? 0.9 : 0.75;
  if (profile.damageType === "heal") return 0;
  if (profile.damageType === "arts") return modeled * Math.max(0.05, 1 - encounter.averageResistance / 100) * confidence;
  const interval = Math.max(0.1, profile.attributes.attackInterval * 100 / Math.max(1, profile.attributes.attackSpeed));
  const perHit = Math.max(profile.attributes.atk * 0.05, profile.attributes.atk - encounter.averageDefense);
  return perHit / interval * modeled / Math.max(1, profile.metrics.normalDps) * confidence;
}

function activeDeployments(script: BattleScript, picks: EnginePick[], mapData: MapData): { deployments: DeploymentPair[]; reasons: string[] } {
  const planned = new Map(planDeploymentTimeline(script, mapData.options).deployments.map(item => [item.actionIndex, item]));
  const byName = new Map(picks.map(pick => [pick.name, pick]));
  const active = new Map<string, string>();
  const occupied = new Set<string>();
  const deployments: DeploymentPair[] = [];
  const reasons = new Set<string>();
  for (const [index, action] of script.actions.entries()) {
    if (action.type === "Retreat" && action.name) {
      const position = active.get(action.name);
      if (position) occupied.delete(position);
      active.delete(action.name);
      continue;
    }
    if (action.type !== "Deploy" || action.cooling) continue;
    const pick = action.name ? byName.get(action.name) : undefined;
    const plannedAction = planned.get(index);
    if (!pick || !action.location || !plannedAction?.affordable) continue;
    const position = key(action.location[0], action.location[1]);
    if (active.has(pick.name) || occupied.has(position)) reasons.add("deployment_position_conflict");
    active.set(pick.name, position);
    occupied.add(position);
    deployments.push({ action, pick, time: plannedAction.time });
  }
  return { deployments, reasons: [...reasons].sort() };
}

function locationCell(row: number, col: number): TemporalCellPressure {
  return {
    row, col, groundHp: 0, airHp: 0, groundCount: 0, airCount: 0,
    incomingAttack: 0, blockDemand: 0, eliteWeight: 0, bossWeight: 0, goalThreat: 0, mergeWeight: 0,
    routeIds: [], enemyIds: [], mechanisms: [], coverageGaps: [],
  };
}

export function evaluateFeasibility(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext,
  mapData: MapData
): FeasibilityResult {
  const timeline = planDeploymentTimeline(script, mapData.options);
  const active = activeDeployments(script, picks, mapData);
  const reasons = new Set([...timeline.reasons, ...active.reasons]);
  const coverageGaps = new Set([...facts.coverageGaps, ...encounter.coverageGaps]);

  for (const window of encounter.criticalWindows) {
    const buckets = encounter.temporalPressure.buckets.filter(bucket => bucket.time >= window.start && bucket.time < window.end);
    let groundDamage = 0;
    let airDamage = 0;
    let hasBlockOrControl = false;
    let maximumSurvival = 0;
    let incomingExposure = 0;
    let hasGroundPressureWithoutBlocker = false;
    for (const bucket of buckets) {
      const available = active.deployments.filter(deployment => deployment.time <= bucket.time);
      const groundDps = available.reduce((sum, deployment) => sum + (bucket.cells.some(cell => cell.groundHp > 0 && covers(deployment.action, deployment.pick, cell))
        ? stageDps(deployment.pick, encounter) : 0), 0);
      const airDps = available.reduce((sum, deployment) => sum + (deployment.pick.profile.position === "RANGED"
        && bucket.cells.some(cell => cell.airHp > 0 && covers(deployment.action, deployment.pick, cell))
        ? stageDps(deployment.pick, encounter) : 0), 0);
      groundDamage += groundDps * encounter.temporalPressure.bucketSeconds;
      airDamage += airDps * encounter.temporalPressure.bucketSeconds;
      if (bucket.cells.some(cell => cell.groundHp > 0)) {
        hasBlockOrControl ||= available.some(deployment => deployment.pick.profile.position === "MELEE"
          || deployment.pick.profile.metrics.controlSeconds > 0);
      }
      const melee = available.filter(deployment => deployment.pick.profile.position === "MELEE");
      const blockers = melee.filter(deployment => deployment.action.location && bucket.cells.some(cell => cell.groundHp > 0
        && cell.row === deployment.action.location![0] && cell.col === deployment.action.location![1]));
      if (bucket.cells.some(cell => cell.groundHp > 0) && blockers.length === 0) hasGroundPressureWithoutBlocker = true;
      const healerCoverage = blockers.reduce((sum, target) => sum + available.reduce((healing, healer) => healing
        + (healer.pick.profile.metrics.healingHps > 0 && target.action.location && covers(healer.action, healer.pick,
          locationCell(target.action.location[0], target.action.location[1])) ? healer.pick.profile.metrics.healingHps : 0), 0), 0);
      const durability = blockers.reduce((sum, deployment) => sum
        + (deployment.pick.profile.metrics.physicalEhp + deployment.pick.profile.metrics.artsEhp) / 2, 0);
      maximumSurvival = Math.max(maximumSurvival, durability + healerCoverage * 15);
      if (blockers.length) incomingExposure += bucket.cells
        .filter(cell => blockers.some(blocker => blocker.action.location
          && blocker.action.location[0] === cell.row && blocker.action.location[1] === cell.col))
        .reduce((sum, cell) => sum + cell.incomingAttack, 0)
        * encounter.temporalPressure.bucketSeconds;
    }
    if (window.groundHp > 0 && groundDamage < window.groundHp * 0.1) reasons.add("critical_window_damage_shortfall");
    if (window.groundHp > 0 && !hasBlockOrControl) reasons.add("critical_window_missing_ground_hold");
    if (window.airHp > 0 && airDamage <= 0) reasons.add("critical_window_missing_anti_air");
    if (window.airHp > 0 && airDamage < window.airHp * 0.08) reasons.add("critical_window_air_damage_shortfall");
    if (maximumSurvival > 0 && incomingExposure > maximumSurvival) reasons.add("critical_window_missing_survival");
    if (hasGroundPressureWithoutBlocker) coverageGaps.add("block_engagement_unknown");
  }
  return { feasible: reasons.size === 0, reasons: [...reasons].sort(), coverageGaps: [...coverageGaps].sort() };
}
