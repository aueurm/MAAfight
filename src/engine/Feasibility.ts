import type { BattleScript, MapData } from "../types";
import { rotateDirection } from "./helpers";
import { costTick, planDeploymentTimeline, type DeploymentTimeline } from "./TimelinePlanner";
import { canTargetAir } from "./TemporalCoverage";
import { estimateSkillWindow, type SkillWindowEstimate } from "./SkillWindow";
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
  endTime: number;
  skillUsage: number;
  activationTimes: number[];
}

interface WindowDeployment extends SkillWindowEstimate { deployment: DeploymentPair }

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function covers(action: DeploymentPair["action"], range: Array<[number, number]>, cell: TemporalCellPressure): boolean {
  if (!action.location) return false;
  return range.some(offset => {
    const [row, col] = rotateDirection(offset, action.direction || "Right");
    return action.location![0] + row === cell.row && action.location![1] + col === cell.col;
  });
}

function normalRange(pick: EnginePick): Array<[number, number]> {
  return pick.profile.baseRange ?? (pick.profile.skillRangeId ? [] : pick.profile.range);
}

function damageMultiplier(pick: EnginePick, encounter: EncounterContext): number {
  const profile = pick.profile;
  const confidence = profile.confidence === "exact" ? 1 : profile.confidence === "partial" ? 0.9 : 0.75;
  if (profile.damageType === "heal") return 0;
  if (profile.damageType === "arts") return Math.max(0.05, 1 - encounter.averageResistance / 100) * confidence;
  const interval = Math.max(0.1, profile.attributes.attackInterval * 100 / Math.max(1, profile.attributes.attackSpeed));
  const perHit = Math.max(profile.attributes.atk * 0.05, profile.attributes.atk - encounter.averageDefense);
  // Retain the existing base-ATK defense approximation for both phases, not an exact skill damage formula.
  return perHit / interval / Math.max(1, profile.metrics.normalDps) * confidence;
}

function activeDeployments(script: BattleScript, picks: EnginePick[], timeline: DeploymentTimeline): { deployments: DeploymentPair[]; reasons: string[] } {
  const planned = new Map(timeline.deployments.map(item => [item.actionIndex, item]));
  const byName = new Map(picks.map(pick => [pick.name, pick]));
  const active = new Map<string, DeploymentPair>();
  const occupied = new Set<string>();
  const deployments: DeploymentPair[] = [];
  const reasons = new Set<string>();
  for (const [index, action] of script.actions.entries()) {
    const target = action.location
      ? [...active.values()].find(item => item.action.location?.[0] === action.location![0]
        && item.action.location?.[1] === action.location![1])
      : action.name ? active.get(action.name) : undefined;
    if (action.type === "Skill" && target && Number.isFinite(timeline.actionTimes[index])) {
      target.activationTimes.push(timeline.actionTimes[index]);
    }
    if (action.type === "Retreat") {
      if (target?.action.location) occupied.delete(key(...target.action.location));
      if (target) active.delete(target.pick.name);
      continue;
    }
    if (action.type !== "Deploy" || action.cooling) continue;
    const pick = action.name ? byName.get(action.name) : undefined;
    const plannedAction = planned.get(index);
    if (!pick || !action.location || !plannedAction?.affordable) continue;
    const position = key(action.location[0], action.location[1]);
    if (active.has(pick.name) || occupied.has(position)) reasons.add("deployment_position_conflict");
    const deployment = { action, pick, time: plannedAction.time, endTime: plannedAction.endTime,
      skillUsage: script.opers.find(operator => operator.name === pick.name)?.skill_usage ?? 1, activationTimes: [] };
    active.set(pick.name, deployment);
    occupied.add(position);
    deployments.push(deployment);
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

// 敌人刚出生时还在行军途中，任何合理落点都够不着。窗口门槛的基数必须是「此刻实际打得到的敌人 HP」，
// 而不是全场存量 HP，否则出生波会让每个候选都判定伤害不足。
function phaseDamage(item: WindowDeployment): Array<{ damage: number; range: Array<[number, number]> }> {
  return [{ damage: item.normalDamage, range: normalRange(item.deployment.pick) },
    { damage: item.skillDamage, range: item.deployment.pick.profile.range }];
}

function damageInCells(item: WindowDeployment, cells: readonly TemporalCellPressure[], air: boolean): number {
  if (air && !canTargetAir(item.deployment.pick)) return 0;
  return phaseDamage(item).reduce((sum, phase) => sum + (cells.some(cell => (air ? cell.airHp : cell.groundHp) > 0
    && covers(item.deployment.action, phase.range, cell)) ? phase.damage : 0), 0);
}

function reachableHp(
  cells: readonly TemporalCellPressure[],
  available: readonly WindowDeployment[],
  air: boolean
): number {
  return cells.reduce((sum, cell) => {
    const hp = air ? cell.airHp : cell.groundHp;
    if (hp <= 0) return sum;
    const covered = available.some(item => damageInCells(item, [cell], air) > 0);
    return covered ? sum + hp : sum;
  }, 0);
}

export function evaluateFeasibility(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext,
  mapData: MapData
): FeasibilityResult {
  const timeline = planDeploymentTimeline(script, mapData.options);
  const autoActivationUntil = script.actions.some(action => action.type === "SkillDaemon") ? Infinity : timeline.time;
  const active = activeDeployments(script, picks, timeline);
  const reasons = new Set([...timeline.reasons, ...active.reasons]);
  const coverageGaps = new Set([...facts.coverageGaps, ...encounter.coverageGaps]);
  const rejectCritical = (reason: string): void => {
    reasons.add(reason);
    coverageGaps.add(reason);
  };
  const horizon = (encounter.temporalPressure.buckets.at(-1)?.time || 0) + encounter.temporalPressure.bucketSeconds;
  if (costTick(mapData.options) > horizon
    && timeline.deployments.some(deployment => deployment.time > horizon)
    && timeline.deployments.reduce((sum, deployment) => sum + deployment.cost, 0) > mapData.options.initialCost) {
    rejectCritical("cost_recovery_not_modeled");
  }

  // 行军途中的敌人可以暂时不在射程内，但每条通往蓝门的实际出怪路线都必须与在场攻击者相交。
  // 不能先按己方射程把敌人 HP 过滤为零，再把整条无人处理的路线判断为可行。
  const hasGoalTiles = mapData.tiles.some(row => row.some(tile => tile.key === "end"));
  const goalRoutes = new Map(mapData.routes.filter(route =>
    mapData.spawnTimeline.some(spawn => spawn.routeIndex === route.id)
    && (!hasGoalTiles || mapData.tiles[route.endPosition.row]?.[route.endPosition.col]?.key === "end"))
    .map(route => [route.id, route]));
  const routeDamage = new Map<number, number>();
  const routePeakHp = new Map<number, number>();
  const damageFactors = new Map(picks.map(pick => [pick.name, damageMultiplier(pick, encounter)]));
  const windowDeployments = new Map<number, WindowDeployment[]>();
  for (const bucket of encounter.temporalPressure.buckets) {
    windowDeployments.set(bucket.time, active.deployments.filter(deployment => deployment.time < bucket.time + encounter.temporalPressure.bucketSeconds
      && bucket.time < deployment.endTime).map(deployment => {
      const estimate = estimateSkillWindow(deployment.pick.profile, { deployedAt: deployment.time,
        windowStart: bucket.time, windowEnd: bucket.time + encounter.temporalPressure.bucketSeconds, activeUntil: deployment.endTime,
        skillUsage: deployment.skillUsage, autoActivationUntil,
        ...(deployment.skillUsage === 0 ? { activationTimes: deployment.activationTimes } : {}) });
      for (const gap of estimate.coverageGaps) coverageGaps.add(gap);
      if (!deployment.pick.profile.baseRange && deployment.pick.profile.skillRangeId) coverageGaps.add("base_attack_range_unknown");
      const factor = damageFactors.get(deployment.pick.name) || 0;
      return { ...estimate, normalDamage: estimate.normalDamage * factor, skillDamage: estimate.skillDamage * factor, deployment };
    }));
  }
  for (const bucket of encounter.temporalPressure.buckets) {
    const bucketHp = new Map<number, number>();
    for (const cell of bucket.cells) {
      for (const motionMode of ["walk", "fly"] as const) {
        const routeIds = cell.routeIds.filter(routeId => goalRoutes.get(routeId)?.motionMode === motionMode);
        const hp = motionMode === "fly" ? cell.airHp : cell.groundHp;
        for (const routeId of routeIds) bucketHp.set(routeId, (bucketHp.get(routeId) || 0) + hp / routeIds.length);
      }
    }
    for (const [routeId, hp] of bucketHp) routePeakHp.set(routeId, Math.max(routePeakHp.get(routeId) || 0, hp));
    for (const item of windowDeployments.get(bucket.time) || []) for (const phase of phaseDamage(item)) {
      if (phase.damage <= 0) continue;
      const deployment = item.deployment;
      const coveredRoutes = new Set<number>();
      for (const cell of bucket.cells) {
        if (!covers(deployment.action, phase.range, cell)) continue;
        for (const routeId of cell.routeIds) {
          const route = goalRoutes.get(routeId);
          if (route && (route.motionMode === "fly"
            ? cell.airHp > 0 && canTargetAir(deployment.pick) : cell.groundHp > 0)) coveredRoutes.add(routeId);
        }
      }
      // Split each phase's finite damage across covered routes; idle skills contribute neither range nor damage.
      for (const routeId of coveredRoutes) routeDamage.set(routeId, (routeDamage.get(routeId) || 0)
        + phase.damage / coveredRoutes.size);
    }
  }
  for (const route of goalRoutes.values()) {
    const air = route.motionMode === "fly";
    const damage = routeDamage.get(route.id) || 0;
    // Check a minimum against the route's peak represented pressure over its entire contact period.
    // This remains a candidate heuristic: the free-moving route model does not simulate blocking or kills.
    const hp = routePeakHp.get(route.id) || 0;
    if (damage <= 0) rejectCritical(air ? "critical_window_missing_anti_air" : "route_missing_ground_coverage");
    else if (damage < hp * (air ? 0.08 : 0.1)) rejectCritical(air ? "route_air_damage_shortfall" : "route_damage_shortfall");
  }

  for (const window of encounter.criticalWindows) {
    const buckets = encounter.temporalPressure.buckets.filter(bucket => bucket.time >= window.start && bucket.time < window.end);
    let groundDamage = 0;
    let airDamage = 0;
    let hasBlockOrControl = false;
    let maximumSurvival = 0;
    let incomingExposure = 0;
    let hasGroundPressureWithoutBlocker = false;
    let engageableGroundHp = 0;
    let engageableAirHp = 0;
    let groundHpSeconds = 0;
    let airHpSeconds = 0;
    for (const bucket of buckets) {
      const windows = windowDeployments.get(bucket.time) || [];
      const available = windows.map(item => item.deployment);
      const groundHp = reachableHp(bucket.cells, windows, false);
      const airHp = reachableHp(bucket.cells, windows, true);
      engageableGroundHp = Math.max(engageableGroundHp, groundHp);
      engageableAirHp = Math.max(engageableAirHp, airHp);
      groundHpSeconds += groundHp * encounter.temporalPressure.bucketSeconds;
      airHpSeconds += airHp * encounter.temporalPressure.bucketSeconds;
      groundDamage += windows.reduce((sum, item) => sum + damageInCells(item, bucket.cells, false), 0);
      airDamage += windows.reduce((sum, item) => sum + damageInCells(item, bucket.cells, true), 0);
      if (bucket.cells.some(cell => cell.groundHp > 0)) {
        hasBlockOrControl ||= available.some(deployment => deployment.pick.profile.position === "MELEE"
          || deployment.pick.profile.metrics.controlSeconds > 0);
      }
      const melee = available.filter(deployment => deployment.pick.profile.position === "MELEE");
      const blockers = melee.filter(deployment => deployment.action.location && bucket.cells.some(cell => cell.groundHp > 0
        && cell.row === deployment.action.location![0] && cell.col === deployment.action.location![1]));
      if (bucket.cells.some(cell => cell.groundHp > 0) && blockers.length === 0) hasGroundPressureWithoutBlocker = true;
      const healerCoverage = blockers.reduce((sum, target) => sum + windows.reduce((healing, item) => {
        if (!target.action.location) return healing;
        const metrics = item.deployment.pick.profile.metrics;
        const legacyHealing = metrics.normalHps === undefined && metrics.skillHps === undefined;
        const normalHps = legacyHealing ? metrics.healingHps : metrics.normalHps ?? 0;
        const skillHps = legacyHealing ? metrics.healingHps : metrics.skillHps ?? 0;
        const cell = locationCell(...target.action.location);
        const healingAmount = (covers(item.deployment.action, normalRange(item.deployment.pick), cell) ? item.normalSeconds * normalHps : 0)
          + (covers(item.deployment.action, item.deployment.pick.profile.range, cell) ? item.skillSeconds * skillHps : 0);
        return healing + healingAmount / encounter.temporalPressure.bucketSeconds;
      }, 0), 0);
      const durability = blockers.reduce((sum, deployment) => sum
        + (deployment.pick.profile.metrics.physicalEhp + deployment.pick.profile.metrics.artsEhp) / 2, 0);
      maximumSurvival = Math.max(maximumSurvival, durability + healerCoverage * 15);
      if (blockers.length) incomingExposure += bucket.cells
        .filter(cell => blockers.some(blocker => blocker.action.location
          && blocker.action.location[0] === cell.row && blocker.action.location[1] === cell.col))
        .reduce((sum, cell) => sum + cell.incomingAttack, 0)
        * encounter.temporalPressure.bucketSeconds;
    }
    // Heuristic lower bounds, not game formulas: retain 10% / 8% per 15 seconds of actual contact.
    // A one-second contact at a window boundary must not require fifteen seconds' damage.
    if (engageableGroundHp > 0 && groundDamage < groundHpSeconds * 0.1 / 15) rejectCritical("critical_window_damage_shortfall");
    if (engageableGroundHp > 0 && !hasBlockOrControl) rejectCritical("critical_window_missing_ground_hold");
    if (engageableAirHp > 0 && airDamage <= 0) rejectCritical("critical_window_missing_anti_air");
    if (engageableAirHp > 0 && airDamage < airHpSeconds * 0.08 / 15) rejectCritical("critical_window_air_damage_shortfall");
    // This exposure assumes one hit per second and no enemy deaths. An upper estimate cannot prove failure.
    // Until attack intervals, damage types and kills are modeled, report uncertainty instead of rejecting.
    if (maximumSurvival > 0 && incomingExposure > maximumSurvival) coverageGaps.add("survival_exposure_upper_bound");
    if (hasGroundPressureWithoutBlocker) coverageGaps.add("block_engagement_unknown");
  }
  return { feasible: reasons.size === 0, reasons: [...reasons].sort(), coverageGaps: [...coverageGaps].sort() };
}
