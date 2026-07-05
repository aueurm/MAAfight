import fs from "fs";
import os from "os";
import path from "path";
import { computeScriptHash, extractStageFacts, generateCopilotScript, isCandidateProtocolSafe, selectDiverseCheapCandidates } from "../src/engine";
import { buildCandidate, buildCandidatePerturbations, buildSquadBeam } from "../src/engine/CandidateBuilder";
import { getCombatOperatorByName, getCombatModelInfo, listCombatOperators, resolveOperatorProfile } from "../src/engine/CombatModel";
import { buildEncounterContext, computeStageContentHash } from "../src/engine/EncounterContext";
import { FeedbackStore, hashOperatorBox } from "../src/feedback/FeedbackStore";
import { validateMAAProtocol } from "../src/copilot/MAAProtocolValidator";
import { validateScript } from "../src/copilot/ScriptValidator";
import type { BattleScript, MapData, PlayerOperator } from "../src/types";
import type { SearchConfig } from "../src/engine/types";

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

const perturbationSearch: SearchConfig = {
  squadBeamWidth: 4,
  candidateFrontierLimit: 64,
  candidatePoolLimit: 24,
  positionVariantCount: 5,
  directionVariantCount: 4,
  timingVariantCount: 7,
  orderVariantCount: 5,
  skillVariantCount: 4,
  minimumFullCandidates: 8,
  defaultFullCandidates: 16,
  maximumFullCandidates: 32,
  deadlineMs: 10_000,
  deadlineCheckInterval: 8,
  diversityFirstDeployLimit: 64,
  diversityFirstThreeLimit: 4,
  diversityDeployCellsLimit: 64,
  diversityDirectionLimit: 256,
  diversityTimingLimit: 256,
  diversitySkillStrategyLimit: 512,
  diversitySquadLimit: 64,
  diversityReservedPerGroup: 2,
};

function diversityTestScript(firstDeployRow: number, variant: number): BattleScript {
  const names = ["Alpha", "Beta", "Gamma"];
  return {
    stage_name: "diversity-test",
    minimum_required: "v6.0.0",
    doc: { title: "diversity", details: "" },
    groups: [],
    opers: names.map(name => ({ name, skill: 1, skill_usage: 1 })),
    actions: [
      { type: "SpeedUp" },
      { type: "Deploy", name: "Alpha", location: [firstDeployRow, 1], direction: "Right", doc: `variant-${variant}` },
      { type: "Deploy", name: "Beta", location: [firstDeployRow, 2], direction: "Right" },
      { type: "Deploy", name: "Gamma", location: [firstDeployRow, 3], direction: "Right" },
      { type: "SkillDaemon" },
    ],
    generatedAt: "2026-01-01T00:00:00.000Z",
    metadata: { source: "test" },
    version: 3,
  };
}

function cheapDiversityCandidate(script: BattleScript, cheapScore: number) {
  return {
    script,
    scriptHash: computeScriptHash(script),
    squadSignature: "Alpha:1|Beta:1|Gamma:1",
    cheapScore,
    diversityGroups: ["perturbation" as const],
  };
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
  });

  it("extracts immutable stage facts and encounter pressure", () => {
    const mapData = makeMapData();
    const facts = extractStageFacts(mapData);
    const encounter = buildEncounterContext(mapData, facts);
    expect(facts.enemyCount).toBe(8);
    expect(encounter.windows[0].groups[0]).toMatchObject({ enemyId: "enemy", count: 8, def: 200, res: 10 });
    expect(encounter.hash).toMatch(/^[a-f0-9]{64}$/);
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

  it("generates a deterministic fixed protocol-safe script", () => {
    const mapData = makeMapData();
    const options = { playerOperators: playerOperators(), search: { deadlineMs: 10_000 } };
    const first = generateCopilotScript("V2-1", mapData, options);
    const second = generateCopilotScript("V2-1", mapData, options);
    expect(first.scriptHash).toBe(second.scriptHash);
    expect(first.script.opers).toHaveLength(12);
    expect(first.script.groups).toEqual([]);
    expect(first.script.actions.some(action => action.type === "Wait" || action.type === "SkillUse")).toBe(false);
    expect(first.skillCoverage).toBeGreaterThan(0);
    expect(first.searchStats.fullyScoredCandidates).toBeGreaterThanOrEqual(64);
    expect(validateScript(first.script, mapData).valid).toBe(true);
    expect(validateMAAProtocol(first.script).valid).toBe(true);
    expect(Object.keys(first.breakdown).sort()).toEqual([
      "direction",
      "feedbackPenalty",
      "operatorPower",
      "placement",
      "publicPrior",
      "timing",
    ]);
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
    expect(context(multiRoute).demand.laneHold).toBeGreaterThan(context(makeMapData()).demand.laneHold);
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
      stageCode: "V2-1", mapData, facts, picks, positionVariant: 0, timingVariant: 0, options,
    });
    const deployedNames = built.script.actions.filter(action => action.type === "Deploy").map(action => action.name);
    expect(deployedNames).toEqual(picks.slice(0, deployedNames.length).map(pick => pick.name));
  });

  it("builds neutral candidate perturbations without invalid scripts", () => {
    const mapData = makeMapData();
    mapData.options.characterLimit = 6;
    const facts = extractStageFacts(mapData);
    const options = { playerOperators: playerOperators(), search: perturbationSearch };
    const picks = buildSquadBeam(facts, buildEncounterContext(mapData, facts), options).squads[0];
    const perturbations = buildCandidatePerturbations("V2-1", facts, perturbationSearch);
    const scripts = perturbations.slice(0, 18).map(perturbation => buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts,
      picks,
      positionVariant: perturbation.positionVariant,
      directionVariant: perturbation.directionVariant,
      timingVariant: Math.round(perturbation.timingDelayMs / 250),
      timingDelayMs: perturbation.timingDelayMs,
      orderVariant: perturbation.orderVariant,
      skillVariant: perturbation.skillVariant,
      options,
    }).script);

    const hashes = new Set(scripts.map(computeScriptHash));
    const deployOrders = new Set(scripts.map(script => script.actions
      .filter(action => action.type === "Deploy")
      .map(action => action.name)
      .join("|")));
    const pointSets = new Set(scripts.map(script => script.actions
      .filter(action => action.type === "Deploy")
      .map(action => action.location?.join(","))
      .join("|")));
    const directions = new Set(scripts.flatMap(script => script.actions
      .filter(action => action.type === "Deploy")
      .map(action => action.direction)));
    const delays = new Set(scripts.flatMap(script => script.actions
      .filter(action => action.type === "Deploy")
      .map(action => action.pre_delay || 0)));

    expect(hashes.size).toBeGreaterThan(8);
    expect(deployOrders.size).toBeGreaterThan(1);
    expect(pointSets.size).toBeGreaterThan(1);
    expect(directions.size).toBeGreaterThan(1);
    expect([...delays]).toEqual(expect.arrayContaining([0, 250, 500]));
    expect(scripts.some(script => !script.actions.some(action => action.type === "SkillDaemon"))).toBe(true);
    expect(scripts.some(script => script.actions.some(action => action.type === "Skill"))).toBe(true);
    for (const script of scripts) {
      expect(script.actions.some(action => action.type === "SkillUse" || action.type === "Wait")).toBe(false);
      expect(validateScript(script, mapData).valid).toBe(true);
      expect(validateMAAProtocol(script).valid).toBe(true);
    }
  });

  it("limits near-duplicate cheap candidates before full scoring", () => {
    const nearDuplicates = Array.from({ length: 12 }, (_, index) =>
      cheapDiversityCandidate(diversityTestScript(1, index), 100 - index));
    const differentFirstDeploys = Array.from({ length: 6 }, (_, index) =>
      cheapDiversityCandidate(diversityTestScript(2 + index, 100 + index), 80 - index));

    const selected = selectDiverseCheapCandidates([...nearDuplicates, ...differentFirstDeploys], 8, {
      ...perturbationSearch,
      diversityFirstDeployLimit: 2,
      diversityFirstThreeLimit: 2,
      diversityDeployCellsLimit: 2,
      diversityDirectionLimit: 20,
      diversityTimingLimit: 20,
      diversitySkillStrategyLimit: 20,
      diversitySquadLimit: 20,
      diversityReservedPerGroup: 0,
    });
    const firstDeployCells = selected.map(candidate =>
      candidate.script.actions.find(action => action.type === "Deploy")?.location?.join(","));

    expect(selected).toHaveLength(8);
    expect(firstDeployCells.filter(cell => cell === "1,1")).toHaveLength(2);
    expect(firstDeployCells).toEqual(expect.arrayContaining(["2,1", "3,1", "4,1", "5,1", "6,1", "7,1"]));
    expect(selected.map(candidate => candidate.cheapScore)).toEqual([100, 99, 80, 79, 78, 77, 76, 75]);
  });

  it("filters invalid candidate coordinates and directions before scoring", () => {
    const mapData = makeMapData();
    const facts = extractStageFacts(mapData);
    const options = { playerOperators: playerOperators(), search: perturbationSearch };
    const picks = buildSquadBeam(facts, buildEncounterContext(mapData, facts), options).squads[0];
    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts,
      picks,
      positionVariant: 0,
      timingVariant: 0,
      options,
    });
    const withBadCoordinate = JSON.parse(JSON.stringify(built.script)) as BattleScript;
    const withBadDirection = JSON.parse(JSON.stringify(built.script)) as BattleScript;
    withBadCoordinate.actions.find(action => action.type === "Deploy")!.location = [99, 99];
    withBadDirection.actions.find(action => action.type === "Deploy")!.direction = "Diagonal";

    expect(isCandidateProtocolSafe(built.script, mapData, built.picks, "V2-1")).toBe(true);
    expect(isCandidateProtocolSafe(withBadCoordinate, mapData, built.picks, "V2-1")).toBe(false);
    expect(isCandidateProtocolSafe(withBadDirection, mapData, built.picks, "V2-1")).toBe(false);
  });

  it("throws a clear error when validation rejects every generated candidate", () => {
    const mapData = makeMapData();
    mapData.deploymentPoints = [];
    mapData.tiles = mapData.tiles.map(row => row.map(tile => ({ ...tile, buildableType: "none" as const })));

    expect(() => generateCopilotScript("V2-1", mapData, {
      playerOperators: playerOperators(),
      search: { ...perturbationSearch, candidatePoolLimit: 8, candidateFrontierLimit: 8 },
    })).toThrow(/no protocol-valid candidate before scoring/);
  });

  it("feeds failed feedback into the next generation avoidance path", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-engine-feedback-"));
    try {
      const mapData = makeMapData();
      const players = playerOperators();
      const operatorBoxHash = hashOperatorBox(players);
      const stageContentHash = computeStageContentHash(mapData);
      const store = new FeedbackStore(stateDir);
      const first = generateCopilotScript("V2-1", mapData, {
        playerOperators: players,
        search: { ...perturbationSearch, candidatePoolLimit: 24, candidateFrontierLimit: 24 },
      });
      store.appendGeneration({
        schemaVersion: 2,
        generationId: "generation-failed",
        scriptHash: first.scriptHash,
        stageId: mapData.stageId,
        stageName: "V2-1",
        operatorBoxHash,
        engineVersion: "v2-skill-v1",
        modelVersion: first.modelVersion,
        combatDataVersion: first.combatModelVersion,
        candidateScore: first.score,
        scoreBreakdown: { ...first.breakdown },
        combatCoverage: first.combatCoverage,
        skillCoverage: first.skillCoverage,
        stageContentHash,
        gameDataCommit: first.gameDataCommit,
        enemyTotal: first.facts.enemyCount,
        outputPath: "",
        script: first.script,
        createdAt: "2026-07-04T00:00:00.000Z",
      });
      store.recordFeedback({ scriptHash: first.scriptHash, killed: 1, total: first.facts.enemyCount, currentOperatorBoxHash: operatorBoxHash });

      const next = generateCopilotScript("V2-1", mapData, {
        playerOperators: players,
        excludedHashes: store.excludedHashes(mapData.stageId, operatorBoxHash, stageContentHash, "v2-skill-v1"),
        feedbackPenalty: (candidateScript, hash, breakdown) => store.feedbackPenalty(
          mapData.stageId, operatorBoxHash, { ...breakdown }, stageContentHash, candidateScript, "v2-skill-v1", hash
        ),
        search: { ...perturbationSearch, candidatePoolLimit: 24, candidateFrontierLimit: 24 },
      });

      expect(next.scriptHash).not.toBe(first.scriptHash);
      expect(validateMAAProtocol(next.script).valid).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("caps perturbed candidates while still returning one best result", () => {
    const result = generateCopilotScript("V2-1", makeMapData(), {
      playerOperators: playerOperators(),
      search: {
        ...perturbationSearch,
        candidatePoolLimit: 20,
        candidateFrontierLimit: 20,
        minimumFullCandidates: 4,
        defaultFullCandidates: 8,
        maximumFullCandidates: 12,
      },
    });

    expect(result.searchStats.cheapCompleteCandidates).toBeLessThanOrEqual(20);
    expect(result.scriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validateMAAProtocol(result.script).valid).toBe(true);
  });

  it("keeps legacy search limit aliases compatible", () => {
    const result = generateCopilotScript("V2-1", makeMapData(), {
      playerOperators: playerOperators(),
      search: {
        ...perturbationSearch,
        candidatePoolLimit: 99,
        candidateFrontierLimit: 99,
        candidateVariantLimit: 18,
        completeCandidateLimit: 18,
        minimumFullCandidates: 4,
        defaultFullCandidates: 8,
        maximumFullCandidates: 12,
      },
    });

    expect(result.searchStats.cheapCompleteCandidates).toBeLessThanOrEqual(18);
    expect(validateMAAProtocol(result.script).valid).toBe(true);
  });

  it("returns a fully scored best-so-far candidate at the deadline", () => {
    let time = 0;
    const result = generateCopilotScript("V2-1", makeMapData(), {
      playerOperators: playerOperators(),
      now: () => { time += 300; return time; },
      search: { deadlineMs: 1200, deadlineCheckInterval: 8 },
    });
    expect(result.searchStats.terminationReason).toBe("deadline");
    expect(result.searchStats.fullyScoredCandidates).toBeGreaterThan(0);
    expect(result.script.metadata.candidateScore).toBeGreaterThanOrEqual(0);
  });

  it("reports the public copilot prior in the runtime model version", () => {
    const result = generateCopilotScript("V2-1", makeMapData(), {
      playerOperators: playerOperators(),
      search: { deadlineMs: 10_000 },
    });
    expect(result.modelVersion).toContain("copilot-prior-v1-");
    expect(result.script.metadata.corpusModelVersion).toContain("copilot-prior-v1-");
  });

  it("generates a legal script when the exact stage has no public prior", () => {
    const result = generateCopilotScript("NO-PUBLIC-PRIOR-STAGE", makeMapData(), {
      playerOperators: playerOperators(),
      search: { deadlineMs: 10_000 },
    });

    expect(validateMAAProtocol(result.script).valid).toBe(true);
    expect(result.script.actions.some(action => action.type === "Deploy")).toBe(true);
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
