import * as fs from "fs";
import * as path from "path";
import { PRTSMapLoader } from "../src/loader/PRTSMapLoader";
import { PRTSMapAdapter } from "../src/adapter/PRTSMapAdapter";
import { extractStageFacts } from "../src/engine";
import type { PRTSLevelData } from "../src/types";

const cacheDir = path.resolve(__dirname, "..", "cache", "levels");

function loadLevel(relativePath = "activities/a001/level_a001_01.json"): PRTSLevelData {
  return JSON.parse(fs.readFileSync(path.join(cacheDir, relativePath), "utf8"));
}

function groupFixture(): PRTSLevelData {
  const data = loadLevel();
  const source = data.waves[0].fragments[0].actions[0];
  data.runes = [];
  data.routes = data.routes.slice(0, 3);
  data.routes[0] = {
    ...data.routes[0]!, motionMode: "FLY", checkpoints: [],
    startPosition: { row: 0, col: 9 }, endPosition: { row: 0, col: 8 },
  };
  data.waves = [{
    preDelay: 1, postDelay: 0, maxTimeWaitingForNextWave: -1,
    fragments: [
      { preDelay: 3, actions: [
        { ...source, key: "enemy_hidden_fixture", hiddenGroup: "extra", routeIndex: 0, preDelay: 20, count: 2, interval: 2 },
        { ...source, hiddenGroup: null, routeIndex: 1, preDelay: 2, count: 1, interval: 1 },
      ] },
      { preDelay: 5, actions: [{ ...source, hiddenGroup: "", routeIndex: 1, preDelay: 1, count: 1, interval: 1 }] },
    ],
  }];
  return data;
}

describe("PRTSMapAdapter default hidden groups", () => {
  let adapter: PRTSMapAdapter;

  beforeAll(async () => {
    const loader = new PRTSMapLoader(cacheDir);
    await loader.loadEnemyDatabase();
    adapter = new PRTSMapAdapter(loader);
  });

  it("omits grouped spawns without an enabled set while retaining their raw schedule span", () => {
    const data = groupFixture();
    const original = JSON.stringify(data);
    const map = adapter.adapt(data, "groups-default");
    const facts = extractStageFacts(map);

    expect(map.spawnTimeline.map(spawn => spawn.time)).toEqual([6, 32]);
    expect(map.waves[0].fragments[0].enemySpawns).toHaveLength(1);
    expect(map.waves[0].fragments[0].spawnScheduleDuration).toBe(22);
    expect(map.enemyDetails.map(enemy => enemy.id)).not.toContain("enemy_hidden_fixture");
    expect(map.highThreatAreas).toEqual([{
      row: 3, col: 8, enemyTypes: [data.waves[0].fragments[0].actions[1].key],
      spawnCount: 2, firstSpawnTime: 6,
    }]);
    expect(map.routes.map(route => route.id)).toEqual([1, 2]);
    expect(map.strategicPoints).not.toContainEqual(expect.objectContaining({ type: "start", row: 6, col: 9 }));
    expect(facts.enemyCount).toBe(2);
    expect(facts.flyingRouteCount).toBe(0);
    expect(facts.routeCells).not.toContainEqual({ row: 6, col: 9 });
    expect(JSON.stringify(data)).toBe(original);
  });

  it.each(["NORMAL", "ALL", 1, 3])("applies the raw level's %s enable rune", difficultyMask => {
    const data = groupFixture();
    data.runes = [{ key: "level_hidden_group_enable", difficultyMask, blackboard: [{ key: "key", valueStr: "extra" }] }];
    const map = adapter.adapt(data, "groups-enabled");
    expect(map.spawnTimeline.map(spawn => spawn.time)).toEqual([6, 24, 26, 32]);
    expect(map.enemyDetails.map(enemy => enemy.id)).toContain("enemy_hidden_fixture");
    expect(map.routes.map(route => route.id)).toEqual([0, 1, 2]);
  });

  it.each(["NONE", "FOUR_STAR", 0, 2])("does not apply the %s enable rune to the default configuration", difficultyMask => {
    const data = groupFixture();
    data.runes = [{ key: "level_hidden_group_enable", difficultyMask, blackboard: [{ valueStr: "extra" }] }];
    expect(adapter.adapt(data, "groups-inactive-rune").spawnTimeline).toHaveLength(2);
  });

  it("retains a route shared by disabled and active spawns without renumbering it", () => {
    const data = groupFixture();
    data.waves[0].fragments[0].actions[1].routeIndex = 0;
    const map = adapter.adapt(data, "groups-shared-route");
    expect(map.routes.map(route => route.id)).toEqual([0, 1, 2]);
    expect(map.highThreatAreas.find(area => area.row === 6 && area.col === 9)?.spawnCount).toBe(1);
  });

  it("matches the crisis default's 30 enemies instead of all 46 optional enemies", () => {
    const data = loadLevel("obt/crisis/v2/level_crisis_v2_01-01.json");
    const actions = data.waves.flatMap(wave => wave.fragments.flatMap(fragment => fragment.actions))
      .filter(action => action.actionType === "SPAWN" || action.actionType === 0);
    expect(actions.reduce((count, action) => count + action.count, 0)).toBe(46);
    const expected = actions.filter(action => !action.hiddenGroup || action.hiddenGroup === "noduskls");
    const map = adapter.adapt(data, "crisis_v2_01-01");
    const facts = extractStageFacts(map);

    expect(map.spawnTimeline).toHaveLength(30);
    expect(map.waves.flatMap(wave => wave.fragments.flatMap(fragment => fragment.enemySpawns))
      .reduce((count, action) => count + action.count, 0)).toBe(30);
    expect(new Set(map.enemyDetails.map(enemy => enemy.id))).toEqual(new Set(expected.map(action => action.key)));
    expect(new Set(map.routes.map(route => route.id))).toEqual(new Set(expected.map(action => action.routeIndex)));
    expect(map.highThreatAreas.reduce((count, area) => count + area.spawnCount, 0)).toBe(30);
    expect(facts.enemyCount).toBe(30);
    expect(facts.flyingRouteCount).toBe(0);
    expect(facts.pressureWindows.every(window => window.flyingCount === 0)).toBe(true);
  });

  it("keeps an ordinary ungrouped level's 42 enemies and routes", () => {
    const data = loadLevel();
    const map = adapter.adapt(data, "a001_01");
    expect(map.spawnTimeline).toHaveLength(42);
    // The raw fixture has 22 entries; two inactive E_NUM routes were already excluded.
    expect(map.routes).toHaveLength(20);
    expect(map.highThreatAreas.reduce((count, area) => count + area.spawnCount, 0)).toBe(42);
    expect(extractStageFacts(map).enemyCount).toBe(42);
  });

  it.each(["EASY", "SIX_STAR", 7, undefined])("rejects the unmodeled difficulty mask %s", difficultyMask => {
    const data = groupFixture();
    data.runes = [{ key: "level_hidden_group_enable", difficultyMask, blackboard: [{ valueStr: "extra" }] }];
    expect(() => adapter.adapt(data, "groups-unknown-mask")).toThrow("Unsupported hidden-group difficultyMask");
  });

  it("rejects an applicable hidden-group disable rule instead of guessing precedence", () => {
    const data = groupFixture();
    data.runes = [{ key: "level_hidden_group_disable", difficultyMask: "ALL", blackboard: [{ valueStr: "extra" }] }];
    expect(() => adapter.adapt(data, "groups-disable")).toThrow("Unsupported default hidden-group rune: level_hidden_group_disable");
    data.runes[0].difficultyMask = "FOUR_STAR";
    expect(adapter.adapt(data, "groups-inactive-disable").spawnTimeline).toHaveLength(2);
  });

  it.each([undefined, null, [{}], [{ valueStr: null }], [{ valueStr: " " }]])("rejects malformed enable data %s", blackboard => {
    const data = groupFixture();
    data.runes = [{ key: "level_hidden_group_enable", difficultyMask: "ALL", blackboard }];
    expect(() => adapter.adapt(data, "groups-invalid-enable")).toThrow("Invalid level_hidden_group_enable blackboard");
  });

  it("rejects a non-string hiddenGroup instead of silently dropping its enemies", () => {
    const data = groupFixture();
    data.waves[0].fragments[0].actions[0].hiddenGroup = 3 as any;
    expect(() => adapter.adapt(data, "groups-invalid-action")).toThrow("Invalid spawn hiddenGroup");
  });
});
