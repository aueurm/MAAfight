import type { EnemyDetail, MapData } from "../types";
import { buildSpawnRouteTimeline } from "./RouteTimeline";
import type { CriticalPressureWindow, TemporalCellPressure, TemporalPressure } from "./types";

export interface TemporalPressureOptions {
  bucketSeconds?: number;
}

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function bucketTime(time: number, bucketSeconds: number): number {
  return Number((Math.floor(Math.max(0, time) / bucketSeconds) * bucketSeconds).toFixed(6));
}

function emptyCell(row: number, col: number): TemporalCellPressure {
  return {
    row, col, groundHp: 0, airHp: 0, groundCount: 0, airCount: 0, incomingAttack: 0, blockDemand: 0,
    eliteWeight: 0, bossWeight: 0, goalThreat: 0, mergeWeight: 0,
    routeIds: [], enemyIds: [], mechanisms: [], coverageGaps: [],
  };
}

function addUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function distanceToGoal(row: number, col: number, route: MapData["routes"][number]): number {
  return Math.abs(row - route.endPosition.row) + Math.abs(col - route.endPosition.col);
}

function addEnemy(
  cell: TemporalCellPressure,
  enemy: EnemyDetail,
  route: MapData["routes"][number],
  coverageGaps: string[]
): void {
  const hp = Math.max(1, enemy.maxHp);
  const attack = Math.max(0, enemy.atk);
  const flying = route.motionMode === "fly";
  if (flying) {
    cell.airHp += hp;
    cell.airCount++;
  }
  else {
    cell.groundHp += hp;
    cell.groundCount++;
    cell.blockDemand++;
  }
  cell.incomingAttack += attack;
  cell.eliteWeight += enemy.isElite ? 2 : 0;
  cell.bossWeight += enemy.isBoss ? 3 : 0;
  if (distanceToGoal(cell.row, cell.col, route) <= 2) cell.goalThreat += hp + attack * 10;
  addUnique(cell.routeIds, route.id);
  addUnique(cell.enemyIds, enemy.id);
  for (const mechanic of [...(enemy.mechanics || []), ...(flying ? ["flying" as const] : [])]) addUnique(cell.mechanisms, mechanic);
  for (const gap of coverageGaps) addUnique(cell.coverageGaps, gap);
}

function criticalWindows(buckets: TemporalPressure["buckets"]): CriticalPressureWindow[] {
  const windows = new Map<number, CriticalPressureWindow>();
  for (const bucket of buckets) {
    const start = Math.floor(bucket.time / 15) * 15;
    const current = bucket.cells.reduce((sum, cell) => ({
      groundHp: sum.groundHp + cell.groundHp,
      airHp: sum.airHp + cell.airHp,
      groundCount: sum.groundCount + cell.groundCount,
      airCount: sum.airCount + cell.airCount,
      incomingAttack: sum.incomingAttack + cell.incomingAttack,
      blockDemand: sum.blockDemand + cell.blockDemand,
      eliteWeight: sum.eliteWeight + cell.eliteWeight,
      bossWeight: sum.bossWeight + cell.bossWeight,
      goalThreat: sum.goalThreat + cell.goalThreat,
      mergeWeight: sum.mergeWeight + cell.mergeWeight,
    }), { groundHp: 0, airHp: 0, groundCount: 0, airCount: 0, incomingAttack: 0, blockDemand: 0, eliteWeight: 0, bossWeight: 0, goalThreat: 0, mergeWeight: 0 });
    const severity = current.groundHp + current.airHp + current.incomingAttack * 10
      + current.goalThreat + current.eliteWeight * 5_000 + current.bossWeight * 10_000 + current.mergeWeight * 2_000;
    const previous = windows.get(start);
    if (!previous || severity > previous.severity) windows.set(start, { start, end: start + 15, ...current, severity });
  }
  return [...windows.values()].sort((left, right) => left.start - right.start);
}

export function buildTemporalPressure(mapData: MapData, options: TemporalPressureOptions = {}): TemporalPressure {
  const bucketSeconds = Math.max(0.1, options.bucketSeconds || 1);
  const enemies = new Map(mapData.enemyDetails.map(enemy => [enemy.id, enemy]));
  const routes = new Map(mapData.routes.map(route => [route.id, route]));
  const byTime = new Map<number, Map<string, TemporalCellPressure>>();
  const coverageGaps = new Set<string>();

  for (const spawn of mapData.spawnTimeline) {
    const enemy = enemies.get(spawn.enemyId);
    const route = routes.get(spawn.routeIndex);
    if (!enemy) {
      coverageGaps.add(`unknown_enemy:${spawn.enemyId}`);
      continue;
    }
    if (!route) {
      coverageGaps.add(`unknown_route:${spawn.routeIndex}`);
      continue;
    }
    const timeline = buildSpawnRouteTimeline(spawn, route, enemy, { bucketSeconds, moveMultiplier: mapData.options.moveMultiplier });
    for (const gap of timeline.coverageGaps) coverageGaps.add(gap);
    for (const point of timeline.points) {
      const time = bucketTime(point.time, bucketSeconds);
      let cells = byTime.get(time);
      if (!cells) {
        cells = new Map();
        byTime.set(time, cells);
      }
      const key = cellKey(point.row, point.col);
      let cell = cells.get(key);
      if (!cell) {
        cell = emptyCell(point.row, point.col);
        cells.set(key, cell);
      }
      addEnemy(cell, enemy, route, timeline.coverageGaps);
    }
  }

  const buckets = [...byTime.entries()].sort(([left], [right]) => left - right).map(([time, cells]) => ({
    time,
    cells: [...cells.values()].map(cell => ({
      ...cell,
      mergeWeight: Math.max(0, cell.routeIds.length - 1),
      routeIds: [...cell.routeIds].sort((left, right) => left - right),
      enemyIds: [...cell.enemyIds].sort(),
      mechanisms: [...cell.mechanisms].sort(),
      coverageGaps: [...cell.coverageGaps].sort(),
    })).sort((left, right) => left.row - right.row || left.col - right.col),
  }));
  return { bucketSeconds, buckets, criticalWindows: criticalWindows(buckets), coverageGaps: [...coverageGaps].sort() };
}

export function cellsAt(pressure: TemporalPressure, time: number): ReadonlyMap<string, TemporalCellPressure> {
  const bucket = pressure.buckets.find(candidate => candidate.time === bucketTime(time, pressure.bucketSeconds));
  return new Map((bucket?.cells || []).map(cell => [cellKey(cell.row, cell.col), cell]));
}
