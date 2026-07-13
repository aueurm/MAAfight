import { validateScript } from "../src/copilot/ScriptValidator";
import { validateBattleDsl } from "../src/model-core/battleDsl";
import {
  generateBattleScript,
  generatedScriptToCopilot,
  repairGeneratedScript,
  resolveBeamConfig,
  type GenerateScriptInput,
} from "../src/model-core/beamSearch";
import type { CpuActionRankerModel } from "../src/model-core/linearRanker";
import { buildScriptFingerprint } from "../src/model-core/modelCoreFeedback";
import type { BattleScript as MaaBattleScript } from "../src/types";

function model(): CpuActionRankerModel {
  return {
    version: "cpu-action-ranker-v0",
    modelType: "linear_pairwise_ranker",
    featureNames: ["action_type_deploy", "cell_x_norm", "action_type_end", "action_type_skill_daemon", "action_type_skill_use"],
    weights: [10, 1, 1, -10, -10],
    bias: 0,
  };
}

function input(config = {}): GenerateScriptInput {
  return {
    stageId: "TEST-1",
    stageFeatures: {
      stageId: "TEST-1",
      rows: 4,
      cols: 4,
      deploymentPoints: [
        { x: 1, y: 1, buildableType: "all" },
        { x: 2, y: 1, buildableType: "all" },
      ],
    },
    rosterFeatures: [{ operatorId: "A", name: "A" }],
    rankerModel: model(),
    config: {
      beamSize: 4,
      topActionsPerState: 8,
      maxSteps: 4,
      candidateActionsPerState: 20,
      seed: 42,
      collectDebug: true,
      ...config,
    },
  };
}

describe("beam search generator", () => {
  it("generates a BattleDSL script and stops expanding after End", () => {
    const generated = generateBattleScript(input());

    expect(generated.actions.some(action => action.type === "Deploy")).toBe(true);
    expect(generated.actions.at(-1)?.type).toBe("End");
    expect(generated.actions.findIndex(action => action.type === "End")).toBe(generated.actions.length - 1);
    expect(validateBattleDsl({ stageId: generated.stageId, actions: generated.actions }).valid).toBe(true);
  });

  it("uses ranker scores to prefer higher scored deploy action", () => {
    const generated = generateBattleScript(input());
    const firstDeploy = generated.actions.find(action => action.type === "Deploy");

    expect(firstDeploy).toMatchObject({ x: 2, y: 1 });
  });

  it("penalizes repeated deploy direction collapse", () => {
    const generated = generateBattleScript({
      ...input({
        repeatPenalty: 2,
        maxSteps: 4,
        candidateActionsPerState: 80,
      }),
      rosterFeatures: [{ operatorId: "A" }, { operatorId: "B" }, { operatorId: "C" }],
      rankerModel: {
        version: "test",
        modelType: "linear_pairwise_ranker",
        featureNames: ["action_type_deploy", "direction_left", "action_type_end", "action_type_skill_daemon", "action_type_skill_use"],
        weights: [5, 2, 0, -10, -10],
        bias: 0,
      },
    });
    const directions = new Set(generated.actions.filter(action => action.type === "Deploy").map(action => action.direction));

    expect(directions.size).toBeGreaterThan(1);
  });

  it("adds End when maxSteps finishes without completed state", () => {
    const generated = generateBattleScript(input({
      maxSteps: 1,
      rankerModel: undefined,
    }));

    expect(generated.actions.at(-1)?.type).toBe("End");
  });

  it("does not end before a basic deployable roster is on the field", () => {
    const generated = generateBattleScript({
      ...input({ maxSteps: 4 }),
      rosterFeatures: [{ operatorId: "A" }, { operatorId: "B" }],
      stageFeatures: {
        stageId: "TEST-1",
        rows: 4,
        cols: 4,
        characterLimit: 2,
        deploymentPoints: [
          { x: 1, y: 1, buildableType: "all" },
          { x: 2, y: 1, buildableType: "all" },
        ],
      },
      rankerModel: {
        version: "test",
        modelType: "linear_pairwise_ranker",
        featureNames: ["action_type_end", "action_type_deploy", "action_type_skill_daemon", "action_type_skill_use"],
        weights: [10, 0, -10, -10],
      },
    });

    expect(generated.actions.filter(action => action.type === "Deploy")).toHaveLength(2);
    expect(generated.actions.at(-1)?.type).toBe("End");
  });

  it("uses state-relative scores instead of extending a script for raw-score gain", () => {
    const generated = generateBattleScript({
      ...input({ maxSteps: 8 }),
      rosterFeatures: [{ operatorId: "A" }, { operatorId: "B" }],
      rankerModel: {
        version: "test",
        modelType: "linear_pairwise_ranker",
        featureNames: ["action_type_skill_use", "action_type_end", "action_type_deploy", "action_type_skill_daemon"],
        weights: [10, 9, 1, -10],
      },
    });

    expect(generated.actions.filter(action => action.type === "Deploy")).toHaveLength(2);
    expect(generated.actions.length).toBeLessThan(8);
    expect(generated.actions.at(-1)?.type).toBe("End");
  });

  it("keeps beam and candidate expansion bounded", () => {
    const generated = generateBattleScript(input({ beamSize: 4, topActionsPerState: 8, candidateActionsPerState: 12 }));
    const history = generated.meta?.beamHistory as unknown[][];
    const candidateLog = generated.meta?.candidateLog as unknown[];

    expect(generated.beams!.length).toBeLessThanOrEqual(resolveBeamConfig({ beamSize: 4 }).beamSize);
    expect(history.every(step => step.length <= 4)).toBe(true);
    expect(candidateLog.length).toBeLessThanOrEqual(12 * 8 * 4);
  });

  it("is stable with the same seed", () => {
    const left = generateBattleScript(input({ seed: 9 }));
    const right = generateBattleScript(input({ seed: 9 }));

    expect(left.actions).toEqual(right.actions);
  });

  it("converts generated BattleDSL to Copilot JSON accepted by validator", () => {
    const generated = generateBattleScript(input());
    const result = generatedScriptToCopilot(generated, input().rosterFeatures, input());

    expect(result.dslValidation.valid).toBe(true);
    expect(result.copilotValidation.valid).toBe(true);
    expect(validateScript(result.copilot as MaaBattleScript).valid).toBe(true);
  });

  it("repairs duplicate End, bad delay, and invalid direction by dropping bad deploys", () => {
    const repaired = repairGeneratedScript({
      stageId: "TEST-1",
      score: 0,
      actions: [
        { type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Side", delay: 123 as never },
        { type: "SkillDaemon", delay: 123 as never },
        { type: "End", delay: 0 },
        { type: "End", delay: 0 },
      ],
    });

    expect(repaired.actions).toEqual([{ type: "SkillDaemon", delay: 250 }, { type: "End", delay: 0 }]);
    expect(validateBattleDsl({ stageId: repaired.stageId, actions: repaired.actions }).valid).toBe(true);
  });

  it("can serialize debug beam history", () => {
    const generated = generateBattleScript(input({ collectDebug: true }));

    expect(JSON.parse(JSON.stringify(generated.meta?.beamHistory))).toBeTruthy();
  });

  it("reuses a successful feedback script without expanding beam states", () => {
    const generated = generateBattleScript({
      ...input(),
      reusableSuccessScript: {
        stageId: "TEST-1",
        actions: [{ type: "SkillDaemon", delay: 0 }, { type: "End", delay: 0 }],
      },
    });

    expect(generated.meta?.reused).toBe(true);
    expect(generated.actions).toEqual([{ type: "SkillDaemon", delay: 0 }, { type: "End", delay: 0 }]);
  });

  it("deducts feedback penalty and hard rejects identical failed scripts", () => {
    const baseline = generateBattleScript(input());
    const similarFailed = buildScriptFingerprint({
      stageId: baseline.stageId,
      actions: [{ ...baseline.actions[0], delay: 500 }, { type: "End", delay: 0 }],
    });
    const penalized = generateBattleScript({ ...input(), failedFingerprints: [similarFailed] });
    const hardRejected = generateBattleScript({
      ...input(),
      failedFingerprints: [buildScriptFingerprint({ stageId: baseline.stageId, actions: baseline.actions })],
    });

    expect(Number(penalized.meta?.feedbackPenalty)).toBeGreaterThan(0);
    expect(penalized.score).toBeLessThan(Number(penalized.meta?.actionRankerCumulativeScore));
    expect(hardRejected.actions).not.toEqual(baseline.actions);
    expect(Number(hardRejected.meta?.hardRejectedCandidates)).toBeGreaterThan(0);
  });
});
