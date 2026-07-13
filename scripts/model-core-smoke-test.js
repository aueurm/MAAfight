#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function parseArgs(argv) {
  const options = { skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workDir") options.workDir = argv[++i];
    else if (arg === "--skipBuild") options.skipBuild = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(command, args, cwd) {
  cp.execFileSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });
}

function runJson(command, args, cwd) {
  const output = cp.execFileSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });
  const start = output.lastIndexOf("\n{");
  return JSON.parse(output.slice(start >= 0 ? start + 1 : 0));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fixtureCopilot() {
  return {
    stage_name: "TEST-SMOKE",
    minimum_required: "v6.0.0",
    doc: { title: "model-core smoke", details: "" },
    opers: [{ name: "A" }, { name: "B" }],
    groups: [],
    version: 3,
    actions: [
      { type: "SpeedUp" },
      { type: "Deploy", name: "A", location: [1, 1], direction: "Right" },
      { type: "Deploy", name: "B", location: [2, 1], direction: "None", pre_delay: 260 },
      { type: "SkillDaemon" },
    ],
  };
}

function fixtureFeature() {
  return {
    id: 1,
    operatorNames: ["A", "B"],
    map: {
      rows: 4,
      cols: 4,
      deploymentPoints: [
        { x: 1, y: 1, buildableType: "all" },
        { x: 2, y: 1, buildableType: "all" },
        { x: 3, y: 1, buildableType: "all" },
      ],
    },
  };
}

function prepare(workDir) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(workDir, "corpus-input", "corpus"), { recursive: true });
  writeJson(path.join(workDir, "copilot.json"), fixtureCopilot());
  writeJson(path.join(workDir, "corpus-input", "corpus", "1.json"), fixtureCopilot());
  writeJson(path.join(workDir, "corpus-input", "features.json"), [fixtureFeature()]);
  fs.writeFileSync(path.join(workDir, "rejected_samples.jsonl"), `${JSON.stringify({
    stageId: "TEST-SMOKE",
    stageHash: "toy-stage",
    rosterHash: "toy-roster",
    engineVersion: "cpu-core-v0",
    scriptHash: "failed-script",
    fingerprint: {},
    actions: [
      { type: "Deploy", operatorId: "B", x: 3, y: 1, direction: "Down", delay: 0 },
    ],
  })}\n`, "utf8");
  writeJson(path.join(workDir, "roster.json"), {
    stageFeatures: {
      stageId: "TEST-SMOKE",
      rows: 4,
      cols: 4,
      deploymentPoints: fixtureFeature().map.deploymentPoints,
    },
    rosterFeatures: [{ operatorId: "A", name: "A" }, { operatorId: "B", name: "B" }],
  });
}

function build(cwd) {
  run(process.execPath, ["scripts/clean-dist.js"], cwd);
  run(process.execPath, ["node_modules/typescript/bin/tsc"], cwd);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: npm run model-core-smoke-test -- [-- --workDir tmp/model-core-smoke]");
    return null;
  }

  const cwd = path.resolve(__dirname, "..");
  if (!options.skipBuild) build(cwd);
  const workDir = path.resolve(options.workDir || fs.mkdtempSync(path.join(os.tmpdir(), "maafight-model-core-smoke-")));
  prepare(workDir);

  const copilot = path.join(workDir, "copilot.json");
  const roundtrip = path.join(workDir, "roundtrip.json");
  const dataset = path.join(workDir, "dataset");
  const model = path.join(workDir, "cpu-action-ranker.json");
  const evalReport = path.join(workDir, "eval_report.json");
  const generated = path.join(workDir, "generated.json");
  const rejectedSamples = path.join(workDir, "rejected_samples.jsonl");

  const battleDsl = runJson(process.execPath, ["scripts/battle-dsl.js", "--input", copilot, "--output", roundtrip], cwd);
  const candidateReport = runJson(process.execPath, ["scripts/enumerate-candidates.js", "--job", copilot, "--step", "1", "--maxCandidates", "20", "--seed", "42"], cwd);
  const datasetReport = runJson(process.execPath, ["scripts/build-action-dataset.js", "--input", path.join(workDir, "corpus-input"), "--out", dataset, "--negativeCount", "4", "--validRatio", "0", "--seed", "42", "--rejectedSamples", rejectedSamples], cwd);
  run(process.env.PYTHON || "python", ["scripts/model-core/train_linear_ranker.py", "--train", path.join(dataset, "train.jsonl"), "--valid", path.join(dataset, "train.jsonl"), "--out", model, "--epochs", "1", "--seed", "42"], cwd);
  run(process.env.PYTHON || "python", ["scripts/model-core/eval_ranker.py", "--model", model, "--valid", path.join(dataset, "train.jsonl"), "--out", evalReport, "--dumpBadCases", "2"], cwd);
  const generation = runJson(process.execPath, ["scripts/generate-script.js", "--stage", "TEST-SMOKE", "--roster", path.join(workDir, "roster.json"), "--model", model, "--out", generated, "--config", "configs/model-core.json", "--beamSize", "4", "--topActionsPerState", "8", "--maxSteps", "4", "--candidateActionsPerState", "20", "--seed", "42"], cwd);

  const output = {
    battleDsl: battleDsl.validationPassed,
    candidateCount: candidateReport.candidateCount,
    sampleCount: datasetReport.sampleCount,
    trainRowCount: datasetReport.trainRowCount,
    rejectedSampleCount: datasetReport.rejectedSampleCount,
    modelExists: fs.existsSync(model),
    evalGroupCount: readJson(evalReport).groupCount,
    generatedExists: fs.existsSync(generated),
    generatedActions: readJson(generated).actions.length,
    validationPassed: generation.validationPassed,
    stageHash: generation.stageHash,
    rosterHash: generation.rosterHash,
    engineVersion: generation.engineVersion,
    workDir,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, fixtureCopilot, fixtureFeature };
