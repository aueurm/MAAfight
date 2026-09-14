import * as fs from "fs";
import * as path from "path";
import { PRTSMapLoader } from "../src/loader/PRTSMapLoader";
import { PRTSMapAdapter } from "../src/adapter/PRTSMapAdapter";
import { extractStageFacts, generateCopilotScript } from "../src/engine";
import { validateScript } from "../src/copilot/ScriptValidator";
import { exportToCopilotFormat } from "../src/copilot/ScriptExporter";
import type { PRTSLevelData, MapData } from "../src/types";

const LEVEL_PATH = path.resolve(__dirname, "..", "cache", "levels", "activities", "a001", "level_a001_01.json");
const BOSS_LEVEL_PATH = path.resolve(__dirname, "..", "cache", "levels", "activities", "act42side", "level_act42side_10.json");
const ALL_TILE_LEVEL_PATH = path.resolve(__dirname, "..", "cache", "levels", "activities", "act12side", "level_act12side_06.json");
const ENEMY_DB_PATH = path.resolve(__dirname, "..", "cache", "enemy_database.json");

function loadLevelData(): PRTSLevelData {
  const raw = fs.readFileSync(LEVEL_PATH, "utf-8");
  return JSON.parse(raw) as PRTSLevelData;
}

function loadBossLevelData(): PRTSLevelData {
  const raw = fs.readFileSync(BOSS_LEVEL_PATH, "utf-8");
  return JSON.parse(raw) as PRTSLevelData;
}

describe("PRTSMapAdapter", () => {
  let loader: PRTSMapLoader;
  let adapter: PRTSMapAdapter;
  let prtsData: PRTSLevelData;

  beforeAll(async () => {
    // Use cache directory that points to local files
    const cacheDir = path.resolve(__dirname, "..", "cache", "levels");
    loader = new PRTSMapLoader(cacheDir);
    await loader.loadEnemyDatabase();
    adapter = new PRTSMapAdapter(loader);
    prtsData = loadLevelData();
  });

  it("should convert tiles and extract deployment points", () => {
    const mapData = adapter.adapt(prtsData, "a001_01");

    expect(mapData.tiles.length).toBe(7);
    expect(mapData.tiles[0].length).toBe(10);
    expect(mapData.deploymentPoints.length).toBe(24);
    expect(mapData.deploymentPoints[0]).toHaveProperty("row");
    expect(mapData.deploymentPoints[0]).toHaveProperty("col");
    expect(mapData.deploymentPoints[0]).toHaveProperty("buildableType");
  });

  it("should convert routes and detect strategic points", () => {
    const mapData = adapter.adapt(prtsData, "a001_01");

    expect(mapData.routes.length).toBeGreaterThan(0);
    // First route should have valid structure
    expect(mapData.routes[0].startPosition).toBeDefined();
    expect(mapData.routes[0].endPosition).toBeDefined();
    expect(Array.isArray(mapData.routes[0].checkpoints)).toBe(true);

    // Should have strategic points (chokepoints or starts)
    expect(mapData.strategicPoints.length).toBeGreaterThan(0);
  });

  it("preserves route checkpoint waits without treating them as path turns", () => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    const route = data.routes.find((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    if (!route) throw new Error("fixture has no route");
    route.checkpoints = [
      { type: "MOVE", time: 0, position: { row: 2, col: 3 } },
      { type: "WAIT_FOR_SECONDS", time: 4, position: { row: 2, col: 3 } },
    ];

    const mapData = adapter.adapt(data, "a001_01");
    expect(mapData.routes[0].checkpoints).toEqual([
      { type: "MOVE", row: 4, col: 3 },
      { type: "WAIT_FOR_SECONDS", row: 4, col: 3, waitSeconds: 4 },
    ]);
  });

  it("should generate sorted spawn timeline", () => {
    const mapData = adapter.adapt(prtsData, "a001_01");

    expect(mapData.spawnTimeline.length).toBeGreaterThan(0);

    // Timeline should be sorted by time ascending
    for (let i = 1; i < mapData.spawnTimeline.length; i++) {
      expect(mapData.spawnTimeline[i].time)
        .toBeGreaterThanOrEqual(mapData.spawnTimeline[i - 1].time);
    }

    // First spawn should be at time 0
    expect(mapData.spawnTimeline[0].time).toBeGreaterThanOrEqual(0);
  });

  it.each(["SPAWN", 0] as const)("schedules %s siblings in parallel and advances completed fragments and waves", actionType => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    const source = data.waves.flatMap(wave => wave.fragments.flatMap(fragment => fragment.actions))
      .find(action => action.actionType === "SPAWN" || action.actionType === 0)!;
    const spawn = (preDelay: number, count = 1, interval = 1) => ({ ...source, actionType, preDelay, count, interval });
    data.waves = [
      { preDelay: 2, postDelay: 5, maxTimeWaitingForNextWave: -1, fragments: [
        { preDelay: 3, actions: [spawn(7, 2, 2), spawn(1)] },
        { preDelay: 4, actions: [spawn(0.5)] },
      ] },
      { preDelay: 6, postDelay: 0, maxTimeWaitingForNextWave: -1, fragments: [
        { preDelay: 2, actions: [] },
        { preDelay: 0, actions: [spawn(2)] },
      ] },
    ];

    const adapted = adapter.adapt(data, "action-delays");
    expect(adapted.waves[0].fragments[0].enemySpawns.map(action => action.preDelay)).toEqual([7, 1]);
    expect(adapted.spawnTimeline.map(spawn => spawn.time)).toEqual([6, 12, 14, 18.5, 33.5]);
    expect(adapted.highThreatAreas).toHaveLength(1);
    expect(adapted.highThreatAreas[0]).toMatchObject({ firstSpawnTime: 6, spawnCount: 5 });
  });

  it.each([-1, NaN, Infinity])("rejects unsupported spawn preDelay %s instead of changing its meaning", preDelay => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    const action = data.waves.flatMap(wave => wave.fragments.flatMap(fragment => fragment.actions))
      .find(action => action.actionType === "SPAWN" || action.actionType === 0)!;
    action.preDelay = preDelay;
    expect(() => adapter.adapt(data, "invalid-action-delay")).toThrow("Invalid spawn preDelay");
  });

  it("preserves H5-1 action offsets instead of spawning delayed ground routes at zero", () => {
    const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "cache", "levels", "obt", "hard", "level_hard_05-01.json"), "utf8")) as PRTSLevelData;
    const adapted = adapter.adapt(data, "hard_05-01");
    expect(adapted.spawnTimeline.filter(spawn => spawn.routeIndex === 7).map(spawn => spawn.time)).toEqual([14]);
    expect(adapted.spawnTimeline.filter(spawn => spawn.routeIndex === 8).map(spawn => spawn.time)).toEqual([23, 26]);
    expect(adapted.spawnTimeline.filter(spawn => spawn.routeIndex === 11).map(spawn => spawn.time)).toEqual([37]);
    expect(adapted.spawnTimeline.filter(spawn => spawn.routeIndex === 12).map(spawn => spawn.time)).toEqual([48]);
  });

  it("should generate enemy details with HP/ATK/DEF", () => {
    const mapData = adapter.adapt(prtsData, "a001_01");

    expect(mapData.enemyDetails.length).toBeGreaterThan(0);
    const firstEnemy = mapData.enemyDetails[0];
    expect(firstEnemy.id).toBeDefined();
    expect(firstEnemy.name).toBeDefined();
    expect(typeof firstEnemy.maxHp).toBe("number");
    expect(typeof firstEnemy.atk).toBe("number");
    expect(typeof firstEnemy.def).toBe("number");
  });

  it("derives stealth and revive mechanics from enemy descriptions", () => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    const enemyId = data.waves[0]?.fragments[0]?.actions.find(action => action.key)?.key;
    if (!enemyId) throw new Error("fixture has no enemy spawn");
    const getEnemyInfo = jest.spyOn(loader, "getEnemyInfo").mockImplementation(id => id === enemyId ? {
      name: "Mechanic fixture", description: "隐匿；首次倒下后重生。", prefabKey: id,
      attributes: { maxHp: 1, atk: 1, def: 1, magicResistance: 0, moveSpeed: 1, attackSpeed: 100, massLevel: 1 },
      enemyTags: [],
    } : null);

    expect(adapter.adapt(data, "a001_01").enemyDetails.find(enemy => enemy.id === enemyId)?.mechanics)
      .toEqual(["stealth", "revive"]);
    getEnemyInfo.mockRestore();
  });

  it("should set correct map options", () => {
    const mapData = adapter.adapt(prtsData, "a001_01");

    expect(mapData.options.characterLimit).toBe(8);
    expect(mapData.options.maxLifePoint).toBe(15);
    expect(mapData.options.initialCost).toBe(10);
    expect(mapData.options.maxCost).toBe(99);
    expect(mapData.options.moveMultiplier).toBe(0.5);
  });

  it("preserves the movement multiplier without changing the raw enemy speed", () => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    data.options.moveMultiplier = 0.25;
    const baseline = adapter.adapt(prtsData, "a001_01");
    const adapted = adapter.adapt(data, "a001_01");
    expect(adapted.options.moveMultiplier).toBe(0.25);
    expect(adapted.enemyDetails.map(enemy => enemy.moveSpeed)).toEqual(baseline.enemyDetails.map(enemy => enemy.moveSpeed));
  });

  it("keeps legacy maps without a movement multiplier compatible", () => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    delete data.options.moveMultiplier;
    expect(adapter.adapt(data, "a001_01").options.moveMultiplier).toBeUndefined();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid movement multiplier %s", value => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    data.options.moveMultiplier = value;
    expect(() => adapter.adapt(data, "a001_01")).toThrow("Invalid moveMultiplier for a001_01");
  });

  it("should parse numeric enum routes and spawn actions from boss data", () => {
    const bossData = loadBossLevelData();
    const mapData = adapter.adapt(bossData, "act42side_10");
    const facts = extractStageFacts(mapData);

    expect(mapData.routes.length).toBeGreaterThan(0);
    expect(mapData.routes.some(route => route.motionMode === "fly")).toBe(true);
    expect(mapData.deploymentPoints.length).toBeGreaterThan(0);
    expect(mapData.deploymentPoints.length).toBeLessThan(mapData.tiles.length * mapData.tiles[0].length);
    expect(mapData.spawnTimeline.length).toBeGreaterThan(0);
    expect(mapData.enemyDetails.length).toBeGreaterThan(0);
    expect(facts.enemyCount).toBeGreaterThan(0);
    expect(mapData.enemyDetails.some(enemy => enemy.isBoss)).toBe(true);
    expect(facts.bossCount).toBeGreaterThan(0);
  });

  it("should preserve ALL tiles as flexible deployment points", () => {
    const allTileData = JSON.parse(fs.readFileSync(ALL_TILE_LEVEL_PATH, "utf8")) as PRTSLevelData;
    const mapData = adapter.adapt(allTileData, "act12side_06");
    expect(mapData.deploymentPoints.some(point => point.buildableType === "all")).toBe(true);
  });

  it("reports an unsupported empty level instead of dereferencing its null map", () => {
    const data = { ...prtsData, mapData: { ...prtsData.mapData, map: null } } as any;
    expect(() => adapter.adapt(data, "empty")).toThrow("Unsupported level structure for empty");
  });

  it("keeps direct routes that have endpoints but no intermediate checkpoints", () => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    const route = data.routes.find((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    if (!route) throw new Error("fixture has no route");
    data.routes = [{ ...route, motionMode: "WALK", checkpoints: [] }];
    expect(adapter.adapt(data, "a001_01").routes).toEqual([{
      id: 0, motionMode: "walk", startPosition: { row: 6 - route.startPosition.row, col: route.startPosition.col },
      endPosition: { row: 6 - route.endPosition.row, col: route.endPosition.col }, checkpoints: [],
    }]);
  });

  it("normalizes numeric waits and teleports using the GameData enum values", () => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    const route = data.routes.find((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    if (!route) throw new Error("fixture has no route");
    data.routes = [{ ...route, motionMode: 0, checkpoints: [
      { type: 1, time: 5, position: { row: 0, col: 0 } },
      { type: 3, time: 10, position: { row: 0, col: 0 } },
      { type: 5, time: 0, position: { row: 0, col: 0 } },
      { type: 6, time: 0, position: { row: 2, col: 4 } },
    ] }];
    expect(adapter.adapt(data, "a001_01").routes[0].checkpoints).toEqual([
      { type: "WAIT_FOR_SECONDS", waitSeconds: 5, row: 6, col: 0 },
      { type: "WAIT_CURRENT_FRAGMENT_TIME", row: 6, col: 0 },
      { type: "DISAPPEAR", row: 6, col: 0 },
      { type: "APPEAR_AT_POS", row: 4, col: 4 },
    ]);
  });

  it.each([
    ["activities/a001/level_a001_01.json", 0],
    ["activities/act3d0/level_act3d0_01.json", 0],
    ["obt/weekly/level_weekly_fly_3.json", 0],
  ])("aligns the route end with the map's blue gate in %s", (relativePath, routeId) => {
    const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "cache", "levels", relativePath), "utf8")) as PRTSLevelData;
    const original = JSON.stringify(data);
    const map = adapter.adapt(data, relativePath);
    const route = map.routes.find(candidate => candidate.id === routeId);
    if (!route) throw new Error("fixture route missing");
    expect(map.tiles[route.endPosition.row][route.endPosition.col].key).toBe("end");
    expect(JSON.stringify(data)).toBe(original);
  });

  it("rejects unsupported checkpoint semantics rather than treating them as teleportation", () => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    const route = data.routes.find((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    if (!route) throw new Error("fixture has no route");
    route.motionMode = "WALK";
    route.checkpoints = [{ type: "PATROL_MOVE", time: 0, position: { row: 1, col: 2 } } as any];
    expect(() => adapter.adapt(data, "a001_01")).toThrow("Unsupported route checkpoint type: PATROL_MOVE");
  });

  it("preserves numeric ALL tiles and passes the stage enemy level to the database", () => {
    const data = JSON.parse(JSON.stringify(prtsData)) as PRTSLevelData;
    data.mapData.tiles[data.mapData.map[0][0]].buildableType = 3;
    const enemyId = data.waves.flatMap(wave => wave.fragments).flatMap(fragment => fragment.actions)
      .find(action => action.actionType === "SPAWN" || action.actionType === 0)?.key;
    if (!enemyId) throw new Error("fixture has no enemy");
    const ref = data.enemyDbRefs.find(candidate => candidate.id === enemyId);
    if (!ref) throw new Error("fixture has no enemy reference");
    ref.level = 2;
    const original = loader.getEnemyInfo.bind(loader);
    const get = jest.spyOn(loader, "getEnemyInfo").mockImplementation(id => original(id));
    const adapted = adapter.adapt(data, "a001_01");
    expect(adapted.deploymentPoints).toContainEqual({ row: 0, col: 0, buildableType: "all" });
    expect(get).toHaveBeenCalledWith(enemyId, 2);
    get.mockRestore();
  });
});

describe("V2 pipeline with real PRTS data", () => {
  let mapData: MapData;

  beforeAll(async () => {
    const cacheDir = path.resolve(__dirname, "..", "cache", "levels");
    const loader = new PRTSMapLoader(cacheDir);
    await loader.loadEnemyDatabase();
    const adapter = new PRTSMapAdapter(loader);
    const prtsData = loadLevelData();
    mapData = adapter.adapt(prtsData, "a001_01");
  });

  it("should run adapt, v2 generation, validation, and export", () => {
    const result = generateCopilotScript("GT-1", mapData);
    const validation = validateScript(result.script, mapData);
    const parsed = JSON.parse(exportToCopilotFormat(result.script));

    expect(result.facts.enemyCount).toBeGreaterThan(0);
    expect(result.script.groups).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(parsed.stage_name).toBe("GT-1");
    expect(parsed.actions.length).toBeGreaterThan(0);
  });

  it("should reject invalid action and deployment coordinates", () => {
    const script = generateCopilotScript("GT-1", mapData).script;
    script.actions.push({ type: "BadAction" });
    script.actions.push({ type: "Deploy", name: "推进之王", location: [999, 999], direction: "Right" });
    const validation = validateScript(script, mapData);
    expect(validation.errors.some(error => error.code === "INVALID_ACTION_TYPE")).toBe(true);
    expect(validation.errors.some(error => error.code === "LOCATION_OUT_OF_BOUNDS")).toBe(true);
  });
});
