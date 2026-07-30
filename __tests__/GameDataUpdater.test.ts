import fs from "fs";
import os from "os";
import path from "path";

const { buildStageIndex, collectLevelPaths, validateSnapshot } = require("../scripts/update-game-data");

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("game data updater", () => {
  it("indexes existing level files in stable order and rejects incomplete snapshots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-game-data-update-"));
    temporaryRoots.push(root);
    const levelsRoot = path.join(root, "levels");
    const mainLevel = path.join(levelsRoot, "obt", "main", "level_main_01-01.json");
    const activityLevel = path.join(levelsRoot, "activities", "a001", "level_a001_01.json");
    const enemyDatabasePath = path.join(root, "enemy_database.json");
    const operatorModelPath = path.join(root, "operatorCombat.v2.json");
    const operatorKnowledgeModelPath = path.join(root, "operatorKnowledge.generated.v1.json");
    fs.mkdirSync(path.dirname(mainLevel), { recursive: true });
    fs.mkdirSync(path.dirname(activityLevel), { recursive: true });
    fs.writeFileSync(mainLevel, "{}", "utf8");
    fs.writeFileSync(activityLevel, "{}", "utf8");
    fs.writeFileSync(enemyDatabasePath, "{}", "utf8");
    fs.writeFileSync(operatorModelPath, JSON.stringify({ source: { commit: "a".repeat(40) }, operators: { test: {} } }), "utf8");
    fs.writeFileSync(operatorKnowledgeModelPath, JSON.stringify({
      source: { commit: "a".repeat(40), operatorCount: 1 }, operators: [{ id: "test", name: "测试" }],
    }), "utf8");

    const levelPaths = collectLevelPaths(levelsRoot);
    const stageIndex = buildStageIndex({
      stages: {
        main_01_01: { stageId: "main_01_01", code: "1-1", name: "主线", levelId: "Obt/Main/level_main_01-01" },
        activity_01: { stageId: "activity_01", code: "GT-1", name: "活动", levelId: "activities-a001-level_a001_01" },
        missing: { stageId: "missing", code: "NO-1", name: "缺失", levelId: "Obt/Main/level_missing" },
      },
    }, levelPaths);

    expect(levelPaths).toEqual([
      "activities/a001/level_a001_01.json",
      "obt/main/level_main_01-01.json",
    ]);
    expect(stageIndex).toMatchObject({
      byCode: { "1-1": "main_01_01", "GT-1": "activity_01" },
      count: 2,
    });
    expect(stageIndex.byStageId.missing).toBeUndefined();
    expect(() => validateSnapshot({
      levelsRoot,
      levelPaths,
      stageIndex,
      enemyDatabasePath,
      operatorModelPath,
      operatorKnowledgeModelPath,
      commit: "a".repeat(40),
    })).not.toThrow();

    fs.rmSync(enemyDatabasePath);
    expect(() => validateSnapshot({
      levelsRoot,
      levelPaths,
      stageIndex,
      enemyDatabasePath,
      operatorModelPath,
      operatorKnowledgeModelPath,
      commit: "a".repeat(40),
    })).toThrow("Enemy database is missing");
  });
});
