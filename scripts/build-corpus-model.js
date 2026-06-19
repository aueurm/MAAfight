#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_SOURCES = [
  "data/prts-plus-latest-100",
  "data/prts-plus-2025-06-18-100",
];

function parseArgs(argv) {
  const options = {
    sources: [...DEFAULT_SOURCES],
    output: "src/data/corpusPrior.v1.json",
    auditOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") options.sources.push(argv[++i]);
    else if (argv[i] === "--output") options.output = argv[++i];
    else if (argv[i] === "--audit-only") options.auditOnly = true;
  }
  if (options.sources.length > DEFAULT_SOURCES.length) {
    options.sources = options.sources.slice(DEFAULT_SOURCES.length);
  }
  return options;
}

function loadSource(sourceDir, label) {
  const corpusDir = path.resolve(sourceDir, "corpus");
  const featuresPath = path.resolve(sourceDir, "features.json");
  if (!fs.existsSync(corpusDir) || !fs.existsSync(featuresPath)) {
    throw new Error(`Corpus source is incomplete: ${sourceDir}`);
  }
  const features = JSON.parse(fs.readFileSync(featuresPath, "utf8"));
  const byId = new Map(features.map(feature => [String(feature.id), feature]));
  return fs.readdirSync(corpusDir)
    .filter(file => file.endsWith(".json"))
    .sort((a, b) => Number(path.basename(a, ".json")) - Number(path.basename(b, ".json")))
    .map(file => {
      const id = path.basename(file, ".json");
      const content = JSON.parse(fs.readFileSync(path.join(corpusDir, file), "utf8"));
      const feature = byId.get(id);
      if (!feature) throw new Error(`Missing feature row for corpus operation ${id}`);
      return { id: Number(id), label, content, feature };
    });
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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

function emptyStats() {
  return {
    operationCount: 0,
    actionCount: 0,
    deployCount: 0,
    skillCount: 0,
    fixedOperCount: 0,
    groupUsageCount: 0,
    speedUpCount: 0,
    skillDaemonCount: 0,
    conditionScripts: { kills: 0, costs: 0, cost_changes: 0, cooling: 0, time_elapsed: 0, delay: 0 },
    actionTypes: {},
    firstActions: {},
    lastActions: {},
    actionBigrams: {},
    directions: {},
    position: { samples: 0, routeDistance: 0, blueBoxDistance: 0, chokepointDistance: 0 },
  };
}

function addOperation(stats, operation) {
  const { content, feature } = operation;
  const actions = Array.isArray(content.actions) ? content.actions : [];
  const types = actions.map(action => String(action.type || "Deploy"));
  stats.operationCount++;
  stats.actionCount += actions.length;
  stats.deployCount += feature.deployCount || 0;
  stats.skillCount += feature.skillCount || 0;
  stats.fixedOperCount += feature.fixedOperCount || 0;
  if ((content.groups || []).length > 0) stats.groupUsageCount++;
  if (feature.hasSpeedUp) stats.speedUpCount++;
  if (feature.hasSkillDaemon) stats.skillDaemonCount++;
  if (types[0]) increment(stats.firstActions, types[0]);
  if (types.length > 0) increment(stats.lastActions, types[types.length - 1]);
  for (const type of types) increment(stats.actionTypes, type);
  for (let i = 0; i < types.length - 1; i++) increment(stats.actionBigrams, `${types[i]}>${types[i + 1]}`);
  for (const action of actions) {
    if (action.direction) increment(stats.directions, String(action.direction));
  }
  for (const key of ["kills", "costs", "cost_changes", "cooling", "time_elapsed"]) {
    if (actions.some(action => action[key] !== undefined)) stats.conditionScripts[key]++;
  }
  if (actions.some(action => action.pre_delay !== undefined || action.post_delay !== undefined)) {
    stats.conditionScripts.delay++;
  }
  const position = feature.deploymentMapFeatures;
  if (position && position.locatedDeployCount > 0) {
    stats.position.samples++;
    stats.position.routeDistance += position.averageRouteDistance || 0;
    stats.position.blueBoxDistance += position.averageBlueBoxDistance || 0;
    stats.position.chokepointDistance += position.averageChokepointDistance || 0;
  }
}

function rates(counts, denominator) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, denominator ? round(value / denominator) : 0])
  );
}

function finalize(stats) {
  const n = stats.operationCount || 1;
  const p = stats.position.samples || 1;
  return {
    operationCount: stats.operationCount,
    averages: {
      actions: round(stats.actionCount / n),
      deploys: round(stats.deployCount / n),
      skills: round(stats.skillCount / n),
      fixedOpers: round(stats.fixedOperCount / n),
    },
    rates: {
      groups: round(stats.groupUsageCount / n),
      speedUp: round(stats.speedUpCount / n),
      skillDaemon: round(stats.skillDaemonCount / n),
      conditions: rates(stats.conditionScripts, n),
    },
    actionTypesPerScript: rates(stats.actionTypes, n),
    firstActionRates: rates(stats.firstActions, n),
    lastActionRates: rates(stats.lastActions, n),
    actionBigramRates: rates(stats.actionBigrams, Math.max(1, stats.actionCount - stats.operationCount)),
    directionRates: rates(stats.directions, Math.max(1, stats.deployCount)),
    position: {
      sampleCount: stats.position.samples,
      averageRouteDistance: round(stats.position.routeDistance / p),
      averageBlueBoxDistance: round(stats.position.blueBoxDistance / p),
      averageChokepointDistance: round(stats.position.chokepointDistance / p),
    },
  };
}

function audit(operations) {
  const latest = operations.filter(operation => operation.label === "latest");
  const requiredTopLevel = ["stage_name", "minimum_required", "doc", "opers", "groups", "actions"];
  const missingRequired = [];
  for (const operation of latest) {
    for (const key of requiredTopLevel) {
      if (!(key in operation.content)) missingRequired.push({ id: operation.id, key });
    }
  }
  const stages = new Map();
  for (const operation of operations) {
    const stage = operation.content.stage_name;
    stages.set(stage, (stages.get(stage) || 0) + 1);
  }
  return {
    operationCount: operations.length,
    latestCount: latest.length,
    historicalCount: operations.length - latest.length,
    uniqueStageCount: stages.size,
    singletonStageCount: [...stages.values()].filter(count => count === 1).length,
    missingRequired,
    leaveOneStageOut: {
      heldOutStageCount: stages.size,
      minimumTrainingOperations: operations.length - Math.max(...stages.values()),
      sameStageLeakageAllowed: false,
    },
  };
}

function buildModel(operations) {
  const contexts = new Map();
  for (const operation of operations) {
    for (const name of contextNames(operation.feature)) {
      if (!contexts.has(name)) contexts.set(name, emptyStats());
      addOperation(contexts.get(name), operation);
    }
  }
  const sourceIds = operations.map(operation => operation.id).sort((a, b) => a - b);
  const sourceHash = crypto.createHash("sha256").update(sourceIds.join(",")).digest("hex").slice(0, 16);
  return {
    schemaVersion: 1,
    modelVersion: `corpus-prior-v1-${sourceHash}`,
    source: audit(operations),
    contexts: Object.fromEntries(
      [...contexts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, stats]) => [name, finalize(stats)])
    ),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const operations = options.sources.flatMap((source, index) => loadSource(source, index === 0 ? "latest" : "historical"));
  const result = audit(operations);
  if (result.missingRequired.length > 0) {
    throw new Error(`Latest corpus is missing ${result.missingRequired.length} required top-level fields`);
  }
  if (options.auditOnly) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const model = buildModel(operations);
  const outputPath = path.resolve(options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, modelVersion: model.modelVersion, source: model.source })}\n`);
}

if (require.main === module) main();

module.exports = { audit, buildModel, contextNames };
