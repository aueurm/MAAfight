import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getMaafightDir } from "../player/PlayerConfig";
import type { PracticeTestResult } from "../shared/practiceResult";
import type { BattleScript, PlayerOperator } from "../types";

export interface ScriptFingerprint {
  scriptHash: string;
  firstDeploy?: string;
  firstThreeDeploys?: string[];
  deployCells?: string[];
  deployDirections?: string[];
  operatorIds?: string[];
  timingBucket?: string;
  skillStrategy?: "daemon" | "none" | "manual" | "mixed";
}

export interface GenerationRecord {
  schemaVersion: 1 | 2;
  generationId: string;
  scriptHash: string;
  stageId: string;
  stageName: string;
  operatorBoxHash: string;
  engineVersion: string;
  modelVersion: string;
  combatDataVersion: string;
  candidateScore: number;
  scoreBreakdown: Record<string, number>;
  combatCoverage: number;
  skillCoverage?: number;
  stageContentHash?: string;
  gameDataCommit?: string;
  enemyTotal: number;
  outputPath: string;
  script: BattleScript;
  reusedFromGenerationId?: string;
  createdAt: string;
}

export interface FeedbackRecord {
  schemaVersion: 1 | 2;
  feedbackId: string;
  generationId?: string;
  scriptHash: string;
  stageId: string;
  operatorBoxHash: string;
  currentOperatorBoxHash: string;
  operatorBoxChanged: boolean;
  killed: number;
  total: number;
  ratio: number;
  notes?: string;
  usableForLearning: boolean;
  stageContentHash?: string;
  createdAt: string;
}

export interface FeedbackSummary {
  count: number;
  usableCount: number;
  averageRatio: number | null;
  medianRatio: number | null;
  minimumRatio: number | null;
  fullClearCount: number;
}

export interface RecordFeedbackInput {
  scriptHash: string;
  killed: number;
  total?: number;
  notes?: string;
  currentOperatorBoxHash: string;
}

export interface RecordPracticeTestInput {
  scriptHash: string;
  testResult: PracticeTestResult;
  currentOperatorBoxHash: string;
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonLines<T>(filePath: string): { records: T[]; warnings: string[] } {
  if (!fs.existsSync(filePath)) return { records: [], warnings: [] };
  const records: T[] = [];
  const warnings: string[] = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      warnings.push(`Skipped invalid JSONL line ${index + 1} in ${path.basename(filePath)}.`);
    }
  }
  return { records, warnings };
}

export function hashOperatorBox(playerOperators?: Map<string, PlayerOperator>): string {
  if (!playerOperators || playerOperators.size === 0) return "default-loadout";
  const normalized = [...playerOperators.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(operator => ({
      name: operator.name,
      own: operator.own,
      elite: operator.elite,
      level: operator.level,
      potential: operator.potential,
      skillLevel: operator.skillLevel ?? null,
      module: operator.module ?? null,
      moduleLevel: operator.moduleLevel ?? null,
      cost: operator.cost ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function hashScriptJson(rawJson: string): string {
  const parsed = JSON.parse(rawJson) as unknown;
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

const SCORE_DISTANCE_KEYS = ["publicPrior", "placement", "direction", "timing", "operatorPower"] as const;

function scoreValue(breakdown: Record<string, number>, key: typeof SCORE_DISTANCE_KEYS[number]): number {
  const value = breakdown[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (key === "publicPrior") return breakdown.corpus ?? 50;
  if (key === "placement" || key === "direction") return breakdown.position ?? 50;
  if (key === "operatorPower") return ((breakdown.tasks ?? 50) + (breakdown.combat ?? 50)) / 2;
  return breakdown.timing ?? 50;
}

function deploySteps(script: BattleScript): Array<{ name?: string; row: number; col: number; direction?: string; delay: number }> {
  return script.actions
    .filter(action => action.type === "Deploy" && action.location)
    .map(action => ({
      name: action.name,
      row: action.location![0],
      col: action.location![1],
      direction: action.direction,
      delay: action.pre_delay || action.time_elapsed || 0,
    }));
}

function deployKey(step: ReturnType<typeof deploySteps>[number]): string {
  return `${step.name || "?"}@${step.row},${step.col}:${step.direction || "None"}`;
}

function jaccard(left: string[] = [], right: string[] = []): number {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter(value => b.has(value)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

function orderedOverlap(left: string[] = [], right: string[] = []): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let matches = 0;
  for (let index = 0; index < length; index++) {
    if (left[index] === right[index]) matches++;
  }
  return matches / Math.max(left.length, right.length);
}

function skillStrategy(script: BattleScript): ScriptFingerprint["skillStrategy"] {
  const hasDaemon = script.actions.some(action => action.type === "SkillDaemon");
  const hasManual = script.actions.some(action => action.type === "Skill");
  if (hasDaemon && hasManual) return "mixed";
  if (hasDaemon) return "daemon";
  if (hasManual) return "manual";
  return "none";
}

export function extractScriptFingerprint(script: BattleScript, scriptHash = ""): ScriptFingerprint {
  const deploys = deploySteps(script);
  const deployCells = deploys.map(step => `${step.row},${step.col}`);
  return {
    scriptHash,
    firstDeploy: deploys[0] ? deployKey(deploys[0]) : undefined,
    firstThreeDeploys: deploys.slice(0, 3).map(deployKey),
    deployCells: [...new Set(deployCells)].sort(),
    deployDirections: deploys.map(step => step.direction || "None"),
    operatorIds: (script.opers || []).map(operator => operator.name).sort(),
    timingBucket: deploys.map(step => Math.round(step.delay / 1000)).join("|"),
    skillStrategy: skillStrategy(script),
  };
}

export function fingerprintPenalty(candidate: ScriptFingerprint, failed: ScriptFingerprint): number {
  if (candidate.scriptHash && candidate.scriptHash === failed.scriptHash) return 20;
  let penalty = 0;
  if (orderedOverlap(candidate.firstThreeDeploys, failed.firstThreeDeploys) >= 2 / 3) penalty += 8;
  if (jaccard(candidate.deployCells, failed.deployCells) >= 0.7) penalty += 6;
  if (orderedOverlap(candidate.deployDirections, failed.deployDirections) >= 0.7) penalty += 4;
  if (candidate.timingBucket && candidate.timingBucket === failed.timingBucket) penalty += 4;
  if (jaccard(candidate.operatorIds, failed.operatorIds) >= 0.8) penalty += 3;
  if (candidate.skillStrategy && candidate.skillStrategy === failed.skillStrategy) penalty += 2;
  return Math.min(18, penalty);
}

export class FeedbackStore {
  readonly generationPath: string;
  readonly feedbackPath: string;

  constructor(cwd = process.cwd()) {
    const dir = getMaafightDir(cwd);
    this.generationPath = path.join(dir, "generations.jsonl");
    this.feedbackPath = path.join(dir, "feedback.jsonl");
  }

  createGenerationId(): string {
    return randomUUID();
  }

  appendGeneration(record: GenerationRecord): void {
    appendJsonLine(this.generationPath, record);
  }

  loadGenerations(): { records: GenerationRecord[]; warnings: string[] } {
    return readJsonLines<GenerationRecord>(this.generationPath);
  }

  loadFeedback(): { records: FeedbackRecord[]; warnings: string[] } {
    return readJsonLines<FeedbackRecord>(this.feedbackPath);
  }

  findGenerationByHash(scriptHash: string): GenerationRecord | undefined {
    return this.loadGenerations().records.filter(record => record.scriptHash === scriptHash).at(-1);
  }

  recordFeedback(input: RecordFeedbackInput): FeedbackRecord {
    if (!Number.isInteger(input.killed) || input.killed < 0) throw new Error("killed must be a non-negative integer");
    const generation = this.findGenerationByHash(input.scriptHash);
    const total = input.total ?? generation?.enemyTotal;
    if (!Number.isInteger(total) || !total || total <= 0) throw new Error("total must be a positive integer");
    if (input.killed > total) throw new Error("killed cannot be greater than total");
    const operatorBoxHash = generation?.operatorBoxHash || "unknown";
    const operatorBoxChanged = Boolean(generation && operatorBoxHash !== input.currentOperatorBoxHash);
    const record: FeedbackRecord = {
      schemaVersion: 2,
      feedbackId: randomUUID(),
      generationId: generation?.generationId,
      scriptHash: input.scriptHash,
      stageId: generation?.stageId || "unknown",
      operatorBoxHash,
      currentOperatorBoxHash: input.currentOperatorBoxHash,
      operatorBoxChanged,
      killed: input.killed,
      total,
      ratio: input.killed / total,
      notes: input.notes?.trim() || undefined,
      usableForLearning: Boolean(generation && !operatorBoxChanged),
      stageContentHash: generation?.stageContentHash,
      createdAt: new Date().toISOString(),
    };
    appendJsonLine(this.feedbackPath, record);
    return record;
  }

  recordPracticeTestResult(input: RecordPracticeTestInput): FeedbackRecord | null {
    if (input.testResult === "进入失败") return null;
    const generation = this.findGenerationByHash(input.scriptHash);
    if (!generation) throw new Error(`generation not found for scriptHash: ${input.scriptHash}`);
    // ponytail: star-only practice feedback has no kill count; replace with StageDrops stats when available.
    const killed = input.testResult === "三星"
      ? generation.enemyTotal
      : input.testResult === "二星"
        ? Math.max(0, generation.enemyTotal - 3)
        : 0;
    return this.recordFeedback({
      scriptHash: input.scriptHash,
      killed,
      total: generation.enemyTotal,
      currentOperatorBoxHash: input.currentOperatorBoxHash,
      notes: `auto practice test result: ${input.testResult}`,
    });
  }

  successfulGeneration(
    stageId: string,
    operatorBoxHash: string,
    revision?: { engineVersion: string; stageContentHash: string; gameDataCommit: string }
  ): GenerationRecord | undefined {
    const generations = this.loadGenerations().records;
    const feedback = this.loadFeedback().records;
    const successfulIds = new Set(
      feedback
        .filter(record => record.usableForLearning && record.ratio === 1 && record.operatorBoxHash === operatorBoxHash)
        .map(record => record.generationId)
        .filter((id): id is string => Boolean(id))
    );
    return generations.filter(record => record.stageId === stageId
      && record.operatorBoxHash === operatorBoxHash
      && successfulIds.has(record.generationId)
      && (!revision || (record.engineVersion === revision.engineVersion
        && record.stageContentHash === revision.stageContentHash
        && record.gameDataCommit === revision.gameDataCommit))).at(-1);
  }

  excludedHashes(stageId: string, operatorBoxHash: string, stageContentHash?: string, engineVersion?: string): Set<string> {
    const generations = new Map(this.loadGenerations().records.map(record => [record.generationId, record]));
    return new Set(
      this.loadFeedback().records
        .filter(record => {
          const generation = record.generationId ? generations.get(record.generationId) : undefined;
          return record.stageId === stageId && record.operatorBoxHash === operatorBoxHash
            && record.usableForLearning && record.ratio < 1
            && (!stageContentHash || record.stageContentHash === stageContentHash)
            && (!engineVersion || generation?.engineVersion === engineVersion);
        })
        .map(record => record.scriptHash)
    );
  }

  feedbackAdjustment(
    stageId: string,
    operatorBoxHash: string,
    breakdown: Record<string, number>,
    stageContentHash?: string
  ): number {
    return -this.feedbackPenalty(stageId, operatorBoxHash, breakdown, stageContentHash);
  }

  feedbackPenalty(
    stageId: string,
    operatorBoxHash: string,
    breakdown: Record<string, number>,
    stageContentHash?: string,
    script?: BattleScript,
    engineVersion?: string,
    scriptHash = ""
  ): number {
    const generations = new Map(this.loadGenerations().records.map(record => [record.generationId, record]));
    const records = this.loadFeedback().records.filter(record =>
      record.usableForLearning && record.stageId === stageId && record.operatorBoxHash === operatorBoxHash && record.generationId
      && record.ratio < 1
      && (!stageContentHash || record.stageContentHash === stageContentHash)
      && (!engineVersion || generations.get(record.generationId!)?.engineVersion === engineVersion)
    );
    if (records.length === 0) return 0;
    let penalty = 0;
    const candidateFingerprint = script ? extractScriptFingerprint(script, scriptHash) : null;
    for (const feedback of records) {
      const generation = generations.get(feedback.generationId!);
      if (!generation) continue;
      const value = candidateFingerprint
        ? fingerprintPenalty(candidateFingerprint, extractScriptFingerprint(generation.script, generation.scriptHash))
        : Math.exp(-4 * SCORE_DISTANCE_KEYS.reduce((sum, key) =>
          sum + Math.abs(scoreValue(breakdown, key) - scoreValue(generation.scoreBreakdown, key)) / 100, 0) / SCORE_DISTANCE_KEYS.length);
      penalty += candidateFingerprint ? value * (1 - feedback.ratio) : (1 - feedback.ratio) * 30 * value;
    }
    return Math.min(18, penalty);
  }

  summary(stageId?: string): FeedbackSummary {
    const generations = this.loadGenerations().records;
    const generationById = new Map(generations.map(record => [record.generationId, record]));
    const stageNames = new Set(
      generations
        .filter(record => stageId && (record.stageId === stageId || record.stageName === stageId))
        .map(record => record.stageName)
    );
    const records = this.loadFeedback().records.filter(record => {
      if (!stageId) return true;
      if (record.stageId === stageId) return true;
      const generation = record.generationId ? generationById.get(record.generationId) : undefined;
      return Boolean(generation && (generation.stageId === stageId || generation.stageName === stageId || stageNames.has(generation.stageName)));
    });
    const ratios = records.map(record => record.ratio).sort((a, b) => a - b);
    const averageRatio = ratios.length ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length : null;
    const medianRatio = ratios.length
      ? ratios.length % 2 === 1
        ? ratios[(ratios.length - 1) / 2]
        : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
      : null;
    return {
      count: records.length,
      usableCount: records.filter(record => record.usableForLearning).length,
      averageRatio,
      medianRatio,
      minimumRatio: ratios[0] ?? null,
      fullClearCount: records.filter(record => record.ratio === 1).length,
    };
  }
}
