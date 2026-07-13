import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { BattleScript } from "../src/model-core/battleDsl";
import {
  appendExecutionFeedback,
  buildScriptFingerprint,
  computeFeedbackPenalty,
  exportRejectedSamples,
  findReusableSuccessScript,
  hashBattleScript,
  loadExecutionFeedback,
  loadFeedbackForContext,
  type ExecutionFeedback,
} from "../src/model-core/modelCoreFeedback";

function script(actions: BattleScript["actions"] = [
  { type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 0 },
  { type: "Deploy", operatorId: "B", x: 2, y: 1, direction: "None", delay: 260 as never },
  { type: "Deploy", operatorId: "C", x: 3, y: 1, direction: "Left", delay: 900 as never },
  { type: "SkillDaemon", delay: 0 },
  { type: "End", delay: 0 },
]): BattleScript {
  return { stageId: "TEST-1", actions };
}

function feedback(overrides: Partial<ExecutionFeedback> = {}): ExecutionFeedback {
  const battleScript = overrides.script || script();
  return {
    stageHash: "stage",
    rosterHash: "roster",
    engineVersion: "cpu-core-v0",
    scriptHash: hashBattleScript(battleScript),
    result: "failure",
    timestamp: "2026-07-06T00:00:00.000Z",
    script: battleScript,
    ...overrides,
  };
}

describe("model-core feedback", () => {
  let cwd: string;
  let feedbackPath: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-model-core-feedback-"));
    feedbackPath = path.join(cwd, "feedback.jsonl");
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("builds stable fingerprints including None direction and delay buckets", () => {
    const fingerprint = buildScriptFingerprint(script());

    expect(fingerprint.scriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint.firstThreeDeploys).toEqual(["A@1,1:Right", "B@2,1:None", "C@3,1:Left"]);
    expect(fingerprint.deployCells).toEqual(["1,1", "2,1", "3,1"]);
    expect(fingerprint.directions).toEqual(["Right", "None", "Left"]);
    expect(fingerprint.operatorIds).toEqual(["A", "B", "C"]);
    expect(fingerprint.delayBuckets).toEqual([0, 500, 1000, 0, 0]);
    expect(fingerprint.skillStrategy).toBe("daemon=3;skill=");
  });

  it("hard rejects identical failed scripts and penalizes similar first deploys", () => {
    const failed = buildScriptFingerprint(script());
    const sameStart = script([
      { type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 500 },
      { type: "Deploy", operatorId: "B", x: 2, y: 1, direction: "None", delay: 500 },
      { type: "Deploy", operatorId: "C", x: 3, y: 1, direction: "Left", delay: 500 },
      { type: "End", delay: 0 },
    ]);

    expect(computeFeedbackPenalty(script(), [failed])).toBe(Number.POSITIVE_INFINITY);
    expect(computeFeedbackPenalty(sameStart, [failed])).toBeGreaterThan(50);
  });

  it("penalizes deploy cells, directions, and delay similarity without semantic guessing", () => {
    const failed = buildScriptFingerprint(script());
    const sameCells = script([
      { type: "Deploy", operatorId: "X", x: 1, y: 1, direction: "Up", delay: 250 },
      { type: "Deploy", operatorId: "Y", x: 2, y: 1, direction: "Down", delay: 750 },
      { type: "End", delay: 0 },
    ]);
    const sameDirections = script([
      { type: "Deploy", operatorId: "X", x: 5, y: 5, direction: "Right", delay: 250 },
      { type: "Deploy", operatorId: "Y", x: 6, y: 5, direction: "None", delay: 750 },
      { type: "End", delay: 0 },
    ]);
    const sameDelays = script([
      { type: "Deploy", operatorId: "X", x: 5, y: 5, direction: "Up", delay: 0 },
      { type: "Deploy", operatorId: "Y", x: 6, y: 5, direction: "Down", delay: 500 },
      { type: "End", delay: 100 as never },
    ]);

    expect(computeFeedbackPenalty(sameCells, [failed])).toBeGreaterThan(0);
    expect(computeFeedbackPenalty(sameDirections, [failed])).toBeGreaterThan(0);
    expect(computeFeedbackPenalty(sameDelays, [failed])).toBeGreaterThan(0);
  });

  it("loads context feedback, reuses matching success, and isolates other rosters", () => {
    appendExecutionFeedback(feedback({ result: "failure" }), feedbackPath);
    appendExecutionFeedback(feedback({
      result: "success",
      timestamp: "2026-07-06T00:01:00.000Z",
      script: script([{ type: "SkillDaemon", delay: 0 }, { type: "End", delay: 0 }]),
    }), feedbackPath);
    appendExecutionFeedback(feedback({ result: "success", rosterHash: "other" }), feedbackPath);

    const context = { stageHash: "stage", rosterHash: "roster", engineVersion: "cpu-core-v0" };
    const records = loadFeedbackForContext(context, feedbackPath);

    expect(records).toHaveLength(2);
    expect(findReusableSuccessScript({ ...context, feedback: records })?.actions[0].type).toBe("SkillDaemon");
    expect(findReusableSuccessScript({ ...context, rosterHash: "other", feedback: records })).toBeNull();
  });

  it("appends JSONL, returns empty for missing files, and exports rejected samples", () => {
    expect(loadExecutionFeedback(feedbackPath)).toEqual([]);

    appendExecutionFeedback(feedback({
      notes: "failed wave 2",
      rehearsal: { enteredBattle: true, completed: false, threeStar: false },
    }), feedbackPath);
    appendExecutionFeedback(feedback({ result: "success" }), feedbackPath);
    const records = loadExecutionFeedback(feedbackPath);
    const rejectedPath = path.join(cwd, "rejected_samples.jsonl");

    expect(records).toHaveLength(2);
    expect(exportRejectedSamples(records, rejectedPath)).toBe(1);
    const rejected = fs.readFileSync(rejectedPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    expect(rejected[0]).toMatchObject({
      stageId: "TEST-1",
      notes: "failed wave 2",
      rehearsal: { enteredBattle: true, completed: false, threeStar: false },
    });
    expect(rejected[0].fingerprint.firstThreeDeploys[0]).toBe("A@1,1:Right");
  });
});
