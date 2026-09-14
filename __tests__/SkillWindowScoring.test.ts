import { buildSquadBeam } from "../src/engine/CandidateBuilder";
import * as CombatModel from "../src/engine/CombatModel";
import { buildEncounterContext } from "../src/engine/EncounterContext";
import { scoreCandidate } from "../src/engine/Scoring";
import { extractStageFacts } from "../src/engine/StageFacts";
import type { EnginePick, ResolvedOperatorProfile } from "../src/engine/types";
import type { BattleScript, MapData } from "../src/types";

function pick(overrides: Partial<ResolvedOperatorProfile> = {}): EnginePick {
  const profile: ResolvedOperatorProfile = {
    operatorId: "window-scorer", name: "window-scorer", role: "guard", subProfession: null,
    position: "RANGED", damageType: "physical", skill: 1, skillRank: 10,
    skillDuration: 5, rawDuration: 5, durationSemantics: "finite", skillType: "MANUAL",
    spType: "INCREASE_WITH_TIME", spCost: 10, initSp: 0, spIncrement: 1, respawnTime: 70,
    baseRangeId: null, skillRangeId: null, baseRange: [[0, 0]], range: [[0, 0], [0, 1]],
    attributes: { hp: 1000, atk: 100, def: 100, res: 0, cost: 1, block: 1, attackInterval: 1, attackSpeed: 100 },
    metrics: { normalDps: 100, burstDps: 1000, cycleDps: 400, healingHps: 0, physicalEhp: 0, artsEhp: 0, controlSeconds: 0 },
    maxTargets: 1, confidence: "exact", modelCoverageGaps: [], ...overrides,
  };
  return { operatorId: profile.operatorId, name: profile.name, role: profile.role,
    skill: profile.skill, skillRank: profile.skillRank, profile };
}

function scenario(times: number[], targetColumn = 1, airShare = 0) {
  const mapData: MapData = {
    stageId: "skill-window-scoring", name: "window scoring", tiles: [],
    deploymentPoints: [{ row: 0, col: 0, buildableType: "all" }], strategicPoints: [], highThreatAreas: [],
    routes: [{ id: 0, motionMode: "walk", startPosition: { row: 0, col: 0 }, checkpoints: [], endPosition: { row: 0, col: 2 } }],
    waves: [], enemyDetails: [{ id: "enemy", name: "enemy", maxHp: 10000, atk: 0, def: 0, magicResistance: 0,
      moveSpeed: 1, isBoss: false, isElite: false }],
    spawnTimeline: [{ time: 0, enemyId: "enemy", count: 1, routeIndex: 0 }],
    options: { characterLimit: 1, maxLifePoint: 3, initialCost: 20, maxCost: 99, costIncreaseTime: 1 },
  };
  const facts = extractStageFacts(mapData);
  const criticalWindow = { start: Math.min(...times), end: Math.max(...times) + 5,
    groundHp: 10000 * (1 - airShare), airHp: 10000 * airShare, groundCount: 1, airCount: 0,
    incomingAttack: 0, blockDemand: 0, eliteWeight: 0, bossWeight: 0, goalThreat: 0, mergeWeight: 0, severity: 10000 };
  facts.criticalWindows = [criticalWindow];
  facts.temporalPressure = { bucketSeconds: 5, criticalWindows: [criticalWindow], coverageGaps: [],
    buckets: times.map(time => ({ time, cells: [{ row: 0, col: targetColumn,
      groundHp: criticalWindow.groundHp, airHp: criticalWindow.airHp, groundCount: 1, airCount: 0,
      incomingAttack: 0, blockDemand: 0, eliteWeight: 0, bossWeight: 0, goalThreat: 0, mergeWeight: 0,
      routeIds: [0], enemyIds: ["enemy"], mechanisms: [], coverageGaps: [] }] })) };
  const encounter = { ...buildEncounterContext(mapData, facts), temporalPressure: facts.temporalPressure,
    criticalWindows: facts.criticalWindows };
  return { mapData, facts, encounter };
}

function script(usage = 1, activation?: number, helperUntil?: number): BattleScript {
  return { stage_name: "skill-window-scoring", minimum_required: "v4.0.0", groups: [],
    opers: [{ name: "window-scorer", skill: 1, skill_usage: usage }], doc: { title: "test", details: "" },
    generatedAt: "test", metadata: { source: "test" },
    actions: [{ type: "ResetStopwatch" }, { type: "Deploy", name: "window-scorer", location: [0, 0], direction: "Right", costs: 1 },
      ...(activation === undefined
        ? [helperUntil === undefined ? { type: "SkillDaemon" } : { type: "Output", elapsed_time: helperUntil * 1000 }]
        : [{ type: "Skill", name: "window-scorer", elapsed_time: activation * 1000 }])] };
}

function score(candidate: EnginePick, data: ReturnType<typeof scenario>, battle = script()) {
  return scoreCandidate(battle, [candidate], data.facts, data.encounter, data.mapData);
}

describe("skill windows in candidate ranking", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not grant skill-only range before readiness or during recharge", () => {
    for (const time of [0, 20]) {
      const data = scenario([time]);
      const active = score(pick(), data);
      const disabled = score(pick(), data, script(0));
      expect(active.breakdown.combat).toBe(disabled.breakdown.combat);
      expect(active.breakdown.position).toBe(disabled.breakdown.position);
    }
    const ready = scenario([10]);
    expect(score(pick(), ready).breakdown.combat).toBeGreaterThan(score(pick(), ready, script(0)).breakdown.combat);
    expect(score(pick(), ready).breakdown.position).toBeGreaterThan(score(pick(), ready, script(0)).breakdown.position);
  });

  it("uses actual planned manual activations rather than the earliest theoretical readiness", () => {
    const data = scenario([10]);
    const delayed = score(pick(), data, script(0, 28));
    expect(delayed.breakdown.combat).toBe(score(pick(), data, script(0)).breakdown.combat);
    expect(delayed.breakdown.position).toBe(score(pick(), data, script(0)).breakdown.position);
    expect(score(pick(), data, script(0, 10)).breakdown.combat).toBeGreaterThan(delayed.breakdown.combat);
    expect(score(pick(), data, script(0, 2)).coverageGaps).toContain("manual_skill_activation_unready");
  });

  it("shares one finite damage budget between simultaneous ground and air targets", () => {
    expect(score(pick(), scenario([10], 1, 0.5)).breakdown.combat)
      .toBeCloseTo(score(pick(), scenario([10], 1, 0)).breakdown.combat);
  });

  it("bounds manual auto-use at the script tail without removing the already active skill", () => {
    const ready = scenario([10]);
    expect(score(pick(), ready, script(1, undefined, 12)).breakdown.combat)
      .toBe(score(pick(), ready).breakdown.combat);
    const later = scenario([25]);
    const ended = score(pick(), later, script(1, undefined, 12));
    expect(ended.breakdown.combat).toBe(score(pick(), later, script(0)).breakdown.combat);
    expect(ended.breakdown.position).toBe(score(pick(), later, script(0)).breakdown.position);
    expect(ended.coverageGaps).toContain("auto_activation_ends_with_script");
    expect(score(pick(), later, script(1, undefined, 28)).breakdown.combat).toBeGreaterThan(ended.breakdown.combat);
    const gameAuto = pick({ skillType: "AUTO" });
    expect(score(gameAuto, later, script(1, undefined, 0)).breakdown.combat)
      .toBe(score(gameAuto, later).breakdown.combat);
  });

  it("credits healing only in its active state and never treats a conditional upper bound as stable healing", () => {
    const data = scenario([10]);
    data.facts.criticalWindows[0].incomingAttack = 10000;
    const healer = pick({ damageType: "heal", metrics: { ...pick().profile.metrics,
      healingHps: 9999, normalHps: 100, skillHps: 1000 } });
    expect(score(healer, data).breakdown.combat).toBeGreaterThan(score(healer, data, script(1, undefined, 0)).breakdown.combat);
    expect(score(healer, data, script(1, undefined, 12)).breakdown.combat).toBe(score(healer, data).breakdown.combat);
    const triggered = pick({ damageType: "heal", metrics: { ...pick().profile.metrics,
      healingHps: 0, normalHps: 0, skillHps: 0, conditionalHpsUpperBound: 9999 } });
    const noHealing = pick({ damageType: "heal" });
    expect(score(triggered, data).breakdown.combat).toBe(score(noHealing, data).breakdown.combat);
    const legacy = pick({ damageType: "heal", metrics: { ...pick().profile.metrics, healingHps: 100 } });
    expect(score(legacy, data).breakdown.combat).toBeGreaterThan(score(noHealing, data).breakdown.combat);
  });

  it("ranks early available total damage ahead of a larger burst that misses the window", () => {
    const early = pick({ initSp: 9, metrics: { ...pick().profile.metrics, burstDps: 500 } });
    const late = pick();
    expect(score(early, scenario([0], 0)).breakdown.combat).toBeGreaterThan(score(late, scenario([0], 0)).breakdown.combat);
  });

  it("changes the actual squad skill choice when pressure moves from startup to a later burst window", () => {
    const record = { ...CombatModel.listCombatOperators()[0], id: "window-scorer", name: "window-scorer",
      role: "guard" as const, subProfession: null, position: "RANGED" as const,
      skills: [{ ...CombatModel.listCombatOperators()[0].skills[0], unlockPhase: 0 },
        { ...CombatModel.listCombatOperators()[0].skills[0], unlockPhase: 0 }] };
    jest.spyOn(CombatModel, "listCombatOperators").mockReturnValue([record]);
    jest.spyOn(CombatModel, "resolveOperatorProfile").mockImplementation((_record, skill) => pick({
      skill, initSp: skill === 1 ? 9 : 0,
      metrics: { ...pick().profile.metrics, burstDps: skill === 1 ? 500 : 1000 },
      baseRange: [[0, 0], [0, 1]],
    }).profile);
    const choose = (time: number) => {
      const data = scenario([time]);
      return buildSquadBeam(data.facts, data.encounter, { search: { squadBeamWidth: 1 } }).squads[0][0].skill;
    };
    expect(choose(0)).toBe(1);
    expect(choose(10)).toBe(2);
  });
});
