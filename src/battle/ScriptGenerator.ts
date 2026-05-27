import type { MapData, TacticalAnalysis, BattleScript, EnemyRoute, PlayerOperator } from "../types";
import { OPERATOR_POOLS, ROLE_NAMES, OperatorEntry } from "../shared/operatorDB";

function inferDirection(
  position: { row: number; col: number },
  routes: EnemyRoute[]
): string {
  if (!routes || routes.length === 0) return "Right";

  let bestRoute: EnemyRoute = routes[0];
  let minDist = Infinity;

  for (const route of routes) {
    if (route.checkpoints.length === 0) continue;
    for (const cp of route.checkpoints) {
      const dist = Math.abs(position.row - cp.row) + Math.abs(position.col - cp.col);
      if (dist < minDist) { minDist = dist; bestRoute = route; }
    }
  }

  const { startPosition, endPosition } = bestRoute;
  const dRow = endPosition.row - startPosition.row;
  const dCol = endPosition.col - startPosition.col;

  if (Math.abs(dCol) >= Math.abs(dRow)) {
    return dCol > 0 ? "Left" : "Right";
  } else {
    return dRow > 0 ? "Up" : "Down";
  }
}

/** 从 OPERATOR_POOLS 中筛选已拥有干员，按练度降序排列 */
function selectOperators(
  pool: OperatorEntry[],
  count: number,
  playerOps?: Map<string, PlayerOperator>
): OperatorEntry[] {
  if (!playerOps || playerOps.size === 0) {
    return pool.slice(0, count);
  }
  const owned = pool
    .filter(op => playerOps.has(op.name))
    .sort((a, b) => {
      const scoreA = playerOps.get(a.name);
      const scoreB = playerOps.get(b.name);
      const calcScore = (po?: PlayerOperator) => po ? po.rarity * 100 + po.elite * 50 + po.level : 0;
      return calcScore(scoreB) - calcScore(scoreA);
    });
  if (owned.length === 0) return pool.slice(0, count);
  return owned.slice(0, count);
}

/** 为干员列表生成 copilot opers 条目（含练度 requirements） */
function buildCopilotOperList(
  operators: { name: string; skill: number }[],
  playerOps?: Map<string, PlayerOperator>
): { name: string; skill: number; skill_usage: number; requirements?: { elite: number; level: number; skill_level: number; module: number; potential: number } }[] {
  return operators.map(op => {
    const po = playerOps?.get(op.name);
    const entry: { name: string; skill: number; skill_usage: number; requirements?: { elite: number; level: number; skill_level: number; module: number; potential: number } } = {
      name: op.name, skill: op.skill, skill_usage: 1,
    };
    if (po) {
      entry.requirements = { elite: po.elite, level: po.level, skill_level: 7, module: 0, potential: po.potential };
    }
    return entry;
  });
}

export interface GeneratorConfig {
  includeSpeedUp?: boolean;
  includeRetreat?: boolean;
  autoSelectOperators?: boolean;
  deploymentTimeout?: number;
  skillDelay?: number;
  playerOperators?: Map<string, PlayerOperator>;
}

export function generateScript(
  stageId: string,
  mapData: MapData,
  tacticalAnalysis: TacticalAnalysis,
  config: GeneratorConfig = {}
): BattleScript {
  const cfg = {
    includeSpeedUp: true,
    includeRetreat: true,
    autoSelectOperators: true,
    deploymentTimeout: 5,
    skillDelay: 2,
    ...config,
  };

  const playerOps = cfg.playerOperators;

  const actions: BattleScript["actions"] = [];
  const groups: BattleScript["groups"] = [];

  if (cfg.includeSpeedUp) {
    actions.push({ type: "SpeedUp" });
  }

  const deployments = mapData.deploymentOrder || [];
  const byRole: Record<string, typeof deployments> = {
    vanguard: [], tank: [], medic: [], sniper: [], caster: [], guard: [], support: [],
  };
  for (const d of deployments) {
    if (byRole[d.role]) byRole[d.role].push(d);
  }

  for (const [role, deps] of Object.entries(byRole)) {
    if (deps.length === 0) continue;

    const pool = OPERATOR_POOLS[role] || [];
    const selected = selectOperators(pool, deps.length, playerOps);
    if (selected.length === 0) continue;

    groups.push({
      name: ROLE_NAMES[role] || role,
      opers: buildCopilotOperList(selected.map(op => ({ name: op.name, skill: op.skill })), playerOps),
    });

    for (let i = 0; i < deps.length && i < selected.length; i++) {
      const deployment = deps[i];
      const operator = selected[i];
      const location: [number, number] = [deployment.position.row, deployment.position.col];
      const direction = inferDirection(deployment.position, mapData.routes);

      actions.push({ type: "Deploy", name: operator.name, location, direction });
    }
  }

  // 没有部署推荐时，根据战术分析生成默认部署
  if (deployments.length === 0 && mapData.deploymentPoints) {
    const req = tacticalAnalysis.requirements;
    const roleOrder = [
      { role: "vanguard", count: req.vanguardCount },
      { role: "tank", count: req.tankCount },
      { role: "guard", count: Math.max(0, req.vanguardCount - 1) },
      { role: "sniper", count: req.sniperCount },
      { role: "caster", count: req.casterCount },
      { role: "medic", count: req.medicCount },
    ];

    let pointIdx = 0;
    for (const { role, count } of roleOrder) {
      const pool = OPERATOR_POOLS[role] || [];
      const selected = selectOperators(pool, count, playerOps);
      if (selected.length === 0) continue;

      groups.push({
        name: ROLE_NAMES[role] || role,
        opers: buildCopilotOperList(selected.map(op => ({ name: op.name, skill: op.skill })), playerOps),
      });

      for (const operator of selected) {
        if (pointIdx < mapData.deploymentPoints.length) {
          const pt = mapData.deploymentPoints[pointIdx++];
          const location: [number, number] = [pt.row, pt.col];
          const direction = inferDirection(pt, mapData.routes);
          actions.push({ type: "Deploy", name: operator.name, location, direction });
        }
      }
    }
  }

  // 在连续 Deploy 之间插入 Wait 保证部署节奏
  if (cfg.deploymentTimeout && cfg.deploymentTimeout > 0) {
    for (let i = actions.length - 1; i > 0; i--) {
      if (actions[i].type === "Deploy" && actions[i - 1].type === "Deploy") {
        actions.splice(i, 0, { type: "Wait", time: cfg.deploymentTimeout });
      }
    }
  }

  const hasDeploy = actions.some(a => a.type === "Deploy");
  if (hasDeploy) {
    actions.push({ type: "SkillDaemon" });
  }

  return {
    stage_name: stageId,
    minimum_required: "v4.0.0",
    actions,
    doc: {
      title: `${stageId} AI-Generated`,
      details: tacticalAnalysis.summary,
    },
    groups,
    opers: (() => {
      const seen = new Set<string>();
      const result: BattleScript["opers"] = [];
      for (const g of groups) {
        for (const op of g.opers) {
          if (!seen.has(op.name)) {
            seen.add(op.name);
            const po = playerOps?.get(op.name);
          const entry: BattleScript["opers"][0] = { name: op.name, skill: op.skill, skill_usage: op.skill_usage };
          if (po) {
            entry.requirements = {
              elite: po.elite,
              level: po.level,
              skill_level: 7,
              module: 0,
              potential: po.potential,
            };
          }
          result.push(entry);
          }
        }
      }
      return result;
    })(),
    generatedAt: new Date().toISOString(),
    metadata: {
      source: "ai",
      difficulty: tacticalAnalysis.requirements.difficultyRating,
      estimatedCost: tacticalAnalysis.requirements.expectedCost,
    },
  };
}
