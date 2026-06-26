import modelJson from "../data/operatorCombat.v2.json";

interface CatalogModel {
  schemaVersion: number;
  nameIndex: Record<string, string>;
  operators: Record<string, { id: string; name: string; role: string }>;
}

const catalog = modelJson as unknown as CatalogModel;
if (catalog.schemaVersion !== 2 || !catalog.nameIndex || !catalog.operators) {
  throw new Error("Operator catalog v2 is missing or incompatible");
}

export function hasCatalogOperator(name: string): boolean {
  return Boolean(catalog.nameIndex[name]);
}

export function catalogRoleForName(name: string): string | undefined {
  const id = catalog.nameIndex[name];
  return id ? catalog.operators[id]?.role : undefined;
}
