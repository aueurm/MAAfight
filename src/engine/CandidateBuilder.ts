import {
  getCombatOperator,
  listCombatOperators,
  resolveOperatorProfile,
  type CombatOperatorRecord,
} from "./CombatModel";
import { rotateDirection, squadSignature } from "./helpers";
import type { BattleScript, BattleScriptOper, DeploymentPoint, PlayerOperator } from "../types";
import type {
  CandidateBuildInput,
  CapabilityDemand,
  EncounterContext,
  EngineOptions,
  EnginePick,
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

function maximumRouteCoverage(pick: EnginePick, facts: StageFacts): number {
  if (facts.routeCells.length === 0) return 0;
  const routeKeys = new Set(facts.routeCells.map(cell => `${cell.row},${cell.col}`));
  let maximum = 0;
  for (const point of facts.deploymentPoints) {
    if (!compatible(pick, point)) continue;
    for (const direction of DIRECTIONS) {
      const covered = new Set<string>();
      for (const offset of pick.profile.range) {
        const [row, col] = rotateDirection(offset, direction);
        const key = `${point.row + row},${point.col + col}`;
        if (routeKeys.has(key)) covered.add(key);
      }
      maximum = Math.max(maximum, covered.size / facts.routeCells.length);
    }
  }
  return maximum;
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
    capabilitiesForPick(pick, encounter, facts),
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

function placementScore(
  pick: EnginePick,
  point: DeploymentPoint,
  direction: typeof DIRECTIONS[number],
  facts: StageFacts
): number {
  const routeKeys = new Set(facts.routeCells.map(cell => `${cell.row},${cell.col}`));
  const covered = pick.profile.range.reduce((count, offset) => {
    const [row, col] = rotateDirection(offset, direction);
    return count + Number(routeKeys.has(`${point.row + row},${point.col + col}`));
  }, 0);
  const nearestRoute = facts.routeCells.length ? Math.min(...facts.routeCells.map(cell => distance(point, cell))) : 0;
  const nearestGoal = facts.goalCells.length ? Math.min(...facts.goalCells.map(cell => distance(point, cell))) : 0;
  const melee = pick.profile.position === "MELEE";
  return covered * 30 - nearestRoute * (melee ? 22 : 8) - nearestGoal * (melee ? 1 : 0.5);
}

function rankedPlacements(pick: EnginePick, facts: StageFacts): RankedPlacement[] {
  let byPick = placementCache.get(facts);
  if (!byPick) {
    byPick = new Map();
    placementCache.set(facts, byPick);
  }
  const key = `${pick.operatorId}:${pick.skill}:${pick.profile.position}:${JSON.stringify(pick.profile.range)}`;
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

function toOper(pick: EnginePick, requirementsMode: "none" | "player"): BattleScriptOper {
  const operator: BattleScriptOper = { name: pick.name, skill: pick.skill, skill_usage: 1 };
  if (requirementsMode === "player" && pick.player) {
    operator.requirements = {
      elite: pick.player.elite,
      level: pick.player.level,
      ...(pick.player.skillLevel !== undefined ? { skill_level: pick.player.skillLevel } : {}),
      ...(pick.player.module !== undefined ? { module: pick.player.module } : {}),
      ...(pick.player.moduleLevel !== undefined ? { module_level: pick.player.moduleLevel } : {}),
      potential: pick.player.potential,
    };
  }
  return operator;
}

export function buildCandidate(input: CandidateBuildInput): { script: BattleScript; picks: EnginePick[]; warnings: string[] } {
  const usedPositions = new Set<string>();
  const actions: BattleScript["actions"] = [{ type: "SpeedUp" }];
  const deployLimit = Math.min(9, input.facts.characterLimit || 9, input.facts.deploymentPoints.length);

  for (const pick of input.picks) {
    if (actions.filter(action => action.type === "Deploy").length >= deployLimit) break;
    const placements = rankedPlacements(pick, input.facts)
      .filter(({ point }) => !usedPositions.has(`${point.row},${point.col}`));
    if (placements.length === 0) continue;
    const placement = placements[Math.min(input.positionVariant, placements.length - 1)];
    usedPositions.add(`${placement.point.row},${placement.point.col}`);
    actions.push({
      type: "Deploy",
      name: pick.name,
      location: [placement.point.row, placement.point.col],
      direction: placement.direction,
      costs: Math.round(pick.profile.attributes.cost),
      ...(input.timingVariant > 0 ? { pre_delay: input.timingVariant * 250 } : {}),
    });
  }
  actions.push({ type: "SkillDaemon" });

  const warnings = input.picks.length < 12 ? [`Only ${input.picks.length} modeled elite 2 operators are available for the fixed squad.`] : [];
  const requirementsMode = input.options.requirementsMode || "none";
  const script: BattleScript = {
    stage_name: input.stageCode,
    minimum_required: "v6.0.0",
    doc: { title: `${input.stageCode} MAAfight v2`, details: input.facts.summary },
    opers: input.picks.map(pick => toOper(pick, requirementsMode)),
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
