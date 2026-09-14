import type { PRTSLevelData } from "../types";

function appliesToDefaultDifficulty(mask: unknown): boolean {
  switch (mask) {
    case "NORMAL": case "ALL": case 1: case 3:
      return true;
    case "NONE": case "FOUR_STAR": case 0: case 2:
      return false;
    default:
      throw new Error(`Unsupported hidden-group difficultyMask: ${String(mask)}`);
  }
}

/** Resolve only the raw level's default NORMAL / RUNE configuration, without external contracts. */
export function resolveDefaultHiddenGroups(prts: PRTSLevelData): Set<string> {
  const enabled = new Set<string>();
  for (const rune of prts.runes || []) {
    if (!rune.key.startsWith("level_hidden_group_")) continue;
    if (!appliesToDefaultDifficulty(rune.difficultyMask)) continue;
    if (rune.key !== "level_hidden_group_enable") {
      throw new Error(`Unsupported default hidden-group rune: ${rune.key}`);
    }
    if (!Array.isArray(rune.blackboard)) {
      throw new Error("Invalid level_hidden_group_enable blackboard: expected group names");
    }
    for (const entry of rune.blackboard) {
      if (!entry || typeof entry.valueStr !== "string" || !entry.valueStr.trim()) {
        throw new Error("Invalid level_hidden_group_enable blackboard: expected non-empty valueStr");
      }
      enabled.add(entry.valueStr);
    }
  }
  return enabled;
}
