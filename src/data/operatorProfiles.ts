export type TacticalFunction =
  | "early_dp"
  | "lane_holder"
  | "main_tank"
  | "healing_tank"
  | "anti_air"
  | "physical_burst"
  | "arts_burst"
  | "arts_dps"
  | "sustained_dps"
  | "aoe_clear"
  | "boss_killer"
  | "healer"
  | "control"
  | "debuff"
  | "buff"
  | "fast_redeploy"
  | "summon"
  | "special_mechanic";

export interface OperatorProfile {
  name: string;
  rarity: 6;
  functions: TacticalFunction[];
  deployType: "melee" | "ranged" | "both";
  damageType?: "physical" | "arts" | "true" | "mixed";
  roleHints: string[];
  notes?: string;
}

export const SIX_STAR_OPERATOR_PROFILES: OperatorProfile[] = [
  { name: "伊内丝", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["vanguard", "specialist"], functions: ["early_dp", "debuff", "control", "sustained_dps"] },
  { name: "风笛", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["vanguard"], functions: ["early_dp", "physical_burst", "boss_killer"] },
  { name: "推进之王", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["vanguard"], functions: ["early_dp", "lane_holder", "aoe_clear"] },
  { name: "嵯峨", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["vanguard"], functions: ["early_dp", "lane_holder", "aoe_clear"] },
  { name: "缪尔赛思", rarity: 6, deployType: "melee", damageType: "mixed", roleHints: ["vanguard", "support"], functions: ["early_dp", "summon", "special_mechanic", "control"] },
  { name: "焰尾", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["vanguard"], functions: ["early_dp", "lane_holder"] },

  { name: "玛恩纳", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["guard"], functions: ["physical_burst", "boss_killer", "aoe_clear"] },
  { name: "史尔特尔", rarity: 6, deployType: "melee", damageType: "arts", roleHints: ["guard"], functions: ["arts_burst", "boss_killer", "lane_holder"] },
  { name: "锏", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["guard"], functions: ["physical_burst", "boss_killer", "sustained_dps"] },
  { name: "银灰", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["guard"], functions: ["physical_burst", "boss_killer", "aoe_clear", "debuff"] },
  { name: "煌", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["guard"], functions: ["lane_holder", "sustained_dps", "aoe_clear"] },
  { name: "棘刺", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["guard", "sniper"], functions: ["lane_holder", "sustained_dps", "anti_air"] },
  { name: "山", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["guard", "tank"], functions: ["lane_holder", "main_tank", "sustained_dps"] },

  { name: "黍", rarity: 6, deployType: "melee", damageType: "arts", roleHints: ["tank", "medic"], functions: ["main_tank", "healing_tank", "healer", "buff"] },
  { name: "年", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["tank"], functions: ["main_tank", "buff", "lane_holder"] },
  { name: "塞雷娅", rarity: 6, deployType: "melee", damageType: "arts", roleHints: ["tank", "medic", "support"], functions: ["healing_tank", "main_tank", "healer", "debuff"] },
  { name: "星熊", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["tank"], functions: ["main_tank", "lane_holder"] },
  { name: "号角", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["tank", "sniper"], functions: ["physical_burst", "aoe_clear", "lane_holder"] },

  { name: "维什戴尔", rarity: 6, deployType: "ranged", damageType: "physical", roleHints: ["sniper"], functions: ["anti_air", "physical_burst", "boss_killer", "aoe_clear"] },
  { name: "艾拉", rarity: 6, deployType: "ranged", damageType: "physical", roleHints: ["sniper", "specialist"], functions: ["anti_air", "control", "physical_burst", "debuff"] },
  { name: "能天使", rarity: 6, deployType: "ranged", damageType: "physical", roleHints: ["sniper"], functions: ["anti_air", "sustained_dps", "physical_burst"] },
  { name: "黑", rarity: 6, deployType: "ranged", damageType: "physical", roleHints: ["sniper"], functions: ["physical_burst", "boss_killer", "debuff"] },
  { name: "提丰", rarity: 6, deployType: "ranged", damageType: "physical", roleHints: ["sniper"], functions: ["boss_killer", "sustained_dps", "control"] },

  { name: "逻各斯", rarity: 6, deployType: "ranged", damageType: "arts", roleHints: ["caster"], functions: ["arts_burst", "arts_dps", "aoe_clear", "debuff"] },
  { name: "艾雅法拉", rarity: 6, deployType: "ranged", damageType: "arts", roleHints: ["caster"], functions: ["arts_burst", "aoe_clear", "boss_killer"] },
  { name: "伊芙利特", rarity: 6, deployType: "ranged", damageType: "arts", roleHints: ["caster"], functions: ["arts_dps", "aoe_clear", "debuff"] },
  { name: "澄闪", rarity: 6, deployType: "ranged", damageType: "arts", roleHints: ["caster"], functions: ["arts_dps", "sustained_dps"] },

  { name: "夜莺", rarity: 6, deployType: "ranged", roleHints: ["medic"], functions: ["healer", "buff", "special_mechanic"] },
  { name: "闪灵", rarity: 6, deployType: "ranged", roleHints: ["medic"], functions: ["healer", "buff"] },
  { name: "凯尔希", rarity: 6, deployType: "ranged", damageType: "true", roleHints: ["medic", "guard"], functions: ["healer", "summon", "boss_killer", "lane_holder"] },

  { name: "铃兰", rarity: 6, deployType: "ranged", damageType: "arts", roleHints: ["support"], functions: ["control", "debuff", "buff", "healer"] },
  { name: "塑心", rarity: 6, deployType: "ranged", damageType: "arts", roleHints: ["support"], functions: ["control", "debuff", "arts_dps"] },

  { name: "麒麟夜刀", rarity: 6, deployType: "melee", damageType: "mixed", roleHints: ["specialist", "guard"], functions: ["fast_redeploy", "physical_burst", "arts_burst", "boss_killer"] },
  { name: "缄默德克萨斯", rarity: 6, deployType: "melee", damageType: "arts", roleHints: ["specialist", "caster"], functions: ["fast_redeploy", "arts_burst", "control", "aoe_clear"] },
  { name: "归溟幽灵鲨", rarity: 6, deployType: "melee", damageType: "physical", roleHints: ["specialist", "guard"], functions: ["lane_holder", "sustained_dps", "special_mechanic"] },
  { name: "阿", rarity: 6, deployType: "ranged", damageType: "physical", roleHints: ["specialist", "support"], functions: ["buff", "debuff", "special_mechanic"] },
];

export const OPERATOR_PROFILE_DB = new Map(
  SIX_STAR_OPERATOR_PROFILES.map(profile => [profile.name, profile])
);

export function getOperatorProfile(name: string): OperatorProfile | undefined {
  return OPERATOR_PROFILE_DB.get(name);
}
