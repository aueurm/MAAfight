import * as path from "path";
import { loadStageContext } from "../src/core/pipeline";

const LEVEL_PATH = path.resolve(__dirname, "..", "cache", "levels", "activities", "a001", "level_a001_01.json");

describe("stage pipeline", () => {
  it("loads a local stage without requiring the enemy database", async () => {
    const context = await loadStageContext({ dataPath: LEVEL_PATH, includeEnemyData: false });

    expect(context.prtsData.mapData.map).not.toHaveLength(0);
    expect(context.mapData.stageId).toBe(context.stageId);
    expect(context.facts.stageId).toBe(context.stageId);
  });
});
