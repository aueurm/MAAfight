import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const decisionTool = require("../scripts/model-core-decision");

function evalReport(top5 = 0.7, validatorPassRate = 0.95, rankerTop5 = 0.8, baselineTop5 = 0.7) {
  return {
    metrics: { top5 },
    validator: { validatorPassRate },
    ablation: {
      actionRanker: { metrics: { top5: rankerTop5 } },
      handwrittenScoring: { metrics: { top5: baselineTop5 } },
      ruleCoreProxy: { metrics: { top5: baselineTop5 } },
    },
  };
}

function feedbackRecords(count: number, threeStar = true, engineVersion = "cpu-core-v0") {
  return Array.from({ length: count }, (_, index) => ({
    stageHash: `stage-${index}`,
    rosterHash: "roster",
    engineVersion,
    scriptHash: `${engineVersion}-script-${index}`,
    result: threeStar ? "success" : "failure",
    timestamp: "2026-07-06T00:00:00.000Z",
    script: { stageId: "TEST", actions: [] },
    rehearsal: { enteredBattle: true, completed: true, threeStar },
  }));
}

function modelFeedbackWithLoop() {
  const records = feedbackRecords(10, true, "cpu-core-v0");
  records[0] = {
    ...records[0],
    stageHash: "loop-stage",
    scriptHash: "failed-script",
    result: "failure",
    rehearsal: { enteredBattle: true, completed: false, threeStar: false },
  };
  records[1] = {
    ...records[1],
    stageHash: "loop-stage",
    scriptHash: "later-success",
    result: "success",
    timestamp: "2026-07-06T00:01:00.000Z",
  };
  return records;
}

function shadowReports(count: number, modelValid = true) {
  return Array.from({ length: count }, (_, index) => ({
    ruleCore: { firstThree: [`A${index}@1,1:Right`], validationPassed: true },
    modelCore: { firstThree: [`B${index}@2,1:Left`], validationPassed: modelValid },
  }));
}

describe("model-core decision", () => {
  it("recommends fixing data/features when offline top5 is low", () => {
    const report = decisionTool.decision(evalReport(0.4), decisionTool.feedbackSummary([]), decisionTool.shadowSummary([]), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("fix-data-or-features");
    expect(report.doNotUpgradeModel).toBe(true);
  });

  it("keeps shadow mode when offline gates pass but rehearsals are missing", () => {
    const report = decisionTool.decision(evalReport(), decisionTool.feedbackSummary(feedbackRecords(2)), decisionTool.shadowSummary(shadowReports(10)), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("continue-shadow-and-rehearsal");
  });

  it("keeps shadow mode when shadow comparison reports are missing", () => {
    const feedback = [
      ...feedbackRecords(10, true, "cpu-core-v0"),
      ...feedbackRecords(10, false, "v2-skill-v1"),
    ];
    const report = decisionTool.decision(evalReport(), decisionTool.feedbackSummary(feedback), decisionTool.shadowSummary([]), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("continue-shadow-and-rehearsal");
    expect(report.reason).toContain("shadow");
  });

  it("blocks upgrade when model-core shadow validation is weak", () => {
    const feedback = [
      ...feedbackRecords(10, true, "cpu-core-v0"),
      ...feedbackRecords(10, false, "v2-skill-v1"),
    ];
    const report = decisionTool.decision(evalReport(), decisionTool.feedbackSummary(feedback), decisionTool.shadowSummary(shadowReports(10, false)), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("fix-validator-or-candidates");
    expect(report.gates.shadowValidatorReady).toBe(false);
  });

  it("keeps shadow mode when the rule-core rehearsal baseline is missing", () => {
    const report = decisionTool.decision(evalReport(), decisionTool.feedbackSummary(feedbackRecords(10)), decisionTool.shadowSummary(shadowReports(10)), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("continue-shadow-and-rehearsal");
    expect(report.reason).toContain("baseline");
  });

  it("only allows considering GBDT when all conservative gates pass", () => {
    const feedback = [
      ...modelFeedbackWithLoop(),
      ...feedbackRecords(10, false, "v2-skill-v1"),
    ];
    const report = decisionTool.decision(evalReport(), decisionTool.feedbackSummary(feedback), decisionTool.shadowSummary(shadowReports(10)), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("ready-to-consider-gbdt");
    expect(report.doNotUpgradeModel).toBe(false);
  });

  it("keeps feedback loop when failures have not led to different successful scripts", () => {
    const feedback = [
      ...feedbackRecords(10, true, "cpu-core-v0"),
      ...feedbackRecords(10, false, "v2-skill-v1"),
    ];
    const report = decisionTool.decision(evalReport(), decisionTool.feedbackSummary(feedback), decisionTool.shadowSummary(shadowReports(10)), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("keep-feedback-loop-and-retrain");
    expect(report.gates.postFailureDifferent).toBe(false);
  });

  it("keeps feedback loop when regenerated scripts differ but still have no later success", () => {
    const modelFeedback = feedbackRecords(10, true, "cpu-core-v0");
    modelFeedback[0] = {
      ...modelFeedback[0],
      stageHash: "loop-stage",
      scriptHash: "failed-script",
      result: "failure",
      rehearsal: { enteredBattle: true, completed: false, threeStar: false },
    };
    modelFeedback[1] = {
      ...modelFeedback[1],
      stageHash: "loop-stage",
      scriptHash: "different-failure",
      result: "failure",
      timestamp: "2026-07-06T00:01:00.000Z",
      rehearsal: { enteredBattle: true, completed: false, threeStar: false },
    };
    const report = decisionTool.decision(evalReport(), decisionTool.feedbackSummary([
      ...modelFeedback,
      ...feedbackRecords(10, false, "v2-skill-v1"),
    ]), decisionTool.shadowSummary(shadowReports(10)), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("keep-feedback-loop-and-retrain");
    expect(report.gates.postFailureDifferent).toBe(true);
    expect(report.gates.feedbackImproved).toBe(false);
  });

  it("reads direct ablation metric shape from eval_ranker output", () => {
    const directEvalReport = {
      metrics: { top5: 0.8 },
      validator: { validatorPassRate: 0.95 },
      ablation: {
        actionRanker: { top5: 0.8 },
        handwrittenScoring: { top5: 0.85 },
        ruleCoreProxy: { top5: 0.7 },
      },
    };
    const report = decisionTool.decision(directEvalReport, decisionTool.feedbackSummary(feedbackRecords(10)), decisionTool.shadowSummary([]), {
      minTop5: 0.6,
      minValidatorPassRate: 0.9,
      minRehearsals: 10,
      minThreeStarRate: 0.5,
    });

    expect(report.recommendation).toBe("keep-linear-and-improve-features");
    expect(report.metrics.handwrittenTop5).toBe(0.85);
  });

  it("CLI reads eval, feedback, and shadow reports", () => {
    const root = path.resolve(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-decision-"));
    const evalPath = path.join(tmp, "eval.json");
    const feedbackPath = path.join(tmp, "feedback.jsonl");
    const shadowPath = path.join(tmp, "shadow.json");
    const outPath = path.join(tmp, "reports", "decision.json");

    try {
      fs.writeFileSync(evalPath, JSON.stringify(evalReport(0.7, 0.95, 0.8, 0.7)), "utf8");
      const feedback = [
        ...modelFeedbackWithLoop(),
        ...feedbackRecords(10, false, "v2-skill-v1"),
      ];
      fs.writeFileSync(feedbackPath, feedback.map(row => JSON.stringify(row)).join("\n"), "utf8");
      fs.writeFileSync(shadowPath, JSON.stringify({
        ruleCore: { firstThree: ["A@1,1:Right"], validationPassed: true },
        modelCore: { firstThree: ["B@2,1:Left"], validationPassed: true },
      }), "utf8");
      const output = cp.execFileSync(process.execPath, [
        "scripts/model-core-decision.js",
        "--eval", evalPath,
        "--feedback", feedbackPath,
        "--shadowReport", shadowPath,
        "--minShadowReports", "1",
        "--out", outPath,
      ], { cwd: root, encoding: "utf8" });
      const report = JSON.parse(output);
      const savedReport = JSON.parse(fs.readFileSync(outPath, "utf8"));

      expect(report.recommendation).toBe("ready-to-consider-gbdt");
      expect(savedReport.recommendation).toBe(report.recommendation);
      expect(report.shadow).toMatchObject({ count: 1, modelValidatorPassRate: 1, firstThreeDifferentRate: 1 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("CLI can read multiple shadow reports from a directory", () => {
    const root = path.resolve(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-decision-dir-"));
    const evalPath = path.join(tmp, "eval.json");
    const feedbackPath = path.join(tmp, "feedback.jsonl");
    const shadowDir = path.join(tmp, "shadow");

    try {
      fs.mkdirSync(shadowDir, { recursive: true });
      fs.writeFileSync(evalPath, JSON.stringify(evalReport(0.7, 0.95, 0.8, 0.7)), "utf8");
      const feedback = [
        ...modelFeedbackWithLoop(),
        ...feedbackRecords(10, false, "v2-skill-v1"),
      ];
      fs.writeFileSync(feedbackPath, feedback.map(row => JSON.stringify(row)).join("\n"), "utf8");
      for (let index = 0; index < 2; index++) {
        fs.writeFileSync(path.join(shadowDir, `shadow-report-${index}.json`), JSON.stringify({
          ruleCore: { firstThree: [`A${index}@1,1:Right`], validationPassed: true },
          modelCore: { firstThree: [`B${index}@2,1:Left`], validationPassed: true },
        }), "utf8");
      }
      fs.writeFileSync(path.join(shadowDir, "selected.json"), JSON.stringify({ actions: [] }), "utf8");
      const output = cp.execFileSync(process.execPath, [
        "scripts/model-core-decision.js",
        "--eval", evalPath,
        "--feedback", feedbackPath,
        "--shadowDir", shadowDir,
        "--minShadowReports", "2",
      ], { cwd: root, encoding: "utf8" });
      const report = JSON.parse(output);

      expect(report.recommendation).toBe("ready-to-consider-gbdt");
      expect(report.shadow.count).toBe(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
