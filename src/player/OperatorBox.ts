import * as fs from "fs";
import type { PlayerOperator } from "../types";
import { catalogRoleForName } from "../shared/operatorCatalog";

export interface OperatorRoleStats {
  vanguard: number;
  guard: number;
  tank: number;
  sniper: number;
  caster: number;
  medic: number;
  support: number;
  specialist: number;
}

type RawPlayerOperator = Partial<PlayerOperator> & {
  id?: string;
  name?: string;
  own?: boolean;
  skill_level?: number;
  skillLevel?: number;
  module?: number;
  module_level?: number;
  moduleLevel?: number;
  cost?: number;
};

const ROLE_KEYS: (keyof OperatorRoleStats)[] = [
  "vanguard",
  "guard",
  "tank",
  "sniper",
  "caster",
  "medic",
  "support",
  "specialist",
];

function numberField(...values: Array<unknown>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeOperator(op: RawPlayerOperator): PlayerOperator | null {
  if (!op.own || !op.name) return null;
  const normalized: PlayerOperator = {
    id: op.id || op.name,
    name: op.name,
    rarity: op.rarity || 0,
    own: true,
    elite: op.elite || 0,
    level: op.level || 0,
    potential: op.potential || 0,
  };
  const skillLevel = numberField(op.skillLevel, op.skill_level);
  const module = numberField(op.module);
  const moduleLevel = numberField(op.moduleLevel, op.module_level);
  const cost = numberField(op.cost);
  if (skillLevel !== undefined) normalized.skillLevel = skillLevel;
  if (module !== undefined) normalized.module = module;
  if (moduleLevel !== undefined) normalized.moduleLevel = moduleLevel;
  if (cost !== undefined) normalized.cost = cost;
  return normalized;
}

export class OperatorBox {
  private operators = new Map<string, PlayerOperator>();

  constructor(filePath: string) {
    this.loadFromJson(fs.readFileSync(filePath, "utf-8"));
  }

  static parseJson(raw: string): PlayerOperator[] {
    const list = JSON.parse(raw) as RawPlayerOperator[];
    if (!Array.isArray(list)) {
      throw new Error("Operator export JSON must be an array");
    }
    return list
      .map(normalizeOperator)
      .filter((op): op is PlayerOperator => op !== null);
  }

  static fromOperators(operators: PlayerOperator[]): OperatorBox {
    const box = Object.create(OperatorBox.prototype) as OperatorBox;
    box.operators = new Map();
    for (const op of operators) {
      if (op.own) box.operators.set(op.name, op);
    }
    return box;
  }

  private loadFromJson(raw: string): void {
    for (const op of OperatorBox.parseJson(raw)) {
      this.operators.set(op.name, op);
    }
  }

  get(name: string): PlayerOperator | undefined {
    return this.operators.get(name);
  }

  has(name: string): boolean {
    return this.operators.has(name);
  }

  priority(name: string): number {
    const op = this.operators.get(name);
    if (!op) return -1;
    return op.rarity * 100 + op.elite * 50 + op.level;
  }

  sortedNames(): string[] {
    return [...this.operators.keys()].sort(
      (a, b) => this.priority(b) - this.priority(a)
    );
  }

  highRarityCount(minRarity = 5): number {
    return [...this.operators.values()].filter(op => op.rarity >= minRarity).length;
  }

  roleCounts(): OperatorRoleStats {
    const counts = Object.fromEntries(ROLE_KEYS.map(role => [role, 0])) as unknown as OperatorRoleStats;
    for (const name of this.operators.keys()) {
      const role = catalogRoleForName(name) as keyof OperatorRoleStats | undefined;
      if (role && ROLE_KEYS.includes(role)) counts[role]++;
    }
    return counts;
  }

  toJSON(): PlayerOperator[] {
    return [...this.operators.values()];
  }

  get size(): number {
    return this.operators.size;
  }

  get playerMap(): Map<string, PlayerOperator> {
    return this.operators;
  }
}
