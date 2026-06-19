import type { MapData } from "../types";
import type { PressureWindow, StageFacts } from "./types";

function uniquePoints(points: Array<{ row: number; col: number }>): Array<{ row: number; col: number }> {
  const seen = new Set<string>();
  return points.filter(point => {
    const key = `${point.row},${point.col}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractStageFacts(mapData: MapData): StageFacts {
  const enemies = new Map(mapData.enemyDetails.map(enemy => [enemy.id, enemy]));
  const routes = new Map(mapData.routes.map(route => [route.id, route]));
  const windows = new Map<number, PressureWindow>();

  let enemyCount = 0;
  let totalHp = 0;
  let totalAttack = 0;
  let weightedDefense = 0;
  let weightedResistance = 0;
  let eliteCount = 0;
  let bossCount = 0;

  for (const spawn of mapData.spawnTimeline) {
    const enemy = enemies.get(spawn.enemyId);
    const count = Math.max(0, spawn.count || 0);
    const hp = Math.max(1, enemy?.maxHp || 1);
    const attack = Math.max(0, enemy?.atk || 0);
    enemyCount += count;
    totalHp += hp * count;
    totalAttack += attack * count;
    weightedDefense += Math.max(0, enemy?.def || 0) * count;
    weightedResistance += Math.max(0, enemy?.magicResistance || 0) * count;
    if (enemy?.isElite) eliteCount += count;
    if (enemy?.isBoss) bossCount += count;

    const start = Math.floor(Math.max(0, spawn.time) / 15) * 15;
    const window = windows.get(start) || {
      start,
      end: start + 15,
      enemyCount: 0,
      totalHp: 0,
      totalAttack: 0,
      flyingCount: 0,
      eliteCount: 0,
      bossCount: 0,
    };
    window.enemyCount += count;
    window.totalHp += hp * count;
    window.totalAttack += attack * count;
    if (routes.get(spawn.routeIndex)?.motionMode === "fly") window.flyingCount += count;
    if (enemy?.isElite) window.eliteCount += count;
    if (enemy?.isBoss) window.bossCount += count;
    windows.set(start, window);
  }

  const routeCells = uniquePoints(mapData.routes.flatMap(route => [
    route.startPosition,
    ...(route.checkpoints || []),
    route.endPosition,
  ]));
  const goalCells = uniquePoints(mapData.routes.map(route => route.endPosition));
  const chokeCells = uniquePoints(mapData.strategicPoints
    .filter(point => point.type === "chokepoint")
    .map(point => ({ row: point.row, col: point.col })));
  const starts = new Set(mapData.routes.map(route => `${route.startPosition.row},${route.startPosition.col}`));
  const pressure = totalHp / Math.max(1, windows.size);
  const difficulty = bossCount > 0 || pressure >= 150000
    ? "extreme"
    : pressure >= 60000
      ? "hard"
      : pressure >= 20000
        ? "medium"
        : "easy";

  return {
    stageId: mapData.stageId,
    rows: mapData.tiles.length,
    cols: mapData.tiles[0]?.length || 0,
    enemyCount,
    totalHp,
    totalAttack,
    averageDefense: enemyCount ? weightedDefense / enemyCount : 0,
    averageResistance: enemyCount ? weightedResistance / enemyCount : 0,
    eliteCount,
    bossCount,
    flyingRouteCount: mapData.routes.filter(route => route.motionMode === "fly").length,
    groundRouteCount: mapData.routes.filter(route => route.motionMode === "walk").length,
    laneCount: starts.size,
    routeCells,
    goalCells,
    chokeCells,
    deploymentPoints: [...mapData.deploymentPoints],
    initialCost: mapData.options.initialCost,
    characterLimit: mapData.options.characterLimit,
    pressureWindows: [...windows.values()].sort((a, b) => a.start - b.start),
    difficulty,
    summary: `${enemyCount} enemies, ${starts.size} lanes, ${difficulty} pressure`,
  };
}
