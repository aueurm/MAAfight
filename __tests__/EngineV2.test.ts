import fs from "fs";
import path from "path";
import { extractStageFacts, generateCopilotScript } from "../src/engine";
import { buildCandidate, selectSquad } from "../src/engine/CandidateBuilder";
import { validateMAAProtocol } from "../src/copilot/MAAProtocolValidator";
import { OPERATOR_POOLS } from "../src/shared/operatorDB";
import type { MapData, PlayerOperator } from "../src/types";

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

function playerOperators(): Map<string, PlayerOperator> {
  const names = [...new Set(Object.values(OPERATOR_POOLS).flat().map(operator => operator.name))];
  return new Map(names.map((name, index) => [name, {
    id: `operator-${index}`,
    name,
    rarity: 6,
    own: true,
    elite: name === "伊内丝" || name === "闪灵" ? 1 : 2,
    level: 60,
    potential: 1,
  }]));
}

describe("v2 engine", () => {
  it("extracts immutable stage facts without a legacy tactical analysis", () => {
    const facts = extractStageFacts(makeMapData());
    expect(facts.enemyCount).toBe(8);
    expect(facts.totalHp).toBe(40000);
    expect(facts.laneCount).toBe(1);
    expect(facts.pressureWindows).toHaveLength(1);
  });

  it("generates a deterministic fixed script directly from map data", () => {
    const first = generateCopilotScript("V2-1", makeMapData());
    const second = generateCopilotScript("V2-1", makeMapData());

    expect(first.scriptHash).toBe(second.scriptHash);
    expect(first.script.opers).toHaveLength(12);
    expect(first.script.groups).toEqual([]);
    expect(first.script.actions.some(action => action.type === "Deploy")).toBe(true);
    expect(first.script.actions.some(action => action.type === "Wait" || action.type === "SkillUse")).toBe(false);
    expect(Object.keys(first.breakdown).sort()).toEqual([
      "automation", "combat", "corpus", "position", "tasks", "timing",
    ]);
    expect(validateMAAProtocol(first.script).valid).toBe(true);
  });

  it("uses only elite 2 operators from a supplied player library", () => {
    const players = playerOperators();
    const result = generateCopilotScript("V2-1", makeMapData(), { playerOperators: players });

    expect(result.script.opers).toHaveLength(12);
    expect(result.script.opers.every(operator => players.get(operator.name)!.elite >= 2)).toBe(true);
    expect(result.script.opers.every(operator => operator.requirements === undefined)).toBe(true);
  });

  it("does not change squad slots for a flying-route opening", () => {
    const groundMap = makeMapData();
    const flyingMap = makeMapData();
    flyingMap.routes = flyingMap.routes.map(route => ({ ...route, motionMode: "fly" }));
    const options = { playerOperators: playerOperators() };
    const baseInput = {
      stageCode: "V2-1",
      operatorVariant: 0,
      positionVariant: 0,
      timingVariant: 0,
      options,
    };
    const ground = selectSquad({ ...baseInput, mapData: groundMap, facts: extractStageFacts(groundMap) });
    const flying = selectSquad({ ...baseInput, mapData: flyingMap, facts: extractStageFacts(flyingMap) });

    expect(flying.picks.map(pick => pick.role)).toEqual(ground.picks.map(pick => pick.role));
  });

  it("does not reorder deployment actions by a fixed role opening", () => {
    const mapData = makeMapData();
    mapData.deploymentPoints = Array.from({ length: 12 }, (_, index) => ({
      row: 1 + Math.floor(index / 6),
      col: index % 6,
      buildableType: "all" as const,
    }));
    mapData.options.characterLimit = 9;
    const facts = extractStageFacts(mapData);
    const built = buildCandidate({
      stageCode: "V2-1",
      mapData,
      facts,
      operatorVariant: 0,
      positionVariant: 0,
      timingVariant: 0,
      options: { playerOperators: playerOperators() },
    });
    const deployedNames = built.script.actions
      .filter(action => action.type === "Deploy")
      .map(action => action.name);

    expect(deployedNames).toEqual(built.picks.slice(0, deployedNames.length).map(pick => pick.name));
  });

  it("keeps the new engine independent from the deleted battle package", () => {
    const engineDir = path.resolve(__dirname, "..", "src", "engine");
    const sources = fs.readdirSync(engineDir)
      .filter(file => file.endsWith(".ts"))
      .map(file => fs.readFileSync(path.join(engineDir, file), "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/from ["'][^"']*battle\//);
    const legacyDir = path.resolve(__dirname, "..", "src", "battle");
    const legacySources = fs.existsSync(legacyDir)
      ? fs.readdirSync(legacyDir).filter(file => file.endsWith(".ts"))
      : [];
    expect(legacySources).toEqual([]);
  });
});
