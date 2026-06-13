import * as fs from "fs";
import * as path from "path";
import { PRTSMapLoader } from "./loader/PRTSMapLoader";
import { PRTSMapAdapter } from "./adapter/PRTSMapAdapter";
import { analyzeBattle } from "./battle/BattleAnalyzer";
import { generateScript } from "./battle/ScriptGenerator";
import { validateScript } from "./battle/ScriptValidator";
import { exportToCopilotFormat } from "./battle/ScriptExporter";
import { listStages, searchStages, listByCategory, resolveStage } from "./loader/levelIndex";
import { OperatorBox } from "./player/OperatorBox";
import type { MapData, BattleScript, PRTSLevelData, StageIndexEntry } from "./types";

const CACHE_DIR = process.env.MAAFIGHT_CACHE_DIR || path.resolve(__dirname, "..", "cache", "levels");
const DATA_URL = process.env.MAAFIGHT_DATA_URL || "https://map.ark-nights.com";

interface Args {
  command: string;
  stage?: string;
  output?: string;
  noCache?: boolean;
  pretty?: boolean;
  quiet?: boolean;
  search?: string;
  category?: string;
  limit?: number;
  file?: string;
  config?: string;
  operators?: string;
  data?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "" };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (["generate", "list", "analyze", "validate", "info"].includes(arg)) {
      args.command = arg;
    } else if (arg === "--stage" || arg === "-s") {
      args.stage = argv[++i];
    } else if (arg === "--output" || arg === "-o") {
      args.output = argv[++i];
    } else if (arg === "--no-cache") {
      args.noCache = true;
    } else if (arg === "--pretty") {
      args.pretty = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else if (arg === "--search") {
      args.search = argv[++i];
    } else if (arg === "--category" || arg === "-c") {
      args.category = argv[++i];
    } else if (arg === "--limit") {
      args.limit = parseInt(argv[++i], 10);
    } else if (arg === "--file" || arg === "-f") {
      args.file = argv[++i];
    } else if (arg === "--config") {
      args.config = argv[++i];
    } else if (arg === "--operators") {
      args.operators = argv[++i];
    } else if (arg === "--data" || arg === "-d") {
      args.data = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    i++;
  }

  if (!args.command) {
    console.error("Usage: maafight <command> [options]");
    console.error("Commands: generate, list, analyze, validate, info");
    console.error("Try: maafight --help");
    process.exit(1);
  }

  return args;
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function printHelp(): void {
  console.log(`MAAfight - AI-driven Arknights copilot battle script generator

Usage: maafight <command> [options]

Commands:
  generate   Generate copilot battle script for a stage
  list       List available stages
  analyze    Analyze a stage without generating script
  validate   Validate an existing copilot script
  info       Show stage details

Options:
  --stage, -s <id>    Stage ID (e.g. a001_01, OF-1)
  --output, -o <path> Write output to file (default: stdout)
  --no-cache          Force re-download from network
  --pretty            Pretty-print JSON output
  --quiet             Suppress non-JSON output
  --search <query>    Search stages by keyword
  --category, -c <cat> Filter by category (main, hard, campaign, weekly, crisis, activity)
  --limit <n>         Max results for list command (default: 50)
  --file, -f <path>   Input script file for validate command
  --config <path>      Generator config JSON file
  --operators <path>   MAA operator export JSON for personalized script
  --data, -d <path>    Use local PRTS.Map JSON file instead of index lookup
  --help, -h           Show this help

Examples:
  maafight generate --stage a001_01
  maafight generate --data ./level_OF-3.json --output script.json --pretty
  maafight list --search CE
  maafight list --category weekly
  maafight analyze --stage a001_01
  maafight validate --file script.json
  maafight info --stage a001_01

Environment:
  MAAFIGHT_CACHE_DIR   Cache directory (default: ./cache/levels)
  MAAFIGHT_DATA_URL    PRTS.Map data URL (default: https://map.ark-nights.com)
  MAAFIGHT_LOG_LEVEL   Log level (default: info)`);
}

async function cmdGenerate(args: Args): Promise<void> {
  if (!args.stage && !args.data) {
    console.error("Error: --stage or --data is required for generate");
    process.exit(1);
  }

  const loader = new PRTSMapLoader(CACHE_DIR, DATA_URL);
  const adapter = new PRTSMapAdapter(loader);

  let prtsData: PRTSLevelData;
  let stageId: string;
  let resolved: StageIndexEntry | null = null;

  if (args.data) {
    if (!fs.existsSync(args.data)) {
      console.error(`Error: File not found: ${args.data}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(args.data, "utf-8");
    prtsData = JSON.parse(raw) as PRTSLevelData;
    stageId = args.stage || path.basename(args.data, ".json");
  } else {
    const inputStage = args.stage!;
    resolved = resolveStage(inputStage);
    prtsData = await loader.load(inputStage, { noCache: args.noCache });
    stageId = resolved ? resolved.stageId : inputStage;
  }

  await loader.loadEnemyDatabase();
  const displayName = resolved?.code || resolved?.name;
  const mapData = adapter.adapt(prtsData, stageId, displayName);
  const analysis = analyzeBattle(mapData);

  let config = {};
  if (args.config && fs.existsSync(args.config)) {
    config = JSON.parse(fs.readFileSync(args.config, "utf-8"));
  }
  if (args.operators && fs.existsSync(args.operators)) {
    const box = new OperatorBox(args.operators);
    if (!args.quiet) console.error(`Loaded ${box.size} owned operators from player data`);
    config = { ...config, playerOperators: box.playerMap };
  }

  const script = generateScript(stageId, mapData, analysis, config);
  const validation = validateScript(script, mapData);

  if (!validation.valid && !args.quiet) {
    console.error("Warning: Script validation had errors:");
    validation.errors.forEach(e => console.error(`  - [${e.code}] ${e.message}`));
  }

  const output = exportToCopilotFormat(script, { compress: !args.pretty });

  if (args.output) {
    fs.writeFileSync(args.output, output, "utf-8");
    if (!args.quiet) console.error(`Script written to: ${args.output}`);
  } else {
    process.stdout.write(output);
    if (!args.quiet) process.stdout.write("\n");
  }
}

function cmdList(args: Args): void {
  let stages = listStages();

  if (args.search) {
    stages = searchStages(args.search);
  } else if (args.category) {
    stages = listByCategory(args.category);
  }

  const limit = args.limit || 50;
  stages = stages.slice(0, limit);

  // Table header
  const stageIdW = Math.max(8, ...stages.map(s => s.stageId.length));
  const codeW = Math.max(4, ...stages.map(s => (s.code || "").length));
  const catW = Math.max(8, ...stages.map(s => s.category.length));
  const pathW = Math.min(50, Math.max(8, ...stages.map(s => s.filePath.length)));

  console.log(
    "  " + padEnd("stageId", stageIdW) + "  " + padEnd("code", codeW) + "  " + padEnd("category", catW) + "  " + padEnd("filePath", pathW)
  );
  console.log("  " + "─".repeat(stageIdW + codeW + catW + Math.min(pathW, 50) + 8));

  for (const s of stages) {
    console.log(
      "  " + padEnd(s.stageId, stageIdW) + "  " +
      padEnd(s.code || "", codeW) + "  " +
      padEnd(s.category, catW) + "  " +
      s.filePath
    );
  }

  console.error(`\n${stages.length} stage(s) shown (of ${listStages().length} total)`);
}

async function cmdAnalyze(args: Args): Promise<void> {
  if (!args.stage && !args.data) {
    console.error("Error: --stage or --data is required for analyze");
    process.exit(1);
  }

  const loader = new PRTSMapLoader(CACHE_DIR, DATA_URL);
  const adapter = new PRTSMapAdapter(loader);

  let prtsData: PRTSLevelData;
  let stageId: string;
  let resolved: StageIndexEntry | null = null;

  if (args.data) {
    if (!fs.existsSync(args.data)) {
      console.error(`Error: File not found: ${args.data}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(args.data, "utf-8");
    prtsData = JSON.parse(raw) as PRTSLevelData;
    stageId = args.stage || path.basename(args.data, ".json");
  } else {
    const inputStage = args.stage!;
    resolved = resolveStage(inputStage);
    prtsData = await loader.load(inputStage, { noCache: args.noCache });
    stageId = resolved ? resolved.stageId : inputStage;
  }

  await loader.loadEnemyDatabase();
  const displayName = resolved?.code || resolved?.name;
  const mapData = adapter.adapt(prtsData, stageId, displayName);
  const analysis = analyzeBattle(mapData);

  if (args.operators && fs.existsSync(args.operators)) {
    const box = new OperatorBox(args.operators);
    console.error(`Loaded ${box.size} owned operators from player data`);
  }

  console.log(JSON.stringify(analysis, null, args.pretty ? 2 : 0));
}

function cmdValidate(args: Args): void {
  if (!args.file) {
    console.error("Error: --file is required for validate");
    process.exit(1);
  }

  const raw = fs.readFileSync(args.file, "utf-8");
  const script: BattleScript = JSON.parse(raw);
  const result = validateScript(script);

  if (result.errors.length > 0) {
    console.log("Errors:");
    result.errors.forEach(e => console.log(`  [${e.code}] ${e.message}`));
  }
  if (result.warnings.length > 0) {
    console.log("Warnings:");
    result.warnings.forEach(w => console.log(`  [${w.code}] ${w.message}`));
  }
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("Script is valid.");
  }
  console.log(`Score: ${result.score}/100`);
}

async function cmdInfo(args: Args): Promise<void> {
  if (!args.stage && !args.data) {
    console.error("Error: --stage or --data is required for info");
    process.exit(1);
  }

  let prtsData: PRTSLevelData;
  let stageId: string;

  if (args.data) {
    if (!fs.existsSync(args.data)) {
      console.error(`Error: File not found: ${args.data}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(args.data, "utf-8");
    prtsData = JSON.parse(raw) as PRTSLevelData;
    stageId = args.stage || path.basename(args.data, ".json");
  } else {
    const loader = new PRTSMapLoader(CACHE_DIR, DATA_URL);
    const inputStage = args.stage!;
    const resolved = resolveStage(inputStage);
    stageId = resolved ? resolved.stageId : inputStage;
    prtsData = await loader.load(inputStage, { noCache: args.noCache });
  }

  const mapSize = `${prtsData.mapData.map.length} × ${prtsData.mapData.map[0]?.length || 0}`;
  const deployable = prtsData.mapData.tiles.filter(t => t.buildableType !== "NONE");
  const melee = deployable.filter(t => t.buildableType === "MELEE").length;
  const ranged = deployable.filter(t => t.buildableType === "RANGED").length;
  const routes = prtsData.routes.filter(r => r.motionMode !== "E_NUM").length;
  const enemies = new Set<string>();
  prtsData.waves.forEach(w => w.fragments.forEach(f => f.actions.forEach(a => {
    if (a.actionType === "SPAWN") enemies.add(a.key);
  })));

  const indexEntry = args.data ? null : resolveStage(stageId);

  console.log(`  Stage:        ${stageId}`);
  if (indexEntry?.code) console.log(`  Code:         ${indexEntry.code}`);
  if (indexEntry?.name) console.log(`  Name:         ${indexEntry.name}`);
  console.log(`  Category:     ${indexEntry?.category || (args.data ? "local" : "unknown")}`);
  console.log(`  Map Size:     ${mapSize}`);
  console.log(`  Deployable:   ${deployable.length} (${melee} melee, ${ranged} ranged)`);
  console.log(`  Routes:       ${routes}`);
  console.log(`  Waves:        ${prtsData.waves.length}`);
  console.log(`  Enemy Types:  ${enemies.size}`);
  console.log(`  Deploy Limit: ${prtsData.options.characterLimit}`);
  console.log(`  Life Points:  ${prtsData.options.maxLifePoint}`);
  console.log(`  Initial Cost: ${prtsData.options.initialCost}`);

  if (!args.quiet && indexEntry) {
    console.log(`  Data URL:     ${DATA_URL}/${indexEntry.filePath}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  try {
    switch (args.command) {
      case "generate":
        await cmdGenerate(args);
        break;
      case "list":
        cmdList(args);
        break;
      case "analyze":
        await cmdAnalyze(args);
        break;
      case "validate":
        cmdValidate(args);
        break;
      case "info":
        await cmdInfo(args);
        break;
      default:
        printHelp();
        process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
