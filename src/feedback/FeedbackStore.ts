import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getMaafightDir } from "../player/PlayerConfig";
import type { BattleScript, PlayerOperator } from "../types";

export interface GenerationRecord {
  schemaVersion: 1;
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
  enemyTotal: number;
  outputPath: string;
  script: BattleScript;
  reusedFromGenerationId?: string;
  createdAt: string;
}

export interface FeedbackRecord {
  schemaVersion: 1;
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
    }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function hashScriptJson(rawJson: string): string {
  const parsed = JSON.parse(rawJson) as unknown;
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
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
      schemaVersion: 1,
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
      createdAt: new Date().toISOString(),
    };
    appendJsonLine(this.feedbackPath, record);
    return record;
  }

  successfulGeneration(stageId: string, operatorBoxHash: string): GenerationRecord | undefined {
    const generations = this.loadGenerations().records;
    const feedback = this.loadFeedback().records;
    const successfulIds = new Set(
      feedback
        .filter(record => record.usableForLearning && record.ratio === 1 && record.operatorBoxHash === operatorBoxHash)
        .map(record => record.generationId)
        .filter((id): id is string => Boolean(id))
    );
    return generations.filter(record => record.stageId === stageId && record.operatorBoxHash === operatorBoxHash && successfulIds.has(record.generationId)).at(-1);
  }

  excludedHashes(stageId: string, operatorBoxHash: string): Set<string> {
    return new Set(
      this.loadFeedback().records
        .filter(record => record.stageId === stageId && record.operatorBoxHash === operatorBoxHash && record.usableForLearning && record.ratio < 1)
        .map(record => record.scriptHash)
    );
  }

  feedbackAdjustment(
    stageId: string,
    operatorBoxHash: string,
    breakdown: Record<string, number>
  ): number {
    const generations = new Map(this.loadGenerations().records.map(record => [record.generationId, record]));
    const records = this.loadFeedback().records.filter(record =>
      record.usableForLearning && record.stageId === stageId && record.operatorBoxHash === operatorBoxHash && record.generationId
    );
    if (records.length === 0) return 0;
    let weightedResidual = 0;
    let totalWeight = 0;
    for (const feedback of records) {
      const generation = generations.get(feedback.generationId!);
      if (!generation) continue;
      const keys = ["combat", "position", "timing", "corpus", "tasks", "automation"];
      const distance = keys.reduce((sum, key) => sum + Math.abs((breakdown[key] || 0) - (generation.scoreBreakdown[key] || 0)) / 100, 0) / keys.length;
      const weight = Math.exp(-3 * distance);
      weightedResidual += (feedback.ratio * 100 - generation.candidateScore) * weight;
      totalWeight += weight;
    }
    if (totalWeight === 0) return 0;
    const alpha = Math.min(0.35, records.length / (records.length + 10));
    return weightedResidual / totalWeight * alpha;
  }

  summary(stageId?: string): FeedbackSummary {
    const records = this.loadFeedback().records.filter(record => !stageId || record.stageId === stageId);
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
