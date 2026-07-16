import { randomUUID } from "crypto";
import * as path from "path";
import { getMaafightDir } from "../player/PlayerConfig";
import { appendJsonLine, readJsonLines } from "../shared/jsonl";
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
