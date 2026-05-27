import * as fs from "fs";
import * as path from "path";
import { PRTSMapLoader } from "../src/loader/PRTSMapLoader";
import { PRTSMapAdapter } from "../src/adapter/PRTSMapAdapter";
import { analyzeBattle } from "../src/battle/BattleAnalyzer";
import { generateScript } from "../src/battle/ScriptGenerator";
import { validateScript } from "../src/battle/ScriptValidator";
import { exportToCopilotFormat } from "../src/battle/ScriptExporter";
import type { PRTSLevelData, MapData } from "../src/types";

const LEVEL_PATH = path.resolve(__dirname, "..", "level_a001_01.json");
const ENEMY_DB_PATH = path.resolve(__dirname, "..", "enemy_database.json");

function loadLevelData(): PRTSLevelData {
  const raw = fs.readFileSync(LEVEL_PATH, "utf-8");
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

  it("should generate deployment order", () => {
    const mapData = adapter.adapt(prtsData, "a001_01");

    expect(mapData.deploymentOrder).toBeDefined();
    expect(mapData.deploymentOrder!.length).toBeGreaterThan(0);
    const first = mapData.deploymentOrder![0];
    expect(first.role).toBeDefined();
    expect(first.priority).toBeGreaterThan(0);
  });
});

describe("Full pipeline with real PRTS data", () => {
  let mapData: MapData;

  beforeAll(async () => {
    const cacheDir = path.resolve(__dirname, "..", "cache", "levels");
    const loader = new PRTSMapLoader(cacheDir);
    await loader.loadEnemyDatabase();
    const adapter = new PRTSMapAdapter(loader);
    const prtsData = loadLevelData();
    mapData = adapter.adapt(prtsData, "a001_01");
  });

  it("should analyze battle and produce valid analysis", () => {
    const analysis = analyzeBattle(mapData);

    expect(analysis.summary).toBeDefined();
    expect(analysis.enemyComposition.totalCount).toBeGreaterThan(0);
    expect(analysis.requirements.difficultyRating).toBeDefined();
    expect(analysis.suggestedStrategy.name).toBeDefined();
  });

  it("should generate a script from analysis", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);

    expect(script.stage_name).toBe("a001_01");
    expect(script.actions.length).toBeGreaterThan(0);
    expect(script.groups.length).toBeGreaterThan(0);

    // Should include SpeedUp and SkillDaemon
    expect(script.actions.some(a => a.type === "SpeedUp")).toBe(true);
    expect(script.actions.some(a => a.type === "SkillDaemon")).toBe(true);
  });

  it("should validate script and pass", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    const result = validateScript(script, mapData);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("should export valid copilot JSON", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);

    expect(parsed.stage_name).toBe("a001_01");
    expect(parsed.version).toBe(3);
    expect(Array.isArray(parsed.actions)).toBe(true);
    expect(Array.isArray(parsed.groups)).toBe(true);
  });

  it("should flag INVALID_ACTION_TYPE for bad action", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    script.actions.push({ type: "BadAction" } as any);
    const result = validateScript(script, mapData);
    expect(result.errors.some(e => e.code === "INVALID_ACTION_TYPE")).toBe(true);
  });

  it("should flag LOCATION_OUT_OF_BOUNDS for out-of-range coords", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    script.actions.push({ type: "Deploy", name: "test", location: [999, 999], direction: "Right" } as any);
    const result = validateScript(script, mapData);
    expect(result.errors.some(e => e.code === "LOCATION_OUT_OF_BOUNDS")).toBe(true);
  });

  it("should warn LOCATION_NOT_DEPLOYABLE for non-deployable tile", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    const tiles = mapData.tiles;
    let nonDeployRow = -1, nonDeployCol = -1;
    for (let r = 0; r < tiles.length && nonDeployRow < 0; r++) {
      for (let c = 0; c < tiles[r].length && nonDeployCol < 0; c++) {
        if (tiles[r][c].buildableType === "none") {
          nonDeployRow = r; nonDeployCol = c;
        }
      }
    }
    if (nonDeployRow >= 0) {
      script.actions.push({ type: "Deploy", name: "test", location: [nonDeployRow, nonDeployCol], direction: "Right" } as any);
      const result = validateScript(script, mapData);
      expect(result.warnings.some(w => w.code === "LOCATION_NOT_DEPLOYABLE")).toBe(true);
    }
  });

  it("should not error OOB when mapData has no tiles", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    script.actions.push({ type: "Deploy", name: "test", location: [999, 999], direction: "Right" } as any);
    const result = validateScript(script, { ...mapData, tiles: undefined as any });
    expect(result.errors.filter(e => e.code === "LOCATION_OUT_OF_BOUNDS").length).toBe(0);
  });

  it("should flag OOB for negative row coordinate", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    script.actions.push({ type: "Deploy", name: "test", location: [-1, 0], direction: "Right" } as any);
    const result = validateScript(script, mapData);
    expect(result.errors.some(e => e.code === "LOCATION_OUT_OF_BOUNDS")).toBe(true);
  });

  it("should flag OOB for negative column coordinate", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    script.actions.push({ type: "Deploy", name: "test", location: [0, -1], direction: "Right" } as any);
    const result = validateScript(script, mapData);
    expect(result.errors.some(e => e.code === "LOCATION_OUT_OF_BOUNDS")).toBe(true);
  });

  it("should end-to-end: adapt → analyze → generate → validate → export", () => {
    const analysis = analyzeBattle(mapData);
    const script = generateScript("a001_01", mapData, analysis);
    const validation = validateScript(script, mapData);
    const json = exportToCopilotFormat(script);

    expect(validation.valid).toBe(true);
    expect(validation.score).toBeGreaterThanOrEqual(60);
    const parsed = JSON.parse(json);
    expect(parsed.actions.length).toBeGreaterThan(0);
  });
});
