import { validateScript } from "../src/copilot/ScriptValidator";
import {
  battleDslToCopilotJson,
  copilotJsonToBattleDsl,
  normalizeDelayToBucket,
  validateBattleDsl,
  type BattleAction,
} from "../src/copilot/battleDsl";
import type { BattleScript as MaaBattleScript } from "../src/types";

function copilot() {
  return {
    stage_name: "main_01-07",
    minimum_required: "v6.0.0",
    doc: { title: "test", details: "" },
    opers: [{ name: "煌", skill: 2 }],
    groups: [],
    version: 3,
    actions: [
      { type: "SpeedUp" },
      { type: "Deploy", name: "煌", location: [4, 2], direction: "left", pre_delay: 260 },
      { type: "SkillDaemon" },
      { type: "Skill", name: "煌", pre_delay: 1200 },
    ],
  };
}

function semantic(actions: BattleAction[]) {
  return actions.map(action => ({
    type: action.type,
    operatorId: action.operatorId,
    x: action.x,
    y: action.y,
    direction: action.direction,
    delay: action.delay,
    kills: action.kills,
    costs: action.costs,
    costChanges: action.costChanges,
    cooling: action.cooling,
    timeElapsed: action.timeElapsed,
  }));
}

describe("BattleDSL", () => {
  it("converts simple Copilot JSON into BattleDSL and fills deploy fields", () => {
    const script = copilotJsonToBattleDsl(copilot());

    expect(script.stageId).toBe("main_01-07");
    expect(script.actions[1]).toMatchObject({
      type: "Deploy",
      operatorId: "煌",
      x: 4,
      y: 2,
      direction: "Left",
      delay: 500,
    });
  });

  it("converts BattleDSL back to Copilot JSON without emitting End", () => {
    const output = battleDslToCopilotJson(copilotJsonToBattleDsl(copilot())) as { actions: Array<{ type: string; pre_delay?: number }> };

    expect(output.actions.map(action => action.type)).toEqual(["SpeedUp", "Deploy", "SkillDaemon", "Skill"]);
    expect(output.actions[1].pre_delay).toBe(500);
    expect(output.actions[3].pre_delay).toBe(1500);
  });

  it("keeps key action semantics through Copilot to BattleDSL roundtrip", () => {
    const first = copilotJsonToBattleDsl(copilot());
    const second = copilotJsonToBattleDsl(battleDslToCopilotJson(first));

    expect(semantic(second.actions)).toEqual(semantic(first.actions));
  });

  it("preserves SkillDaemon and adds End when missing", () => {
    const script = copilotJsonToBattleDsl(copilot());

    expect(script.actions.some(action => action.type === "SkillDaemon")).toBe(true);
    expect(script.actions.at(-1)).toEqual({ type: "End", delay: 0 });
  });

  it("round-trips ResetStopwatch and native action conditions", () => {
    const script = copilotJsonToBattleDsl({
      stage_name: "x",
      actions: [
        { type: "ResetStopwatch" },
        { type: "Skill", name: "煌", kills: 5, costs: 20, cost_changes: -1, cooling: 0, time_elapsed: 30 },
        { type: "Retreat", name: "煌", kills: 10 },
      ],
    });
    const output = battleDslToCopilotJson(script) as { actions: Array<Record<string, unknown>> };

    expect(script.actions[0].type).toBe("ResetStopwatch");
    expect(script.actions[1]).toMatchObject({ type: "SkillUse", kills: 5, costs: 20, costChanges: -1, cooling: 0, timeElapsed: 30 });
    expect(validateBattleDsl(script).valid).toBe(true);
    expect(output.actions[1]).toMatchObject({ type: "Skill", kills: 5, costs: 20, cost_changes: -1, cooling: 0, time_elapsed: 30 });
    expect(copilotJsonToBattleDsl(output).actions[1]).toMatchObject(script.actions[1]);
  });

  it("rejects invalid native action conditions", () => {
    const result = validateBattleDsl({
      stageId: "x",
      actions: [
        { type: "Deploy", operatorId: "煌", x: 1, y: 2, direction: "Right", kills: 1, delay: 0 },
        { type: "SkillUse", operatorId: "煌", timeElapsed: 0, delay: 0 },
        { type: "Retreat", operatorId: "煌", costs: -1, delay: 0 },
        { type: "End", delay: 0 },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.code)).toEqual(expect.arrayContaining(["INVALID_ACTION_CONDITIONS", "INVALID_ACTION_CONDITION"]));
  });

  it("maps delay values into buckets", () => {
    expect(normalizeDelayToBucket(undefined)).toBe(0);
    expect(normalizeDelayToBucket(-10)).toBe(0);
    expect(normalizeDelayToBucket(1)).toBe(250);
    expect(normalizeDelayToBucket(260)).toBe(500);
    expect(normalizeDelayToBucket(9000)).toBe(5000);
  });

  it("reports invalid direction and coordinates", () => {
    const result = validateBattleDsl({
      stageId: "x",
      actions: [
        { type: "Deploy", operatorId: "煌", x: 1.5, y: 2, direction: "Side", delay: 0 },
        { type: "End", delay: 0 },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.code)).toEqual(expect.arrayContaining(["INVALID_DIRECTION", "INVALID_COORDINATE"]));
  });

  it("allows None direction for device-like deploy actions", () => {
    const script = copilotJsonToBattleDsl({
      stage_name: "x",
      actions: [{ type: "Deploy", name: "高能源石爆桶", location: [1, 2], direction: "None" }],
    });

    expect(script.actions[0]).toMatchObject({ type: "Deploy", direction: "None" });
    expect(validateBattleDsl(script).valid).toBe(true);
  });

  it("outputs Copilot JSON accepted by existing validator", () => {
    const output = battleDslToCopilotJson(copilotJsonToBattleDsl(copilot())) as MaaBattleScript;
    const result = validateScript(output);

    expect(result.valid).toBe(true);
  });
});
