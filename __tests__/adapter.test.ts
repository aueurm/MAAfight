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

  it("should set correct map options", () => {
    const mapData = adapter.adapt(prtsData, "a001_01");

    expect(mapData.options.characterLimit).toBe(8);
    expect(mapData.options.maxLifePoint).toBe(15);
    expect(mapData.options.initialCost).toBe(10);
    expect(mapData.options.maxCost).toBe(99);
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
