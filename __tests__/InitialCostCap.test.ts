import { PRTSMapAdapter } from "../src/adapter/PRTSMapAdapter";
import { computeStageContentHash } from "../src/engine/EncounterContext";
import { PRTSMapLoader } from "../src/loader/PRTSMapLoader";
import type { PRTSLevelData, PRTSRune } from "../src/types";

function rune(cap = 20, ceiling = 99): PRTSRune {
  return { key: "cbuff_max_cost", difficultyMask: "ALL", professionMask: 1023, buildableMask: "ALL",
    blackboard: [{ key: "max_cost", value: cap }, { key: "max_cost_ceil", value: ceiling }] };
}

function data(runes: PRTSRune[]): PRTSLevelData {
  return {
    options: { characterLimit: 8, maxLifePoint: 3, initialCost: 10, maxCost: 99, costIncreaseTime: 1,
      isTrainingLevel: false, isHardTrainingLevel: false },
    mapData: { map: [[0]], tiles: [{ tileKey: "tile_road", heightType: "LOWLAND", buildableType: "MELEE",
      passableMask: "ALL", playerSideMask: "ALL", effects: null }] },
    routes: [], waves: [], enemyDbRefs: [], runes, predefines: { characterInsts: [] }, tilesDisallowToLocate: [], randomSeed: 0,
  };
}

const adapter = new PRTSMapAdapter(new PRTSMapLoader());

describe("verified initial DP cap normalization", () => {
  it("normalizes the global starting cap without replacing the eventual maximum or raw rune", () => {
    const raw = data([rune()]);
    const map = adapter.adapt(raw, "cap-test");
    expect(map.options).toMatchObject({ initialCost: 10, initialCostCap: 20, maxCost: 99 });
    expect(raw.runes).toEqual([rune()]);
    expect(adapter.adapt(data([rune(), rune()]), "same-cap").options.initialCostCap).toBe(20);
  });

  it.each([
    { difficultyMask: "FOUR_STAR" }, { professionMask: 1 }, { buildableMask: "MELEE" },
    { position: { row: 0, col: 0 } }, { blackboard: [{ key: "max_cost", value: 20 }] },
  ])("does not infer the global cap from a partial or scoped rune %j", change => {
    expect(adapter.adapt(data([{ ...rune(), ...change }]), "scoped-cap").options.initialCostCap).toBeUndefined();
  });

  it("does not select a value when rune caps, ceilings or blackboard entries conflict", () => {
    for (const runes of [[rune(20), rune(30)], [rune(20, 99), rune(20, 90)],
      [rune(), { ...rune(), difficultyMask: "FOUR_STAR" }],
      [{ ...rune(), blackboard: [{ key: "max_cost", value: 20 }, { key: "max_cost", value: 20 }, { key: "max_cost_ceil", value: 99 }] }]]) {
      expect(adapter.adapt(data(runes), "conflicting-cap").options.initialCostCap).toBeUndefined();
    }
  });

  it.each([[-1, 99], [20.5, 99], [NaN, 99], [Infinity, 99], [20, 19], [20, 100]])(
    "does not infer invalid cap/ceiling %s/%s", (cap, ceiling) => {
      expect(adapter.adapt(data([rune(cap, ceiling)]), "invalid-cap").options.initialCostCap).toBeUndefined();
    }
  );

  it("includes the normalized cap in the existing stage content hash", () => {
    const base = adapter.adapt(data([]), "same-stage");
    const capped = adapter.adapt(data([rune()]), "same-stage");
    expect(computeStageContentHash(base)).not.toBe(computeStageContentHash(capped));
    expect(base.options.initialCostCap).toBeUndefined();
  });
});
