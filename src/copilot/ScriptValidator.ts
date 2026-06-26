import type { BattleScript, MapData, ValidationResult } from "../types";
import { hasCatalogOperator } from "../shared/operatorCatalog";

const ACTION_TYPES = new Set([
  "Deploy", "Skill", "Retreat", "SpeedUp", "BulletTime", "SkillUsage",
  "Output", "SkillDaemon", "MoveCamera", "ResetStopwatch",
]);

export function validateScript(script: BattleScript, mapData?: MapData): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  const warnings: ValidationResult["warnings"] = [];
  if (!script.stage_name) errors.push({ code: "MISSING_STAGE_NAME", message: "Missing stage_name" });
  if (!Array.isArray(script.actions) || script.actions.length === 0) {
    errors.push({ code: "INVALID_ACTIONS", message: "Script must have at least one action" });
  }
  const actions = Array.isArray(script.actions) ? script.actions : [];

  const deployedNames = new Set<string>();
  const groupNames = new Set((script.groups || []).map(group => group.name));
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    if (!ACTION_TYPES.has(action.type)) {
      errors.push({ code: "INVALID_ACTION_TYPE", message: `Action ${index} invalid type: ${action.type}`, location: { actionIndex: index } });
    }
    if (action.type !== "Deploy") continue;
    if (!action.name) {
      errors.push({ code: "MISSING_OPERATOR_NAME", message: `Deploy action ${index} missing name`, location: { actionIndex: index } });
    } else {
      deployedNames.add(action.name);
    }
    if (!action.location || action.location.length !== 2) {
      errors.push({ code: "INVALID_LOCATION", message: `Deploy action ${index} invalid location`, location: { actionIndex: index } });
      continue;
    }
    if (mapData) {
      const [row, col] = action.location;
      if (row < 0 || row >= mapData.tiles.length || col < 0 || col >= (mapData.tiles[0]?.length || 0)) {
        errors.push({ code: "LOCATION_OUT_OF_BOUNDS", message: `Deploy action ${index} location is outside map bounds`, location: { actionIndex: index } });
      } else if (!mapData.deploymentPoints.some(point => point.row === row && point.col === col)) {
        errors.push({ code: "LOCATION_NOT_DEPLOYABLE", message: `Deploy action ${index} location is not deployable`, location: { actionIndex: index } });
      }
    }
    if (!action.direction) warnings.push({ code: "MISSING_DIRECTION", message: `Deploy action ${index} missing direction` });
  }

  for (const name of deployedNames) {
    if (!hasCatalogOperator(name) && !groupNames.has(name)) warnings.push({ code: "UNKNOWN_OPERATOR", message: `Operator "${name}" not in catalog` });
  }
  const deployCount = actions.filter(action => action.type === "Deploy").length;
  if (deployCount < 3) warnings.push({ code: "LOW_DEPLOY_COUNT", message: `Only ${deployCount} deployments` });
  if (deployCount > 0 && !actions.some(action => action.type === "SkillDaemon")) {
    warnings.push({ code: "NO_SKILL_DAEMON", message: "No SkillDaemon found" });
  }
  return { valid: errors.length === 0, errors, warnings, score: Math.max(0, 100 - errors.length * 20 - warnings.length * 5) };
}
