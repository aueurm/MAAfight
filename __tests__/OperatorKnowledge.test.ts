import { getCombatOperatorByName, resolveOperatorProfile } from "../src/engine/CombatModel";
import combatModel from "../src/data/operatorCombat.v2.json";
import generatedKnowledge from "../src/data/operatorKnowledge.generated.v1.json";
import {
  getOperatorKnowledge,
  OPERATOR_VECTOR_AXES,
  parseOperatorKnowledge,
  resolveKnowledgeFallback,
  type KnowledgeSubject,
  type OperatorKnowledgeEntry,
} from "../src/engine/OperatorKnowledge";

describe("operator knowledge", () => {
  it("covers every current combat-model operator at the same source commit", () => {
    expect(generatedKnowledge.source.commit).toBe(combatModel.source.commit);
    expect(generatedKnowledge.operators).toHaveLength(Object.keys(combatModel.operators).length);
  });

  it("keeps migrated skill choices while exposing structured spatial vectors", () => {
    const yao = getCombatOperatorByName("遥")!;
    const profile = resolveOperatorProfile(yao, 2);
    const knowledge = getOperatorKnowledge(yao, profile);

    expect(knowledge.preferredSkills).toEqual([2]);
    expect(knowledge.sustainedHealingSkills).toEqual([2]);
    expect(knowledge.skillTags[2]).toEqual(expect.arrayContaining(["persistent-healing", "healing"]));
    expect(knowledge.capabilities).toEqual(expect.arrayContaining(["healing", "support"]));
    expect(knowledge.spatial.range).toEqual(profile.range);
    expect(knowledge.vector).toHaveLength(OPERATOR_VECTOR_AXES.length);
    expect(knowledge.spatial.skillRangeBehavior).toBe("persistent");

    const amiya = getCombatOperatorByName("阿米娅")!;
    const amiyaSkill3 = resolveOperatorProfile(amiya, 3);
    expect(getOperatorKnowledge(amiya).avoidedSkills).toEqual([2, 3]);
    expect(amiyaSkill3.skillRangeId).toBe("knowledge:char_002_amiya:skill:3");
    expect(amiyaSkill3.range).toHaveLength(18);
  });

  it("selects a deterministic similarity fallback for metadata-only operators", () => {
    const candidates: KnowledgeSubject[] = [
      { id: "front", name: "前卫", position: "MELEE", damageType: "physical" },
      { id: "caster", name: "术师", position: "RANGED", damageType: "arts" },
    ];
    const entry: OperatorKnowledgeEntry = {
      id: "new-caster",
      name: "增量术师",
      vector: [0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0.3],
      relationships: { similarTo: ["术师"] },
      provenance: { source: "external", confidence: 0.6 },
    };

    expect(resolveKnowledgeFallback(entry, candidates)?.id).toBe("caster");
    expect(resolveKnowledgeFallback({ ...entry, fallbackTo: "front" }, candidates)?.id).toBe("front");
  });

  it("materializes a new player operator from metadata without changing the combat model", () => {
    jest.isolateModules(() => {
      jest.doMock("../src/data/operatorKnowledge.v1.json", () => ({
        schemaVersion: 1,
        modelVersion: "knowledge-test",
        vectorAxes: [...OPERATOR_VECTOR_AXES],
        operators: [{
          id: "char_metadata_only",
          name: "元数据干员",
          fallbackTo: "阿米娅",
          role: "caster",
          position: "RANGED",
          damageType: "arts",
          spatial: { range: [[0, 0], [0, 1]] },
        }],
      }));
      const combat = require("../src/engine/CombatModel") as typeof import("../src/engine/CombatModel");
      const operator = combat.getCombatOperatorByName("元数据干员")!;
      const profile = combat.resolveOperatorProfile(operator, 1, {
        id: operator.id, name: operator.name, rarity: operator.rarity, own: true, elite: 2, level: 60, potential: 1,
      });

      expect(operator.id).toBe("char_metadata_only");
      expect(profile.range).toEqual([[0, 0], [0, 1]]);
      expect(profile.modelCoverageGaps).toContain("knowledge_similarity_fallback:char_002_amiya");
    });
  });

  it("uses generated vectors while preserving manual strategy overrides", () => {
    jest.isolateModules(() => {
      jest.doMock("../src/data/operatorKnowledge.generated.v1.json", () => ({
        schemaVersion: 1,
        modelVersion: "generated-test",
        source: { repository: "test", commit: "a".repeat(40), ruleVersion: "description-tags-v1", operatorCount: 1 },
        vectorAxes: [...OPERATOR_VECTOR_AXES],
        operators: [{
          id: "char_generated", name: "生成干员", capabilities: ["control"],
          skills: { "1": { tags: ["generated-control"] } },
          vector: [0, 1, 0, 1, 0, 0, 0, 1, 0, 0.5, 0, 0.4], provenance: { source: "external", confidence: 0.8 },
        }],
      }));
      jest.doMock("../src/data/operatorKnowledge.v1.json", () => ({
        schemaVersion: 1,
        modelVersion: "manual-test",
        vectorAxes: [...OPERATOR_VECTOR_AXES],
        operators: [{
          name: "生成干员", capabilities: ["healing"],
          skills: { "1": { preferred: true, tags: ["manual-preference"] } },
        }],
      }));
      const knowledgeApi = require("../src/engine/OperatorKnowledge") as typeof import("../src/engine/OperatorKnowledge");
      const knowledge = knowledgeApi.getOperatorKnowledge({ id: "char_generated", name: "生成干员", position: "RANGED", damageType: "arts" });

      expect(knowledge.source).toBe("external");
      expect(knowledge.capabilities).toEqual(expect.arrayContaining(["control", "healing"]));
      expect(knowledge.preferredSkills).toEqual([1]);
      expect(knowledge.skillTags[1]).toEqual(["generated-control", "manual-preference"]);
      expect(knowledge.vector).toEqual([0, 1, 0, 1, 1, 0, 0, 1, 0, 0.5, 0, 0.4]);
    });
  });

  it("rejects malformed vectors before an update reaches the planner", () => {
    expect(() => parseOperatorKnowledge({
      schemaVersion: 1,
      modelVersion: "invalid",
      vectorAxes: [...OPERATOR_VECTOR_AXES],
      operators: [{ name: "bad", vector: [1] }],
    })).toThrow("must match vectorAxes");
  });
});
