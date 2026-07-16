import type { ValidationResult } from "../types";

export const DELAY_BUCKETS = [0, 250, 500, 750, 1000, 1500, 3000, 5000] as const;
export const DIRECTIONS = ["Up", "Down", "Left", "Right", "None"] as const;
const ACTION_TYPES = ["SpeedUp", "Deploy", "SkillDaemon", "SkillUse", "Retreat", "ResetStopwatch", "End"] as const;

export type DelayBucket = typeof DELAY_BUCKETS[number];
export type Direction = typeof DIRECTIONS[number];
export type BattleActionType = typeof ACTION_TYPES[number];
export interface BattleAction {
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
}

export interface BattleDslScript {
  stageId: string;
  actions: BattleAction[];
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

export function validateBattleDsl(script: BattleDslScript): ValidationResult {
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
