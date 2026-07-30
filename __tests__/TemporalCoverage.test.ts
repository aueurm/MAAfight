import { temporalCoverageScore } from "../src/engine/TemporalCoverage";
import type { EnginePick, TemporalCellPressure, TemporalPressure } from "../src/engine/types";

function cell(row: number, col: number, groundHp: number, airHp = 0): TemporalCellPressure {
  return {
    row, col, groundHp, airHp, groundCount: groundHp ? 1 : 0, airCount: airHp ? 1 : 0,
    incomingAttack: 100, blockDemand: groundHp ? 1 : 0, eliteWeight: 0, bossWeight: 0, goalThreat: 0, mergeWeight: 0,
    routeIds: [0], enemyIds: ["enemy"], mechanisms: [], coverageGaps: [],
  };
}

function pick(position: "MELEE" | "RANGED"): EnginePick {
  return { profile: { position, range: [[0, 1]] } } as EnginePick;
}

const pressure: TemporalPressure = {
  bucketSeconds: 1,
  buckets: [
    { time: 0, cells: [cell(0, 1, 5000)] },
    { time: 1, cells: [cell(0, 1, 5000)] },
  ],
  criticalWindows: [], coverageGaps: [],
};

describe("temporal coverage", () => {
  it("rewards coverage duration and discounts already covered pressure", () => {
    const candidate = { pick: pick("RANGED"), location: { row: 0, col: 0 }, direction: "Right" };
    const standalone = temporalCoverageScore(candidate.pick, candidate.location, candidate.direction, pressure);
    const marginal = temporalCoverageScore(candidate.pick, candidate.location, candidate.direction, pressure, [candidate]);

    expect(standalone).toBeGreaterThan(0);
    expect(marginal).toBeLessThan(standalone);
  });

  it("does not let melee placements satisfy air coverage", () => {
    const airPressure: TemporalPressure = { ...pressure, buckets: [{ time: 0, cells: [cell(0, 1, 0, 5000)] }] };
    expect(temporalCoverageScore(pick("MELEE"), { row: 0, col: 0 }, "Right", airPressure)).toBe(0);
    expect(temporalCoverageScore(pick("RANGED"), { row: 0, col: 0 }, "Right", airPressure)).toBeGreaterThan(0);
  });
});
