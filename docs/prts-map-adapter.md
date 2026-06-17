# PRTS.Map 适配器设计

## 概述

PRTSMapLoader 负责获取关卡数据，PRTSMapAdapter 负责将 PRTS.Map 的游戏引擎格式转换为 MAAfight 内部 MapData 格式。

## PRTSMapLoader

### 职责

1. **关卡索引** — 维护 stage ID → PRTS.Map 文件路径的映射
2. **数据获取** — 从 `https://map.ark-nights.com/` 下载关卡 JSON
3. **缓存管理** — 本地 `cache/` 目录缓存，避免重复下载
4. **敌人数据库** — 加载 `enemy_database.json`，提供敌人名称/属性查询

### 接口

```typescript
class PRTSMapLoader {
  /**
   * 根据 stage ID 加载关卡数据
   * @param stageId 如 "a001_01", "OF-1"
   * @param options.noCache 强制重新下载
   */
  async load(stageId: string, options?: { noCache?: boolean }): Promise<PRTSLevelData>;

  /**
   * 获取敌人的完整信息
   * @param enemyId 如 "enemy_1027_mob"
   */
  getEnemyInfo(enemyId: string): EnemyDatabaseEntry | null;

  /**
   * 列出所有支持的关卡 ID
   */
  listStages(): string[];

  /**
   * 用关卡名称模糊搜索
   */
  searchStages(query: string): StageSummary[];
}
```

### 关卡索引结构

从 PRTS.Map 索引整理出的关卡条目，结构化存储在 `src/loader/levelIndex.ts`。

关卡数量会随索引更新变化，文档不固定写死数量。需要确认时运行：

```bash
maafight list --limit 1
```

```typescript
// src/loader/levelIndex.ts
interface StageIndexEntry {
  stageId: string;       // "a001_01"
  filePath: string;      // "activities/a001/level_a001_01.json"
  category: string;      // "main" | "activity" | "crisis" | "roguelike" | "weekly" | "training"
  code?: string;         // 玩家可见的关卡代号, 如 "0-1", "OF-1"
}

const LEVEL_INDEX: StageIndexEntry[] = [
  // obt/main — 主线关卡
  // obt/hard — 突袭
  // obt/campaign — 剿灭作战
  // obt/weekly — 物资筹备 (CE-5, LS-5等)
  // obt/crisis — 危机合约
  // obt/roguelike — 集成战略
  // activities/ — 活动关卡
];
```

### 缓存策略

```
cache/
├── levels/
│   ├── activities/a001/level_a001_01.json
│   └── ...
└── enemy_database.json
```

### 实现要点

1. **使用 Node.js 内置 `https`** — 避免引入 `node-fetch` 等依赖
2. **并发下载** — 批量预下载时控制并发数（最多 5 个并发）
3. **ETag/If-Modified-Since** — 可选，减少重复下载
4. **错误处理** — 网络失败时回退到缓存，缓存也不存在则报错

```typescript
// 核心实现骨架
async load(stageId: string, options?: { noCache?: boolean }): Promise<PRTSLevelData> {
  const entry = this.resolveStage(stageId);
  const cachePath = `cache/levels/${entry.filePath}`;

  if (!options?.noCache && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  }

  const url = `https://map.ark-nights.com/data/levels/${entry.filePath}`;
  const data = await this.httpGet(url);
  this.ensureCacheDir(path.dirname(cachePath));
  fs.writeFileSync(cachePath, JSON.stringify(data));
  return data;
}
```

---

## PRTSMapAdapter

### 职责

将 PRTSLevelData 转换为 MapData (MAAfight 内部格式)。

### 接口

```typescript
class PRTSMapAdapter {
  constructor(private loader: PRTSMapLoader);

  /**
   * 主转换函数
   */
  adapt(prtsData: PRTSLevelData, stageId: string): MapData;
}
```

### 转换逻辑

#### 1. 瓦片转换 (tiles → TileInfo[][] + DeploymentPoint[])

```typescript
// 输入: prtsData.mapData.map (7×10 二维索引数组) + prtsData.mapData.tiles (定义数组)
// 输出: MapData.tiles (TileInfo 二维数组) + MapData.deploymentPoints

function adaptTiles(prtsData: PRTSLevelData): { tiles: TileInfo[][]; deploymentPoints: DeploymentPoint[] } {
  const tiles: TileInfo[][] = [];
  const deploymentPoints: DeploymentPoint[] = [];

  for (let row = 0; row < prtsData.mapData.map.length; row++) {
    tiles[row] = [];
    for (let col = 0; col < prtsData.mapData.map[row].length; col++) {
      const tileIdx = prtsData.mapData.map[row][col];
      const tileDef = prtsData.mapData.tiles[tileIdx];
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

function tileKeyToType(key: string): string {
  const map: Record<string, string> = {
    tile_road: "road", tile_wall: "wall", tile_floor: "floor",
    tile_start: "start", tile_end: "end", tile_forbidden: "forbidden",
  };
  return map[key] || "unknown";
}
```

#### 2. 路径分析 (routes → EnemyRoute[] + StrategicPoint[])

```typescript
// 输入: prtsData.routes
// 输出: MapData.routes + MapData.strategicPoints

function adaptRoutes(prtsData: PRTSLevelData): { routes: EnemyRoute[]; strategicPoints: StrategicPoint[] } {
  const routes: EnemyRoute[] = [];
  const pathCrossCount = new Map<string, number>(); // "row,col" → 路线数

  for (let i = 0; i < prtsData.routes.length; i++) {
    const r = prtsData.routes[i];
    const checkpoints = (r.checkpoints || [])
      .filter(cp => cp.type === "MOVE")
      .map(cp => ({ row: cp.position.row, col: cp.position.col }));

    // 过滤掉 E_NUM 模式(不是真实路径)
    if (r.motionMode === "E_NUM" || !checkpoints.length) continue;

    routes.push({
      id: i,
      motionMode: r.motionMode === "FLY" ? "fly" : "walk",
      startPosition: { row: r.startPosition.row, col: r.startPosition.col },
      endPosition: { row: r.endPosition.row, col: r.endPosition.col },
      checkpoints,
    });

    // 统计路径交叉: 每个途经点经过的路线数 +1
    for (const cp of checkpoints) {
      const key = `${cp.row},${cp.col}`;
      pathCrossCount.set(key, (pathCrossCount.get(key) || 0) + 1);
    }

    // 起点/终点也是战略点
    const startKey = `${r.startPosition.row},${r.startPosition.col}`;
    pathCrossCount.set(startKey, (pathCrossCount.get(startKey) || 0) + 1);
    const endKey = `${r.endPosition.row},${r.endPosition.col}`;
    pathCrossCount.set(endKey, (pathCrossCount.get(endKey) || 0) + 1);
  }

  // 路径交叉点 → 隘口
  const strategicPoints: StrategicPoint[] = [];
  for (const [key, count] of pathCrossCount) {
    const [row, col] = key.split(",").map(Number);
    if (count >= 2) {
      strategicPoints.push({ type: "chokepoint", row, col, routeCount: count });
    }
  }

  // 起点/终点
  for (const r of routes) {
    const sk = `${r.startPosition.row},${r.startPosition.col}`;
    if (!strategicPoints.find(p => p.type === "start" && p.row === r.startPosition.row && p.col === r.startPosition.col)) {
      strategicPoints.push({ type: "start", row: r.startPosition.row, col: r.startPosition.col, routeCount: 1 });
    }
  }

  return { routes, strategicPoints };
}
```

#### 3. 波次分析 (waves + routes → WaveInfo[] + SpawnEvent[] + HighThreatArea[])

```typescript
function adaptWaves(prtsData: PRTSLevelData, routes: EnemyRoute[]): WaveInfo[] {
  const waves: WaveInfo[] = [];
  let accumulatedTime = 0;

  for (let wi = 0; wi < prtsData.waves.length; wi++) {
    const w = prtsData.waves[wi];
    accumulatedTime += w.preDelay;

    const fragments: FragmentInfo[] = [];
    for (const frag of w.fragments) {
      let fragTime = accumulatedTime + frag.preDelay;
      const enemySpawns: EnemySpawn[] = [];

      for (const action of frag.actions) {
        if (action.actionType !== "SPAWN") continue;

        // action.preDelay + accumulated → 该批的绝对时间
        // 连续出怪: 每隔 action.interval 秒出一个
        enemySpawns.push({
          enemyId: action.key,
          count: action.count,
          interval: action.interval,
          routeIndex: action.routeIndex,
        });
      }

      fragments.push({ preDelay: frag.preDelay, enemySpawns });
    }

    waves.push({ index: wi, preDelay: w.preDelay, fragments });
    accumulatedTime += w.postDelay;
  }

  return waves;
}

// 生成精确出怪时间线
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
  }

  return timeline.sort((a, b) => a.time - b.time);
}

// 从 eventSpawns + routes 生成 highThreatAreas
function buildHighThreatAreas(
  spawns: EnemySpawn[], routes: EnemyRoute[]
): HighThreatArea[] {
  // 按 routeIndex 和 enemyId 分组
  const areaMap = new Map<string, { firstTime: number; count: number; enemyTypes: Set<string> }>();

  // ... 分组逻辑 ...

  return Array.from(areaMap.entries()).map(([key, data]) => {
    const routeIdx = parseInt(key.split(":")[0]);
    const route = routes[routeIdx];
    return {
      row: route.startPosition.row,
      col: route.startPosition.col,
      enemyTypes: [...data.enemyTypes],
      spawnCount: data.count,
      firstSpawnTime: data.firstTime,
    };
  });
}
```

#### 4. 敌人属性提取 (enemyDbRefs + enemy_database → EnemyDetail[])

```typescript
function adaptEnemies(
  prtsData: PRTSLevelData,
  loader: PRTSMapLoader
): EnemyDetail[] {
  const enemySet = new Set<string>();

  // 收集所有出场的敌人 ID
  for (const wave of prtsData.waves) {
    for (const frag of wave.fragments) {
      for (const action of frag.actions) {
        if (action.actionType === "SPAWN") {
          enemySet.add(action.key);
        }
      }
    }
  }

  const enemies: EnemyDetail[] = [];
  for (const enemyId of enemySet) {
    const dbEntry = prtsData.enemyDbRefs.find(e => e.id === enemyId);
    const dbInfo = loader.getEnemyInfo(enemyId);

    const attr = dbEntry?.overwrittenData.attributes;
    const baseAttr = dbInfo?.attributes || {};

    // 覆写数据优先, 未覆写则用数据库默认值
    function getVal(mDef: { m_defined: boolean; m_value: number } | undefined, base: number): number {
      return mDef?.m_defined ? mDef.m_value : base;
    }

    const maxHp = getVal(attr?.maxHp, baseAttr.maxHp || 0);
    const atk = getVal(attr?.atk, baseAttr.atk || 0);
    const def = getVal(attr?.def, baseAttr.def || 0);

    enemies.push({
      id: enemyId,
      name: dbInfo?.name || enemyId,
      maxHp, atk, def,
      magicResistance: getVal(attr?.magicResistance, baseAttr.magicResistance || 0),
      moveSpeed: getVal(attr?.moveSpeed, baseAttr.moveSpeed || 1),
      isBoss: dbInfo?.enemyTags?.includes("boss") || false,
      isElite: maxHp > 5000 || atk > 800,
    });
  }

  return enemies;
}
```

#### 5. 部署顺序推断

```typescript
// 启发式算法, 基于:
// 1. 敌人波次时间 → 先出怪的路线上先部署
// 2. 可部署点位距蓝门距离 → 近蓝门优先
// 3. 瓦片类型 → 近战位优先于高台位(先锋先下)

function inferDeploymentOrder(
  deploymentPoints: DeploymentPoint[],
  spawnTimeline: SpawnEvent[],
  routes: EnemyRoute[],
  strategicPoints: StrategicPoint[]
): DeploymentRecommendation[] {
  // 1. 找出最早出怪的路线
  const earliestByRoute = new Map<number, number>();
  for (const event of spawnTimeline) {
    if (!earliestByRoute.has(event.routeIndex) || event.time < earliestByRoute.get(event.routeIndex)!) {
      earliestByRoute.set(event.routeIndex, event.time);
    }
  }

  // 2. 计算每个部署点到蓝门(出口)的距离
  const endPoints = strategicPoints.filter(p => p.type === "end");

  // 3. 排序: 最早出怪路径上的点位 > 近战位 > 高台位 > 距离蓝门近的
  // ...
}
```

### 主转换入口

```typescript
adapt(prtsData: PRTSLevelData, stageId: string): MapData {
  const { tiles, deploymentPoints } = adaptTiles(prtsData);
  const { routes, strategicPoints } = adaptRoutes(prtsData);
  const waves = adaptWaves(prtsData, routes);
  const spawnTimeline = buildSpawnTimeline(waves);
  const highThreatAreas = buildHighThreatAreas(/*...*/);
  const enemies = adaptEnemies(prtsData, this.loader);

  return {
    stageId,
    name: stageId,
    tiles,
    deploymentPoints,
    strategicPoints,
    highThreatAreas,
    routes,
    waves,
    enemyDetails: enemies,
    spawnTimeline,
    options: {
      characterLimit: prtsData.options.characterLimit,
      maxLifePoint: prtsData.options.maxLifePoint,
      initialCost: prtsData.options.initialCost,
      maxCost: prtsData.options.maxCost,
      costIncreaseTime: prtsData.options.costIncreaseTime,
    },
  };
}
```

### 测试要点

1. 使用 `level_a001_01.json` (已下载到 MAAfight 目录) 作为测试数据
2. 验证 deploymentPoints 数量与地图可见的可部署格一致
3. 验证路径交叉点识别正确
4. 验证出怪时间线时间递增
5. 验证敌人属性的覆写逻辑: 覆写值 > 数据库值
