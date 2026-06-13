import type {
  PRTSLevelData, MapData, TileInfo, DeploymentPoint,
  EnemyRoute, WaveInfo, FragmentInfo, EnemySpawn,
  SpawnEvent, HighThreatArea, StrategicPoint,
  EnemyDetail, DeploymentRecommendation,
} from "../types";
import type { PRTSMapLoader, EnemyDatabaseEntry } from "../loader/PRTSMapLoader";

function tileKeyToType(key: string): string {
  const map: Record<string, string> = {
    tile_road: "road", tile_wall: "wall", tile_floor: "floor",
    tile_start: "start", tile_end: "end", tile_forbidden: "forbidden",
  };
  return map[key] || "unknown";
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
        heightType: tileDef.heightType === "HIGHLAND" ? "highland" : "lowland",
        buildableType: tileDef.buildableType === "MELEE" ? "melee"
          : tileDef.buildableType === "RANGED" ? "ranged" : "none",
        row, col,
      };

      if (tileDef.buildableType !== "NONE") {
        deploymentPoints.push({
          row, col,
          buildableType: tileDef.buildableType === "MELEE" ? "melee" : "ranged",
        });
      }
    }
  }

  return { tiles, deploymentPoints };
}

function adaptRoutes(prts: PRTSLevelData): { routes: EnemyRoute[]; strategicPoints: StrategicPoint[] } {
  const routes: EnemyRoute[] = [];
  const pathCrossCount = new Map<string, number>();

  for (let i = 0; i < prts.routes.length; i++) {
    const r = prts.routes[i];
    if (!r) continue;
    const checkpoints = (r.checkpoints || [])
      .filter(cp => cp.type === "MOVE")
      .map(cp => ({ row: cp.position.row, col: cp.position.col }));

    if (r.motionMode === "E_NUM" || checkpoints.length === 0) continue;

    routes.push({
      id: i,
      motionMode: r.motionMode === "FLY" ? "fly" : "walk",
      startPosition: { row: r.startPosition.row, col: r.startPosition.col },
      endPosition: { row: r.endPosition.row, col: r.endPosition.col },
      checkpoints,
    });

    for (const cp of checkpoints) {
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

function adaptWaves(prts: PRTSLevelData): WaveInfo[] {
  const waves: WaveInfo[] = [];
  let absoluteTime = 0;

  for (let wi = 0; wi < prts.waves.length; wi++) {
    const w = prts.waves[wi];
    absoluteTime += w.preDelay;

    const fragments: FragmentInfo[] = [];
    for (const frag of w.fragments) {
      const fragTime = absoluteTime + frag.preDelay;
      const enemySpawns: EnemySpawn[] = [];

      for (const action of frag.actions) {
        if (action.actionType !== "SPAWN") continue;
        enemySpawns.push({
          enemyId: action.key,
          count: action.count,
          interval: action.interval,
          routeIndex: action.routeIndex,
        });
      }

      fragments.push({ preDelay: frag.preDelay, enemySpawns });
    }

    waves.push({ index: wi, preDelay: w.preDelay, postDelay: w.postDelay, fragments });
    absoluteTime += w.postDelay;
  }

  return waves;
}

function buildSpawnTimeline(waves: WaveInfo[]): SpawnEvent[] {
  const timeline: SpawnEvent[] = [];
  let absoluteTime = 0;

  for (const wave of waves) {
    absoluteTime += wave.preDelay;
    for (const frag of wave.fragments) {
      absoluteTime += frag.preDelay;
      for (const spawn of frag.enemySpawns) {
        for (let i = 0; i < spawn.count; i++) {
          timeline.push({
            time: absoluteTime + i * spawn.interval,
            enemyId: spawn.enemyId,
            count: 1,
            routeIndex: spawn.routeIndex,
          });
        }
      }
    }
    absoluteTime += wave.postDelay;
  }

  return timeline.sort((a, b) => a.time - b.time);
}

function buildHighThreatAreas(
  waves: WaveInfo[], routes: EnemyRoute[]
): HighThreatArea[] {
  const byRoute = new Map<number, { enemyTypes: Set<string>; count: number; firstTime: number }>();

  let absoluteTime = 0;
  for (const wave of waves) {
    absoluteTime += wave.preDelay;
    for (const frag of wave.fragments) {
      absoluteTime += frag.preDelay;
      for (const spawn of frag.enemySpawns) {
        let entry = byRoute.get(spawn.routeIndex);
        if (!entry) {
          entry = { enemyTypes: new Set(), count: 0, firstTime: absoluteTime };
          byRoute.set(spawn.routeIndex, entry);
        }
        entry.enemyTypes.add(spawn.enemyId);
        entry.count += spawn.count;
      }
    }
    absoluteTime += wave.postDelay;
  }

  return Array.from(byRoute.entries()).map(([routeIdx, data]) => {
    const route = routes[routeIdx];
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

function inferDeploymentOrder(
  deploymentPoints: DeploymentPoint[],
  spawnTimeline: SpawnEvent[],
  routes: EnemyRoute[],
  strategicPoints: StrategicPoint[]
): DeploymentRecommendation[] {
  const earliestByRoute = new Map<number, number>();
  for (const event of spawnTimeline) {
    if (!earliestByRoute.has(event.routeIndex) || event.time < earliestByRoute.get(event.routeIndex)!) {
      earliestByRoute.set(event.routeIndex, event.time);
    }
  }

  const points = deploymentPoints.map(dp => {
    let minRouteDist = Infinity;
    let earliestSpawn = Infinity;

    for (let ri = 0; ri < routes.length; ri++) {
      const route = routes[ri];
      for (const cp of route.checkpoints) {
        const dist = Math.abs(dp.row - cp.row) + Math.abs(dp.col - cp.col);
        if (dist < minRouteDist) {
          minRouteDist = dist;
          earliestSpawn = earliestByRoute.get(ri) || Infinity;
        }
      }
    }

    return { point: dp, minRouteDist, earliestSpawn };
  });

  // Sort: prioritize melee tiles near early-spawn routes
  points.sort((a, b) => {
    const scoreA = (a.point.buildableType === "melee" ? 0 : 1) * 100 + a.earliestSpawn + a.minRouteDist * 10;
    const scoreB = (b.point.buildableType === "melee" ? 0 : 1) * 100 + b.earliestSpawn + b.minRouteDist * 10;
    return scoreA - scoreB;
  });

  return points.map((p, i) => ({
    position: { row: p.point.row, col: p.point.col },
    role: p.point.buildableType === "melee" ? (i < 3 ? "vanguard" : "guard") : "sniper",
    priority: 100 - i,
  }));
}

export class PRTSMapAdapter {
  constructor(private loader: PRTSMapLoader) {}

  adapt(prtsData: PRTSLevelData, stageId: string, displayName?: string): MapData {
    const { tiles, deploymentPoints } = adaptTiles(prtsData);
    const { routes, strategicPoints } = adaptRoutes(prtsData);
    const waves = adaptWaves(prtsData);
    const spawnTimeline = buildSpawnTimeline(waves);
    const highThreatAreas = buildHighThreatAreas(waves, routes);

    // Resolve enemy details - use enemyDbRefs + loader if available
    const enemySet = new Set<string>();
    for (const wave of prtsData.waves) {
      for (const frag of wave.fragments) {
        for (const action of frag.actions) {
          if (action.actionType === "SPAWN") enemySet.add(action.key);
        }
      }
    }

    const enemyDetails: EnemyDetail[] = [];
    for (const enemyId of enemySet) {
      const dbEntry = this.loader.getEnemyInfo(enemyId);
      const ref = prtsData.enemyDbRefs.find(e => e.id === enemyId);
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
        isBoss: dbEntry?.enemyTags?.includes("boss") || false,
        isElite: (dbEntry?.enemyTags?.includes("elite")) ||
                 getOverrideVal(attr?.maxHp, baseAttr.maxHp) > 5000 ||
                 getOverrideVal(attr?.atk, baseAttr.atk) > 800,
      });
    }

    const deploymentOrder = inferDeploymentOrder(deploymentPoints, spawnTimeline, routes, strategicPoints);

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
        costIncreaseTime: prtsData.options.costIncreaseTime,
      },
      deploymentOrder,
      runes: prtsData.runes,
      _raw: prtsData,
    };
  }
}
