import * as fs from "fs";
import * as path from "path";
import { validateMAAProtocol } from "../copilot/MAAProtocolValidator";
import { validateScript } from "../copilot/ScriptValidator";
import { hashScriptJson } from "../feedback/FeedbackStore";
import type { BattleScript } from "../types";
import { parseCallbackLogFile } from "./callback";
import { RunResultStore } from "./RunResultStore";
import { observeMaaScreen } from "./screenObserver";
import type { RunMode, RunResult } from "./types";

export interface DryRunOptions {
  filePath: string;
  mode?: string;
  allowSanity?: boolean;
  stateDir?: string;
  now?: () => Date;
}

export interface DryRunResult {
  result: RunResult;
  runResultsPath: string;
}

export interface CallbackRunOptions extends DryRunOptions {
  callbackLogPath: string;
}

export interface ScreenObservedRunOptions extends DryRunOptions {
  maaPath?: string;
  adbPath?: string;
  address?: string;
  connectConfig?: string;
  debugDir?: string;
}

export interface ScreenObservedRunResult extends DryRunResult {
  debugScreenshotPath?: string;
  debugSamplesPath: string;
}

interface ValidatedScript {
  script: BattleScript;
  scriptHash: string;
}

export function parseRunMode(value = "manual-practice"): RunMode {
  if (value === "manual-practice" || value === "manual-normal") return value;
  throw new Error(`Unsupported run mode: ${value}`);
}

function assertSanityAllowed(mode: RunMode, allowSanity?: boolean): void {
  if (mode === "manual-normal" && !allowSanity) {
    throw new Error("manual-normal may consume sanity and requires --allow-sanity.");
  }
}

function loadValidatedScript(filePath: string): ValidatedScript {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let script: BattleScript;
  try {
    script = JSON.parse(raw) as BattleScript;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid script JSON: ${message}`);
  }
  if (!script || typeof script !== "object" || Array.isArray(script)) {
    throw new Error("Invalid script JSON: expected a copilot script object.");
  }

  const validation = validateScript(script);
  const protocol = validateMAAProtocol(script);
  if (!validation.valid || !protocol.valid) {
    const errors = [
      ...validation.errors.map(error => error.message),
      ...protocol.errors.map(error => error.message),
    ];
    throw new Error(`Invalid copilot script: ${errors.join("; ")}`);
  }
  return { script, scriptHash: hashScriptJson(raw) };
}

export function recordDryRun(options: DryRunOptions): DryRunResult {
  const mode = parseRunMode(options.mode);
  assertSanityAllowed(mode, options.allowSanity);
  const loaded = loadValidatedScript(options.filePath);

  const store = new RunResultStore(options.stateDir);
  const result: RunResult = {
    schemaVersion: 1,
    runId: store.createRunId(),
    scriptHash: loaded.scriptHash,
    stageId: loaded.script.stage_name,
    mode,
    outcome: "unknown",
    source: "dry_run",
    errorType: "MAA_EXECUTION_NOT_IMPLEMENTED",
    message: "MAA execution is not implemented yet; this dry-run skeleton only validates and records the script.",
    createdAt: (options.now || (() => new Date()))().toISOString(),
  };
  store.append(result);
  return { result, runResultsPath: store.runResultsPath };
}

export function recordCallbackRun(options: CallbackRunOptions): DryRunResult {
  const mode = parseRunMode(options.mode);
  assertSanityAllowed(mode, options.allowSanity);
  const loaded = loadValidatedScript(options.filePath);
  const callback = parseCallbackLogFile(options.callbackLogPath);
  const store = new RunResultStore(options.stateDir);
  const result: RunResult = {
    schemaVersion: 1,
    runId: store.createRunId(),
    scriptHash: loaded.scriptHash,
    stageId: loaded.script.stage_name,
    mode,
    outcome: callback.outcome,
    stars: callback.stars,
    source: "maa_callback",
    errorType: callback.errorType,
    message: callback.message,
    createdAt: (options.now || (() => new Date()))().toISOString(),
  };
  store.append(result);
  return { result, runResultsPath: store.runResultsPath };
}

export function recordScreenObservedRun(options: ScreenObservedRunOptions): ScreenObservedRunResult {
  const mode = parseRunMode(options.mode);
  assertSanityAllowed(mode, options.allowSanity);
  const loaded = loadValidatedScript(options.filePath);
  const store = new RunResultStore(options.stateDir);
  const runId = store.createRunId();
  const stateDir = options.stateDir || process.cwd();
  const debugDir = options.debugDir || path.join(stateDir, ".maafight", "screen-observer", runId);
  const observed = observeMaaScreen({
    maaPath: options.maaPath,
    adbPath: options.adbPath,
    address: options.address,
    connectConfig: options.connectConfig,
    debugDir,
    userDir: path.join(stateDir, ".maafight", "maa-core"),
  });
  const result: RunResult = {
    schemaVersion: 1,
    runId,
    scriptHash: loaded.scriptHash,
    stageId: loaded.script.stage_name,
    mode,
    outcome: observed.outcome,
    stars: observed.stars,
    source: "screen_observer",
    errorType: observed.errorType,
    message: observed.message,
    maaVersion: observed.maaVersion,
    createdAt: (options.now || (() => new Date()))().toISOString(),
  };
  store.append(result);
  return {
    result,
    runResultsPath: store.runResultsPath,
    debugScreenshotPath: observed.debugScreenshotPath,
    debugSamplesPath: observed.debugSamplesPath,
  };
}
