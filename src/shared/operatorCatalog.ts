import { getCombatOperatorByName } from "../engine/CombatModel";

export function hasCatalogOperator(name: string): boolean {
  return Boolean(getCombatOperatorByName(name));
}

export function catalogRoleForName(name: string): string | undefined {
  return getCombatOperatorByName(name)?.role;
}
