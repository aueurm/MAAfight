#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { loadOperations } = require("./train-public-copilot");

function loadBuilder() {
  try {
    return require("../dist/model-core/actionDataset");
  } catch (error) {
    throw new Error("Build first: npm run build:node");
  }
}

function parseArgs(argv) {
  const options = {
    inputs: [],
    out: "data/model-core",
    negativeCount: 50,
    validRatio: 0.1,
    seed: 42,
    rejectedPerSample: 4,
    simpleOnly: false,
    excludeStages: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") options.inputs.push(argv[++i]);
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--output") options.out = path.dirname(argv[++i]);
    else if (arg === "--negativeCount" || arg === "--negative-count") options.negativeCount = Number.parseInt(argv[++i], 10);
    else if (arg === "--validRatio" || arg === "--valid-ratio") options.validRatio = Number.parseFloat(argv[++i]);
    else if (arg === "--seed") options.seed = Number.parseInt(argv[++i], 10);
    else if (arg === "--rejectedSamples" || arg === "--rejected-samples") options.rejectedSamples = argv[++i];
    else if (arg === "--rejectedPerSample" || arg === "--rejected-per-sample") options.rejectedPerSample = Number.parseInt(argv[++i], 10);
    else if (arg === "--simpleOnly" || arg === "--simple-only") options.simpleOnly = true;
    else if (arg === "--excludeStage" || arg === "--exclude-stage") options.excludeStages.push(argv[++i]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run build-action-dataset -- --input data/prts-plus-latest-100 --out data/model-core --negativeCount 50 --validRatio 0.1 --seed 42 [--simpleOnly] [--excludeStage main_01-07] [--rejectedSamples data/model-core/rejected_samples.jsonl]`);
}

function defaultInputs() {
  return [
    "data/prts-plus-latest-100",
    "data/prts-plus-2025-06-18-100",
  ].filter(source => fs.existsSync(path.resolve(source, "corpus")) && fs.existsSync(path.resolve(source, "features.json")));
}

function writeLine(fd, value) {
  fs.writeSync(fd, `${JSON.stringify(value)}\n`, undefined, "utf8");
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function operationStageId(operation) {
  const feature = operation.feature || {};
  return String(
    feature.resolvedStage?.stageId
      || feature.map?.stageId
      || feature.stageName
      || operation.content?.stage_name
      || ""
  );
}

function isSimpleOperation(operation) {
  const feature = operation.feature || {};
  const map = feature.map || {};
  return feature.mapMatched === true
    && Number(map.bossTypeCount || 0) === 0
    && Number(map.eliteTypeCount || 0) <= 1
    && Number(map.weightedHp ?? Infinity) <= 300000
    && Number(map.spawnCount ?? Infinity) <= 70
    && Number(feature.retreatCount || 0) <= 1;
}

function selectOperations(operations, options = {}) {
  const excludeStages = new Set(options.excludeStages || []);
  const seen = new Set();
  const selected = [];
  const stats = { duplicateCount: 0, excludedStageCount: 0, nonSimpleCount: 0 };
  for (const operation of operations) {
    const id = operation.id;
    if (id !== undefined && id !== null) {
      const key = String(id);
      if (seen.has(key)) {
        stats.duplicateCount++;
        continue;
      }
      seen.add(key);
    }
    if (excludeStages.has(operationStageId(operation))) {
      stats.excludedStageCount++;
      continue;
    }
    if (options.simpleOnly && !isSimpleOperation(operation)) {
      stats.nonSimpleCount++;
      continue;
    }
    selected.push(operation);
  }
  return { operations: selected, stats };
}

function operationOperatorNames(operation) {
  const content = operation.content || {};
  const fixed = Array.isArray(content.opers) ? content.opers : [];
  const grouped = Array.isArray(content.groups)
    ? content.groups.flatMap(group => Array.isArray(group?.opers) ? group.opers : [])
    : [];
  return [...fixed, ...grouped]
    .map(operator => operator?.name)
    .filter(name => typeof name === "string" && name.trim());
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  const inputs = options.inputs.length ? options.inputs : defaultInputs();
  if (inputs.length === 0) throw new Error("No corpus inputs found; pass --input <analyzer-output-dir>.");
  const rejectedSamples = readJsonl(options.rejectedSamples);

  const {
    buildActionTrainingSamplesForOperation,
    trainingRowsForSample,
    isValidSplit,
    featureCount,
  } = loadBuilder();
  const outDir = path.resolve(options.out);
  fs.mkdirSync(outDir, { recursive: true });
  const actionSamplesPath = path.join(outDir, "action_samples.jsonl");
  const trainPath = path.join(outDir, "train.jsonl");
  const validPath = path.join(outDir, "valid.jsonl");
  const samplesFd = fs.openSync(actionSamplesPath, "w");
  const trainFd = fs.openSync(trainPath, "w");
  const validFd = fs.openSync(validPath, "w");

  const selection = selectOperations(loadOperations(inputs), options);
  const selectedOperations = selection.operations;
  const excludedStages = new Set(options.excludeStages);
  const stageCount = new Set(selectedOperations.map(operationStageId).filter(Boolean)).size;
  const operatorCount = new Set(selectedOperations.flatMap(operationOperatorNames)).size;
  let scriptCount = 0;
  let sampleCount = 0;
  let trainRowCount = 0;
  let validRowCount = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  try {
    for (const operation of selectedOperations) {
      scriptCount++;
      const samples = buildActionTrainingSamplesForOperation(operation, {
        negativeCount: options.negativeCount,
        seed: options.seed + scriptCount,
        validRatio: options.validRatio,
        rejectedSamples,
        rejectedPerSample: options.rejectedPerSample,
      });
      const valid = isValidSplit(String(operation.id), options.validRatio, options.seed);
      for (const sample of samples) {
        const sampleStageId = String(sample.meta?.stageId || sample.stageFeatures?.stageId || "");
        if (excludedStages.has(sampleStageId)) {
          throw new Error(`Excluded stage leaked into action samples: ${sampleStageId}`);
        }
        writeLine(samplesFd, sample);
        sampleCount++;
        const rows = trainingRowsForSample(sample);
        for (const row of rows) {
          writeLine(valid ? validFd : trainFd, row);
          if (valid) validRowCount++;
          else trainRowCount++;
          if (row.label === 1) positiveCount++;
          else negativeCount++;
        }
      }
    }
  } finally {
    fs.closeSync(samplesFd);
    fs.closeSync(trainFd);
    fs.closeSync(validFd);
  }

  const result = {
    inputScriptCount: selectedOperations.length
      + selection.stats.duplicateCount
      + selection.stats.excludedStageCount
      + selection.stats.nonSimpleCount,
    scriptCount,
    stageCount,
    operatorCount,
    ...selection.stats,
    sampleCount,
    trainRowCount,
    validRowCount,
    avgNegatives: sampleCount ? Math.round((negativeCount / sampleCount) * 100) / 100 : 0,
    positiveCount,
    negativeCount,
    rejectedSampleCount: rejectedSamples.length,
    featureCount: featureCount(),
    output: { actionSamplesPath, trainPath, validPath },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { defaultInputs, isSimpleOperation, main, parseArgs, selectOperations };
