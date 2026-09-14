import type {
  PRTSLevelData, MapData, TileInfo, DeploymentPoint,
  EnemyRoute, WaveInfo, FragmentInfo, EnemySpawn,
  SpawnEvent, HighThreatArea, StrategicPoint,
  EnemyDetail, EnemyMechanic, PRTSCheckpoint, RouteCheckpoint,
} from "../types";
import type { PRTSMapLoader, EnemyDatabaseEntry } from "../loader/PRTSMapLoader";
import { isSpawnActionType, normalizeBuildableType } from "../shared/prtsMap";
import { resolveDefaultHiddenGroups } from "./hiddenGroups";

function tileKeyToType(key: string): string {
  const map: Record<string, string> = {
    tile_road: "road", tile_wall: "wall", tile_floor: "floor",
    tile_start: "start", tile_end: "end", tile_forbidden: "forbidden",
  };
  return map[key] || "unknown";
}

function normalizeCheckpointType(type: PRTSCheckpoint["type"]): NonNullable<RouteCheckpoint["type"]> {
  if (type === "MOVE" || type === 0) return "MOVE";
  if (type === "WAIT_FOR_SECONDS" || type === 1) return "WAIT_FOR_SECONDS";
  if (type === "WAIT_CURRENT_FRAGMENT_TIME" || type === 3) return "WAIT_CURRENT_FRAGMENT_TIME";
  if (type === "DISAPPEAR" || type === 5) return "DISAPPEAR";
  if (type === "APPEAR_AT_POS" || type === 6) return "APPEAR_AT_POS";
  throw new Error(`Unsupported route checkpoint type: ${String(type)}`);
}

function isPathCheckpoint(checkpoint: RouteCheckpoint): boolean {
  return checkpoint.type === "MOVE" || checkpoint.type === "APPEAR_AT_POS";
}

function mapPosition(position: { row: number; col: number }, rows: number): { row: number; col: number } {
  return { row: rows - 1 - position.row, col: position.col };
}

function initialCostCap(prts: PRTSLevelData): number | undefined {
  const runes = (prts.runes || []).filter(rune => rune.key === "cbuff_max_cost");
  if (!runes.length) return undefined;
  let resolved: { cap: number; ceiling: number } | undefined;
  for (const rune of runes) {
    // Only the verified global form has an unambiguous starting-state meaning.
    if (rune.difficultyMask !== "ALL" || rune.professionMask !== 1023 || rune.buildableMask !== "ALL"
      || rune.position != null || !Array.isArray(rune.blackboard)) return undefined;
    const blackboard = rune.blackboard;
    const read = (name: string): unknown => {
      const entries = blackboard.filter((entry: unknown) => entry && typeof entry === "object"
        && (entry as { key?: unknown }).key === name);
      return entries.length === 1 ? entries[0].value : undefined;
    };
    const cap = read("max_cost");
    const ceiling = read("max_cost_ceil");
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0
      || typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling < cap
      || ceiling > prts.options.maxCost) return undefined;
    if (resolved && (resolved.cap !== cap || resolved.ceiling !== ceiling)) return undefined;
    resolved = { cap, ceiling };
  }
  return resolved?.cap;
}

function normalizeCheckpoint(checkpoint: PRTSCheckpoint, rows: number): RouteCheckpoint {
  const type = normalizeCheckpointType(checkpoint.type);
  return {
    ...mapPosition(checkpoint.position, rows),
    type,
    ...(type === "WAIT_FOR_SECONDS" ? { waitSeconds: Math.max(0, Number(checkpoint.time) || 0) } : {}),
  };
}

function isInactiveRouteMode(mode: unknown): boolean {
  return mode === "E_NUM" || mode === 2;
}

function normalizeMotionMode(mode: unknown): "walk" | "fly" {
  return mode === "FLY" || mode === 1 ? "fly" : "walk";
}

function normalizeHeightType(type: unknown): "highland" | "lowland" {
  return type === "HIGHLAND" || type === 1 ? "highland" : "lowland";
}

function adaptTiles(prts: PRTSLevelData): { tiles: TileInfo[][]; deploymentPoints: DeploymentPoint[] } {
  const tiles: TileInfo[][] = [];
  const deploymentPoints: DeploymentPoint[] = [];

  for (let row = 0; row < prts.mapData.map.length; row++) {
    tiles[row] = [];
    for (let col = 0; col < prts.mapData.map[row].length; col++) {
      const tileIdx = prts.mapData.map[row][col];
      const tileDef = prts.mapData.tiles[tileIdx];
      const type = tileKeyToType(tileDef.tileKey);

      tiles[row][col] = {
        key: type,
        heightType: normalizeHeightType(tileDef.heightType),
        buildableType: normalizeBuildableType(tileDef.buildableType),
        row, col,
      };

      if (tiles[row][col].buildableType !== "none") {
        deploymentPoints.push({
          row, col,
          buildableType: tiles[row][col].buildableType as "melee" | "ranged" | "all",
        });
      }
    }
  }

  return { tiles, deploymentPoints };
}

function adaptRoutes(prts: PRTSLevelData, excludedRouteIds: Set<number>): { routes: EnemyRoute[]; strategicPoints: StrategicPoint[] } {
  const routes: EnemyRoute[] = [];
  const pathCrossCount = new Map<string, number>();

  for (let i = 0; i < prts.routes.length; i++) {
    const r = prts.routes[i];
    if (!r || isInactiveRouteMode(r.motionMode) || excludedRouteIds.has(i)) continue;
    const rows = prts.mapData.map.length;
    const checkpoints = (r.checkpoints || []).map(checkpoint => normalizeCheckpoint(checkpoint, rows));
    const pathCheckpoints = checkpoints.filter(isPathCheckpoint);

    routes.push({
      id: i,
      motionMode: normalizeMotionMode(r.motionMode),
      startPosition: mapPosition(r.startPosition, rows),
      endPosition: mapPosition(r.endPosition, rows),
      checkpoints,
    });

    for (const cp of pathCheckpoints) {
      const key = `${cp.row},${cp.col}`;
      pathCrossCount.set(key, (pathCrossCount.get(key) || 0) + 1);
    }
  }

  const strategicPoints: StrategicPoint[] = [];
  for (const [key, count] of pathCrossCount) {
    const [row, col] = key.split(",").map(Number);
    if (count >= 2) {
      strategicPoints.push({ type: "chokepoint", row, col, routeCount: count });
    }
  }

  // Mark path starts
  const startKeys = new Set<string>();
  for (const r of routes) {
    const sk = `${r.startPosition.row},${r.startPosition.col}`;
    if (!startKeys.has(sk)) {
      startKeys.add(sk);
      strategicPoints.push({ type: "start", row: r.startPosition.row, col: r.startPosition.col, routeCount: 1 });
    }
  }

  return { routes, strategicPoints };
}

function adaptWaves(prts: PRTSLevelData): { waves: WaveInfo[]; excludedRouteIds: Set<number> } {
  const waves: WaveInfo[] = [];
  const enabledGroups = resolveDefaultHiddenGroups(prts);
  const enabledRouteIds = new Set<number>();
  const excludedRouteIds = new Set<number>();

  for (let wi = 0; wi < prts.waves.length; wi++) {
    const w = prts.waves[wi];

    const fragments: FragmentInfo[] = [];
    for (const frag of w.fragments) {
      const enemySpawns: EnemySpawn[] = [];
      let spawnScheduleDuration = 0;

      for (const action of frag.actions) {
        if (!isSpawnActionType(action.actionType)) continue;
        if (!Number.isFinite(action.preDelay) || action.preDelay < 0) {
          throw new Error(`Invalid spawn preDelay for ${action.key}: expected non-negative finite game seconds`);
        }
        // PRTS.Map advances the raw schedule before filtering inactive hidden groups.
        spawnScheduleDuration = Math.max(spawnScheduleDuration, action.preDelay + (action.count - 1) * action.interval);
        if (action.hiddenGroup != null && typeof action.hiddenGroup !== "string") {
          throw new Error(`Invalid spawn hiddenGroup for ${action.key}: expected a string or null`);
        }
        if (action.hiddenGroup && !enabledGroups.has(action.hiddenGroup)) {
          excludedRouteIds.add(action.routeIndex);
          continue;
        }
        enabledRouteIds.add(action.routeIndex);
        enemySpawns.push({
          enemyId: action.key,
          count: action.count,
          preDelay: action.preDelay,
          interval: action.interval,
          routeIndex: action.routeIndex,
        });
      }

      fragments.push({ preDelay: frag.preDelay, enemySpawns, spawnScheduleDuration });
    }

    waves.push({ index: wi, preDelay: w.preDelay, postDelay: w.postDelay, fragments });
  }

  // Shared routes remain valid; only routes used exclusively by disabled SPAWN groups are removed.
  for (const routeId of enabledRouteIds) excludedRouteIds.delete(routeId);
  return { waves, excludedRouteIds };
}

function buildSpawnTimeline(waves: WaveInfo[]): SpawnEvent[] {
  const timeline: SpawnEvent[] = [];
  let absoluteTime = 0;

  for (const wave of waves) {
    absoluteTime += wave.preDelay;
    for (const frag of wave.fragments) {
      absoluteTime += frag.preDelay;
      const fragmentStart = absoluteTime;
      for (const spawn of frag.enemySpawns) {
        for (let i = 0; i < spawn.count; i++) {
          const time = fragmentStart + (spawn.preDelay ?? 0) + i * spawn.interval;
          timeline.push({
            time,
            enemyId: spawn.enemyId,
            count: 1,
            routeIndex: spawn.routeIndex,
          });
          // Sibling actions share one start; the next fragment waits for scheduled spawns.
          absoluteTime = Math.max(absoluteTime, time);
        }
      }
      absoluteTime = Math.max(absoluteTime, fragmentStart + (frag.spawnScheduleDuration ?? 0));
    }
    absoluteTime += wave.postDelay;
  }

  return timeline.sort((a, b) => a.time - b.time);
}

function buildHighThreatAreas(
  spawnTimeline: SpawnEvent[], routes: EnemyRoute[]
): HighThreatArea[] {
  const byRoute = new Map<number, { enemyTypes: Set<string>; count: number; firstTime: number }>();
  const routeById = new Map(routes.map(route => [route.id, route]));

  for (const spawn of spawnTimeline) {
    let entry = byRoute.get(spawn.routeIndex);
    if (!entry) {
      entry = { enemyTypes: new Set(), count: 0, firstTime: spawn.time };
      byRoute.set(spawn.routeIndex, entry);
    }
    entry.enemyTypes.add(spawn.enemyId);
    entry.count += spawn.count;
    entry.firstTime = Math.min(entry.firstTime, spawn.time);
  }

  return Array.from(byRoute.entries()).map(([routeIdx, data]) => {
    const route = routeById.get(routeIdx);
    return {
      row: route?.startPosition.row || 0,
      col: route?.startPosition.col || 0,
      enemyTypes: [...data.enemyTypes],
      spawnCount: data.count,
      firstSpawnTime: data.firstTime,
    };
  });
}

function getOverrideVal(
  mDef: { m_defined: boolean; m_value: number } | undefined,
  base: number
): number {
  return mDef?.m_defined ? mDef.m_value : base;
}

function inferEnemyMechanics(description: string | undefined): EnemyMechanic[] {
  if (!description) return [];
  const mechanics: EnemyMechanic[] = [];
  if (description.includes("隐匿")) mechanics.push("stealth");
  if (description.includes("首次倒下后重生")) mechanics.push("revive");
  return mechanics;
}

export class PRTSMapAdapter {
  constructor(private loader: PRTSMapLoader) {}

  adapt(prtsData: PRTSLevelData, stageId: string, displayName?: string): MapData {
    if (!Array.isArray(prtsData?.mapData?.map) || !Array.isArray(prtsData?.mapData?.tiles)
      || !Array.isArray(prtsData?.routes) || !Array.isArray(prtsData?.waves) || !Array.isArray(prtsData?.enemyDbRefs)) {
      throw new Error(`Unsupported level structure for ${stageId}: map, routes, waves and enemy references must be arrays`);
    }
    const moveMultiplier = prtsData.options.moveMultiplier;
    if (moveMultiplier !== undefined && (!Number.isFinite(moveMultiplier) || moveMultiplier <= 0)) {
      throw new Error(`Invalid moveMultiplier for ${stageId}: expected a positive finite number`);
    }
    const { tiles, deploymentPoints } = adaptTiles(prtsData);
    const { waves, excludedRouteIds } = adaptWaves(prtsData);
    const { routes, strategicPoints } = adaptRoutes(prtsData, excludedRouteIds);
    const spawnTimeline = buildSpawnTimeline(waves);
    const highThreatAreas = buildHighThreatAreas(spawnTimeline, routes);
    const startingCostCap = initialCostCap(prtsData);

    // Resolve enemy details - use enemyDbRefs + loader if available
    const enemySet = new Set(spawnTimeline.map(spawn => spawn.enemyId));

    const enemyDetails: EnemyDetail[] = [];
    for (const enemyId of enemySet) {
      const ref = prtsData.enemyDbRefs.find(e => e.id === enemyId);
      const dbEntry = this.loader.getEnemyInfo(enemyId, ref?.level || 0);
      const attr = ref?.overwrittenData?.attributes;
      const baseAttr = dbEntry?.attributes || { maxHp: 0, atk: 0, def: 0, magicResistance: 0, moveSpeed: 1, attackSpeed: 100, massLevel: 1 };

      enemyDetails.push({
        id: enemyId,
        name: dbEntry?.name || enemyId,
        maxHp: getOverrideVal(attr?.maxHp, baseAttr.maxHp),
        atk: getOverrideVal(attr?.atk, baseAttr.atk),
        def: getOverrideVal(attr?.def, baseAttr.def),
        magicResistance: getOverrideVal(attr?.magicResistance, baseAttr.magicResistance),
        moveSpeed: getOverrideVal(attr?.moveSpeed, baseAttr.moveSpeed),
        isBoss: dbEntry?.levelType === "BOSS" || dbEntry?.enemyTags?.includes("boss") || false,
        isElite: (dbEntry?.enemyTags?.includes("elite")) ||
                 getOverrideVal(attr?.maxHp, baseAttr.maxHp) > 5000 ||
                 getOverrideVal(attr?.atk, baseAttr.atk) > 800,
        mechanics: inferEnemyMechanics(dbEntry?.description),
      });
    }

    return {
      stageId,
      name: displayName || stageId,
      tiles,
      deploymentPoints,
      strategicPoints,
      highThreatAreas,
      routes,
      waves,
      enemyDetails,
      spawnTimeline,
      options: {
        characterLimit: prtsData.options.characterLimit,
        maxLifePoint: prtsData.options.maxLifePoint,
        initialCost: prtsData.options.initialCost,
        maxCost: prtsData.options.maxCost,
        ...(startingCostCap !== undefined ? { initialCostCap: startingCostCap } : {}),
        costIncreaseTime: prtsData.options.costIncreaseTime,
        moveMultiplier,
      },
      runes: prtsData.runes?.map(rune => rune.position
        ? { ...rune, position: mapPosition(rune.position, prtsData.mapData.map.length) }
        : rune),
      _raw: prtsData,
    };
  }
}
