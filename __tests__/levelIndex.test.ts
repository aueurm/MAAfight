import { resolveStage, searchStages, listByCategory, listStages } from "../src/loader/levelIndex";

describe("levelIndex", () => {
  it("resolveStage returns entry for known stage", () => {
    const entry = resolveStage("a001_01");
    expect(entry).not.toBeNull();
    expect(entry!.stageId).toBe("a001_01");
    expect(entry!.category).toBe("activity");
  });

  it("resolveStage returns null for unknown stage", () => {
    expect(resolveStage("nonexistent_zz99")).toBeNull();
  });

  it("searchStages finds by stageId", () => {
    const results = searchStages("CE");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.stageId.toUpperCase().includes("CE") || r.filePath.toUpperCase().includes("CE"))).toBe(true);
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
