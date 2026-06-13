import type { MapData, TacticalAnalysis, DPSRequirement, MapRecommendation } from "../types";

interface EnemyStats {
  bossCount: number;
  eliteCount: number;
  normalCount: number;
  totalCount: number;
  totalHP: number;
  totalDPS: number;
  totalDEF: number;
}

function analyzeEnemyComposition(mapData: MapData): EnemyStats {
  const spawnTimeline = mapData.spawnTimeline || [];
  const enemyMap = new Map((mapData.enemyDetails || []).map(e => [e.id, e]));

  let bossCount = 0, eliteCount = 0, normalCount = 0;
  let totalHP = 0, totalDPS = 0, totalDEF = 0;
  let totalCount = 0;

  if (enemyMap.size > 0) {
    // v2: 使用真实敌人数据
    for (const event of spawnTimeline) {
      const count = event.count || 1;
      const detail = enemyMap.get(event.enemyId);
      totalCount += count;

      if (detail) {
        if (detail.isBoss) bossCount += count;
        else if (detail.isElite) eliteCount += count;
        else normalCount += count;
        totalHP += detail.maxHp * count;
        totalDPS += detail.atk * count;
        totalDEF += detail.def * count;
      } else {
        normalCount += count;
      }
    }
  } else {
    // v1 启发式回退：无敌人数据库时基于数量估算
    totalCount = spawnTimeline.reduce((sum, e) => sum + (e.count || 1), 0);
    normalCount = totalCount;

    if (totalCount > 10) {
      normalCount = Math.floor(totalCount * 0.7);
      eliteCount = Math.floor(totalCount * 0.25);
      bossCount = Math.floor(totalCount * 0.05);
    } else if (totalCount > 5) {
      eliteCount = Math.floor(totalCount * 0.3);
      normalCount = totalCount - eliteCount;
    }

    // 启发式 HP 估算
    totalHP = normalCount * 2000 + eliteCount * 8000 + bossCount * 50000;
    totalDPS = normalCount * 200 + eliteCount * 500 + bossCount * 1000;
    totalDEF = normalCount * 100 + eliteCount * 300 + bossCount * 500;
  }

  return { bossCount, eliteCount, normalCount, totalCount, totalHP, totalDPS, totalDEF };
}

function calculateDPSRequirement(mapData: MapData): DPSRequirement | undefined {
  const enemyMap = new Map((mapData.enemyDetails || []).map(e => [e.id, e]));
  let bossHP = 0;

  for (const event of mapData.spawnTimeline || []) {
    const detail = enemyMap.get(event.enemyId);
    if (detail?.isBoss) {
      bossHP += detail.maxHp * (event.count || 1);
    }
  }

  if (bossHP === 0) return undefined;

  const burstWindowSeconds = 30;
  const requiredDPS = Math.ceil(bossHP / burstWindowSeconds);

  const recommendedOperators: string[] = [];
  if (bossHP > 100000) {
    recommendedOperators.push("银灰", "艾雅法拉", "能天使");
  } else if (bossHP > 50000) {
    recommendedOperators.push("艾雅法拉", "能天使");
  } else {
    recommendedOperators.push("能天使", "黑");
  }

  return {
    totalBossHP: bossHP,
    burstWindowSeconds,
    requiredDPS,
    recommendedOperators,
  };
}

function rateDifficulty(stats: EnemyStats, chokepointCount: number): "easy" | "medium" | "hard" | "extreme" {
  let score = 0;

  // 数量维度：每 5 只敌人 +1 分，上限 10
  score += Math.min(stats.totalCount / 5, 10);
  // 精英维度：每只精英 +3 分，上限 15
  score += Math.min(stats.eliteCount * 3, 15);
  // Boss 维度：每只 Boss +10 分
  score += stats.bossCount * 10;
  // 总血量维度：每 10000 HP +1 分，上限 10
  score += Math.min(stats.totalHP / 10000, 10);
  // 敌人 DPS 维度：每 500 DPS +1 分，上限 5
  score += Math.min(stats.totalDPS / 500, 5);
  // 隘口维度：每个隘口 +2 分，上限 6
  score += Math.min(chokepointCount * 2, 6);

  if (score >= 30) return "extreme";
  if (score >= 15) return "hard";
  if (score >= 5) return "medium";
  return "easy";
}

function buildKeyTimings(
  spawnTimeline: MapData["spawnTimeline"],
  stats: EnemyStats
): TacticalAnalysis["keyTimings"] {
  const timings: TacticalAnalysis["keyTimings"] = [
    { time: 0, description: "Initial deployment", recommendedAction: "Deploy vanguards first", operatorType: "vanguard" },
  ];

  if (spawnTimeline.length === 0) return timings;

  // 找敌人密度峰值区间（5 秒窗口内敌人数量最大）
  const maxTime = spawnTimeline[spawnTimeline.length - 1].time;
  const windowSize = 10;
  let peakTime = 0;
  let peakDensity = 0;

  for (let t = 0; t <= maxTime; t += 5) {
    const density = spawnTimeline.filter(
      e => e.time >= t && e.time < t + windowSize
    ).reduce((sum, e) => sum + (e.count || 1), 0);
    if (density > peakDensity) {
      peakDensity = density;
      peakTime = t;
    }
  }

  if (peakDensity > 3) {
    timings.push({
      time: peakTime,
      description: `Peak enemy wave (~${peakDensity} enemies/${windowSize}s)`,
      recommendedAction: "Establish front line with AOE support",
      operatorType: "medic",
    });
  }

  if (stats.eliteCount > 0) {
    const firstEliteTime = spawnTimeline[Math.floor(spawnTimeline.length * 0.3)]?.time || 30;
    timings.push({
      time: firstEliteTime,
      description: "Elite enemy appearance window",
      recommendedAction: "Focus fire on elite targets",
    });
  }

  if (stats.bossCount > 0) {
    const bossTime = spawnTimeline[spawnTimeline.length - 1]?.time || 60;
    timings.push({
      time: Math.max(0, bossTime - 10),
      description: "Boss appearance imminent",
      recommendedAction: "Use boss counter skills",
      operatorType: "tank",
    });
  }

  timings.sort((a, b) => a.time - b.time);
  return timings;
}

function recommendPositions(mapData: MapData): MapRecommendation[] {
  const recommendations: MapRecommendation[] = [];
  const chokepoints = (mapData.strategicPoints || []).filter(p => p.type === "chokepoint");

  // 隘口附近优先推荐重装
  for (const cp of chokepoints) {
    const nearby = (mapData.deploymentPoints || [])
      .filter(dp => Math.abs(dp.row - cp.row) + Math.abs(dp.col - cp.col) <= 2)
      .sort((a, b) => {
        const distA = Math.abs(a.row - cp.row) + Math.abs(a.col - cp.col);
        const distB = Math.abs(b.row - cp.row) + Math.abs(b.col - cp.col);
        return distA - distB;
      });

    for (const dp of nearby.slice(0, 2)) {
      if (!recommendations.some(r => r.position.row === dp.row && r.position.col === dp.col)) {
        recommendations.push({
          position: { row: dp.row, col: dp.col },
          recommendedRole: dp.buildableType === "melee" ? "tank" : "sniper",
          priority: 80,
          reason: `Covers chokepoint at (${cp.row}, ${cp.col})`,
        });
      }
    }
  }

  // 路径起点附近推荐先锋
  const starts = (mapData.strategicPoints || []).filter(p => p.type === "start");
  for (const st of starts) {
    const nearby = (mapData.deploymentPoints || [])
      .filter(dp => Math.abs(dp.row - st.row) + Math.abs(dp.col - st.col) <= 2)
      .sort((a, b) => {
        const distA = Math.abs(a.row - st.row) + Math.abs(a.col - st.col);
        const distB = Math.abs(b.row - st.row) + Math.abs(b.col - st.col);
        return distA - distB;
      });

    for (const dp of nearby.slice(0, 1)) {
      if (!recommendations.some(r => r.position.row === dp.row && r.position.col === dp.col)) {
        recommendations.push({
          position: { row: dp.row, col: dp.col },
          recommendedRole: "vanguard",
          priority: 90,
          reason: `Early interception near spawn at (${st.row}, ${st.col})`,
        });
      }
    }
  }

  return recommendations.sort((a, b) => b.priority - a.priority);
}

export function analyzeBattle(mapData: MapData): TacticalAnalysis {
  const stats = analyzeEnemyComposition(mapData);
  const chokepoints = (mapData.strategicPoints || []).filter(p => p.type === "chokepoint");
  const chokepointCount = chokepoints.length;

  let compositionType: "single" | "swarm" | "mixed" | "boss_rush" = "single";
  if (stats.bossCount > 0) compositionType = "boss_rush";
  else if (stats.normalCount > 8 && stats.eliteCount > 0) compositionType = "mixed";
  else if (stats.normalCount > 8) compositionType = "swarm";
  else if (stats.eliteCount > 2) compositionType = "mixed";

  const vanguardCount = Math.min(2, Math.max(1, Math.ceil(stats.totalCount / 12)));
  let guardCount = compositionType === "boss_rush" ? 2 : 1;
  let medicCount = stats.bossCount > 0 ? 2 : 1;
  let tankCount = chokepointCount > 0 ? Math.min(2, Math.max(1, chokepointCount)) : 1;
  let sniperCount = compositionType === "swarm" ? 2 : 1;
  const avgDEF = stats.totalCount > 0 ? stats.totalDEF / stats.totalCount : 0;
  let casterCount = avgDEF > 300 ? 1 : 0;
  let specialistCount = 0;
  const specialRequirements: string[] = [];

  if (stats.bossCount > 0) {
    specialRequirements.push("Boss counter operator required");
    tankCount = Math.max(tankCount, 2);
    medicCount = 2;
    guardCount = Math.max(guardCount, 2);
    specialistCount = Math.max(specialistCount, 1);
  }
  if (compositionType === "swarm") {
    specialRequirements.push("AOE operators recommended for swarm control");
    sniperCount = Math.max(sniperCount, 2);
    casterCount = Math.max(casterCount, 1);
  }
  if (stats.totalDPS > 5000) {
    specialRequirements.push("High incoming damage — consider additional medics or defenders");
    medicCount = Math.max(medicCount, 2);
  }

  // Cap to 12 operators, trim from least-essential roles
  const supportCount = 0;
  let totalCount = vanguardCount + guardCount + tankCount + sniperCount + casterCount + medicCount + specialistCount + supportCount;
  const trimOrder = ["specialistCount", "casterCount", "sniperCount", "guardCount"];
  // Build a mutable reference object for trimming
  const counts: Record<string, number> = { vanguardCount, guardCount, tankCount, sniperCount, casterCount, medicCount, specialistCount, supportCount };
  for (const key of trimOrder) {
    if (totalCount <= 12) break;
    const trim = Math.min(counts[key], totalCount - 12);
    counts[key] -= trim;
    totalCount -= trim;
  }
  guardCount = counts.guardCount;
  casterCount = counts.casterCount;
  sniperCount = counts.sniperCount;
  specialistCount = counts.specialistCount;

  const expectedCost = vanguardCount * 10 + guardCount * 16 + tankCount * 15 +
    sniperCount * 15 + casterCount * 18 + medicCount * 12 + specialistCount * 12;

  const difficultyRating = rateDifficulty(stats, chokepointCount);

  let strategy: TacticalAnalysis["suggestedStrategy"];
  if (stats.bossCount > 0) {
    strategy = {
      name: "Boss Rush",
      description: "Focus all damage on boss while maintaining survival",
      corePrinciples: [
        "Deploy tanks to absorb boss attacks",
        "Keep medics at maximum healing",
        "Use burst DPS during boss vulnerable windows",
      ],
    };
  } else if (compositionType === "swarm" && chokepointCount > 0) {
    strategy = {
      name: "Chokepoint Defense",
      description: "Control chokepoints to maximize AOE efficiency",
      corePrinciples: [
        "Deploy tanks at chokepoints",
        "Stack AOE operators behind front line",
        "Maintain steady healing output",
      ],
    };
  } else if (compositionType === "mixed") {
    strategy = {
      name: "Balanced Assault",
      description: "Mixed composition requires flexible response",
      corePrinciples: [
        "Prioritize elite targets",
        "Use appropriate counter operators",
        "Maintain formation integrity",
      ],
    };
  } else {
    strategy = {
      name: "Standard Push",
      description: "Conventional strategy for normal encounters",
      corePrinciples: [
        "Deploy vanguards first",
        "Build cost and deploy damage dealers",
        "Support with medics as needed",
      ],
    };
  }

  const dpsRequirement = calculateDPSRequirement(mapData);
  const mapRecommendations = recommendPositions(mapData);
  const keyTimings = buildKeyTimings(mapData.spawnTimeline || [], stats);

  return {
    summary: `${compositionType.replace("_", " ")} composition with ${stats.totalCount} enemies, rated ${difficultyRating}`,
    enemyComposition: {
      totalCount: stats.totalCount,
      normalCount: stats.normalCount,
      eliteCount: stats.eliteCount,
      bossCount: stats.bossCount,
      compositionType,
      totalHP: stats.totalHP,
      totalDPS: stats.totalDPS,
      averageDEF: stats.totalCount > 0 ? Math.round(stats.totalDEF / stats.totalCount) : 0,
    },
    requirements: {
      vanguardCount, guardCount, medicCount, tankCount, sniperCount, casterCount,
      supportCount, specialistCount, specialRequirements, expectedCost, difficultyRating,
    },
    keyTimings,
    threatPriorities: [
      ...(stats.bossCount > 0 ? [{ threatLevel: "critical" as const, targetDescription: "Boss enemy", counterRecommendation: "High DPS + boss counter", priority: 100 }] : []),
      ...(stats.eliteCount > 0 ? [{ threatLevel: "high" as const, targetDescription: `Elite enemies (${stats.eliteCount})`, counterRecommendation: "Single-target high DPS", priority: 80 }] : []),
      ...(compositionType === "swarm" ? [{ threatLevel: "medium" as const, targetDescription: "Enemy swarm", counterRecommendation: "AOE operators", priority: 60 }] : []),
      { threatLevel: stats.bossCount > 0 ? "high" as const : "medium" as const, targetDescription: "Normal enemies", counterRecommendation: "Standard DPS", priority: 40 },
    ],
    suggestedStrategy: strategy,
    dpsRequirement,
    spawnTimeline: mapData.spawnTimeline,
    mapRecommendations: mapRecommendations.length > 0 ? mapRecommendations : undefined,
    notes: [
      ...specialRequirements,
      ...(difficultyRating === "extreme" ? ["Consider using support units for this battle"] : []),
      ...(stats.bossCount > 0 ? ["Boss battle — timing and positioning are critical"] : []),
      ...(compositionType === "swarm" ? ["Swarm battle — AOE coverage is essential"] : []),
      ...(stats.totalHP > 100000 ? [`Total enemy HP: ${Math.round(stats.totalHP / 1000)}k — ensure sufficient DPS`] : []),
      `Estimated required cost: ${expectedCost}`,
    ],
  };
}
