import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

describe("operator combat model builder", () => {
  it("builds phase-aware operator data from a pinned snapshot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-model-"));
    const output = path.join(root, "operatorCombat.json");
    fs.writeFileSync(path.join(root, "character_table.json"), JSON.stringify({
      char_test: {
        name: "测试干员",
        profession: "WARRIOR",
        rarity: 5,
        phases: [{
          maxLevel: 50,
          rangeId: "1-1",
          attributesKeyFrames: [
            { level: 1, data: { maxHp: 1000, atk: 300, def: 200, magicResistance: 0, baseAttackTime: 1.2, blockCnt: 2 } },
            { level: 50, data: { maxHp: 2000, atk: 600, def: 400, magicResistance: 10, baseAttackTime: 1.2, blockCnt: 2 } },
          ],
        }],
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, "..", "scripts", "build-operator-combat-model.js"),
      "--game-data", root,
      "--output", output,
      "--commit", "fixture-commit",
    ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });

    expect(result.status).toBe(0);
    const model = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(model.source.commit).toBe("fixture-commit");
    expect(model.source.characterTableHash).toMatch(/^[a-f0-9]{16}$/);
    expect(model.operators["测试干员"].phases[0]).toMatchObject({
      elite: 0,
      minLevel: 1,
      maxLevel: 50,
      min: { hp: 1000, atk: 300, def: 200, res: 0 },
      hp: 2000,
      atk: 600,
      def: 400,
      res: 10,
    });
  });
});
