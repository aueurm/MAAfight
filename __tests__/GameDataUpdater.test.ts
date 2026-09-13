import fs from "fs";
import os from "os";
import path from "path";

const { buildStageIndex, collectLevelPaths, replaceAll, validateSnapshot } = require("../scripts/update-game-data");

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
    }, levelPaths, "a".repeat(40));

    expect(levelPaths).toEqual([
      "activities/a001/level_a001_01.json",
      "obt/main/level_main_01-01.json",
    ]);
    expect(stageIndex).toMatchObject({
      byCode: { "1-1": "main_01_01", "GT-1": "activity_01" },
      count: 2,
    });
    expect(stageIndex.byStageId.missing).toBeUndefined();
    expect(stageIndex.unavailable.missing.code).toBe("NO-1");
    expect(stageIndex.source.commit).toBe("a".repeat(40));
    expect(() => validateSnapshot({
      levelsRoot,
      levelPaths,
      stageIndex,
      enemyDatabasePath,
      operatorModelPath,
      operatorKnowledgeModelPath,
      commit: "a".repeat(40),
    })).not.toThrow();

    expect(() => validateSnapshot({
      levelsRoot, levelPaths, stageIndex: { ...stageIndex, source: { commit: "b".repeat(40) } },
      enemyDatabasePath, operatorModelPath, operatorKnowledgeModelPath, commit: "a".repeat(40),
    })).toThrow("Stage index commit does not match");

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

  it("restores all previous files when installing a snapshot fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-game-data-rollback-"));
    temporaryRoots.push(root);
    const first = path.join(root, "first.json");
    const second = path.join(root, "second.json");
    const staged = path.join(root, "staged.json");
    fs.writeFileSync(first, "previous first");
    fs.writeFileSync(second, "previous second");
    fs.writeFileSync(staged, "replacement");
    expect(() => replaceAll([
      { staged, target: first },
      { staged: path.join(root, "missing.json"), target: second },
    ])).toThrow();
    expect(fs.readFileSync(first, "utf8")).toBe("previous first");
    expect(fs.readFileSync(second, "utf8")).toBe("previous second");
    expect(fs.readdirSync(root).some(file => file.includes("backup"))).toBe(false);
  });

  it("preserves the installed file and stale backup when a backup already exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-game-data-stale-"));
    temporaryRoots.push(root);
    const target = path.join(root, "target.json");
    const staged = path.join(root, "staged.json");
    const backup = `${target}.maafight-update-backup-${process.pid}-0`;
    fs.writeFileSync(target, "installed");
    fs.writeFileSync(staged, "replacement");
    fs.writeFileSync(backup, "stale backup");
    expect(() => replaceAll([{ staged, target }])).toThrow("Stale update backup exists");
    expect(fs.readFileSync(target, "utf8")).toBe("installed");
    expect(fs.readFileSync(backup, "utf8")).toBe("stale backup");
  });
});
