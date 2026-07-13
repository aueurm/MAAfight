#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function loadModelCore() {
  try {
    return require("../dist/model-core/beamSearch");
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
  return value === true || value === "true" || value === "1" || value === "yes";
}

function appendListValue(list, value) {
  return [...(list || []), ...String(value || "").split(",").map(item => item.trim()).filter(Boolean)];
}

function loadModelCoreConfig(file) {
  if (!file) return {};
  return readJson(file);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stage") options.stage = argv[++i];
    else if (arg === "--roster") options.roster = argv[++i];
    else if (arg === "--model") options.model = argv[++i];
    else if (arg === "--out" || arg === "--output") options.out = argv[++i];
    else if (arg === "--config") options.config = argv[++i];
    else if (arg === "--beamSize") options.beamSize = Number.parseInt(argv[++i], 10);
    else if (arg === "--topActionsPerState") options.topActionsPerState = Number.parseInt(argv[++i], 10);
    else if (arg === "--maxSteps") options.maxSteps = Number.parseInt(argv[++i], 10);
    else if (arg === "--candidateActionsPerState") options.candidateActionsPerState = Number.parseInt(argv[++i], 10);
    else if (arg === "--repeatPenalty") options.repeatPenalty = Number.parseFloat(argv[++i]);
    else if (arg === "--seed") options.seed = Number.parseInt(argv[++i], 10);
    else if (arg === "--dumpBeams") options.dumpBeams = argv[++i];
    else if (arg === "--dumpCandidates") options.dumpCandidates = argv[++i];
    else if (arg === "--excludeOperator") options.excludeOperators = appendListValue(options.excludeOperators, argv[++i]);
    else if (arg === "--excludeOperators") options.excludeOperators = appendListValue(options.excludeOperators, argv[++i]);
    else if (arg === "--useFeedback") {
      const next = argv[i + 1];
      options.useFeedback = next === undefined || next.startsWith("-") ? true : parseBoolean(argv[++i]);
    }
    else if (arg === "--feedbackFile") options.feedbackFile = argv[++i];
    else if (arg === "--stageHash") options.stageHash = argv[++i];
    else if (arg === "--rosterHash") options.rosterHash = argv[++i];
    else if (arg === "--engineVersion") options.engineVersion = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const config = loadModelCoreConfig(options.config);
  const beam = config.beamSearch || {};
  return {
    beamSize: options.beamSize ?? beam.beamSize ?? 8,
    topActionsPerState: options.topActionsPerState ?? beam.topActionsPerState ?? 16,
    maxSteps: options.maxSteps ?? beam.maxSteps ?? 16,
    candidateActionsPerState: options.candidateActionsPerState ?? beam.candidateActionsPerState ?? 500,
    repeatPenalty: options.repeatPenalty ?? beam.repeatPenalty ?? 1,
    seed: options.seed ?? 42,
    ...options,
  };
}

function printHelp() {
  console.log(`Usage: npm run generate-script -- --stage STAGE --roster roster.json --model models/cpu-action-ranker.json --out out/copilot.json [--config configs/model-core.json]`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function rosterFeature(item) {
  if (typeof item === "string") return { operatorId: item, name: item };
  const name = item && typeof item === "object" ? item.operatorId || item.name : null;
  return name ? { operatorId: name, name, ...item } : null;
}

function loadRosterAndStage(file, stageId) {
  const raw = readJson(file);
  const rosterItems = Array.isArray(raw)
    ? raw
    : raw.rosterFeatures || raw.opers || raw.operators || [];
  const rosterFeatures = rosterItems.map(rosterFeature).filter(Boolean);
  const stageFeatures = raw.stageFeatures || {
    stageId,
    stageName: stageId,
    rows: raw.rows,
    cols: raw.cols,
    map: raw.map || {},
    deploymentPoints: raw.deploymentPoints || raw.map?.deploymentPoints || [],
  };
  stageFeatures.stageId = stageFeatures.stageId || stageId;
  stageFeatures.stageName = stageFeatures.stageName || stageId;
  return { rosterFeatures, stageFeatures };
}

function operatorName(feature) {
  return String(feature?.operatorId || feature?.name || "").trim();
}

function filterExcludedRoster(rosterFeatures, excludeOperators = []) {
  const excluded = new Set(appendListValue([], excludeOperators.join(",")));
  if (!excluded.size) return rosterFeatures;
  return rosterFeatures.filter(feature => !excluded.has(operatorName(feature)));
}

function writeJson(file, value) {
  const outputPath = path.resolve(file);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return outputPath;
}

function writeJsonl(file, rows) {
  const outputPath = path.resolve(file);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  return outputPath;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.stage || !options.roster || !options.out) {
    printHelp();
    return null;
  }
  const { generateBattleScript, generatedScriptToCopilot } = loadModelCore();
  const feedbackCore = loadFeedbackCore();
  const loaded = loadRosterAndStage(options.roster, options.stage);
  const rosterFeatures = filterExcludedRoster(loaded.rosterFeatures, options.excludeOperators || []);
  const stageFeatures = loaded.stageFeatures;
  if (!rosterFeatures.length) throw new Error("No operators left after applying --excludeOperator");
  const stageHash = options.stageHash || feedbackCore.hashStable(stageFeatures);
  const rosterHash = options.rosterHash || feedbackCore.hashStable(rosterFeatures);
  const engineVersion = options.engineVersion || feedbackCore.MODEL_CORE_ENGINE_VERSION;
  let feedbackRecords = [];
  let reusableSuccessScript = null;
  let failedFingerprints = [];
  if (options.useFeedback) {
    feedbackRecords = feedbackCore.loadFeedbackForContext(
      { stageHash, rosterHash, engineVersion },
      options.feedbackFile || feedbackCore.DEFAULT_MODEL_CORE_FEEDBACK_PATH
    );
    reusableSuccessScript = feedbackCore.findReusableSuccessScript({ stageHash, rosterHash, engineVersion, feedback: feedbackRecords });
    failedFingerprints = feedbackCore.failedFingerprintsForContext({ stageHash, rosterHash, engineVersion, feedback: feedbackRecords });
  }
  const generated = generateBattleScript({
    stageId: options.stage,
    stageFeatures,
    rosterFeatures,
    rankerModelPath: options.model,
    reusableSuccessScript: reusableSuccessScript || undefined,
    failedFingerprints,
    config: {
      beamSize: options.beamSize,
      topActionsPerState: options.topActionsPerState,
      maxSteps: options.maxSteps,
      candidateActionsPerState: options.candidateActionsPerState,
      seed: options.seed,
      collectDebug: Boolean(options.dumpBeams || options.dumpCandidates),
    },
  });
  const result = generatedScriptToCopilot(generated, rosterFeatures, { stageFeatures, rosterFeatures });
  const outputPath = writeJson(options.out, result.copilot);
  if (options.dumpBeams) writeJson(options.dumpBeams, generated.meta?.beamHistory || []);
  if (options.dumpCandidates) writeJsonl(options.dumpCandidates, generated.meta?.candidateLog || []);
  const summary = {
    stageId: options.stage,
    beamSize: options.beamSize,
    maxSteps: options.maxSteps,
    generatedActionCount: generated.actions.length,
    ended: generated.actions.at(-1)?.type === "End",
    score: generated.score,
    validationPassed: result.dslValidation.valid && result.copilotValidation.valid,
    repaired: result.repaired,
    reused: Boolean(generated.meta?.reused),
    feedbackRecords: feedbackRecords.length,
    feedbackPenalty: generated.meta?.feedbackPenalty,
    stageHash,
    rosterHash,
    engineVersion,
    excludedOperators: options.excludeOperators || [],
    output: outputPath,
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

module.exports = { main, parseArgs, loadModelCoreConfig, loadRosterAndStage, filterExcludedRoster };
