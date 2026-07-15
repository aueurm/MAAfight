import { parseDeepSeekBattleDsl } from "../src/deepseek-core/BattleDslParser";

const operators = Array.from({ length: 12 }, (_, index) => `operator(干员${index + 1}, 1, 1)`).join("\n");

describe("DeepSeek BattleDSL parser", () => {
  it("parses function-style actions and only keeps supplied AND conditions", () => {
    const result = parseDeepSeekBattleDsl(`${operators}\n\ndeploy(干员1, 1, 2, Right)\nskill(干员1, kills=10, timeElapsed=30)\nretreat(干员1, costChanges=-1)\nskillDaemon()`);

    expect(result.valid).toBe(true);
    expect(result.candidate?.operators).toHaveLength(12);
    expect(result.candidate?.actions).toEqual([
      { type: "SpeedUp", delay: 0 },
      { type: "Deploy", operatorId: "干员1", x: 1, y: 2, direction: "Right", delay: 0 },
      { type: "SkillUse", operatorId: "干员1", kills: 10, timeElapsed: 30, delay: 0 },
      { type: "Retreat", operatorId: "干员1", costChanges: -1, delay: 0 },
      { type: "SkillDaemon", delay: 0 },
      { type: "End", delay: 0 },
    ]);
    expect(result.candidate?.actions[2]).not.toHaveProperty("costs");
  });

  it.each([
    ["unknown function", `${operators}\nwait(1000)`],
    ["duplicate argument", `${operators}\ndeploy(干员1, 1, 2, Right, delay=250, delay=500)`],
    ["bad integer", `${operators}\nskill(干员1, kills=1.5)`],
    ["missing squad", "deploy(干员1, 1, 2, Right)"],
  ])("reports %s with its DSL line", (_label, source) => {
    const result = parseDeepSeekBattleDsl(source);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/^line \d+:/);
  });
});
