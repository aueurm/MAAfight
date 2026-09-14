import { buildCandidate } from "../src/engine/CandidateBuilder";
import { extractDefenseFronts, orderDefenseDeployments, planDefenseOpening } from "../src/engine/DefensePlanner";
import { buildEncounterContext } from "../src/engine/EncounterContext";
import { buildJointPlan } from "../src/engine/JointPlanner";
import { extractStageFacts } from "../src/engine/StageFacts";
import type { EnginePick } from "../src/engine/types";
import type { MapData } from "../src/types";

function mapData(): MapData {
  const goal = { row: 3, col: 7 };
  return {
    stageId: "branching-terminal", name: "Branching terminal",
    tiles: Array.from({ length: 7 }, (_, row) => Array.from({ length: 8 }, (_, col) => ({
      row, col, key: row === 3 && col === 7 ? "end" : "road", heightType: "lowland", buildableType: "all",
    }))),
    deploymentPoints: [
      { row: 3, col: 6, buildableType: "melee" }, { row: 2, col: 7, buildableType: "melee" },
      { row: 4, col: 7, buildableType: "melee" }, { row: 2, col: 6, buildableType: "all" },
    ], strategicPoints: [], highThreatAreas: [], waves: [],
    routes: [
      { id: 0, motionMode: "walk", startPosition: { row: 3, col: 0 }, checkpoints: [], endPosition: goal },
      { id: 1, motionMode: "walk", startPosition: { row: 0, col: 0 }, checkpoints: [{ row: 0, col: 7 }], endPosition: goal },
      { id: 2, motionMode: "walk", startPosition: { row: 6, col: 0 }, checkpoints: [{ row: 6, col: 7 }], endPosition: goal },
    ],
    enemyDetails: [{ id: "enemy", name: "enemy", maxHp: 1000, atk: 100, def: 0, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false }],
    spawnTimeline: [
      { time: 1, enemyId: "enemy", count: 1, routeIndex: 0 },
      { time: 20, enemyId: "enemy", count: 20, routeIndex: 1 },
      { time: 40, enemyId: "enemy", count: 1, routeIndex: 2 },
    ],
    options: { initialCost: 10, maxCost: 99, costIncreaseTime: 1, characterLimit: 4, maxLifePoint: 3 },
  };
}

function pick(name: string, cost: number, block = 1): EnginePick {
  return { operatorId: name, name, role: "guard", skill: 1, skillRank: 7,
    profile: { operatorId: name, name, role: "guard", subProfession: null, position: "MELEE", damageType: "physical",
      skill: 1, skillRank: 7, skillDuration: 0, respawnTime: 0, baseRangeId: null, skillRangeId: null, range: [[0, 0]],
      attributes: { hp: 1000, atk: 100, def: 100, res: 0, cost, block, attackInterval: 1, attackSpeed: 100 },
      metrics: { normalDps: 100, burstDps: 100, cycleDps: 100, healingHps: 0, physicalEhp: 1000, artsEhp: 1000, controlSeconds: 0 },
      maxTargets: 1, confidence: "exact", modelCoverageGaps: [] } };
}

describe("terminal route defense and opening deadlines", () => {
  it("keeps three actual approaches to one blue box, excluding the nearby off-route tile", () => {
    const facts = extractDefenseFronts(mapData());
    expect(facts.fronts.map(front => [front.point.row, front.point.col])).toEqual([[3, 6], [2, 7], [4, 7]]);
    expect(facts.fronts.map(front => front.firstArrival)).toEqual([7, 29, 49]);
    expect(facts.fronts.map(front => front.direction)).toEqual(["Left", "Up", "Down"]);
  });

  it("deduplicates shared terminal cells and ignores unused and flying routes", () => {
    const data = mapData();
    data.routes[1] = { ...data.routes[0], id: 1, startPosition: { row: 2, col: 0 }, checkpoints: [{ row: 3, col: 0 }] };
    data.spawnTimeline = data.spawnTimeline.slice(0, 2);
    data.routes.push({ ...data.routes[0], id: 3, motionMode: "fly" });
    data.spawnTimeline.push({ time: 0, enemyId: "enemy", count: 1, routeIndex: 3 });
    expect(extractDefenseFronts(data).fronts).toHaveLength(1);
    expect(extractDefenseFronts(data).fronts[0].routeIds).toEqual([0, 1]);
  });

  it("uses movement multipliers and route waits when finding first contact", () => {
    const data = mapData();
    data.routes = [data.routes[0]];
    data.routes[0].checkpoints = [{ row: 3, col: 0, type: "WAIT_FOR_SECONDS", waitSeconds: 5 }];
    data.options.moveMultiplier = 2;
    expect(extractDefenseFronts(data).fronts[0].firstArrival).toBe(9);
  });

  it("merges dominated terminal points at a shared upstream tile and recalculates its earliest arrival", () => {
    const data = mapData();
    data.tiles[4][5].key = "end";
    data.deploymentPoints = [{ row: 3, col: 5, buildableType: "melee" }, { row: 3, col: 6, buildableType: "melee" }];
    data.routes = [data.routes[0], { ...data.routes[0], id: 1, checkpoints: [{ row: 3, col: 5 }], endPosition: { row: 4, col: 5 } }];
    data.spawnTimeline = [data.spawnTimeline[0], { time: 100, enemyId: "enemy", count: 1, routeIndex: 1 }];
    const fronts = extractDefenseFronts(data).fronts;
    expect(fronts).toHaveLength(1);
    expect(fronts[0]).toMatchObject({ point: { row: 3, col: 5 }, routeIds: [0, 1], firstArrival: 6 });
  });

  it("assigns a cheaper blocker when an expensive first pick would miss the opening", () => {
    const data = mapData();
    const plan = planDefenseOpening(data, [pick("costly", 23), pick("cheap", 10), pick("third", 10), pick("zero-block", 0, 0)], 4);
    expect(plan.assignments[0].pick.name).toBe("cheap");
    expect(plan.assignments[0].readyTime).toBe(3);
    expect(plan.assignments.map(item => item.pick.name)).not.toContain("zero-block");
    expect(plan.coverageGaps).not.toContain("defense_opening_deadline_missed");
  });

  it("preserves a downstream front when another route only passes its upstream point while invisible", () => {
    const data = mapData();
    data.tiles[3][7].key = "road";
    data.tiles[0][3].key = "end";
    data.deploymentPoints = [{ row: 1, col: 1, buildableType: "melee" }, { row: 1, col: 3, buildableType: "melee" }];
    const startPosition = { row: 1, col: 0 };
    const endPosition = { row: 0, col: 3 };
    data.routes = [
      { id: 0, motionMode: "walk", startPosition, endPosition, checkpoints: [{ row: 1, col: 1 }] },
      { id: 1, motionMode: "walk", startPosition, endPosition, checkpoints: [
        { row: 1, col: 0, type: "DISAPPEAR" }, { row: 1, col: 2, type: "APPEAR_AT_POS" },
        { row: 1, col: 3, type: "MOVE" },
      ] },
    ];
    data.spawnTimeline = [data.spawnTimeline[0], { time: 2, enemyId: "enemy", count: 1, routeIndex: 1 }];
    const facts = extractDefenseFronts(data);
    expect(facts.fronts.map(front => ({ cell: [front.point.row, front.point.col], routes: front.routeIds }))).toEqual([
      { cell: [1, 1], routes: [0] }, { cell: [1, 3], routes: [1] },
    ]);
    expect(facts.coverageGaps).toContain("route_visibility_unknown");
  });

  it.each(["self_hp_drain_unmodeled", "self_removal_unmodeled"])(
    "keeps a burst skill with %s out of primary defense without deleting it from the squad", gap => {
    const data = mapData();
    data.routes = [data.routes[0]];
    data.spawnTimeline = [data.spawnTimeline[0]];
    const burst = pick("self-draining-burst", 1);
    burst.profile.modelCoverageGaps.push(gap);
    const picks = [burst, pick("sustained", 10)];
    expect(planDefenseOpening(data, picks, 1).assignments.map(item => item.pick.name)).toEqual(["sustained"]);
    expect(picks).toContain(burst);
    const alone = planDefenseOpening(data, [burst], 1);
    expect(alone.assignments).toHaveLength(0);
    expect(alone.coverageGaps).toContain("defense_blocker_missing");
  });

  it("builds every primary front within the starting DP cap before queuing a higher-cost deployment", () => {
    const data = mapData();
    data.options.initialCostCap = 20;
    data.spawnTimeline.forEach(spawn => { spawn.time += 100; });
    const expensive = pick("later-expensive", 22);
    const blockers = [pick("first", 10), pick("second", 15), pick("third", 20)];
    const plan = planDefenseOpening(data, [expensive, ...blockers], 4);
    expect(plan.assignments.map(item => item.pick.name)).toEqual(blockers.map(item => item.name));
    expect(plan.coverageGaps).toContain("dynamic_cost_cap_unlock_unmodeled");
    expect(orderDefenseDeployments(data, [expensive, ...blockers], plan.assignments).map(item => item.name))
      .toEqual([...blockers.map(item => item.name), expensive.name]);
    expect(data.options.maxCost).toBe(99);
    const missing = planDefenseOpening(data, [expensive], 4);
    expect(missing.assignments).toHaveLength(0);
    expect(missing.coverageGaps).toContain("defense_blocker_missing");
  });

  it("reports an unresolved cap rune instead of assuming its dynamic starting state", () => {
    const data = mapData();
    data.runes = [{ key: "cbuff_max_cost", difficultyMask: "FOUR_STAR" }];
    expect(planDefenseOpening(data, [pick("blocker", 10)], 1).coverageGaps).toContain("initial_cost_cap_unresolved");
  });

  it("preempts an unrelated expensive deployment but preserves an affordable support opening", () => {
    const data = mapData();
    const blockers = [pick("first", 10), pick("second", 10), pick("third", 10)];
    const plan = planDefenseOpening(data, blockers, 4);
    const costlySupport = pick("support", 40, 0);
    expect(orderDefenseDeployments(data, [costlySupport, ...blockers], plan.assignments)[0].name).toBe("first");
    const cheapSupport = pick("support", 1, 0);
    expect(orderDefenseDeployments(data, [cheapSupport, ...blockers], plan.assignments)[0].name).toBe("support");
  });

  it("does not assign a skill-time zero-block standard bearer as the sole sustained defense", () => {
    const data = mapData();
    data.routes = [data.routes[0]];
    data.spawnTimeline = [data.spawnTimeline[0]];
    const bearer = pick("standard-bearer", 3, 1);
    bearer.role = "vanguard";
    bearer.profile.subProfession = "bearer";
    bearer.profile.skillType = "MANUAL";
    bearer.profile.skillDuration = 8;
    const alone = planDefenseOpening(data, [bearer], 1);
    expect(alone.assignments).toEqual([]);
    expect(alone.coverageGaps).toContain("defense_blocker_missing");
    const supported = planDefenseOpening(data, [bearer, pick("sustained-blocker", 10)], 1);
    expect(supported.assignments.map(item => item.pick.name)).toEqual(["sustained-blocker"]);
    expect(supported.coverageGaps).not.toContain("defense_blocker_missing");
  });

  it("reserves enough DP for the next approach instead of satisfying only the first deadline", () => {
    const data = mapData();
    data.options.initialCost = 20;
    data.routes = [data.routes[0], { ...data.routes[1], startPosition: { row: 0, col: 7 } }];
    data.spawnTimeline = [data.spawnTimeline[0], { time: 6, enemyId: "enemy", count: 1, routeIndex: 1 }];
    const first = pick("vanguard-a", 10); first.role = "vanguard";
    const second = pick("vanguard-b", 10); second.role = "vanguard";
    const plan = planDefenseOpening(data, [pick("expensive-tank", 20), first, second], 2);
    expect(plan.assignments.map(item => item.pick.name)).toEqual(["vanguard-a", "vanguard-b"]);
    expect(plan.coverageGaps).not.toContain("defense_opening_deadline_missed");
  });

  it("emits explicit capacity, roster and arrival gaps without inventing a blocker", () => {
    const data = mapData();
    expect(planDefenseOpening(data, [pick("only", 99)], 2).coverageGaps).toEqual(expect.arrayContaining([
      "defense_fronts_exceed_deployment_limit", "defense_blocker_missing", "defense_opening_deadline_missed",
    ]));
    const noGround = mapData();
    noGround.deploymentPoints = [];
    expect(extractDefenseFronts(noGround).coverageGaps).toContain("ground_route_without_legal_interception");
    const air = mapData();
    air.routes.forEach(route => { route.motionMode = "fly"; });
    expect(planDefenseOpening(air, [], 0)).toEqual({ assignments: [], coverageGaps: [] });
  });

  it("keeps the earliest front despite a stronger later route in joint candidate truncation", () => {
    const data = mapData();
    const facts = extractStageFacts(data);
    const plan = buildJointPlan(data, facts, buildEncounterContext(data, facts), { picks: [pick("front", 10)], placementsPerPick: 1 });
    expect(plan.decisions[0].location).toEqual([3, 6]);
  });

  it("compiles deadline order and real terminal tiles without an artificial deployment delay", () => {
    const data = mapData();
    const built = buildCandidate({ stageCode: "SYNTHETIC", mapData: data, facts: extractStageFacts(data), openingPressure: false,
      picks: [pick("costly", 23), pick("cheap", 10), pick("third", 10)], positionVariant: 0, timingVariant: 5, options: {} });
    const deploys = built.script.actions.filter(action => action.type === "Deploy");
    expect(deploys[0]).toMatchObject({ name: "cheap", location: [3, 6], direction: "Left", pre_delay: 0 });
    expect(deploys.map(action => action.location)).toEqual([[3, 6], [2, 7], [4, 7]]);
    expect(built.script.metadata.defensePlan?.fronts[0].readyTime).toBe(3);
  });

  it.each([
    { limit: 3, expected: ["first", "second", "third"] },
    { limit: 4, expected: ["first", "healer", "second", "third"] },
  ])("reserves deployment slots for all assigned fronts at capacity $limit", ({ limit, expected }) => {
    const data = mapData();
    data.options.characterLimit = limit;
    data.options.initialCost = 99;
    data.spawnTimeline.forEach(spawn => { spawn.time += 100; });
    const healer = pick("healer", 10, 0);
    healer.role = healer.profile.role = "medic";
    healer.profile.position = "RANGED";
    healer.profile.damageType = "heal";
    healer.profile.metrics.normalHps = healer.profile.metrics.healingHps = 100;
    healer.profile.range = [[0, 0], [0, 1], [1, 0]];
    const built = buildCandidate({ stageCode: "SYNTHETIC", mapData: data, facts: extractStageFacts(data), openingPressure: false,
      picks: [pick("first", 10), pick("second", 10), pick("third", 10), healer],
      positionVariant: 0, timingVariant: 0, options: {} });
    expect(built.script.actions.filter(action => action.type === "Deploy").map(action => action.name)).toEqual(expected);
    expect(built.script.metadata.defensePlan?.fronts).toHaveLength(3);
    for (const front of built.script.metadata.defensePlan!.fronts) {
      expect(front.readyTime).not.toBeNull();
      expect(front.readyTime!).toBeLessThanOrEqual(front.firstArrival!);
    }
    expect(built.coverageGaps).not.toContain("defense_opening_deadline_missed");
  });
});
