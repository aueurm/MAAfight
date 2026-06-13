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

/** 玩家练度评分 */
/** 按 tier → 精英化 → 稀有度 → 等级排序 */
function sortByElitePriority(
  pool: OperatorEntry[],
  playerOps?: Map<string, PlayerOperator>
): OperatorEntry[] {
  return [...pool].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const pa = playerOps?.get(a.name);
    const pb = playerOps?.get(b.name);
    if ((pb?.elite ?? 0) !== (pa?.elite ?? 0)) return (pb?.elite ?? 0) - (pa?.elite ?? 0);
    if ((pb?.rarity ?? 0) !== (pa?.rarity ?? 0)) return (pb?.rarity ?? 0) - (pa?.rarity ?? 0);
    return (pb?.level ?? 0) - (pa?.level ?? 0);
  });
}

/** 按 tier 优先、精英二优先、练度降序选择干员，只选已拥有 */
function selectOperators(
  pool: OperatorEntry[],
  count: number,
  playerOps?: Map<string, PlayerOperator>
): OperatorEntry[] {
  const sorted = sortByElitePriority(pool, playerOps);

  if (!playerOps || playerOps.size === 0) {
    return sorted.slice(0, count);
  }

  // 严格只用已拥有干员，不回落未拥有
  return sorted.filter(op => playerOps.has(op.name)).slice(0, count);
}

/** 为干员列表生成 copilot opers 条目 */
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

/** 部署优先级：先锋最早，特种最晚 */
const DEPLOY_ROLE_ORDER = [
  "vanguard", "guard", "tank", "sniper", "caster", "medic", "support", "specialist",
];

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
  const req = tacticalAnalysis.requirements;

  const actions: BattleScript["actions"] = [];
  const groups: BattleScript["groups"] = [];

  if (cfg.includeSpeedUp) {
    actions.push({ type: "SpeedUp" });
  }

  // 收集各角色部署推荐并匹配干员
  const deployments = mapData.deploymentOrder || [];
  const byRole: Record<string, typeof deployments> = {};
  for (const role of DEPLOY_ROLE_ORDER) {
    byRole[role] = [];
  }
  for (const d of deployments) {
    if (!byRole[d.role]) continue;
    byRole[d.role].push(d);
  }

  // 干员选择：按战术需求从各职业池选取
  const roleCounts: Record<string, number> = {
    vanguard: req.vanguardCount,
    guard: req.guardCount,
    tank: req.tankCount,
    sniper: req.sniperCount,
    caster: req.casterCount,
    medic: req.medicCount,
    support: req.supportCount,
    specialist: req.specialistCount,
  };

  const selectedByRole: Record<string, OperatorEntry[]> = {};
  const operatorGaps: string[] = [];
  let totalSelected = 0;

  for (const role of DEPLOY_ROLE_ORDER) {
    const pool = OPERATOR_POOLS[role] || [];
    const count = roleCounts[role] || 0;
    const selected = selectOperators(pool, count, playerOps);
    selectedByRole[role] = selected;
    if (playerOps && playerOps.size > 0 && count > 0 && selected.length < count) {
      operatorGaps.push(`${ROLE_NAMES[role] || role}: need ${count}, selected ${selected.length}`);
    }
    totalSelected += selected.length;
  }

  // 超过 12 人时从低优先级职业裁剪
  if (totalSelected > 12) {
    const trimOrder = ["specialist", "support", "caster", "sniper", "guard", "tank", "medic", "vanguard"];
    for (const role of trimOrder) {
      if (totalSelected <= 12) break;
      const arr = selectedByRole[role];
      while (arr.length > 0 && totalSelected > 12) {
        // 优先裁 tier 最高的（最弱的）
        arr.pop();
        totalSelected--;
      }
    }
  }

  // 生成 8 个职业组
  for (const role of DEPLOY_ROLE_ORDER) {
    const selected = selectedByRole[role];
    if (!selected || selected.length === 0) continue;
    groups.push({
      name: ROLE_NAMES[role] || role,
      opers: buildCopilotOperList(selected.map(op => ({ name: op.name, skill: op.skill })), playerOps),
    });
  }

  // 部署动作生成：按职业优先级分配干员到对应部署位
  const deployedNames = new Set<string>();
  const usedPositions = new Set<string>();

  for (const role of DEPLOY_ROLE_ORDER) {
    const deps = byRole[role] || [];
    const selected = selectedByRole[role] || [];
    for (let i = 0; i < deps.length && i < selected.length; i++) {
      const deployment = deps[i];
      const operator = selected[i];
      const location: [number, number] = [deployment.position.row, deployment.position.col];
      const direction = inferDirection(deployment.position, mapData.routes);
      actions.push({ type: "Deploy", name: operator.name, location, direction });
      deployedNames.add(operator.name);
      usedPositions.add(`${deployment.position.row},${deployment.position.col}`);
    }
  }

  // 回退：将已入选但未部署的干员分配到任何空闲部署位
  if (deployments.length > 0) {
    const allDeployments = deployments.map(d => ({
      ...d,
      key: `${d.position.row},${d.position.col}`,
    }));
    const unusedDeployments = allDeployments.filter(d => !usedPositions.has(d.key));
    let unusedIdx = 0;

    for (const role of DEPLOY_ROLE_ORDER) {
      const selected = selectedByRole[role] || [];
      for (const operator of selected) {
        if (!deployedNames.has(operator.name) && unusedIdx < unusedDeployments.length) {
          const d = unusedDeployments[unusedIdx++];
          const location: [number, number] = [d.position.row, d.position.col];
          const direction = inferDirection(d.position, mapData.routes);
          actions.push({ type: "Deploy", name: operator.name, location, direction });
          deployedNames.add(operator.name);
        }
      }
    }
  }

  // 没有部署推荐时，根据战术分析 + 部署点位生成
  if (deployments.length === 0 && mapData.deploymentPoints) {
    let pointIdx = 0;
    for (const role of DEPLOY_ROLE_ORDER) {
      const selected = selectedByRole[role] || [];
      if (selected.length === 0) continue;

      // 确保该组已加入 groups
      if (!groups.some(g => g.name === (ROLE_NAMES[role] || role))) {
        groups.push({
          name: ROLE_NAMES[role] || role,
          opers: buildCopilotOperList(selected.map(op => ({ name: op.name, skill: op.skill })), playerOps),
        });
      }

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

  // Deploy 之间插入 Wait
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
                elite: po.elite, level: po.level, skill_level: 7, module: 0, potential: po.potential,
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
      playerOperatorsUsed: Boolean(playerOps && playerOps.size > 0),
      operatorGaps,
    },
  };
}
