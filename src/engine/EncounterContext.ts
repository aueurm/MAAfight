import { createHash } from "crypto";
import type { MapData } from "../types";
import { clamp } from "./helpers";
import type { EncounterContext, EncounterEnemyGroup, StageFacts } from "./types";

const encounterCache = new Map<string, EncounterContext>();

export function computeStageContentHash(mapData: MapData): string {
  const relevant = {
    stageId: mapData.stageId,
    deploymentPoints: mapData.deploymentPoints,
    routes: mapData.routes,
    enemyDetails: mapData.enemyDetails,
    spawnTimeline: mapData.spawnTimeline,
    options: mapData.options,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

export function buildEncounterContext(mapData: MapData, facts: StageFacts): EncounterContext {
  const hash = computeStageContentHash(mapData);
  const cached = encounterCache.get(hash);
  if (cached) return cached;
  const enemies = new Map(mapData.enemyDetails.map(enemy => [enemy.id, enemy]));
  const routes = new Map(mapData.routes.map(route => [route.id, route]));
  const grouped = new Map<number, EncounterEnemyGroup[]>();
  for (const spawn of mapData.spawnTimeline) {
    const enemy = enemies.get(spawn.enemyId);
    if (!enemy || spawn.count <= 0) continue;
    const start = Math.floor(Math.max(0, spawn.time) / 15) * 15;
    const group: EncounterEnemyGroup = {
      enemyId: spawn.enemyId,
      routeIndex: spawn.routeIndex,
      motionMode: routes.get(spawn.routeIndex)?.motionMode || "walk",
      count: spawn.count,
      hp: Math.max(1, enemy.maxHp),
      atk: Math.max(0, enemy.atk),
      def: Math.max(0, enemy.def),
      res: Math.max(0, enemy.magicResistance),
      moveSpeed: Math.max(0, enemy.moveSpeed),
      elite: enemy.isElite,
      boss: enemy.isBoss,
    };
    grouped.set(start, [...(grouped.get(start) || []), group]);
  }
  const windows = [...grouped.entries()].sort(([left], [right]) => left - right).map(([start, groups]) => ({
    start,
    end: start + 15,
    groups,
    totalHp: groups.reduce((sum, group) => sum + group.hp * group.count, 0),
    totalAttack: groups.reduce((sum, group) => sum + group.atk * group.count, 0),
  }));
  const totalCount = windows.reduce((sum, window) => sum + window.groups.reduce((n, group) => n + group.count, 0), 0);
  const averageDefense = totalCount
    ? windows.reduce((sum, window) => sum + window.groups.reduce((n, group) => n + group.def * group.count, 0), 0) / totalCount
    : 0;
  const averageResistance = totalCount
    ? windows.reduce((sum, window) => sum + window.groups.reduce((n, group) => n + group.res * group.count, 0), 0) / totalCount
    : 0;
  const peakHp = Math.max(0, ...windows.map(window => window.totalHp));
  const averageWindowHp = facts.totalHp / Math.max(1, windows.length);
  const flying = windows.reduce((sum, window) => sum + window.groups
    .filter(group => group.motionMode === "fly").reduce((n, group) => n + group.count, 0), 0);
  const fast = windows.reduce((sum, window) => sum + window.groups
    .filter(group => group.moveSpeed >= 1.2).reduce((n, group) => n + group.count, 0), 0);
  const averageAttack = totalCount
    ? windows.reduce((sum, window) => sum + window.groups.reduce((n, group) => n + group.atk * group.count, 0), 0) / totalCount
    : 0;
  const eliteBossCount = windows.reduce((sum, window) => sum + window.groups
    .filter(group => group.elite || group.boss).reduce((n, group) => n + group.count, 0), 0);
  const largestGroup = Math.max(0, ...windows.flatMap(window => window.groups.map(group => group.count)));
  const groundShare = facts.groundRouteCount / Math.max(1, facts.groundRouteCount + facts.flyingRouteCount);
  const referencePhysicalEffectiveness = Math.max(0.05, (1000 - averageDefense) / 1000);
  const referenceArtsEffectiveness = Math.max(0.05, 1 - averageResistance / 100);
  const context: EncounterContext = {
    hash,
    windows,
    averageDefense,
    averageResistance,
    routeCells: facts.routeCells,
    demand: {
      physical: referencePhysicalEffectiveness,
      arts: referenceArtsEffectiveness,
      burst: clamp((peakHp / Math.max(1, averageWindowHp) - 1) / 2 + (facts.bossCount > 0 ? 0.5 : 0), 0, 1),
      sustain: clamp(windows.length / 8, 0, 1),
      healing: clamp(averageAttack / 800 + facts.bossCount * 0.15, 0, 1),
      block: clamp(
        facts.groundRouteCount / Math.max(1, facts.groundRouteCount + facts.flyingRouteCount) * 0.45
          + facts.laneCount / 6,
        0,
        1
      ),
      control: clamp(fast / Math.max(1, totalCount) + facts.eliteCount / Math.max(1, totalCount), 0, 1),
      antiAir: clamp(flying / Math.max(1, totalCount) * 2, 0, 1),
      coverage: 0,
      singleTarget: clamp(eliteBossCount / Math.max(1, totalCount) * 3 + facts.bossCount * 0.35, 0, 1),
      area: clamp(largestGroup / 10 + totalCount / Math.max(1, windows.length * 25), 0, 1),
      laneHold: clamp(groundShare * (facts.laneCount / 4 + windows.length / 12), 0, 1),
      support: clamp(averageAttack / 1800 + fast / Math.max(1, totalCount), 0, 1),
      deployment: clamp(
        Math.max(0, (20 - facts.initialCost) / 30)
          + (windows[0]?.totalHp || 0) / Math.max(1, peakHp) * 0.5,
        0,
        1
      ),
    },
  };
  encounterCache.set(hash, context);
  return context;
}
