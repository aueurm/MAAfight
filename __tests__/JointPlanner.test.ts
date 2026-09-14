import { buildEncounterContext } from "../src/engine/EncounterContext";
import { buildJointPlan } from "../src/engine/JointPlanner";
import { extractStageFacts } from "../src/engine/StageFacts";
import type { EnginePick } from "../src/engine/types";
import type { MapData } from "../src/types";

function mapData(): MapData {
  return {
    stageId: "joint-test", name: "Joint test",
    tiles: Array.from({ length: 3 }, (_, row) => Array.from({ length: 6 }, (_, col) => ({
      key: "floor", heightType: row === 0 ? "highland" as const : "lowland" as const,
      buildableType: row === 0 ? "ranged" as const : row === 1 ? "melee" as const : "none" as const, row, col,
    }))),
    deploymentPoints: [
      { row: 1, col: 2, buildableType: "melee" },
      { row: 1, col: 3, buildableType: "melee" },
      { row: 0, col: 2, buildableType: "ranged" },
    ],
    strategicPoints: [], highThreatAreas: [],
    routes: [{ id: 0, motionMode: "walk", startPosition: { row: 1, col: 0 }, checkpoints: [], endPosition: { row: 1, col: 5 } }],
    waves: [],
    enemyDetails: [{ id: "enemy", name: "enemy", maxHp: 5_000, atk: 300, def: 0, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false }],
    spawnTimeline: [{ time: 0, enemyId: "enemy", count: 4, routeIndex: 0 }],
    options: { characterLimit: 2, maxLifePoint: 3, initialCost: 10, maxCost: 99, costIncreaseTime: 1 },
  };
}

function pick(name: string, position: "MELEE" | "RANGED", range: Array<[number, number]>): EnginePick {
  return {
    operatorId: name, name, role: position === "MELEE" ? "guard" : "sniper", skill: 1, skillRank: 10,
    profile: {
      operatorId: name, name, role: position === "MELEE" ? "guard" : "sniper", subProfession: null, position,
      damageType: "physical", skill: 1, skillRank: 10, skillDuration: 0, respawnTime: 0,
      baseRangeId: null, skillRangeId: null, range,
      attributes: { hp: 1000, atk: 500, def: 100, res: 0, cost: 10, block: 1, attackInterval: 1, attackSpeed: 100 },
      metrics: { normalDps: 500, burstDps: 500, cycleDps: 500, healingHps: 0, physicalEhp: 1000, artsEhp: 1000, controlSeconds: 0 },
      maxTargets: 1, confidence: "exact", modelCoverageGaps: [],
    },
  };
}

describe("joint placement planner", () => {
  it("selects distinct legal cells with temporal coverage", () => {
    const data = mapData();
    const facts = extractStageFacts(data);
    const plan = buildJointPlan(data, facts, buildEncounterContext(data, facts), {
      picks: [pick("blocker", "MELEE", [[0, 0]]), pick("ranged", "RANGED", [[1, 0], [1, 1]])],
    });

    expect(plan.decisions).toHaveLength(2);
    expect(new Set(plan.decisions.map(item => item.location.join(","))).size).toBe(plan.decisions.length);
    expect(plan.decisions.every(item => data.deploymentPoints.some(point => point.row === item.location[0]
      && point.col === item.location[1]))).toBe(true);
  });

  it("does not delay first contact to a later coarse pressure window", () => {
    const data = mapData();
    data.deploymentPoints = [{ row: 1, col: 2, buildableType: "melee" }];
    data.spawnTimeline.push({ time: 20, enemyId: "enemy", count: 1, routeIndex: 0 });
    const facts = extractStageFacts(data);
    const plan = buildJointPlan(data, facts, buildEncounterContext(data, facts), {
      picks: [pick("blocker", "MELEE", [[0, 0]])],
    });
    expect(plan.decisions[0].targetTime).toBe(1);
  });
});
