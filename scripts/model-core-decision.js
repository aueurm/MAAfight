#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const options = {
    eval: "data/model-core/eval_report.json",
    feedback: "data/model-core/feedback.jsonl",
    shadowReports: [],
    shadowDirs: [],
    minRehearsals: 10,
    minShadowReports: 10,
    minTop5: 0.6,
    minValidatorPassRate: 0.9,
    minThreeStarRate: 0.5,
    minPostFailureDifferent: 1,
    minPostFailureSuccess: 1,
    modelEngineVersion: "cpu-core-v0",
    baselineEngineVersion: "v2-skill-v1",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--eval") options.eval = argv[++i];
    else if (arg === "--feedback") options.feedback = argv[++i];
    else if (arg === "--shadowReport") options.shadowReports.push(argv[++i]);
    else if (arg === "--shadowDir") options.shadowDirs.push(argv[++i]);
    else if (arg === "--minRehearsals") options.minRehearsals = Number.parseInt(argv[++i], 10);
    else if (arg === "--minShadowReports") options.minShadowReports = Number.parseInt(argv[++i], 10);
    else if (arg === "--minTop5") options.minTop5 = Number.parseFloat(argv[++i]);
    else if (arg === "--minValidatorPassRate") options.minValidatorPassRate = Number.parseFloat(argv[++i]);
    else if (arg === "--minShadowValidatorPassRate") options.minShadowValidatorPassRate = Number.parseFloat(argv[++i]);
    else if (arg === "--minThreeStarRate") options.minThreeStarRate = Number.parseFloat(argv[++i]);
    else if (arg === "--minBaselineRehearsals") options.minBaselineRehearsals = Number.parseInt(argv[++i], 10);
    else if (arg === "--minPostFailureDifferent") options.minPostFailureDifferent = Number.parseInt(argv[++i], 10);
    else if (arg === "--minPostFailureSuccess") options.minPostFailureSuccess = Number.parseInt(argv[++i], 10);
    else if (arg === "--modelEngineVersion") options.modelEngineVersion = argv[++i];
    else if (arg === "--baselineEngineVersion") options.baselineEngineVersion = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function shadowReportFiles(options) {
  const files = [...options.shadowReports];
  for (const dir of options.shadowDirs || []) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (/^shadow-report.*\.json$/i.test(entry)) files.push(`${dir}/${entry}`);
    }
  }
  return files;
}

function rate(count, total) {
  return total ? count / total : 0;
}

function feedbackLoopCounts(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.stageHash}\0${record.rosterHash}\0${record.engineVersion || "unknown"}`;
    groups.set(key, [...(groups.get(key) || []), record]);
  }
  let postFailureDifferentCount = 0;
  let postFailureSuccessCount = 0;
  for (const group of groups.values()) {
    const failedHashes = new Set();
    for (const record of group.sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || "")))) {
      if (failedHashes.size && !failedHashes.has(record.scriptHash)) {
        postFailureDifferentCount++;
        if (record.result === "success" || record.rehearsal?.threeStar) postFailureSuccessCount++;
      }
      if (record.result === "failure") failedHashes.add(record.scriptHash);
    }
  }
  return { postFailureDifferentCount, postFailureSuccessCount };
}

function summarizeRecords(records) {
  const rehearsals = records.filter(record => record.rehearsal);
  return {
    count: rehearsals.length,
    enteredRate: rate(rehearsals.filter(record => record.rehearsal.enteredBattle).length, rehearsals.length),
    completedRate: rate(rehearsals.filter(record => record.rehearsal.completed).length, rehearsals.length),
    threeStarRate: rate(rehearsals.filter(record => record.rehearsal.threeStar).length, rehearsals.length),
    successCount: records.filter(record => record.result === "success").length,
    failureCount: records.filter(record => record.result === "failure").length,
    ...feedbackLoopCounts(records),
  };
}

function feedbackSummary(records) {
  const byEngineVersion = {};
  for (const record of records) {
    const engine = record.engineVersion || "unknown";
    if (!byEngineVersion[engine]) byEngineVersion[engine] = summarizeRecords([]);
  }
  for (const engine of Object.keys(byEngineVersion)) {
    byEngineVersion[engine] = summarizeRecords(records.filter(record => (record.engineVersion || "unknown") === engine));
  }
  return {
    ...summarizeRecords(records),
    byEngineVersion,
  };
}

function shadowSummary(reports) {
  if (!reports.length) return { count: 0, modelValidatorPassRate: 0, firstThreeDifferentRate: 0 };
  const modelValid = reports.filter(report => report.modelCore?.validationPassed).length;
  const firstThreeDifferent = reports.filter(report =>
    JSON.stringify(report.ruleCore?.firstThree || []) !== JSON.stringify(report.modelCore?.firstThree || [])
  ).length;
  return {
    count: reports.length,
    modelValidatorPassRate: rate(modelValid, reports.length),
    firstThreeDifferentRate: rate(firstThreeDifferent, reports.length),
  };
}

function top5Of(section, fallback = 0) {
  if (!section) return fallback;
  return Number(section.metrics?.top5 ?? section.top5 ?? fallback);
}

function decision(evalReport, feedback, shadow, thresholds) {
  const top5 = Number(evalReport.metrics?.top5 || 0);
  const validatorPassRate = Number(evalReport.validator?.validatorPassRate || 0);
  const actionRankerTop5 = top5Of(evalReport.ablation?.actionRanker, top5);
  const handwrittenTop5 = top5Of(evalReport.ablation?.handwrittenScoring);
  const ruleProxyTop5 = top5Of(evalReport.ablation?.ruleCoreProxy);
  const beatsBaselines = actionRankerTop5 > Math.max(handwrittenTop5, ruleProxyTop5);
  const modelEngineVersion = thresholds.modelEngineVersion || "cpu-core-v0";
  const baselineEngineVersion = thresholds.baselineEngineVersion || "v2-skill-v1";
  const modelFeedback = feedback.byEngineVersion?.[modelEngineVersion] || summarizeRecords([]);
  const baselineFeedback = feedback.byEngineVersion?.[baselineEngineVersion] || summarizeRecords([]);
  const minBaselineRehearsals = thresholds.minBaselineRehearsals ?? thresholds.minRehearsals;
  const minShadowReports = thresholds.minShadowReports ?? 10;
  const minShadowValidatorPassRate = thresholds.minShadowValidatorPassRate ?? thresholds.minValidatorPassRate;
  const minPostFailureDifferent = thresholds.minPostFailureDifferent ?? 1;
  const minPostFailureSuccess = thresholds.minPostFailureSuccess ?? 1;

  const gates = {
    offlineTop5: top5 >= thresholds.minTop5,
    validatorReady: validatorPassRate >= thresholds.minValidatorPassRate,
    shadowEvidence: shadow.count >= minShadowReports,
    shadowValidatorReady: shadow.modelValidatorPassRate >= minShadowValidatorPassRate,
    enoughRehearsals: modelFeedback.count >= thresholds.minRehearsals,
    baselineEvidence: baselineFeedback.count >= minBaselineRehearsals,
    rehearsalStrong: modelFeedback.threeStarRate >= thresholds.minThreeStarRate,
    beatsManualBaseline: modelFeedback.threeStarRate > baselineFeedback.threeStarRate,
    postFailureDifferent: modelFeedback.postFailureDifferentCount >= minPostFailureDifferent,
    feedbackImproved: modelFeedback.postFailureSuccessCount >= minPostFailureSuccess,
    beatsBaselines,
  };

  let recommendation = "ready-to-consider-gbdt";
  let reason = "offline, validator, ablation, shadow, and rehearsal gates passed";
  if (!gates.offlineTop5) {
    recommendation = "fix-data-or-features";
    reason = "top-5 recall is below threshold";
  } else if (!gates.validatorReady) {
    recommendation = "fix-validator-or-candidates";
    reason = "validator pass rate is below threshold";
  } else if (!gates.beatsBaselines) {
    recommendation = "keep-linear-and-improve-features";
    reason = "action ranker does not beat rule/handwritten baselines";
  } else if (!gates.shadowEvidence) {
    recommendation = "continue-shadow-and-rehearsal";
    reason = "not enough shadow comparison reports";
  } else if (!gates.shadowValidatorReady) {
    recommendation = "fix-validator-or-candidates";
    reason = "model-core shadow validator pass rate is below threshold";
  } else if (!gates.enoughRehearsals) {
    recommendation = "continue-shadow-and-rehearsal";
    reason = "not enough model-core manual rehearsal evidence";
  } else if (!gates.baselineEvidence) {
    recommendation = "continue-shadow-and-rehearsal";
    reason = "not enough rule-core baseline rehearsal evidence";
  } else if (!gates.rehearsalStrong) {
    recommendation = "keep-feedback-loop-and-retrain";
    reason = "manual rehearsal three-star rate is below threshold";
  } else if (!gates.beatsManualBaseline) {
    recommendation = "keep-feedback-loop-and-retrain";
    reason = "model-core manual rehearsal rate does not beat rule-core baseline";
  } else if (!gates.postFailureDifferent) {
    recommendation = "keep-feedback-loop-and-retrain";
    reason = "not enough evidence that failed scripts regenerate differently";
  } else if (!gates.feedbackImproved) {
    recommendation = "keep-feedback-loop-and-retrain";
    reason = "not enough evidence that feedback improves later outcomes";
  }

  return {
    recommendation,
    reason,
    doNotUpgradeModel: recommendation !== "ready-to-consider-gbdt",
    gates,
    metrics: {
      top5,
      validatorPassRate,
      actionRankerTop5,
      handwrittenTop5,
      ruleProxyTop5,
    },
    feedback,
    modelFeedback,
    baselineFeedback,
    shadow,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: npm run model-core-decision -- --eval data/model-core/eval_report.json --feedback data/model-core/feedback.jsonl");
    return null;
  }
  const evalReport = readJson(options.eval);
  const feedback = feedbackSummary(readJsonl(options.feedback));
  const shadow = shadowSummary(shadowReportFiles(options).map(readJson));
  const report = decision(evalReport, feedback, shadow, options);
  const output = JSON.stringify(report, null, 2);
  if (options.out) {
    const outputPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${output}\n`, "utf8");
  }
  process.stdout.write(`${output}\n`);
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { decision, feedbackLoopCounts, feedbackSummary, main, parseArgs, shadowSummary };
