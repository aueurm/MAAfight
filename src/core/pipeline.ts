import * as fs from "fs";
import * as path from "path";
import { PRTSMapLoader } from "../loader/PRTSMapLoader";
import { PRTSMapAdapter } from "../adapter/PRTSMapAdapter";
import { resolveStage, searchStages } from "../loader/levelIndex";
import { validateScript } from "../copilot/ScriptValidator";
import { validateMAAProtocol } from "../copilot/MAAProtocolValidator";
import { exportToCopilotFormat } from "../copilot/ScriptExporter";
import { computeScriptHash, extractStageFacts, generateCopilotScript, type StageFacts } from "../engine";
import { getCombatModelInfo } from "../engine/CombatModel";
import { computeStageContentHash } from "../engine/EncounterContext";
import { FeedbackStore, hashOperatorBox } from "../feedback/FeedbackStore";
import { OperatorBox } from "../player/OperatorBox";
import { loadConfiguredOperatorBox } from "../player/PlayerConfig";
import { getRuntimePaths } from "../runtime/paths";
import { inferStageIdFromDataPath, getDisplayStageName } from "./stageDisplay";
import type {
  BattleScript,
  MapData,
  PRTSLevelData,
  PlayerOperator,
  StageIndexEntry,
  ValidationResult,
} from "../types";

export interface OperatorInput {
  operatorsJson?: string;
  operatorFilePath?: string;
}

export interface PipelineOptions {
  cacheDir?: string;
  dataUrl?: string;
  stateDir?: string;
}

export interface AnalyzeStageInput extends OperatorInput {
  stage: string;
}

export interface GenerateStageInput extends OperatorInput {
  stage: string;
  pretty?: boolean;
  outputDir?: string;
  fileName?: string;
  newCandidate?: boolean;
}

export interface ValidateScriptInput {
  scriptJson: string;
}

export interface AnalyzeStageResult {
  stageId: string;
  stageName: string;
  analysis: StageFacts;
  warnings: string[];
}

export interface GenerateStageResult extends AnalyzeStageResult {
  outputPath: string;
  fileName: string;
  outputDir: string;
  script: BattleScript;
  json: string;
  validation: ValidationResult;
  protocol: ReturnType<typeof validateMAAProtocol>;
  explain: string;
  generationId: string;
  scriptHash: string;
  candidateScore: number;
  modelVersion: string;
  combatCoverage: number;
  skillCoverage: number;
}

export interface ValidateScriptResult {
  validation: ValidationResult;
  protocol: ReturnType<typeof validateMAAProtocol>;
  warnings: string[];
}

export interface StageSuggestion {
  stageId: string;
  stageName: string;
  code?: string;
  name?: string;
  category: string;
  filePath: string;
  series: string;
  number: string;
}

export const DEFAULT_CACHE_DIR = getRuntimePaths().cacheLevelsDir;
export const DEFAULT_DATA_URL = process.env.MAAFIGHT_DATA_URL || "https://map.ark-nights.com";
export const DEFAULT_OUTPUT_DIR = getRuntimePaths().outputDir;

function sanitizeFileName(name: string): string {
  const baseName = path.basename(name).trim();
  const safe = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return safe.endsWith(".json") ? safe : `${safe}.json`;
}

export function makeDefaultScriptFileName(stageName: string, resolved?: StageIndexEntry | null): string {
  const primary = resolved?.code || stageName || resolved?.stageId || "script";
  const parts = [primary];
  if (resolved?.name && resolved.name !== primary) parts.push(resolved.name);
  return sanitizeFileName(`${parts.join("_")}.json`);
}

function parseOperatorInput(
  input: OperatorInput,
  stateDir = getRuntimePaths().homeDir
): { playerOperators?: Map<string, PlayerOperator>; warnings: string[] } {
  const warnings: string[] = [];
  if (input.operatorsJson?.trim()) {
    if (input.operatorFilePath?.trim()) warnings.push("operatorsJson and operatorFilePath were both provided; using pasted operatorsJson.");
    const operators = OperatorBox.parseJson(input.operatorsJson);
    return { playerOperators: OperatorBox.fromOperators(operators).playerMap, warnings };
  }
  if (input.operatorFilePath?.trim()) {
    const operatorPath = path.resolve(input.operatorFilePath);
    if (!fs.existsSync(operatorPath)) throw new Error(`Operator file not found: ${operatorPath}`);
    return { playerOperators: new OperatorBox(operatorPath).playerMap, warnings };
  }
  const configured = loadConfiguredOperatorBox(stateDir);
  return configured ? { playerOperators: configured.box.playerMap, warnings } : { warnings };
}

function splitStageParts(entry: StageIndexEntry): { series: string; number: string } {
  const key = (entry.code || entry.stageId).toUpperCase();
  const letters = key.match(/[A-Z]+/)?.[0] || key.split(/[-_]/)[0] || key;
  return { series: letters.slice(0, 2), number: (key.match(/\d+/g) || []).join("-") };
}

function stageSearchScore(entry: StageIndexEntry, query: string): number {
  const q = query.toLowerCase();
  const code = (entry.code || "").toLowerCase();
  const stageId = entry.stageId.toLowerCase();
  const name = (entry.name || "").toLowerCase();
  if (code === q || stageId === q) return 0;
  if (code.startsWith(q)) return 1;
  if (stageId.startsWith(q)) return 2;
  if (name.startsWith(q)) return 3;
  if (code.includes(q)) return 4;
  if (stageId.includes(q)) return 5;
  if (name.includes(q)) return 6;
  return 7;
}

export function searchStageSuggestions(query: string, limit = 24): StageSuggestion[] {
  const q = query.trim();
  if (!q) return [];
  const seen = new Set<string>();
  return searchStages(q)
    .sort((a, b) => stageSearchScore(a, q) - stageSearchScore(b, q)
      || (a.code || a.stageId).localeCompare(b.code || b.stageId))
    .map(entry => entry.code ? resolveStage(entry.code) || entry : entry)
    .filter(entry => {
      const key = (entry.code || entry.stageId).toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map(entry => ({
      stageId: entry.stageId,
      stageName: getDisplayStageName(entry.stageId, entry),
      code: entry.code,
      name: entry.name,
      category: entry.category,
      filePath: entry.filePath,
      ...splitStageParts(entry),
    }));
}

async function buildStageContext(stage: string, options: PipelineOptions): Promise<{
  mapData: MapData;
  facts: StageFacts;
  stageId: string;
  stageName: string;
  resolved: StageIndexEntry | null;
}> {
  const loader = new PRTSMapLoader(options.cacheDir || DEFAULT_CACHE_DIR, options.dataUrl || DEFAULT_DATA_URL);
  const resolved = resolveStage(stage);
  const prtsData: PRTSLevelData = await loader.load(stage);
  const stageId = resolved?.stageId || inferStageIdFromDataPath(stage);
  await loader.loadEnemyDatabase();
  const stageName = getDisplayStageName(stageId, resolved);
  const mapData = new PRTSMapAdapter(loader).adapt(prtsData, stageId, stageName);
  return { mapData, facts: extractStageFacts(mapData), stageId, stageName, resolved };
}

export async function analyzeStage(input: AnalyzeStageInput, options: PipelineOptions = {}): Promise<AnalyzeStageResult> {
  if (!input.stage?.trim()) throw new Error("stage is required");
  const { warnings } = parseOperatorInput(input, options.stateDir);
  const { facts, stageId, stageName } = await buildStageContext(input.stage.trim(), options);
  return { stageId, stageName, analysis: facts, warnings };
}

export async function generateStage(input: GenerateStageInput, options: PipelineOptions = {}): Promise<GenerateStageResult> {
  if (!input.stage?.trim()) throw new Error("stage is required");
  const parsedOperators = parseOperatorInput(input, options.stateDir);
  const warnings = [...parsedOperators.warnings];
  const { mapData, facts, stageId, stageName, resolved } = await buildStageContext(input.stage.trim(), options);
  const feedbackStore = new FeedbackStore(options.stateDir || getRuntimePaths().homeDir);
  const operatorBoxHash = hashOperatorBox(parsedOperators.playerOperators);
  const stageContentHash = computeStageContentHash(mapData);
  const combatModel = getCombatModelInfo();
  const successful = !input.newCandidate ? feedbackStore.successfulGeneration(stageId, operatorBoxHash, {
    engineVersion: "v2-skill-v1",
    stageContentHash,
    gameDataCommit: combatModel.commit,
  }) : undefined;

  let script: BattleScript;
  let modelVersion: string;
  let combatDataVersion: string;
  let combatCoverage: number;
  let skillCoverage: number;
  let candidateScore: number;
  let scoreBreakdown: Record<string, number>;
  let reusedFromGenerationId: string | undefined;

  if (successful && successful.engineVersion === "v2-skill-v1") {
    script = JSON.parse(JSON.stringify(successful.script)) as BattleScript;
    modelVersion = successful.modelVersion;
    combatDataVersion = successful.combatDataVersion;
    combatCoverage = successful.combatCoverage;
    skillCoverage = successful.skillCoverage ?? 0;
    candidateScore = successful.candidateScore;
    scoreBreakdown = successful.scoreBreakdown;
    reusedFromGenerationId = successful.generationId;
    warnings.push(`Reused a 100% v2 generation ${successful.generationId}.`);
  } else {
    const result = generateCopilotScript(stageName, mapData, {
      playerOperators: parsedOperators.playerOperators,
      excludedHashes: feedbackStore.excludedHashes(stageId, operatorBoxHash, stageContentHash),
      feedbackAdjustment: (_script, _hash, breakdown) => feedbackStore.feedbackAdjustment(
        stageId, operatorBoxHash, { ...breakdown }, stageContentHash
      ),
    });
    script = result.script;
    modelVersion = result.modelVersion;
    combatDataVersion = result.combatModelVersion;
    combatCoverage = result.combatCoverage;
    skillCoverage = result.skillCoverage;
    candidateScore = result.score;
    scoreBreakdown = { ...result.breakdown };
    warnings.push(...result.warnings);
  }

  const validation = validateScript(script, mapData);
  const protocol = validateMAAProtocol(script);
  if (!validation.valid || !protocol.valid) {
    const errors = [...validation.errors.map(error => error.message), ...protocol.errors.map(error => error.message)];
    throw new Error(`V2 candidate failed validation: ${errors.join("; ")}`);
  }

  const outputDir = path.resolve(input.outputDir || DEFAULT_OUTPUT_DIR);
  const fileName = sanitizeFileName(input.fileName || makeDefaultScriptFileName(stageName, resolved));
  const outputPath = path.join(outputDir, fileName);
  const scriptHash = computeScriptHash(script);
  const generationId = feedbackStore.createGenerationId();
  script.metadata = { ...script.metadata, generationId, scriptHash };
  const json = exportToCopilotFormat(script, { compress: !input.pretty });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, json, "utf8");
  feedbackStore.appendGeneration({
    schemaVersion: 2,
    generationId,
    scriptHash,
    stageId,
    stageName,
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

  return {
    stageId,
    stageName,
    analysis: facts,
    outputPath,
    outputDir,
    fileName,
    script,
    json,
    validation,
    protocol,
    explain: [
      `Stage: ${facts.stageId}`,
      `Facts: ${facts.summary}`,
      `Candidate score: ${candidateScore.toFixed(2)} (ranking only, not a clear rate)`,
      ...warnings.map(warning => `Warning: ${warning}`),
    ].join("\n"),
    warnings,
    generationId,
    scriptHash,
    candidateScore,
    modelVersion,
    combatCoverage,
    skillCoverage,
  };
}

export function validateScriptJson(input: ValidateScriptInput): ValidateScriptResult {
  if (!input.scriptJson?.trim()) throw new Error("scriptJson is required");
  const script = JSON.parse(input.scriptJson) as BattleScript;
  return { validation: validateScript(script), protocol: validateMAAProtocol(script), warnings: [] };
}
