#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const options = {
    inputs: [],
    dataOut: "data/model-core",
    modelOut: "models/cpu-action-ranker.json",
    evalOut: "data/model-core/eval_report.json",
    rejectedSamples: "data/model-core/rejected_samples.jsonl",
    negativeCount: 50,
    validRatio: 0.1,
    epochs: 5,
    lr: 0.05,
    l2: 0.0001,
    seed: 42,
    simpleOnly: false,
    excludeStages: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") options.inputs.push(argv[++i]);
    else if (arg === "--dataOut") options.dataOut = argv[++i];
    else if (arg === "--modelOut") options.modelOut = argv[++i];
    else if (arg === "--evalOut") options.evalOut = argv[++i];
    else if (arg === "--rejectedSamples") options.rejectedSamples = argv[++i];
    else if (arg === "--negativeCount") options.negativeCount = Number.parseInt(argv[++i], 10);
    else if (arg === "--validRatio") options.validRatio = Number.parseFloat(argv[++i]);
    else if (arg === "--epochs") options.epochs = Number.parseInt(argv[++i], 10);
    else if (arg === "--lr") options.lr = Number.parseFloat(argv[++i]);
    else if (arg === "--l2") options.l2 = Number.parseFloat(argv[++i]);
    else if (arg === "--seed") options.seed = Number.parseInt(argv[++i], 10);
    else if (arg === "--simpleOnly" || arg === "--simple-only") options.simpleOnly = true;
    else if (arg === "--excludeStage" || arg === "--exclude-stage") options.excludeStages.push(argv[++i]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log("Usage: npm run model-core-retrain -- --input data/prts-plus-latest-100 --rejectedSamples data/model-core/rejected_samples.jsonl --modelOut models/cpu-action-ranker.json");
}

function run(command, args, cwd) {
  cp.execFileSync(command, args, { cwd, stdio: "inherit" });
}

function buildDatasetArgs(options, dataOut, rejectedPath, hasRejectedSamples) {
  const args = ["scripts/build-action-dataset.js"];
  for (const input of options.inputs) args.push("--input", input);
  args.push("--out", dataOut, "--negativeCount", String(options.negativeCount), "--validRatio", String(options.validRatio), "--seed", String(options.seed));
  if (options.simpleOnly) args.push("--simpleOnly");
  for (const stageId of options.excludeStages) args.push("--excludeStage", stageId);
  if (hasRejectedSamples) args.push("--rejectedSamples", rejectedPath);
  return args;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  const root = path.resolve(__dirname, "..");
  const dataOut = path.resolve(options.dataOut);
  const modelOut = path.resolve(options.modelOut);
  const evalOut = path.resolve(options.evalOut);
  const rejectedPath = path.resolve(options.rejectedSamples);

  const datasetArgs = buildDatasetArgs(options, dataOut, rejectedPath, fs.existsSync(rejectedPath));
  run(process.execPath, datasetArgs, root);

  run(process.env.PYTHON || "python", [
    "scripts/model-core/train_linear_ranker.py",
    "--train", path.join(dataOut, "train.jsonl"),
    "--valid", path.join(dataOut, "valid.jsonl"),
    "--out", modelOut,
    "--epochs", String(options.epochs),
    "--lr", String(options.lr),
    "--l2", String(options.l2),
    "--seed", String(options.seed),
  ], root);

  run(process.env.PYTHON || "python", [
    "scripts/model-core/eval_ranker.py",
    "--model", modelOut,
    "--valid", path.join(dataOut, "valid.jsonl"),
    "--out", evalOut,
    "--badCases", path.join(path.dirname(evalOut), "bad_cases.jsonl"),
  ], root);

  const summary = {
    dataOut,
    modelOut,
    evalOut,
    rejectedSamples: fs.existsSync(rejectedPath) ? rejectedPath : null,
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

module.exports = { buildDatasetArgs, main, parseArgs };
