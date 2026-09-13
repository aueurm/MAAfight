import { canTargetAir, temporalRangeCells, temporalThreatWeight } from "./TemporalCoverage";
import type { DeploymentPoint, MapData } from "../types";
import type { Direction, EncounterContext, EnginePick, JointDecision, JointPlan, SearchBias, StageFacts } from "./types";

const DIRECTIONS: Direction[] = ["Right", "Down", "Left", "Up"];

export interface JointPlannerOptions {
  picks: EnginePick[];
  beamWidth?: number;
  placementsPerPick?: number;
  searchBias?: SearchBias;
  checkDeadline?: () => void;
}

interface PlacementCandidate {
  point: DeploymentPoint;
  direction: Direction;
  coverage: Map<string, number>;
  score: number;
  firstCoverageTime: number;
}

interface JointState {
  decisions: JointDecision[];
  occupied: Set<string>;
  coverage: Map<string, number>;
  score: number;
  signature: string;
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function compatible(pick: EnginePick, point: DeploymentPoint): boolean {
  return point.buildableType === "all"
    || point.buildableType === "melee" && pick.profile.position === "MELEE"
    || point.buildableType === "ranged" && pick.profile.position === "RANGED";
}

function weight(pick: EnginePick, cell: StageFacts["temporalPressure"]["buckets"][number]["cells"][number], bias?: SearchBias): number {
  const routeWeight = Math.max(0, ...cell.routeIds.map(routeId => bias?.routeWeights[routeId] || 0));
  return temporalThreatWeight(pick, cell) * (1 + routeWeight);
}

function candidatesFor(pick: EnginePick, facts: StageFacts, limit: number, bias?: SearchBias, checkDeadline?: () => void): PlacementCandidate[] {
  const targetsAir = canTargetAir(pick);
  const byCell = new Map<string, Array<{ key: string; time: number; weight: number }>>();
  for (const bucket of facts.temporalPressure.buckets) {
    checkDeadline?.();
    for (const cell of bucket.cells) {
      if (cell.groundHp <= 0 && cell.airHp > 0 && !targetsAir) continue;
      const cellKey = key(cell.row, cell.col);
      const entries = byCell.get(cellKey) || [];
      entries.push({ key: `${bucket.time}:${cellKey}`, time: bucket.time, weight: weight(pick, cell, bias) });
      byCell.set(cellKey, entries);
    }
  }
  const candidates = facts.deploymentPoints.flatMap(point => compatible(pick, point)
    ? DIRECTIONS.map(direction => {
      checkDeadline?.();
      const coverage = new Map<string, number>();
      let firstCoverageTime = Number.POSITIVE_INFINITY;
      for (const cell of temporalRangeCells(pick, point, direction)) {
        for (const entry of byCell.get(cell) || []) {
          coverage.set(entry.key, entry.weight);
          firstCoverageTime = Math.min(firstCoverageTime, entry.time);
        }
      }
      const score = [...coverage.values()].reduce((sum, value) => sum + value, 0);
      return { point, direction, coverage, score, firstCoverageTime };
    })
    : [])
    .sort((left, right) => right.score - left.score || left.point.row - right.point.row || left.point.col - right.point.col
      || left.direction.localeCompare(right.direction));
  return candidates.slice(0, limit);
}

function targetTime(candidate: PlacementCandidate): number {
  return Number.isFinite(candidate.firstCoverageTime)
    ? Math.max(0, candidate.firstCoverageTime - 1)
    : 0;
}

function marginalScore(candidate: PlacementCandidate, coverage: Map<string, number>): number {
  let score = 0;
  for (const [cell, value] of candidate.coverage) score += value / (1 + (coverage.get(cell) || 0));
  return score;
}

function signature(decisions: JointDecision[]): string {
  return decisions.map(decision => `${decision.pick.operatorId}@${decision.location.join(",")}:${decision.direction}`).join("|");
}

export function buildJointPlan(
  mapData: MapData,
  facts: StageFacts,
  _encounter: EncounterContext,
  options: JointPlannerOptions
): JointPlan {
  const beamWidth = Math.max(1, options.beamWidth || 8);
  const placementsPerPick = Math.max(1, options.placementsPerPick || 6);
  const candidateLimit = Math.min(options.picks.length, mapData.options.characterLimit, facts.deploymentPoints.length);
  let states: JointState[] = [{ decisions: [], occupied: new Set(), coverage: new Map(), score: 0, signature: "" }];

  for (const pick of options.picks.slice(0, candidateLimit)) {
    options.checkDeadline?.();
    const candidates = candidatesFor(pick, facts, placementsPerPick, options.searchBias, options.checkDeadline);
    if (!candidates.length) continue;
    const next: JointState[] = [];
    for (const state of states) {
      options.checkDeadline?.();
      for (const candidate of candidates) {
        const locationKey = key(candidate.point.row, candidate.point.col);
        if (state.occupied.has(locationKey)) continue;
        const score = marginalScore(candidate, state.coverage);
        const decision: JointDecision = {
          pick, location: [candidate.point.row, candidate.point.col], direction: candidate.direction,
          score, targetTime: targetTime(candidate),
        };
        const coverage = new Map(state.coverage);
        for (const cell of candidate.coverage.keys()) coverage.set(cell, (coverage.get(cell) || 0) + 1);
        const decisions = [...state.decisions, decision];
        next.push({
          decisions,
          occupied: new Set([...state.occupied, locationKey]),
          coverage,
          score: state.score + score,
          signature: signature(decisions),
        });
      }
    }
    states = next.sort((left, right) => right.score - left.score || left.signature.localeCompare(right.signature)).slice(0, beamWidth);
    if (!states.length) break;
  }
  const best = states[0] || { decisions: [], score: 0, signature: "" };
  return { decisions: best.decisions, score: best.score, signature: best.signature };
}
