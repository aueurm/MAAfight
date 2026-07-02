import * as fs from "fs";
import * as path from "path";
import { PRTSMapLoader } from "./loader/PRTSMapLoader";
import { PRTSMapAdapter } from "./adapter/PRTSMapAdapter";
import { validateScript } from "./copilot/ScriptValidator";
import { validateMAAProtocol } from "./copilot/MAAProtocolValidator";
import { exportToCopilotFormat } from "./copilot/ScriptExporter";
import { computeScriptHash, extractStageFacts, generateCopilotScript } from "./engine";
import { listStages, searchStages, listByCategory, resolveStage } from "./loader/levelIndex";
import { OperatorBox } from "./player/OperatorBox";
import { loadConfiguredOperatorBox, saveOperatorConfig } from "./player/PlayerConfig";
import { startGuiServer } from "./gui/server";
import { openUrl } from "./gui/openBrowser";
import { getRuntimePaths } from "./runtime/paths";
import { writeGuiLog } from "./runtime/logger";
import { FeedbackStore, hashOperatorBox, hashScriptJson } from "./feedback/FeedbackStore";
import { getCombatModelInfo } from "./engine/CombatModel";
import { computeStageContentHash } from "./engine/EncounterContext";
import { inferStageIdFromDataPath, getDisplayStageName } from "./core/stageDisplay";
import { isSpawnActionType, normalizeBuildableType } from "./shared/prtsMap";
import { RunResultStore } from "./runner/RunResultStore";
import { connectMaaEnvironment, probeMaaEnvironment } from "./runner/probe";
import { recordCallbackRun, recordDryRun, recordScreenObservedRun } from "./runner/run";
import type { BattleScript, PRTSLevelData, StageIndexEntry } from "./types";

const CACHE_DIR = getRuntimePaths().cacheLevelsDir;
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
  operators?: string;
  operatorsStdin?: boolean;
  data?: string;
  explain?: boolean;
  subcommand?: string;
  newCandidate?: boolean;
  requirementsMode?: "none" | "player";
  killed?: number;
  total?: number;
  notes?: string;
  mode?: string;
  allowSanity?: boolean;
  callbackLog?: string;
  maa?: string;
  adb?: string;
  address?: string;
  connectConfig?: string;
  debugDir?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "" };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (["generate", "list", "analyze", "validate", "info", "init", "operators", "feedback", "run", "gui"].includes(arg)) {
      args.command = arg;
      if ((arg === "operators" || arg === "feedback" || arg === "run") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
        args.subcommand = argv[++i];
      }
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
    } else if (arg === "--operators") {
      args.operators = argv[++i];
    } else if (arg === "--operators-stdin") {
      args.operatorsStdin = true;
    } else if (arg === "--data" || arg === "-d") {
      args.data = argv[++i];
    } else if (arg === "--explain") {
      args.explain = true;
    } else if (arg === "--new-candidate") {
      args.newCandidate = true;
    } else if (arg === "--requirements") {
      const value = argv[++i];
      if (value !== "none" && value !== "player") throw new Error(`Unsupported requirements mode: ${value}`);
      args.requirementsMode = value;
    } else if (arg === "--killed") {
      args.killed = Number.parseInt(argv[++i], 10);
    } else if (arg === "--total") {
      args.total = Number.parseInt(argv[++i], 10);
    } else if (arg === "--notes") {
      args.notes = argv[++i];
    } else if (arg === "--mode") {
      args.mode = argv[++i];
    } else if (arg === "--allow-sanity") {
      args.allowSanity = true;
    } else if (arg === "--callback-log") {
      args.callbackLog = argv[++i];
    } else if (arg === "--maa") {
      args.maa = argv[++i];
    } else if (arg === "--adb") {
      args.adb = argv[++i];
    } else if (arg === "--address") {
      args.address = argv[++i];
    } else if (arg === "--connect-config") {
      args.connectConfig = argv[++i];
    } else if (arg === "--debug-dir") {
      args.debugDir = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    i++;
  }

  if (!args.command) {
    console.error("Usage: maafight <command> [options]");
    console.error("Commands: generate, list, analyze, validate, info, init, operators, feedback, run, gui");
    console.error("Try: maafight --help");
    process.exit(1);
  }

  return args;
}

export function countActiveRoutes(prtsData: Pick<PRTSLevelData, "routes">): number {
  return (prtsData.routes || []).filter(r =>
    r &&
    r.motionMode !== "E_NUM" &&
    r.motionMode !== 2 &&
    (r.checkpoints || []).some(cp => cp.type === "MOVE" || cp.type === 0)
  ).length;
}

function countDeploymentTiles(prtsData: Pick<PRTSLevelData, "mapData">): { total: number; melee: number; ranged: number } {
  let total = 0;
  let melee = 0;
  let ranged = 0;

  for (const row of prtsData.mapData.map) {
    for (const tileIdx of row) {
      const tile = prtsData.mapData.tiles[tileIdx];
      const type = normalizeBuildableType(tile?.buildableType);
      if (type === "melee") melee++;
      if (type === "ranged") ranged++;
      if (type === "all") {
        melee++;
        ranged++;
      }
      if (type !== "none") total++;
    }
  }

  return { total, melee, ranged };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const hasUtf16Bom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
      const likelyUtf16 = !hasUtf16Bom && buffer.slice(0, 80).some((byte, index) => index % 2 === 1 && byte === 0);
      resolve(hasUtf16Bom || likelyUtf16 ? buffer.toString("utf16le").replace(/^\uFEFF/, "") : buffer.toString("utf-8"));
    });
    process.stdin.on("error", reject);
  });
}

function loadOperatorBoxForGeneration(args: Args): { box: OperatorBox; source: string; configured: boolean } | null {
  if (args.operators) {
    if (!fs.existsSync(args.operators)) {
      throw new Error(`Operator file not found: ${args.operators}`);
    }
    return { box: new OperatorBox(args.operators), source: args.operators, configured: false };
  }

  const configured = loadConfiguredOperatorBox(getRuntimePaths().homeDir);
  if (!configured) return null;

  return { box: configured.box, source: configured.operatorsPath, configured: true };
}

function printOperatorBoxInfo(box: OperatorBox, source: string): void {
  const roles = box.roleCounts();
  console.log(`Source: ${source}`);
  console.log(`Owned operators: ${box.size}`);
  console.log(`High rarity: ${box.highRarityCount()}`);
  console.log(`Vanguard: ${roles.vanguard}`);
  console.log(`Guard: ${roles.guard}`);
  console.log(`Defender: ${roles.tank}`);
  console.log(`Medic: ${roles.medic}`);
  console.log(`Sniper: ${roles.sniper}`);
  console.log(`Caster: ${roles.caster}`);
  console.log(`Supporter: ${roles.support}`);
  console.log(`Specialist: ${roles.specialist}`);
}

function countMatchedRoles(box: OperatorBox): number {
  const roles = box.roleCounts();
  return Object.values(roles).reduce((sum, count) => sum + count, 0);
}

function warnIfOperatorNamesDoNotMatchPools(box: OperatorBox): void {
  if (box.size > 0 && countMatchedRoles(box) === 0) {
    console.error("Warning: no owned operator names matched MAAfight role pools. If you used a Windows pipe, try --operators <file> instead.");
  }
}

function printHelp(): void {
  console.log(`MAAfight v2 - corpus-driven MAA copilot script generator

Usage: maafight <command> [options]

Commands:
  init       Initialize local player operator database
  operators Manage local player operator database
  feedback  Record or summarize real battle kill results
  run       Probe MAA, import callback results, or record a dry-run RunResult
  generate   Generate copilot battle script for a stage
  gui        Start local Web GUI preview
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
  --file, -f <path>   Input script file for validate/run commands
  --operators <path>   MAA operator export JSON for personalized script
  --operators-stdin    Read MAA operator export JSON from stdin for init
  --data, -d <path>    Use local PRTS.Map JSON file instead of index lookup
  --explain            Print planning confidence, risks, and deployment reasons
  --new-candidate      Ignore a previous 100% result and search again
  --requirements <mode> none (default) or player
  --killed <n>         Killed enemies for feedback record
  --total <n>          Total enemies for feedback record (optional when known)
  --notes <text>       Optional feedback note
  --mode <mode>        run mode: manual-practice (default) or manual-normal
  --allow-sanity       Required for manual-normal dry-run records
  --callback-log <path> Import MAA callback JSON/JSONL instead of recording dry-run
  --maa <path>          MAA directory or executable for run probe
  --adb <path>          adb executable for run connect
  --address <addr>      adb device serial/address for run connect
  --connect-config <c>  MAA connection config for run connect / observe-screen
  --debug-dir <path>    Debug output directory for run observe-screen
  --help, -h           Show this help

Examples:
  maafight init --operators Arknights_OperBox_Export.json
  maafight init --operators-stdin
  maafight operators info
  maafight gui
  maafight generate --stage a001_01
  maafight feedback record --file script.json --killed 35 --total 42
  maafight feedback summary --stage GT-1
  maafight run --file script.json --mode manual-practice
  maafight run probe --maa C:\\Tools\\MAA
  maafight run connect --maa C:\\Tools\\MAA --address 127.0.0.1:16384
  maafight run observe-screen --file script.json --maa C:\\Tools\\MAA --address 127.0.0.1:16384
  maafight run --file script.json --callback-log maa-callback.jsonl
  maafight run summary --stage GT-1
  maafight run --file script.json --mode manual-normal --allow-sanity
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

async function cmdInit(args: Args): Promise<void> {
  if (args.operators && args.operatorsStdin) {
    console.error("Error: use either --operators or --operators-stdin, not both");
    process.exit(1);
  }
  if (!args.operators && !args.operatorsStdin) {
    console.error("Error: --operators or --operators-stdin is required for init");
    process.exit(1);
  }

  let raw: string;
  if (args.operators) {
    if (!fs.existsSync(args.operators)) {
      console.error(`Error: File not found: ${args.operators}`);
      process.exit(1);
    }
    raw = fs.readFileSync(args.operators, "utf-8");
  } else {
    raw = await readStdin();
    if (!raw.trim()) {
      console.error("Error: no JSON received from stdin");
      process.exit(1);
    }
  }

  const saved = saveOperatorConfig(raw, getRuntimePaths().homeDir);
  console.log(`Initialized local operator database: ${saved.operatorsPath}`);
  console.log(`Config written to: ${saved.configPath}`);
  printOperatorBoxInfo(saved.box, saved.operatorsPath);
  warnIfOperatorNamesDoNotMatchPools(saved.box);
}

function cmdOperators(args: Args): void {
  if (args.subcommand !== "info") {
    console.error("Usage: maafight operators info [--operators <path>]");
    process.exit(1);
  }

  let box: OperatorBox;
  let source: string;

  if (args.operators) {
    if (!fs.existsSync(args.operators)) {
      console.error(`Error: File not found: ${args.operators}`);
      process.exit(1);
    }
    box = new OperatorBox(args.operators);
    source = args.operators;
  } else {
    const configured = loadConfiguredOperatorBox(getRuntimePaths().homeDir);
    if (!configured) {
      console.error("Error: no local operator database found. Run: maafight init --operators <path>");
      process.exit(1);
    }
    box = configured.box;
    source = configured.operatorsPath;
  }

  printOperatorBoxInfo(box, source);
  warnIfOperatorNamesDoNotMatchPools(box);
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
    const inputStage = args.stage || inferStageIdFromDataPath(args.data);
    resolved = resolveStage(inputStage);
    stageId = resolved ? resolved.stageId : inputStage;
  } else {
    const inputStage = args.stage!;
    resolved = resolveStage(inputStage);
    prtsData = await loader.load(inputStage, { noCache: args.noCache });
    stageId = resolved ? resolved.stageId : inputStage;
  }

  await loader.loadEnemyDatabase();
  const displayName = getDisplayStageName(stageId, resolved);
  const mapData = adapter.adapt(prtsData, stageId, displayName);
  const facts = extractStageFacts(mapData);
  const operatorSource = loadOperatorBoxForGeneration(args);
  const playerOperators = operatorSource?.box.playerMap;
  if (operatorSource) {
    const mode = operatorSource.configured ? "local operator database" : "player data";
    if (!args.quiet) {
      console.error(`Loaded ${operatorSource.box.size} owned operators from ${mode}: ${operatorSource.source}`);
    }
  }
  const feedbackStore = new FeedbackStore(getRuntimePaths().homeDir);
  const operatorBoxHash = hashOperatorBox(playerOperators);
  let reusedFromGenerationId: string | undefined;
  let script: BattleScript;
  let modelVersion: string;
  let combatDataVersion: string;
  let combatCoverage: number;
  let skillCoverage: number;
  let candidateScore: number;
  let scoreBreakdown: Record<string, number>;

  const stageContentHash = computeStageContentHash(mapData);
  const combatModel = getCombatModelInfo();
  const revision = {
    engineVersion: "v2-skill-v1",
    stageContentHash,
    gameDataCommit: combatModel.commit,
  };
  const successful = !args.newCandidate ? feedbackStore.successfulGeneration(stageId, operatorBoxHash, revision) : undefined;
  if (successful?.engineVersion === "v2-skill-v1") {
    script = JSON.parse(JSON.stringify(successful.script)) as BattleScript;
    reusedFromGenerationId = successful.generationId;
    modelVersion = successful.modelVersion;
    combatDataVersion = successful.combatDataVersion;
    combatCoverage = successful.combatCoverage;
    skillCoverage = successful.skillCoverage ?? 0;
    candidateScore = successful.candidateScore;
    scoreBreakdown = successful.scoreBreakdown;
    if (!args.quiet) console.error(`Reused 100% feedback generation: ${successful.generationId}`);
  } else {
    const result = generateCopilotScript(displayName, mapData, {
      playerOperators,
      requirementsMode: args.requirementsMode || "none",
      excludedHashes: feedbackStore.excludedHashes(stageId, operatorBoxHash, stageContentHash),
      feedbackAdjustment: (_script, _hash, breakdown) => feedbackStore.feedbackAdjustment(stageId, operatorBoxHash, { ...breakdown }, stageContentHash),
    });
    script = result.script;
    modelVersion = result.modelVersion;
    combatDataVersion = result.combatModelVersion;
    combatCoverage = result.combatCoverage;
    skillCoverage = result.skillCoverage;
    candidateScore = result.score;
    scoreBreakdown = { ...result.breakdown };
    if (!args.quiet) result.warnings.forEach(warning => console.error(`Warning: ${warning}`));
  }
  const validation = validateScript(script, mapData);
  const protocol = validateMAAProtocol(script);
  if (!validation.valid || !protocol.valid) {
    const errors = [...validation.errors.map(error => error.message), ...protocol.errors.map(error => error.message)];
    throw new Error(`V2 candidate failed validation: ${errors.join("; ")}`);
  }

  if (args.explain) {
    process.stderr.write([
      `Stage: ${displayName}`,
      `Facts: ${facts.summary}`,
      `Candidate score: ${candidateScore.toFixed(2)} (ranking only, not a clear rate)`,
    ].join("\n") + "\n");
  }

  const scriptHash = computeScriptHash(script);
  const generationId = feedbackStore.createGenerationId();
  script.metadata = { ...script.metadata, generationId, scriptHash };
  const output = exportToCopilotFormat(script, { compress: !args.pretty });
  const outputPath = args.output ? path.resolve(args.output) : "";

  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, output, "utf-8");
    if (!args.quiet) console.error(`Script written to: ${args.output}`);
  } else {
    process.stdout.write(output);
    if (!args.quiet) process.stdout.write("\n");
  }
  feedbackStore.appendGeneration({
    schemaVersion: 2,
    generationId,
    scriptHash,
    stageId,
    stageName: displayName,
    operatorBoxHash,
    engineVersion: "v2-skill-v1",
    modelVersion,
    combatDataVersion,
    candidateScore,
    scoreBreakdown,
    combatCoverage,
    skillCoverage,
    stageContentHash,
    gameDataCommit: combatModel.commit,
    enemyTotal: facts.enemyCount,
    outputPath,
    script,
    reusedFromGenerationId,
    createdAt: new Date().toISOString(),
  });
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
    "  " + "stageId".padEnd(stageIdW) + "  " + "code".padEnd(codeW) + "  " + "category".padEnd(catW) + "  " + "filePath".padEnd(pathW)
  );
  console.log("  " + "─".repeat(stageIdW + codeW + catW + Math.min(pathW, 50) + 8));

  for (const s of stages) {
    console.log(
      "  " + s.stageId.padEnd(stageIdW) + "  " +
      (s.code || "").padEnd(codeW) + "  " +
      s.category.padEnd(catW) + "  " +
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
    const inputStage = args.stage || inferStageIdFromDataPath(args.data);
    resolved = resolveStage(inputStage);
    stageId = resolved ? resolved.stageId : inputStage;
  } else {
    const inputStage = args.stage!;
    resolved = resolveStage(inputStage);
    prtsData = await loader.load(inputStage, { noCache: args.noCache });
    stageId = resolved ? resolved.stageId : inputStage;
  }

  await loader.loadEnemyDatabase();
  const displayName = getDisplayStageName(stageId, resolved);
  const mapData = adapter.adapt(prtsData, stageId, displayName);
  const analysis = extractStageFacts(mapData);

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
  const protocol = validateMAAProtocol(script);

  if (result.errors.length > 0) {
    console.log("Errors:");
    result.errors.forEach(e => console.log(`  [${e.code}] ${e.message}`));
  }
  if (result.warnings.length > 0) {
    console.log("Warnings:");
    result.warnings.forEach(w => console.log(`  [${w.code}] ${w.message}`));
  }
  if (protocol.errors.length > 0) {
    console.log("Protocol Errors:");
    protocol.errors.forEach(e => console.log(`  [${e.code}] ${e.message}`));
  }
  if (protocol.warnings.length > 0) {
    console.log("Protocol Warnings:");
    protocol.warnings.forEach(w => console.log(`  [${w.code}] ${w.message}`));
  }
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("Script is valid.");
  }
  console.log(`Score: ${result.score}/100`);
  console.log(`Protocol Score: ${protocol.score}/100`);
}

async function cmdInfo(args: Args): Promise<void> {
  if (!args.stage && !args.data) {
    console.error("Error: --stage or --data is required for info");
    process.exit(1);
  }

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
    const inputStage = args.stage || inferStageIdFromDataPath(args.data);
    resolved = resolveStage(inputStage);
    stageId = resolved ? resolved.stageId : inputStage;
  } else {
    const loader = new PRTSMapLoader(CACHE_DIR, DATA_URL);
    const inputStage = args.stage!;
    resolved = resolveStage(inputStage);
    stageId = resolved ? resolved.stageId : inputStage;
    prtsData = await loader.load(inputStage, { noCache: args.noCache });
  }

  const mapSize = `${prtsData.mapData.map.length} × ${prtsData.mapData.map[0]?.length || 0}`;
  const deployable = countDeploymentTiles(prtsData);
  const routes = countActiveRoutes(prtsData);
  const enemies = new Set<string>();
  prtsData.waves.forEach(w => w.fragments.forEach(f => f.actions.forEach(a => {
    if (isSpawnActionType(a.actionType)) enemies.add(a.key);
  })));

  const indexEntry = resolved || resolveStage(stageId);

  console.log(`  Stage:        ${stageId}`);
  if (indexEntry?.code) console.log(`  Code:         ${indexEntry.code}`);
  if (indexEntry?.name) console.log(`  Name:         ${indexEntry.name}`);
  console.log(`  Category:     ${indexEntry?.category || (args.data ? "local" : "unknown")}`);
  console.log(`  Map Size:     ${mapSize}`);
  console.log(`  Deployable:   ${deployable.total} (${deployable.melee} melee, ${deployable.ranged} ranged)`);
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

async function cmdGui(): Promise<void> {
  const started = await startGuiServer();
  console.log(`MAAfight GUI running at ${started.url}`);
  try {
    await openUrl(started.url);
    writeGuiLog("browser_opened", { url: started.url });
    console.log("Browser opened. Press Ctrl+C to stop the server.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeGuiLog("browser_open_failed", { url: started.url, error: message });
    console.error(`Could not open browser automatically: ${message}`);
    console.error(`Open this URL manually: ${started.url}`);
  }
}

function cmdFeedback(args: Args): void {
  const store = new FeedbackStore(getRuntimePaths().homeDir);
  if (args.subcommand === "summary") {
    console.log(JSON.stringify(store.summary(args.stage), null, 2));
    return;
  }
  if (args.subcommand !== "record") {
    throw new Error("Usage: maafight feedback record|summary [options]");
  }
  if (!args.file || !fs.existsSync(args.file)) {
    throw new Error("--file <script.json> is required for feedback record");
  }
  if (!Number.isInteger(args.killed)) {
    throw new Error("--killed <n> is required for feedback record");
  }
  const rawJson = fs.readFileSync(args.file, "utf8");
  const operatorSource = loadOperatorBoxForGeneration(args);
  const record = store.recordFeedback({
    scriptHash: hashScriptJson(rawJson),
    killed: args.killed!,
    total: args.total,
    notes: args.notes,
    currentOperatorBoxHash: hashOperatorBox(operatorSource?.box.playerMap),
  });
  console.log(JSON.stringify(record, null, 2));
}

function cmdRun(args: Args): void {
  if (args.subcommand === "probe") {
    console.log(JSON.stringify(probeMaaEnvironment({ maaPath: args.maa }), null, args.pretty ? 2 : 0));
    return;
  }
  if (args.subcommand === "connect") {
    console.log(JSON.stringify(connectMaaEnvironment({
      maaPath: args.maa,
      adbPath: args.adb,
      address: args.address,
      connectConfig: args.connectConfig,
    }), null, args.pretty ? 2 : 0));
    return;
  }
  if (args.subcommand === "observe-screen") {
    if (!args.file) throw new Error("--file <script.json> is required for run observe-screen");
    const { result, debugScreenshotPath, debugSamplesPath } = recordScreenObservedRun({
      filePath: args.file,
      mode: args.mode,
      allowSanity: args.allowSanity,
      stateDir: getRuntimePaths().homeDir,
      maaPath: args.maa,
      adbPath: args.adb,
      address: args.address,
      connectConfig: args.connectConfig,
      debugDir: args.debugDir,
    });
    console.error(`Screen observer debug samples: ${debugSamplesPath}`);
    if (debugScreenshotPath) console.error(`Screen observer debug screenshot: ${debugScreenshotPath}`);
    console.log(JSON.stringify(result, null, args.pretty ? 2 : 0));
    return;
  }
  if (args.subcommand === "summary") {
    const store = new RunResultStore(getRuntimePaths().homeDir);
    console.log(JSON.stringify(store.summary(args.stage), null, args.pretty ? 2 : 0));
    return;
  }
  if (args.subcommand) throw new Error("Usage: maafight run [summary] [options]");
  if (!args.file) throw new Error("--file <script.json> is required for run");
  if (args.callbackLog) {
    const { result } = recordCallbackRun({
      filePath: args.file,
      callbackLogPath: args.callbackLog,
      mode: args.mode,
      allowSanity: args.allowSanity,
      stateDir: getRuntimePaths().homeDir,
    });
    console.error("MAA callback import only; no MAA, ADB, or emulator execution was started.");
    console.log(JSON.stringify(result, null, args.pretty ? 2 : 0));
    return;
  }
  const { result } = recordDryRun({
    filePath: args.file,
    mode: args.mode,
    allowSanity: args.allowSanity,
    stateDir: getRuntimePaths().homeDir,
  });
  console.error("MAA execution is not implemented yet; this dry-run skeleton only validated and recorded the script.");
  console.log(JSON.stringify(result, null, args.pretty ? 2 : 0));
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "init":
      await cmdInit(args);
      break;
    case "operators":
      cmdOperators(args);
      break;
    case "feedback":
      cmdFeedback(args);
      break;
    case "run":
      cmdRun(args);
      break;
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
    case "gui":
      await cmdGui();
      break;
    default:
      printHelp();
      process.exit(1);
  }
}

async function main(): Promise<void> {
  try {
    await runCli(process.argv.slice(2));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
