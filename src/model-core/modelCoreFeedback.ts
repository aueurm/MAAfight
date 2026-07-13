import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { normalizeDelayToBucket, type BattleAction, type BattleScript, type DelayBucket } from "./battleDsl";

export const MODEL_CORE_ENGINE_VERSION = "cpu-core-v0";
export const DEFAULT_MODEL_CORE_FEEDBACK_PATH = path.join("data", "model-core", "feedback.jsonl");
export const DEFAULT_REJECTED_SAMPLES_PATH = path.join("data", "model-core", "rejected_samples.jsonl");

export interface ExecutionFeedback {
  stageHash: string;
  rosterHash: string;
  engineVersion: string;
  scriptHash: string;
  result: "success" | "failure";
  timestamp: string;
  script: BattleScript;
  rehearsal?: {
    enteredBattle?: boolean;
    completed?: boolean;
    threeStar?: boolean;
  };
  notes?: string;
}

export interface ScriptFingerprint {
  scriptHash: string;
  firstThreeDeploys: string[];
  deployCells: string[];
  directions: string[];
  operatorIds: string[];
  delayBuckets: number[];
  skillStrategy: string;
}

export interface FeedbackContextInput {
  stageHash: string;
  rosterHash: string;
  engineVersion: string;
  feedback?: ExecutionFeedback[];
}

export interface RejectedSample {
  stageId: string;
  stageHash: string;
  rosterHash: string;
  engineVersion: string;
  scriptHash: string;
  fingerprint: ScriptFingerprint;
  actions: BattleAction[];
  rehearsal?: ExecutionFeedback["rehearsal"];
  notes?: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)])
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function hashStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedAction(action: BattleAction): BattleAction {
  const output: BattleAction = { type: action.type, delay: normalizeDelayToBucket(action.delay ?? 0) };
  if (action.operatorId) output.operatorId = action.operatorId;
  if (Number.isInteger(action.x)) output.x = action.x;
  if (Number.isInteger(action.y)) output.y = action.y;
  if (action.direction) output.direction = action.direction;
  if (Number.isInteger(action.skillIndex)) output.skillIndex = action.skillIndex;
  return output;
}

export function hashBattleScript(script: BattleScript): string {
  return hashStable({ stageId: script.stageId, actions: script.actions.map(normalizedAction) });
}

function deployKey(action: BattleAction): string {
  return `${action.operatorId || ""}@${action.x},${action.y}:${action.direction || ""}`;
}

function skillStrategy(script: BattleScript): string {
  const daemon = script.actions.map((action, index) => action.type === "SkillDaemon" ? index : -1).filter(index => index >= 0);
  const skillUse = script.actions.map((action, index) => action.type === "SkillUse" ? index : -1).filter(index => index >= 0);
  return `daemon=${daemon.join(",")};skill=${skillUse.join(",")}`;
}

export function buildScriptFingerprint(script: BattleScript): ScriptFingerprint {
  const deploys = script.actions.filter(action => action.type === "Deploy");
  return {
    scriptHash: hashBattleScript(script),
    firstThreeDeploys: deploys.slice(0, 3).map(deployKey),
    deployCells: deploys
      .filter(action => Number.isInteger(action.x) && Number.isInteger(action.y))
      .map(action => `${action.x},${action.y}`),
    directions: deploys.map(action => String(action.direction || "")),
    operatorIds: deploys.map(action => String(action.operatorId || "")),
    delayBuckets: script.actions.map(action => normalizeDelayToBucket(action.delay ?? 0) as DelayBucket),
    skillStrategy: skillStrategy(script),
  };
}

function setSimilarity(left: Array<string | number>, right: Array<string | number>): number {
  const leftSet = new Set(left.map(String));
  const rightSet = new Set(right.map(String));
  if (!leftSet.size && !rightSet.size) return 0;
  const intersection = [...leftSet].filter(value => rightSet.has(value)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union ? intersection / union : 0;
}

function sequenceSimilarity(left: unknown[], right: unknown[]): number {
  const length = Math.max(left.length, right.length);
  if (!length) return 0;
  let same = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] === right[index]) same++;
  }
  return same / length;
}

export function computeFeedbackPenalty(candidate: BattleScript, failedFingerprints: ScriptFingerprint[]): number {
  const current = buildScriptFingerprint(candidate);
  let penalty = 0;
  for (const failed of failedFingerprints) {
    if (current.scriptHash === failed.scriptHash) return Number.POSITIVE_INFINITY;
    const firstThree = sequenceSimilarity(current.firstThreeDeploys, failed.firstThreeDeploys);
    const cells = setSimilarity(current.deployCells, failed.deployCells);
    const directions = sequenceSimilarity(current.directions, failed.directions);
    const delays = setSimilarity(current.delayBuckets, failed.delayBuckets);
    const skill = current.skillStrategy && current.skillStrategy === failed.skillStrategy ? 1 : 0;
    penalty = Math.max(penalty, firstThree * 50 + cells * 20 + directions * 10 + delays * 10 + skill * 5);
  }
  return penalty;
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: T[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Keep the feedback loop tolerant of hand-edited JSONL.
    }
  }
  return rows;
}

export function appendExecutionFeedback(
  feedback: ExecutionFeedback,
  feedbackPath = DEFAULT_MODEL_CORE_FEEDBACK_PATH
): void {
  appendJsonLine(feedbackPath, feedback);
}

export function loadExecutionFeedback(feedbackPath = DEFAULT_MODEL_CORE_FEEDBACK_PATH): ExecutionFeedback[] {
  return readJsonLines<ExecutionFeedback>(feedbackPath);
}

export function loadFeedbackForContext(
  input: FeedbackContextInput,
  feedbackPath = DEFAULT_MODEL_CORE_FEEDBACK_PATH
): ExecutionFeedback[] {
  const records = input.feedback || loadExecutionFeedback(feedbackPath);
  return records.filter(record =>
    record.stageHash === input.stageHash
    && record.rosterHash === input.rosterHash
    && record.engineVersion === input.engineVersion
  );
}

export function findReusableSuccessScript(input: FeedbackContextInput): BattleScript | null {
  return loadFeedbackForContext(input)
    .filter(record => record.result === "success")
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .at(-1)?.script || null;
}

export function failedFingerprintsForContext(input: FeedbackContextInput): ScriptFingerprint[] {
  return loadFeedbackForContext(input)
    .filter(record => record.result === "failure")
    .map(record => buildScriptFingerprint(record.script));
}

export function rejectedSamples(records: ExecutionFeedback[]): RejectedSample[] {
  return records
    .filter(record => record.result === "failure")
    .map(record => ({
      stageId: record.script.stageId,
      stageHash: record.stageHash,
      rosterHash: record.rosterHash,
      engineVersion: record.engineVersion,
      scriptHash: record.scriptHash,
      fingerprint: buildScriptFingerprint(record.script),
      actions: record.script.actions,
      rehearsal: record.rehearsal,
      notes: record.notes,
    }));
}

export function exportRejectedSamples(
  records: ExecutionFeedback[],
  outputPath = DEFAULT_REJECTED_SAMPLES_PATH
): number {
  const rows = rejectedSamples(records);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  return rows.length;
}
