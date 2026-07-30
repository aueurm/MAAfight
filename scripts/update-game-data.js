#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const SOURCE_REPOSITORY = "https://github.com/Kengxxiao/ArknightsGameData.git";
const SOURCE_PATHS = ["zh_CN/gamedata/excel", "zh_CN/gamedata/levels"];

function parseArgs(argv) {
  const options = { ref: "master" };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--ref") options.ref = argv[++index];
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.ref || options.ref.startsWith("-")) throw new Error("--ref requires a branch or commit SHA");
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/update-game-data.js [--ref <branch-or-sha>]

Downloads the specified ArknightsGameData revision, rebuilds local operator and
stage indexes, and atomically replaces cache/levels plus cache/enemy_database.json.

Options:
  --ref <branch-or-sha>  Upstream revision (default: master)
  -h, --help             Show this help`);
}

function run(command, args, cwd = REPOSITORY_ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`Failed to run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown failure").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return String(result.stdout || "").trim();
}

function sortedObject(entries) {
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function levelIdToPath(levelId) {
  const clean = String(levelId || "").replace(/#f#/g, "");
  if (clean.includes("/")) return `${clean.toLowerCase()}.json`;
  const parts = clean.split("-");
  if (parts.length >= 3) {
    return `${parts[0]}/${parts[1]}/${parts.slice(2).join("-")}.json`.toLowerCase();
  }
  return `${clean.toLowerCase()}.json`;
}

function collectLevelPaths(levelsRoot, current = levelsRoot, collected = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) collectLevelPaths(levelsRoot, fullPath, collected);
    else if (entry.isFile() && entry.name.startsWith("level_") && entry.name.endsWith(".json")) {
      collected.push(path.relative(levelsRoot, fullPath).split(path.sep).join("/"));
    }
  }
  return collected.sort((left, right) => left.localeCompare(right));
}

function buildStageIndex(stageTable, levelPaths) {
  if (!stageTable || typeof stageTable !== "object" || !stageTable.stages || typeof stageTable.stages !== "object") {
    throw new Error("stage_table.json does not contain a stages object");
  }

  const availablePaths = new Set(levelPaths);
  const byStageId = {};
  for (const [key, stage] of Object.entries(stageTable.stages)) {
    const stageId = String(stage?.stageId || key);
    const levelId = String(stage?.levelId || "");
    if (!stageId || !levelId || !availablePaths.has(levelIdToPath(levelId))) continue;
    byStageId[stageId] = {
      code: String(stage.code || ""),
      name: String(stage.name || ""),
      levelId,
    };
  }

  const byCode = {};
  for (const [stageId, stage] of Object.entries(byStageId).sort(([left], [right]) => left.localeCompare(right))) {
    if (stage.code && !byCode[stage.code]) byCode[stage.code] = stageId;
  }

  const orderedStages = sortedObject(Object.entries(byStageId));
  return {
    byStageId: orderedStages,
    byCode: sortedObject(Object.entries(byCode)),
    count: Object.keys(orderedStages).length,
  };
}

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${description} is missing: ${filePath}`);
  }
}

function validateSnapshot({ levelsRoot, levelPaths, stageIndex, enemyDatabasePath, operatorModelPath, operatorKnowledgeModelPath, commit }) {
  if (levelPaths.length === 0) throw new Error("No level JSON files were found");
  if (stageIndex.count === 0) throw new Error("No stage metadata matched downloaded levels");
  assertFile(enemyDatabasePath, "Enemy database");
  for (const filePath of levelPaths) assertFile(path.join(levelsRoot, filePath), "Indexed level");
  for (const stage of Object.values(stageIndex.byStageId)) {
    assertFile(path.join(levelsRoot, levelIdToPath(stage.levelId)), "Indexed stage level");
  }

  assertFile(operatorModelPath, "Operator combat model");
  const model = JSON.parse(fs.readFileSync(operatorModelPath, "utf8"));
  if (model?.source?.commit !== commit) throw new Error("Operator model commit does not match downloaded source");
  const operatorCount = Object.keys(model.operators || {}).length;
  if (operatorCount === 0) throw new Error("Operator combat model has no operators");
  assertFile(operatorKnowledgeModelPath, "Generated operator knowledge");
  const knowledge = JSON.parse(fs.readFileSync(operatorKnowledgeModelPath, "utf8"));
  if (knowledge?.source?.commit !== commit) throw new Error("Generated operator knowledge commit does not match downloaded source");
  if (knowledge?.source?.operatorCount !== operatorCount || !Array.isArray(knowledge.operators) || knowledge.operators.length !== operatorCount) {
    throw new Error("Generated operator knowledge does not match operator combat model");
  }
  return operatorCount;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function replaceAll(replacements) {
  const states = [];
  try {
    for (const [index, replacement] of replacements.entries()) {
      const state = { ...replacement, backup: null, installed: false };
      states.push(state);
      if (!fs.existsSync(state.target)) continue;
      state.backup = `${state.target}.maafight-update-backup-${process.pid}-${index}`;
      if (fs.existsSync(state.backup)) throw new Error(`Stale update backup exists: ${state.backup}`);
      fs.renameSync(state.target, state.backup);
    }

    for (const state of states) {
      fs.renameSync(state.staged, state.target);
      state.installed = true;
    }
  } catch (error) {
    for (const state of states.reverse()) {
      if (state.installed && fs.existsSync(state.target)) fs.rmSync(state.target, { recursive: true, force: true });
      if (state.backup && fs.existsSync(state.backup)) fs.renameSync(state.backup, state.target);
    }
    throw error;
  }

  for (const state of states) {
    if (state.backup && fs.existsSync(state.backup)) fs.rmSync(state.backup, { recursive: true, force: true });
  }
}

function checkoutSource(sourceRoot, ref) {
  const cloneArgs = ["clone", "--depth", "1", "--filter=blob:none", "--sparse"];
  if (ref === "master") cloneArgs.push("--branch", ref);
  cloneArgs.push(SOURCE_REPOSITORY, sourceRoot);
  run("git", cloneArgs);
  if (ref !== "master") {
    run("git", ["-C", sourceRoot, "fetch", "--depth", "1", "--filter=blob:none", "origin", ref]);
    run("git", ["-C", sourceRoot, "checkout", "--detach", "FETCH_HEAD"]);
  }
  run("git", ["-C", sourceRoot, "sparse-checkout", "set", "--no-cone", ...SOURCE_PATHS]);
  return run("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();

  const cacheRoot = path.join(REPOSITORY_ROOT, "cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(cacheRoot, ".maafight-data-update-"));
  try {
    const sourceRoot = path.join(temporaryRoot, "source");
    const commit = checkoutSource(sourceRoot, options.ref);
    if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error(`Invalid upstream commit: ${commit}`);

    const gameDataRoot = path.join(sourceRoot, "zh_CN", "gamedata");
    const excelRoot = path.join(gameDataRoot, "excel");
    const levelsRoot = path.join(gameDataRoot, "levels");
    const stageTablePath = path.join(excelRoot, "stage_table.json");
    const enemyDatabasePath = path.join(levelsRoot, "enemydata", "enemy_database.json");
    assertFile(stageTablePath, "Stage table");
    assertFile(enemyDatabasePath, "Enemy database");

    const levelPaths = collectLevelPaths(levelsRoot);
    const stageIndex = buildStageIndex(JSON.parse(fs.readFileSync(stageTablePath, "utf8")), levelPaths);
    const generatedRoot = path.join(temporaryRoot, "generated");
    const operatorModelPath = path.join(generatedRoot, "operatorCombat.v2.json");
    const operatorKnowledgeModelPath = path.join(generatedRoot, "operatorKnowledge.generated.v1.json");
    const stageIndexPath = path.join(generatedRoot, "stage_index.json");
    const levelPathsPath = path.join(generatedRoot, "levelPaths.json");
    const stagedEnemyDatabase = path.join(generatedRoot, "enemy_database.json");
    run(process.execPath, [
      path.join(REPOSITORY_ROOT, "scripts", "build-operator-combat-model.js"),
      "--game-data", excelRoot,
      "--output", operatorModelPath,
      "--commit", commit,
    ]);
    run(process.execPath, [
      path.join(REPOSITORY_ROOT, "scripts", "build-operator-knowledge.js"),
      "--game-data", excelRoot,
      "--combat-model", operatorModelPath,
      "--output", operatorKnowledgeModelPath,
      "--commit", commit,
    ]);
    writeJson(stageIndexPath, stageIndex);
    writeJson(levelPathsPath, levelPaths);
    fs.copyFileSync(enemyDatabasePath, stagedEnemyDatabase);

    const stagedLevels = path.join(temporaryRoot, "levels");
    fs.renameSync(levelsRoot, stagedLevels);
    const operatorCount = validateSnapshot({
      levelsRoot: stagedLevels,
      levelPaths,
      stageIndex,
      enemyDatabasePath: stagedEnemyDatabase,
      operatorModelPath,
      operatorKnowledgeModelPath,
      commit: commit.toLowerCase(),
    });

    replaceAll([
      { staged: operatorModelPath, target: path.join(REPOSITORY_ROOT, "src", "data", "operatorCombat.v2.json") },
      { staged: operatorKnowledgeModelPath, target: path.join(REPOSITORY_ROOT, "src", "data", "operatorKnowledge.generated.v1.json") },
      { staged: stageIndexPath, target: path.join(REPOSITORY_ROOT, "src", "data", "stage_index.json") },
      { staged: levelPathsPath, target: path.join(REPOSITORY_ROOT, "src", "loader", "levelPaths.json") },
      { staged: stagedLevels, target: path.join(cacheRoot, "levels") },
      { staged: stagedEnemyDatabase, target: path.join(cacheRoot, "enemy_database.json") },
    ]);

    console.log(JSON.stringify({
      commit: commit.toLowerCase(),
      operatorCount,
      stageCount: stageIndex.count,
      levelCount: levelPaths.length,
      validation: "passed",
    }));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { buildStageIndex, collectLevelPaths, levelIdToPath, validateSnapshot };
