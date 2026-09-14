import { buildEncounterContext } from "../src/engine/EncounterContext";
import { planSkillActions } from "../src/engine/SkillPlanner";
import { extractStageFacts } from "../src/engine/StageFacts";
import type { EnginePick } from "../src/engine/types";
import type { BattleScript, MapData } from "../src/types";

function mapData(): MapData {
  return {
    stageId: "skill-test", name: "Skill test", tiles: [], deploymentPoints: [], strategicPoints: [], highThreatAreas: [],
    routes: [{ id: 0, motionMode: "walk", startPosition: { row: 0, col: 0 }, checkpoints: [], endPosition: { row: 0, col: 2 } }], waves: [],
    enemyDetails: [{ id: "boss", name: "boss", maxHp: 50_000, atk: 1_000, def: 0, magicResistance: 0, moveSpeed: 1, isBoss: true, isElite: true }],
    spawnTimeline: [{ time: 20, enemyId: "boss", count: 1, routeIndex: 0 }],
    options: { characterLimit: 1, maxLifePoint: 3, initialCost: 20, maxCost: 99, costIncreaseTime: 1 },
  };
}

function pick(skillType: string, spType: string): EnginePick {
  return {
    operatorId: "operator", name: "operator", role: "guard", skill: 1, skillRank: 10,
    profile: {
      operatorId: "operator", name: "operator", role: "guard", subProfession: null, position: "MELEE", damageType: "physical",
      skill: 1, skillRank: 10, skillDuration: 20, skillType, spType, spCost: 10, initSp: 0, respawnTime: 0,
      baseRangeId: null, skillRangeId: null, range: [[0, 0]],
      attributes: { hp: 2000, atk: 1000, def: 200, res: 0, cost: 10, block: 1, attackInterval: 1, attackSpeed: 100 },
      metrics: { normalDps: 500, burstDps: 2000, cycleDps: 800, healingHps: 0, physicalEhp: 3000, artsEhp: 2000, controlSeconds: 0 },
      maxTargets: 1, confidence: "exact", modelCoverageGaps: [],
    },
  };
}

function actions(): BattleScript["actions"] {
  return [{ type: "Deploy", name: "operator", location: [0, 0], direction: "Right", costs: 10 }];
}

describe("skill strategy planner", () => {
  it("holds a ready manual skill for the boss window without daemon", () => {
    const data = mapData();
    const facts = extractStageFacts(data);
    const plan = planSkillActions(actions(), [pick("MANUAL", "INCREASE_WITH_TIME")], buildEncounterContext(data, facts), data.options);

    expect(plan.actions).toContainEqual(expect.objectContaining({ type: "Skill", name: "operator", elapsed_time: 15000 }));
    expect(plan.usesDaemon).toBe(false);
  });

  it("leaves automatic skills to daemon", () => {
    const data = mapData();
    const facts = extractStageFacts(data);
    const plan = planSkillActions(actions(), [pick("AUTO", "INCREASE_WHEN_ATTACK")], buildEncounterContext(data, facts), data.options);

    expect(plan.actions).toEqual([]);
    expect(plan.usesDaemon).toBe(true);
  });

  it("expresses a game-time trigger as wall-clock milliseconds at double speed", () => {
    const data = mapData();
    const facts = extractStageFacts(data);
    const plan = planSkillActions([{ type: "SpeedUp" }, ...actions()], [pick("MANUAL", "INCREASE_WITH_TIME")], buildEncounterContext(data, facts), data.options);
    expect(plan.actions).toContainEqual(expect.objectContaining({ type: "Skill", elapsed_time: 7500 }));
  });

  it("does not schedule a skill after its operator has already retreated", () => {
    const data = mapData();
    const facts = extractStageFacts(data);
    const plan = planSkillActions([...actions(), { type: "Retreat", name: "operator", pre_delay: 1000 }],
      [pick("MANUAL", "INCREASE_WITH_TIME")], buildEncounterContext(data, facts), data.options);
    expect(plan.actions).toEqual([]);
    expect(plan.usesDaemon).toBe(true);
  });

  it("falls back to daemon when queued deployments would miss a manual trigger window", () => {
    const data = mapData();
    const facts = extractStageFacts(data);
    const delayed: BattleScript["actions"] = [
      ...actions(),
      { type: "Deploy", name: "reserve", location: [0, 1], direction: "Right", costs: 50 },
    ];
    const plan = planSkillActions(delayed, [pick("MANUAL", "INCREASE_WITH_TIME")], buildEncounterContext(data, facts), data.options);

    expect(plan.actions).toEqual([]);
    expect(plan.usesDaemon).toBe(true);
    expect(plan.coverageGaps).toContain("manual_skill_ordering_unverified:operator");
  });

  it("does not subtract nonexistent ordinary attacks when ranking a skill-only attacker", () => {
    const data = mapData();
    const candidates = ["skill-only", "ordinary-a", "ordinary-b"].map(name => {
      const candidate = pick("MANUAL", "INCREASE_WITH_TIME");
      candidate.name = candidate.operatorId = candidate.profile.name = candidate.profile.operatorId = name;
      candidate.profile.normalAttackSuppressed = name === "skill-only";
      candidate.profile.metrics.burstDps = name === "skill-only" ? 500 : 700;
      return candidate;
    });
    const deployments: BattleScript["actions"] = candidates.map((candidate, col) => ({
      type: "Deploy", name: candidate.name, location: [0, col], direction: "Right", costs: 1,
    }));
    const facts = extractStageFacts(data);
    const plan = planSkillActions(deployments, candidates, buildEncounterContext(data, facts), data.options);
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions.some(action => action.name === "skill-only")).toBe(true);
  });
});
