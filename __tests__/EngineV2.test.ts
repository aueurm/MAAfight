import fs from "fs";
import path from "path";
import { clearSearchCaches, computeScriptHash, extractStageFacts, generateCopilotScript } from "../src/engine";
import { buildCandidate, buildSquadBeam } from "../src/engine/CandidateBuilder";
import * as CandidateBuilder from "../src/engine/CandidateBuilder";
import { getCombatOperatorByName, getCombatModelInfo, listCombatOperators, resolveOperatorProfile } from "../src/engine/CombatModel";
import { buildEncounterContext } from "../src/engine/EncounterContext";
import { scoreCandidate } from "../src/engine/Scoring";
import * as Scoring from "../src/engine/Scoring";
import { planDeploymentTimeline } from "../src/engine/TimelinePlanner";
import { rotateDirection } from "../src/engine/helpers";
import { validateMAAProtocol } from "../src/copilot/MAAProtocolValidator";
import type { BattleScript, MapData, PlayerOperator } from "../src/types";
import type { EnginePick } from "../src/engine/types";

function makeMapData(): MapData {
  return {
    stageId: "v2-test",
    name: "V2 Test",
    tiles: Array.from({ length: 5 }, (_, row) => Array.from({ length: 7 }, (_, col) => ({
      key: "floor",
      heightType: row === 1 || row === 3 ? "highland" as const : "lowland" as const,
      buildableType: row === 2 ? "all" as const : row === 1 || row === 3 ? "ranged" as const : "none" as const,
      row,
      col,
    }))),
    deploymentPoints: [
      { row: 2, col: 2, buildableType: "all" },
      { row: 2, col: 3, buildableType: "all" },
      { row: 2, col: 4, buildableType: "all" },
      { row: 1, col: 2, buildableType: "ranged" },
      { row: 1, col: 4, buildableType: "ranged" },
      { row: 3, col: 3, buildableType: "ranged" },
    ],
    strategicPoints: [
      { type: "start", row: 2, col: 0, routeCount: 1 },
      { type: "chokepoint", row: 2, col: 3, routeCount: 1 },
      { type: "end", row: 2, col: 6, routeCount: 1 },
    ],
    highThreatAreas: [],
    routes: [{
      id: 0,
      motionMode: "walk",
      startPosition: { row: 2, col: 0 },
      endPosition: { row: 2, col: 6 },
      checkpoints: [{ row: 2, col: 2 }, { row: 2, col: 3 }, { row: 2, col: 4 }],
    }],
    waves: [],
    enemyDetails: [{
      id: "enemy",
      name: "Enemy",
      maxHp: 5000,
      atk: 400,
      def: 200,
      magicResistance: 10,
      moveSpeed: 1,
      isBoss: false,
      isElite: false,
    }],
    spawnTimeline: [{ time: 0, enemyId: "enemy", count: 8, routeIndex: 0 }],
    options: { characterLimit: 8, maxLifePoint: 3, initialCost: 10, maxCost: 99, costIncreaseTime: 1 },
  };
}

function playerOperators(count = 24): Map<string, PlayerOperator> {
  const records = listCombatOperators().slice(0, count);
  return new Map(records.map((record, index) => [record.name, {
    id: record.id,
    name: record.name,
    rarity: record.rarity,
    own: true,
    elite: index === 0 ? 1 : 2,
    level: 60,
    potential: 1,
  }]));
}

interface TestPickOptions {
  role?: EnginePick["role"];
  subProfession?: string | null;
  skill?: number;
  cost?: number;
  skillDuration?: number;
  respawnTime?: number;
  skillType?: string;
  spType?: string;
  spCost?: number;
  initSp?: number;
}

function testPick(
  name: string,
  position: "MELEE" | "RANGED",
  range: Array<[number, number]> = [[0, 0]],
  options: TestPickOptions = {},
): EnginePick {
  const role = options.role ?? "guard";
  return {
    operatorId: name,
    name,
    role,
    skill: options.skill ?? 1,
    skillRank: 10,
    profile: {
      operatorId: name,
      name,
      role,
      subProfession: options.subProfession ?? null,
      position,
      damageType: "physical",
      skill: options.skill ?? 1,
      skillRank: 10,
      skillType: options.skillType,
      spType: options.spType,
      spCost: options.spCost,
      initSp: options.initSp,
      skillDuration: options.skillDuration ?? 0,
      respawnTime: options.respawnTime ?? 0,
      baseRangeId: null,
      skillRangeId: null,
      range,
      attributes: { hp: 1, atk: 1, def: 1, res: 0, cost: options.cost ?? 1, block: 1, attackInterval: 1, attackSpeed: 100 },
      metrics: { normalDps: 1, burstDps: 1, cycleDps: 1, healingHps: 0, physicalEhp: 1, artsEhp: 1, controlSeconds: 0 },
      maxTargets: 1,
      confidence: "exact",
      modelCoverageGaps: [],
    },
  };
}

function makeBlockCoverageMap(): MapData {
  const mapData = makeMapData();
  mapData.routes = [{
    id: 0,
    motionMode: "walk",
    startPosition: { row: 0, col: 0 },
    checkpoints: [{ row: 0, col: 2 }, { row: 0, col: 3 }],
    endPosition: { row: 0, col: 5 },
  }];
  mapData.deploymentPoints = [
    { row: 2, col: 2, buildableType: "melee" },
    { row: 2, col: 1, buildableType: "melee" },
    { row: 1, col: 2, buildableType: "ranged" },
  ];
  return mapData;
}

function maximumActive(actions: Array<{ type: string; cooling?: number }>): number {
  let active = 0;
  let maximum = 0;
  for (const action of actions) {
    if (action.type === "Deploy" && !action.cooling) active++;
    if (action.type === "Retreat") active--;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

describe("v2 skill engine", () => {
  it("loads a pinned full operator model without role fallback", () => {
    const info = getCombatModelInfo();
    expect(info.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(info.operatorCount).toBeGreaterThan(300);
    const outsider = getCombatOperatorByName("重岳");
    expect(outsider).toBeDefined();
    const profile = resolveOperatorProfile(outsider!, 1, {
      id: outsider!.id, name: outsider!.name, rarity: outsider!.rarity, own: true,
      elite: 2, level: 60, potential: 1,
    });
    expect(profile.skillRank).toBe(10);
    expect(profile.modelCoverageGaps).toContain("assumed_skill_rank_10");

    const yato = getCombatOperatorByName("麒麟R夜刀")!;
    const yatoProfile = resolveOperatorProfile(yato, 1, {
      id: yato.id, name: yato.name, rarity: yato.rarity, own: true,
      elite: 2, level: 90, potential: 3,
    });
    expect(yatoProfile.respawnTime).toBe(16);
    expect(yatoProfile.skillDuration).toBe(20);
  });

  it("extracts immutable stage facts and encounter pressure", () => {
    const mapData = makeMapData();
    const facts = extractStageFacts(mapData);
    const encounter = buildEncounterContext(mapData, facts);
    expect(facts.enemyCount).toBe(8);
    expect(encounter.windows[0].groups[0]).toMatchObject({ enemyId: "enemy", count: 8, def: 200, res: 10 });
    expect(encounter.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses blue tiles as goals instead of scripted route exits through red doors", () => {
    const mapData = makeMapData();
    mapData.tiles[2][6].key = "end";
    mapData.tiles[2][0].key = "start";
    mapData.routes.push({ ...mapData.routes[0], id: 1, endPosition: { row: 2, col: 0 } });
    expect(extractStageFacts(mapData).goalCells).toEqual([{ row: 2, col: 6 }]);
  });

  it("does not score an unaffordable deployment as available in the opening window", () => {
    const mapData = makeMapData();
    mapData.options.initialCost = 0;
    const facts = extractStageFacts(mapData);
    const encounter = buildEncounterContext(mapData, facts);
    const pick = testPick("时间线攻击者", "RANGED", [[0, -2]], { cost: 0 });
    const script = (cost: number): BattleScript => ({
      stage_name: "V2-1", minimum_required: "v6.0.0", doc: { title: "test", details: "test" },
      opers: [{ name: pick.name, skill: 1, skill_usage: 1 }], groups: [],
      actions: [{ type: "Deploy", name: pick.name, location: [2, 2], direction: "Right", costs: cost }],
      generatedAt: "2026-01-01T00:00:00.000Z", metadata: { source: "test" }, version: 3,
    });

    expect(scoreCandidate(script(0), [pick], facts, encounter, mapData).breakdown.combat)
      .toBeGreaterThan(scoreCandidate(script(20), [pick], facts, encounter, mapData).breakdown.combat);
  });

  it("scores only the part of a pressure window where a deployment is actually present", () => {
    const mapData = makeMapData();
    mapData.spawnTimeline[0].time = 5;
    const facts = extractStageFacts(mapData);
    const encounter = buildEncounterContext(mapData, facts);
    const pick = testPick("时间线攻击者", "RANGED", [[0, 0], [0, 1], [0, 2], [0, 3]], { cost: 0 });
    const battle: BattleScript = {
      stage_name: "V2-1", minimum_required: "v6.0.0", doc: { title: "test", details: "test" },
      opers: [{ name: pick.name, skill: 1 }], groups: [],
      actions: [{ type: "Deploy", name: pick.name, location: [2, 2], direction: "Right", costs: 0, pre_delay: 5000 }],
      generatedAt: "2026-01-01T00:00:00.000Z", metadata: { source: "test" }, version: 3,
    };
    const score = (actions: BattleScript["actions"]): number => scoreCandidate({ ...battle, actions }, [pick], facts, encounter, mapData).breakdown.combat;
    const present = score(battle.actions);
    expect(present).toBeGreaterThan(score([{ ...battle.actions[0], pre_delay: 20000 }]));
    expect(present).toBeGreaterThan(score([
      { ...battle.actions[0], pre_delay: 0 }, { type: "Retreat", name: pick.name, pre_delay: 1000 },
    ]));
  });

  it("subtracts cost waiting from an absolute joint deployment target", () => {
    const mapData = makeMapData();
    const pick = testPick("绝对时机", "MELEE", [[0, 0]], { cost: 20 });
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
      picks: [pick], positionVariant: 0, timingVariant: 0, options: {},
      jointPlan: { decisions: [{ pick, location: [2, 2], direction: "Right", score: 0, targetTime: 10 }], score: 0, signature: "target" },
    });
    expect(planDeploymentTimeline(built.script, mapData.options).deployments[0].time).toBe(10);
  });

  it("uses old-pool outsiders and excludes non-E2 players", () => {
    const outsider = getCombatOperatorByName("重岳")!;
    const records = [outsider, ...listCombatOperators().filter(record => record.id !== outsider.id).slice(0, 11)];
    const players = new Map(records.map((record, index) => [record.name, {
      id: record.id, name: record.name, rarity: record.rarity, own: true,
      elite: index === 1 ? 1 : 2, level: 60, potential: 1,
    }] as [string, PlayerOperator]));
    const mapData = makeMapData();
    const facts = extractStageFacts(mapData);
    const beam = buildSquadBeam(facts, buildEncounterContext(mapData, facts), { playerOperators: players });
    expect(beam.squads[0].some(pick => pick.name === "重岳")).toBe(true);
    expect(beam.squads[0].some(pick => pick.name === records[1].name)).toBe(false);
    expect(beam.squads[0]).toHaveLength(11);
  });

  it("applies preferred skills after filtering the player roster", () => {
    const eyjafjalla = getCombatOperatorByName("艾雅法拉")!;
    const saria = getCombatOperatorByName("塞雷娅")!;
    const typhon = getCombatOperatorByName("提丰")!;
    const players = new Map([eyjafjalla, saria, typhon].map(record => [record.id, {
      id: record.id, name: record.name, rarity: record.rarity, own: true,
      elite: 2, level: 60, potential: 1,
    }] as [string, PlayerOperator]));
    const mapData = makeMapData();
    const facts = extractStageFacts(mapData);
    const picks = buildSquadBeam(facts, buildEncounterContext(mapData, facts), { playerOperators: players }).squads[0];

    expect(picks).toHaveLength(3);
    expect(picks.find(pick => pick.name === "艾雅法拉")?.skill).toBe(2);
    expect(picks.find(pick => pick.name === "塞雷娅")?.skill).toBeGreaterThanOrEqual(1);
    expect([2, 3]).toContain(picks.find(pick => pick.name === "提丰")?.skill);
  });

  it("opens high deployment demand with a vanguard without changing low-demand scoring", () => {
    const records = ["德克萨斯", "佩佩", "塞雷娅"].map(name => getCombatOperatorByName(name)!);
    const players = new Map(records.map(record => [record.id, {
      id: record.id, name: record.name, rarity: record.rarity, own: true,
      elite: 2, level: 60, potential: 1,
    }] as [string, PlayerOperator]));
    const highMap = makeMapData();
    highMap.deploymentPoints = [
      { row: 2, col: 2, buildableType: "all" },
      { row: 2, col: 3, buildableType: "all" },
    ];
    const highFacts = extractStageFacts(highMap);
    const highEncounter = buildEncounterContext(highMap, highFacts);
    const highPicks = buildSquadBeam(highFacts, highEncounter, { playerOperators: players }).squads[0];

    expect(highEncounter.demand.deployment).toBeGreaterThanOrEqual(0.5);
    expect(highPicks[0].role).toBe("vanguard");

    const lowMap = makeMapData();
    lowMap.options.initialCost = 30;
    lowMap.deploymentPoints = [
      { row: 2, col: 1, buildableType: "all" },
      { row: 2, col: 2, buildableType: "all" },
    ];
    lowMap.routes = [{
      id: 0,
      motionMode: "walk",
      startPosition: { row: 2, col: 0 },
      checkpoints: [{ row: 2, col: 1 }],
      endPosition: { row: 2, col: 2 },
    }];
    lowMap.spawnTimeline = [
      { time: 0, enemyId: "enemy", count: 1, routeIndex: 0 },
      { time: 15, enemyId: "enemy", count: 9, routeIndex: 0 },
    ];
    const lowFacts = extractStageFacts(lowMap);
    const lowEncounter = buildEncounterContext(lowMap, lowFacts);
    const lowPicks = buildSquadBeam(lowFacts, lowEncounter, { playerOperators: players }).squads[0];

    expect(lowEncounter.demand.deployment).toBeLessThan(0.5);
    expect(lowPicks[0].role).not.toBe("vanguard");
  });

  it("reserves a stealth revealer when the stage has hidden enemies", () => {
    const silverAsh = getCombatOperatorByName("银灰")!;
    const records = [silverAsh, ...listCombatOperators().filter(record => record.id !== silverAsh.id).slice(0, 12)];
    const players = new Map(records.map(record => [record.id, {
      id: record.id, name: record.name, rarity: record.rarity, own: true,
      elite: 2, level: 60, potential: 1,
    }] as [string, PlayerOperator]));
    const mapData = makeMapData();
    mapData.enemyDetails[0].mechanics = ["stealth"];
    const facts = extractStageFacts(mapData);
    const picks = buildSquadBeam(facts, buildEncounterContext(mapData, facts), { playerOperators: players }).squads[0];

    expect(picks.some(pick => pick.name === "银灰")).toBe(true);
  });

  it("faces a stealth revealer toward the hidden route's final approach", () => {
    const mapData = makeMapData();
    mapData.routes = [{
      id: 0, motionMode: "fly", startPosition: { row: 2, col: 0 }, checkpoints: [], endPosition: { row: 2, col: 6 },
    }];
    mapData.enemyDetails = [{ ...mapData.enemyDetails[0], id: "stealth", mechanics: ["stealth"] }];
    mapData.spawnTimeline = [{ time: 0, enemyId: "stealth", count: 1, routeIndex: 0 }];
    const silverAshPick = testPick("银灰", "MELEE", [[0, 0], [0, 1], [0, 2]], { skill: 3 });
    const silverAsh = {
      ...silverAshPick,
      operatorId: "char_172_svrash",
      profile: { ...silverAshPick.profile, operatorId: "char_172_svrash" },
    };

    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: true,
      picks: [silverAsh], positionVariant: 0, timingVariant: 0, options: {},
    });

    expect(built.script.actions.find(action => action.type === "Deploy")?.direction).toBe("Right");
  });

  it("waits for a stealth revealer before queuing later deployments", () => {
    const mapData = makeMapData();
    mapData.routes = [{
      id: 0, motionMode: "fly", startPosition: { row: 2, col: 0 }, checkpoints: [], endPosition: { row: 2, col: 6 },
    }];
    mapData.enemyDetails = [{ ...mapData.enemyDetails[0], id: "stealth", isBoss: true, maxHp: 50_000, mechanics: ["stealth"] }];
    mapData.spawnTimeline = [{ time: 20, enemyId: "stealth", count: 1, routeIndex: 0 }];
    const silverAshPick = testPick("银灰", "MELEE", [[0, 0], [0, 1], [0, 2]], {
      skill: 3, skillType: "MANUAL", spType: "INCREASE_WITH_TIME", spCost: 0, initSp: 0,
    });
    const silverAsh = {
      ...silverAshPick,
      operatorId: "char_172_svrash",
      profile: { ...silverAshPick.profile, operatorId: "char_172_svrash" },
    };
    const facts = extractStageFacts(mapData);
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts, openingPressure: true,
      picks: [silverAsh, testPick("后备", "MELEE", [[0, 0]], { cost: 50 })],
      positionVariant: 0, timingVariant: 0, encounter: buildEncounterContext(mapData, facts), options: {},
    });

    const actions = built.script.actions;
    const silverDeploy = actions.findIndex(action => action.type === "Deploy" && action.name === "银灰");
    const skill = actions.findIndex(action => action.type === "Skill" && action.name === "银灰");
    const reserveDeploy = actions.findIndex(action => action.type === "Deploy" && action.name === "后备");
    expect(skill).toBe(silverDeploy + 1);
    expect(skill).toBeLessThan(reserveDeploy);
  });

  it("reserves a sustained ranged healer for each pressured goal", () => {
    const records = [
      "德克萨斯", "Mon3tr", "末药", "维什戴尔", "逻各斯", "玛恩纳", "佩佩",
    ].map(name => getCombatOperatorByName(name)!);
    const players = new Map(records.map(record => [record.id, {
      id: record.id, name: record.name, rarity: record.rarity, own: true,
      elite: 2, level: 60, potential: 1,
    }] as [string, PlayerOperator]));
    const mapData = makeMapData();
    mapData.routes = [
      { id: 0, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [], endPosition: { row: 0, col: 6 } },
      { id: 1, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [], endPosition: { row: 4, col: 6 } },
    ];
    const facts = extractStageFacts(mapData);
    const picks = buildSquadBeam(facts, buildEncounterContext(mapData, facts), { playerOperators: players }).squads[0];

    expect(picks.slice(0, 3).map(pick => pick.role)).toEqual(["vanguard", "medic", "medic"]);
  });

  it("excludes self-disabling skills while retaining the other skill choices", () => {
    const exclusions = new Map<string, { blocked: number[]; choices: number }>([
      ["阿米娅", { blocked: [2, 3], choices: 1 }],
      ["幽灵鲨", { blocked: [2], choices: 1 }],
      ["雷蛇", { blocked: [2], choices: 1 }],
      ["远山", { blocked: [2], choices: 1 }],
      ["布洛卡", { blocked: [2], choices: 1 }],
      ["断罪者", { blocked: [2], choices: 1 }],
      ["森蚺", { blocked: [3], choices: 2 }],
      ["蚀清", { blocked: [1], choices: 1 }],
      ["极光", { blocked: [2], choices: 1 }],
      ["洛洛", { blocked: [2], choices: 1 }],
      ["苍苔", { blocked: [2], choices: 1 }],
    ]);
    const mapData = makeMapData();
    const facts = extractStageFacts(mapData);
    const encounter = buildEncounterContext(mapData, facts);

    for (const [name, { blocked, choices }] of exclusions) {
      const record = getCombatOperatorByName(name)!;
      const players = new Map([[record.id, {
        id: record.id, name: record.name, rarity: record.rarity, own: true,
        elite: 2, level: 60, potential: 1,
      }] as [string, PlayerOperator]]);
      const beam = buildSquadBeam(facts, encounter, { playerOperators: players });

      expect(beam.expandedStates).toBe(choices);
      expect(blocked).not.toContain(beam.squads[0][0]?.skill);
    }
  });

  it("faces a melee blocker toward the highest-threat incoming route", () => {
    const mapData = makeMapData();
    mapData.deploymentPoints = [{ row: 2, col: 2, buildableType: "melee" }];
    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts: extractStageFacts(mapData),
      openingPressure: false,
      picks: [testPick("melee", "MELEE", [[0, 1], [0, 2]])],
      positionVariant: 0,
      timingVariant: 0,
      options: {},
    });

    expect(built.script.actions.find(action => action.type === "Deploy")?.direction).toBe("Left");
  });

  it("strongly prefers a ranged direction covering all earlier melee blockers", () => {
    const mapData = makeBlockCoverageMap();
    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts: extractStageFacts(mapData),
      openingPressure: false,
      picks: [
        testPick("melee-a", "MELEE"),
        testPick("melee-b", "MELEE"),
        testPick("ranged", "RANGED", [[-1, 0], [-1, 1]]),
      ],
      positionVariant: 0,
      timingVariant: 0,
      options: {},
    });

    expect(built.script.actions.filter(action => action.type === "Deploy")[2].direction).toBe("Left");
  });

  it("prefers distinct melee blockers at each goal front before a shared central choke", () => {
    const mapData = makeMapData();
    mapData.routes = [
      { id: 0, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [{ row: 2, col: 2 }], endPosition: { row: 0, col: 6 } },
      { id: 1, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [{ row: 2, col: 2 }], endPosition: { row: 4, col: 6 } },
    ];
    mapData.deploymentPoints = [
      { row: 2, col: 2, buildableType: "melee" },
      { row: 0, col: 5, buildableType: "melee" },
      { row: 4, col: 5, buildableType: "melee" },
    ];
    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts: extractStageFacts(mapData),
      openingPressure: false,
      picks: [testPick("melee-a", "MELEE"), testPick("melee-b", "MELEE")],
      positionVariant: 0,
      timingVariant: 0,
      options: {},
    });

    expect(built.script.actions.filter(action => action.type === "Deploy").map(action => action.location)).toEqual([
      [0, 5],
      [4, 5],
    ]);
  });

  it("infers recessed goal fronts and spreads sustained healers across them", () => {
    const mapData = makeMapData();
    mapData.routes = [
      { id: 0, motionMode: "walk", startPosition: { row: 4, col: 3 }, checkpoints: [], endPosition: { row: 2, col: 0 } },
      { id: 1, motionMode: "walk", startPosition: { row: 4, col: 3 }, checkpoints: [], endPosition: { row: 2, col: 6 } },
    ];
    mapData.deploymentPoints = [
      { row: 2, col: 2, buildableType: "melee" },
      { row: 2, col: 3, buildableType: "melee" },
      { row: 2, col: 4, buildableType: "melee" },
      { row: 1, col: 2, buildableType: "ranged" },
      { row: 1, col: 4, buildableType: "ranged" },
    ];
    mapData.tiles[2][2].key = "road";
    mapData.tiles[2][4].key = "road";
    const healingRange: Array<[number, number]> = [[0, 1]];
    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts: extractStageFacts(mapData),
      openingPressure: true,
      picks: [
        testPick("先锋", "MELEE", [[0, 0]], { role: "vanguard" }),
        testPick("左路主坦", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("右路主坦", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("医疗甲", "RANGED", healingRange, { role: "medic" }),
        testPick("医疗乙", "RANGED", healingRange, { role: "medic" }),
      ],
      positionVariant: 0,
      timingVariant: 0,
      options: {},
    });
    const deploys = built.script.actions.filter(action => action.type === "Deploy");

    expect(deploys.map(action => action.name)).toEqual(["先锋", "左路主坦", "右路主坦", "医疗甲", "医疗乙"]);
    expect(deploys.slice(1, 3).map(action => action.location)).toEqual(expect.arrayContaining([[2, 2], [2, 4]]));
    for (const frontline of deploys.slice(1, 3)) {
      expect(deploys.slice(3).some(healer => healingRange.some(offset => {
        const [row, col] = rotateDirection(offset, healer.direction!);
        return healer.location![0] + row === frontline.location![0]
          && healer.location![1] + col === frontline.location![1];
      }))).toBe(true);
    }
  });

  it("keeps recessed goal fronts on their distinct incoming routes", () => {
    const mapData = makeMapData();
    mapData.routes = [
      { id: 0, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [{ row: 0, col: 3 }], endPosition: { row: 0, col: 6 } },
      { id: 1, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [{ row: 4, col: 3 }], endPosition: { row: 4, col: 6 } },
    ];
    mapData.deploymentPoints = [
      { row: 0, col: 3, buildableType: "melee" },
      { row: 4, col: 3, buildableType: "melee" },
      { row: 2, col: 6, buildableType: "melee" },
    ];
    for (const point of mapData.deploymentPoints) mapData.tiles[point.row][point.col].key = "road";

    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts: extractStageFacts(mapData),
      openingPressure: true,
      picks: [
        testPick("上路主坦", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("下路主坦", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
      ],
      positionVariant: 0,
      timingVariant: 0,
      options: {},
    });

    expect(built.script.actions.filter(action => action.type === "Deploy").map(action => action.location)).toEqual([
      [0, 3],
      [4, 3],
    ]);
  });

  it("assigns an unhealable lane holder to the non-boss lane and heals the boss blocker", () => {
    const mapData = makeMapData();
    mapData.routes = [
      { id: 0, motionMode: "walk", startPosition: { row: 0, col: 0 }, checkpoints: [], endPosition: { row: 0, col: 6 } },
      { id: 1, motionMode: "walk", startPosition: { row: 4, col: 0 }, checkpoints: [], endPosition: { row: 4, col: 6 } },
    ];
    mapData.enemyDetails.push({ ...mapData.enemyDetails[0], id: "boss", name: "Boss", isBoss: true });
    mapData.spawnTimeline = [
      { time: 0, enemyId: "boss", count: 1, routeIndex: 0 },
      { time: 0, enemyId: "enemy", count: 8, routeIndex: 1 },
    ];
    mapData.deploymentPoints = [
      { row: 0, col: 5, buildableType: "melee" },
      { row: 4, col: 5, buildableType: "melee" },
      { row: 1, col: 5, buildableType: "ranged" },
      { row: 3, col: 5, buildableType: "ranged" },
    ];
    const healingRange: Array<[number, number]> = [[0, 1]];
    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts: extractStageFacts(mapData),
      openingPressure: false,
      picks: [
        testPick("solo-lane", "MELEE", [[0, 0]], { subProfession: "unyield" }),
        testPick("boss-tank", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("medic", "RANGED", healingRange, { role: "medic" }),
      ],
      positionVariant: 0,
      timingVariant: 0,
      options: {},
    });
    const deploys = built.script.actions.filter(action => action.type === "Deploy");
    const byName = new Map(deploys.map(action => [action.name, action]));

    expect(byName.get("boss-tank")?.location).toEqual([0, 5]);
    expect(byName.get("solo-lane")?.location).toEqual([4, 5]);
    const medic = byName.get("medic")!;
    const covers = (target: [number, number]): boolean => healingRange.some(offset => {
      const [row, col] = rotateDirection(offset, medic.direction!);
      return medic.location![0] + row === target[0] && medic.location![1] + col === target[1];
    });
    expect(covers([0, 5])).toBe(true);
    expect(covers([4, 5])).toBe(false);
  });

  it("builds a pressured opening in the nearest defensive zone before ranged support", () => {
    const mapData = makeMapData();
    mapData.routes = [
      { id: 0, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [{ row: 2, col: 2 }], endPosition: { row: 0, col: 6 } },
      { id: 1, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [{ row: 2, col: 2 }], endPosition: { row: 4, col: 6 } },
    ];
    mapData.deploymentPoints = [
      { row: 2, col: 2, buildableType: "melee" },
      { row: 1, col: 5, buildableType: "melee" },
      { row: 2, col: 5, buildableType: "melee" },
      { row: 0, col: 5, buildableType: "melee" },
      { row: 4, col: 5, buildableType: "melee" },
      { row: 2, col: 5, buildableType: "melee" },
      { row: 2, col: 3, buildableType: "ranged" },
      { row: 1, col: 4, buildableType: "ranged" },
    ];
    const sustainedRange: Array<[number, number]> = [[-2, 2], [-1, 2], [0, 2], [2, 2]];
    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts: extractStageFacts(mapData),
      openingPressure: true,
      picks: [
        testPick("先锋", "MELEE", [[0, 0]], { role: "vanguard" }),
        testPick("高台", "RANGED", [[-2, 2], [-1, 2], [2, 2]]),
        testPick("上路主坦", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("下路主坦", "MELEE", [[0, 0]], { role: "tank", subProfession: "guardian" }),
        testPick("近卫", "MELEE"),
        testPick("遥", "RANGED", sustainedRange, { role: "support", skill: 2 }),
      ],
      positionVariant: 0,
      timingVariant: 0,
      options: {},
    });
    const deploys = built.script.actions.filter(action => action.type === "Deploy");

    expect(deploys.map(action => action.name)).toEqual(["先锋", "上路主坦", "下路主坦", "遥", "高台", "近卫"]);
    expect(deploys[0].location).not.toEqual([2, 2]);
    expect(deploys.slice(1, 3).map(action => action.location)).toEqual(expect.arrayContaining([[0, 5], [4, 5]]));
    expect(deploys[3].location).toEqual([2, 3]);
    expect(deploys[5].location).not.toEqual([2, 2]);
    for (const action of [...deploys.slice(1, 3), deploys[5]]) {
      expect(sustainedRange.some(offset => {
        const [row, col] = rotateDirection(offset, deploys[3].direction!);
        return deploys[3].location![0] + row === action.location![0]
          && deploys[3].location![1] + col === action.location![1];
      })).toBe(true);
    }
  });

  it("prioritizes measurable healing over a zero-healing bard in a pressured opening", () => {
    const mapData = makeMapData();
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: true,
      picks: [
        testPick("先锋", "MELEE", [[0, 0]], { role: "vanguard" }),
        testPick("前线", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("浊心斯卡蒂", "RANGED", [[0, 0]], { role: "support", subProfession: "bard" }),
        testPick("医疗", "RANGED", [[0, 0]], { role: "medic" }),
      ],
      positionVariant: 0, timingVariant: 0, options: {},
    });

    const names = built.script.actions.filter(action => action.type === "Deploy").map(action => action.name);
    expect(names.indexOf("医疗")).toBeLessThan(names.indexOf("浊心斯卡蒂"));
  });

  it("deploys opening blockers and anti-air attackers before healers when fliers open the stage", () => {
    const mapData = makeMapData();
    mapData.routes = [
      { id: 0, motionMode: "walk", startPosition: { row: 2, col: 0 }, checkpoints: [{ row: 2, col: 2 }], endPosition: { row: 0, col: 6 } },
      { id: 1, motionMode: "fly", startPosition: { row: 1, col: 0 }, checkpoints: [{ row: 1, col: 2 }], endPosition: { row: 1, col: 6 } },
    ];
    mapData.deploymentPoints = [
      { row: 2, col: 2, buildableType: "melee" },
      { row: 0, col: 5, buildableType: "melee" },
      { row: 2, col: 3, buildableType: "ranged" },
      { row: 1, col: 3, buildableType: "ranged" },
    ];
    mapData.tiles[0][5].key = "road";
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: true,
      picks: [
        testPick("先锋", "MELEE", [[0, 0]], { role: "vanguard" }),
        testPick("前线", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector", cost: 20 }),
        testPick("医疗", "RANGED", [[0, 0]], { role: "medic" }),
        testPick("对空", "RANGED", [[-1, 0], [0, 0], [1, 0]], { role: "sniper", cost: 6 }),
      ],
      positionVariant: 0, timingVariant: 0, options: {},
    });

    const names = built.script.actions.filter(action => action.type === "Deploy").map(action => action.name);
    expect(names).toEqual(expect.arrayContaining(["对空", "医疗"]));
    expect(names.indexOf("前线")).toBe(1);
    expect(names.indexOf("对空")).toBe(2);
    expect(names.indexOf("前线")).toBeLessThan(names.indexOf("医疗"));
    expect(names.indexOf("对空")).toBeLessThan(names.indexOf("医疗"));
  });

  it("does not deploy a ranged vanguard twice when it also covers opening fliers", () => {
    const mapData = makeMapData();
    mapData.routes.push({
      id: 1, motionMode: "fly", startPosition: { row: 1, col: 0 }, checkpoints: [], endPosition: { row: 1, col: 6 },
    });
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: true,
      picks: [
        testPick("对空先锋", "RANGED", [[-1, 0], [0, 0], [1, 0]], { role: "vanguard" }),
        testPick("前线", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("医疗", "RANGED", [[0, 0]], { role: "medic" }),
      ],
      positionVariant: 0, timingVariant: 0, options: {},
    });

    expect(built.script.actions.filter(action => action.type === "Deploy" && action.name === "对空先锋")).toHaveLength(1);
  });

  it("marks generated manual skill operators for MAA manual use", () => {
    const mapData = makeMapData();
    mapData.enemyDetails[0] = { ...mapData.enemyDetails[0], isBoss: true, maxHp: 50_000 };
    mapData.spawnTimeline = [{ time: 20, enemyId: "enemy", count: 1, routeIndex: 0 }];
    const facts = extractStageFacts(mapData);
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts, openingPressure: true,
      picks: [testPick("手动", "MELEE", [[0, 0]], {
        skillType: "MANUAL", spType: "INCREASE_WITH_TIME", spCost: 0, initSp: 0,
      })],
      positionVariant: 0, timingVariant: 0, encounter: buildEncounterContext(mapData, facts), options: {},
    });

    expect(built.script.actions).toContainEqual(expect.objectContaining({ type: "Skill", name: "手动" }));
    expect(built.script.opers).toContainEqual(expect.objectContaining({ name: "手动", skill_usage: 0 }));
  });

  it("retires a temporary vanguard only when its reserve can deploy", () => {
    const mapData = makeMapData();
    mapData.options.characterLimit = 2;
    mapData.deploymentPoints = [
      { row: 2, col: 2, buildableType: "all" },
      { row: 2, col: 3, buildableType: "all" },
      { row: 2, col: 4, buildableType: "all" },
    ];
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
      picks: [
        testPick("先锋", "MELEE", [[0, 0]], { role: "vanguard", cost: 5, respawnTime: 70 }),
        testPick("主力", "MELEE", [[0, 0]], { cost: 7 }),
        testPick("后备主力", "MELEE", [[0, 0]], { cost: 20 }),
      ],
      positionVariant: 0, timingVariant: 0, options: {},
    });
    const actions = built.script.actions;

    expect(actions.map(action => action.type)).toEqual([
      "SpeedUp", "Deploy", "Deploy", "Retreat", "Deploy", "SkillDaemon",
    ]);
    expect(actions[3]).toMatchObject({ type: "Retreat", name: "先锋", costs: 20 });
    expect(actions[3]).not.toHaveProperty("kills");
    expect(actions[4]).toMatchObject({ type: "Deploy", name: "后备主力", costs: 20 });
    expect(actions.some(action => action.cooling)).toBe(false);
    expect(maximumActive(actions)).toBeLessThanOrEqual(mapData.options.characterLimit);
    expect(validateMAAProtocol(built.script).valid).toBe(true);
  });

  it("rotates a non-frontline operator when a reserve arrives after the vanguard", () => {
    const mapData = makeMapData();
    mapData.options.characterLimit = 2;
    mapData.deploymentPoints = [
      { row: 2, col: 5, buildableType: "melee" },
      { row: 1, col: 3, buildableType: "ranged" },
      { row: 2, col: 3, buildableType: "melee" },
    ];
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
      picks: [
        testPick("前线", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("非前线", "RANGED", [[0, 0]], { respawnTime: 70 }),
        testPick("后备", "MELEE", [[0, 0]], { cost: 20 }),
      ],
      positionVariant: 0, timingVariant: 0, options: {},
    });

    expect(built.script.actions.map(action => [action.type, action.name])).toEqual([
      ["SpeedUp", undefined], ["Deploy", "前线"], ["Deploy", "非前线"],
      ["Retreat", "非前线"], ["Deploy", "后备"], ["SkillDaemon", undefined],
    ]);
    expect(built.script.actions[3]).toMatchObject({ costs: 20 });
    expect(built.script.actions.some(action => action.cooling)).toBe(false);
    expect(maximumActive(built.script.actions)).toBeLessThanOrEqual(mapData.options.characterLimit);
  });

  it("does not invent a cooldown-gated rescue at field capacity", () => {
    const mapData = makeMapData();
    mapData.options.characterLimit = 2;
    mapData.deploymentPoints = [
      { row: 2, col: 5, buildableType: "melee" },
      { row: 1, col: 4, buildableType: "ranged" },
      { row: 2, col: 3, buildableType: "melee" },
    ];
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
      picks: [
        testPick("前线", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("医疗", "RANGED", [[0, 1]], { role: "medic" }),
        testPick("救场主力", "MELEE", [[0, 0]], { cost: 20 }),
      ],
      positionVariant: 0, timingVariant: 0, options: {},
    });

    expect(built.script.actions.map(action => [action.type, action.name])).toEqual([
      ["SpeedUp", undefined], ["Deploy", "前线"], ["Deploy", "医疗"],
      ["SkillDaemon", undefined],
    ]);
    expect(built.script.actions.some(action => action.cooling)).toBe(false);
    expect(validateMAAProtocol(built.script).valid).toBe(true);
  });

  it("keeps permanent lane holders when no safe replacement exists", () => {
    const mapData = makeMapData();
    mapData.options.characterLimit = 2;
    mapData.deploymentPoints = [
      { row: 2, col: 2, buildableType: "melee" },
      { row: 2, col: 3, buildableType: "melee" },
      { row: 2, col: 5, buildableType: "melee" },
      { row: 1, col: 4, buildableType: "ranged" },
    ];
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
      picks: [
        testPick("先锋", "MELEE", [[0, 0]], { role: "vanguard", respawnTime: 70 }),
        testPick("前线", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
        testPick("医疗", "RANGED", [[0, 1]], { role: "medic" }),
        testPick("救场主力", "MELEE", [[0, 0]], { cost: 20 }),
      ],
      positionVariant: 0, timingVariant: 0, options: {},
    });

    expect(built.script.actions.map(action => action.type)).toEqual([
      "SpeedUp", "Deploy", "Deploy", "Retreat", "Deploy", "SkillDaemon",
    ]);
    expect(built.script.actions.filter(action => action.type === "Retreat")).toEqual([
      expect.objectContaining({ name: "先锋", costs: expect.any(Number) }),
    ]);
    expect(built.script.actions.some(action => action.cooling)).toBe(false);
    expect(validateMAAProtocol(built.script).valid).toBe(true);
  });

  it("retires and redeploys an executor using its actual timing", () => {
    const mapData = makeMapData();
    mapData.options.characterLimit = 1;
    mapData.deploymentPoints = [{ row: 2, col: 2, buildableType: "all" }];
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
      picks: [testPick("快活", "MELEE", [[0, 0]], {
        role: "specialist", subProfession: "executor", cost: 6, skillDuration: 20, respawnTime: 16,
      })],
      positionVariant: 0, timingVariant: 0, options: {},
    });
    const actions = built.script.actions;

    expect(actions.map(action => action.type)).toEqual(["SpeedUp", "Deploy", "Retreat", "Deploy", "SkillDaemon"]);
    expect(actions[2]).toMatchObject({ type: "Retreat", name: "快活", pre_delay: 10_000 });
    expect(actions[3]).toMatchObject({ type: "Deploy", name: "快活", pre_delay: 8_000, costs: 6 });
    expect(maximumActive(actions)).toBeLessThanOrEqual(mapData.options.characterLimit);
    expect(validateMAAProtocol(built.script).valid).toBe(true);
  });

  it("does not guess an executor redeploy time", () => {
    const mapData = makeMapData();
    mapData.options.characterLimit = 1;
    mapData.deploymentPoints = [{ row: 2, col: 2, buildableType: "all" }];
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
      picks: [testPick("未知冷却快活", "MELEE", [[0, 0]], {
        role: "specialist", subProfession: "executor", skillDuration: 20,
      })],
      positionVariant: 0, timingVariant: 0, options: {},
    });
    const actions = built.script.actions;

    expect(actions.find(action => action.type === "Retreat")).toMatchObject({ name: "未知冷却快活", pre_delay: 10_000 });
    expect(actions.filter(action => action.type === "Deploy")).toHaveLength(1);
    expect(validateMAAProtocol(built.script).valid).toBe(true);
  });

  it("keeps temporary operators off an available goal front", () => {
    const mapData = makeMapData();
    mapData.deploymentPoints = [
      { row: 2, col: 5, buildableType: "melee" },
      { row: 2, col: 2, buildableType: "melee" },
    ];
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
      picks: [testPick("先锋", "MELEE", [[0, 0]], { role: "vanguard" })],
      positionVariant: 0, timingVariant: 0, options: {},
    });

    expect(built.script.actions.find(action => action.type === "Deploy")?.location).toEqual([2, 2]);
  });

  it("generates a deterministic fixed protocol-safe script", () => {
    const options = { playerOperators: playerOperators(), search: { deadlineMs: 10_000 } };
    const first = generateCopilotScript("V2-1", makeMapData(), options);
    const second = generateCopilotScript("V2-1", makeMapData(), options);
    expect(first.scriptHash).toBe(second.scriptHash);
    expect(computeScriptHash({
      ...first.script,
      metadata: { ...first.script.metadata, generationId: "later", scriptHash: "different", candidateScore: 0 },
    })).toBe(first.scriptHash);
    expect(first.script.opers).toHaveLength(12);
    expect(first.script.groups).toEqual([]);
    expect(first.script.actions.some(action => action.type === "Wait" || action.type === "SkillUse")).toBe(false);
    expect(first.skillCoverage).toBeGreaterThan(0);
    expect(first.searchStats.fullyScoredCandidates).toBeGreaterThan(0);
    expect(validateMAAProtocol(first.script).valid).toBe(true);
  });

  it("changes capability demand for flying pressure", () => {
    const ground = makeMapData();
    const flying = makeMapData();
    flying.routes = flying.routes.map(route => ({ ...route, motionMode: "fly" }));
    const groundFacts = extractStageFacts(ground);
    const flyingFacts = extractStageFacts(flying);
    expect(buildEncounterContext(flying, flyingFacts).demand.antiAir)
      .toBeGreaterThan(buildEncounterContext(ground, groundFacts).demand.antiAir);
  });

  it("keeps pressure in its actual route window instead of only its spawn window", () => {
    const mapData = makeMapData();
    mapData.routes[0].checkpoints = [
      { row: 2, col: 2, type: "MOVE" },
      { row: 2, col: 2, type: "WAIT_FOR_SECONDS", waitSeconds: 20 },
    ];
    const facts = extractStageFacts(mapData);
    const encounter = buildEncounterContext(mapData, facts);

    expect(facts.temporalPressure.buckets.some(bucket => bucket.time === 15)).toBe(true);
    expect(facts.pressureWindows.find(window => window.start === 15)?.totalHp).toBeGreaterThan(0);
    expect(encounter.criticalWindows.some(window => window.start === 15)).toBe(true);
  });

  it("separates armor, resistance, boss, and multi-route demands", () => {
    const armored = makeMapData();
    armored.enemyDetails[0] = { ...armored.enemyDetails[0], def: 900, magicResistance: 0 };
    const resistant = makeMapData();
    resistant.enemyDetails[0] = { ...resistant.enemyDetails[0], def: 0, magicResistance: 90 };
    const boss = makeMapData();
    boss.enemyDetails[0] = { ...boss.enemyDetails[0], isBoss: true };
    const multiRoute = makeMapData();
    multiRoute.routes.push({
      id: 1, startPosition: { row: 4, col: 0 }, endPosition: { row: 4, col: 5 },
      checkpoints: [{ row: 4, col: 3 }], motionMode: "walk",
    });
    multiRoute.spawnTimeline.push({ enemyId: "enemy", routeIndex: 1, time: 0, count: 4 });

    const context = (mapData: MapData) => {
      const facts = extractStageFacts(mapData);
      return buildEncounterContext(mapData, facts);
    };
    expect(context(armored).demand.arts).toBeGreaterThan(context(armored).demand.physical);
    expect(context(resistant).demand.physical).toBeGreaterThan(context(resistant).demand.arts);
    expect(context(boss).demand.burst).toBeGreaterThan(context(makeMapData()).demand.burst);
    expect(context(multiRoute).demand.coverage).toBeGreaterThan(context(makeMapData()).demand.coverage);
  });

  it("builds deployment actions in marginal squad order", () => {
    const mapData = makeMapData();
    mapData.deploymentPoints = Array.from({ length: 12 }, (_, index) => ({
      row: 1 + Math.floor(index / 6), col: index % 6, buildableType: "all" as const,
    }));
    mapData.options.characterLimit = 9;
    const facts = extractStageFacts(mapData);
    const options = { playerOperators: playerOperators() };
    const picks = buildSquadBeam(facts, buildEncounterContext(mapData, facts), options).squads[0];
    const built = buildCandidate({
      stageCode: "V2-1", mapData, facts, openingPressure: false,
      picks, positionVariant: 0, timingVariant: 0, options,
    });
    const firstRetreat = built.script.actions.findIndex(action => action.type === "Retreat");
    const initialDeploys = built.script.actions.slice(0, firstRetreat < 0 ? undefined : firstRetreat)
      .filter(action => action.type === "Deploy").map(action => action.name);
    expect(initialDeploys).toEqual(picks.slice(0, initialDeploys.length).map(pick => pick.name));
  });

  it("returns a fully scored best-so-far candidate at the deadline", () => {
    let time = 0;
    const result = generateCopilotScript("V2-1", makeMapData(), {
      playerOperators: playerOperators(),
      now: () => time,
      feedbackAdjustment: () => { time = 1200; return 0; },
      search: { deadlineMs: 1200, deadlineCheckInterval: 8 },
    });
    expect(result.searchStats.terminationReason).toBe("deadline");
    expect(result.searchStats.fullyScoredCandidates).toBeGreaterThan(0);
    expect(result.script.metadata.candidateScore).toBeGreaterThanOrEqual(0);
  });

  it("enforces the deadline during squad construction before any candidate is produced", () => {
    let reads = 0;
    expect(() => generateCopilotScript("V2-1", makeMapData(), {
      playerOperators: playerOperators(),
      now: () => ++reads >= 4 ? 1200 : 0,
      search: { deadlineMs: 1200 },
    })).toThrow(/deadline exceeded during squad selection/);
  });

  it("retains a scored initial candidate when construction reaches its deadline", () => {
    clearSearchCaches();
    let time = 0;
    const original = Scoring.scoreCandidate;
    const scoring = jest.spyOn(Scoring, "scoreCandidate").mockImplementation((...args) => {
      const result = original(...args);
      time = 1200;
      return result;
    });
    try {
      const result = generateCopilotScript("V2-1", makeMapData(), {
        playerOperators: playerOperators(), now: () => time,
        search: { deadlineMs: 1200 },
      });
      expect(result.searchStats.terminationReason).toBe("deadline");
      expect(result.searchStats.cheapCompleteCandidates).toBe(1);
      expect(result.searchStats.fullyScoredCandidates).toBe(1);
      expect(validateMAAProtocol(result.script).valid).toBe(true);
    } finally {
      scoring.mockRestore();
    }
  });

  it("returns a legal scored candidate when widening a large roster exhausts the budget", () => {
    let time = 0;
    const widths: number[] = [];
    const original = CandidateBuilder.buildSquadBeam;
    const selection = jest.spyOn(CandidateBuilder, "buildSquadBeam").mockImplementation((facts, encounter, options, checkDeadline) => {
      widths.push(options.search!.squadBeamWidth!);
      if (options.search!.squadBeamWidth! > 4) { time = 1200; checkDeadline?.(); }
      return original(facts, encounter, options, checkDeadline);
    });
    try {
      const data = makeMapData();
      data.options.initialCost = 99;
      const result = generateCopilotScript("V2-1", data, { playerOperators: playerOperators(200), now: () => time });
      expect(widths).toEqual([4, 32]);
      expect(result.searchStats.terminationReason).toBe("deadline");
      expect(result.searchStats.fullyScoredCandidates).toBeGreaterThan(0);
      expect(validateMAAProtocol(result.script).valid).toBe(true);
    } finally {
      selection.mockRestore();
    }
  });

  it("still fails when widening times out without a legal initial candidate", () => {
    let time = 0;
    const original = CandidateBuilder.buildSquadBeam;
    const selection = jest.spyOn(CandidateBuilder, "buildSquadBeam").mockImplementation((facts, encounter, options, checkDeadline) => {
      if (options.search!.squadBeamWidth! > 4) { time = 1200; checkDeadline?.(); }
      return original(facts, encounter, options, checkDeadline);
    });
    try {
      const data = makeMapData();
      data.deploymentPoints = [];
      expect(() => generateCopilotScript("V2-1", data, {
        playerOperators: playerOperators(200), now: () => time,
      })).toThrow(/deadline exceeded.*route_missing_ground_coverage/);
    } finally {
      selection.mockRestore();
    }
  });

  it("keeps an explicitly small beam within its configured width", () => {
    const selection = jest.spyOn(CandidateBuilder, "buildSquadBeam");
    try {
      const result = generateCopilotScript("V2-1", makeMapData(), {
        playerOperators: playerOperators(), now: () => 0, search: { squadBeamWidth: 2 },
      });
      expect(selection.mock.calls.map(call => call[2].search?.squadBeamWidth)).toEqual([2]);
      expect(validateMAAProtocol(result.script).valid).toBe(true);
    } finally {
      selection.mockRestore();
    }
  });

  it("reports feasibility failures separately from protocol validation", () => {
    const data = makeMapData();
    data.deploymentPoints = [];
    expect(() => generateCopilotScript("V2-1", data, {
      playerOperators: playerOperators(3),
      search: { deadlineMs: 10_000 },
    })).toThrow(/no feasible candidate.*route_missing_ground_coverage/);
  });

  it("reports the public copilot prior in the runtime model version", () => {
    const result = generateCopilotScript("V2-1", makeMapData(), {
      playerOperators: playerOperators(),
      search: { deadlineMs: 10_000 },
    });
    expect(result.modelVersion).toContain("copilot-prior-v1-");
    expect(result.script.metadata.corpusModelVersion).toContain("copilot-prior-v1-");
  });

  it("keeps the new engine independent from the deleted battle package", () => {
    const engineDir = path.resolve(__dirname, "..", "src", "engine");
    const sources = fs.readdirSync(engineDir)
      .filter(file => file.endsWith(".ts"))
      .map(file => fs.readFileSync(path.join(engineDir, file), "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/from ["'][^"']*battle\//);
    expect(sources).not.toMatch(/OPERATOR_POOLS|operatorVariant|rolePlan/);
  });
});
