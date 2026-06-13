import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfiguredOperatorBox, saveOperatorConfig } from "../src/player/PlayerConfig";
import { OPERATOR_POOLS } from "../src/shared/operatorDB";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maafight-config-"));
}

describe("PlayerConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should save owned-only operators and config under .maafight", () => {
    tmpDir = makeTmpDir();
    const ownedName = OPERATOR_POOLS.vanguard[0].name;
    const unownedName = OPERATOR_POOLS.sniper[0].name;
    const raw = JSON.stringify([
      { id: "owned", name: ownedName, rarity: 6, own: true, elite: 2, level: 90, potential: 1 },
      { id: "unowned", name: unownedName, rarity: 6, own: false, elite: 2, level: 90, potential: 1 },
    ]);

    const saved = saveOperatorConfig(raw, tmpDir);

    expect(saved.box.size).toBe(1);
    expect(fs.existsSync(saved.configPath)).toBe(true);
    expect(fs.existsSync(saved.operatorsPath)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(saved.operatorsPath, "utf-8"));
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe(ownedName);

    const config = JSON.parse(fs.readFileSync(saved.configPath, "utf-8"));
    expect(config.operatorsPath).toBe("operators.json");
  });

  it("should load configured operator box from .maafight/config.json", () => {
    tmpDir = makeTmpDir();
    const ownedName = OPERATOR_POOLS.medic[0].name;
    saveOperatorConfig(JSON.stringify([
      { id: "medic", name: ownedName, rarity: 6, own: true, elite: 2, level: 80, potential: 2 },
    ]), tmpDir);

    const loaded = loadConfiguredOperatorBox(tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.box.size).toBe(1);
    expect(loaded!.box.has(ownedName)).toBe(true);
  });

  it("should return null when local config is absent", () => {
    tmpDir = makeTmpDir();
    expect(loadConfiguredOperatorBox(tmpDir)).toBeNull();
  });
});
