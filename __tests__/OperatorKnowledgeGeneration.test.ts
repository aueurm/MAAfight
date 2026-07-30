const { buildKnowledge, tagsForDescription } = require("../scripts/build-operator-knowledge");

const commit = "a".repeat(40);
const combatModel = {
  modelVersion: "combat-test",
  source: { commit },
  ranges: { base: [[0, 0], [0, 1]], long: [[0, 0], [0, 1], [0, 2], [1, 1]] },
  operators: {
    char_tagged: {
      id: "char_tagged", name: "标签干员", role: "caster", subProfession: "core", position: "RANGED", damageType: "arts", respawnTime: 30,
      e2: { rangeId: "base" }, baseMetrics: { normalDps: 100, burstDps: 100, healingHps: 0, controlSeconds: 0 },
      skills: [{ levels: [{ rangeId: "long", maxTargets: 1, metrics: { normalDps: 100, burstDps: 300, healingHps: 0, controlSeconds: 0 } }] }],
    },
    char_plain: {
      id: "char_plain", name: "普通干员", role: "guard", subProfession: "core", position: "MELEE", damageType: "physical", respawnTime: 70,
      e2: { rangeId: "base" }, baseMetrics: { normalDps: 100, burstDps: 100, healingHps: 0, controlSeconds: 0 },
      skills: [{ levels: [{ rangeId: "base", maxTargets: 1, metrics: { normalDps: 100, burstDps: 100, healingHps: 0, controlSeconds: 0 } }] }],
    },
  },
};

describe("operator knowledge generator", () => {
  it("extracts only deterministic description tags and emits stable spatial vectors", () => {
    expect(tagsForDescription("攻击范围扩大，立即攻击范围内所有敌人并造成眩晕")).toEqual([
      "area", "burst", "control", "range-extension",
    ]);
    expect(tagsForDescription("提高闪避率")).toEqual([]);

    const knowledge = buildKnowledge({
      characterTable: {
        char_tagged: { skills: [{ skillId: "tagged" }] },
        char_plain: { skills: [{ skillId: "plain" }] },
      },
      skillTable: {
        tagged: { levels: [{ description: "攻击范围扩大，立即攻击范围内所有敌人并造成眩晕" }] },
        plain: { levels: [{ description: "提高闪避率" }] },
      },
      combatModel,
      commit,
    });

    const tagged = knowledge.operators.find((operator: { id: string }) => operator.id === "char_tagged")!;
    const plain = knowledge.operators.find((operator: { id: string }) => operator.id === "char_plain")!;
    expect(knowledge.source.operatorCount).toBe(2);
    expect(tagged.skills).toEqual({ 1: { tags: ["area", "burst", "control", "range-extension"] } });
    expect(tagged.spatial).toMatchObject({ attackPattern: "area", coverage: "extended-range", skillRangeBehavior: "extends", positionEffect: "range-bound" });
    expect(tagged.vector).toEqual([0, 1, 0, 1, 0, 1, 1, 1, 0, 0.3333, 1, 0.7]);
    expect(plain.skills).toBeUndefined();
    expect(plain.capabilities).toBeUndefined();
  });
});
