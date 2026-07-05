import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FeedbackStore, extractScriptFingerprint, fingerprintPenalty, hashOperatorBox } from "../src/feedback/FeedbackStore";
import type { BattleScript, PlayerOperator } from "../src/types";

function script(location: [number, number] = [1, 2], direction = "Right"): BattleScript {
  return {
    stage_name: "TEST-1",
    minimum_required: "v6.0.0",
    actions: [{ type: "Deploy", name: "芬", location, direction, costs: 9 }],
    doc: { title: "test", details: "" },
    groups: [],
    opers: [{ name: "芬", skill: 1 }],
    generatedAt: "2026-06-18T00:00:00.000Z",
    metadata: { source: "test" },
    version: 3,
  };
}

function scriptWithDeploys(
  deploys: Array<{ name: string; location: [number, number]; direction: string; pre_delay?: number }>,
  skillStrategy: "daemon" | "none" | "manual" | "mixed" = "daemon"
): BattleScript {
  const actions: BattleScript["actions"] = deploys.map(deploy => ({
    type: "Deploy",
    name: deploy.name,
    location: deploy.location,
    direction: deploy.direction,
    costs: 10,
    ...(deploy.pre_delay ? { pre_delay: deploy.pre_delay } : {}),
  }));
  if (skillStrategy === "manual" || skillStrategy === "mixed") {
    actions.push({ type: "Skill", name: deploys[0]?.name || "芬", pre_delay: 15000 });
  }
  if (skillStrategy === "daemon" || skillStrategy === "mixed") actions.push({ type: "SkillDaemon" });
  return {
    stage_name: "TEST-1",
    minimum_required: "v6.0.0",
    actions,
    doc: { title: "test", details: "" },
    groups: [],
    opers: deploys.map(deploy => ({ name: deploy.name, skill: 1 })),
    generatedAt: "2026-06-18T00:00:00.000Z",
    metadata: { source: "test" },
    version: 3,
  };
}

describe("FeedbackStore", () => {
  let cwd: string;
  let store: FeedbackStore;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-feedback-"));
    store = new FeedbackStore(cwd);
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("should exclude partial scripts and reuse full clear scripts", () => {
    const box = new Map<string, PlayerOperator>([["芬", { id: "fen", name: "芬", rarity: 3, own: true, elite: 1, level: 55, potential: 6 }]]);
    const boxHash = hashOperatorBox(box);
    const base = script();
    store.appendGeneration({
      schemaVersion: 1,
      generationId: "generation-1",
      scriptHash: "hash-1",
      stageId: "stage-1",
      stageName: "TEST-1",
      operatorBoxHash: boxHash,
      engineVersion: "v2",
      modelVersion: "model",
      combatDataVersion: "combat",
      candidateScore: 70,
      scoreBreakdown: { combat: 70 },
      combatCoverage: 0,
      enemyTotal: 10,
      outputPath: "",
      script: base,
      createdAt: "2026-06-18T00:00:00.000Z",
    });
    store.recordFeedback({ scriptHash: "hash-1", killed: 8, currentOperatorBoxHash: boxHash });
    expect(store.excludedHashes("stage-1", boxHash)).toContain("hash-1");
    expect(store.excludedHashes("stage-1", boxHash, undefined, "v2")).toContain("hash-1");
    expect(store.excludedHashes("stage-1", boxHash, undefined, "v3")).not.toContain("hash-1");
    expect(store.successfulGeneration("stage-1", boxHash)).toBeUndefined();

    store.recordFeedback({ scriptHash: "hash-1", killed: 10, currentOperatorBoxHash: boxHash });
    expect(store.successfulGeneration("stage-1", boxHash)?.generationId).toBe("generation-1");
    expect(store.summary("stage-1")).toMatchObject({ count: 2, usableCount: 2, fullClearCount: 1 });
  });

  it("should keep changed operator-box feedback out of learning", () => {
    store.appendGeneration({
      schemaVersion: 1,
      generationId: "generation-2",
      scriptHash: "hash-2",
      stageId: "stage-2",
      stageName: "TEST-2",
      operatorBoxHash: "old-box",
      engineVersion: "v2",
      modelVersion: "model",
      combatDataVersion: "combat",
      candidateScore: 60,
      scoreBreakdown: {},
      combatCoverage: 0,
      enemyTotal: 5,
      outputPath: "",
      script: script(),
      createdAt: "2026-06-18T00:00:00.000Z",
    });
    const record = store.recordFeedback({ scriptHash: "hash-2", killed: 5, currentOperatorBoxHash: "new-box" });
    expect(record.operatorBoxChanged).toBe(true);
    expect(record.usableForLearning).toBe(false);
    expect(store.successfulGeneration("stage-2", "old-box")).toBeUndefined();
  });

  it("extracts script fingerprints used for failure similarity", () => {
    const fingerprint = extractScriptFingerprint(scriptWithDeploys([
      { name: "芬", location: [1, 2], direction: "Right" },
      { name: "克洛丝", location: [2, 3], direction: "Left", pre_delay: 500 },
      { name: "米格鲁", location: [3, 4], direction: "Down", pre_delay: 1500 },
    ], "mixed"), "hash-fp");

    expect(fingerprint).toMatchObject({
      scriptHash: "hash-fp",
      firstDeploy: "芬@1,2:Right",
      firstThreeDeploys: ["芬@1,2:Right", "克洛丝@2,3:Left", "米格鲁@3,4:Down"],
      deployCells: ["1,2", "2,3", "3,4"],
      deployDirections: ["Right", "Left", "Down"],
      operatorIds: ["克洛丝", "米格鲁", "芬"],
      timingBucket: "0|1|2",
      skillStrategy: "mixed",
    });
  });

  it("converts similar failed feedback into a bounded fingerprint penalty only", () => {
    const failed = scriptWithDeploys([
      { name: "芬", location: [1, 2], direction: "Right" },
      { name: "克洛丝", location: [2, 3], direction: "Left", pre_delay: 500 },
      { name: "米格鲁", location: [3, 4], direction: "Down", pre_delay: 1500 },
    ], "daemon");
    store.appendGeneration({
      schemaVersion: 2,
      generationId: "generation-penalty",
      scriptHash: "hash-penalty",
      stageId: "stage-penalty",
      stageName: "TEST-PENALTY",
      operatorBoxHash: "box",
      engineVersion: "v2-skill-v1",
      modelVersion: "model",
      combatDataVersion: "combat",
      candidateScore: 70,
      scoreBreakdown: {
        publicPrior: 80,
        placement: 70,
        direction: 60,
        timing: 90,
        operatorPower: 50,
        feedbackPenalty: 0,
      },
      combatCoverage: 1,
      stageContentHash: "stage-hash",
      enemyTotal: 10,
      outputPath: "",
      script: failed,
      createdAt: "2026-06-18T00:00:00.000Z",
    });
    store.recordFeedback({ scriptHash: "hash-penalty", killed: 5, currentOperatorBoxHash: "box" });

    const breakdown = {
      publicPrior: 80,
      placement: 70,
      direction: 60,
      timing: 90,
      operatorPower: 50,
      feedbackPenalty: 0,
    };
    const similar = scriptWithDeploys([
      { name: "芬", location: [1, 2], direction: "Right" },
      { name: "克洛丝", location: [2, 3], direction: "Left", pre_delay: 500 },
      { name: "米格鲁", location: [3, 4], direction: "Down", pre_delay: 1500 },
    ], "daemon");
    const far = scriptWithDeploys([
      { name: "夜刀", location: [8, 8], direction: "Up", pre_delay: 9000 },
      { name: "安赛尔", location: [9, 9], direction: "Right", pre_delay: 12000 },
      { name: "黑角", location: [10, 10], direction: "Left", pre_delay: 15000 },
    ], "manual");
    const penalty = store.feedbackPenalty("stage-penalty", "box", breakdown, "stage-hash", similar, "v2-skill-v1", "hash-new");
    const farPenalty = store.feedbackPenalty("stage-penalty", "box", breakdown, "stage-hash", far, "v2-skill-v1", "hash-far");

    expect(penalty).toBeGreaterThan(6);
    expect(farPenalty).toBeLessThan(2);
    expect(store.feedbackAdjustment("stage-penalty", "box", breakdown, "stage-hash")).toBeLessThan(0);
    expect(store.feedbackPenalty("stage-penalty", "box", breakdown, "stage-hash", similar, "other-engine", "hash-new")).toBe(0);
  });

  it("caps repeated similar failure penalties", () => {
    const failed = scriptWithDeploys([
      { name: "芬", location: [1, 2], direction: "Right" },
      { name: "克洛丝", location: [2, 3], direction: "Left" },
      { name: "米格鲁", location: [3, 4], direction: "Down" },
    ]);
    for (let index = 0; index < 3; index++) {
      store.appendGeneration({
        schemaVersion: 2,
        generationId: `generation-cap-${index}`,
        scriptHash: `hash-cap-${index}`,
        stageId: "stage-cap",
        stageName: "TEST-CAP",
        operatorBoxHash: "box",
        engineVersion: "v2-skill-v1",
        modelVersion: "model",
        combatDataVersion: "combat",
        candidateScore: 70,
        scoreBreakdown: { timing: 90 },
        combatCoverage: 1,
        stageContentHash: "stage-hash",
        enemyTotal: 10,
        outputPath: "",
        script: failed,
        createdAt: "2026-06-18T00:00:00.000Z",
      });
      store.recordFeedback({ scriptHash: `hash-cap-${index}`, killed: 0, currentOperatorBoxHash: "box" });
    }

    expect(store.feedbackPenalty(
      "stage-cap",
      "box",
      { timing: 90 },
      "stage-hash",
      failed,
      "v2-skill-v1",
      "new-hash"
    )).toBeLessThanOrEqual(18);
  });

  it("computes exact hash and component fingerprint penalties", () => {
    const failed = extractScriptFingerprint(script(), "same");
    const same = extractScriptFingerprint(script(), "same");
    const similar = extractScriptFingerprint(script(), "other");

    expect(fingerprintPenalty(same, failed)).toBe(20);
    expect(fingerprintPenalty(similar, failed)).toBeLessThanOrEqual(18);
    expect(fingerprintPenalty(similar, failed)).toBeGreaterThan(0);
  });

  it("summarizes feedback across internal variants of the same displayed stage", () => {
    const base = {
      schemaVersion: 2 as const,
      stageName: "11-7",
      operatorBoxHash: "box",
      engineVersion: "v2",
      modelVersion: "model",
      combatDataVersion: "combat",
      candidateScore: 70,
      scoreBreakdown: {},
      combatCoverage: 0,
      enemyTotal: 10,
      outputPath: "",
      script: script(),
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    store.appendGeneration({ ...base, generationId: "old", scriptHash: "old-hash", stageId: "easy_11-06" });
    store.appendGeneration({ ...base, generationId: "new", scriptHash: "new-hash", stageId: "main_11-06" });
    store.recordFeedback({ scriptHash: "old-hash", killed: 8, currentOperatorBoxHash: "box" });
    store.recordFeedback({ scriptHash: "new-hash", killed: 10, currentOperatorBoxHash: "box" });

    expect(store.summary("main_11-06")).toMatchObject({ count: 2, usableCount: 2, fullClearCount: 1 });
    expect(store.summary("11-7")).toMatchObject({ count: 2, usableCount: 2, fullClearCount: 1 });
  });

  it("records practice test results as learnable feedback", () => {
    store.appendGeneration({
      schemaVersion: 2,
      generationId: "generation-practice",
      scriptHash: "hash-practice",
      stageId: "stage-practice",
      stageName: "TEST-PRACTICE",
      operatorBoxHash: "default-loadout",
      engineVersion: "v2-skill-v1",
      modelVersion: "model",
      combatDataVersion: "combat",
      candidateScore: 80,
      scoreBreakdown: { combat: 80 },
      combatCoverage: 1,
      enemyTotal: 10,
      outputPath: "",
      script: script(),
      createdAt: "2026-06-20T00:00:00.000Z",
    });

    expect(store.recordPracticeTestResult({
      scriptHash: "hash-practice",
      testResult: "进入失败",
      currentOperatorBoxHash: "default-loadout",
    })).toBeNull();
    expect(store.recordPracticeTestResult({
      scriptHash: "hash-practice",
      testResult: "二星",
      currentOperatorBoxHash: "default-loadout",
    })?.ratio).toBe(0.7);
    expect(store.recordPracticeTestResult({
      scriptHash: "hash-practice",
      testResult: "三星",
      currentOperatorBoxHash: "default-loadout",
    })?.ratio).toBe(1);
    expect(store.excludedHashes("stage-practice", "default-loadout")).toContain("hash-practice");
    expect(store.successfulGeneration("stage-practice", "default-loadout")?.generationId).toBe("generation-practice");
  });

  it("includes cost in player hashes and isolates successful reuse by revision", () => {
    const first = new Map<string, PlayerOperator>([["芬", {
      id: "fen", name: "芬", rarity: 3, own: true, elite: 2, level: 55, potential: 6, cost: 9,
    }]]);
    const second = new Map<string, PlayerOperator>([["芬", {
      id: "fen", name: "芬", rarity: 3, own: true, elite: 2, level: 55, potential: 6, cost: 10,
    }]]);
    expect(hashOperatorBox(first)).not.toBe(hashOperatorBox(second));

    const boxHash = hashOperatorBox(first);
    store.appendGeneration({
      schemaVersion: 2,
      generationId: "generation-revision",
      scriptHash: "hash-revision",
      stageId: "stage-revision",
      stageName: "TEST-REVISION",
      operatorBoxHash: boxHash,
      engineVersion: "v2-skill-v1",
      modelVersion: "model",
      combatDataVersion: "combat",
      candidateScore: 80,
      scoreBreakdown: { combat: 80 },
      combatCoverage: 1,
      skillCoverage: 0.5,
      stageContentHash: "stage-hash",
      gameDataCommit: "game-data",
      enemyTotal: 10,
      outputPath: "",
      script: script(),
      createdAt: "2026-06-20T00:00:00.000Z",
    });
    store.recordFeedback({ scriptHash: "hash-revision", killed: 10, currentOperatorBoxHash: boxHash });
    expect(store.successfulGeneration("stage-revision", boxHash, {
      engineVersion: "v2-skill-v1", stageContentHash: "stage-hash", gameDataCommit: "game-data",
    })?.generationId).toBe("generation-revision");
    expect(store.successfulGeneration("stage-revision", boxHash, {
      engineVersion: "v2-skill-v1", stageContentHash: "changed", gameDataCommit: "game-data",
    })).toBeUndefined();
  });

  it("should skip malformed JSONL lines", () => {
    fs.mkdirSync(path.dirname(store.feedbackPath), { recursive: true });
    fs.writeFileSync(store.feedbackPath, "not-json\n", "utf8");
    expect(store.loadFeedback().warnings).toHaveLength(1);
  });
});
