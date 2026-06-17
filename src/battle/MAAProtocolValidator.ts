import type { BattleScript, BattleScriptAction, BattleScriptOper, ProtocolIssue, ProtocolValidationResult } from "../types";

const MAA_STANDARD_ACTION_TYPES = new Set([
  "Deploy",
  "Skill",
  "Retreat",
  "SpeedUp",
  "BulletTime",
  "SkillUsage",
  "Output",
  "SkillDaemon",
  "MoveCamera",
  "ResetStopwatch",
]);

const INTERNAL_COMPATIBLE_ACTION_TYPES = new Set(["Wait", "SkillUse"]);
const DISPLAY_NAME_CHARS = /[:：/\[\]]/;

function hasRequirements(opers: BattleScriptOper[] = []): boolean {
  return opers.some(op => op.requirements !== undefined);
}

function hasDelay(action: BattleScriptAction | undefined): boolean {
  if (!action) return false;
  return Boolean(
    (action.post_delay !== undefined && action.post_delay > 0) ||
    (action.pre_delay !== undefined && action.pre_delay > 0) ||
    (action.time !== undefined && action.time > 0)
  );
}

function pushWarning(warnings: ProtocolIssue[], code: string, message: string, actionIndex?: number, suggestion?: string): void {
  warnings.push({ code, message, severity: "warning", actionIndex, suggestion });
}

function pushError(errors: ProtocolIssue[], code: string, message: string, actionIndex?: number, suggestion?: string): void {
  errors.push({ code, message, severity: "error", actionIndex, suggestion });
}

function warnDisplayName(
  warnings: ProtocolIssue[],
  name: string | undefined,
  field: string,
  actionIndex?: number
): void {
  if (!name || !DISPLAY_NAME_CHARS.test(name)) return;
  pushWarning(
    warnings,
    "DISPLAY_TEXT_IN_NAME",
    `${field} contains display text characters and may not match an operator or group name: ${name}`,
    actionIndex,
    "Use a plain operator name or a plain group name; keep role labels and candidate lists outside protocol name fields."
  );
}

export function validateMAAProtocol(script: BattleScript): ProtocolValidationResult {
  const errors: ProtocolIssue[] = [];
  const warnings: ProtocolIssue[] = [];
  let hasResetStopwatch = false;
  const groupNames = new Set((script.groups || []).map(group => group.name));
  const operatorNames = new Set<string>();

  for (const op of script.opers || []) {
    operatorNames.add(op.name);
    warnDisplayName(warnings, op.name, "opers[].name");
  }
  for (const group of script.groups || []) {
    warnDisplayName(warnings, group.name, "groups[].name");
    for (const op of group.opers || []) {
      operatorNames.add(op.name);
      warnDisplayName(warnings, op.name, "groups[].opers[].name");
    }
  }

  if (hasRequirements(script.opers) || (script.groups || []).some(g => hasRequirements(g.opers))) {
    pushWarning(
      warnings,
      "REQUIREMENTS_RESERVED",
      "Operator requirements are reserved metadata in MAA protocol and should not be treated as execution constraints.",
      undefined,
      "Keep requirements for human review, but do not rely on MAA enforcing them."
    );
  }

  for (let i = 0; i < (script.actions || []).length; i++) {
    const action = script.actions[i];

    if (action.type === "ResetStopwatch") {
      hasResetStopwatch = true;
    }

    warnDisplayName(warnings, action.name, "actions[].name", i);

    if (action.type === "Wait") {
      pushWarning(
        warnings,
        "NON_STANDARD_WAIT",
        "Wait is an internal action and is not listed as a standard MAA copilot action type.",
        i,
        "Prefer post_delay, Output with delay, or a protocol condition such as costs/time_elapsed."
      );
    } else if (action.type === "SkillUse") {
      pushWarning(
        warnings,
        "SKILLUSE_ALIAS",
        "SkillUse is an internal alias; MAA protocol uses Skill.",
        i,
        "Export SkillUse as Skill when strict MAA compatibility is required."
      );
    } else if (!MAA_STANDARD_ACTION_TYPES.has(action.type) && !INTERNAL_COMPATIBLE_ACTION_TYPES.has(action.type)) {
      pushError(
        errors,
        "MAA_INVALID_ACTION_TYPE",
        `Action ${i} has unsupported MAA action type: ${action.type}`,
        i
      );
    }

    if (action.time_elapsed !== undefined && !hasResetStopwatch) {
      pushWarning(
        warnings,
        "TIME_ELAPSED_WITHOUT_RESET",
        "time_elapsed is measured from the latest ResetStopwatch and may block without one.",
        i,
        "Insert ResetStopwatch before using time_elapsed."
      );
    }

    if (action.type === "MoveCamera" && !hasDelay(action) && !hasDelay(script.actions[i + 1])) {
      pushWarning(
        warnings,
        "MOVE_CAMERA_WITHOUT_DELAY",
        "MoveCamera is not followed by a delay, so later actions may run before camera animation settles.",
        i,
        "Add post_delay to MoveCamera or pre_delay to the following action."
      );
    }

    if (action.type === "Deploy" && action.name && !operatorNames.has(action.name) && !groupNames.has(action.name)) {
      pushWarning(
        warnings,
        "DEPLOY_NAME_NOT_DECLARED",
        `Deploy action references a name that is not present in opers or groups: ${action.name}`,
        i,
        "Add the operator to opers, add a matching group, or change the Deploy name."
      );
    }
  }

  const score = Math.max(0, 100 - errors.length * 25 - warnings.length * 5);
  return { valid: errors.length === 0, errors, warnings, score };
}
