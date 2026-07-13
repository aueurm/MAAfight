#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function loadModelCore() {
  try {
    return {
      ...require("../dist/model-core/battleDsl"),
      ...require("../dist/model-core/candidateEnumerator"),
    };
  } catch (error) {
    throw new Error("Build first: npm run build:node");
  }
}

function parseArgs(argv) {
  const options = { step: 0, maxCandidates: 500, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--job") options.job = argv[++i];
    else if (arg === "--step") options.step = Number.parseInt(argv[++i], 10);
    else if (arg === "--maxCandidates") options.maxCandidates = Number.parseInt(argv[++i], 10);
    else if (arg === "--seed") options.seed = Number.parseInt(argv[++i], 10);
    else if (arg === "--output") options.output = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log("Usage: npm run enumerate-candidates -- --job copilot.json --step 5 --maxCandidates 500 --seed 42");
}

function roster(content) {
  return [
    ...(Array.isArray(content.opers) ? content.opers : []),
    ...(Array.isArray(content.groups) ? content.groups.flatMap(group => Array.isArray(group?.opers) ? group.opers : []) : []),
  ].map(operator => ({ operatorId: operator.name, ...operator })).filter(operator => operator.operatorId);
}

function deploymentPoints(actions) {
  const seen = new Set();
  return actions.filter(action => action.type === "Deploy" && Number.isInteger(action.x) && Number.isInteger(action.y))
    .map(action => ({ x: action.x, y: action.y }))
    .filter(point => {
      const key = `${point.x},${point.y}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.job) {
    printHelp();
    return null;
  }
  const { copilotJsonToBattleDsl, enumerateCandidateActions } = loadModelCore();
  const content = JSON.parse(fs.readFileSync(options.job, "utf8"));
  const script = copilotJsonToBattleDsl(content);
  const partialActions = script.actions.slice(0, Math.max(0, options.step));
  const candidates = enumerateCandidateActions({
    stageFeatures: {
      stageId: script.stageId,
      deploymentPoints: deploymentPoints(script.actions),
    },
    rosterFeatures: roster(content),
    partialActions,
    publicPriorActions: script.actions,
  }, { maxCandidates: options.maxCandidates, seed: options.seed });
  const sourceCounts = {};
  for (const candidate of candidates) sourceCounts[candidate.source] = (sourceCounts[candidate.source] || 0) + 1;
  const result = {
    partialActionsLength: partialActions.length,
    maxCandidates: options.maxCandidates,
    candidateCount: candidates.length,
    sourceCounts,
    candidates,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, text, "utf8");
  } else {
    process.stdout.write(text);
  }
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

module.exports = { main, parseArgs };
