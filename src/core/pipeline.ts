import * as fs from "fs";
import * as path from "path";
import { PRTSMapLoader } from "../loader/PRTSMapLoader";
import { PRTSMapAdapter } from "../adapter/PRTSMapAdapter";
import { resolveStage, searchStages } from "../loader/levelIndex";
import { analyzeBattle } from "../battle/BattleAnalyzer";
import { generateScript, type GeneratorConfig } from "../battle/ScriptGenerator";
import { validateScript } from "../battle/ScriptValidator";
import { validateMAAProtocol } from "../battle/MAAProtocolValidator";
import { buildPlanningReport, formatPlanningReport } from "../battle/PlanningReport";
import { exportToCopilotFormat } from "../battle/ScriptExporter";
import { OperatorBox } from "../player/OperatorBox";
import { loadConfiguredOperatorBox } from "../player/PlayerConfig";
import { getRuntimePaths } from "../runtime/paths";
import type {
  BattleScript,
  MapData,
  PRTSLevelData,
  PlayerOperator,
  StageIndexEntry,
  TacticalAnalysis,
  ValidationResult,
} from "../types";

export type SquadMode = "fixed" | "groups" | "hybrid";

export interface OperatorInput {
  operatorsJson?: string;
  operatorFilePath?: string;
}

export interface PipelineOptions {
  cacheDir?: string;
  dataUrl?: string;
}

export interface AnalyzeStageInput extends OperatorInput {
  stage: string;
}

export interface GenerateStageInput extends OperatorInput {
  stage: string;
  squadMode?: SquadMode;
  pretty?: boolean;
  outputDir?: string;
  fileName?: string;
}

export interface ValidateScriptInput {
  scriptJson: string;
}

export interface PipelineWarning {
  code?: string;
  message: string;
}

export interface AnalyzeStageResult {
  stageId: string;
  stageName: string;
  analysis: TacticalAnalysis;
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
export const DEFAULT_SQUAD_MODE: SquadMode = "fixed";
export const SUPPORTED_SQUAD_MODES: SquadMode[] = ["fixed", "groups", "hybrid"];

function inferStageIdFromDataPath(dataPath: string): string {
  return path.basename(dataPath, ".json").replace(/^level_/, "");
}

function getDisplayStageName(stageId: string, resolved: StageIndexEntry | null): string {
  return resolved?.code || resolved?.name || stageId;
}

function sanitizeFileName(name: string): string {
  const baseName = path.basename(name).trim();
  const safe = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return safe.endsWith(".json") ? safe : `${safe}.json`;
}

export function makeDefaultScriptFileName(stageName: string, resolved?: StageIndexEntry | null): string {
  const primary = resolved?.code || stageName || resolved?.stageId || "script";
  const parts = [primary];
  if (resolved?.name && resolved.name !== primary) {
    parts.push(resolved.name);
  }
  return sanitizeFileName(`${parts.join("_")}.json`);
}

function parseOperatorInput(input: OperatorInput): { playerOperators?: Map<string, PlayerOperator>; warnings: string[] } {
  const warnings: string[] = [];

  if (input.operatorsJson?.trim()) {
    if (input.operatorFilePath?.trim()) {
      warnings.push("operatorsJson and operatorFilePath were both provided; using pasted operatorsJson.");
    }
    const operators = OperatorBox.parseJson(input.operatorsJson);
    return { playerOperators: OperatorBox.fromOperators(operators).playerMap, warnings };
  }

  if (input.operatorFilePath?.trim()) {
    const operatorPath = path.resolve(input.operatorFilePath);
    if (!fs.existsSync(operatorPath)) {
      throw new Error(`Operator file not found: ${operatorPath}`);
    }
    return { playerOperators: new OperatorBox(operatorPath).playerMap, warnings };
  }

  const configured = loadConfiguredOperatorBox(getRuntimePaths().homeDir);
  if (configured) {
    return { playerOperators: configured.box.playerMap, warnings };
  }

  return { warnings };
}

function splitStageParts(entry: StageIndexEntry): { series: string; number: string } {
  const key = (entry.code || entry.stageId).toUpperCase();
  const letters = key.match(/[A-Z]+/)?.[0] || key.split(/[-_]/)[0] || key;
  const numbers = key.match(/\d+/g) || [];
  return {
    series: letters.slice(0, 2),
    number: numbers.join("-"),
  };
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
  if (q.length < 1) return [];

  return searchStages(q)
    .sort((a, b) => {
      const score = stageSearchScore(a, q) - stageSearchScore(b, q);
      if (score !== 0) return score;
      return (a.code || a.stageId).localeCompare(b.code || b.stageId);
    })
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map(entry => {
      const { series, number } = splitStageParts(entry);
      return {
        stageId: entry.stageId,
        stageName: getDisplayStageName(entry.stageId, entry),
        code: entry.code,
        name: entry.name,
        category: entry.category,
        filePath: entry.filePath,
        series,
        number,
      };
    });
}

function applySquadMode(script: BattleScript, squadMode: SquadMode): BattleScript {
  const next: BattleScript = {
    ...script,
    actions: script.actions.map(action => ({ ...action })),
    groups: script.groups.map(group => ({
      ...group,
      opers: group.opers.map(op => ({ ...op })),
    })),
    opers: script.opers.map(op => ({ ...op })),
    metadata: { ...script.metadata, squadMode },
  };

  if (squadMode === "fixed") {
    next.groups = [];
    return next;
  }

  if (squadMode === "groups") {
    const operatorToGroup = new Map<string, string>();
    for (const group of next.groups) {
      for (const op of group.opers) {
        if (!operatorToGroup.has(op.name)) {
          operatorToGroup.set(op.name, group.name);
        }
      }
    }

    next.opers = [];
    next.actions = next.actions.map(action => {
      if (action.type !== "Deploy" || !action.name) return action;
      const groupName = operatorToGroup.get(action.name);
      return groupName ? { ...action, name: groupName } : action;
    });
  }

  return next;
}

async function loadStage(stage: string, options: PipelineOptions): Promise<{
  prtsData: PRTSLevelData;
  stageId: string;
  resolved: StageIndexEntry | null;
  loader: PRTSMapLoader;
}> {
  const loader = new PRTSMapLoader(options.cacheDir || DEFAULT_CACHE_DIR, options.dataUrl || DEFAULT_DATA_URL);
  const resolved = resolveStage(stage);
  const prtsData = await loader.load(stage);
  return {
    prtsData,
    stageId: resolved ? resolved.stageId : inferStageIdFromDataPath(stage),
    resolved,
    loader,
  };
}

async function buildStageContext(stage: string, options: PipelineOptions): Promise<{
  mapData: MapData;
  analysis: TacticalAnalysis;
  stageId: string;
  stageName: string;
  resolved: StageIndexEntry | null;
}> {
  const { prtsData, stageId, resolved, loader } = await loadStage(stage, options);
  await loader.loadEnemyDatabase();
  const adapter = new PRTSMapAdapter(loader);
  const stageName = getDisplayStageName(stageId, resolved);
  const mapData = adapter.adapt(prtsData, stageId, stageName);
  const analysis = analyzeBattle(mapData);
  return { mapData, analysis, stageId, stageName, resolved };
}

export async function analyzeStage(input: AnalyzeStageInput, options: PipelineOptions = {}): Promise<AnalyzeStageResult> {
  if (!input.stage?.trim()) {
    throw new Error("stage is required");
  }
  const { warnings } = parseOperatorInput(input);
  const { analysis, stageId, stageName } = await buildStageContext(input.stage.trim(), options);
  return { stageId, stageName, analysis, warnings };
}

export async function generateStage(input: GenerateStageInput, options: PipelineOptions = {}): Promise<GenerateStageResult> {
  if (!input.stage?.trim()) {
    throw new Error("stage is required");
  }
  if (input.squadMode && !SUPPORTED_SQUAD_MODES.includes(input.squadMode)) {
    throw new Error(`Unsupported squadMode: ${input.squadMode}`);
  }

  const { playerOperators, warnings } = parseOperatorInput(input);
  const { mapData, analysis, stageId, stageName, resolved } = await buildStageContext(input.stage.trim(), options);

  const config: GeneratorConfig = {};
  if (playerOperators) config.playerOperators = playerOperators;

  const squadMode = input.squadMode || DEFAULT_SQUAD_MODE;
  const script = applySquadMode(generateScript(stageName, mapData, analysis, config), squadMode);
  const validation = validateScript(script, mapData);
  const protocol = validateMAAProtocol(script);
  const report = buildPlanningReport({ mapData, analysis, script, validation, protocol });
  const json = exportToCopilotFormat(script, { compress: !input.pretty });

  const outputDir = path.resolve(input.outputDir || DEFAULT_OUTPUT_DIR);
  const fileName = sanitizeFileName(input.fileName || makeDefaultScriptFileName(stageName, resolved));
  const outputPath = path.join(outputDir, fileName);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, json, "utf-8");

  return {
    stageId,
    stageName,
    analysis,
    outputPath,
    outputDir,
    fileName,
    script,
    json,
    validation,
    protocol,
    explain: formatPlanningReport(report, script),
    warnings,
  };
}

export function validateScriptJson(input: ValidateScriptInput): ValidateScriptResult {
  if (!input.scriptJson?.trim()) {
    throw new Error("scriptJson is required");
  }
  const script = JSON.parse(input.scriptJson) as BattleScript;
  const validation = validateScript(script);
  const protocol = validateMAAProtocol(script);
  return { validation, protocol, warnings: [] };
}
