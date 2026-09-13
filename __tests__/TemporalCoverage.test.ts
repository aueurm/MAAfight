import { canTargetAir, temporalCoverageScore } from "../src/engine/TemporalCoverage";
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
    const silverAsh = {
      ...pick("MELEE"),
      operatorId: "char_172_svrash",
      name: "银灰",
      profile: { ...pick("MELEE").profile, operatorId: "char_172_svrash", name: "银灰", subProfession: "lord" },
    };
    expect(temporalCoverageScore(silverAsh, { row: 0, col: 0 }, "Right", airPressure)).toBeGreaterThan(0);
    expect(temporalCoverageScore(pick("RANGED"), { row: 0, col: 0 }, "Right", airPressure)).toBeGreaterThan(0);
  });

  it("does not infer anti-air from a stealth-reveal tag", () => {
    const revealer = { ...pick("MELEE"), operatorId: "char_172_svrash", name: "银灰" };
    expect(canTargetAir(revealer)).toBe(false);
  });

  it("does not treat the flinger ground-only trait as anti-air", () => {
    const flinger = { ...pick("RANGED"), profile: { ...pick("RANGED").profile, subProfession: "flinger" } };
    expect(canTargetAir(flinger)).toBe(false);
  });

  it("retains melee ground coverage when air enemies share the same cell", () => {
    const mixed: TemporalPressure = { ...pressure, buckets: [{ time: 0, cells: [cell(0, 1, 5000, 5000)] }] };
    const melee = temporalCoverageScore(pick("MELEE"), { row: 0, col: 0 }, "Right", mixed);
    expect(melee).toBeGreaterThan(0);
    expect(melee).toBeLessThan(temporalCoverageScore(pick("RANGED"), { row: 0, col: 0 }, "Right", mixed));
  });

  it("preserves duration and overlap weights when ground, mixed and air-only pressure share a coordinate", () => {
    const mixed: TemporalPressure = { ...pressure, buckets: [
      { time: 0, cells: [cell(0, 1, 5000)] },
      { time: 1, cells: [cell(0, 1, 5000, 5000)] },
      { time: 2, cells: [cell(0, 1, 0, 5000)] },
    ] };
    const melee = { pick: pick("MELEE"), location: { row: 0, col: 0 }, direction: "Right" };
    const ranged = { pick: pick("RANGED"), location: { row: 0, col: 0 }, direction: "Right" };
    ranged.pick.profile.range.push([0, 1]);
    expect(temporalCoverageScore(ranged.pick, ranged.location, ranged.direction, mixed)).toBeCloseTo(21.5);
    expect(temporalCoverageScore(melee.pick, melee.location, melee.direction, mixed)).toBeCloseTo(10.75);
    expect(temporalCoverageScore(ranged.pick, ranged.location, ranged.direction, mixed, [melee])).toBeCloseTo(13.5);
    expect(temporalCoverageScore(ranged.pick, ranged.location, ranged.direction, mixed, [ranged])).toBeCloseTo(10.75);
    expect(temporalCoverageScore(ranged.pick, ranged.location, ranged.direction, { ...mixed, bucketSeconds: 0.5 })).toBeCloseTo(10.75);
  });
});
