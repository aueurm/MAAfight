#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function loadBattleDsl() {
  try {
    return require("../dist/copilot/battleDsl");
  } catch (error) {
    throw new Error("Build first: npm run build:node");
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") options.input = argv[++i];
    else if (arg === "--output") options.output = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run battle-dsl -- --input copilot.json --output roundtrip.json`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.input) {
    printHelp();
    return null;
  }
  const { copilotJsonToBattleDsl, battleDslToCopilotJson, validateBattleDsl } = loadBattleDsl();
  const input = JSON.parse(fs.readFileSync(options.input, "utf8"));
  const script = copilotJsonToBattleDsl(input);
  const validation = validateBattleDsl(script);
  const output = battleDslToCopilotJson(script);
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  const actionCount = Array.isArray(input.actions) ? input.actions.length : 0;
  const summary = {
    stageId: script.stageId,
    actionCount,
    normalizedActionCount: script.actions.length,
    hasEnd: script.actions.some(action => action.type === "End"),
    validationPassed: validation.valid,
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

module.exports = { main, parseArgs };
