# BattleAnalyzer v2 增强设计

## 概述

v1 (battle-ipc.js) 的 `analyzeBattle` 通过 `spawnCount` (高威胁区域位置数) 来盲猜敌人组成。v2 利用 PRTS.Map 提供的精确敌人属性 (HP/ATK/DEF) 和出怪时间线，做真实难度评估。

## v1 的问题

```typescript
// v1 的问题: 基于 spawnCount 盲猜
const spawnCount = (mapData.highThreatAreas || []).reduce(
  (sum, area) => sum + (area.positions || []).length, 0
);

if (spawnCount > 10) { bossCount = floor(spawnCount * 0.05); }  // 纯猜测!
```

- 无法区分 Boss (HP 50000) 和杂兵 (HP 1000)
- 难度评级不可靠
- DPS 需求无法计算

## v2 增强点

### 1. 精确敌人组成

```typescript
// v2: 读取每只敌人的精确属性
function analyzeEnemyComposition(mapData: MapData): EnemyComposition {
  const bosses: EnemyDetail[] = [];
  const elites: EnemyDetail[] = [];
  const normals: EnemyDetail[] = [];

  for (const spawn of mapData.spawnTimeline) {
    const detail = mapData.enemyDetails.find(e => e.id === spawn.enemyId);
    if (!detail) continue;

    if (detail.isBoss) bosses.push(detail);
    else if (detail.isElite) elites.push(detail);
    else normals.push(detail);
  }

  const totalHP = [...bosses, ...elites, ...normals].reduce((s, e) => s + e.maxHp, 0);
  const totalCount = bosses.length + elites.length + normals.length;

  let compositionType: EnemyComposition["compositionType"];
  if (bosses.length > 0) compositionType = "boss_rush";
  else if (normals.length > 20) compositionType = "swarm";
  else if (elites.length > 3) compositionType = "mixed";
  else compositionType = "single";

  return {
    totalCount,
    normalCount: normals.length,
    eliteCount: elites.length,
    bossCount: bosses.length,
    compositionType,
    totalHP,
    averageDEF: [...bosses, ...elites].reduce((s, e) => s + e.def, 0) / (bosses.length + elites.length || 1),
  };
}
```

### 2. DPS 需求计算

```typescript
function calculateDPSRequirement(
  enemies: EnemyDetail[],
  spawnTimeline: SpawnEvent[],
  options: MapOptions
): DPSRequirement | undefined {
  const bosses = enemies.filter(e => e.isBoss);
  if (bosses.length === 0) return undefined;

  const totalBossHP = bosses.reduce((sum, b) => sum + b.maxHp, 0);

  // 估算 Boss 有效输出窗口: 假设 Boss 在中期出现
  const bossSpawns = spawnTimeline.filter(s =>
    enemies.find(e => e.id === s.enemyId && e.isBoss)
  );
  const firstBossTime = Math.min(...bossSpawns.map(s => s.time));
  const lastBossTime = Math.max(...bossSpawns.map(s => s.time));

  // 输出窗口: 从首只 Boss 到关卡结束(假设为最后出怪时间 + 60秒)
  const windowEnd = lastBossTime + 60;
  const burstWindow = Math.max(30, windowEnd - firstBossTime);
  const requiredDPS = totalBossHP / burstWindow;

  return {
    totalBossHP,
    burstWindowSeconds: burstWindow,
    requiredDPS,
    recommendedOperators: recommendHighDPS(requiredDPS),
  };
}

function recommendHighDPS(requiredDPS: number): string[] {
  // 基于干员数据库推荐 (硬编码数据, 后续对接 PRTS)
  if (requiredDPS > 1500) return ["银灰(真银斩)", "史尔特尔(黄昏)", "玛恩纳(未照耀的荣光)"];
  if (requiredDPS > 800) return ["艾雅法拉(火山)", "能天使(过载模式)", "棘刺(至高之术)"];
  return ["常规输出干员即可应对"];
}
```

### 3. 精确时间线分析

```typescript
function analyzeTimings(spawnTimeline: SpawnEvent[]): KeyTiming[] {
  const timings: KeyTiming[] = [];

  // 首次出怪时间
  const firstSpawn = spawnTimeline[0];
  if (firstSpawn) {
    timings.push({
      time: firstSpawn.time,
      description: "首批敌人出现",
      recommendedAction: "部署先锋获取费用",
      operatorType: "vanguard",
    });
  }

  // 找出敌人密度峰值 (滑动窗口内最多出怪数)
  const peakTime = findPeakTime(spawnTimeline);
  if (peakTime) {
    timings.push({
      time: peakTime.time,
      description: `出怪高峰 (${peakTime.count} 只/分钟)`,
      recommendedAction: "全员部署完毕, 技能准备就绪",
      operatorType: "medic",
    });
  }

  // Boss 出现时间
  for (const event of spawnTimeline) {
    const detail = /* enemyDetail lookup */;
    if (detail?.isBoss) {
      timings.push({
        time: event.time,
        description: `Boss 出现: ${detail.name}`,
        recommendedAction: "集中火力, 激活核心技能",
        operatorType: "tank",
      });
    }
  }

  return timings.sort((a, b) => a.time - b.time);
}

function findPeakTime(timeline: SpawnEvent[]): { time: number; count: number } | null {
  const windowSize = 30; // 30秒窗口
  let maxCount = 0, peakTime = 0;

  for (const event of timeline) {
    const count = timeline.filter(
      e => e.time >= event.time && e.time < event.time + windowSize
    ).length;
    if (count > maxCount) { maxCount = count; peakTime = event.time; }
  }

  return maxCount > 0 ? { time: peakTime, count: maxCount } : null;
}
```

### 4. 增强难度评级

```typescript
function rateDifficulty(composition: EnemyComposition, options: MapOptions): DifficultyRating {
  let score = 0;
  let rating: DifficultyRating["rating"] = "easy";

  // 评分因子
  if (composition.totalHP > 100000) score += 3;
  else if (composition.totalHP > 50000) score += 2;
  else if (composition.totalHP > 20000) score += 1;

  if (composition.bossCount > 1) score += 3;
  else if (composition.bossCount > 0) score += 2;

  if (composition.eliteCount > 5) score += 2;
  else if (composition.eliteCount > 3) score += 1;

  if (composition.totalCount > 50) score += 2;
  else if (composition.totalCount > 30) score += 1;

  // 生存压力: 高防敌人多则物理队压力大
  if (composition.averageDEF > 500) score += 1;

  // 部署限制
  if (options.characterLimit < 8) score += 1;

  if (score >= 7) rating = "extreme";
  else if (score >= 4) rating = "hard";
  else if (score >= 2) rating = "medium";

  return { rating, score };
}
```

### 5. 地图推荐

```typescript
// 基于可部署点位和路径分析, 推荐每个位置的部署角色
function recommendPositions(mapData: MapData): MapRecommendation[] {
  const recommendations: MapRecommendation[] = [];

  for (const dp of mapData.deploymentPoints) {
    // 计算该位置到最近敌人路径的距离
    const nearRoutes = mapData.routes.filter(r =>
      r.checkpoints.some(cp => manhattanDistance(cp, dp) <= 2)
    );

    if (nearRoutes.length === 0) {
      recommendations.push({
        position: { row: dp.row, col: dp.col },
        recommendedRole: "support",
        priority: 1,
        reason: "远离主要交火区域, 适合部署辅助/医疗",
      });
      continue;
    }

    // 在敌人路径上的近战位 → 重装
    if (dp.buildableType === "melee" && nearRoutes.length >= 2) {
      recommendations.push({
        position: { row: dp.row, col: dp.col },
        recommendedRole: "tank",
        priority: 3,
        reason: "多路线交汇近战位, 重装最佳部署点",
      });
    }
    // 在敌人路径上的近战位 → 近卫/先锋
    else if (dp.buildableType === "melee") {
      recommendations.push({
        position: { row: dp.row, col: dp.col },
        recommendedRole: "guard",
        priority: 2,
        reason: "路径近战位, 适合输出干员",
      });
    }
    // 高台位靠近路径 → 狙击/术师
    else if (dp.buildableType === "ranged" && nearRoutes.length > 0) {
      recommendations.push({
        position: { row: dp.row, col: dp.col },
        recommendedRole: nearRoutes.length > 1 ? "caster" : "sniper",
        priority: 3,
        reason: nearRoutes.length > 1 ? "多路线覆盖, AOE 术师最佳位置" : "直线覆盖, 狙击理想位置",
      });
    }
  }

  return recommendations.sort((a, b) => b.priority - a.priority);
}
```

## 迁移兼容性

v2 `analyzeBattle` 保持与 v1 相同的函数签名，确保 ScriptGenerator 无需改动：

```typescript
// 签名完全兼容 v1
function analyzeBattle(mapData: MapData): TacticalAnalysis {
  const composition = analyzeEnemyComposition(mapData);
  const dpsReq = calculateDPSRequirement(mapData.enemyDetails, mapData.spawnTimeline, mapData.options);
  const timings = analyzeTimings(mapData.spawnTimeline);
  const { rating } = rateDifficulty(composition, mapData.options);
  const strategy = selectStrategy(composition);

  // 干员需求
  const requirements = {
    vanguardCount: Math.min(2, Math.max(1, Math.ceil(mapData.spawnTimeline.length / 20))),
    medicCount: composition.bossCount > 0 ? 2 : 1,
    tankCount: mapData.strategicPoints.filter(p => p.type === "chokepoint").length > 0
      ? Math.min(2, mapData.strategicPoints.filter(p => p.type === "chokepoint").length) : 1,
    sniperCount: composition.compositionType === "swarm" ? 2 : 1,
    casterCount: composition.eliteCount > 2 ? 1 : 0,
    supportCount: 0,
    specialRequirements: buildSpecialRequirements(composition, dpsReq),
    expectedCost: calculateCost(requirements),
    difficultyRating: rating,
  };

  return {
    summary: `${composition.compositionType.replace("_", " ")} composition with ${composition.totalCount} enemies, rated ${rating}`,
    enemyComposition: composition,
    requirements,
    keyTimings: timings,
    threatPriorities: buildThreats(composition, mapData.enemyDetails),
    suggestedStrategy: strategy,
    dpsRequirement: dpsReq,
    spawnTimeline: mapData.spawnTimeline,
    mapRecommendations: recommendPositions(mapData),
    notes: buildNotes(composition, requirements),
  };
}
```

## 测试计划

1. **测试数据** — 使用已下载的 `level_a001_01.json` 作为标准测试输入
2. **验证点**:
   - 敌人 HP 总和 > 0 (不是盲猜)
   - Boss 识别正确 (isBoss = true 的敌人被正确标记)
   - 难度评级有区分度 (不同关卡不同评分)
   - 与 v1 输出结构兼容 (ScriptGenerator 不报错)
3. **边界情况**:
   - 无 Boss 关卡: `dpsRequirement` 应为 undefined
   - 单路线关卡: `strategicPoints.chokepoint` 为空
   - 0 秒出怪: `spawnTimeline[0].time === 0`
