import type { BattleScript, BattleScriptAction, BattleScriptOper, ProtocolIssue, ProtocolValidationResult } from "../types";

const ACTION_TYPES = new Set([
  "Deploy", "Skill", "Retreat", "SpeedUp", "BulletTime", "SkillUsage",
  "Output", "SkillDaemon", "MoveCamera", "ResetStopwatch",
]);
const DISPLAY_NAME_CHARS = /[:：/\[\]]/;

function hasRequirements(operators: BattleScriptOper[] = []): boolean {
  return operators.some(operator => operator.requirements !== undefined);
}

function hasDelay(action: BattleScriptAction | undefined): boolean {
  return Boolean(action && (
    (action.post_delay !== undefined && action.post_delay > 0) ||
    (action.pre_delay !== undefined && action.pre_delay > 0) ||
    (action.time !== undefined && action.time > 0)
  ));
}

function warning(target: ProtocolIssue[], code: string, message: string, actionIndex?: number, suggestion?: string): void {
  target.push({ code, message, severity: "warning", actionIndex, suggestion });
}

function error(target: ProtocolIssue[], code: string, message: string, actionIndex?: number, suggestion?: string): void {
  target.push({ code, message, severity: "error", actionIndex, suggestion });
}

function checkName(target: ProtocolIssue[], name: string | undefined, field: string, actionIndex?: number): void {
  if (!name || !DISPLAY_NAME_CHARS.test(name)) return;
  warning(
    target,
    "DISPLAY_TEXT_IN_NAME",
    `${field} contains display text characters and may not match an operator or group name: ${name}`,
    actionIndex,
    "Use a plain operator or group name."
  );
}

export function validateMAAProtocol(script: BattleScript): ProtocolValidationResult {
  const errors: ProtocolIssue[] = [];
  const warnings: ProtocolIssue[] = [];
  const groupNames = new Set((script.groups || []).map(group => group.name));
  const operatorNames = new Set<string>();
  let hasResetStopwatch = false;

  for (const operator of script.opers || []) {
    operatorNames.add(operator.name);
    checkName(warnings, operator.name, "opers[].name");
  }
  for (const group of script.groups || []) {
    checkName(warnings, group.name, "groups[].name");
    for (const operator of group.opers || []) {
      operatorNames.add(operator.name);
      checkName(warnings, operator.name, "groups[].opers[].name");
    }
  }
  if (hasRequirements(script.opers) || (script.groups || []).some(group => hasRequirements(group.opers))) {
    warning(warnings, "REQUIREMENTS_RESERVED", "Operator requirements are reserved metadata and are not execution constraints.");
  }

  for (let index = 0; index < (script.actions || []).length; index++) {
    const action = script.actions[index];
    if (!ACTION_TYPES.has(action.type)) {
      error(errors, "MAA_INVALID_ACTION_TYPE", `Action ${index} has unsupported MAA action type: ${action.type}`, index);
    }
    if (action.type === "ResetStopwatch") hasResetStopwatch = true;
    checkName(warnings, action.name, "actions[].name", index);
    if (action.time_elapsed !== undefined && !hasResetStopwatch) {
      warning(warnings, "TIME_ELAPSED_WITHOUT_RESET", "time_elapsed requires an earlier ResetStopwatch.", index);
    }
    if (action.type === "MoveCamera" && !hasDelay(action) && !hasDelay(script.actions[index + 1])) {
      warning(warnings, "MOVE_CAMERA_WITHOUT_DELAY", "MoveCamera is not followed by a delay.", index);
    }
    if (action.type === "Deploy" && action.name && !operatorNames.has(action.name) && !groupNames.has(action.name)) {
      warning(warnings, "DEPLOY_NAME_NOT_DECLARED", `Deploy action references an undeclared name: ${action.name}`, index);
    }
  }

  return { valid: errors.length === 0, errors, warnings, score: Math.max(0, 100 - errors.length * 25 - warnings.length * 5) };
}
