import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const COMMIT = "b327f67a1d73fe9a2501f4e159603a30da75911f";

function writeFixture(root: string): void {
  fs.writeFileSync(path.join(root, "character_table.json"), JSON.stringify({
    char_test: {
      name: "测试干员",
      profession: "WARRIOR",
      subProfessionId: "fighter",
      position: "MELEE",
      rarity: "TIER_6",
      phases: [{}, {}, {
        maxLevel: 90,
        rangeId: "test-range",
        attributesKeyFrames: [
          { level: 1, data: { maxHp: 1000, atk: 300, def: 200, magicResistance: 0, cost: 18, baseAttackTime: 1.2, attackSpeed: 100, blockCnt: 2 } },
          { level: 90, data: { maxHp: 2400, atk: 700, def: 450, magicResistance: 10, cost: 20, baseAttackTime: 1.2, attackSpeed: 100, blockCnt: 2 } },
        ],
      }],
      favorKeyFrames: [{ level: 50, data: { maxHp: 100, atk: 50, def: 20, magicResistance: 0 } }],
      skills: [{ skillId: "sk_test", unlockCond: { phase: "PHASE_2", level: 1 } }],
      talents: [{ candidates: [{
        unlockCondition: { phase: "PHASE_2", level: 1 },
        requiredPotentialRank: 0,
        prefabKey: "simple-talent",
        blackboard: [{ key: "atk", value: 0.1 }],
      }] }],
    },
  }), "utf8");
  fs.writeFileSync(path.join(root, "skill_table.json"), JSON.stringify({
    sk_test: {
      skillId: "sk_test",
      levels: Array.from({ length: 10 }, (_, index) => ({
        rangeId: index === 9 ? "skill-range" : null,
        skillType: "MANUAL",
        durationType: "DURATION",
        spData: { spType: "INCREASE_WITH_TIME", spCost: 30, initSp: 10, increment: 1 },
        duration: 20,
        blackboard: [
          { key: "atk", value: 0.5 },
          { key: "attack_speed", value: 50 },
          { key: "max_target", value: 2 },
          { key: "mystery_effect", value: 9 },
        ],
      })),
    },
  }), "utf8");
  fs.writeFileSync(path.join(root, "range_table.json"), JSON.stringify({
    "test-range": { id: "test-range", direction: 1, grids: [{ row: 0, col: 0 }, { row: 0, col: 1 }] },
    "skill-range": { id: "skill-range", direction: 1, grids: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }] },
  }), "utf8");
  fs.writeFileSync(path.join(root, "uniequip_table.json"), JSON.stringify({
    equipDict: {
      uniequip_test: { uniEquipId: "uniequip_test", uniEquipName: "测试模组", charId: "char_test", type: "ADVANCED", charEquipOrder: 1 },
    },
  }), "utf8");
  fs.writeFileSync(path.join(root, "battle_equip_table.json"), JSON.stringify({
    uniequip_test: {
      phases: [{ equipLevel: 1, parts: [], attributeBlackboard: [{ key: "atk", value: 30 }] }],
    },
  }), "utf8");
}

function runBuilder(root: string, output: string, commit = COMMIT) {
  return spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "scripts", "build-operator-combat-model.js"),
    "--game-data", root,
    "--output", output,
    "--commit", commit,
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
}

describe("operator combat model builder", () => {
  it("builds a deterministic five-table v2 model", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-model-"));
    const first = path.join(root, "first.json");
    const second = path.join(root, "second.json");
    writeFixture(root);

    expect(runBuilder(root, first).status).toBe(0);
    expect(runBuilder(root, second).status).toBe(0);
    expect(fs.readFileSync(first, "utf8")).toBe(fs.readFileSync(second, "utf8"));

    const model = JSON.parse(fs.readFileSync(first, "utf8"));
    expect(model.schemaVersion).toBe(2);
    expect(model.source.commit).toBe(COMMIT);
    expect(Object.keys(model.source.tableHashes).sort()).toEqual([
      "battle_equip_table", "character_table", "range_table", "skill_table", "uniequip_table",
    ]);
    expect(model.nameIndex["测试干员"]).toBe("char_test");
    expect(model.operators.char_test).toMatchObject({
      id: "char_test",
      name: "测试干员",
      role: "guard",
      position: "MELEE",
      e2: { minLevel: 1, maxLevel: 90, rangeId: "test-range" },
    });
    expect(model.operators.char_test.skills[0].levels[9]).toMatchObject({
      rank: 10,
      spType: "INCREASE_WITH_TIME",
      spCost: 30,
      initSp: 10,
      duration: 20,
      rangeId: "skill-range",
      maxTargets: 2,
      confidence: "partial",
    });
    expect(model.operators.char_test.skills[0].levels[9].modelCoverageGaps).toContain("unsupported:mystery_effect");
    expect(model.operators.char_test.modules[0]).toMatchObject({ id: "uniequip_test", index: 1 });
    expect(model.ranges["skill-range"]).toEqual([[0, 0], [0, 1], [0, 2]]);
  });

  it("rejects a non-full commit sha", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-model-"));
    writeFixture(root);
    const result = runBuilder(root, path.join(root, "output.json"), "unknown");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full 40-character commit SHA");
  });

  it("fails when any required source table is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-model-"));
    writeFixture(root);
    fs.rmSync(path.join(root, "skill_table.json"));
    const result = runBuilder(root, path.join(root, "output.json"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("skill_table.json not found");
  });
});
