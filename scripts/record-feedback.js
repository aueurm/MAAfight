#!/usr/bin/env node
"use strict";

const fs = require("fs");

const MODEL_CORE_ENGINE_VERSION = "cpu-core-v0";
const RULE_CORE_ENGINE_VERSION = "v2-skill-v1";

function loadBattleDsl() {
  try {
    return require("../dist/model-core/battleDsl");
  } catch (error) {
    throw new Error("Build first: npm run build:node");
  }
}

function loadFeedbackCore() {
  try {
    return require("../dist/model-core/modelCoreFeedback");
  } catch (error) {
    throw new Error("Build first: npm run build:node");
  }
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`Expected boolean value, got: ${value}`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stageHash") options.stageHash = argv[++i];
    else if (arg === "--rosterHash") options.rosterHash = argv[++i];
    else if (arg === "--engineVersion") options.engineVersion = argv[++i];
    else if (arg === "--script") options.script = argv[++i];
    else if (arg === "--shadowReport") options.shadowReport = argv[++i];
    else if (arg === "--core") options.core = argv[++i];
    else if (arg === "--result") options.result = argv[++i];
    else if (arg === "--entered") options.enteredBattle = parseBoolean(argv[++i]);
    else if (arg === "--completed") options.completed = parseBoolean(argv[++i]);
    else if (arg === "--threeStar") options.threeStar = parseBoolean(argv[++i]);
    else if (arg === "--notes") options.notes = argv[++i];
    else if (arg === "--feedbackFile") options.feedbackFile = argv[++i];
    else if (arg === "--rejectedOut") options.rejectedOut = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log("Usage: npm run record-feedback -- --stageHash STAGE --rosterHash ROSTER --script copilot.json --result success|failure [--entered true --completed false --threeStar false]");
}

function rehearsalFromOptions(options) {
  const rehearsal = {};
  if (options.enteredBattle !== undefined) rehearsal.enteredBattle = options.enteredBattle;
  if (options.completed !== undefined) rehearsal.completed = options.completed;
  if (options.threeStar !== undefined) rehearsal.threeStar = options.threeStar;
  return Object.keys(rehearsal).length ? rehearsal : undefined;
}

function validateCoreOption(options) {
  if (options.core && !["rule-core", "model-core"].includes(options.core)) {
    throw new Error("--core must be rule-core or model-core");
  }
}

function defaultEngineVersion(options) {
  validateCoreOption(options);
  return options.engineVersion || (options.core === "rule-core" ? RULE_CORE_ENGINE_VERSION : MODEL_CORE_ENGINE_VERSION);
}

function applyShadowReport(options) {
  if (!options.shadowReport) return options;
  const report = JSON.parse(fs.readFileSync(options.shadowReport, "utf8"));
  const core = options.core || report.selectedCore;
  validateCoreOption({ core });
  const context = report.context || {};
  const paths = report.paths || {};
  return {
    ...options,
    core,
    stageHash: options.stageHash || context.stageHash,
    rosterHash: options.rosterHash || context.rosterHash,
    engineVersion: options.engineVersion || (
      core === "model-core"
        ? context.modelEngineVersion || MODEL_CORE_ENGINE_VERSION
        : context.ruleEngineVersion || defaultEngineVersion({ core })
    ),
    script: options.script || (core === "model-core" ? paths.modelCore : paths.ruleCore),
  };
}

function missingRequiredFields(options) {
  return ["stageHash", "rosterHash", "script", "result"].filter(key => !options[key]);
}

function main(argv = process.argv.slice(2)) {
  const options = applyShadowReport(parseArgs(argv));
  if (options.help) {
    printHelp();
    return null;
  }
  validateCoreOption(options);
  const missing = missingRequiredFields(options);
  if (missing.length) {
    if (options.shadowReport) {
      throw new Error(`Missing required feedback fields after applying --shadowReport: ${missing.join(", ")}`);
    }
    printHelp();
    return null;
  }
  if (!["success", "failure"].includes(options.result)) throw new Error("--result must be success or failure");

  const battleDsl = loadBattleDsl();
  const feedbackCore = loadFeedbackCore();
  const raw = JSON.parse(fs.readFileSync(options.script, "utf8"));
  const script = battleDsl.copilotJsonToBattleDsl(raw);
  const feedbackFile = options.feedbackFile || feedbackCore.DEFAULT_MODEL_CORE_FEEDBACK_PATH;
  const feedback = {
    stageHash: options.stageHash,
    rosterHash: options.rosterHash,
    engineVersion: defaultEngineVersion(options),
    scriptHash: feedbackCore.hashBattleScript(script),
    result: options.result,
    timestamp: new Date().toISOString(),
    script,
    rehearsal: rehearsalFromOptions(options),
    notes: options.notes,
  };
  feedbackCore.appendExecutionFeedback(feedback, feedbackFile);

  let rejectedCount = 0;
  const rejectedOut = options.rejectedOut || (options.result === "failure" ? feedbackCore.DEFAULT_REJECTED_SAMPLES_PATH : undefined);
  if (rejectedOut) {
    const records = feedbackCore.loadFeedbackForContext({
      stageHash: feedback.stageHash,
      rosterHash: feedback.rosterHash,
      engineVersion: feedback.engineVersion,
    }, feedbackFile);
    rejectedCount = feedbackCore.exportRejectedSamples(records, rejectedOut);
  }

  const fingerprint = feedbackCore.buildScriptFingerprint(script);
  const summary = {
    feedbackFile,
    stageHash: feedback.stageHash,
    rosterHash: feedback.rosterHash,
    engineVersion: feedback.engineVersion,
    scriptHash: feedback.scriptHash,
    result: feedback.result,
    rehearsal: feedback.rehearsal,
    firstThreeDeploys: fingerprint.firstThreeDeploys,
    deployCells: fingerprint.deployCells,
    directions: fingerprint.directions,
    delayBuckets: fingerprint.delayBuckets,
    rejectedCount,
    rejectedOut,
    sourceCore: options.core,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { applyShadowReport, defaultEngineVersion, main, missingRequiredFields, parseArgs, parseBoolean, validateCoreOption };
