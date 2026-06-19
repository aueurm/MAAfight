import { resolveStage, searchStages, listByCategory, listStages } from "../src/loader/levelIndex";

describe("levelIndex", () => {
  it("resolveStage returns entry for known stage", () => {
    const entry = resolveStage("a001_01");
    expect(entry).not.toBeNull();
    expect(entry!.stageId).toBe("a001_01");
    expect(entry!.category).toBe("activity");
    expect(entry!.code).toBe("GT-1");
  });

  it("resolveStage returns the same entry by visible game code", () => {
    const entry = resolveStage("GT-1");
    expect(entry).not.toBeNull();
    expect(entry!.stageId).toBe("a001_01");
    expect(entry!.code).toBe("GT-1");
  });

  it.each([
    ["bossrush1_01", "TN-1"],
    ["act3d0_03", "OF-3"],
    ["weekly_fly_3", "CA-3"],
    ["weekly_toxic_5", "AP-5"],
  ])("resolves the official code for cached level id %s", (stageId, code) => {
    const entry = resolveStage(stageId);
    expect(entry).not.toBeNull();
    expect(entry!.stageId).toBe(stageId);
    expect(entry!.code).toBe(code);
  });

  it("includes the official code when searching by a cached level id", () => {
    const result = searchStages("bossrush1_01").find(entry => entry.stageId === "bossrush1_01");
    expect(result?.code).toBe("TN-1");
  });

  it("resolveStage returns null for unknown stage", () => {
    expect(resolveStage("nonexistent_zz99")).toBeNull();
  });

  it("searchStages finds by stageId", () => {
    const results = searchStages("CE");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r =>
      r.stageId.toUpperCase().includes("CE") ||
      r.filePath.toUpperCase().includes("CE") ||
      (r.code && r.code.toUpperCase().includes("CE")) ||
      (r.name && r.name.toUpperCase().includes("CE"))
    )).toBe(true);
  });

  it("searchStages is case insensitive", () => {
    const lower = searchStages("ce");
    const upper = searchStages("CE");
    expect(lower.length).toBe(upper.length);
  });

  it("listByCategory filters correctly", () => {
    const main = listByCategory("main");
    expect(main.length).toBeGreaterThan(0);
    expect(main.every(e => e.category === "main")).toBe(true);
  });

  it("listStages returns full index", () => {
    const all = listStages();
    expect(all.length).toBeGreaterThan(1000);
  });
});
