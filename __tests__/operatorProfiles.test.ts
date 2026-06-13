import { getOperatorProfile, SIX_STAR_OPERATOR_PROFILES } from "../src/data/operatorProfiles";

describe("six-star operator profiles", () => {
  it("should define function profiles for represented six-star operators", () => {
    const names = [
      "伊内丝", "风笛", "推进之王", "嵯峨", "缪尔赛思", "焰尾",
      "玛恩纳", "史尔特尔", "锏", "银灰", "煌", "棘刺", "山",
      "黍", "年", "塞雷娅", "星熊", "号角",
      "维什戴尔", "艾拉", "能天使", "黑", "提丰",
      "逻各斯", "艾雅法拉", "伊芙利特", "澄闪",
      "夜莺", "闪灵", "凯尔希",
      "铃兰", "塑心",
      "麒麟夜刀", "缄默德克萨斯", "归溟幽灵鲨", "阿",
    ];

    for (const name of names) {
      const profile = getOperatorProfile(name);
      expect(profile).toBeDefined();
      expect(profile!.rarity).toBe(6);
      expect(profile!.functions.length).toBeGreaterThan(0);
      expect(["melee", "ranged", "both"]).toContain(profile!.deployType);
    }
  });

  it("should expose distinctive functional tags for non-trivial six-stars", () => {
    expect(getOperatorProfile("塞雷娅")!.functions).toEqual(expect.arrayContaining(["healing_tank", "healer"]));
    expect(getOperatorProfile("史尔特尔")!.functions).toEqual(expect.arrayContaining(["arts_burst", "boss_killer"]));
    expect(getOperatorProfile("能天使")!.functions).toEqual(expect.arrayContaining(["anti_air", "sustained_dps"]));
    expect(getOperatorProfile("凯尔希")!.functions).toEqual(expect.arrayContaining(["summon", "boss_killer"]));
  });

  it("should not contain duplicate profile names", () => {
    const names = SIX_STAR_OPERATOR_PROFILES.map(profile => profile.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
