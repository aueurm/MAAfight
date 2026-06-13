import { validateMAAProtocol } from "../src/battle/MAAProtocolValidator";
import type { BattleScript } from "../src/types";

function makeScript(overrides: Partial<BattleScript> = {}): BattleScript {
  return {
    stage_name: "a001_01",
    minimum_required: "v4.0.0",
    doc: { title: "test", details: "test" },
    opers: [{ name: "test", skill: 1, skill_usage: 1 }],
    groups: [{ name: "test", opers: [{ name: "test", skill: 1, skill_usage: 1 }] }],
    actions: [
      { type: "SpeedUp" },
      { type: "Deploy", name: "test", location: [1, 1], direction: "Right" },
      { type: "SkillDaemon" },
    ],
    generatedAt: "2026-06-12T00:00:00.000Z",
    metadata: { source: "test" },
    ...overrides,
  };
}

describe("validateMAAProtocol", () => {
  it("should pass standard copilot actions", () => {
    const result = validateMAAProtocol(makeScript());

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.score).toBe(100);
  });

  it("should warn for internal Wait actions", () => {
    const result = validateMAAProtocol(makeScript({
      actions: [{ type: "Wait", time: 5 }],
    }));

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.code === "NON_STANDARD_WAIT")).toBe(true);
  });

  it("should warn for SkillUse alias", () => {
    const result = validateMAAProtocol(makeScript({
      actions: [{ type: "SkillUse", name: "test", skill: 1 }],
    }));

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.code === "SKILLUSE_ALIAS")).toBe(true);
  });

  it("should fail unknown action types", () => {
    const result = validateMAAProtocol(makeScript({
      actions: [{ type: "BadAction" }],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("MAA_INVALID_ACTION_TYPE");
  });

  it("should warn that requirements are informational", () => {
    const requirements = { elite: 2, level: 90, skill_level: 7, module: 0, potential: 1 };
    const result = validateMAAProtocol(makeScript({
      opers: [{ name: "test", skill: 1, skill_usage: 1, requirements }],
    }));

    expect(result.warnings.some(w => w.code === "REQUIREMENTS_RESERVED")).toBe(true);
  });

  it("should warn when time_elapsed has no ResetStopwatch", () => {
    const result = validateMAAProtocol(makeScript({
      actions: [{ type: "Deploy", name: "test", location: [1, 1], direction: "Right", time_elapsed: 10 }],
    }));

    expect(result.warnings.some(w => w.code === "TIME_ELAPSED_WITHOUT_RESET")).toBe(true);
  });

  it("should allow time_elapsed after ResetStopwatch", () => {
    const result = validateMAAProtocol(makeScript({
      actions: [
        { type: "ResetStopwatch" },
        { type: "Deploy", name: "test", location: [1, 1], direction: "Right", time_elapsed: 10 },
      ],
    }));

    expect(result.warnings.some(w => w.code === "TIME_ELAPSED_WITHOUT_RESET")).toBe(false);
  });

  it("should warn when MoveCamera has no delay", () => {
    const result = validateMAAProtocol(makeScript({
      actions: [{ type: "MoveCamera" }, { type: "Deploy", name: "test", location: [1, 1], direction: "Right" }],
    }));

    expect(result.warnings.some(w => w.code === "MOVE_CAMERA_WITHOUT_DELAY")).toBe(true);
  });

  it("should allow MoveCamera followed by post_delay", () => {
    const result = validateMAAProtocol(makeScript({
      actions: [{ type: "MoveCamera", post_delay: 1000 }, { type: "Deploy", name: "test", location: [1, 1], direction: "Right" }],
    }));

    expect(result.warnings.some(w => w.code === "MOVE_CAMERA_WITHOUT_DELAY")).toBe(false);
  });
});
