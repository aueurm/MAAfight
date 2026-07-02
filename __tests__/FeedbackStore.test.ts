import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FeedbackStore, hashOperatorBox } from "../src/feedback/FeedbackStore";
import type { BattleScript, PlayerOperator } from "../src/types";

function script(): BattleScript {
  return {
    stage_name: "TEST-1",
    minimum_required: "v6.0.0",
    actions: [{ type: "Deploy", name: "芬", location: [1, 2], direction: "Right", costs: 9 }],
    doc: { title: "test", details: "" },
    groups: [],
    opers: [{ name: "芬", skill: 1 }],
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
