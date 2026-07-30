import { coversTemporalCell } from "./TemporalCoverage";
import { buildTimelineEvents, type TimelineEvent } from "./TimelinePlanner";
import type { DeploymentPoint, MapData } from "../types";
import type { Direction, EncounterContext, EnginePick, JointDecision, JointPlan, StageFacts } from "./types";

const DIRECTIONS: Direction[] = ["Right", "Down", "Left", "Up"];

export interface JointPlannerOptions {
  picks: EnginePick[];
  beamWidth?: number;
  placementsPerPick?: number;
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

function weight(cell: StageFacts["temporalPressure"]["buckets"][number]["cells"][number]): number {
  return (cell.groundHp + cell.airHp) / 1_000 + cell.incomingAttack / 200
    + cell.goalThreat / 1_000 + cell.eliteWeight * 5 + cell.bossWeight * 10 + cell.mergeWeight * 2;
}

function candidatesFor(pick: EnginePick, facts: StageFacts, limit: number): PlacementCandidate[] {
  const candidates = facts.deploymentPoints.flatMap(point => compatible(pick, point)
    ? DIRECTIONS.map(direction => {
      const coverage = new Map<string, number>();
      let firstCoverageTime = Number.POSITIVE_INFINITY;
      for (const bucket of facts.temporalPressure.buckets) {
        for (const cell of bucket.cells) {
          if (!coversTemporalCell(pick, point, direction, cell)) continue;
          coverage.set(`${bucket.time}:${key(cell.row, cell.col)}`, weight(cell));
          firstCoverageTime = Math.min(firstCoverageTime, bucket.time);
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

function targetTime(candidate: PlacementCandidate, events: TimelineEvent[]): number {
  const firstThreat = events.find(event => event.time >= candidate.firstCoverageTime
    && (event.type === "fire_zone" || event.type === "flying_wave" || event.type === "boss_arrival"));
  return Number.isFinite(candidate.firstCoverageTime)
    ? Math.max(0, (firstThreat?.time ?? candidate.firstCoverageTime) - 1)
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
  const events = buildTimelineEvents(mapData, facts);
  const candidateLimit = Math.min(options.picks.length, mapData.options.characterLimit, facts.deploymentPoints.length);
  let states: JointState[] = [{ decisions: [], occupied: new Set(), coverage: new Map(), score: 0, signature: "" }];

  for (const pick of options.picks.slice(0, candidateLimit)) {
    const candidates = candidatesFor(pick, facts, placementsPerPick);
    if (!candidates.length) continue;
    const next: JointState[] = [];
    for (const state of states) {
      for (const candidate of candidates) {
        const locationKey = key(candidate.point.row, candidate.point.col);
        if (state.occupied.has(locationKey)) continue;
        const score = marginalScore(candidate, state.coverage);
        const decision: JointDecision = {
          pick, location: [candidate.point.row, candidate.point.col], direction: candidate.direction,
          score, targetTime: targetTime(candidate, events),
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
