export type RunMode = "manual-practice" | "manual-normal";

export type RunOutcome =
  | "clear"
  | "partial_clear"
  | "failed"
  | "execution_error"
  | "unknown";

export type RunResultSource = "maa_callback" | "screen_observer" | "manual" | "dry_run";

export interface RunResult {
  schemaVersion: 1;
  runId: string;
  scriptHash: string;
  stageId: string;
  mode: RunMode;
  outcome: RunOutcome;
  stars?: number;
  killed?: number;
  total?: number;
  source: RunResultSource;
  errorType?: string;
  message?: string;
  maaVersion?: string;
  emulator?: string;
  createdAt: string;
}
