import * as fs from "fs";
import type { PlayerOperator } from "../types";

export class OperatorBox {
  /** name → PlayerOperator 索引，仅包含已拥有干员 */
  private operators = new Map<string, PlayerOperator>();

  /**
   * @param filePath MAA 导出 JSON 文件路径 (Arknights_OperBox_Export.json)
   */
  constructor(filePath: string) {
    const raw = fs.readFileSync(filePath, "utf-8");
    const list: PlayerOperator[] = JSON.parse(raw);
    for (const op of list) {
      if (op.own) {
        this.operators.set(op.name, op);
      }
    }
  }

  /** 查询单个干员练度 */
  get(name: string): PlayerOperator | undefined {
    return this.operators.get(name);
  }

  /** 是否拥有该干员 */
  has(name: string): boolean {
    return this.operators.has(name);
  }

  /** 练度优先级分数（高者优先部署） */
  priority(name: string): number {
    const op = this.operators.get(name);
    if (!op) return -1;
    return op.rarity * 100 + op.elite * 50 + op.level;
  }

  /** 按练度降序排列的干员名列表 */
  sortedNames(): string[] {
    return [...this.operators.keys()].sort(
      (a, b) => this.priority(b) - this.priority(a)
    );
  }

  /** 已拥有干员总数 */
  get size(): number {
    return this.operators.size;
  }

  /** name → PlayerOperator Map，供 ScriptGenerator 使用 */
  get playerMap(): Map<string, PlayerOperator> {
    return this.operators;
  }
}
