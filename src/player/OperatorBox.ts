import * as fs from "fs";
import type { PlayerOperator } from "../types";
import { OPERATOR_POOLS } from "../shared/operatorDB";

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

function normalizeOperator(op: RawPlayerOperator): PlayerOperator | null {
  if (!op.own || !op.name) return null;
  return {
    id: op.id || op.name,
    name: op.name,
    rarity: op.rarity || 0,
    own: true,
    elite: op.elite || 0,
    level: op.level || 0,
    potential: op.potential || 0,
  };
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
    const ownedNames = new Set(this.operators.keys());

    for (const role of ROLE_KEYS) {
      const seen = new Set<string>();
      for (const op of OPERATOR_POOLS[role] || []) {
        if (!seen.has(op.name) && ownedNames.has(op.name)) {
          counts[role]++;
          seen.add(op.name);
        }
      }
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
