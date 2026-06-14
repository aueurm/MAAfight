export interface OperatorEntry {
  name: string;
  skill: number;
  tier: number; // 1–5，1 最强
}

export const OPERATOR_POOLS: Record<string, OperatorEntry[]> = {
  vanguard: [
    { name: "伊内丝", skill: 2, tier: 1 },
    { name: "风笛", skill: 2, tier: 1 },
    { name: "琴柳", skill: 3, tier: 2 },
    { name: "桃金娘", skill: 1, tier: 2 },
    { name: "推进之王", skill: 2, tier: 2 },
    { name: "嵯峨", skill: 2, tier: 2 },
    { name: "缪尔赛思", skill: 2, tier: 2 },
    { name: "焰尾", skill: 2, tier: 3 },
    { name: "德克萨斯", skill: 2, tier: 3 },
    { name: "凛冬", skill: 1, tier: 4 },
    { name: "贾维", skill: 2, tier: 4 },
    { name: "清道夫", skill: 1, tier: 5 },
    { name: "讯使", skill: 1, tier: 5 },
    { name: "芬", skill: 1, tier: 5 },
  ],
  guard: [
    { name: "玛恩纳", skill: 3, tier: 1 },
    { name: "史尔特尔", skill: 3, tier: 1 },
    { name: "锏", skill: 3, tier: 1 },
    { name: "银灰", skill: 2, tier: 2 },
    { name: "煌", skill: 2, tier: 2 },
    { name: "棘刺", skill: 2, tier: 2 },
    { name: "山", skill: 1, tier: 2 },
    { name: "布洛卡", skill: 2, tier: 3 },
    { name: "拉普兰德", skill: 2, tier: 3 },
    { name: "羽毛笔", skill: 1, tier: 3 },
    { name: "星极", skill: 1, tier: 4 },
    { name: "霜叶", skill: 1, tier: 5 },
    { name: "缠丸", skill: 1, tier: 5 },
    { name: "玫兰莎", skill: 1, tier: 5 },
  ],
  tank: [
    { name: "黍", skill: 1, tier: 1 },
    { name: "年", skill: 2, tier: 1 },
    { name: "塞雷娅", skill: 1, tier: 2 },
    { name: "泥岩", skill: 2, tier: 2 },
    { name: "星熊", skill: 2, tier: 2 },
    { name: "号角", skill: 2, tier: 2 },
    { name: "临光", skill: 1, tier: 3 },
    { name: "暴雨", skill: 1, tier: 3 },
    { name: "古米", skill: 1, tier: 4 },
    { name: "蛇屠箱", skill: 1, tier: 4 },
    { name: "斑点", skill: 1, tier: 5 },
    { name: "黑角", skill: 1, tier: 5 },
  ],
  sniper: [
    { name: "维什戴尔", skill: 3, tier: 1 },
    { name: "假日威龙陈", skill: 3, tier: 1 },
    { name: "艾拉", skill: 2, tier: 1 },
    { name: "能天使", skill: 2, tier: 2 },
    { name: "黑", skill: 2, tier: 2 },
    { name: "提丰", skill: 2, tier: 2 },
    { name: "鸿雪", skill: 3, tier: 2 },
    { name: "蓝毒", skill: 2, tier: 3 },
    { name: "白金", skill: 2, tier: 3 },
    { name: "灰喉", skill: 1, tier: 4 },
    { name: "流星", skill: 1, tier: 4 },
    { name: "杰西卡", skill: 1, tier: 5 },
    { name: "克洛斯", skill: 1, tier: 5 },
    { name: "克洛丝", skill: 1, tier: 5 },
  ],
  caster: [
    { name: "逻各斯", skill: 1, tier: 1 },
    { name: "艾雅法拉", skill: 2, tier: 1 },
    { name: "伊芙利特", skill: 2, tier: 2 },
    { name: "澄闪", skill: 2, tier: 2 },
    { name: "刻俄柏", skill: 2, tier: 3 },
    { name: "天火", skill: 2, tier: 3 },
    { name: "阿米娅", skill: 2, tier: 3 },
    { name: "远山", skill: 2, tier: 4 },
    { name: "史都华德", skill: 1, tier: 4 },
    { name: "炎熔", skill: 1, tier: 5 },
    { name: "杜林", skill: 1, tier: 5 },
  ],
  medic: [
    { name: "夜莺", skill: 1, tier: 1 },
    { name: "纯烬艾雅法拉", skill: 1, tier: 1 },
    { name: "闪灵", skill: 1, tier: 1 },
    { name: "白面鸮", skill: 2, tier: 2 },
    { name: "凯尔希", skill: 3, tier: 2 },
    { name: "流明", skill: 3, tier: 2 },
    { name: "华法琳", skill: 1, tier: 3 },
    { name: "赫默", skill: 2, tier: 3 },
    { name: "苏苏洛", skill: 2, tier: 4 },
    { name: "芙蓉", skill: 1, tier: 4 },
    { name: "安赛尔", skill: 1, tier: 5 },
  ],
  support: [
    { name: "铃兰", skill: 3, tier: 1 },
    { name: "塑心", skill: 2, tier: 1 },
    { name: "浊心斯卡蒂", skill: 2, tier: 1 },
    { name: "空", skill: 1, tier: 2 },
    { name: "初雪", skill: 1, tier: 2 },
    { name: "灵知", skill: 3, tier: 2 },
    { name: "真理", skill: 1, tier: 3 },
    { name: "梅尔", skill: 1, tier: 3 },
    { name: "地灵", skill: 1, tier: 4 },
    { name: "深海色", skill: 1, tier: 4 },
    { name: "梓兰", skill: 1, tier: 5 },
  ],
  specialist: [
    { name: "麒麟夜刀", skill: 2, tier: 1 },
    { name: "缄默德克萨斯", skill: 2, tier: 1 },
    { name: "归溟幽灵鲨", skill: 2, tier: 2 },
    { name: "阿", skill: 2, tier: 2 },
    { name: "槐琥", skill: 1, tier: 3 },
    { name: "红", skill: 1, tier: 3 },
    { name: "砾", skill: 1, tier: 4 },
    { name: "孑", skill: 1, tier: 4 },
  ],
};

export const ROLE_NAMES: Record<string, string> = {
  vanguard: "先锋", guard: "近卫", tank: "重装",
  sniper: "狙击", caster: "术师", medic: "医疗",
  support: "辅助", specialist: "特种",
};

export const OPERATOR_DB: Map<string, OperatorEntry> = new Map();
(function buildDB() {
  for (const [role, ops] of Object.entries(OPERATOR_POOLS)) {
    for (const op of ops) {
      OPERATOR_DB.set(op.name, { ...op, role } as OperatorEntry & { role: string });
    }
  }
})();
