import { buildPlanningReport, formatPlanningReport } from "../src/battle/PlanningReport";
import { validateMAAProtocol } from "../src/battle/MAAProtocolValidator";
import type { BattleScript, MapData, TacticalAnalysis, ValidationResult } from "../src/types";

function makeMapData(overrides: Partial<MapData> = {}): MapData {
  return {
    stageId: "a001_01",
    name: "a001_01",
    tiles: [
      [
        { key: "tile_floor", heightType: "lowland", buildableType: "melee", row: 0, col: 0 },
        { key: "tile_floor", heightType: "lowland", buildableType: "melee", row: 0, col: 1 },
      ],
    ],
    deploymentPoints: [{ row: 0, col: 0, buildableType: "melee" }],
    strategicPoints: [],
    highThreatAreas: [],
    routes: [],
    waves: [],
    enemyDetails: [{ id: "enemy_1", name: "enemy", maxHp: 1000, atk: 100, def: 100, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false }],
    spawnTimeline: [{ time: 0, enemyId: "enemy_1", count: 1, routeIndex: 0 }],
    options: { characterLimit: 8, maxLifePoint: 3, initialCost: 10, maxCost: 99, costIncreaseTime: 1 },
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<TacticalAnalysis> = {}): TacticalAnalysis {
  return {
    summary: "test",
    enemyComposition: {
      totalCount: 1,
      normalCount: 1,
      eliteCount: 0,
      bossCount: 0,
      compositionType: "single",
    },
    requirements: {
      vanguardCount: 1,
      guardCount: 0,
      medicCount: 0,
      tankCount: 0,
      sniperCount: 0,
      casterCount: 0,
      supportCount: 0,
      specialistCount: 0,
      specialRequirements: [],
      expectedCost: 20,
      difficultyRating: "easy",
    },
    keyTimings: [],
    threatPriorities: [],
    suggestedStrategy: { name: "Single lane", description: "Hold one lane", corePrinciples: [] },
    ...overrides,
  };
}

function makeScript(overrides: Partial<BattleScript> = {}): BattleScript {
  return {
    stage_name: "a001_01",
    minimum_required: "v4.0.0",
    doc: { title: "test", details: "test" },
    opers: [{ name: "test", skill: 1, skill_usage: 1 }],
    groups: [{ name: "先锋", opers: [{ name: "test", skill: 1, skill_usage: 1 }] }],
    actions: [
      { type: "Deploy", name: "test", location: [0, 0], direction: "Right" },
      { type: "SkillDaemon" },
    ],
    generatedAt: "2026-06-12T00:00:00.000Z",
    metadata: { source: "test" },
    ...overrides,
  };
}

function makeValidation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true,
    errors: [],
    warnings: [],
    score: 100,
    ...overrides,
  };
}

describe("PlanningReport", () => {
  it("should build a high-confidence supported report for a clean script", () => {
    const script = makeScript();
    const report = buildPlanningReport({
      mapData: makeMapData(),
      analysis: makeAnalysis(),
      script,
      validation: makeValidation(),
      protocol: validateMAAProtocol(script),
    });

    expect(report.supportLevel).toBe("supported");
    expect(report.script_valid).toBe(true);
    expect(report.deployable_tiles_used).toBe(1);
    expect(report.enemy_data_used).toBe(true);
    expect(report.boss_detected).toBe(false);
    expect(report.planner_confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("should downgrade support and confidence for boss, rune, and protocol risks", () => {
    const requirements = { elite: 2, level: 90, skill_level: 7, module: 0, potential: 1 };
    const script = makeScript({
      opers: [{ name: "test", skill: 1, skill_usage: 1, requirements }],
      actions: [{ type: "Wait", time: 5 }],
    });
    const report = buildPlanningReport({
      mapData: makeMapData({
        runes: [{ key: "test_rune", position: { row: 0, col: 1 } }],
        enemyDetails: [{ id: "boss", name: "boss", maxHp: 50000, atk: 1000, def: 500, magicResistance: 30, moveSpeed: 1, isBoss: true, isElite: true }],
      }),
      analysis: makeAnalysis({
        enemyComposition: { totalCount: 1, normalCount: 0, eliteCount: 0, bossCount: 1, compositionType: "boss_rush" },
        requirements: { ...makeAnalysis().requirements, difficultyRating: "hard" },
      }),
      script,
      validation: makeValidation(),
      protocol: validateMAAProtocol(script),
    });

    expect(report.supportLevel).toBe("experimental");
    expect(report.boss_detected).toBe(true);
    expect(report.planner_confidence).toBeLessThan(0.8);
    expect(report.known_risks).toEqual(expect.arrayContaining([
      "boss wave detected; skill timing model is heuristic only",
      "special tile/rune detected",
      "uses internal Wait action; MAA strict protocol may need delay conversion",
      "operator requirements are informational only in MAA",
    ]));
  });

  it("should mark invalid scripts as unsupported", () => {
    const script = makeScript({ actions: [{ type: "BadAction" }] });
    const report = buildPlanningReport({
      mapData: makeMapData(),
      analysis: makeAnalysis(),
      script,
      validation: makeValidation({ valid: false, errors: [{ code: "INVALID_ACTION_TYPE", message: "bad" }], score: 80 }),
      protocol: validateMAAProtocol(script),
    });

    expect(report.supportLevel).toBe("unsupported");
    expect(report.script_valid).toBe(false);
    expect(report.planner_confidence).toBeLessThan(0.7);
  });

  it("should format a readable explain report", () => {
    const script = makeScript();
    const report = buildPlanningReport({
      mapData: makeMapData(),
      analysis: makeAnalysis(),
      script,
      validation: makeValidation(),
      protocol: validateMAAProtocol(script),
    });

    const text = formatPlanningReport(report, script);

    expect(text).toContain("Stage: a001_01");
    expect(text).toContain("Support: supported");
    expect(text).toContain("Deployments:");
    expect(text).toContain("1. test: [0, 0] Right");
  });
});
