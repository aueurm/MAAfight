import {
  getCombatOperator,
  listCombatOperators,
  resolveOperatorProfile,
  type CombatOperatorRecord,
} from "./CombatModel";
import { getOperatorKnowledge } from "./OperatorKnowledge";
import { temporalCoverageScore, type TemporalDeployment } from "./TemporalCoverage";
import { planSkillActions } from "./SkillPlanner";
import { planDeploymentTimeline } from "./TimelinePlanner";
import { routePathCells } from "./RouteTimeline";
import { rotateDirection, squadSignature } from "./helpers";
import type { BattleScript, BattleScriptOper, DeploymentPoint, MapData, PlayerOperator } from "../types";
import type {
  CandidateBuildInput,
  CapabilityDemand,
  EncounterContext,
  EngineOptions,
  EnginePick,
  StageFacts,
} from "./types";

const DIRECTIONS = ["Right", "Down", "Left", "Up"] as const;
const UNHEALABLE_SUBPROFESSIONS = new Set(["musha", "juggernaut", "reaper", "unyield"]);
// ponytail: favor healable frontliners until rehearsals show a stage that specifically needs an unhealable solo lane.
const UNHEALABLE_SELECTION_PENALTY = 3;
const MELEE_INCOMING_BONUS = 45;
const MELEE_GOAL_FRONT_BONUS = 120;
const RANGED_BLOCK_COVERAGE_BONUS = 100;
const RANGED_ALL_BLOCKS_BONUS = 200;
// ponytail: score only twelve structurally legal slots; expand only if rehearsals show a missed tactical cell.
const MAX_PLACEMENTS_PER_PICK = 12;

interface SquadState {
  picks: EnginePick[];
  capabilities: CapabilityDemand;
  score: number;
  signature: string;
}

interface SquadExpansion extends Omit<SquadState, "capabilities"> {
  previousCapabilities: CapabilityDemand;
  addition: CapabilityDemand;
}

interface RankedPlacement {
  point: DeploymentPoint;
  direction: typeof DIRECTIONS[number];
  score: number;
}

interface ActiveDeployment {
  pick: EnginePick;
  placement: RankedPlacement;
}

const placementCache = new WeakMap<StageFacts, Map<string, RankedPlacement[]>>();
const incomingDirectionCache = new WeakMap<MapData, Map<string, typeof DIRECTIONS[number] | undefined>>();
const routeThreatCache = new WeakMap<MapData, Map<number, number>>();
const goalFrontCache = new WeakMap<MapData, Map<string, string>>();
const bossGoalCache = new WeakMap<MapData, Set<string>>();

const AREA_SUBPROFESSIONS = new Set(["aoesniper", "bombarder", "splashcaster", "chain", "reaper", "centurion"]);
const SINGLE_TARGET_SUBPROFESSIONS = new Set(["closerange", "siegesniper", "mystic", "artsfghter", "fighter", "crusher", "hammer", "librator"]);
const LANE_HOLD_SUBPROFESSIONS = new Set(["centurion", "reaper", "crusher", "guardian", "protector", "unyield", "artsprotector"]);
const SUPPORT_SUBPROFESSIONS = new Set(["slower", "underminer", "bard", "ritualist", "blessing", "alchemist"]);
const CONTROL_SUBPROFESSIONS = new Set(["slower", "stalker", "pusher", "hookmaster"]);
const ANTI_AIR_SUBPROFESSIONS = new Set(["fastshot", "longrange", "siegesniper", "closerange"]);

export interface SquadBeamResult {
  squads: EnginePick[][];
  expandedStates: number;
  warnings: string[];
}

function emptyCapabilities(): CapabilityDemand {
  return {
    physical: 0, arts: 0, burst: 0, sustain: 0, healing: 0, block: 0,
    control: 0, antiAir: 0, coverage: 0, singleTarget: 0, area: 0, laneHold: 0, support: 0,
    deployment: 0,
  };
}

function addCapabilities(left: CapabilityDemand, right: CapabilityDemand): CapabilityDemand {
  return {
    physical: left.physical + right.physical,
    arts: left.arts + right.arts,
    burst: left.burst + right.burst,
    sustain: left.sustain + right.sustain,
    healing: left.healing + right.healing,
    block: left.block + right.block,
    control: left.control + right.control,
    antiAir: left.antiAir + right.antiAir,
    coverage: left.coverage + right.coverage,
    singleTarget: left.singleTarget + right.singleTarget,
    area: left.area + right.area,
    laneHold: left.laneHold + right.laneHold,
    support: left.support + right.support,
    deployment: left.deployment + right.deployment,
  };
}

function adjustedDps(pick: EnginePick, encounter: EncounterContext, value: number): number {
  const profile = pick.profile;
  if (profile.damageType === "arts") return value * Math.max(0.05, 1 - encounter.averageResistance / 100);
  if (profile.damageType === "physical") {
    const interval = Math.max(0.1, profile.attributes.attackInterval * 100 / Math.max(1, profile.attributes.attackSpeed));
    const perHit = Math.max(profile.attributes.atk * 0.05, profile.attributes.atk - encounter.averageDefense);
    return perHit / interval * (value / Math.max(1, profile.metrics.normalDps));
  }
  return 0;
}

function biasedDemand(demand: CapabilityDemand, options: EngineOptions): CapabilityDemand {
  const bias = options.searchBias;
  if (!bias) return demand;
  return {
    ...demand,
    antiAir: demand.antiAir + bias.antiAir,
    burst: demand.burst + bias.bossBurst,
    healing: demand.healing + bias.healing,
    coverage: demand.coverage + bias.openingCoverage,
    deployment: demand.deployment + bias.openingCoverage * 0.25 + bias.costSafety * 0.1,
  };
}

function knowledgeForPick(pick: EnginePick) {
  return getOperatorKnowledge({
    id: pick.operatorId,
    name: pick.name,
    role: pick.role,
    subProfession: pick.profile.subProfession,
    position: pick.profile.position,
    damageType: pick.profile.damageType,
  }, pick.profile);
}

function isStealthRevealer(pick: EnginePick): boolean {
  return knowledgeForPick(pick).capabilities.includes("stealth-reveal");
}

function stageHasStealth(facts: StageFacts): boolean {
  return facts.temporalPressure.buckets.some(bucket => bucket.cells.some(cell => cell.mechanisms.includes("stealth")));
}

function maximumRouteCoverage(pick: EnginePick, facts: StageFacts): number {
  if (facts.routeCells.length === 0) return 0;
  let maximum = 0;
  for (const point of facts.deploymentPoints) {
    if (!compatible(pick, point)) continue;
    for (const direction of DIRECTIONS) {
      maximum = Math.max(maximum, temporalCoverageScore(pick, point, direction, facts.temporalPressure));
    }
  }
  return maximum / (maximum + 50) * knowledgeForPick(pick).spatial.routeCoverageWeight;
}

function capabilitiesForPick(pick: EnginePick, encounter: EncounterContext, facts: StageFacts): CapabilityDemand {
  const profile = pick.profile;
  const confidenceFactor = profile.confidence === "exact" ? 1 : profile.confidence === "partial" ? 0.9 : 0.75;
  const spatialFit = maximumRouteCoverage(pick, facts);
  const effectiveCoverage = 0.2 + spatialFit * 0.8;
  const normal = adjustedDps(pick, encounter, profile.metrics.normalDps) * effectiveCoverage * confidenceFactor;
  const burst = adjustedDps(pick, encounter, profile.metrics.burstDps) * effectiveCoverage * confidenceFactor;
  const cycle = adjustedDps(pick, encounter, profile.metrics.cycleDps ?? profile.metrics.normalDps) * effectiveCoverage * confidenceFactor;
  const rangedAir = profile.position === "RANGED" && profile.range.some(([, col]) => col >= 2);
  const subclass = profile.subProfession || "";
  const capabilities: CapabilityDemand = {
    physical: profile.damageType === "physical" ? normal / 1800 : 0,
    arts: profile.damageType === "arts" ? normal / 1800 : 0,
    burst: Math.max(0, burst - normal) / 2400,
    sustain: cycle / 1800,
    healing: profile.metrics.healingHps / 1000 * confidenceFactor,
    block: profile.position === "MELEE"
      ? profile.attributes.block / 5 + profile.metrics.physicalEhp / 30000
      : 0,
    control: profile.metrics.controlSeconds / 6 + Number(CONTROL_SUBPROFESSIONS.has(subclass)) * 0.6,
    antiAir: rangedAir
      ? Math.max(normal, cycle) / 1800 * Math.max(0.25, spatialFit)
        + Number(ANTI_AIR_SUBPROFESSIONS.has(subclass)) * 0.8
      : 0,
    coverage: Math.min(1.5, spatialFit * 2 + profile.maxTargets / 8),
    singleTarget: (profile.maxTargets <= 1 ? burst / 1800 : burst / (profile.maxTargets * 3000))
      + Number(SINGLE_TARGET_SUBPROFESSIONS.has(subclass)) * 0.8,
    area: (profile.maxTargets > 1 ? cycle * profile.maxTargets / 2200 : spatialFit * cycle / 5000)
      + Number(AREA_SUBPROFESSIONS.has(subclass)) * 0.8,
    laneHold: (profile.position === "MELEE"
      ? cycle / 2200 + profile.attributes.block / 5 + profile.metrics.physicalEhp / 35000
      : 0) + Number(LANE_HOLD_SUBPROFESSIONS.has(subclass)) * 0.7,
    support: (profile.metrics.healingHps / 1000 + profile.metrics.controlSeconds / 6) * confidenceFactor
      + Number(SUPPORT_SUBPROFESSIONS.has(subclass)) * 0.7,
    deployment: Math.max(0, (30 - profile.attributes.cost) / 20),
  };
  for (const [key, weight] of Object.entries(knowledgeForPick(pick).capabilityWeights)) {
    if (key in capabilities) capabilities[key as keyof CapabilityDemand] += weight;
  }
  return capabilities;
}

function saturated(value: number, demand: number): number {
  return 1 - Math.exp(-Math.max(0, value) / Math.max(0.25, demand * 1.5));
}

function reserveGapWeight(key: keyof CapabilityDemand): number {
  return key === "physical" || key === "arts" ? 0.2 : 1;
}

function preferenceBonus(pick: EnginePick): number {
  return knowledgeForPick(pick).deployment.selectionBias;
}

function squadSelectionAdjustment(pick: EnginePick): number {
  return preferenceBonus(pick) - Number(cannotReceiveAllyHealing(pick)) * UNHEALABLE_SELECTION_PENALTY;
}

function isSustainedHealer(pick: EnginePick): boolean {
  return pick.role === "medic"
    || (pick.profile.subProfession === "bard" || pick.profile.subProfession === "guardian")
      && pick.profile.metrics.healingHps > 0 && pick.profile.skillDuration === 0
    || knowledgeForPick(pick).sustainedHealingSkills.includes(pick.skill);
}

function cannotReceiveAllyHealing(pick: EnginePick): boolean {
  return !knowledgeForPick(pick).deployment.canReceiveAllyHealing
    || UNHEALABLE_SUBPROFESSIONS.has(pick.profile.subProfession || "");
}

function needsSustainedHealing(pick: EnginePick): boolean {
  return pick.profile.position === "MELEE" && !isSustainedHealer(pick)
    && !cannotReceiveAllyHealing(pick);
}

function marginalScore(
  previous: CapabilityDemand,
  previousSaturation: CapabilityDemand,
  addition: CapabilityDemand,
  demand: CapabilityDemand,
  pick: EnginePick,
  selectionAdjustment: number,
  slot: number,
  reserveFocus?: keyof CapabilityDemand
): number {
  if (reserveFocus) {
    const replacementFit = reserveGapWeight(reserveFocus) * demand[reserveFocus]
      * (saturated(previous[reserveFocus] + addition[reserveFocus], demand[reserveFocus]) - previousSaturation[reserveFocus])
      * 100;
    return replacementFit - pick.profile.attributes.cost * 0.04 + selectionAdjustment;
  }
  let gain = 0;
  for (const key of Object.keys(demand) as Array<keyof CapabilityDemand>) {
    gain += demand[key]
      * (saturated(previous[key] + addition[key], demand[key]) - previousSaturation[key])
      * 100;
  }
  const earlyCostPenalty = pick.profile.attributes.cost * (slot < 3 ? 0.35 : 0.06);
  return gain - earlyCostPenalty + selectionAdjustment;
}

function eligibleOperators(options: EngineOptions): Array<{ record: CombatOperatorRecord; player?: PlayerOperator }> {
  const players = options.playerOperators;
  if (!players || players.size === 0) return listCombatOperators().map(record => ({ record }));
  const eligible: Array<{ record: CombatOperatorRecord; player: PlayerOperator }> = [];
  const used = new Set<string>();
  for (const player of players.values()) {
    if (!player.own || player.elite < 2) continue;
    const record = getCombatOperator(player.id) || getCombatOperator(player.name);
    if (!record || used.has(record.id)) continue;
    used.add(record.id);
    eligible.push({ record, player });
  }
  return eligible.sort((left, right) => left.record.id.localeCompare(right.record.id));
}

function pickOptions(options: EngineOptions): EnginePick[] {
  return eligibleOperators(options).flatMap(({ record, player }) => {
    const skillCount = Math.max(1, record.skills.filter(skill => skill.unlockPhase <= 2).length);
    const knowledge = getOperatorKnowledge(record);
    const preferredSkills = knowledge.preferredSkills;
    const excludedSkills = knowledge.avoidedSkills;
    return Array.from({ length: skillCount }, (_, index) => index + 1)
      .filter(skill => !excludedSkills.includes(skill))
      .filter(skill => preferredSkills.length === 0 || preferredSkills.includes(skill))
      .map(skill => ({
        operatorId: record.id,
        name: record.name,
        role: record.role,
        skill,
        skillRank: player?.skillLevel ?? 10,
        profile: resolveOperatorProfile(record, skill, player),
        player,
      }));
  });
}

function operatorSetSignature(picks: EnginePick[]): string {
  return picks.map(pick => pick.operatorId).sort().join("|");
}

function operatorOverlap(left: EnginePick[], right: ReadonlySet<string>): number {
  if (left.length === 0 || right.size === 0) return 0;
  const shared = left.reduce((count, pick) => count + Number(right.has(pick.operatorId)), 0);
  return shared / Math.max(left.length, right.size);
}

export function buildSquadBeam(
  facts: StageFacts,
  encounter: EncounterContext,
  options: EngineOptions,
  checkDeadline?: () => void
): SquadBeamResult {
  const available = pickOptions(options);
  const demand = biasedDemand(encounter.demand, options);
  // ponytail: one threshold gates early vanguard starts; calibrate per-stage only if rehearsals show false positives.
  const openingVanguards = demand.deployment >= 0.5
    ? available.filter(pick => pick.role === "vanguard")
    : [];
  const splitGroundOpening = demand.deployment >= 0.5 && facts.groundRouteCount >= 4 && facts.laneCount >= 4;
  const openingBlockers = splitGroundOpening
    ? available.filter(pick => pick.profile.position === "MELEE" && !isTemporaryPick(pick)
      && pick.profile.attributes.cost <= facts.initialCost + 4)
    : [];
  const openingBlockerSlots = Math.min(2, new Set(openingBlockers.map(pick => pick.operatorId)).size);
  const stealthRevealers = stageHasStealth(facts)
    ? available.filter(isStealthRevealer)
    : [];
  const openingHealers = demand.deployment >= 0.5 && facts.groundRouteCount > 0
    ? available.filter(pick => pick.profile.position === "RANGED" && isSustainedHealer(pick))
    : [];
  // ponytail: cap at two healer slots; revisit only if rehearsals prove three separated goals need more.
  const openingHealerSlots = Math.min(
    2,
    facts.goalCells.length,
    new Set(openingHealers.map(pick => pick.operatorId)).size
  );
  const uniqueOperators = new Set(available.map(pick => pick.operatorId)).size;
  const targetSize = Math.min(12, uniqueOperators);
  const stealthRevealerSlot = stealthRevealers.length
    ? Math.min(targetSize - 1, (openingVanguards.length ? 1 : 0) + openingBlockerSlots)
    : -1;
  const deploymentCoreSize = Math.min(9, facts.characterLimit || 9, facts.deploymentPoints.length, targetSize);
  const beamWidth = Math.max(1, Math.floor(options.search?.squadBeamWidth ?? 32));
  const capabilityCache = new Map<EnginePick, { capabilities: CapabilityDemand; adjustment: number }>();
  for (const pick of available) {
    checkDeadline?.();
    capabilityCache.set(pick, { capabilities: capabilitiesForPick(pick, encounter, facts), adjustment: squadSelectionAdjustment(pick) });
  }
  let beam: SquadState[] = [{ picks: [], capabilities: emptyCapabilities(), score: 0, signature: "" }];
  let expandedStates = 0;
  const compareExpansions = (left: SquadExpansion, right: SquadExpansion): number => right.score - left.score
    || (left.signature ||= squadSignature(left.picks)).localeCompare(right.signature ||= squadSignature(right.picks));

  for (let slot = 0; slot < targetSize; slot++) {
    const expanded = new Map<string, SquadExpansion>();
    for (const state of beam) {
      checkDeadline?.();
      const used = new Set(state.picks.map(pick => pick.operatorId));
      const previousSaturation = emptyCapabilities();
      for (const key of Object.keys(demand) as Array<keyof CapabilityDemand>) {
        previousSaturation[key] = saturated(state.capabilities[key], demand[key]);
      }
      // 同一 state 的后备职责只取决于已有能力，不能为每名候选重复排序。
      const reservePriorities = slot >= deploymentCoreSize
        ? (Object.keys(demand) as Array<keyof CapabilityDemand>).sort((left, right) => {
          const rightGap = reserveGapWeight(right) * demand[right] * (1 - previousSaturation[right]);
          const leftGap = reserveGapWeight(left) * demand[left] * (1 - previousSaturation[left]);
          return rightGap - leftGap || left.localeCompare(right);
        }) : [];
      const reserveFocus = reservePriorities[Math.min(slot - deploymentCoreSize, reservePriorities.length - 1)];
      const slotOptions = slot === 0 && openingVanguards.length ? openingVanguards
        : slot === stealthRevealerSlot ? stealthRevealers
        : slot > 0 && slot <= openingBlockerSlots ? openingBlockers
          : slot > openingBlockerSlots && slot <= openingBlockerSlots + openingHealerSlots ? openingHealers
            : available;
      for (const pick of slotOptions) {
        if (used.has(pick.operatorId)) continue;
        const { capabilities: addition, adjustment } = capabilityCache.get(pick)!;
        const picks = [...state.picks, pick];
        const candidate: SquadExpansion = {
          picks,
          previousCapabilities: state.capabilities,
          addition,
          score: state.score + marginalScore(
            state.capabilities, previousSaturation, addition, demand, pick, adjustment, slot, reserveFocus
          ),
          signature: "",
        };
        const operatorSignature = operatorSetSignature(picks);
        const previous = expanded.get(operatorSignature);
        if (!previous || compareExpansions(candidate, previous) < 0) expanded.set(operatorSignature, candidate);
        expandedStates++;
      }
    }
    // 与原先排序后去重等价：同一干员集合只可能保留评分和 tie-break 最优的技能组合。
    const ordered = [...expanded.entries()].sort((left, right) => compareExpansions(left[1], right[1]));
    const deduplicated = new Map<string, SquadExpansion>();
    const selectedOperatorSets: Array<Set<string>> = [];
    const exploratoryTarget = beamWidth;
    for (const [operatorSignature, state] of ordered) {
      const sufficientlyDistinct = selectedOperatorSets.every(selected => operatorOverlap(state.picks, selected) <= 2 / 3);
      if (sufficientlyDistinct) {
        deduplicated.set(operatorSignature, state);
        selectedOperatorSets.push(new Set(state.picks.map(pick => pick.operatorId)));
      }
      if (deduplicated.size >= exploratoryTarget) break;
    }
    for (const [operatorSignature, state] of ordered) {
      if (!deduplicated.has(operatorSignature)) deduplicated.set(operatorSignature, state);
      if (deduplicated.size >= beamWidth) break;
    }
    // 只为保留的 beam 状态合并能力，避免为随即淘汰的扩展分配能力对象。
    beam = [...deduplicated.values()].map(state => ({
      picks: state.picks,
      score: state.score,
      signature: state.signature,
      capabilities: addCapabilities(state.previousCapabilities, state.addition),
    }));
    if (beam.length === 0) break;
  }

  return {
    squads: beam.map(state => state.picks),
    expandedStates,
    warnings: targetSize < 12 ? [`Only ${targetSize} modeled elite 2 operators are available for the fixed squad.`] : [],
  };
}

function distance(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

function compatible(pick: EnginePick, point: DeploymentPoint): boolean {
  if (point.buildableType === "all") return true;
  return pick.profile.position === "MELEE" ? point.buildableType === "melee" : point.buildableType === "ranged";
}

function placementScore(
  pick: EnginePick,
  point: DeploymentPoint,
  direction: typeof DIRECTIONS[number],
  facts: StageFacts
): number {
  const spatial = knowledgeForPick(pick).spatial;
  const coverage = temporalCoverageScore(pick, point, direction, facts.temporalPressure);
  const nearestRoute = facts.routeCells.length ? Math.min(...facts.routeCells.map(cell => distance(point, cell))) : 0;
  const nearestGoal = facts.goalCells.length ? Math.min(...facts.goalCells.map(cell => distance(point, cell))) : 0;
  const melee = pick.profile.position === "MELEE";
  return Math.log1p(coverage) * 20 * spatial.routeCoverageWeight
    - nearestRoute * (melee ? 22 : 8) * spatial.routeDistanceWeight
    - nearestGoal * (melee ? 1 : 0.5) * spatial.routeDistanceWeight;
}

function rankedPlacements(pick: EnginePick, facts: StageFacts): RankedPlacement[] {
  let byPick = placementCache.get(facts);
  if (!byPick) {
    byPick = new Map();
    placementCache.set(facts, byPick);
  }
  const spatial = knowledgeForPick(pick).spatial;
  const key = `${pick.operatorId}:${pick.skill}:${pick.profile.position}:${JSON.stringify(pick.profile.range)}:${spatial.routeCoverageWeight}:${spatial.routeDistanceWeight}`;
  const cached = byPick.get(key);
  if (cached) return cached;
  const ranked = facts.deploymentPoints.flatMap(point => compatible(pick, point)
    ? DIRECTIONS.map(direction => ({ point, direction, score: placementScore(pick, point, direction, facts) }))
    : [])
    .sort((left, right) => right.score - left.score
      || left.point.row - right.point.row || left.point.col - right.point.col
      || left.direction.localeCompare(right.direction));
  byPick.set(key, ranked);
  return ranked;
}

function temporalMarginalAdjustment(
  pick: EnginePick,
  placement: RankedPlacement,
  active: Map<string, ActiveDeployment>,
  facts: StageFacts
): number {
  const existing: TemporalDeployment[] = [...active.values()].map(deployment => ({
    pick: deployment.pick,
    location: deployment.placement.point,
    direction: deployment.placement.direction,
  }));
  const base = temporalCoverageScore(pick, placement.point, placement.direction, facts.temporalPressure);
  const marginal = temporalCoverageScore(pick, placement.point, placement.direction, facts.temporalPressure, existing);
  return (Math.log1p(marginal) - Math.log1p(base)) * 20;
}

function routeThreats(mapData: MapData): Map<number, number> {
  const cached = routeThreatCache.get(mapData);
  if (cached) return cached;
  const enemies = new Map(mapData.enemyDetails.map(enemy => [enemy.id, enemy]));
  const threats = new Map<number, number>();
  for (const spawn of mapData.spawnTimeline) {
    const enemy = enemies.get(spawn.enemyId);
    const multiplier = enemy?.isBoss ? 3 : enemy?.isElite ? 2 : 1;
    const threat = Math.max(1, spawn.count) * (Math.max(1, enemy?.maxHp || 1) + Math.max(0, enemy?.atk || 0) * 10) * multiplier;
    threats.set(spawn.routeIndex, (threats.get(spawn.routeIndex) || 0) + threat);
  }
  routeThreatCache.set(mapData, threats);
  return threats;
}

function incomingDirection(point: DeploymentPoint, route: MapData["routes"][number]): typeof DIRECTIONS[number] | undefined {
  const cells = [route.startPosition, ...route.checkpoints, route.endPosition];
  let closestIndex = -1;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const [index, cell] of cells.entries()) {
    const cellDistance = distance(point, cell);
    if (cellDistance < closestDistance) {
      closestIndex = index;
      closestDistance = cellDistance;
    }
  }
  if (closestDistance > 1 || closestIndex < 0 || cells.length < 2) return undefined;
  const current = cells[closestIndex];
  const upstream = closestIndex > 0 ? cells[closestIndex - 1] : cells[1];
  const rowDelta = closestIndex > 0 ? upstream.row - point.row : current.row - upstream.row;
  const colDelta = closestIndex > 0 ? upstream.col - point.col : current.col - upstream.col;
  if (Math.abs(colDelta) >= Math.abs(rowDelta)) return colDelta < 0 ? "Left" : "Right";
  return rowDelta < 0 ? "Up" : "Down";
}

function preferredIncomingDirection(
  point: DeploymentPoint,
  mapData: MapData,
  threats: Map<number, number>
): typeof DIRECTIONS[number] | undefined {
  let byPoint = incomingDirectionCache.get(mapData);
  if (!byPoint) {
    byPoint = new Map();
    incomingDirectionCache.set(mapData, byPoint);
  }
  const key = `${point.row},${point.col}`;
  if (byPoint.has(key)) return byPoint.get(key);
  const directionThreats = new Map<typeof DIRECTIONS[number], number>();
  for (const route of mapData.routes) {
    if (route.motionMode !== "walk") continue;
    const direction = incomingDirection(point, route);
    if (!direction) continue;
    directionThreats.set(direction, (directionThreats.get(direction) || 0) + (threats.get(route.id) || 0));
  }
  const direction = [...directionThreats.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  byPoint.set(key, direction);
  return direction;
}

function routeFinalDirection(route: MapData["routes"][number]): typeof DIRECTIONS[number] | undefined {
  const cells = routePathCells(route);
  for (let index = cells.length - 1; index > 0; index--) {
    const from = cells[index - 1];
    const to = cells[index];
    const row = to.row - from.row;
    const col = to.col - from.col;
    if (row === 0 && col === 0) continue;
    if (Math.abs(col) >= Math.abs(row)) return col > 0 ? "Right" : "Left";
    return row > 0 ? "Down" : "Up";
  }
  return undefined;
}

function preferredStealthDirection(mapData: MapData): typeof DIRECTIONS[number] | undefined {
  const enemies = new Map(mapData.enemyDetails.map(enemy => [enemy.id, enemy]));
  const routes = new Map(mapData.routes.map(route => [route.id, route]));
  const weights = new Map<typeof DIRECTIONS[number], number>();
  for (const spawn of mapData.spawnTimeline) {
    const enemy = enemies.get(spawn.enemyId);
    if (!enemy?.mechanics?.includes("stealth")) continue;
    const direction = routes.get(spawn.routeIndex) && routeFinalDirection(routes.get(spawn.routeIndex)!);
    if (!direction) continue;
    const threat = Math.max(1, spawn.count) * (Math.max(1, enemy.maxHp) + Math.max(0, enemy.atk) * 10);
    weights.set(direction, (weights.get(direction) || 0) + threat);
  }
  return [...weights.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function goalFrontByPoint(mapData: MapData): Map<string, string> {
  const cached = goalFrontCache.get(mapData);
  if (cached) return cached;
  const fronts = new Map<string, string>();
  const goalRoutes = new Map<string, typeof mapData.routes>();
  const hasGoalTiles = mapData.tiles.some(row => row.some(tile => tile.key === "end"));
  for (const route of mapData.routes.filter(route => route.motionMode === "walk")) {
    if (hasGoalTiles && mapData.tiles[route.endPosition.row]?.[route.endPosition.col]?.key !== "end") continue;
    const goalKey = `${route.endPosition.row},${route.endPosition.col}`;
    goalRoutes.set(goalKey, [...(goalRoutes.get(goalKey) || []), route]);
  }
  const melee = mapData.deploymentPoints.filter(point => point.buildableType !== "ranged");
  const roadMelee = melee.filter(point => mapData.tiles[point.row]?.[point.col]?.key === "road");
  const candidates = roadMelee.length ? roadMelee : melee;
  const claimed = new Set<string>();
  for (const [goalKey, routes] of goalRoutes) {
    const routeTails = routes.map(route => routePathCells(route).slice(-6));
    // ponytail: rank against this goal's route tails so recessed goals cannot share an unrelated global nearest road tile.
    const ranked = candidates.map(point => {
      const distances = routeTails.map(tail => Math.min(...tail.map(cell => distance(point, cell))));
      return { point, farthest: Math.max(...distances), total: distances.reduce((sum, value) => sum + value, 0),
        goalDistance: distance(point, routes[0].endPosition) };
    }).sort((left, right) => left.farthest - right.farthest || left.total - right.total
      || left.goalDistance - right.goalDistance
      || left.point.row - right.point.row || left.point.col - right.point.col);
    const selected = ranked.find(({ point }) => !claimed.has(`${point.row},${point.col}`)) || ranked[0];
    if (!selected) continue;
    const pointKey = `${selected.point.row},${selected.point.col}`;
    fronts.set(pointKey, goalKey);
    claimed.add(pointKey);
  }
  goalFrontCache.set(mapData, fronts);
  return fronts;
}

function bossGoalKeys(mapData: MapData): Set<string> {
  const cached = bossGoalCache.get(mapData);
  if (cached) return cached;
  const bossIds = new Set(mapData.enemyDetails.filter(enemy => enemy.isBoss).map(enemy => enemy.id));
  const bossRouteIds = new Set(mapData.spawnTimeline
    .filter(spawn => bossIds.has(spawn.enemyId))
    .map(spawn => spawn.routeIndex));
  const goals = new Set(mapData.routes
    .filter(route => route.motionMode === "walk" && bossRouteIds.has(route.id))
    .map(route => `${route.endPosition.row},${route.endPosition.col}`));
  bossGoalCache.set(mapData, goals);
  return goals;
}

function coversPoint(deployment: ActiveDeployment, point: DeploymentPoint): boolean {
  return deployment.pick.profile.range.some(offset => {
    const [row, col] = rotateDirection(offset, deployment.placement.direction);
    return deployment.placement.point.row + row === point.row
      && deployment.placement.point.col + col === point.col;
  });
}

function placementPreference(
  pick: EnginePick,
  placement: RankedPlacement,
  meleeBlocks: DeploymentPoint[],
  mapData: MapData,
  threats: Map<number, number>,
  goalFronts: Map<string, string>,
  securedGoals: Set<string>,
): number {
  if (pick.profile.position === "MELEE") {
    const goal = goalFronts.get(`${placement.point.row},${placement.point.col}`);
    return Number(Boolean(goal && !securedGoals.has(goal))) * MELEE_GOAL_FRONT_BONUS
      + Number(placement.direction === preferredIncomingDirection(placement.point, mapData, threats)) * MELEE_INCOMING_BONUS;
  }
  if (meleeBlocks.length === 0) return 0;
  const coveredBlocks = meleeBlocks.filter(block => coversPoint({ pick, placement }, block)).length;
  if (coveredBlocks === 0) return 0;
  // ponytail: earlier melee cells stand in for blocked enemies; add timed occupancy only if rehearsals show this static proxy is insufficient.
  return coveredBlocks * RANGED_BLOCK_COVERAGE_BONUS
    + Number(coveredBlocks === meleeBlocks.length) * RANGED_ALL_BLOCKS_BONUS;
}

function toOper(pick: EnginePick, manualSkillNames: Set<string>): BattleScriptOper {
  return { name: pick.name, skill: pick.skill, skill_usage: manualSkillNames.has(pick.name) ? 0 : 1 };
}

function isTemporaryPick(pick: EnginePick): boolean {
  return knowledgeForPick(pick).deployment.temporary || pick.role === "vanguard" || pick.profile.subProfession === "executor";
}

function uniquePicks(picks: Array<EnginePick | undefined>): EnginePick[] {
  const ids = new Set<string>();
  return picks.filter((pick): pick is EnginePick => {
    if (!pick || ids.has(pick.operatorId)) return false;
    ids.add(pick.operatorId);
    return true;
  });
}

export function buildCandidate(input: CandidateBuildInput, checkDeadline?: () => void): { script: BattleScript; picks: EnginePick[]; warnings: string[]; coverageGaps: string[] } {
  const occupiedPositions = new Set<string>();
  const active = new Map<string, ActiveDeployment>();
  const meleeBlocks: DeploymentPoint[] = [];
  const threats = routeThreats(input.mapData);
  const goalFronts = goalFrontByPoint(input.mapData);
  const bossGoals = bossGoalKeys(input.mapData);
  const securedGoals = new Set<string>();
  const actions: BattleScript["actions"] = [{ type: "SpeedUp" }];
  // 候选固定以 SpeedUp 开局；模型时长是游戏秒，MAA 延时是真实毫秒。
  const gameSecondsToDelay = (seconds: number): number => Math.round(seconds * 1000 / 2);
  const deployLimit = Math.min(9, input.facts.characterLimit || 9, input.facts.deploymentPoints.length);
  const hasStealth = stageHasStealth(input.facts);
  const openingVanguard = input.openingPressure && input.picks[0]?.role === "vanguard"
    ? input.picks[0]
    : undefined;
  const plansDefensiveFrontline = input.openingPressure || bossGoals.size > 0;
  const permanentMelee = input.picks.filter(pick => pick.profile.position === "MELEE" && !isTemporaryPick(pick));
  const frontlineCount = new Set(goalFronts.values()).size;
  const laneHolder = (pick: EnginePick): boolean => LANE_HOLD_SUBPROFESSIONS.has(pick.profile.subProfession || "")
    || knowledgeForPick(pick).capabilities.includes("lane-hold");
  const orderedFrontliners = [
    ...permanentMelee.filter(laneHolder),
    ...permanentMelee.filter(pick => !laneHolder(pick)),
  ];
  const bossFrontliners = orderedFrontliners
    .filter(pick => !cannotReceiveAllyHealing(pick))
    .slice(0, Math.min(bossGoals.size, frontlineCount));
  const bossFrontlinerIds = new Set(bossFrontliners.map(pick => pick.operatorId));
  const remainingFrontliners = bossGoals.size
    ? [
      ...orderedFrontliners.filter(pick => cannotReceiveAllyHealing(pick)),
      ...orderedFrontliners.filter(pick => !cannotReceiveAllyHealing(pick)),
    ].filter(pick => !bossFrontlinerIds.has(pick.operatorId))
    : orderedFrontliners;
  // ponytail: boss lanes reserve healable blockers; unhealable lane holders take the remaining ordinary fronts.
  const frontlinePicks = plansDefensiveFrontline
    ? [...bossFrontliners, ...remainingFrontliners].slice(0, frontlineCount)
    : [];
  const frontlineIds = new Set(frontlinePicks.map(pick => pick.operatorId));
  const splitGroundOpening = input.facts.groundRouteCount >= 4 && input.facts.laneCount >= 4;
  // ponytail: only wide split openings need two cheap permanent melee units before expensive tanks or support can arrive.
  const openingBlockers = plansDefensiveFrontline
    ? (splitGroundOpening
      ? [...frontlinePicks, ...permanentMelee.filter(pick => !frontlineIds.has(pick.operatorId))]
        .sort((left, right) => left.profile.attributes.cost - right.profile.attributes.cost
          || left.operatorId.localeCompare(right.operatorId))
        .slice(0, 2)
      : frontlinePicks)
    : [];
  const openingHealers = plansDefensiveFrontline
    ? input.picks.filter(pick => pick.profile.position === "RANGED" && isSustainedHealer(pick))
    : [];
  // ponytail: one early anti-air is enough to avoid delaying every opening flier behind the healer queue.
  const openingAntiAir = plansDefensiveFrontline && input.facts.flyingRouteCount > 0
    ? input.picks.filter(pick => pick.profile.position === "RANGED" && !isSustainedHealer(pick)
      && pick.profile.range.length >= 3).slice(0, 1)
    : [];
  const openingStealthRevealer = hasStealth
    ? input.picks.filter(isStealthRevealer).slice(0, 1)
    : [];
  const openingCore = openingAntiAir.length
    ? [...openingBlockers, ...openingStealthRevealer, ...openingAntiAir]
    : [...openingBlockers, ...openingStealthRevealer];
  const prioritizedPicks = uniquePicks([openingVanguard, ...openingCore, ...openingHealers]);
  const prioritizedIds = new Set(prioritizedPicks.map(pick => pick.operatorId));
  const plannedDeploymentPicks = plansDefensiveFrontline
    ? [
      ...prioritizedPicks,
      ...input.picks.filter(pick => !prioritizedIds.has(pick.operatorId)),
    ]
    : input.picks;
  const openingPriority = input.openingPressure && input.facts.flyingRouteCount > 0
    ? uniquePicks([openingVanguard, ...openingBlockers.slice(0, 1), ...openingStealthRevealer, ...openingAntiAir, ...openingBlockers.slice(1)])
    : [];
  const openingPriorityIds = new Set(openingPriority.map(pick => pick.operatorId));
  // ponytail: deploy blockers before ranged support, otherwise cost waiting leaks split opening ground lanes.
  const deploymentPicks = openingPriority.length
    ? [
      ...openingPriority,
      ...plannedDeploymentPicks.slice(0, deployLimit)
        .filter(pick => !openingPriorityIds.has(pick.operatorId))
        .sort((left, right) => left.profile.attributes.cost - right.profile.attributes.cost
          || left.operatorId.localeCompare(right.operatorId)),
      ...plannedDeploymentPicks.slice(deployLimit),
    ]
    : plannedDeploymentPicks;
  const jointDecisions = new Map(input.jointPlan?.decisions.map(decision => [decision.pick.operatorId, decision]));
  const jointPreDelay = (pick: EnginePick): number | undefined => {
    if (!input.jointPlan) return undefined;
    const targetTime = jointDecisions.get(pick.operatorId)?.targetTime || 0;
    if (targetTime <= 0) return undefined;
    const timeline = planDeploymentTimeline({ actions: [...actions, {
      type: "Deploy", name: pick.name, costs: Math.round(pick.profile.attributes.cost),
    }] }, input.mapData.options);
    const readyTime = timeline.deployments[timeline.deployments.length - 1]?.time ?? 0;
    const delay = Math.max(0, targetTime - readyTime);
    return delay > 0 ? gameSecondsToDelay(delay) : undefined;
  };

  const removeActive = (deployment: ActiveDeployment): void => {
    active.delete(deployment.pick.operatorId);
    occupiedPositions.delete(`${deployment.placement.point.row},${deployment.placement.point.col}`);
    const blockIndex = meleeBlocks.findIndex(point => point.row === deployment.placement.point.row
      && point.col === deployment.placement.point.col);
    if (blockIndex >= 0) meleeBlocks.splice(blockIndex, 1);
  };
  const addDeployment = (pick: EnginePick, placement: RankedPlacement, preDelay?: number): void => {
    occupiedPositions.add(`${placement.point.row},${placement.point.col}`);
    active.set(pick.operatorId, { pick, placement });
    if (pick.profile.position === "MELEE") {
      meleeBlocks.push(placement.point);
      const goal = goalFronts.get(`${placement.point.row},${placement.point.col}`);
      if (goal) securedGoals.add(goal);
    }
    actions.push({
      type: "Deploy",
      name: pick.name,
      location: [placement.point.row, placement.point.col],
      direction: placement.direction,
      costs: Math.round(pick.profile.attributes.cost),
      ...(preDelay !== undefined ? { pre_delay: preDelay }
        : input.timingVariant > 0 ? { pre_delay: input.timingVariant * 250 } : {}),
    });
  };

  for (const pick of deploymentPicks) {
    checkDeadline?.();
    if (active.size >= deployLimit) {
      const vanguard = !isTemporaryPick(pick)
        ? [...active.values()].find(deployment => deployment.pick.role === "vanguard"
          && !goalFronts.has(`${deployment.placement.point.row},${deployment.placement.point.col}`))
        : undefined;
      const ordinary = !isTemporaryPick(pick) && !vanguard
        ? [...active.values()].find(deployment => !isTemporaryPick(deployment.pick)
          && deployment.pick.profile.position !== "MELEE"
          && !isSustainedHealer(deployment.pick)
          && preferenceBonus(deployment.pick) === 0
          && !goalFronts.has(`${deployment.placement.point.row},${deployment.placement.point.col}`))
          || [...active.values()].find(deployment => !isTemporaryPick(deployment.pick)
            && deployment.pick.profile.position !== "MELEE"
            && !isSustainedHealer(deployment.pick)
            && !goalFronts.has(`${deployment.placement.point.row},${deployment.placement.point.col}`))
        : undefined;
      const outgoing = vanguard || ordinary;
      if (!outgoing) continue;
      // ponytail: permanent melee preserve lane interception; rotate only a non-frontline ranged unit.
      actions.push({ type: "Retreat", name: outgoing.pick.name, costs: Math.round(pick.profile.attributes.cost) });
      removeActive(outgoing);
    }
    const ranked = rankedPlacements(pick, input.facts)
      .filter(({ point }) => !occupiedPositions.has(`${point.row},${point.col}`));
    const unreserved = isTemporaryPick(pick)
      ? ranked.filter(({ point }) => !goalFronts.has(`${point.row},${point.col}`))
      : ranked;
    let placements = unreserved.length ? unreserved : ranked;
    const stealthDirection = isStealthRevealer(pick) ? preferredStealthDirection(input.mapData) : undefined;
    if (stealthDirection) {
      const facingStealth = placements.filter(placement => placement.direction === stealthDirection);
      if (facingStealth.length) placements = facingStealth;
    }
    if (frontlineIds.has(pick.operatorId) && placements.length) {
      const roleFronts = placements.filter(({ point }) => {
        const goal = goalFronts.get(`${point.row},${point.col}`);
        if (!goal || securedGoals.has(goal)) return false;
        return cannotReceiveAllyHealing(pick) ? !bossGoals.has(goal) : bossGoals.has(goal);
      });
      if (roleFronts.length) placements = roleFronts;
    }
    if (pick.profile.position === "RANGED" && isSustainedHealer(pick) && placements.length) {
      const activeHealers = [...active.values()].filter(deployment => isSustainedHealer(deployment.pick));
      const healingTargets = [...active.values()]
        .filter(deployment => deployment.pick.profile.position === "MELEE"
          && !cannotReceiveAllyHealing(deployment.pick)
          && (needsSustainedHealing(deployment.pick)
            || bossGoals.has(goalFronts.get(`${deployment.placement.point.row},${deployment.placement.point.col}`) || "")))
        .map(deployment => deployment.placement.point);
      const uncoveredBlocks = healingTargets.filter(block => !activeHealers.some(healer => coversPoint(healer, block)));
      const uncoveredBossBlocks = uncoveredBlocks.filter(block => bossGoals.has(goalFronts.get(`${block.row},${block.col}`) || ""));
      const coverageTargets = uncoveredBossBlocks.length ? uncoveredBossBlocks
        : uncoveredBlocks.length ? uncoveredBlocks : healingTargets;
      const covered = (placement: RankedPlacement): number => coverageTargets
        .filter(block => coversPoint({ pick, placement }, block)).length;
      if (coverageTargets.length) {
        const maximumCovered = Math.max(...placements.map(covered));
        if (maximumCovered > 0) placements = placements.filter(placement => covered(placement) === maximumCovered);
      }
    }
    if (input.openingPressure && pick.profile.position === "MELEE" && pick.profile.subProfession !== "executor"
      && placements.length && input.facts.goalCells.length) {
      const goalDistance = (placement: RankedPlacement): number => Math.min(
        ...input.facts.goalCells.map(goal => distance(placement.point, goal))
      );
      const nearestDefensiveDistance = Math.min(...placements.map(goalDistance));
      // ponytail: one-tile slack keeps variants while bounding pressured melee to the deepest legal band.
      placements = placements.filter(placement => goalDistance(placement) <= nearestDefensiveDistance + 1);
    }
    const healers = [...active.values()].filter(deployment => isSustainedHealer(deployment.pick));
    if (input.openingPressure && needsSustainedHealing(pick) && healers.length && placements.length) {
      const covered = placements.filter(placement => healers.some(healer => coversPoint(healer, placement.point)));
      // ponytail: keep a legal uncovered fallback when the roster or map has no covered tile.
      if (covered.length) placements = covered;
    }
    const joint = jointDecisions.get(pick.operatorId);
    if (joint) {
      const planned = placements.find(placement => placement.point.row === joint.location[0]
        && placement.point.col === joint.location[1] && placement.direction === joint.direction);
      if (planned) placements = [planned];
    }
    if (placements.length === 0) continue;
    placements = placements.slice(0, MAX_PLACEMENTS_PER_PICK)
      .map(placement => ({
        ...placement,
        score: placement.score + temporalMarginalAdjustment(pick, placement, active, input.facts)
          + placementPreference(pick, placement, meleeBlocks, input.mapData, threats, goalFronts, securedGoals),
      }))
      .sort((left, right) => right.score - left.score
        || left.point.row - right.point.row || left.point.col - right.point.col
        || left.direction.localeCompare(right.direction));
    const placement = placements[Math.min(input.positionVariant, placements.length - 1)];
    addDeployment(pick, placement, jointPreDelay(pick));
  }

  // ponytail: rotate one executor; add threat-window scheduling only after rehearsals prove it changes a result.
  const executor = [...active.values()].find(deployment => deployment.pick.profile.subProfession === "executor"
    && deployment.pick.profile.skillDuration > 0);
  if (executor) {
    actions.push({ type: "Retreat", name: executor.pick.name, pre_delay: gameSecondsToDelay(executor.pick.profile.skillDuration) });
    removeActive(executor);
    if (executor.pick.profile.respawnTime > 0) {
      addDeployment(executor.pick, executor.placement, gameSecondsToDelay(executor.pick.profile.respawnTime));
    }
  }
  const stealthRevealer = hasStealth ? input.picks.find(isStealthRevealer) : undefined;
  const stealthDeployIndex = stealthRevealer
    ? actions.map(action => action.type === "Deploy" && action.name === stealthRevealer.name).lastIndexOf(true)
    : -1;
  const skillPlan = input.encounter
    ? planSkillActions(
      stealthDeployIndex >= 0 ? actions.slice(0, stealthDeployIndex + 1) : actions,
      stealthRevealer ? [stealthRevealer] : input.picks,
      input.encounter,
      input.mapData.options,
    )
    : { actions: [], strategies: {}, coverageGaps: [], usesDaemon: true };
  if (skillPlan.usesDaemon) actions.push({ type: "SkillDaemon" });
  else {
    actions.splice(1, 0, { type: "ResetStopwatch" });
    const skillDeployIndex = stealthRevealer
      ? actions.map(action => action.type === "Deploy" && action.name === stealthRevealer.name).lastIndexOf(true)
      : -1;
    if (skillDeployIndex >= 0) actions.splice(skillDeployIndex + 1, 0, ...skillPlan.actions);
    else actions.push(...skillPlan.actions);
  }
  const manualSkillNames = new Set(skillPlan.actions
    .map(action => action.name)
    .filter((name): name is string => Boolean(name)));

  const warnings = [
    ...(input.picks.length < 12 ? [`Only ${input.picks.length} modeled elite 2 operators are available for the fixed squad.`] : []),
    ...skillPlan.coverageGaps,
  ];
  const script: BattleScript = {
    stage_name: input.stageCode,
    minimum_required: "v6.0.0",
    doc: { title: `${input.stageCode} MAAfight v2`, details: input.facts.summary },
    opers: input.picks.map(pick => toOper(pick, manualSkillNames)),
    groups: [],
    actions,
    generatedAt: new Date().toISOString(),
    metadata: {
      source: "maafight-v2-skill-model",
      difficulty: input.facts.difficulty,
      playerOperatorsUsed: Boolean(input.options.playerOperators?.size),
      operatorGaps: input.picks.length < 12 ? [`fixed squad missing ${12 - input.picks.length} operators`] : [],
      warnings: [...warnings],
    },
    version: 3,
  };
  return { script, picks: input.picks, warnings, coverageGaps: skillPlan.coverageGaps };
}
