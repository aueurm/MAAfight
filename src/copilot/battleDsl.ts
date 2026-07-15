import type { BattleScriptAction, ValidationResult } from "../types";

export const DELAY_BUCKETS = [0, 250, 500, 750, 1000, 1500, 3000, 5000] as const;
export const DIRECTIONS = ["Up", "Down", "Left", "Right", "None"] as const;
const ACTION_TYPES = ["SpeedUp", "Deploy", "SkillDaemon", "SkillUse", "Retreat", "ResetStopwatch", "End"] as const;

export type DelayBucket = typeof DELAY_BUCKETS[number];
export type Direction = typeof DIRECTIONS[number];
export type BattleActionType = typeof ACTION_TYPES[number];

export type BattleAction = {
  type: BattleActionType;
  delay?: DelayBucket;
  operatorId?: string;
  x?: number;
  y?: number;
  direction?: Direction | string;
  skillIndex?: number;
  kills?: number;
  costs?: number;
  costChanges?: number;
  cooling?: number;
  timeElapsed?: number;
  raw?: unknown;
};

export type BattleScript = {
  stageId: string;
  actions: BattleAction[];
  meta?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? JSON.parse(JSON.stringify(value)) : {};
}

function finiteInt(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function maybeNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function normalizeDelayToBucket(delay: unknown = 0): DelayBucket {
  const value = Math.max(0, maybeNumber(delay) ?? 0);
  return (DELAY_BUCKETS.find(bucket => value <= bucket) ?? 5000) as DelayBucket;
}

function normalizeDirection(value: unknown): Direction | string | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return undefined;
  return DIRECTIONS.find(direction => direction.toLowerCase() === raw.toLowerCase()) ?? raw;
}

function normalizeActionType(value: unknown): BattleActionType | null {
  const key = String(value || "Deploy").replace(/[_\s-]/g, "").toLowerCase();
  if (key === "speedup") return "SpeedUp";
  if (key === "deploy") return "Deploy";
  if (key === "skilldaemon") return "SkillDaemon";
  if (key === "skill" || key === "skilluse") return "SkillUse";
  if (key === "retreat") return "Retreat";
  if (key === "resetstopwatch") return "ResetStopwatch";
  if (key === "end") return "End";
  return null;
}

function conditionFromAction(action: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (action[key] !== undefined) return action[key];
  }
  return undefined;
}

function copyConditions(action: BattleAction, raw: Record<string, unknown>): void {
  const output = action as unknown as Record<string, unknown>;
  const conditions: Array<[keyof BattleAction, string[]]> = [
    ["kills", ["kills"]],
    ["costs", ["costs"]],
    ["costChanges", ["costChanges", "cost_changes"]],
    ["cooling", ["cooling"]],
    ["timeElapsed", ["timeElapsed", "time_elapsed"]],
  ];
  for (const [key, aliases] of conditions) {
    const value = conditionFromAction(raw, aliases);
    if (value !== undefined) output[key] = value;
  }
}

function operatorId(action: Record<string, unknown>): string | undefined {
  for (const key of ["operatorId", "name", "operator", "op"]) {
    const value = action[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function delayFromAction(action: Record<string, unknown>): DelayBucket {
  for (const key of ["delay", "pre_delay", "cost_ms", "time", "post_delay"]) {
    if (action[key] !== undefined) return normalizeDelayToBucket(action[key]);
  }
  return 0;
}

function convertAction(raw: unknown): BattleAction | null {
  if (!isRecord(raw)) return null;
  const type = normalizeActionType(raw.type);
  if (!type) return null;
  if (type === "SpeedUp" || type === "SkillDaemon" || type === "ResetStopwatch" || type === "End") {
    return { type, delay: delayFromAction(raw), raw };
  }

  const action: BattleAction = {
    type,
    delay: delayFromAction(raw),
    operatorId: operatorId(raw),
    raw,
  };
  if (type === "Deploy") {
    const location = Array.isArray(raw.location) ? raw.location : [];
    action.x = finiteInt(raw.x ?? location[0]);
    action.y = finiteInt(raw.y ?? location[1]);
    action.direction = normalizeDirection(raw.direction);
  }
  const skillIndex = finiteInt(raw.skillIndex ?? raw.skill);
  if (skillIndex !== undefined) action.skillIndex = skillIndex;
  copyConditions(action, raw);
  return action;
}

export function copilotJsonToBattleDsl(input: unknown): BattleScript {
  const root = isRecord(input) ? input : {};
  const actions = (Array.isArray(root.actions) ? root.actions : [])
    .map(convertAction)
    .filter((action): action is BattleAction => Boolean(action));
  if (!actions.some(action => action.type === "End")) actions.push({ type: "End", delay: 0 });

  return {
    stageId: String(root.stageId || root.stage_id || root.stage_name || ""),
    actions,
    meta: { rawInput: input },
  };
}

function withDelay(output: Record<string, unknown>, delay: DelayBucket | undefined): void {
  if (delay && delay > 0) output.pre_delay = delay;
  else delete output.pre_delay;
}

function withConditions(output: Record<string, unknown>, action: BattleAction): void {
  for (const key of ["kills", "costs", "costChanges", "cost_changes", "cooling", "timeElapsed", "time_elapsed"]) delete output[key];
  if (action.kills !== undefined) output.kills = action.kills;
  if (action.costs !== undefined) output.costs = action.costs;
  if (action.costChanges !== undefined) output.cost_changes = action.costChanges;
  if (action.cooling !== undefined) output.cooling = action.cooling;
  if (action.timeElapsed !== undefined) output.time_elapsed = action.timeElapsed;
}

function toCopilotAction(action: BattleAction): BattleScriptAction | null {
  if (action.type === "End") return null;
  const output = cloneRecord(action.raw);
  if (action.type === "SpeedUp" || action.type === "SkillDaemon" || action.type === "ResetStopwatch") {
    output.type = action.type;
  } else if (action.type === "SkillUse" || action.type === "Retreat") {
    output.type = action.type === "SkillUse" ? "Skill" : "Retreat";
    output.name = action.operatorId;
    if (action.skillIndex !== undefined) output.skill = action.skillIndex;
  } else {
    output.type = "Deploy";
    output.name = action.operatorId;
    output.location = [action.x, action.y];
    output.direction = action.direction;
  }
  withDelay(output, action.delay);
  withConditions(output, action);
  delete output.delay;
  return output as unknown as BattleScriptAction;
}

export function battleDslToCopilotJson(script: BattleScript): unknown {
  const output = cloneRecord(script.meta?.rawInput);
  output.stage_name = script.stageId;
  output.minimum_required = output.minimum_required || "v6.0.0";
  output.doc = output.doc || { title: `${script.stageId} BattleDSL`, details: "" };
  output.opers = Array.isArray(output.opers) ? output.opers : [];
  output.groups = Array.isArray(output.groups) ? output.groups : [];
  output.version = output.version || 3;
  output.actions = script.actions.map(toCopilotAction).filter(Boolean);
  return output;
}

function issue(code: string, message: string, actionIndex?: number): ValidationResult["errors"][number] {
  return { code, message, ...(actionIndex !== undefined ? { location: { actionIndex } } : {}) };
}

function hasConditions(action: BattleAction): boolean {
  return [action.kills, action.costs, action.costChanges, action.cooling, action.timeElapsed].some(value => value !== undefined);
}

function validInteger(value: unknown, minimum?: number): boolean {
  return Number.isFinite(Number(value)) && Number.isInteger(Number(value)) && (minimum === undefined || Number(value) >= minimum);
}

export function validateBattleDsl(script: BattleScript): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  const warnings: ValidationResult["warnings"] = [];
  if (!script.stageId) errors.push(issue("MISSING_STAGE_ID", "BattleDSL missing stageId"));
  if (!Array.isArray(script.actions) || script.actions.length === 0) errors.push(issue("EMPTY_ACTIONS", "BattleDSL actions must not be empty"));

  let endCount = 0;
  for (const [index, action] of (script.actions || []).entries()) {
    if (!ACTION_TYPES.includes(action.type)) errors.push(issue("INVALID_ACTION_TYPE", `Invalid action type: ${action.type}`, index));
    if (!DELAY_BUCKETS.includes((action.delay ?? 0) as DelayBucket)) errors.push(issue("INVALID_DELAY_BUCKET", `Invalid delay bucket: ${action.delay}`, index));
    if (action.type === "End") {
      endCount++;
      if (index !== script.actions.length - 1) warnings.push({ code: "END_NOT_LAST", message: "End action should be the last action" });
    }
    if (action.type === "Deploy") {
      if (!action.operatorId) errors.push(issue("MISSING_OPERATOR_ID", "Deploy action missing operatorId", index));
      if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) errors.push(issue("INVALID_COORDINATE", "Deploy action coordinates must be integers", index));
      if (!DIRECTIONS.includes(action.direction as Direction)) errors.push(issue("INVALID_DIRECTION", `Deploy action invalid direction: ${action.direction}`, index));
    }
    if ((action.type === "SkillUse" || action.type === "Retreat") && !action.operatorId) {
      errors.push(issue("MISSING_OPERATOR_ID", `${action.type} action missing operatorId`, index));
    }
    if (hasConditions(action) && action.type !== "SkillUse" && action.type !== "Retreat") {
      errors.push(issue("INVALID_ACTION_CONDITIONS", `${action.type} cannot use native action conditions`, index));
    }
    for (const [key, value, minimum] of [
      ["kills", action.kills, 0],
      ["costs", action.costs, 0],
      ["costChanges", action.costChanges, undefined],
      ["cooling", action.cooling, 0],
      ["timeElapsed", action.timeElapsed, 1],
    ] as const) {
      if (value !== undefined && !validInteger(value, minimum)) {
        const rule = key === "costChanges" ? "an integer" : key === "timeElapsed" ? "a positive integer" : "a non-negative integer";
        errors.push(issue("INVALID_ACTION_CONDITION", `${key} must be ${rule}`, index));
      }
    }
  }
  if (endCount > 1) errors.push(issue("MULTIPLE_END", "BattleDSL allows at most one End action"));
  return { valid: errors.length === 0, errors, warnings, score: Math.max(0, 100 - errors.length * 20 - warnings.length * 5) };
}
