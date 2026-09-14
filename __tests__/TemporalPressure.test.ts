import { buildSpawnRouteTimeline } from "../src/engine/RouteTimeline";
import { buildTemporalPressure, cellsAt } from "../src/engine/TemporalPressure";
import type { MapData } from "../src/types";

function makeMapData(): MapData {
  return {
    stageId: "TIME-1", name: "TIME-1",
    tiles: Array.from({ length: 2 }, (_, row) => Array.from({ length: 5 }, (_, col) => ({
      row, col, key: "road", heightType: "lowland" as const, buildableType: "none" as const,
    }))),
    deploymentPoints: [], strategicPoints: [], highThreatAreas: [], waves: [], runes: [],
    routes: [{
      id: 0, motionMode: "walk", startPosition: { row: 0, col: 0 }, endPosition: { row: 0, col: 4 },
      checkpoints: [
        { row: 0, col: 2, type: "MOVE" },
        { row: 0, col: 2, type: "WAIT_FOR_SECONDS", waitSeconds: 2 },
      ],
    }],
    enemyDetails: [{ id: "enemy", name: "Enemy", maxHp: 5000, atk: 400, def: 0, magicResistance: 0, moveSpeed: 1, isBoss: false, isElite: false }],
    spawnTimeline: [{ time: 0, enemyId: "enemy", count: 1, routeIndex: 0 }],
    options: { characterLimit: 8, maxLifePoint: 3, initialCost: 10, maxCost: 99, costIncreaseTime: 1 },
  };
}

describe("temporal pressure", () => {
  it("discretizes movement and explicit checkpoint waits", () => {
    const mapData = makeMapData();
    const timeline = buildSpawnRouteTimeline(mapData.spawnTimeline[0], mapData.routes[0], mapData.enemyDetails[0]);
    expect(timeline.points.find(point => point.time === 2)).toMatchObject({ row: 0, col: 2 });
    expect(timeline.points.find(point => point.time === 4)).toMatchObject({ row: 0, col: 2 });
    expect(timeline.points.find(point => point.time === 5)).toMatchObject({ row: 0, col: 3 });
  });

  it("applies the level move multiplier in game seconds without scaling checkpoint waits", () => {
    const mapData = makeMapData();
    const timeline = buildSpawnRouteTimeline(mapData.spawnTimeline[0], mapData.routes[0], mapData.enemyDetails[0], { moveMultiplier: 0.5 });
    expect(timeline.points.find(point => point.time === 2)).toMatchObject({ row: 0, col: 1 });
    expect(timeline.points.find(point => point.time === 4)).toMatchObject({ row: 0, col: 2 });
    expect(timeline.points.find(point => point.time === 6)).toMatchObject({ row: 0, col: 2 });
    expect(timeline.points.at(-1)).toMatchObject({ row: 0, col: 4, time: 10 });

    mapData.options.moveMultiplier = 0.5;
    const pressure = buildTemporalPressure(mapData);
    expect(cellsAt(pressure, 2).has("0,1")).toBe(true);
    expect(cellsAt(pressure, 10).has("0,4")).toBe(true);
  });

  it("maps ground pressure, blue-box threat, merges, and flying pressure by time and cell", () => {
    const mapData = makeMapData();
    mapData.routes.push({
      id: 1, motionMode: "fly", startPosition: { row: 0, col: 0 }, endPosition: { row: 0, col: 4 },
      checkpoints: [{ row: 0, col: 2, type: "MOVE" }],
    });
    mapData.spawnTimeline.push({ time: 0, enemyId: "enemy", count: 1, routeIndex: 1 });
    const pressure = buildTemporalPressure(mapData);

    expect(cellsAt(pressure, 2).get("0,2")).toMatchObject({ groundHp: 5000, airHp: 5000, blockDemand: 1, mergeWeight: 1 });
    expect(cellsAt(pressure, 6).get("0,4")?.goalThreat).toBeGreaterThan(0);
    expect(pressure.criticalWindows).not.toHaveLength(0);
  });
});
