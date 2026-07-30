import { evaluateFeasibility } from "../src/engine/Feasibility";
import { buildEncounterContext } from "../src/engine/EncounterContext";
import { extractStageFacts } from "../src/engine/StageFacts";
import type { EnginePick } from "../src/engine/types";
import type { BattleScript, MapData } from "../src/types";

function mapData(motionMode: "walk" | "fly"): MapData {
  return {
    stageId: "FEAS-1", name: "FEAS-1", tiles: [], deploymentPoints: [{ row: 0, col: 0, buildableType: "all" }],
    strategicPoints: [], highThreatAreas: [], waves: [], runes: [],
    routes: [{ id: 0, motionMode, startPosition: { row: 0, col: 0 }, endPosition: { row: 0, col: 2 }, checkpoints: [{ row: 0, col: 1 }] }],
    enemyDetails: [{ id: "enemy", name: "Enemy", maxHp: 5000, atk: 100, def: 0, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false }],
    spawnTimeline: [{ time: 0, enemyId: "enemy", count: 1, routeIndex: 0 }],
    options: { characterLimit: 1, maxLifePoint: 3, initialCost: 10, maxCost: 99, costIncreaseTime: 1 },
  };
}

function pick(position: "MELEE" | "RANGED", cost = 10): EnginePick {
  return {
    operatorId: position, name: position, role: position === "MELEE" ? "guard" : "sniper", skill: 1, skillRank: 10,
    profile: {
      operatorId: position, name: position, role: position === "MELEE" ? "guard" : "sniper", subProfession: null, position,
      damageType: "physical", skill: 1, skillRank: 10, skillDuration: 0, respawnTime: 0, baseRangeId: null, skillRangeId: null,
      range: [[0, 0], [0, 1], [0, 2]], attributes: { hp: 2000, atk: 1000, def: 200, res: 0, cost, block: position === "MELEE" ? 1 : 0, attackInterval: 1, attackSpeed: 100 },
      metrics: { normalDps: 1000, burstDps: 1000, cycleDps: 1000, healingHps: 0, physicalEhp: 3000, artsEhp: 2000, controlSeconds: 0 },
      maxTargets: 1, confidence: "exact", modelCoverageGaps: [],
    },
  };
}

function script(pick: EnginePick): BattleScript {
  return {
    stage_name: "FEAS-1", minimum_required: "v6.0.0", groups: [], opers: [{ name: pick.name, skill: 1 }],
    actions: [{ type: "Deploy", name: pick.name, location: [0, 0], direction: "Right", costs: pick.profile.attributes.cost }],
    doc: { title: "test", details: "" }, generatedAt: "2026-01-01T00:00:00.000Z", metadata: { source: "test" }, version: 3,
  };
}

describe("candidate feasibility", () => {
  it("rejects flying pressure without ranged anti-air coverage", () => {
    const data = mapData("fly");
    const facts = extractStageFacts(data);
    expect(evaluateFeasibility(script(pick("MELEE")), [pick("MELEE")], facts, buildEncounterContext(data, facts), data).reasons)
      .toContain("critical_window_missing_anti_air");
  });

  it("rejects deployments that can never be afforded", () => {
    const data = mapData("walk");
    const facts = extractStageFacts(data);
    expect(evaluateFeasibility(script(pick("RANGED", 100)), [pick("RANGED", 100)], facts, buildEncounterContext(data, facts), data).reasons)
      .toContain("cost_timeline_unaffordable");
  });

  it("evaluates a cost-ready deployment in the pressure buckets it can actually reach", () => {
    const data = mapData("walk");
    data.enemyDetails[0].atk = 400;
    data.routes[0].endPosition = { row: 0, col: 4 };
    data.routes[0].checkpoints = [
      { row: 0, col: 2, type: "MOVE" },
      { row: 0, col: 4, type: "MOVE" },
      { row: 0, col: 4, type: "WAIT_FOR_SECONDS", waitSeconds: 10 },
    ];
    const candidate = pick("MELEE", 13);
    candidate.profile.range = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]];
    const facts = extractStageFacts(data);
    expect(evaluateFeasibility(script(candidate), [candidate], facts, buildEncounterContext(data, facts), data).feasible).toBe(true);
  });
});
