import { validateMAAProtocol } from "../src/copilot/MAAProtocolValidator";
import { exportToCopilotFormat } from "../src/copilot/ScriptExporter";
import { validateScript } from "../src/copilot/ScriptValidator";
import {
  requestDeepSeekCandidate,
  resolveDeepSeekApiKey,
} from "../src/deepseek-core/DeepSeekCore";
import {
  buildDeepSeekContext,
  compileDeepSeekCandidate,
  generateDeepSeekScript,
  type DeepSeekGenerationInput,
} from "../src/deepseek-core/DeepSeekCompiler";
import type { BattleAction } from "../src/deepseek-core/BattleDsl";
import { getOperatorKnowledge as resolveKnowledge } from "../src/engine/OperatorKnowledge";
import type { StageFacts } from "../src/engine/types";
import type { MapData, PlayerOperator } from "../src/types";

function mapData(): MapData {
  return {
    stageId: "main_01-07",
    name: "1-7",
    tiles: Array.from({ length: 4 }, (_, row) => Array.from({ length: 5 }, (_, col) => ({
      key: "floor",
      heightType: "lowland" as const,
      buildableType: "melee" as const,
      row,
      col,
    }))),
    deploymentPoints: [
      { row: 2, col: 1, buildableType: "melee" },
      { row: 1, col: 2, buildableType: "melee" },
      { row: 1, col: 3, buildableType: "melee" },
    ],
    strategicPoints: [{ type: "chokepoint", row: 2, col: 1, routeCount: 1 }],
    highThreatAreas: [],
    routes: [{ id: 1, motionMode: "walk", startPosition: { row: 2, col: 4 }, checkpoints: [{ row: 2, col: 1 }], endPosition: { row: 2, col: 0 } }],
    waves: [],
    enemyDetails: [],
    spawnTimeline: [],
    options: { characterLimit: 3, maxLifePoint: 3, initialCost: 10, maxCost: 99, costIncreaseTime: 1 },
  };
}

function operators() {
  return Array.from({ length: 12 }, (_, index) => ({ name: `干员${index + 1}`, skill: 1, skillUsage: 2 }));
}

function candidate(): { stageId: string; operators: ReturnType<typeof operators>; actions: BattleAction[] } {
  return {
    stageId: "1-7",
    operators: operators(),
    actions: [
      { type: "SpeedUp", delay: 0 },
      { type: "Deploy", operatorId: "干员1", x: 1, y: 2, direction: "Right", delay: 0 },
      { type: "SkillUse", operatorId: "干员1", skillIndex: 1, kills: 10, timeElapsed: 30, delay: 250 },
      { type: "Deploy", operatorId: "干员2", x: 2, y: 1, direction: "Right", delay: 500 },
      { type: "Retreat", operatorId: "干员1", costChanges: -1, delay: 0 },
      { type: "Deploy", operatorId: "干员3", x: 3, y: 1, direction: "Left", delay: 500 },
      { type: "End", delay: 0 },
    ],
  };
}

function battleDsl(): string {
  return `${operators().map(operator => `operator(${operator.name}, ${operator.skill}, ${operator.skillUsage})`).join("\n")}\n\ndeploy(干员1, 1, 2, Right)\nskill(干员1, kills=10, timeElapsed=30, delay=250)\ndeploy(干员2, 2, 1, Right, delay=500)\nretreat(干员1, costChanges=-1)\ndeploy(干员3, 3, 1, Left, delay=500)`;
}

function environment(selectedSkillType = "MANUAL") {
  const players = new Map<string, PlayerOperator>(operators().map((operator, index) => [operator.name, {
    id: operator.name,
    name: operator.name,
    rarity: 6,
    own: true,
    elite: 2,
    level: 60,
    potential: index + 1,
  }]));
  return {
    stageName: "1-7",
    mapData: mapData(),
    players,
    getCombatOperatorByName: (name: string) => players.has(name) ? {
      id: name,
      name,
      role: "guard",
      subProfession: "fighter",
      position: "MELEE" as const,
      skills: [{ unlockPhase: 0, levels: [{ rank: 10, skillType: selectedSkillType }] }],
    } : undefined,
    now: () => new Date("2026-07-14T00:00:00.000Z"),
  };
}

function generationEnvironment(selectedSkillType = "MANUAL") {
  const input = environment(selectedSkillType);
  return {
    ...input,
    getOperatorKnowledge: (name: string, _skill: number, player: PlayerOperator) => {
      const combat = input.getCombatOperatorByName(name);
      return resolveKnowledge({
        id: player.id,
        name,
        role: combat?.role,
        subProfession: combat?.subProfession,
        position: combat?.position,
      });
    },
  };
}

describe("DeepSeek core", () => {
  it("sends an OpenAI-compatible JSON request without exposing the key", async () => {
    let request: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | undefined;
    const output = await requestDeepSeekCandidate({
      apiKey: "test-key",
      context: { stageId: "1-7" },
      feedback: { errors: [] },
      fetcher: async (url, init) => {
        request = { url, init };
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ battleDsl: battleDsl() }) } }] }) };
      },
    });

    expect(output).toEqual({ battleDsl: battleDsl() });
    expect(request?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request?.init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(request!.init.body)).toMatchObject({
      model: "deepseek-v4-pro",
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
    const systemPrompt = JSON.parse(request!.init.body).messages[0].content;
    expect(systemPrompt).toContain("battleDsl");
    expect(systemPrompt).toContain("positionEffect");
    expect(systemPrompt).toContain("通关保证");
  });

  it("rejects missing keys and HTTP failures without including credentials", async () => {
    expect(() => resolveDeepSeekApiKey({})).toThrow("DEEPSEEK_API_KEY is not configured");
    await expect(requestDeepSeekCandidate({
      apiKey: "test-key",
      context: {},
      feedback: { errors: [] },
      fetcher: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"invalid key"}}' }),
    })).rejects.toThrow("DeepSeek request failed: 401 invalid key");
  });

  it("only exposes skills unlocked at the player's elite level", () => {
    const input = environment();
    const context = buildDeepSeekContext({
      ...input,
      getCombatOperatorByName: name => input.players.has(name) ? {
        position: "MELEE" as const,
        skills: [
          { unlockPhase: 0, levels: [{ rank: 10, skillType: "MANUAL" }] },
          { unlockPhase: 3, levels: [{ rank: 10, skillType: "MANUAL" }] },
        ],
      } : undefined,
    }) as { roster: Array<{ name: string; skills: Array<{ index: number }> }> };

    expect(context.roster.find(operator => operator.name === "干员1")?.skills).toMatchObject([{ index: 1, unlockPhase: 0, skillType: "MANUAL" }]);
  });

  it("exposes role data without restricting the roster", () => {
    const context = buildDeepSeekContext(environment()) as { roster: Array<{ name: string; role?: string; subProfession?: string }> };

    expect(context.roster.find(operator => operator.name === "干员1")).toMatchObject({ role: "guard", subProfession: "fighter" });
  });

  it("exposes operator knowledge vectors and skill spatial behavior", () => {
    const context = buildDeepSeekContext(environment()) as {
      operatorKnowledgeVectorAxes: string[];
      roster: Array<{
        name: string;
        knowledge: { vector: number[]; spatial: { range: Array<[number, number]> } };
        skills: Array<{ knowledge: { preferred: boolean; spatial: { skillRangeBehavior: string } } }>;
      }>;
    };
    const operator = context.roster.find(item => item.name === "干员1")!;

    expect(context.operatorKnowledgeVectorAxes).toHaveLength(12);
    expect(operator.knowledge.vector).toHaveLength(12);
    expect(operator.knowledge.spatial.range).toEqual([]);
    expect(operator.skills[0].knowledge).toMatchObject({ preferred: false, spatial: { skillRangeBehavior: "unchanged" } });
  });

  it("passes the resolved knowledge model and the current skill knowledge into context", () => {
    const input = environment();
    const baseKnowledge = resolveKnowledge({ id: "knowledge-test", name: "知识测试", position: "RANGED", damageType: "arts" });
    const resolver = jest.fn((_name: string, skill: number) => ({
      ...baseKnowledge,
      skillTags: { [skill]: [`skill-${skill}`] },
      spatial: { ...baseKnowledge.spatial, range: [[0, skill] as [number, number]], skillRangeBehavior: skill === 2 ? "extends" : "unchanged" },
    }));
    const context = buildDeepSeekContext({
      ...input,
      getCombatOperatorByName: name => input.players.has(name) ? {
        position: "RANGED" as const,
        role: "caster",
        subProfession: "corecaster",
        skills: [
          { unlockPhase: 0, levels: [{ rank: 10, skillType: "MANUAL" }] },
          { unlockPhase: 0, levels: [{ rank: 10, skillType: "MANUAL" }] },
        ],
      } : undefined,
      getOperatorKnowledge: resolver,
    }) as {
      operatorKnowledgeModel: { generatedCommit: string; generatedOperatorCount: number; vectorAxes: string[] };
      roster: Array<{ name: string; skills: Array<{ index: number; knowledge: { tags: string[]; spatial: { range: Array<[number, number]>; skillRangeBehavior: string } } }> }>;
    };
    const operator = context.roster.find(item => item.name === "干员1")!;

    expect(context.operatorKnowledgeModel).toMatchObject({ generatedCommit: expect.stringMatching(/^[a-f0-9]{40}$/), generatedOperatorCount: 412 });
    expect(context.operatorKnowledgeModel.vectorAxes).toHaveLength(12);
    expect(resolver).toHaveBeenCalledWith("干员1", 2, input.players.get("干员1"));
    expect(operator.skills[1]).toMatchObject({ index: 2, knowledge: { tags: ["skill-2"], spatial: { range: [[0, 2]], skillRangeBehavior: "extends" } } });
  });

  it("only exposes E2 operators and reports a blue-gate blocking entry", () => {
    const input = environment();
    input.players.get("干员1")!.elite = 1;
    const context = buildDeepSeekContext(input) as {
      roster: Array<{ name: string }>;
      stage: { blueGateFronts: Array<{ goal: { x: number; y: number }; blockingPoints: Array<{ x: number; y: number; direction: string; safeSupportPoints: unknown[] }> }> };
    };

    expect(context.roster.some(operator => operator.name === "干员1")).toBe(false);
    expect(context.stage.blueGateFronts).toEqual([{ goal: { x: 0, y: 2 }, blockingPoints: [{ x: 1, y: 2, direction: "Right", safeSupportPoints: [] }] }]);
    expect(compileDeepSeekCandidate(candidate(), input).errors.join("\n")).toContain("NON_ELITE_2_OPERATOR: 干员1");
  });

  it("rejects a candidate that leaves a blue-gate front uncovered or facing away", () => {
    const wrongFront = candidate();
    wrongFront.actions[1] = { type: "Deploy", operatorId: "干员1", x: 1, y: 2, direction: "Left", delay: 0 };

    expect(compileDeepSeekCandidate(wrongFront, environment()).errors.join("\n"))
      .toContain("MISSING_BLUE_GATE_FRONT: goal (0,2) needs MELEE deploy(1,2,Right)");
  });

  it("requires a safe high-ground medic for each blue-gate front when the stage has a boss", () => {
    const bossMap = mapData();
    bossMap.tiles[1][1].buildableType = "ranged";
    bossMap.deploymentPoints.push({ row: 1, col: 1, buildableType: "ranged" });
    const result = compileDeepSeekCandidate(candidate(), {
      ...environment(),
      mapData: bossMap,
      facts: { bossCount: 1 } as StageFacts,
    });

    expect(result.errors.join("\n")).toContain("MISSING_BLUE_GATE_HEALER: goal (0,2) needs RANGED medic at a safeSupportPoint");
  });

  it("requires exactly one configured manual skill for a boss stage", () => {
    const noBurst = candidate();
    noBurst.actions = noBurst.actions.filter(action => action.type !== "SkillUse");

    expect(compileDeepSeekCandidate(noBurst, { ...environment(), facts: { bossCount: 1 } as StageFacts }).errors.join("\n"))
      .toContain("BOSS_MANUAL_SKILL_REQUIRED: expected exactly one SkillUse, got 0");
  });

  it("rejects a weak manual skill when the selected squad has a stronger burst skill", () => {
    const weakBurst = candidate();
    const input = environment();
    const originalCombat = input.getCombatOperatorByName;
    input.getCombatOperatorByName = name => {
      const combat = originalCombat(name);
      return combat && {
        ...combat,
        skills: [
          { unlockPhase: 0, levels: [{ rank: 10, skillType: "MANUAL", maxTargets: 1, metrics: { burstDps: 10 } }] },
          { unlockPhase: 0, levels: [{ rank: 10, skillType: "MANUAL", maxTargets: 3, metrics: { burstDps: 100 } }] },
        ],
      };
    };

    expect(compileDeepSeekCandidate(weakBurst, { ...input, facts: { bossCount: 1 } as StageFacts }).errors.join("\n"))
      .toContain("BOSS_MANUAL_SKILL_TOO_WEAK: 干员1 annihilationPower=10; selected squad maximum MANUAL annihilationPower=300");
  });

  it("compiles a legal DeepSeek candidate through every deterministic validator", () => {
    const result = compileDeepSeekCandidate(candidate(), environment());

    expect(result.valid).toBe(true);
    expect(result.script?.actions[0]).toMatchObject({ type: "ResetStopwatch" });
    expect(result.script?.actions[2].location).toEqual([2, 1]);
    expect(result.script?.actions[3]).toMatchObject({ type: "Skill", kills: 10, time_elapsed: 30 });
    expect(JSON.parse(result.copilotJson!).actions[2].location).toEqual([1, 2]);
    expect(validateScript(result.script!, environment().mapData).valid).toBe(true);
    expect(validateMAAProtocol(result.script!).valid).toBe(true);
    expect(JSON.parse(exportToCopilotFormat(result.script!)).actions[2].location).toEqual([1, 2]);
  });

  it("rejects automatic and passive skills when they are explicitly used", () => {
    for (const selectedSkillType of ["AUTO", "PASSIVE"]) {
      const result = compileDeepSeekCandidate(candidate(), environment(selectedSkillType));
      expect(result.valid).toBe(false);
      expect(result.errors.join("\n")).toContain("NON_MANUAL_SKILL_USE");
    }
  });

  it("allows automatic and passive skills to deploy without SkillUse", () => {
    for (const selectedSkillType of ["AUTO", "PASSIVE"]) {
      const automaticCandidate = candidate();
      automaticCandidate.actions = automaticCandidate.actions.filter(action => action.type !== "SkillUse");
      const result = compileDeepSeekCandidate(automaticCandidate, environment(selectedSkillType));
      expect(result.valid).toBe(true);
      expect(result.script?.actions.some(action => action.type === "Skill")).toBe(false);
    }
  });

  it("rejects mixed skill controls, untimed retreats, invalid conditions, and inactive references", () => {
    const mixed = candidate();
    mixed.actions.splice(-1, 0, { type: "SkillDaemon", delay: 0 });
    const untimed = candidate();
    untimed.actions[4] = { type: "Retreat", operatorId: "干员1", delay: 0 };
    const invalidCondition = candidate();
    invalidCondition.actions[2] = { type: "SkillUse", operatorId: "干员1", skillIndex: 1, timeElapsed: 0, delay: 0 };
    const inactive = candidate();
    inactive.actions[2] = { type: "SkillUse", operatorId: "干员2", skillIndex: 1, delay: 0 };

    expect(compileDeepSeekCandidate(mixed, environment()).errors.join("\n")).toContain("MIXED_SKILL_CONTROL");
    expect(compileDeepSeekCandidate(untimed, environment()).errors.join("\n")).toContain("UNTIMED_RETREAT");
    expect(compileDeepSeekCandidate(invalidCondition, environment()).errors.join("\n")).toContain("BATTLE_DSL_INVALID_ACTION_CONDITION");
    expect(compileDeepSeekCandidate(inactive, environment()).errors.join("\n")).toContain("SKILL_OPERATOR_NOT_ACTIVE");
  });

  it("reports the operator and active count when deployment exceeds the limit", () => {
    const overLimit = candidate();
    overLimit.actions = [
      { type: "SpeedUp", delay: 0 },
      { type: "Deploy", operatorId: "干员1", x: 1, y: 2, direction: "Right", delay: 0 },
      { type: "Deploy", operatorId: "干员2", x: 2, y: 1, direction: "Right", delay: 0 },
      { type: "End", delay: 0 },
    ];

    expect(compileDeepSeekCandidate(overLimit, { ...environment(), mapData: { ...mapData(), options: { ...mapData().options, characterLimit: 1 } } }).errors.join("\n"))
      .toContain("CHARACTER_LIMIT: action 2 Deploy 干员2 active=2/1");
  });

  it("feeds static errors into the second DeepSeek request and never accepts an illegal candidate", async () => {
    const feedback: Array<{ errors: string[] }> = [];
    let call = 0;
    const result = await generateDeepSeekScript({
      ...generationEnvironment(),
      requestCandidate: async input => {
        feedback.push(input.feedback);
        call++;
        return call === 1 ? { battleDsl: "invalid()" } : { battleDsl: battleDsl() };
      },
    });

    expect(result.valid).toBe(true);
    expect(result.attempts).toBe(2);
    expect(feedback[1].errors.join("\n")).toContain("INVALID_BATTLE_DSL");
  });

  it("stops after three failed static candidates", async () => {
    const result = await generateDeepSeekScript({
      ...generationEnvironment(),
      requestCandidate: async () => ({ battleDsl: "invalid()" }),
    });

    expect(result.valid).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it("requires a runtime operator knowledge resolver for generation", async () => {
    await expect(generateDeepSeekScript({
      ...environment(),
      requestCandidate: async () => ({ battleDsl: battleDsl() }),
    } as unknown as DeepSeekGenerationInput)).rejects.toThrow("DeepSeek generation requires getOperatorKnowledge");
  });
});
