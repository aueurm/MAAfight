import { rotateDirection } from "./helpers";
import type { EnginePick, TemporalCellPressure, TemporalPressure } from "./types";

export interface TemporalDeployment {
  pick: EnginePick;
  location: { row: number; col: number };
  direction: string;
}

interface CellWeights {
  ground: number;
  mixed: number;
  airOnly: number;
}

const coverageWeights = new WeakMap<TemporalPressure, Map<string, CellWeights>>();

export function temporalRangeCells(
  pick: EnginePick,
  location: { row: number; col: number },
  direction: string
): Set<string> {
  return new Set(pick.profile.range.map(offset => {
    const [row, col] = rotateDirection(offset, direction);
    return `${location.row + row},${location.col + col}`;
  }));
}

export function canTargetAir(pick: EnginePick): boolean {
  if (pick.profile.damageType === "heal" || pick.profile.subProfession === "bard" || pick.profile.subProfession === "flinger") return false;
  // 领主的远程攻击和反隐是独立能力，不能从 stealth-reveal 推导对空。
  return pick.profile.position === "RANGED" || pick.profile.subProfession === "lord";
}

export function coversTemporalCell(
  pick: EnginePick,
  location: { row: number; col: number },
  direction: string,
  cell: TemporalCellPressure
): boolean {
  if (cell.groundHp <= 0 && cell.airHp > 0 && !canTargetAir(pick)) return false;
  return pick.profile.range.some(offset => {
    const [row, col] = rotateDirection(offset, direction);
    return location.row + row === cell.row && location.col + col === cell.col;
  });
}

function threatWeight(cell: TemporalCellPressure, targetsAir: boolean): number {
  const targetableHp = cell.groundHp + (targetsAir ? cell.airHp : 0);
  const share = targetableHp / Math.max(1, cell.groundHp + cell.airHp);
  return targetableHp / 1_000 + share * (cell.incomingAttack / 200
    + cell.goalThreat / 1_000 + cell.eliteWeight * 5 + cell.bossWeight * 10 + cell.mergeWeight * 2);
}

export function temporalThreatWeight(pick: EnginePick, cell: TemporalCellPressure): number {
  return threatWeight(cell, canTargetAir(pick));
}

function aggregatedWeights(pressure: TemporalPressure): Map<string, CellWeights> {
  const cached = coverageWeights.get(pressure);
  if (cached) return cached;
  const weights = new Map<string, CellWeights>();
  for (const bucket of pressure.buckets) {
    for (const cell of bucket.cells) {
      const key = `${cell.row},${cell.col}`;
      const value = weights.get(key) || { ground: 0, mixed: 0, airOnly: 0 };
      if (cell.groundHp <= 0 && cell.airHp > 0) {
        value.airOnly += threatWeight(cell, true) * pressure.bucketSeconds;
      } else {
        value.ground += threatWeight(cell, false) * pressure.bucketSeconds;
        value.mixed += threatWeight(cell, true) * pressure.bucketSeconds;
      }
      weights.set(key, value);
    }
  }
  coverageWeights.set(pressure, weights);
  return weights;
}

export function temporalCoverageScore(
  pick: EnginePick,
  location: { row: number; col: number },
  direction: string,
  pressure: TemporalPressure,
  existing: TemporalDeployment[] = []
): number {
  const weights = aggregatedWeights(pressure);
  const targetsAir = canTargetAir(pick);
  const overlaps = existing.map(deployment => ({
    cells: temporalRangeCells(deployment.pick, deployment.location, deployment.direction),
    targetsAir: canTargetAir(deployment.pick),
  }));
  let score = 0;
  // With fixed placements, overlap only differs between air-only and ground/mixed cells.
  // Aggregate time first, preserving both classes so melee never discounts an air-only cell.
  for (const cell of temporalRangeCells(pick, location, direction)) {
    const value = weights.get(cell);
    if (!value) continue;
    let groundOverlap = 0;
    let airOverlap = 0;
    for (const overlap of overlaps) {
      if (!overlap.cells.has(cell)) continue;
      groundOverlap++;
      if (overlap.targetsAir) airOverlap++;
    }
    score += (targetsAir ? value.mixed : value.ground) / (1 + groundOverlap);
    if (targetsAir) score += value.airOnly / (1 + airOverlap);
  }
  return score;
}
