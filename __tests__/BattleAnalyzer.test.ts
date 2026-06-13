import { analyzeBattle } from "../src/battle/BattleAnalyzer";
import type { MapData } from "../src/types";

function makeMapData(overrides: Partial<MapData> = {}): MapData {
  return {
    stageId: "test-01",
    name: "test",
    tiles: [],
    deploymentPoints: [
      { row: 1, col: 2, buildableType: "melee" },
      { row: 1, col: 3, buildableType: "melee" },
      { row: 2, col: 2, buildableType: "ranged" },
    ],
    strategicPoints: [
      { type: "chokepoint", row: 2, col: 3, routeCount: 2 },
    ],
    highThreatAreas: [
      { row: 0, col: 0, enemyTypes: [], spawnCount: 6, firstSpawnTime: 0 },
    ],
    routes: [
      {
        id: 0, motionMode: "walk",
        startPosition: { row: 0, col: 1 },
        endPosition: { row: 6, col: 4 },
        checkpoints: [{ row: 2, col: 3 }, { row: 4, col: 4 }],
      },
    ],
    waves: [],
    enemyDetails: [],
    spawnTimeline: [
      { time: 0, enemyId: "e1", count: 1, routeIndex: 0 },
      { time: 5, enemyId: "e2", count: 1, routeIndex: 0 },
      { time: 10, enemyId: "e3", count: 1, routeIndex: 0 },
      { time: 15, enemyId: "e4", count: 1, routeIndex: 0 },
      { time: 20, enemyId: "e5", count: 1, routeIndex: 0 },
      { time: 25, enemyId: "e6", count: 1, routeIndex: 0 },
    ],
    options: {
      characterLimit: 8,
      maxLifePoint: 10,
      initialCost: 10,
      maxCost: 99,
      costIncreaseTime: 1,
    },
    ...overrides,
  };
}

describe("analyzeBattle", () => {
  it("should return a valid tactical analysis", () => {
    const result = analyzeBattle(makeMapData());

    expect(result.summary).toBeDefined();
    expect(result.enemyComposition).toBeDefined();
    expect(result.requirements).toBeDefined();
    expect(result.keyTimings.length).toBeGreaterThan(0);
    expect(result.suggestedStrategy).toBeDefined();
    expect(result.suggestedStrategy.name).toBeDefined();
  });

  it("should rate easy for small spawn counts", () => {
    const mapData = makeMapData({
      spawnTimeline: [{ time: 0, enemyId: "e1", count: 1, routeIndex: 0 }],
    });
    const result = analyzeBattle(mapData);
    expect(result.requirements.difficultyRating).toBe("easy");
  });

  it("should rate hard for elite-heavy compositions", () => {
    // 15 spawns triggers eliteCount = floor(15*0.25) = 3, puts it in "hard"
    const timeline = Array.from({ length: 15 }, (_, i) => ({
      time: i * 3, enemyId: `e${i}`, count: 1, routeIndex: 0,
    }));
    const result = analyzeBattle(makeMapData({ spawnTimeline: timeline }));
    expect(["medium", "hard", "extreme"]).toContain(result.requirements.difficultyRating);
  });

  it("should recommend more medics for boss compositions", () => {
    // 25 spawns triggers bossCount = floor(25*0.05) = 1
    const timeline = Array.from({ length: 25 }, (_, i) => ({
      time: i * 2, enemyId: `e${i}`, count: 1, routeIndex: 0,
    }));
    const result = analyzeBattle(makeMapData({ spawnTimeline: timeline }));
    expect(result.requirements.medicCount).toBeGreaterThanOrEqual(2);
  });

  it("should handle empty maps gracefully", () => {
    const mapData = makeMapData({
      spawnTimeline: [],
      highThreatAreas: [],
      strategicPoints: [],
    });
    const result = analyzeBattle(mapData);
    expect(result.summary).toContain("rated");
    expect(result.enemyComposition.totalCount).toBe(0);
  });

  it("should include notes in output", () => {
    const result = analyzeBattle(makeMapData());
    expect(result.notes).toBeDefined();
    expect(result.notes!.length).toBeGreaterThan(0);
  });

  it("should use real enemyDetails for composition analysis", () => {
    const mapData = makeMapData({
      enemyDetails: [
        { id: "e1", name: "enemy1", maxHp: 2000, atk: 200, def: 100, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false },
        { id: "e2", name: "enemy2", maxHp: 8000, atk: 500, def: 300, magicResistance: 20, moveSpeed: 1, isBoss: false, isElite: true },
      ],
      spawnTimeline: [
        { time: 0, enemyId: "e1", count: 5, routeIndex: 0 },
        { time: 10, enemyId: "e2", count: 2, routeIndex: 0 },
      ],
    });
    const result = analyzeBattle(mapData);
    expect(result.enemyComposition.normalCount).toBe(5);
    expect(result.enemyComposition.eliteCount).toBe(2);
    expect(result.enemyComposition.bossCount).toBe(0);
  });

  it("should trigger mixed strategy for normal+elite mix", () => {
    const mapData = makeMapData({
      enemyDetails: [
        { id: "e1", name: "soldier", maxHp: 2000, atk: 200, def: 100, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false },
        { id: "e2", name: "elite", maxHp: 8000, atk: 500, def: 300, magicResistance: 20, moveSpeed: 1, isBoss: false, isElite: true },
      ],
      spawnTimeline: Array.from({ length: 11 }, (_, i) => ({
        time: i * 2,
        enemyId: i < 9 ? "e1" : "e2",
        count: 1,
        routeIndex: 0,
      })),
    });
    const result = analyzeBattle(mapData);
    expect(result.enemyComposition.compositionType).toBe("mixed");
    expect(result.suggestedStrategy.name).toBe("Balanced Assault");
  });

  it("should calculate DPS requirements for boss stages", () => {
    const mapData = makeMapData({
      enemyDetails: [
        { id: "boss", name: "Boss", maxHp: 50000, atk: 1000, def: 500, magicResistance: 30, moveSpeed: 0.5, isBoss: true, isElite: false },
        { id: "e1", name: "mob", maxHp: 2000, atk: 200, def: 100, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false },
      ],
      spawnTimeline: [
        { time: 0, enemyId: "e1", count: 5, routeIndex: 0 },
        { time: 30, enemyId: "boss", count: 1, routeIndex: 0 },
      ],
    });
    const result = analyzeBattle(mapData);
    expect(result.enemyComposition.bossCount).toBe(1);
    expect(result.dpsRequirement).toBeDefined();
    expect(result.dpsRequirement!.totalBossHP).toBe(50000);
    expect(result.dpsRequirement!.requiredDPS).toBeGreaterThan(0);
    expect(["hard", "extreme"]).toContain(result.requirements.difficultyRating);
  });

  it("should generate map recommendations near chokepoints", () => {
    const mapData = makeMapData({
      deploymentPoints: [
        { row: 1, col: 2, buildableType: "melee" },
        { row: 1, col: 3, buildableType: "melee" },
        { row: 1, col: 4, buildableType: "ranged" },
        { row: 3, col: 3, buildableType: "melee" },
      ],
      strategicPoints: [
        { type: "chokepoint", row: 2, col: 3, routeCount: 2 },
        { type: "start", row: 0, col: 1, routeCount: 1 },
      ],
    });
    const result = analyzeBattle(mapData);
    expect(result.mapRecommendations).toBeDefined();
    expect(result.mapRecommendations!.length).toBeGreaterThan(0);
    // Should include chokepoint coverage
    expect(result.mapRecommendations!.some(r => r.recommendedRole === "tank")).toBe(true);
  });

  it("should handle enemy not found in enemyDetails", () => {
    const mapData = makeMapData({
      enemyDetails: [
        { id: "e1", name: "known", maxHp: 2000, atk: 200, def: 100, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false },
      ],
      spawnTimeline: [
        { time: 0, enemyId: "e1", count: 1, routeIndex: 0 },
        { time: 5, enemyId: "unknown_enemy", count: 1, routeIndex: 0 },
      ],
    });
    const result = analyzeBattle(mapData);
    expect(result.enemyComposition.normalCount).toBe(2);
  });

  it("should recommend top-tier DPS for boss HP > 100k", () => {
    const mapData = makeMapData({
      enemyDetails: [
        { id: "boss", name: "MegaBoss", maxHp: 150000, atk: 2000, def: 800, magicResistance: 50, moveSpeed: 0.5, isBoss: true, isElite: false },
      ],
      spawnTimeline: [
        { time: 60, enemyId: "boss", count: 1, routeIndex: 0 },
      ],
    });
    const result = analyzeBattle(mapData);
    expect(result.dpsRequirement).toBeDefined();
    expect(result.dpsRequirement!.totalBossHP).toBe(150000);
    expect(result.dpsRequirement!.recommendedOperators).toContain("银灰");
  });

  it("should use v1 heuristic when enemyDetails is empty", () => {
    const mapData = makeMapData({
      enemyDetails: [],
      spawnTimeline: Array.from({ length: 15 }, (_, i) => ({
        time: i * 3, enemyId: `e${i}`, count: 1, routeIndex: 0,
      })),
    });
    const result = analyzeBattle(mapData);
    expect(result.enemyComposition.totalCount).toBe(15);
    expect(result.enemyComposition.eliteCount).toBe(3);
  });

  it("should rate extreme for high difficulty score", () => {
    const mapData = makeMapData({
      enemyDetails: [
        { id: "boss", name: "Boss", maxHp: 100000, atk: 2000, def: 800, magicResistance: 50, moveSpeed: 0.5, isBoss: true, isElite: false },
        { id: "elite", name: "Elite", maxHp: 15000, atk: 800, def: 500, magicResistance: 30, moveSpeed: 1, isBoss: false, isElite: true },
        { id: "mob", name: "Mob", maxHp: 3000, atk: 300, def: 150, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false },
      ],
      spawnTimeline: [
        ...Array.from({ length: 5 }, (_, i) => ({ time: i * 2, enemyId: "mob", count: 1, routeIndex: 0 })),
        { time: 15, enemyId: "boss", count: 1, routeIndex: 0 },
        { time: 20, enemyId: "elite", count: 3, routeIndex: 0 },
        ...Array.from({ length: 10 }, (_, i) => ({ time: 30 + i * 2, enemyId: "mob", count: 1, routeIndex: 0 })),
      ],
    });
    const result = analyzeBattle(mapData);
    expect(result.requirements.difficultyRating).toBe("extreme");
    expect(result.dpsRequirement).toBeDefined();
    expect(result.enemyComposition.totalHP).toBeGreaterThan(0);
    expect(result.enemyComposition.averageDEF).toBeGreaterThan(0);
  });
});
