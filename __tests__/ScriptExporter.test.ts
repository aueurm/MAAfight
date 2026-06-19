import { exportToCopilotFormat } from "../src/copilot/ScriptExporter";
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
    doc: { title: "Test Script", details: "Test details" },
    groups: [
      { name: "先锋", opers: [{ name: "推进之王", skill: 2, skill_usage: 1 }] },
    ],
    opers: [{ name: "推进之王", skill: 2, skill_usage: 1 }],
    generatedAt: new Date().toISOString(),
    metadata: { source: "ai", difficulty: "easy", estimatedCost: 40 },
    ...overrides,
  };
}

describe("exportToCopilotFormat", () => {
  it("should export valid JSON", () => {
    const json = exportToCopilotFormat(makeScript());
    const parsed = JSON.parse(json);

    expect(parsed.stage_name).toBe("OF-1");
    expect(parsed.minimum_required).toBe("v4.0.0");
    expect(parsed.actions).toBeDefined();
    expect(parsed.groups).toBeDefined();
    expect(parsed.version).toBe(3);
  });

  it("should produce pretty-printed JSON by default", () => {
    const json = exportToCopilotFormat(makeScript());
    expect(json).toContain("\n");
    expect(json).toContain("  ");
  });

  it("should produce compressed output when enabled", () => {
    const json = exportToCopilotFormat(makeScript(), { compress: true });
    expect(json).not.toContain("\n");
  });

  it("should clean unnecessary fields from actions", () => {
    const script = makeScript({
      actions: [
        { type: "SpeedUp", name: undefined as unknown as string },
      ],
    });
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);
    // SpeedUp should not have a name field
    expect(parsed.actions[0].name).toBeUndefined();
  });

  it("should handle scripts without groups", () => {
    const json = exportToCopilotFormat(makeScript({ groups: [] }));
    const parsed = JSON.parse(json);
    expect(parsed.groups).toEqual([]);
  });

  it("should preserve operator skill_usage", () => {
    const script = makeScript({
      opers: [{ name: "test", skill: 1, skill_usage: 2 }],
    });
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);
    expect(parsed.opers[0].skill_usage).toBe(2);
  });

  it("should preserve operator requirements", () => {
    const requirements = { elite: 2, level: 90, skill_level: 7, module: 0, potential: 3 };
    const script = makeScript({
      opers: [{ name: "test", skill: 1, skill_usage: 1, requirements }],
      groups: [{ name: "test-group", opers: [{ name: "test", skill: 1, skill_usage: 1, requirements }] }],
    });
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);
    expect(parsed.opers[0].requirements).toEqual(requirements);
    expect(parsed.groups[0].opers[0].requirements).toEqual(requirements);
  });

  it("should preserve action location and direction", () => {
    const json = exportToCopilotFormat(makeScript());
    const parsed = JSON.parse(json);
    const deployAction = parsed.actions.find((a: { type: string }) => a.type === "Deploy");
    expect(deployAction.location).toEqual([2, 3]);
    expect(deployAction.direction).toBe("Right");
  });

  it("should preserve standard action conditions and delays", () => {
    const script = makeScript({
      actions: [
        {
          type: "Deploy",
          name: "推进之王",
          location: [3, 2],
          direction: "Right",
          costs: 12,
          cost_changes: 3,
          kills: 4,
          cooling: 1,
          time_elapsed: 5000,
          pre_delay: 100,
          post_delay: 200,
          skip_if_not_ready: false,
          distance: [1, -1],
          doc: "deploy",
          doc_color: "orange",
        },
      ],
    });
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);
    expect(parsed.actions[0]).toMatchObject({
      costs: 12,
      cost_changes: 3,
      kills: 4,
      cooling: 1,
      time_elapsed: 5000,
      pre_delay: 100,
      post_delay: 200,
      skip_if_not_ready: false,
      distance: [1, -1],
      doc: "deploy",
      doc_color: "orange",
    });
  });

  it("should handle empty doc title and details", () => {
    const script = makeScript({ doc: { title: "", details: "" } });
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);
    expect(parsed.doc.title).toBe("");
    expect(parsed.doc.details).toBe("");
  });

  it("should omit undefined optional fields from opers", () => {
    const script = makeScript({
      opers: [{ name: "test" }],
    });
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);
    expect(parsed.opers[0].skill).toBeUndefined();
    expect(parsed.opers[0].skill_usage).toBeUndefined();
  });

  it("should omit undefined optional fields from group opers", () => {
    const script = makeScript({
      groups: [{ name: "test", opers: [{ name: "op", skill: 0, skill_usage: 0 }] }],
      opers: [],
    });
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);
    const groupOper = parsed.groups[0].opers[0];
    expect(groupOper.skill).toBe(0);
    expect(groupOper.skill_usage).toBe(0);
  });

  it("should include target field on action when set", () => {
    const script = makeScript({
      actions: [
        { type: "SkillUse", name: "test", skill: 1, target: "boss" },
      ],
    });
    const json = exportToCopilotFormat(script);
    const parsed = JSON.parse(json);
    expect(parsed.actions[0].target).toBe("boss");
  });
});
