import { buildBattlePlan, buildPressureWindows } from "../src/battle/BattlePlanner";
import { DPTimeline } from "../src/battle/DPTimeline";
import { analyzeBattle } from "../src/battle/BattleAnalyzer";
import type { MapData } from "../src/types";

function makeMapData(overrides: Partial<MapData> = {}): MapData {
  return {
    stageId: "planner-test",
    name: "planner-test",
    tiles: [],
    deploymentPoints: [
      { row: 1, col: 1, buildableType: "melee" },
      { row: 2, col: 2, buildableType: "ranged" },
    ],
    strategicPoints: [
      { type: "start", row: 0, col: 0, routeCount: 1 },
      { type: "chokepoint", row: 2, col: 1, routeCount: 2 },
      { type: "end", row: 5, col: 5, routeCount: 1 },
    ],
    highThreatAreas: [],
    routes: [
      {
        id: 0,
        motionMode: "walk",
        startPosition: { row: 0, col: 0 },
        endPosition: { row: 5, col: 5 },
        checkpoints: [{ row: 1, col: 1 }, { row: 2, col: 1 }, { row: 4, col: 4 }],
      },
      {
        id: 1,
        motionMode: "fly",
        startPosition: { row: 0, col: 5 },
        endPosition: { row: 5, col: 5 },
        checkpoints: [{ row: 1, col: 4 }, { row: 3, col: 4 }],
      },
    ],
    waves: [],
    enemyDetails: [],
    spawnTimeline: [
      { time: 0, enemyId: "mob", count: 3, routeIndex: 0 },
      { time: 12, enemyId: "drone", count: 2, routeIndex: 1 },
      { time: 30, enemyId: "boss", count: 1, routeIndex: 0 },
    ],
    options: {
      characterLimit: 8,
      maxLifePoint: 10,
      initialCost: 5,
      maxCost: 99,
      costIncreaseTime: 1,
    },
    ...overrides,
  };
}

describe("BattlePlanner", () => {
  it("should build pressure windows without enemy details", () => {
    const windows = buildPressureWindows(makeMapData({ enemyDetails: [] }));

    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].enemyCount).toBeGreaterThan(0);
    expect(windows[0].totalHp).toBeGreaterThan(0);
    expect(windows.some(window => window.hasFlying)).toBe(true);
  });

  it("should recommend lightweight tasks from pressure and analysis", () => {
    const mapData = makeMapData({
      enemyDetails: [
        { id: "mob", name: "mob", maxHp: 2000, atk: 200, def: 100, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false },
        { id: "drone", name: "drone", maxHp: 1800, atk: 250, def: 80, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false },
        { id: "boss", name: "boss", maxHp: 90000, atk: 1400, def: 700, magicResistance: 30, moveSpeed: 0.5, isBoss: true, isElite: false },
      ],
    });
    const analysis = analyzeBattle(mapData);
    const plan = buildBattlePlan(mapData, analysis);

    expect(plan.recommendedTasks).toContain("early_dp");
    expect(plan.recommendedTasks).toContain("anti_air");
    expect(plan.recommendedTasks).toContain("arts_damage");
    expect(plan.recommendedTasks).toContain("boss_kill");
    expect(plan.pressureWindows.some(window => window.hasBoss)).toBe(true);
  });
});

describe("DPTimeline", () => {
  it("should never return a deploy time before the requested lower bound", () => {
    const timeline = new DPTimeline(0, 1);
    const deployTime = timeline.nextDeployableTime(18, 5);
    const waitBefore = Math.max(0, Math.ceil(deployTime - timeline.currentTime));

    expect(deployTime).toBeGreaterThanOrEqual(5);
    expect(waitBefore).toBeGreaterThanOrEqual(0);
  });
});
