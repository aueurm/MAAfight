import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getMaafightDir } from "../player/PlayerConfig";
import type { RunOutcome, RunResult } from "./types";

export interface RunResultSummary {
  stageId?: string;
  total: number;
  clear: number;
  partial_clear: number;
  failed: number;
  execution_error: number;
  unknown: number;
  dry_run: number;
  realResultCount: number;
  passRate: number | null;
}

const REAL_RESULT_OUTCOMES = new Set<RunOutcome>(["clear", "partial_clear", "failed", "execution_error"]);

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

export class RunResultStore {
  readonly runResultsPath: string;

  constructor(cwd = process.cwd()) {
    this.runResultsPath = path.join(getMaafightDir(cwd), "run-results.jsonl");
  }

  createRunId(): string {
    return randomUUID();
  }

  append(record: RunResult): void {
    appendJsonLine(this.runResultsPath, record);
  }

  load(): { records: RunResult[]; warnings: string[] } {
    return readJsonLines<RunResult>(this.runResultsPath);
  }

  summary(stageId?: string): RunResultSummary {
    const records = this.load().records.filter(record => !stageId || record.stageId === stageId);
    const realResults = records.filter(record =>
      record.source !== "dry_run" && REAL_RESULT_OUTCOMES.has(record.outcome)
    );
    const count = (outcome: RunOutcome): number => records.filter(record => record.outcome === outcome).length;
    return {
      stageId,
      total: records.length,
      clear: count("clear"),
      partial_clear: count("partial_clear"),
      failed: count("failed"),
      execution_error: count("execution_error"),
      unknown: records.filter(record => record.source !== "dry_run" && record.outcome === "unknown").length,
      dry_run: records.filter(record => record.source === "dry_run").length,
      realResultCount: realResults.length,
      passRate: realResults.length
        ? realResults.filter(record => record.outcome === "clear").length / realResults.length
        : null,
    };
  }
}
