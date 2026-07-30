import { rotateDirection } from "./helpers";
import type { EnginePick, TemporalCellPressure, TemporalPressure } from "./types";

export interface TemporalDeployment {
  pick: EnginePick;
  location: { row: number; col: number };
  direction: string;
}

export function coversTemporalCell(
  pick: EnginePick,
  location: { row: number; col: number },
  direction: string,
  cell: TemporalCellPressure
): boolean {
  if (cell.airHp > 0 && pick.profile.position !== "RANGED") return false;
  return pick.profile.range.some(offset => {
    const [row, col] = rotateDirection(offset, direction);
    return location.row + row === cell.row && location.col + col === cell.col;
  });
}

function threatWeight(cell: TemporalCellPressure): number {
  return (cell.groundHp + cell.airHp) / 1_000 + cell.incomingAttack / 200
    + cell.goalThreat / 1_000 + cell.eliteWeight * 5 + cell.bossWeight * 10 + cell.mergeWeight * 2;
}

export function temporalCoverageScore(
  pick: EnginePick,
  location: { row: number; col: number },
  direction: string,
  pressure: TemporalPressure,
  existing: TemporalDeployment[] = []
): number {
  let score = 0;
  for (const bucket of pressure.buckets) {
    for (const cell of bucket.cells) {
      if (!coversTemporalCell(pick, location, direction, cell)) continue;
      const overlap = existing.reduce((count, deployment) => count
        + Number(coversTemporalCell(deployment.pick, deployment.location, deployment.direction, cell)), 0);
      score += threatWeight(cell) * pressure.bucketSeconds / (1 + overlap);
    }
  }
  return score;
}
