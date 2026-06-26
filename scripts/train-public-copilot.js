#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PRESETS = {
  conservative: [
    { name: "latest", limit: 500 },
    { name: "2026-03-01", limit: 500, aroundDate: "2026-03-01" },
    { name: "2025-11-01", limit: 500, aroundDate: "2025-11-01" },
    { name: "2025-06-18", limit: 500, aroundDate: "2025-06-18" },
  ],
  standard: [
    { name: "latest", limit: 500 },
    { name: "2026-05-01", limit: 500, aroundDate: "2026-05-01" },
    { name: "2026-04-01", limit: 500, aroundDate: "2026-04-01" },
    { name: "2026-03-01", limit: 500, aroundDate: "2026-03-01" },
    { name: "2026-02-01", limit: 500, aroundDate: "2026-02-01" },
    { name: "2026-01-01", limit: 500, aroundDate: "2026-01-01" },
    { name: "2025-12-01", limit: 500, aroundDate: "2025-12-01" },
    { name: "2025-11-01", limit: 500, aroundDate: "2025-11-01" },
    { name: "2025-10-01", limit: 500, aroundDate: "2025-10-01" },
    { name: "2025-09-01", limit: 500, aroundDate: "2025-09-01" },
    { name: "2025-08-01", limit: 500, aroundDate: "2025-08-01" },
    { name: "2025-06-18", limit: 500, aroundDate: "2025-06-18" },
    { name: "2025-03-01", limit: 500, aroundDate: "2025-03-01" },
  ],
};
const PRESET_MINIMUMS = { conservative: 1000, standard: 3000 };

function parseArgs(argv) {
  const options = {
    preset: "conservative",
    inputs: [],
    output: "src/data/copilotPrior.v1.json",
    dataDir: "data/prts-plus-training",
    report: false,
    reportPath: "training-results/public-copilot-report.md",
    reuseCorpus: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--preset") options.preset = argv[++i];
    else if (arg === "--input") options.inputs.push(argv[++i]);
    else if (arg === "--output") options.output = argv[++i];
    else if (arg === "--data-dir") options.dataDir = argv[++i];
    else if (arg === "--reuse-corpus") options.reuseCorpus = true;
    else if (arg === "--report") {
      options.report = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) options.reportPath = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!PRESETS[options.preset]) throw new Error(`Unknown preset: ${options.preset}`);
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/train-public-copilot.js [options]

Options:
  --preset <name>       conservative (2000 max) or standard (6000 max)
  --input <dir>         Reuse an analyzer output directory; repeatable
  --reuse-corpus        Do not download; use --input dirs or bundled 100-job corpora
  --output <file>       Prior output (default: src/data/copilotPrior.v1.json)
  --data-dir <dir>      Download output root (default: data/prts-plus-training)
  --report [file]       Write compact report
  -h, --help            Show this help`);
}

function sourceOperationCount(sourceDir) {
  const corpusDir = path.resolve(sourceDir, "corpus");
  const featuresPath = path.resolve(sourceDir, "features.json");
  if (!fs.existsSync(corpusDir) || !fs.existsSync(featuresPath)) return 0;
  const features = JSON.parse(fs.readFileSync(featuresPath, "utf8"));
  const files = fs.readdirSync(corpusDir).filter(file => file.endsWith(".json")).length;
  return Math.min(Array.isArray(features) ? features.length : 0, files);
}

function totalOperationCount(sourceDirs) {
  return sourceDirs.reduce((sum, sourceDir) => sum + sourceOperationCount(sourceDir), 0);
}

function runAnalyzer(options, run = execFileSync) {
  const windows = PRESETS[options.preset];
  const minimum = PRESET_MINIMUMS[options.preset];
  const dirs = [];
  const failures = [];
  for (const window of windows) {
    const output = path.join(options.dataDir, window.name);
    if (sourceOperationCount(output) >= window.limit) {
      console.error(`Reusing complete window ${window.name}: ${output}`);
      dirs.push(output);
      continue;
    }
    const args = ["scripts/analyze-prts-plus.js", "--limit", String(window.limit), "--output", output];
    if (window.aroundDate) args.push("--around-date", window.aroundDate);
    try {
      run(process.execPath, args, { stdio: "inherit" });
      dirs.push(output);
    } catch (error) {
      failures.push(window.name);
      console.error(`Window ${window.name} failed; continuing with remaining windows.`);
    }
  }
  if (totalOperationCount(dirs) < minimum) {
    throw new Error(`Preset ${options.preset} needs at least ${minimum} operations; got ${totalOperationCount(dirs)}. Failed windows: ${failures.join(", ") || "none"}`);
  }
  return dirs;
}

function loadOperations(sourceDirs) {
  return sourceDirs.flatMap((sourceDir, sourceIndex) => {
    const corpusDir = path.resolve(sourceDir, "corpus");
    const featuresPath = path.resolve(sourceDir, "features.json");
    if (!fs.existsSync(corpusDir) || !fs.existsSync(featuresPath)) {
      throw new Error(`Corpus source is incomplete: ${sourceDir}`);
    }
    const features = JSON.parse(fs.readFileSync(featuresPath, "utf8"));
    const featureById = new Map(features.map(feature => [String(feature.id), feature]));
    return fs.readdirSync(corpusDir)
      .filter(file => file.endsWith(".json"))
      .sort((a, b) => Number(path.basename(a, ".json")) - Number(path.basename(b, ".json")))
      .map(file => {
        const id = path.basename(file, ".json");
        const feature = featureById.get(id);
        if (!feature) throw new Error(`Missing feature row for corpus operation ${id}`);
        return {
          id: Number(id),
          source: path.basename(sourceDir) || `source-${sourceIndex + 1}`,
          content: JSON.parse(fs.readFileSync(path.join(corpusDir, file), "utf8")),
          feature,
        };
      });
  });
}

function increment(target, key, amount = 1) {
  if (key === null || key === undefined || key === "") return;
  target[key] = (target[key] || 0) + amount;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function actionType(action) {
  return typeof action?.type === "string" && action.type.trim() ? action.type.trim() : "Deploy";
}

function operatorEntries(content) {
  return [
    ...(Array.isArray(content.opers) ? content.opers : []),
    ...(Array.isArray(content.groups) ? content.groups.flatMap(group => Array.isArray(group?.opers) ? group.opers : []) : []),
  ].filter(oper => oper && typeof oper.name === "string" && oper.name.trim());
}

function contextNames(feature) {
  const map = feature.map || {};
  const names = ["global"];
  names.push((map.bossTypeCount || 0) > 0 ? "boss" : "no_boss");
  names.push((map.flyingRouteCount || 0) > 0 ? "flying" : "ground_only");
  names.push((map.uniqueStartCount || 0) > 1 ? "multi_lane" : "single_lane");
  const hp = map.weightedHp || 0;
  names.push(hp >= 150000 ? "pressure_high" : hp >= 60000 ? "pressure_medium" : "pressure_low");
  const area = (map.rows || 0) * (map.cols || 0);
  names.push(area >= 100 ? "map_large" : area >= 60 ? "map_medium" : "map_small");
  return names;
}

function emptyBucket() {
  return {
    operationCount: 0,
    actionCount: 0,
    deployCount: 0,
    skillCount: 0,
    retreatCount: 0,
    fixedOperCount: 0,
    speedUpCount: 0,
    skillDaemonCount: 0,
    actionTypes: {},
    firstActions: {},
    directions: {},
    deployHeatmap: {},
    firstDeploys: {},
    operatorUsage: {},
    skillUsage: {},
  };
}

function addOperation(bucket, operation) {
  const actions = Array.isArray(operation.content.actions) ? operation.content.actions : [];
  const deploys = actions.filter(action => actionType(action).toLowerCase() === "deploy");
  bucket.operationCount++;
  bucket.actionCount += actions.length;
  bucket.deployCount += deploys.length;
  bucket.skillCount += actions.filter(action => actionType(action).toLowerCase() === "skill").length;
  bucket.retreatCount += actions.filter(action => actionType(action).toLowerCase() === "retreat").length;
  bucket.fixedOperCount += Array.isArray(operation.content.opers) ? operation.content.opers.length : 0;
  if (actions.some(action => actionType(action).toLowerCase() === "speedup")) bucket.speedUpCount++;
  if (actions.some(action => actionType(action).toLowerCase() === "skilldaemon")) bucket.skillDaemonCount++;
  if (actions[0]) increment(bucket.firstActions, actionType(actions[0]));
  for (const action of actions) increment(bucket.actionTypes, actionType(action));
  for (const [index, action] of deploys.entries()) {
    if (typeof action.direction === "string") increment(bucket.directions, action.direction);
    const location = Array.isArray(action.location) ? action.location : null;
    if (location && Number.isFinite(Number(location[0])) && Number.isFinite(Number(location[1]))) {
      const tile = `${Number(location[1])},${Number(location[0])}`;
      increment(bucket.deployHeatmap, tile);
      if (index < 3) increment(bucket.firstDeploys, `${index + 1}:${tile}`);
    }
  }
  for (const oper of operatorEntries(operation.content)) {
    const name = oper.name.trim();
    increment(bucket.operatorUsage, name);
    const skill = Number(oper.skill);
    if (Number.isFinite(skill)) increment(bucket.skillUsage, `${name}#${skill}`);
  }
}

function topCounts(counts, limit = 50) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, limit)
  );
}

function rates(counts, denominator, limit) {
  return Object.fromEntries(
    Object.entries(topCounts(counts, limit))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, denominator ? round(value / denominator) : 0])
  );
}

function finalizeBucket(bucket) {
  const operations = bucket.operationCount || 1;
  const deploys = bucket.deployCount || 1;
  return {
    operationCount: bucket.operationCount,
    averages: {
      actions: round(bucket.actionCount / operations),
      deploys: round(bucket.deployCount / operations),
      skills: round(bucket.skillCount / operations),
      retreats: round(bucket.retreatCount / operations),
      fixedOpers: round(bucket.fixedOperCount / operations),
    },
    rates: {
      speedUp: round(bucket.speedUpCount / operations),
      skillDaemon: round(bucket.skillDaemonCount / operations),
    },
    actionTypesPerScript: rates(bucket.actionTypes, operations, 20),
    firstActionRates: rates(bucket.firstActions, operations, 10),
    directionRates: rates(bucket.directions, deploys, 8),
    deployHeatmap: topCounts(bucket.deployHeatmap, 40),
    firstDeploys: topCounts(bucket.firstDeploys, 12),
    operatorUsage: topCounts(bucket.operatorUsage, 50),
    skillUsage: topCounts(bucket.skillUsage, 50),
  };
}

function buildBuckets(operations) {
  const contexts = new Map();
  const stages = new Map();
  for (const operation of operations) {
    for (const name of contextNames(operation.feature)) {
      if (!contexts.has(name)) contexts.set(name, emptyBucket());
      addOperation(contexts.get(name), operation);
    }
    const stage = operation.feature.stageName || operation.content.stage_name;
    if (stage) {
      if (!stages.has(stage)) stages.set(stage, emptyBucket());
      addOperation(stages.get(stage), operation);
    }
  }
  return {
    contexts: Object.fromEntries([...contexts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, finalizeBucket(value)])),
    stages: Object.fromEntries([...stages.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, finalizeBucket(value)])),
  };
}

function fitAgainstBucket(operation, bucket) {
  if (!bucket) return 0;
  const actions = Array.isArray(operation.content.actions) ? operation.content.actions : [];
  const deploys = actions.filter(action => actionType(action).toLowerCase() === "deploy");
  const closeness = (actual, expected) => Math.max(0, 1 - Math.abs(actual - expected) / Math.max(1, expected));
  return round(average([
    closeness(actions.length, bucket.averages.actions),
    closeness(deploys.length, bucket.averages.deploys),
    closeness(actions.filter(action => actionType(action).toLowerCase() === "skill").length, bucket.averages.skills),
  ]));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function evaluateFit(operations, prior, baseline) {
  const holdout = operations.filter(operation => operation.id % 5 === 0);
  const rows = holdout.length ? holdout : operations.slice(0, Math.min(operations.length, 50));
  const trained = rows.map(operation => {
    const stage = operation.feature.stageName || operation.content.stage_name;
    const bucket = prior.stages[stage] || contextNames(operation.feature).map(name => prior.contexts[name]).find(Boolean) || prior.contexts.global;
    return fitAgainstBucket(operation, bucket);
  });
  const base = rows.map(operation => {
    const bucket = contextNames(operation.feature).map(name => baseline?.contexts?.[name]).find(Boolean) || baseline?.contexts?.global;
    return fitAgainstBucket(operation, bucket);
  });
  return {
    holdoutCount: rows.length,
    publicPriorFit: round(average(trained)),
    corpusPriorFit: round(average(base)),
    delta: round(average(trained) - average(base)),
  };
}

function buildPublicPrior(operations, baseline = null) {
  const deduped = [...new Map(operations.map(operation => [operation.id, operation])).values()];
  const buckets = buildBuckets(deduped);
  const ids = deduped.map(operation => operation.id).sort((a, b) => a - b);
  const sourceHash = crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16);
  const prior = {
    schemaVersion: 1,
    modelVersion: `copilot-prior-v1-${sourceHash}`,
    source: {
      operationCount: deduped.length,
      uniqueStageCount: new Set(deduped.map(operation => operation.feature.stageName || operation.content.stage_name).filter(Boolean)).size,
      sourceCount: new Set(deduped.map(operation => operation.source)).size,
      fullSequenceStored: false,
    },
    contexts: buckets.contexts,
    stages: buckets.stages,
  };
  prior.evaluation = evaluateFit(deduped, prior, baseline);
  return prior;
}

function loadBaseline() {
  const baselinePath = path.resolve("src/data/corpusPrior.v1.json");
  return fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : null;
}

function writeJson(file, value) {
  const outputPath = path.resolve(file);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return outputPath;
}

function writeText(file, value) {
  const outputPath = path.resolve(file);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, value, "utf8");
  return outputPath;
}

function buildReport(prior) {
  const topStages = Object.entries(prior.stages)
    .sort((a, b) => b[1].operationCount - a[1].operationCount || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([stage, bucket]) => `| ${stage} | ${bucket.operationCount} |`)
    .join("\n");
  return `# Public Copilot Training Report

## Data Quality

- Parsed jobs: ${prior.source.operationCount}
- Unique stages: ${prior.source.uniqueStageCount}
- Source windows: ${prior.source.sourceCount}
- Full sequences in artifact: ${prior.source.fullSequenceStored ? "yes" : "no"}

## Fit Evaluation

- Holdout jobs: ${prior.evaluation.holdoutCount}
- Public prior fit: ${prior.evaluation.publicPriorFit}
- Existing corpus prior fit: ${prior.evaluation.corpusPriorFit}
- Delta: ${prior.evaluation.delta}

## Training Impact

- Artifact: \`src/data/copilotPrior.v1.json\`
- Runtime integration: scoring-only weak prior
- Feedback priority: local killed/total remains outside this artifact and is applied after scoring

| Stage | Jobs |
| --- | --- |
${topStages}

## Summary

This run builds aggregate priors only: heatmaps, directions, first-deploy counts, action ratios, and operator/skill usage counts. It does not store complete public action sequences. Scale to the standard preset only after local simple-stage feedback improves.
`;
}

function defaultInputs(options) {
  if (options.inputs.length) return options.inputs;
  if (options.reuseCorpus) return ["data/prts-plus-latest-100", "data/prts-plus-2025-06-18-100"];
  return runAnalyzer(options);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  const inputs = defaultInputs(options);
  const operations = loadOperations(inputs);
  const prior = buildPublicPrior(operations, loadBaseline());
  const outputPath = writeJson(options.output, prior);
  let reportPath = null;
  if (options.report) {
    reportPath = writeText(options.reportPath.replace(/\.json$/i, ".md"), buildReport(prior));
  }
  const result = { outputPath, reportPath, modelVersion: prior.modelVersion, source: prior.source, evaluation: prior.evaluation };
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

module.exports = {
  buildPublicPrior,
  loadOperations,
  main,
  parseArgs,
  runAnalyzer,
  sourceOperationCount,
};
