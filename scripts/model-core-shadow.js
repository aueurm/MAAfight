#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

function loadShadowCore() {
  try {
    return require("../dist/model-core/shadowCore");
  } catch {
    throw new Error("Build first: npm run build:node");
  }
}

function loadFeedbackCore() {
  try {
    return require("../dist/model-core/modelCoreFeedback");
  } catch {
    throw new Error("Build first: npm run build:node");
  }
}

function parseArgs(argv) {
  const options = { mode: "hybrid-core", outDir: "data/model-core/shadow", seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") options.mode = argv[++i];
    else if (arg === "--stage") options.stage = argv[++i];
    else if (arg === "--data") options.data = argv[++i];
    else if (arg === "--operators") options.operators = argv[++i];
    else if (arg === "--rule") options.rule = argv[++i];
    else if (arg === "--modelScript") options.modelScript = argv[++i];
    else if (arg === "--roster") options.roster = argv[++i];
    else if (arg === "--model") options.model = argv[++i];
    else if (arg === "--config") options.config = argv[++i];
    else if (arg === "--outDir") options.outDir = argv[++i];
    else if (arg === "--report") options.report = argv[++i];
    else if (arg === "--selectedOut") options.selectedOut = argv[++i];
    else if (arg === "--seed") options.seed = Number.parseInt(argv[++i], 10);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log("Usage: npm run shadow-core -- --stage STAGE --rule old.json --roster roster.json --model models/cpu-action-ranker.json");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  const outputPath = path.resolve(file);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return outputPath;
}

function safeName(value) {
  return String(value || "shadow")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "") || "shadow";
}

function outputStem(options) {
  if (options.stage) return safeName(options.stage);
  if (options.data) return safeName(path.basename(options.data, path.extname(options.data)));
  return "shadow";
}

function run(command, args, cwd) {
  cp.execFileSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });
}

function needsRule(mode) {
  return mode === "rule-core" || mode === "hybrid-core";
}

function needsModel(mode) {
  return mode === "model-core" || mode === "hybrid-core";
}

function makeRuleScript(options, root, outDir, stem) {
  if (options.rule) return path.resolve(options.rule);
  if (!options.stage && !options.data) throw new Error("--stage or --data is required to generate rule-core output");
  const output = path.join(outDir, `rule-core-${stem}.json`);
  const args = ["dist/index.js", "generate", "--output", output, "--quiet"];
  if (options.stage) args.push("--stage", options.stage);
  if (options.data) args.push("--data", options.data);
  if (options.operators) args.push("--operators", options.operators);
  run(process.execPath, args, root);
  return output;
}

function makeModelScript(options, root, outDir, stem) {
  if (options.modelScript) return path.resolve(options.modelScript);
  if (!options.stage || !options.roster || !options.model) {
    throw new Error("--stage, --roster, and --model are required to generate model-core output");
  }
  const output = path.join(outDir, `model-core-${stem}.json`);
  const args = [
    "scripts/generate-script.js",
    "--stage", options.stage,
    "--roster", options.roster,
    "--model", options.model,
    "--out", output,
    "--seed", String(options.seed),
  ];
  if (options.config) args.push("--config", options.config);
  run(process.execPath, args, root);
  return output;
}

function feedbackContext(options) {
  if (!options.stage || !options.roster) return undefined;
  const { loadRosterAndStage } = require("./generate-script");
  const feedbackCore = loadFeedbackCore();
  const { stageFeatures, rosterFeatures } = loadRosterAndStage(options.roster, options.stage);
  return {
    stageHash: feedbackCore.hashStable(stageFeatures),
    rosterHash: feedbackCore.hashStable(rosterFeatures),
    modelEngineVersion: feedbackCore.MODEL_CORE_ENGINE_VERSION,
    ruleEngineVersion: "v2-skill-v1",
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  if (!["rule-core", "model-core", "hybrid-core"].includes(options.mode)) throw new Error("--mode must be rule-core, model-core, or hybrid-core");

  const root = path.resolve(__dirname, "..");
  const outDir = path.resolve(options.outDir);
  const stem = outputStem(options);
  fs.mkdirSync(outDir, { recursive: true });
  const rulePath = needsRule(options.mode) ? makeRuleScript(options, root, outDir, stem) : undefined;
  const modelPath = needsModel(options.mode) ? makeModelScript(options, root, outDir, stem) : undefined;
  const shadow = loadShadowCore();
  const comparison = shadow.compareShadowScripts({
    mode: options.mode,
    ruleScript: rulePath ? readJson(rulePath) : undefined,
    modelScript: modelPath ? readJson(modelPath) : undefined,
  });
  const selectedPath = options.selectedOut || path.join(outDir, `selected-${stem}.json`);
  const selectedScript = comparison.selectedCore === "model-core" ? readJson(modelPath) : readJson(rulePath);
  writeJson(selectedPath, selectedScript);
  const report = {
    ...comparison,
    context: feedbackContext(options),
    paths: {
      ruleCore: rulePath,
      modelCore: modelPath,
      selected: path.resolve(selectedPath),
    },
  };
  const reportPath = writeJson(options.report || path.join(outDir, `shadow-report-${stem}.json`), report);
  process.stdout.write(`${JSON.stringify({
    report: reportPath,
    selectedCore: comparison.selectedCore,
    selectionReason: comparison.selectionReason,
    context: report.context,
  }, null, 2)}\n`);
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

module.exports = { main, parseArgs, outputStem, safeName };
