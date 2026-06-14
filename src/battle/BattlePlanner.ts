import type { MapData, TacticalAnalysis } from "../types";
import type { BattlePlan, BattleTask, PositionHint, PressureWindow } from "./types";

const WINDOW_SECONDS = 15;
const TASK_PRIORITY: Record<BattleTask, number> = {
  early_dp: 100,
  boss_kill: 95,
  anti_air: 90,
  healing: 85,
  lane_block: 80,
  lane_hold: 75,
  arts_damage: 70,
  elite_control: 65,
  physical_dps: 60,
  fast_redeploy: 55,
  support: 50,
};

function getEnemyStats(mapData: MapData, enemyId: string): {
  hp: number;
  atk: number;
  isElite: boolean;
  isBoss: boolean;
} {
  const detail = (mapData.enemyDetails || []).find(enemy => enemy.id === enemyId);
  if (!detail) {
    return { hp: 2000, atk: 200, isElite: false, isBoss: false };
  }

  return {
    hp: detail.maxHp || 2000,
    atk: detail.atk || 200,
    isElite: Boolean(detail.isElite),
    isBoss: Boolean(detail.isBoss),
  };
}

function isFlyingSpawn(mapData: MapData, routeIndex: number): boolean {
  const route = (mapData.routes || []).find(r => r.id === routeIndex) || (mapData.routes || [])[routeIndex];
  return route?.motionMode === "fly";
}

export function buildPressureWindows(mapData: MapData, windowSeconds = WINDOW_SECONDS): PressureWindow[] {
  const timeline = [...(mapData.spawnTimeline || [])].sort((a, b) => a.time - b.time);
  if (timeline.length === 0) {
    return [];
  }

  const maxTime = Math.max(...timeline.map(event => event.time || 0));
  const windows: PressureWindow[] = [];

  for (let start = 0; start <= maxTime; start += windowSeconds) {
    const end = start + windowSeconds;
    const events = timeline.filter(event => (event.time || 0) >= start && (event.time || 0) < end);
    if (events.length === 0) continue;

    let enemyCount = 0;
    let totalHp = 0;
    let totalAtk = 0;
    let eliteCount = 0;
    let bossCount = 0;
    let flyingCount = 0;
    const laneIds = new Set<string>();

    for (const event of events) {
      const count = Math.max(1, event.count || 1);
      const stats = getEnemyStats(mapData, event.enemyId);
      const flying = isFlyingSpawn(mapData, event.routeIndex);
      enemyCount += count;
      totalHp += stats.hp * count;
      totalAtk += stats.atk * count;
      if (stats.isElite) eliteCount += count;
      if (stats.isBoss) bossCount += count;
      if (flying) flyingCount += count;
      if (event.routeIndex !== undefined) laneIds.add(String(event.routeIndex));
    }

    windows.push({
      start,
      end,
      laneId: laneIds.size === 1 ? [...laneIds][0] : undefined,
      enemyCount,
      totalHp,
      totalAtk,
      hasFlying: flyingCount > 0,
      hasElite: eliteCount > 0,
      hasBoss: bossCount > 0,
      pressureScore:
        enemyCount +
        totalHp / 1000 +
        totalAtk / 100 +
        eliteCount * 5 +
        bossCount * 20 +
        flyingCount * 3,
    });
  }

  return windows.sort((a, b) => a.start - b.start);
}

function pushTask(tasks: BattleTask[], task: BattleTask, count = 1): void {
  for (let i = 0; i < count; i++) {
    tasks.push(task);
  }
}

export function buildRecommendedTasks(analysis: TacticalAnalysis, windows: PressureWindow[], mapData: MapData): BattleTask[] {
  const tasks: BattleTask[] = [];
  const req = analysis.requirements;
  const composition = analysis.enemyComposition;
  const highPressureCount = windows.filter(window => window.pressureScore >= 30).length;
  const flyingWindows = windows.filter(window => window.hasFlying).length;
  const eliteWindows = windows.filter(window => window.hasElite).length;
  const hasBoss = windows.some(window => window.hasBoss) || composition.bossCount > 0;
  const routeCount = new Set((mapData.spawnTimeline || []).map(event => event.routeIndex)).size;

  pushTask(tasks, "early_dp", Math.max(1, req.vanguardCount || 1));
  pushTask(tasks, "lane_block", Math.max(1, req.tankCount || 0));
  pushTask(tasks, "lane_hold", Math.max(1, req.guardCount || 0));

  if (routeCount > 1 || highPressureCount > 1) {
    pushTask(tasks, "lane_hold");
  }

  if (flyingWindows > 0 || (mapData.routes || []).some(route => route.motionMode === "fly")) {
    pushTask(tasks, "anti_air", Math.max(1, req.sniperCount || 1));
  } else {
    pushTask(tasks, "physical_dps", Math.max(0, req.sniperCount || 0));
  }

  if ((composition.averageDEF || 0) > 300 || (composition.totalHP || 0) > 60000 || req.casterCount > 0) {
    pushTask(tasks, "arts_damage", Math.max(1, req.casterCount || 1));
  }

  if (hasBoss) {
    pushTask(tasks, "boss_kill");
  }

  if (eliteWindows > 0 || composition.eliteCount > 0) {
    pushTask(tasks, "elite_control");
  }

  if ((composition.totalDPS || 0) > 5000 || highPressureCount > 0 || hasBoss || req.medicCount > 0) {
    pushTask(tasks, "healing", Math.max(1, req.medicCount || 1));
  }

  pushTask(tasks, "support", req.supportCount || 0);
  pushTask(tasks, "fast_redeploy", req.specialistCount || 0);

  const seenCounts: Partial<Record<BattleTask, number>> = {};
  return tasks
    .map((task, index) => {
      const duplicateIndex = seenCounts[task] || 0;
      seenCounts[task] = duplicateIndex + 1;
      return { task, index, adjustedPriority: TASK_PRIORITY[task] - duplicateIndex * 20 };
    })
    .sort((a, b) => b.adjustedPriority - a.adjustedPriority || a.index - b.index)
    .slice(0, Math.max(1, mapData.options?.characterLimit || 12))
    .map(item => item.task);
}

function buildPositionHints(mapData: MapData, tasks: BattleTask[]): Record<string, PositionHint[]> {
  const hints: Record<string, PositionHint[]> = {};
  const recommendations = mapData.deploymentOrder || [];

  for (const task of [...new Set(tasks)]) {
    hints[task] = recommendations.slice(0, 5).map((rec): PositionHint => ({
      task,
      row: rec.position.row,
      col: rec.position.col,
      score: rec.priority,
      reason: `Adapter deployment recommendation for ${rec.role}`,
    }));
  }

  return hints;
}

export function buildBattlePlan(mapData: MapData, analysis: TacticalAnalysis): BattlePlan {
  const warnings: string[] = [];
  const pressureWindows = buildPressureWindows(mapData);

  if ((mapData.spawnTimeline || []).length === 0) {
    warnings.push("No spawn timeline available; battle plan uses requirement fallback only.");
  }
  if ((mapData.enemyDetails || []).length === 0) {
    warnings.push("Enemy detail data missing; pressure scores use safe default enemy stats.");
  }

  const recommendedTasks = buildRecommendedTasks(analysis, pressureWindows, mapData);

  return {
    difficulty: analysis.requirements.difficultyRating,
    tacticType: analysis.suggestedStrategy.name,
    pressureWindows,
    recommendedTasks,
    positionHints: buildPositionHints(mapData, recommendedTasks),
    warnings,
  };
}
