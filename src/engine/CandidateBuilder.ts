import {
  getCombatOperator,
  listCombatOperators,
  resolveOperatorProfile,
  type CombatOperatorRecord,
} from "./CombatModel";
import { squadSignature } from "./helpers";
import type { BattleScript, BattleScriptOper, DeploymentPoint, PlayerOperator } from "../types";
import { copilotPriorStats, directionPriorScore, positionPriorScore, timingVariantOrder, type CopilotPriorStats } from "./CopilotPrior";
import type {
  CandidateBuildInput,
  CapabilityDemand,
  EncounterContext,
  EngineOptions,
  EnginePick,
  SearchConfig,
  StageFacts,
} from "./types";

const DIRECTIONS = ["Right", "Down", "Left", "Up"] as const;

interface SquadState {
  picks: EnginePick[];
  capabilities: CapabilityDemand;
  score: number;
  signature: string;
}

interface RankedPlacement {
  point: DeploymentPoint;
  direction: typeof DIRECTIONS[number];
  score: number;
}

export interface CandidatePerturbation {
  positionVariant: number;
  directionVariant: number;
  timingDelayMs: number;
  orderVariant: number;
  skillVariant: number;
}

const placementCache = new WeakMap<StageFacts, Map<string, RankedPlacement[]>>();

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

function capabilitiesForPick(pick: EnginePick, encounter: EncounterContext): CapabilityDemand {
  const profile = pick.profile;
  const confidenceFactor = profile.confidence === "exact" ? 1 : profile.confidence === "partial" ? 0.9 : 0.75;
  const normal = adjustedDps(pick, encounter, profile.metrics.normalDps) * confidenceFactor;
  const burst = adjustedDps(pick, encounter, profile.metrics.burstDps) * confidenceFactor;
  const cycle = adjustedDps(pick, encounter, profile.metrics.cycleDps ?? profile.metrics.normalDps) * confidenceFactor;
  const rangedAir = profile.position === "RANGED" && profile.range.some(([, col]) => col >= 2);
  const subclass = profile.subProfession || "";
  return {
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
      ? Math.max(normal, cycle) / 3600
        + Number(ANTI_AIR_SUBPROFESSIONS.has(subclass)) * 0.8
      : 0,
    coverage: 0,
    singleTarget: (profile.maxTargets <= 1 ? burst / 1800 : burst / (profile.maxTargets * 3000))
      + Number(SINGLE_TARGET_SUBPROFESSIONS.has(subclass)) * 0.8,
    area: (profile.maxTargets > 1 ? cycle * profile.maxTargets / 2200 : cycle / 10000)
      + Number(AREA_SUBPROFESSIONS.has(subclass)) * 0.8,
    laneHold: (profile.position === "MELEE"
      ? cycle / 2200 + profile.attributes.block / 5 + profile.metrics.physicalEhp / 35000
      : 0) + Number(LANE_HOLD_SUBPROFESSIONS.has(subclass)) * 0.7,
    support: (profile.metrics.healingHps / 1000 + profile.metrics.controlSeconds / 6) * confidenceFactor
      + Number(SUPPORT_SUBPROFESSIONS.has(subclass)) * 0.7,
    deployment: Math.max(0, (30 - profile.attributes.cost) / 20),
  };
}

function saturated(value: number, demand: number): number {
  return 1 - Math.exp(-Math.max(0, value) / Math.max(0.25, demand * 1.5));
}

function reserveGapWeight(key: keyof CapabilityDemand): number {
  return key === "physical" || key === "arts" ? 0.2 : 1;
}

function marginalScore(
  previous: CapabilityDemand,
  addition: CapabilityDemand,
  demand: CapabilityDemand,
  pick: EnginePick,
  slot: number,
  deploymentCoreSize: number
): number {
  if (slot >= deploymentCoreSize) {
    const priorities = (Object.keys(demand) as Array<keyof CapabilityDemand>)
      .sort((left, right) => {
        const rightGap = reserveGapWeight(right) * demand[right] * (1 - saturated(previous[right], demand[right]));
        const leftGap = reserveGapWeight(left) * demand[left] * (1 - saturated(previous[left], demand[left]));
        return rightGap - leftGap || left.localeCompare(right);
      });
    const focus = priorities[Math.min(slot - deploymentCoreSize, priorities.length - 1)];
    const replacementFit = reserveGapWeight(focus) * demand[focus]
      * (saturated(previous[focus] + addition[focus], demand[focus]) - saturated(previous[focus], demand[focus]))
      * 100;
    return replacementFit - pick.profile.attributes.cost * 0.04;
  }
  let gain = 0;
  for (const key of Object.keys(demand) as Array<keyof CapabilityDemand>) {
    gain += demand[key]
      * (saturated(previous[key] + addition[key], demand[key]) - saturated(previous[key], demand[key]))
      * 100;
  }
  const earlyCostPenalty = pick.profile.attributes.cost * (slot < 3 ? 0.35 : 0.06);
  return gain - earlyCostPenalty;
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
    return Array.from({ length: skillCount }, (_, index) => {
      const skill = index + 1;
      return {
        operatorId: record.id,
        name: record.name,
        role: record.role,
        skill,
        skillRank: player?.skillLevel ?? 10,
        profile: resolveOperatorProfile(record, skill, player),
        player,
      };
    });
  });
}

function operatorSetSignature(picks: EnginePick[]): string {
  return picks.map(pick => pick.operatorId).sort().join("|");
}

function operatorOverlap(left: EnginePick[], right: EnginePick[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightIds = new Set(right.map(pick => pick.operatorId));
  const shared = left.reduce((count, pick) => count + Number(rightIds.has(pick.operatorId)), 0);
  return shared / Math.max(left.length, right.length);
}

export function buildSquadBeam(
  facts: StageFacts,
  encounter: EncounterContext,
  options: EngineOptions
): SquadBeamResult {
  const available = pickOptions(options);
  const uniqueOperators = new Set(available.map(pick => pick.operatorId)).size;
  const targetSize = Math.min(12, uniqueOperators);
  const deploymentCoreSize = Math.min(9, facts.characterLimit || 9, facts.deploymentPoints.length, targetSize);
  const beamWidth = Math.max(1, Math.floor(options.search?.squadBeamWidth ?? 32));
  const capabilityCache = new Map(available.map(pick => [
    `${pick.operatorId}:${pick.skill}`,
    capabilitiesForPick(pick, encounter),
  ]));
  let beam: SquadState[] = [{ picks: [], capabilities: emptyCapabilities(), score: 0, signature: "" }];
  let expandedStates = 0;

  for (let slot = 0; slot < targetSize; slot++) {
    const expanded: SquadState[] = [];
    for (const state of beam) {
      const used = new Set(state.picks.map(pick => pick.operatorId));
      for (const pick of available) {
        if (used.has(pick.operatorId)) continue;
        const addition = capabilityCache.get(`${pick.operatorId}:${pick.skill}`)!;
        const picks = [...state.picks, pick];
        expanded.push({
          picks,
          capabilities: addCapabilities(state.capabilities, addition),
          score: state.score + marginalScore(
            state.capabilities, addition, encounter.demand, pick, slot, deploymentCoreSize
          ),
          signature: squadSignature(picks),
        });
        expandedStates++;
      }
    }
    expanded.sort((left, right) => right.score - left.score || left.signature.localeCompare(right.signature));
    const deduplicated = new Map<string, SquadState>();
    const exploratoryTarget = beamWidth;
    for (const state of expanded) {
      const operatorSignature = operatorSetSignature(state.picks);
      if (deduplicated.has(operatorSignature)) continue;
      const sufficientlyDistinct = [...deduplicated.values()].every(selected => operatorOverlap(state.picks, selected.picks) <= 2 / 3);
      if (sufficientlyDistinct) deduplicated.set(operatorSignature, state);
      if (deduplicated.size >= exploratoryTarget) break;
    }
    for (const state of expanded) {
      const operatorSignature = operatorSetSignature(state.picks);
      if (!deduplicated.has(operatorSignature)) deduplicated.set(operatorSignature, state);
      if (deduplicated.size >= beamWidth) break;
    }
    beam = [...deduplicated.values()];
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

function directionSanity(
  point: DeploymentPoint,
  direction: typeof DIRECTIONS[number],
  facts: StageFacts
): number {
  if (facts.routeCells.length === 0) return 0;
  const nearestRoute = facts.routeCells
    .map(cell => ({ cell, distance: distance(point, cell) }))
    .sort((left, right) => left.distance - right.distance)[0]?.cell;
  if (!nearestRoute) return 0;
  const rowDelta = nearestRoute.row - point.row;
  const colDelta = nearestRoute.col - point.col;
  if (Math.abs(colDelta) >= Math.abs(rowDelta)) {
    if (colDelta > 0) return direction === "Right" ? 6 : 0;
    if (colDelta < 0) return direction === "Left" ? 6 : 0;
  }
  if (rowDelta > 0) return direction === "Down" ? 6 : 0;
  if (rowDelta < 0) return direction === "Up" ? 6 : 0;
  return 2;
}

function placementScore(
  pick: EnginePick,
  point: DeploymentPoint,
  direction: typeof DIRECTIONS[number],
  facts: StageFacts,
  priorStats: CopilotPriorStats[],
  deployIndex: number
): number {
  const nearestRoute = facts.routeCells.length ? Math.min(...facts.routeCells.map(cell => distance(point, cell))) : 0;
  const nearestGoal = facts.goalCells.length ? Math.min(...facts.goalCells.map(cell => distance(point, cell))) : 0;
  const melee = pick.profile.position === "MELEE";
  const publicPosition = positionPriorScore(priorStats, point.row, point.col, deployIndex) || 0;
  const publicDirection = directionPriorScore(priorStats, direction, point.row, point.col) || 0;
  return directionSanity(point, direction, facts)
    - nearestRoute * (melee ? 6 : 3)
    - nearestGoal * (melee ? 0.4 : 0.2)
    + publicPosition * 0.18
    + publicDirection * 0.08;
}

function rankedPlacements(pick: EnginePick, facts: StageFacts, stageCode: string, deployIndex: number): RankedPlacement[] {
  let byPick = placementCache.get(facts);
  if (!byPick) {
    byPick = new Map();
    placementCache.set(facts, byPick);
  }
  const key = `${stageCode}:${deployIndex}:${pick.operatorId}:${pick.skill}:${pick.profile.position}:${JSON.stringify(pick.profile.range)}`;
  const cached = byPick.get(key);
  if (cached) return cached;
  const priorStats = copilotPriorStats(stageCode, facts);
  const ranked = facts.deploymentPoints.flatMap(point => compatible(pick, point)
    ? DIRECTIONS.map(direction => ({ point, direction, score: placementScore(pick, point, direction, facts, priorStats, deployIndex) }))
    : [])
    .sort((left, right) => right.score - left.score
      || left.point.row - right.point.row || left.point.col - right.point.col
      || left.direction.localeCompare(right.direction));
  byPick.set(key, ranked);
  return ranked;
}

function variantChoice<T>(items: T[], variant: number, variantCount: number): T | undefined {
  if (items.length === 0) return undefined;
  const topSlots = Math.max(1, variantCount - 1);
  const index = variant < topSlots ? variant : items.length - 1 - (variant - topSlots);
  return items[Math.max(0, Math.min(items.length - 1, index))];
}

function uniquePointPlacements(placements: RankedPlacement[]): RankedPlacement[] {
  const seen = new Set<string>();
  return placements.filter(placement => {
    const key = `${placement.point.row},${placement.point.col}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orderedPicks(picks: EnginePick[], variant = 0): EnginePick[] {
  const ordered = [...picks];
  const swap = (left: number, right: number) => {
    if (ordered[left] && ordered[right]) [ordered[left], ordered[right]] = [ordered[right], ordered[left]];
  };
  if (variant === 1) swap(0, 1);
  if (variant === 2) swap(1, 2);
  if (variant === 3) swap(2, 3);
  if (variant >= 4) {
    const window = ordered.slice(0, Math.min(4, ordered.length));
    const highCostIndex = window
      .map((pick, index) => ({ index, cost: pick.profile.attributes.cost }))
      .sort((left, right) => right.cost - left.cost || left.index - right.index)[0]?.index;
    if (highCostIndex !== undefined && highCostIndex + 1 < ordered.length) swap(highCostIndex, highCostIndex + 1);
  }
  return ordered;
}

function timingDelays(stageCode: string, facts: StageFacts, limit: number): number[] {
  const base = [0, 250, 500, 750, 1000, 1500, 3000];
  const prior = timingVariantOrder(stageCode, facts, base.map(delay => delay / 250)).map(variant => variant * 250);
  const nearby = prior.flatMap(delay => [delay - 250, delay, delay + 250]);
  return [...new Set([...nearby, ...base])]
    .filter(delay => delay >= 0)
    .sort((left, right) => {
      const leftBase = base.includes(left) ? 0 : 1;
      const rightBase = base.includes(right) ? 0 : 1;
      return leftBase - rightBase || left - right;
    })
    .slice(0, Math.max(1, limit));
}

function skillTimingDelays(stats: CopilotPriorStats[]): number[] {
  const counts = new Map<number, number>();
  for (const stat of stats) {
    for (const [bucket, count] of Object.entries(stat.skillTiming || {})) {
      const delay = Math.round(Math.max(0, Number(bucket) || 0) / 250) * 250;
      counts.set(delay, (counts.get(delay) || 0) + count);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .map(([delay]) => delay);
}

function addPerturbation(target: CandidatePerturbation[], seen: Set<string>, value: CandidatePerturbation): void {
  const key = JSON.stringify(value);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(value);
}

export function buildCandidatePerturbations(stageCode: string, facts: StageFacts, config: SearchConfig): CandidatePerturbation[] {
  const perturbations: CandidatePerturbation[] = [];
  const seen = new Set<string>();
  const timing = timingDelays(stageCode, facts, config.timingVariantCount);
  const base: CandidatePerturbation = {
    positionVariant: 0,
    directionVariant: 0,
    timingDelayMs: timing[0] || 0,
    orderVariant: 0,
    skillVariant: 0,
  };
  addPerturbation(perturbations, seen, base);

  for (let positionVariant = 1; positionVariant < config.positionVariantCount; positionVariant++) {
    addPerturbation(perturbations, seen, { ...base, positionVariant });
  }
  for (let directionVariant = 1; directionVariant < config.directionVariantCount; directionVariant++) {
    addPerturbation(perturbations, seen, { ...base, directionVariant });
  }
  for (const timingDelayMs of timing.slice(1)) {
    addPerturbation(perturbations, seen, { ...base, timingDelayMs });
  }
  for (let skillVariant = 1; skillVariant < config.skillVariantCount; skillVariant++) {
    addPerturbation(perturbations, seen, { ...base, skillVariant });
  }
  for (let orderVariant = 1; orderVariant < config.orderVariantCount; orderVariant++) {
    addPerturbation(perturbations, seen, { ...base, orderVariant });
  }

  for (let positionVariant = 1; positionVariant < Math.min(3, config.positionVariantCount); positionVariant++) {
    for (let directionVariant = 1; directionVariant < Math.min(3, config.directionVariantCount); directionVariant++) {
      addPerturbation(perturbations, seen, { ...base, positionVariant, directionVariant });
    }
    for (const timingDelayMs of timing.slice(1, 4)) {
      addPerturbation(perturbations, seen, { ...base, positionVariant, timingDelayMs });
    }
  }

  return perturbations.slice(0, Math.max(1, config.candidatePoolLimit));
}

function toOper(pick: EnginePick): BattleScriptOper {
  return { name: pick.name, skill: pick.skill, skill_usage: 1 };
}

export function buildCandidate(input: CandidateBuildInput): { script: BattleScript; picks: EnginePick[]; warnings: string[] } {
  const usedPositions = new Set<string>();
  const actions: BattleScript["actions"] = [{ type: "SpeedUp" }];
  const deployLimit = Math.min(9, input.facts.characterLimit || 9, input.facts.deploymentPoints.length);
  const positionVariant = Math.max(0, Math.floor(input.positionVariant));
  const directionVariant = Math.max(0, Math.floor(input.directionVariant ?? 0));
  const timingDelayMs = Math.max(0, Math.floor(input.timingDelayMs ?? input.timingVariant * 250));
  const orderVariant = Math.max(0, Math.floor(input.orderVariant ?? 0));
  const skillVariant = Math.max(0, Math.floor(input.skillVariant ?? 0));
  const positionVariantCount = Math.max(1, Math.floor(input.options.search?.positionVariantCount ?? 4));
  const directionVariantCount = Math.max(1, Math.floor(input.options.search?.directionVariantCount ?? 4));
  const deployPicks = orderedPicks(input.picks, orderVariant);
  const deployedNames: string[] = [];

  for (const pick of deployPicks) {
    if (actions.filter(action => action.type === "Deploy").length >= deployLimit) break;
    const deployIndex = actions.filter(action => action.type === "Deploy").length;
    const placements = rankedPlacements(pick, input.facts, input.stageCode, deployIndex)
      .filter(({ point }) => !usedPositions.has(`${point.row},${point.col}`));
    if (placements.length === 0) continue;
    const pointPlacement = variantChoice(uniquePointPlacements(placements), positionVariant, positionVariantCount);
    if (!pointPlacement) continue;
    const placement = variantChoice(
      placements.filter(({ point }) => point.row === pointPlacement.point.row && point.col === pointPlacement.point.col),
      directionVariant,
      directionVariantCount
    ) || pointPlacement;
    usedPositions.add(`${placement.point.row},${placement.point.col}`);
    deployedNames.push(pick.name);
    actions.push({
      type: "Deploy",
      name: pick.name,
      location: [placement.point.row, placement.point.col],
      direction: placement.direction,
      costs: Math.round(pick.profile.attributes.cost),
      ...(timingDelayMs > 0 ? { pre_delay: timingDelayMs } : {}),
    });
  }
  const firstDeployName = deployedNames[0];
  if (skillVariant === 0) {
    actions.push({ type: "SkillDaemon" });
  } else if (firstDeployName && skillVariant >= 2) {
    const publicSkillDelays = skillTimingDelays(copilotPriorStats(input.stageCode, input.facts));
    const delay = skillVariant === 2 ? 15000 : publicSkillDelays[0] ?? 30000;
    actions.push({ type: "Skill", name: firstDeployName, pre_delay: delay, skip_if_not_ready: true });
    if (skillVariant >= 4) actions.push({ type: "SkillDaemon" });
  }

  const warnings = input.picks.length < 12 ? [`Only ${input.picks.length} modeled elite 2 operators are available for the fixed squad.`] : [];
  const script: BattleScript = {
    stage_name: input.stageCode,
    minimum_required: "v6.0.0",
    doc: { title: `${input.stageCode} MAAfight v2`, details: input.facts.summary },
    opers: input.picks.map(toOper),
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
  return { script, picks: input.picks, warnings };
}
