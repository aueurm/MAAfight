import { countActiveRoutes } from "../src/index";
import type { PRTSLevelData } from "../src/types";

describe("CLI info helpers", () => {
  it("should count active routes while ignoring null and inactive routes", () => {
    const prtsData = {
      routes: [
        null,
        { motionMode: "WALK", checkpoints: [{ type: "MOVE" }] },
        { motionMode: "FLY", checkpoints: [{ type: "MOVE" }] },
        { motionMode: "WALK", checkpoints: [] },
        { motionMode: "E_NUM", checkpoints: [{ type: "MOVE" }] },
        { motionMode: 0, checkpoints: [{ type: 0 }] },
        { motionMode: 1, checkpoints: [{ type: 0 }] },
        { motionMode: 2, checkpoints: [{ type: 0 }] },
      ],
    } as unknown as PRTSLevelData;

    expect(countActiveRoutes(prtsData)).toBe(4);
  });
});
