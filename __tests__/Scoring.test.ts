import {
  publicPriorScoreFromStats,
  timingVariantOrderFromStats,
  type CopilotPriorStats,
} from "../src/engine/CopilotPrior";
import { scoreCandidate, timingScoreFromStats, toCandidateScoreBreakdown, weightedScore } from "../src/engine/Scoring";
import type { BattleScript } from "../src/types";
import type { EncounterContext, EnginePick, StageFacts } from "../src/engine/types";

function scriptAt(location: [number, number], direction = "Right"): BattleScript {
  return {
    stage_name: "coverage-test",
    minimum_required: "v6.0.0",
    actions: [
      { type: "SpeedUp" },
      { type: "Deploy", name: "测试干员", location, direction, costs: 10 },
      { type: "SkillDaemon" },
    ],
    doc: { title: "test", details: "" },
    groups: [],
    opers: [{ name: "测试干员", skill: 1, skill_usage: 1 }],
    generatedAt: "2026-07-03T00:00:00.000Z",
    metadata: { source: "test" },
    version: 3,
  };
}

function delayedScriptAt(location: [number, number], direction = "Right", pre_delay = 0): BattleScript {
  const script = scriptAt(location, direction);
  const deploy = script.actions.find(action => action.type === "Deploy");
  if (deploy && pre_delay > 0) deploy.pre_delay = pre_delay;
  return script;
}

function timingScript(deploys: Array<{ costs: number; pre_delay?: number }>): BattleScript {
  return {
    ...scriptAt([1, 1]),
    actions: [
      { type: "SpeedUp" },
      ...deploys.map((deploy, index) => ({
        type: "Deploy",
        name: "测试干员",
        location: [1, 1] as [number, number],
        direction: "Right",
        costs: deploy.costs,
        ...(deploy.pre_delay !== undefined ? { pre_delay: deploy.pre_delay } : {}),
        doc: `deploy-${index}`,
      })),
      { type: "SkillDaemon" },
    ],
  };
}

function pick(range: Array<[number, number]>): EnginePick {
  return {
    operatorId: "test",
    name: "测试干员",
    role: "guard",
    skill: 1,
    skillRank: 7,
    profile: {
      operatorId: "test",
      name: "测试干员",
      role: "guard",
      subProfession: null,
      position: "MELEE",
      damageType: "physical",
      skill: 1,
      skillRank: 7,
      baseRangeId: null,
      skillRangeId: null,
      range,
      attributes: { hp: 2000, atk: 500, def: 200, res: 0, cost: 10, block: 2, attackInterval: 1, attackSpeed: 100 },
      metrics: {
        normalDps: 500,
        burstDps: 700,
        cycleDps: 550,
        healingHps: 0,
        physicalEhp: 3000,
        artsEhp: 2500,
        controlSeconds: 0,
      },
      maxTargets: 1,
      confidence: "exact",
      modelCoverageGaps: [],
    },
  };
}

const facts: StageFacts = {
  stageId: "coverage-test",
  rows: 6,
  cols: 6,
  enemyCount: 1,
  totalHp: 1000,
  totalAttack: 100,
  averageDefense: 0,
  averageResistance: 0,
  eliteCount: 0,
  bossCount: 0,
  flyingRouteCount: 0,
  groundRouteCount: 1,
  laneCount: 1,
  routeCells: [{ row: 1, col: 2 }, { row: 1, col: 3 }, { row: 1, col: 4 }],
  goalCells: [{ row: 1, col: 5 }],
  chokeCells: [],
  deploymentPoints: [{ row: 1, col: 1, buildableType: "all" }],
  initialCost: 10,
  characterLimit: 1,
  pressureWindows: [],
  difficulty: "easy",
  summary: "test",
};

const encounter: EncounterContext = {
  hash: "test",
  windows: [],
  demand: {
    physical: 1,
    arts: 0,
    burst: 0,
    sustain: 0,
    healing: 0,
    block: 0,
    control: 0,
    antiAir: 0,
    coverage: 0,
    singleTarget: 0,
    area: 0,
    laneHold: 0,
    support: 0,
    deployment: 0,
  },
  averageDefense: 0,
  averageResistance: 0,
  routeCells: facts.routeCells,
};

const priorStats: CopilotPriorStats[] = [{
  averages: { actions: 3, deploys: 1, skills: 0, fixedOpers: 1 },
  rates: { speedUp: 1, skillDaemon: 1 },
  actionTypesPerScript: { Deploy: 1, SkillDaemon: 1, SpeedUp: 1 },
  firstActionRates: { SpeedUp: 1 },
  deployHeatmap: { "1,1": 10, "4,4": 1 },
  firstDeploys: { "1:1,1": 10 },
  directionRates: { Left: 1, Right: 10 },
  directionHeatmap: { "1,1:Right": 10, "4,4:Left": 1 },
  deployTiming: { "0": 1, "500": 10 },
  operatorUsage: { "测试干员": 10 },
  skillUsage: { "测试干员#1": 10 },
}];

describe("candidate scoring", () => {
  it("uses the public-prior placement direction timing operator formula and subtracts feedback penalty", () => {
    const score = weightedScore({
      publicPrior: 100,
      placement: 80,
      direction: 60,
      timing: 50,
      operatorPower: 40,
      feedbackPenalty: 7,
    });

    expect(score).toBeCloseTo(64.2);
  });

  it("lets public prior reorder otherwise equal final candidates", () => {
    const candidates = [
      {
        id: "weak-prior",
        score: weightedScore({
          publicPrior: 20,
          placement: 70,
          direction: 70,
          timing: 70,
          operatorPower: 70,
          feedbackPenalty: 0,
        }),
      },
      {
        id: "strong-prior",
        score: weightedScore({
          publicPrior: 90,
          placement: 70,
          direction: 70,
          timing: 70,
          operatorPower: 70,
          feedbackPenalty: 0,
        }),
      },
    ].sort((left, right) => right.score - left.score);

    expect(candidates[0].id).toBe("strong-prior");
    expect(candidates[0].score - candidates[1].score).toBeCloseTo(19.6);
  });

  it("adapts legacy score breakdowns for old callers", () => {
    const breakdown = toCandidateScoreBreakdown({
      combat: 40,
      position: 80,
      timing: 70,
      corpus: 90,
      tasks: 60,
      automation: 100,
    });

    expect(breakdown).toEqual({
      publicPrior: 90,
      placement: 80,
      direction: 80,
      timing: 70,
      operatorPower: 50,
      feedbackPenalty: 0,
    });
    expect(weightedScore(breakdown)).toBeCloseTo(77.2);
  });

  it("does not let route coverage from operator range drive placement or direction scores", () => {
    const narrow = scoreCandidate(scriptAt([1, 1]), [pick([[0, 1]])], facts, encounter).breakdown;
    const wide = scoreCandidate(scriptAt([1, 1]), [pick([[0, 1], [0, 2], [0, 3], [0, 4]])], facts, encounter).breakdown;

    expect(wide.placement).toBeCloseTo(narrow.placement);
    expect(wide.direction).toBeCloseTo(narrow.direction);
  });

  it("keeps placement as basic geometry sanity instead of route-cell coverage", () => {
    const legal = scoreCandidate(scriptAt([1, 1]), [pick([[0, 1]])], facts, encounter).breakdown;
    const invalid = scoreCandidate(scriptAt([4, 4]), [pick([[0, 1]])], facts, encounter).breakdown;

    expect(invalid.placement).toBeLessThan(legal.placement);
  });

  it("uses public position direction timing operator and shape prior as a bonus", () => {
    const aligned = publicPriorScoreFromStats(delayedScriptAt([1, 1], "Right", 500), [pick([[0, 1]])], priorStats);
    const offPrior = publicPriorScoreFromStats(delayedScriptAt([4, 4], "Left", 0), [pick([[0, 1]])], priorStats);

    expect(aligned).toBeGreaterThan(offPrior);
  });

  it("keeps missing public prior neutral instead of rejecting the candidate", () => {
    expect(publicPriorScoreFromStats(scriptAt([1, 1]), [pick([[0, 1]])], [])).toBe(50);
  });

  it("orders timing variants by public deploy timing when available", () => {
    expect(timingVariantOrderFromStats([{ ...priorStats[0], deployTiming: { "750": 5, "250": 10 } }]))
      .toEqual([1, 3, 0, 2]);
  });

  it("penalizes obviously infeasible deployment costs", () => {
    const reasonable = timingScoreFromStats(timingScript([{ costs: 10 }]), facts);
    const infeasible = timingScoreFromStats(timingScript([{ costs: 40 }, { costs: 35 }]), facts);

    expect(infeasible).toBeLessThan(reasonable - 25);
  });

  it("does not over-penalize reasonable delay used for cost", () => {
    expect(timingScoreFromStats(timingScript([{ costs: 20, pre_delay: 10_000 }]), facts)).toBeGreaterThan(80);
  });

  it("penalizes extreme long pre_delay", () => {
    const reasonable = timingScoreFromStats(timingScript([{ costs: 20, pre_delay: 10_000 }]), facts);
    const extreme = timingScoreFromStats(timingScript([{ costs: 10, pre_delay: 120_000 }]), facts);

    expect(extreme).toBeLessThan(reasonable - 20);
  });

  it("gives a timing bonus near public timing prior", () => {
    const nearPrior = timingScoreFromStats(timingScript([{ costs: 10, pre_delay: 500 }]), facts, priorStats);
    const offPrior = timingScoreFromStats(timingScript([{ costs: 10 }]), facts, priorStats);

    expect(nearPrior).toBeGreaterThan(offPrior);
  });
});
