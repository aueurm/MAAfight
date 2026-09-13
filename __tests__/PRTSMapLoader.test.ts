import fs from "fs";
import os from "os";
import path from "path";
import { DEFAULT_LEVEL_DATA_URL, PRTSMapLoader } from "../src/loader/PRTSMapLoader";
import stageIndex from "../src/data/stage_index.json";

const roots: string[] = [];
function cacheRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-loader-"));
  roots.push(root);
  const levels = path.join(root, "levels");
  fs.mkdirSync(levels);
  return levels;
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("PRTSMapLoader data revisions", () => {
  it("downloads the pinned revision instead of trusting an unmarked old cache", async () => {
    const root = cacheRoot();
    const relativePath = "activities/a001/level_a001_01.json";
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), JSON.stringify({ revision: "old" }));
    const loader = new PRTSMapLoader(root);
    const get = jest.spyOn(loader as any, "httpGet").mockResolvedValue(JSON.stringify({ revision: "current" }));

    await expect(loader.load("GT-1")).resolves.toEqual({ revision: "current" });
    expect(get).toHaveBeenCalledWith(`${DEFAULT_LEVEL_DATA_URL}/levels/${relativePath}`);
    get.mockClear();
    await expect(loader.load("GT-1")).resolves.toEqual({ revision: "current" });
    expect(get).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"))).toEqual({ revision: "old" });
  });

  it("uses a complete snapshot only when its revision matches the generated model", async () => {
    const root = cacheRoot();
    const relativePath = "activities/a001/level_a001_01.json";
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), JSON.stringify({ revision: "snapshot" }));
    fs.writeFileSync(path.join(root, ".maafight-source.json"), JSON.stringify(stageIndex.source));
    const loader = new PRTSMapLoader(root);
    const get = jest.spyOn(loader as any, "httpGet");

    await expect(loader.load("GT-1")).resolves.toEqual({ revision: "snapshot" });
    expect(get).not.toHaveBeenCalled();
  });

  it("preserves an explicit PRTS-compatible endpoint", async () => {
    const loader = new PRTSMapLoader(cacheRoot(), "https://data.example.test/");
    const get = jest.spyOn(loader as any, "httpGet").mockResolvedValue("{}");
    await loader.load("GT-1");
    expect(get).toHaveBeenCalledWith("https://data.example.test/data/levels/activities/a001/level_a001_01.json");
  });

  it("isolates custom endpoints from the pinned snapshot and each other", async () => {
    const root = cacheRoot();
    const levelPath = path.join(root, "activities/a001/level_a001_01.json");
    const enemyPath = path.join(root, "..", "enemy_database.json");
    fs.mkdirSync(path.dirname(levelPath), { recursive: true });
    fs.writeFileSync(levelPath, JSON.stringify({ revision: "pinned" }));
    fs.writeFileSync(enemyPath, JSON.stringify({ enemies: [], revision: "pinned" }));
    fs.writeFileSync(path.join(root, ".maafight-source.json"), JSON.stringify(stageIndex.source));
    const custom = new PRTSMapLoader(root, "https://data.example.test");
    const get = jest.spyOn(custom as any, "httpGet").mockResolvedValue(JSON.stringify({ enemies: [], revision: "custom" }));

    expect((await custom.load("GT-1") as any).revision).toBe("custom");
    await custom.loadEnemyDatabase();
    expect(get).toHaveBeenCalledWith("https://data.example.test/data/levels/enemydata/enemy_database.json");
    get.mockClear();
    expect((await custom.load("GT-1") as any).revision).toBe("custom");
    await custom.loadEnemyDatabase();
    expect(get).not.toHaveBeenCalled();
    await custom.load("GT-1", { noCache: true });
    await custom.loadEnemyDatabase({ noCache: true });
    expect(JSON.parse(fs.readFileSync(levelPath, "utf8")).revision).toBe("pinned");
    expect(JSON.parse(fs.readFileSync(enemyPath, "utf8")).revision).toBe("pinned");

    const other = new PRTSMapLoader(root, "https://other.example.test");
    const otherGet = jest.spyOn(other as any, "httpGet").mockResolvedValue(JSON.stringify({ revision: "other" }));
    expect((await other.load("GT-1") as any).revision).toBe("other");
    expect(otherGet).toHaveBeenCalledTimes(1);
    expect((await new PRTSMapLoader(root).load("GT-1") as any).revision).toBe("pinned");
  });

  it("explains when upstream metadata exists without the corresponding level", async () => {
    const loader = new PRTSMapLoader(cacheRoot());
    const get = jest.spyOn(loader as any, "httpGet");
    await expect(loader.load("SW-EV-1")).rejects.toThrow("未提供关卡文件 activities/act4d0/level_act4d0_01.json");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("PRTSMapLoader enemy variants", () => {
  it("uses the requested level and inherits omitted fields from level zero", async () => {
    const defined = <T>(value: T) => ({ m_defined: true, m_value: value });
    const absent = <T>(value: T) => ({ m_defined: false, m_value: value });
    const root = cacheRoot();
    const common = { name: absent(""), description: absent(""), prefabKey: absent("") };
    fs.writeFileSync(path.join(root, "..", "enemy_database.json"), JSON.stringify({ enemies: [{
      Key: "enemy", Value: [
        { level: 0, enemyData: { ...common, name: defined("基础敌人"), levelType: defined("ELITE"),
          attributes: { maxHp: defined(1000), atk: defined(100), def: defined(200) } } },
        { level: 1, enemyData: { ...common, attributes: { maxHp: defined(2000), def: defined(500) } } },
        { level: 2, enemyData: { ...common, attributes: { atk: defined(300), maxHp: absent(0) } } },
      ],
    }] }));
    fs.writeFileSync(path.join(root, ".maafight-source.json"), JSON.stringify(stageIndex.source));
    const loader = new PRTSMapLoader(root);
    await loader.loadEnemyDatabase();
    expect(loader.getEnemyInfo("enemy", 1)).toMatchObject({
      name: "基础敌人", levelType: "ELITE", attributes: { maxHp: 2000, atk: 100, def: 500 },
    });
    expect(loader.getEnemyInfo("enemy", 2)?.attributes).toMatchObject({ maxHp: 1000, atk: 300, def: 200 });
    expect(() => loader.getEnemyInfo("enemy", 3)).toThrow("level 3 is missing");
  });
});
