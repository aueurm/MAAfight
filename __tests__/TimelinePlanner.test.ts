import { buildTimelineEvents, costAt, planDeploymentTimeline } from "../src/engine/TimelinePlanner";
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
  it("reports every action's game time and applies explicit deployment interaction allowances", () => {
    const actions = [{ type: "SpeedUp" as const }, { type: "Deploy" as const, name: "operator", costs: 8 },
      { type: "Skill" as const, name: "operator", pre_delay: 1000 }, { type: "Output" as const, kills: 1 }];
    const timeline = planDeploymentTimeline({ actions }, mapData().options, { deploymentInteractionSeconds: 0.75 });
    expect(timeline.actionTimes).toEqual([0, 3, 6.5, Number.POSITIVE_INFINITY]);
    expect(timeline.deployments[0].time).toBe(4.5);
  });
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
    // MAA 先等费用条件，再等 pre_delay。
    expect(planDeploymentTimeline(script, mapData().options).deployments[0]).toMatchObject({ time: 5, cost: 8, affordable: true });
  });

  it("does not invent natural cost recovery in annihilation stages", () => {
    const options = { ...mapData().options, initialCost: 0, costIncreaseTime: 999999 };
    const timeline = planDeploymentTimeline({ actions: [{ type: "Deploy", name: "operator", costs: 20 }] }, options);
    expect(costAt(120, options)).toBe(0);
    expect(timeline.deployments[0].time).toBeGreaterThan(120);
    expect(costAt(timeline.deployments[0].time, options)).toBe(20);
  });

  it("propagates skill timer conditions and post delays to later deployments", () => {
    const timeline = planDeploymentTimeline({ actions: [
      { type: "ResetStopwatch" },
      { type: "Skill", name: "operator", elapsed_time: 90000, pre_delay: 1000, post_delay: 2000 },
      { type: "Deploy", name: "reserve", costs: 20 },
    ] }, mapData().options);
    expect(timeline.deployments[0].time).toBe(93);
  });

  it("converts wall-clock waits to game seconds after SpeedUp and resets the stopwatch origin", () => {
    const timeline = planDeploymentTimeline({ actions: [
      { type: "SpeedUp" },
      { type: "Output", post_delay: 5000 },
      { type: "ResetStopwatch" },
      { type: "Skill", name: "operator", elapsed_time: 10000 },
      { type: "Deploy", name: "reserve", costs: 0 },
    ] }, mapData().options);
    expect(timeline.deployments[0].time).toBe(30);
  });

  it("honors cost conditions on Retreat before recording the deployment end", () => {
    const timeline = planDeploymentTimeline({ actions: [
      { type: "Deploy", name: "operator", location: [0, 0], costs: 5 },
      { type: "Retreat", name: "operator", costs: 10, post_delay: 2000 },
      { type: "Deploy", name: "reserve", location: [0, 0], costs: 1 },
    ] }, mapData().options);
    expect(timeline.deployments[0]).toMatchObject({ time: 0, endTime: 10 });
    expect(timeline.deployments[1].time).toBe(12);
  });

  it("does not assign an early deployment after an unmodeled kill or cooling condition", () => {
    for (const condition of [{ kills: 3 }, { cooling: 1 }]) {
      const timeline = planDeploymentTimeline({ actions: [
        { type: "Skill", name: "operator", ...condition },
        { type: "Deploy", name: "reserve", costs: 1 },
      ] }, mapData().options);
      expect(timeline.deployments[0].affordable).toBe(false);
      expect(timeline.reasons).toContain("action_condition_timing_unknown");
    }
  });

  it("bases cost_changes on the cost at the start of the action", () => {
    const timeline = planDeploymentTimeline({ actions: [
      { type: "Output", cost_changes: 5, pre_delay: 2000, post_delay: 1000 },
      { type: "Deploy", name: "operator", costs: 1 },
    ] }, mapData().options);
    expect(timeline.deployments[0].time).toBe(8);
  });

  it("keeps fractional recovery periods from losing a cost point to rounding", () => {
    const options = { ...mapData().options, initialCost: 0, costIncreaseTime: 0.85 };
    const timeline = planDeploymentTimeline({ actions: [{ type: "Deploy", name: "operator", costs: 13 }] }, options);
    expect(timeline.deployments[0].affordable).toBe(true);
    expect(costAt(13 * 0.85, options)).toBe(13);
  });
});
