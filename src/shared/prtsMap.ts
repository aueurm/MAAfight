export function isSpawnActionType(type: unknown): boolean {
  return type === "SPAWN" || type === 0;
}

export function normalizeBuildableType(type: unknown): "melee" | "ranged" | "all" | "none" {
  if (type === "MELEE" || type === 1) return "melee";
  if (type === "RANGED" || type === 2) return "ranged";
  if (type === "ALL") return "all";
  return "none";
}
