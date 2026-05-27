import type { BattleScript, ValidationResult, MapData } from "../types";
import { OPERATOR_DB } from "../shared/operatorDB";

export function validateScript(script: BattleScript, mapData?: MapData): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  const warnings: ValidationResult["warnings"] = [];
  let score = 100;

  if (!script.stage_name) {
    errors.push({ code: "MISSING_STAGE_NAME", message: "Missing stage_name" });
  }
  if (!Array.isArray(script.actions) || script.actions.length === 0) {
    errors.push({ code: "INVALID_ACTIONS", message: "Script must have at least one action" });
  }

  const validTypes = ["Deploy", "SpeedUp", "SkillDaemon", "SkillUse", "Retreat", "Wait"];
  const deployedNames = new Set<string>();

  for (let i = 0; i < (script.actions || []).length; i++) {
    const a = script.actions[i];
    if (!a.type || !validTypes.includes(a.type)) {
      errors.push({
        code: "INVALID_ACTION_TYPE",
        message: `Action ${i} invalid type: ${a.type}`,
        location: { actionIndex: i },
      });
    }
    if (a.type === "Deploy") {
      if (a.name) deployedNames.add(a.name);
      if (!a.name) {
        errors.push({
          code: "MISSING_OPERATOR_NAME",
          message: `Deploy action ${i} missing name`,
          location: { actionIndex: i },
        });
      }
      if (!a.location || a.location.length !== 2) {
        errors.push({
          code: "INVALID_LOCATION",
          message: `Deploy action ${i} invalid location`,
          location: { actionIndex: i },
        });
      } else if (mapData) {
        const [row, col] = a.location;
        const tiles = mapData.tiles;
        if (tiles && (row < 0 || row >= tiles.length || col < 0 || col >= (tiles[0]?.length || 0))) {
          errors.push({
            code: "LOCATION_OUT_OF_BOUNDS",
            message: `Deploy action ${i} location [${row}, ${col}] is outside map bounds`,
            location: { actionIndex: i, field: "location" },
          });
        } else if (mapData.deploymentPoints && !mapData.deploymentPoints.some(
          dp => dp.row === row && dp.col === col
        )) {
          warnings.push({
            code: "LOCATION_NOT_DEPLOYABLE",
            message: `Deploy action ${i} location [${row}, ${col}] is not a deployable tile`,
            suggestion: "Choose a valid deployment point",
          });
        }
      }
      if (!a.direction) {
        warnings.push({
          code: "MISSING_DIRECTION",
          message: `Deploy action ${i} missing direction`,
        });
      }
    }
  }

  for (const name of deployedNames) {
    if (!OPERATOR_DB.has(name)) {
      warnings.push({
        code: "UNKNOWN_OPERATOR",
        message: `Operator "${name}" not in database`,
      });
    }
  }

  const deployCount = (script.actions || []).filter(a => a.type === "Deploy").length;
  if (deployCount < 3) {
    warnings.push({
      code: "LOW_DEPLOY_COUNT",
      message: `Only ${deployCount} deployments - might be insufficient`,
    });
  }
  if (!(script.actions || []).some(a => a.type === "SkillDaemon") && deployCount > 0) {
    warnings.push({
      code: "NO_SKILL_DAEMON",
      message: "No SkillDaemon found",
      suggestion: "Add SkillDaemon for auto skill activation",
    });
  }

  score = Math.max(0, score - errors.length * 20 - warnings.length * 5);

  return { valid: errors.length === 0, errors, warnings, score };
}
