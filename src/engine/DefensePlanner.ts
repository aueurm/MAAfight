import type { BattleScript, DeploymentPoint, MapData } from "../types";
import { buildSpawnRouteTimeline, routePathCells } from "./RouteTimeline";
import { planDeploymentTimeline } from "./TimelinePlanner";
import type { Direction, EnginePick } from "./types";

export interface DefenseFront {
  point: DeploymentPoint;
  routeIds: number[];
  goalKeys: string[];
  firstArrival: number;
  direction: Direction;
}

export interface DefenseFacts {
  fronts: DefenseFront[];
  coverageGaps: string[];
}

export interface DefenseAssignment {
  front: DefenseFront;
  pick: EnginePick;
  readyTime: number;
}

// Scheduling allowance: observed MAA deployment helpers took about 1.2–1.3 wall seconds.
// Game-time progression during UI interaction is approximate; disclose the allowance in metadata.
export const DEFENSE_DEPLOY_INTERACTION_SECONDS = 1.5;
const defenseCache = new WeakMap<MapData, DefenseFacts>();
const key = (point: { row: number; col: number }): string => `${point.row},${point.col}`;

export function extractDefenseFronts(mapData: MapData): DefenseFacts {
  const cached = defenseCache.get(mapData);
  if (cached) return cached;
  const fronts = new Map<string, DefenseFront>();
  const provenCoverage = new Map<string, Set<number>>();
  const traversals: Array<{ route: MapData["routes"][number]; cells: ReturnType<typeof routePathCells>;
    timelines: Array<ReturnType<typeof buildSpawnRouteTimeline>>; complete: boolean }> = [];
  const gaps = new Set<string>();
  const groundPoints = new Map(mapData.deploymentPoints
    .filter(point => point.buildableType === "melee" || point.buildableType === "all")
    .map(point => [key(point), point]));
  const enemies = new Map(mapData.enemyDetails.map(enemy => [enemy.id, enemy]));
  const hasGoals = mapData.tiles.some(row => row.some(tile => tile.key === "end"));
  for (const route of mapData.routes) {
    const spawns = mapData.spawnTimeline.filter(spawn => spawn.routeIndex === route.id && spawn.count > 0);
    if (route.motionMode !== "walk" || !spawns.length
      || hasGoals && mapData.tiles[route.endPosition.row]?.[route.endPosition.col]?.key !== "end") continue;
    const cells = routePathCells(route);
    let last = cells.length - 2;
    while (last >= 0 && !groundPoints.has(key(cells[last]))) last--;
    if (last < 0) { gaps.add("ground_route_without_legal_interception"); continue; }
    const point = groundPoints.get(key(cells[last]))!;
    let arrival = Number.POSITIVE_INFINITY;
    const timelines: Array<ReturnType<typeof buildSpawnRouteTimeline>> = [];
    // Later spawns of the same enemy cannot reach this point before its first identical spawn.
    const earliestByEnemy = new Map<string, typeof spawns[number]>();
    for (const spawn of spawns) {
      if (spawn.time < (earliestByEnemy.get(spawn.enemyId)?.time ?? Number.POSITIVE_INFINITY)) earliestByEnemy.set(spawn.enemyId, spawn);
    }
    for (const spawn of earliestByEnemy.values()) {
      const enemy = enemies.get(spawn.enemyId);
      if (!enemy) { gaps.add("defense_enemy_timing_unknown"); continue; }
      const timeline = buildSpawnRouteTimeline(spawn, route, enemy, { bucketSeconds: 0.25, moveMultiplier: mapData.options.moveMultiplier });
      timelines.push(timeline);
      for (const gap of timeline.coverageGaps) gaps.add(gap);
      const contact = timeline.points.find(cell => cell.visible && cell.row === point.row && cell.col === point.col);
      if (contact) arrival = Math.min(arrival, contact.time);
      else gaps.add("defense_arrival_unknown");
    }
    const previous = cells[Math.max(0, last - 1)];
    const direction: Direction = previous.col !== point.col ? previous.col < point.col ? "Left" : "Right"
      : previous.row < point.row ? "Up" : "Down";
    const front = fronts.get(key(point)) || { point, routeIds: [], goalKeys: [], firstArrival: Number.POSITIVE_INFINITY, direction };
    front.routeIds.push(route.id);
    front.goalKeys = [...new Set([...front.goalKeys, key(route.endPosition)])].sort();
    if (arrival < front.firstArrival) { front.firstArrival = arrival; front.direction = direction; }
    fronts.set(key(point), front);
    traversals.push({ route, cells, timelines, complete: timelines.length === earliestByEnemy.size });
  }
  // A slightly earlier shared tile can intercept every branch of several terminal approaches.
  // Expand actual path membership first, then remove only points whose entire route set is covered.
  for (const front of fronts.values()) {
    const proven = new Set<number>();
    provenCoverage.set(key(front.point), proven);
    for (const { route, cells, timelines, complete } of traversals) {
      const index = cells.findIndex(cell => key(cell) === key(front.point));
      if (index < 0) continue;
      const contacts = timelines.map(timeline => timeline.points.find(cell => cell.visible && key(cell) === key(front.point)));
      // Geometric traversal while disappeared is not interception, and cannot erase a downstream front.
      if (!complete || !contacts.length || contacts.some(contact => !contact)) continue;
      proven.add(route.id);
      if (!front.routeIds.includes(route.id)) front.routeIds.push(route.id);
      if (!front.goalKeys.includes(key(route.endPosition))) front.goalKeys.push(key(route.endPosition));
      for (const contact of contacts) {
        if (contact && contact.time < front.firstArrival) {
          front.firstArrival = contact.time;
          const previous = cells[Math.max(0, index - 1)];
          front.direction = previous.col !== front.point.col ? previous.col < front.point.col ? "Left" : "Right"
            : previous.row < front.point.row ? "Up" : "Down";
        }
      }
    }
    front.routeIds.sort((a, b) => a - b);
    front.goalKeys.sort();
  }
  const allFronts = [...fronts.values()];
  const distinct = allFronts.filter(front => !allFronts.some(other => other !== front
    && front.routeIds.every(routeId => provenCoverage.get(key(other.point))?.has(routeId))
    && (other.routeIds.length > front.routeIds.length || other.firstArrival > front.firstArrival
      || other.firstArrival === front.firstArrival && key(other.point) < key(front.point))));
  const result = { fronts: distinct.sort((a, b) => a.firstArrival - b.firstArrival
    || a.point.row - b.point.row || a.point.col - b.point.col), coverageGaps: [...gaps].sort() };
  defenseCache.set(mapData, result);
  return result;
}

export function planDefenseOpening(mapData: MapData, picks: EnginePick[], deploymentLimit: number,
  preferenceFor: (pick: EnginePick, front: DefenseFront) => number = () => 0): {
  assignments: DefenseAssignment[]; coverageGaps: string[];
} {
  const facts = extractDefenseFronts(mapData);
  const gaps = new Set(facts.coverageGaps);
  const cap = mapData.options.initialCostCap ?? mapData.options.maxCost;
  const openingOptions = { ...mapData.options, maxCost: Math.min(cap, mapData.options.maxCost) };
  if (cap < mapData.options.maxCost) gaps.add("dynamic_cost_cap_unlock_unmodeled");
  if (mapData.options.initialCostCap === undefined && mapData.runes?.some(rune => rune.key === "cbuff_max_cost")) {
    gaps.add("initial_cost_cap_unresolved");
  }
  const remaining = picks.filter(pick => pick.profile.position === "MELEE" && pick.profile.attributes.block > 0
    // Standard bearers lose all block during skills; automatic skill use cannot secure a sole entrance.
    && pick.profile.subProfession !== "executor" && pick.profile.subProfession !== "bearer"
    && !pick.profile.modelCoverageGaps.includes("self_hp_drain_unmodeled")
    && !pick.profile.modelCoverageGaps.includes("self_removal_unmodeled")
    && Math.round(pick.profile.attributes.cost) <= cap);
  const assignments: DefenseAssignment[] = [];
  const actions: BattleScript["actions"] = [{ type: "SpeedUp" }];
  if (facts.fronts.length > deploymentLimit) gaps.add("defense_fronts_exceed_deployment_limit");
  const scheduledFronts = facts.fronts.slice(0, deploymentLimit);
  for (const [frontIndex, front] of scheduledFronts.entries()) {
    const choices = remaining.map((pick, preference) => {
      const action = { type: "Deploy" as const, name: pick.name, costs: Math.round(pick.profile.attributes.cost) };
      const timeline = planDeploymentTimeline({ actions: [...actions, action] }, openingOptions,
        { deploymentInteractionSeconds: DEFENSE_DEPLOY_INTERACTION_SECONDS });
      const readyTime = timeline.deployments.at(-1)!.time;
      const laterFronts = scheduledFronts.slice(frontIndex + 1);
      const cheapestRemaining = remaining.filter(other => other !== pick)
        .sort((a, b) => a.profile.attributes.cost - b.profile.attributes.cost).slice(0, laterFronts.length);
      const forecast = planDeploymentTimeline({ actions: [...actions, action, ...cheapestRemaining.map(other => ({
        type: "Deploy" as const, name: other.name, costs: Math.round(other.profile.attributes.cost),
      }))] }, openingOptions, { deploymentInteractionSeconds: DEFENSE_DEPLOY_INTERACTION_SECONDS });
      const later = forecast.deployments.slice(timeline.deployments.length);
      const missedFronts = Number(readyTime > front.firstArrival)
        + laterFronts.filter((other, index) => (later[index]?.time ?? Number.POSITIVE_INFINITY) > other.firstArrival).length;
      return { pick, action, readyTime, preference, missedFronts,
        lateness: Number.isFinite(readyTime) ? Math.max(0, readyTime - front.firstArrival) : Number.POSITIVE_INFINITY };
    }).sort((a, b) => a.missedFronts - b.missedFronts || a.lateness - b.lateness
      || preferenceFor(a.pick, front) - preferenceFor(b.pick, front)
      || Number(a.pick.role === "vanguard") - Number(b.pick.role === "vanguard")
      || a.readyTime - b.readyTime || a.preference - b.preference);
    const choice = choices[0];
    if (!choice) { gaps.add("defense_blocker_missing"); continue; }
    if (!Number.isFinite(front.firstArrival)) gaps.add("defense_arrival_unknown");
    if (!Number.isFinite(choice.readyTime) || choice.readyTime > front.firstArrival) gaps.add("defense_opening_deadline_missed");
    assignments.push({ front, pick: choice.pick, readyTime: choice.readyTime });
    actions.push(choice.action);
    remaining.splice(remaining.indexOf(choice.pick), 1);
  }
  return { assignments, coverageGaps: [...gaps].sort() };
}

export function orderDefenseDeployments(mapData: MapData, picks: EnginePick[], assignments: DefenseAssignment[]): EnginePick[] {
  const remaining = [...picks];
  const pending = [...assignments];
  const cap = mapData.options.initialCostCap ?? mapData.options.maxCost;
  const openingOptions = { ...mapData.options, maxCost: Math.min(cap, mapData.options.maxCost) };
  const ordered: EnginePick[] = [];
  const actions: BattleScript["actions"] = [{ type: "SpeedUp" }];
  const actionFor = (pick: EnginePick): BattleScript["actions"][number] => ({
    type: "Deploy", name: pick.name, costs: Math.round(pick.profile.attributes.cost),
  });
  while (remaining.length) {
    let next = remaining[0];
    const earliest = pending[0];
    if (earliest && next.operatorId !== earliest.pick.operatorId) {
      const assignedLater = pending.some(item => item.pick.operatorId === next.operatorId);
      const forecast = planDeploymentTimeline({ actions: [...actions, actionFor(next), ...pending.map(item => actionFor(item.pick))] },
        openingOptions, { deploymentInteractionSeconds: DEFENSE_DEPLOY_INTERACTION_SECONDS });
      const later = forecast.deployments.slice(-pending.length);
      if (Math.round(next.profile.attributes.cost) > cap || assignedLater
        || pending.some((item, index) => later[index].time > item.front.firstArrival)) next = earliest.pick;
    }
    ordered.push(next);
    actions.push(actionFor(next));
    remaining.splice(remaining.findIndex(pick => pick.operatorId === next.operatorId), 1);
    const assigned = pending.findIndex(item => item.pick.operatorId === next.operatorId);
    if (assigned >= 0) pending.splice(assigned, 1);
  }
  return ordered;
}
