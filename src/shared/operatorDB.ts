export interface OperatorEntry {
  name: string;
  skill: number;
  role?: string;
}

export const OPERATOR_POOLS: Record<string, OperatorEntry[]> = {
  vanguard: [
    { name: "推进之王", skill: 2 }, { name: "风笛", skill: 2 },
    { name: "嵯峨", skill: 2 },    { name: "德克萨斯", skill: 2 },
    { name: "焰尾", skill: 2 },    { name: "凛冬", skill: 1 },
    { name: "贾维", skill: 2 },    { name: "清道夫", skill: 1 },
    { name: "讯使", skill: 1 },    { name: "芬", skill: 1 },
    { name: "香草", skill: 1 },
  ],
  tank: [
    { name: "塞雷娅", skill: 1 },  { name: "星熊", skill: 2 },
    { name: "临光", skill: 1 },    { name: "古米", skill: 1 },
    { name: "蛇屠箱", skill: 1 },  { name: "斑点", skill: 1 },
  ],
  medic: [
    { name: "闪灵", skill: 1 },    { name: "夜莺", skill: 1 },
    { name: "白面鸮", skill: 2 },  { name: "赫默", skill: 2 },
    { name: "华法琳", skill: 1 },  { name: "芙蓉", skill: 1 },
    { name: "安赛尔", skill: 1 },
  ],
  sniper: [
    { name: "能天使", skill: 2 },  { name: "黑", skill: 2 },
    { name: "蓝毒", skill: 2 },    { name: "白金", skill: 2 },
    { name: "灰喉", skill: 1 },    { name: "流星", skill: 1 },
    { name: "杰西卡", skill: 1 },  { name: "克洛斯", skill: 1 },
  ],
  caster: [
    { name: "艾雅法拉", skill: 2 }, { name: "伊芙利特", skill: 2 },
    { name: "天火", skill: 2 },     { name: "阿米娅", skill: 2 },
    { name: "史都华德", skill: 1 }, { name: "炎熔", skill: 1 },
  ],
  guard: [
    { name: "银灰", skill: 2 },    { name: "煌", skill: 2 },
    { name: "棘刺", skill: 2 },    { name: "山", skill: 1 },
    { name: "布洛卡", skill: 2 },  { name: "星极", skill: 1 },
    { name: "霜叶", skill: 1 },    { name: "缠丸", skill: 1 },
  ],
  support: [
    { name: "空", skill: 1 },      { name: "初雪", skill: 1 },
    { name: "真理", skill: 1 },    { name: "梅尔", skill: 1 },
  ],
};

export const ROLE_NAMES: Record<string, string> = {
  vanguard: "先锋", tank: "重装", medic: "医疗",
  sniper: "狙击", caster: "术师", guard: "近卫", support: "辅助",
};

export const OPERATOR_DB: Map<string, OperatorEntry> = new Map();
(function buildDB() {
  for (const [role, ops] of Object.entries(OPERATOR_POOLS)) {
    for (const op of ops) {
      OPERATOR_DB.set(op.name, { ...op, role });
    }
  }
})();
