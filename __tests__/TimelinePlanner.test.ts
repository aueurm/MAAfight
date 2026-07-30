import { buildTimelineEvents, planDeploymentTimeline } from "../src/engine/TimelinePlanner";
import { extractStageFacts } from "../src/engine/StageFacts";
import type { BattleScript, MapData } from "../src/types";

function mapData(): MapData {
  return {
    stageId: "timeline-test", name: "Timeline test", tiles: [], deploymentPoints: [], strategicPoints: [], highThreatAreas: [],
    routes: [
      { id: 0, motionMode: "walk", startPosition: { row: 0, col: 0 }, checkpoints: [], endPosition: { row: 0, col: 2 } },
      { id: 1, motionMode: "fly", startPosition: { row: 1, col: 0 }, checkpoints: [], endPosition: { row: 1, col: 2 } },
    ], waves: [],
    enemyDetails: [
      { id: "enemy", name: "enemy", maxHp: 1_000, atk: 100, def: 0, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false },
      { id: "boss", name: "boss", maxHp: 20_000, atk: 900, def: 0, magicResistance: 0, moveSpeed: 1, isBoss: true, isElite: true },
    ],
    spawnTimeline: [
      { time: 3, enemyId: "enemy", count: 2, routeIndex: 1 },
      { time: 18, enemyId: "boss", count: 1, routeIndex: 0 },
    ],
    options: { characterLimit: 2, maxLifePoint: 3, initialCost: 5, maxCost: 99, costIncreaseTime: 1 },
  };
}

describe("event deployment timeline", () => {
  it("derives spawn, air, boss and critical-zone events", () => {
    const data = mapData();
    const events = buildTimelineEvents(data, extractStageFacts(data));

    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(["first_spawn", "flying_wave", "boss_arrival", "fire_zone"]));
    expect(events.find(event => event.type === "first_spawn")?.time).toBe(3);
  });

  it("keeps cost readiness and explicit delays in one deterministic deployment timeline", () => {
    const script: BattleScript = {
      stage_name: "timeline-test", minimum_required: "v6.0.0", groups: [], opers: [],
      actions: [{ type: "Deploy", name: "operator", costs: 8, pre_delay: 2_000 }],
      doc: { title: "", details: "" }, generatedAt: "2026-01-01T00:00:00.000Z", metadata: { source: "test" }, version: 3,
    };
    expect(planDeploymentTimeline(script, mapData().options).deployments[0]).toMatchObject({ time: 3, cost: 8, affordable: true });
  });
});
