import { generateScript } from "../src/battle/ScriptGenerator";
import { analyzeBattle } from "../src/battle/BattleAnalyzer";
import type { MapData, PlayerOperator } from "../src/types";
import { OPERATOR_POOLS } from "../src/shared/operatorDB";

function makeMapData(overrides: Partial<MapData> = {}): MapData {
  return {
    stageId: "test-01",
    name: "test",
    tiles: [],
    deploymentPoints: [
      { row: 1, col: 2, buildableType: "melee" },
      { row: 1, col: 3, buildableType: "melee" },
      { row: 2, col: 2, buildableType: "ranged" },
      { row: 2, col: 6, buildableType: "ranged" },
      { row: 3, col: 2, buildableType: "melee" },
    ],
    strategicPoints: [],
    highThreatAreas: [],
    routes: [],
    waves: [],
    enemyDetails: [],
    spawnTimeline: [
      { time: 0, enemyId: "e1", count: 1, routeIndex: 0 },
      { time: 5, enemyId: "e2", count: 1, routeIndex: 0 },
      { time: 10, enemyId: "e3", count: 1, routeIndex: 0 },
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

describe("generateScript", () => {
  it("should generate a script with SpeedUp action", () => {
    const mapData = makeMapData();
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);

    expect(script.stage_name).toBe("test-01");
    expect(script.minimum_required).toBe("v4.0.0");
    expect(script.actions.length).toBeGreaterThan(0);
    expect(script.actions[0].type).toBe("SpeedUp");
  });

  it("should include SkillDaemon when operators are deployed", () => {
    const mapData = makeMapData();
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);

    const hasSkillDaemon = script.actions.some(a => a.type === "SkillDaemon");
    expect(hasSkillDaemon).toBe(true);
  });

  it("should generate groups for deployed operators", () => {
    const mapData = makeMapData();
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);

    expect(script.groups.length).toBeGreaterThan(0);
    expect(script.groups[0].name).toBeDefined();
    expect(script.groups[0].opers.length).toBeGreaterThan(0);
  });

  it("should use deploymentOrder when provided", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "vanguard", priority: 100 },
        { position: { row: 2, col: 2 }, role: "sniper", priority: 80 },
      ],
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);

    const deployActions = script.actions.filter(a => a.type === "Deploy");
    expect(deployActions.length).toBeGreaterThanOrEqual(2);
    expect(deployActions[0].location).toEqual([1, 2]);
  });

  it("should set correct metadata", () => {
    const mapData = makeMapData();
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);

    expect(script.metadata.source).toBe("ai");
    expect(script.metadata.difficulty).toBeDefined();
    expect(script.generatedAt).toBeDefined();
  });

  it("should respect config options", () => {
    const mapData = makeMapData();
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis, {
      includeSpeedUp: false,
    });

    expect(script.actions[0].type).not.toBe("SpeedUp");
  });

  it("should insert Wait between consecutive Deploy actions", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "vanguard", priority: 100 },
        { position: { row: 1, col: 3 }, role: "vanguard", priority: 90 },
        { position: { row: 2, col: 2 }, role: "sniper", priority: 80 },
      ],
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis, {
      deploymentTimeout: 5,
    });

    const waitActions = script.actions.filter(a => a.type === "Wait");
    expect(waitActions.length).toBeGreaterThan(0);
    expect(waitActions[0].time).toBe(5);
  });

  it("should infer vertical direction for north-south routes", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "vanguard", priority: 100 },
      ],
      routes: [{
        id: 0, motionMode: "walk",
        startPosition: { row: 0, col: 5 },
        endPosition: { row: 10, col: 5 },
        checkpoints: [{ row: 5, col: 5 }],
      }],
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);
    const deployAction = script.actions.find(a => a.type === "Deploy");
    expect(deployAction).toBeDefined();
    expect(deployAction!.direction).toBe("Up");
  });

  it("should use fallback deployment when no deploymentOrder", () => {
    const mapData = makeMapData({
      deploymentOrder: undefined,
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);
    expect(script.actions.some(a => a.type === "Deploy")).toBe(true);
    expect(script.groups.length).toBeGreaterThan(0);
  });

  it("should infer Down direction for north-to-south routes", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "vanguard", priority: 100 },
      ],
      routes: [{
        id: 0, motionMode: "walk",
        startPosition: { row: 10, col: 5 },
        endPosition: { row: 0, col: 5 },
        checkpoints: [{ row: 5, col: 5 }],
      }],
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);
    const deployAction = script.actions.find(a => a.type === "Deploy");
    expect(deployAction).toBeDefined();
    expect(deployAction!.direction).toBe("Down");
  });

  it("should infer Left direction for west-to-east routes", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "vanguard", priority: 100 },
      ],
      routes: [{
        id: 0, motionMode: "walk",
        startPosition: { row: 5, col: 0 },
        endPosition: { row: 5, col: 10 },
        checkpoints: [{ row: 5, col: 5 }],
      }],
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);
    const deployAction = script.actions.find(a => a.type === "Deploy");
    expect(deployAction).toBeDefined();
    expect(deployAction!.direction).toBe("Left");
  });

  it("should skip routes with empty checkpoints in direction inference", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "vanguard", priority: 100 },
      ],
      routes: [
        { id: 0, motionMode: "walk",
          startPosition: { row: 0, col: 0 },
          endPosition: { row: 0, col: 0 },
          checkpoints: [],
        },
        { id: 1, motionMode: "walk",
          startPosition: { row: 0, col: 10 },
          endPosition: { row: 0, col: 0 },
          checkpoints: [{ row: 0, col: 5 }],
        },
      ],
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);
    const deployAction = script.actions.find(a => a.type === "Deploy");
    expect(deployAction).toBeDefined();
    expect(deployAction!.direction).toBe("Right");
  });

  it("should not insert Wait when deploymentTimeout is 0", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "vanguard", priority: 100 },
        { position: { row: 1, col: 3 }, role: "vanguard", priority: 90 },
      ],
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis, {
      deploymentTimeout: 0,
    });

    const waitActions = script.actions.filter(a => a.type === "Wait");
    expect(waitActions.length).toBe(0);
  });

  it("should skip unknown roles and fallback-deploy remaining operators", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "unknown_role", priority: 100 },
        { position: { row: 1, col: 3 }, role: "vanguard", priority: 90 },
      ],
    });
    const analysis = analyzeBattle(mapData);
    const script = generateScript("test-01", mapData, analysis);
    const deployActions = script.actions.filter(a => a.type === "Deploy");
    // Unknown role skipped, then fallback deploys remaining operators to unused slots
    expect(deployActions.length).toBeGreaterThanOrEqual(1);
  });

  it("should prefer owned operators when player data is provided", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "sniper", priority: 100 },
      ],
    });
    const analysis = analyzeBattle(mapData);
    const playerOps = new Map<string, PlayerOperator>([
      ["克洛斯", { id: "char_xxx", name: "克洛斯", rarity: 3, own: true, elite: 2, level: 55, potential: 6 }],
    ]);
    const scriptWithPlayer = generateScript("test-01", mapData, analysis, { playerOperators: playerOps });
    const deployAction = scriptWithPlayer.actions.find(a => a.type === "Deploy");
    expect(deployAction).toBeDefined();
    expect(deployAction!.name).toBe("克洛斯");
  });

  it("should not use unowned operators — only owned are deployed", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "sniper", priority: 100 },
      ],
    });
    const analysis = analyzeBattle(mapData);
    // Player owns 芬 (vanguard) but no snipers — sniper role should be skipped
    const playerOps = new Map<string, PlayerOperator>([
      ["芬", { id: "char_xxx", name: "芬", rarity: 2, own: true, elite: 0, level: 30, potential: 6 }],
    ]);
    const script = generateScript("test-01", mapData, analysis, { playerOperators: playerOps });
    const deployAction = script.actions.find(a => a.type === "Deploy");
    expect(deployAction).toBeDefined();
    // Owned vanguard fills the unused deployment slot (no unowned fallback)
    expect(deployAction!.name).toBe("芬");
    // No unowned sniper in groups
    const sniperGroup = script.groups.find(g => g.name === "狙击");
    expect(sniperGroup).toBeUndefined();
  });

  it("should include requirements in opers when player data is provided", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 1, col: 2 }, role: "vanguard", priority: 100 },
      ],
    });
    const analysis = analyzeBattle(mapData);
    const playerOps = new Map<string, PlayerOperator>([
      ["推进之王", { id: "char_xxx", name: "推进之王", rarity: 6, own: true, elite: 2, level: 90, potential: 3 }],
    ]);
    const script = generateScript("test-01", mapData, analysis, { playerOperators: playerOps });
    const topOper = script.opers.find(o => o.name === "推进之王");
    expect(topOper).toBeDefined();
    expect(topOper!.requirements).toBeDefined();
    expect(topOper!.requirements!.elite).toBe(2);
    expect(topOper!.requirements!.level).toBe(90);
    expect(topOper!.requirements!.potential).toBe(3);
  });

  it("should record operator gaps when owned player data lacks a requested role", () => {
    const mapData = makeMapData({
      deploymentOrder: [
        { position: { row: 2, col: 2 }, role: "sniper", priority: 100 },
      ],
    });
    const analysis = analyzeBattle(mapData);
    analysis.requirements = {
      ...analysis.requirements,
      vanguardCount: 0,
      guardCount: 0,
      tankCount: 0,
      sniperCount: 1,
      casterCount: 0,
      medicCount: 0,
      supportCount: 0,
      specialistCount: 0,
    };
    const ownedVanguard = OPERATOR_POOLS.vanguard[0].name;
    const playerOps = new Map<string, PlayerOperator>([
      [ownedVanguard, { id: "owned-vanguard", name: ownedVanguard, rarity: 6, own: true, elite: 2, level: 90, potential: 1 }],
    ]);

    const script = generateScript("test-01", mapData, analysis, { playerOperators: playerOps });

    expect(script.actions.some(a => a.type === "Deploy")).toBe(false);
    expect(script.metadata.playerOperatorsUsed).toBe(true);
    expect(script.metadata.operatorGaps).toEqual(expect.arrayContaining([
      expect.stringContaining("need 1, selected 0"),
    ]));
  });
});
