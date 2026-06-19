import { validateScript } from "../src/copilot/ScriptValidator";
import type { BattleScript } from "../src/types";

function makeScript(overrides: Partial<BattleScript> = {}): BattleScript {
  return {
    stage_name: "OF-1",
    minimum_required: "v4.0.0",
    actions: [
      { type: "SpeedUp" },
      { type: "Deploy", name: "推进之王", location: [3, 2], direction: "Right" },
      { type: "SkillDaemon" },
    ],
    doc: { title: "Test", details: "Test" },
    groups: [{ name: "先锋", opers: [{ name: "推进之王", skill: 2, skill_usage: 1 }] }],
    opers: [],
    generatedAt: new Date().toISOString(),
    metadata: { source: "ai" },
    ...overrides,
  };
}

describe("validateScript", () => {
  it("should validate a correct script", () => {
    const result = validateScript(makeScript());
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("should detect missing stage_name", () => {
    const result = validateScript(makeScript({ stage_name: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === "MISSING_STAGE_NAME")).toBe(true);
  });

  it("should detect empty actions", () => {
    const result = validateScript(makeScript({ actions: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === "INVALID_ACTIONS")).toBe(true);
  });

  it("should detect Deploy without operator name", () => {
    const result = validateScript(makeScript({
      actions: [{ type: "Deploy", location: [3, 2] } as BattleScript["actions"][0]],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === "MISSING_OPERATOR_NAME")).toBe(true);
  });

  it("should detect Deploy without location", () => {
    const result = validateScript(makeScript({
      actions: [{ type: "Deploy", name: "银灰" } as BattleScript["actions"][0]],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === "INVALID_LOCATION")).toBe(true);
  });

  it("should warn about missing direction", () => {
    const result = validateScript(makeScript({
      actions: [{ type: "Deploy", name: "银灰", location: [3, 2] } as BattleScript["actions"][0]],
    }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.code === "MISSING_DIRECTION")).toBe(true);
  });

  it("should warn about low deployment count", () => {
    const result = validateScript(makeScript({
      actions: [
        { type: "Deploy", name: "银灰", location: [3, 2], direction: "Right" },
      ],
    }));
    expect(result.warnings.some(w => w.code === "LOW_DEPLOY_COUNT")).toBe(true);
  });

  it("should warn about missing SkillDaemon", () => {
    const result = validateScript(makeScript({
      actions: [
        { type: "Deploy", name: "银灰", location: [3, 2], direction: "Right" },
        { type: "Deploy", name: "闪灵", location: [4, 2], direction: "Right" },
      ],
    }));
    expect(result.warnings.some(w => w.code === "NO_SKILL_DAEMON")).toBe(true);
  });

  it("should warn about unknown operators", () => {
    const result = validateScript(makeScript({
      actions: [
        { type: "SpeedUp" },
        { type: "Deploy", name: "UnknownOperator", location: [3, 2], direction: "Right" },
        { type: "SkillDaemon" },
      ],
    }));
    expect(result.warnings.some(w => w.code === "UNKNOWN_OPERATOR")).toBe(true);
  });

  it("should reduce score for errors", () => {
    const result = validateScript(makeScript({
      stage_name: "",
      actions: [{ type: "Deploy" } as BattleScript["actions"][0]],
    }));
    expect(result.score).toBeLessThan(100);
  });

  it("should give score 100 for a perfect script", () => {
    const result = validateScript(makeScript({
      actions: [
        { type: "SpeedUp" },
        { type: "Deploy", name: "推进之王", location: [3, 2], direction: "Right" },
        { type: "Deploy", name: "闪灵", location: [4, 2], direction: "Right" },
        { type: "Deploy", name: "银灰", location: [5, 2], direction: "Right" },
        { type: "SkillDaemon" },
      ],
    }));
    expect(result.score).toBe(100);
  });

  it("should handle null actions gracefully", () => {
    const script = makeScript({ actions: null as unknown as BattleScript["actions"] });
    const result = validateScript(script);
    expect(result.errors.some(e => e.code === "INVALID_ACTIONS")).toBe(true);
  });

  it("should handle Deploy without mapData bounds check", () => {
    const result = validateScript(makeScript({
      actions: [
        { type: "SpeedUp" },
        { type: "Deploy", name: "test", location: [999, 999], direction: "Right" },
        { type: "SkillDaemon" },
      ],
    }));
    expect(result.valid).toBe(true);
  });
});
