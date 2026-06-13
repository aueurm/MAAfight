import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { OperatorBox } from "../src/player/OperatorBox";
import { OPERATOR_POOLS } from "../src/shared/operatorDB";

const sampleData = [
  { id: "char_002_amiya", name: "阿米娅", rarity: 5, own: true, elite: 2, level: 80, potential: 5 },
  { id: "char_2024_chyue", name: "重岳", rarity: 6, own: true, elite: 2, level: 90, potential: 3 },
  { id: "char_009_12fce", name: "12F", rarity: 2, own: false },
  { id: "char_103_angel", name: "能天使", rarity: 6, own: true, elite: 2, level: 60, potential: 1 },
  { id: "char_500", name: "黑", rarity: 6, own: true, elite: 0, level: 1, potential: 0 },
];

let tmpFile: string;

beforeAll(() => {
  tmpFile = path.join(os.tmpdir(), "maa_operbox_test.json");
  fs.writeFileSync(tmpFile, JSON.stringify(sampleData));
});

afterAll(() => {
  fs.unlinkSync(tmpFile);
});

describe("OperatorBox", () => {
  it("should load only owned operators", () => {
    const box = new OperatorBox(tmpFile);
    expect(box.size).toBe(4);
  });

  it("has() returns true for owned, false for unowned", () => {
    const box = new OperatorBox(tmpFile);
    expect(box.has("能天使")).toBe(true);
    expect(box.has("12F")).toBe(false);
  });

  it("get() returns full info for owned operator", () => {
    const box = new OperatorBox(tmpFile);
    const op = box.get("阿米娅");
    expect(op).toBeDefined();
    expect(op!.elite).toBe(2);
    expect(op!.level).toBe(80);
    expect(op!.potential).toBe(5);
  });

  it("get() returns undefined for unowned operator", () => {
    const box = new OperatorBox(tmpFile);
    expect(box.get("12F")).toBeUndefined();
  });

  it("priority() ranks higher rarity+elite+level higher", () => {
    const box = new OperatorBox(tmpFile);
    const amiyaPrio = box.priority("阿米娅");
    const chongyuePrio = box.priority("重岳");
    const heiPrio = box.priority("黑");
    expect(chongyuePrio).toBeGreaterThan(amiyaPrio);
    expect(amiyaPrio).toBeGreaterThan(heiPrio);
  });

  it("sortedNames() returns names in descending priority", () => {
    const box = new OperatorBox(tmpFile);
    const names = box.sortedNames();
    expect(names[0]).toBe("重岳");
    expect(names[1]).toBe("能天使");
  });

  it("should handle empty file (no owned operators)", () => {
    const emptyFile = path.join(os.tmpdir(), "maa_empty_test.json");
    fs.writeFileSync(emptyFile, JSON.stringify([
      { id: "x", name: "x", rarity: 1, own: false },
    ]));
    const box = new OperatorBox(emptyFile);
    expect(box.size).toBe(0);
    fs.unlinkSync(emptyFile);
  });

  it("parseJson() should normalize owned operators with missing training fields", () => {
    const name = OPERATOR_POOLS.vanguard[0].name;
    const parsed = OperatorBox.parseJson(JSON.stringify([
      { id: "x", name, rarity: 6, own: true },
    ]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      id: "x",
      name,
      rarity: 6,
      own: true,
      elite: 0,
      level: 0,
      potential: 0,
    });
  });

  it("roleCounts() should count owned operators by role pool membership", () => {
    const vanguard = OPERATOR_POOLS.vanguard[0].name;
    const medic = OPERATOR_POOLS.medic[0].name;
    const box = OperatorBox.fromOperators([
      { id: "v", name: vanguard, rarity: 6, own: true, elite: 2, level: 90, potential: 1 },
      { id: "m", name: medic, rarity: 5, own: true, elite: 1, level: 70, potential: 2 },
      { id: "unknown", name: "not-in-pool", rarity: 6, own: true, elite: 2, level: 90, potential: 1 },
    ]);

    const roles = box.roleCounts();
    expect(roles.vanguard).toBe(1);
    expect(roles.medic).toBe(1);
    expect(roles.sniper).toBe(0);
    expect(box.highRarityCount()).toBe(3);
  });
});
