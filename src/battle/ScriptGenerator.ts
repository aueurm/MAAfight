import type { MapData, TacticalAnalysis, BattleScript, EnemyRoute, PlayerOperator } from "../types";
import { OPERATOR_POOLS, ROLE_NAMES, OperatorEntry } from "../shared/operatorDB";
import { getOperatorProfile, type OperatorProfile, type TacticalFunction } from "../data/operatorProfiles";

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

type DeployType = "melee" | "ranged" | "both";
type CandidateOperator = OperatorEntry & { role: string };

const ROLE_DEPLOY_TYPE: Record<string, DeployType> = {
  vanguard: "melee",
  guard: "melee",
  tank: "melee",
  sniper: "ranged",
  caster: "ranged",
  medic: "ranged",
  support: "ranged",
  specialist: "both",
};

function buildCandidatePool(): CandidateOperator[] {
  const byName = new Map<string, CandidateOperator>();
  for (const [role, ops] of Object.entries(OPERATOR_POOLS)) {
    for (const op of ops) {
      const prev = byName.get(op.name);
      if (!prev || op.tier < prev.tier) {
        byName.set(op.name, { ...op, role });
      }
    }
  }
  return [...byName.values()];
}

function compatibleDeployType(required: DeployType, actual?: DeployType): boolean {
  if (!actual || required === "both" || actual === "both") return true;
  return required === actual;
}

function dedupeFunctions(functions: TacticalFunction[]): TacticalFunction[] {
  return [...new Set(functions)];
}

function buildFunctionNeeds(role: string, mapData: MapData, analysis: TacticalAnalysis): TacticalFunction[] {
  const composition = analysis.enemyComposition;
  const hasBoss = composition.bossCount > 0;
  const isSwarm = composition.compositionType === "swarm";
  const avgDef = composition.averageDEF || 0;
  const hasFlyRoute = (mapData.routes || []).some(route => route.motionMode === "fly");
  const chokepointCount = (mapData.strategicPoints || []).filter(p => p.type === "chokepoint").length;

  const needs: TacticalFunction[] = [];

  switch (role) {
    case "vanguard":
      needs.push("early_dp", "lane_holder");
      break;
    case "guard":
      needs.push(hasBoss ? "boss_killer" : "lane_holder", "sustained_dps", "physical_burst");
      if (isSwarm) needs.push("aoe_clear");
      break;
    case "tank":
      needs.push("main_tank", chokepointCount > 0 ? "lane_holder" : "healing_tank");
      if (hasBoss) needs.push("healing_tank");
      break;
    case "sniper":
      needs.push(hasFlyRoute ? "anti_air" : "sustained_dps", "physical_burst");
      if (hasBoss) needs.push("boss_killer");
      break;
    case "caster":
      needs.push(avgDef > 300 || hasBoss ? "arts_burst" : "arts_dps");
      if (isSwarm) needs.push("aoe_clear");
      break;
    case "medic":
      needs.push("healer");
      if (hasBoss || analysis.requirements.difficultyRating === "hard" || analysis.requirements.difficultyRating === "extreme") {
        needs.push("buff");
      }
      break;
    case "support":
      needs.push("control", "debuff", hasBoss ? "buff" : "arts_dps");
      break;
    case "specialist":
      needs.push("fast_redeploy", hasBoss ? "boss_killer" : "control", "special_mechanic");
      break;
  }

  return dedupeFunctions(needs);
}

function trainingScore(name: string, playerOps?: Map<string, PlayerOperator>): number {
  const op = playerOps?.get(name);
  if (!op) return 0;
  return op.elite * 12 + op.rarity * 2 + op.level / 10;
}

function functionMatchScore(profile: OperatorProfile | undefined, needs: TacticalFunction[]): number {
  if (!profile) return 0;
  return needs.reduce((score, need, index) => {
    if (!profile.functions.includes(need)) return score;
    return score + Math.max(16, 40 - index * 4);
  }, 0);
}

function scoreCandidate(
  candidate: CandidateOperator,
  role: string,
  needs: TacticalFunction[],
  playerOps?: Map<string, PlayerOperator>
): number {
  const profile = getOperatorProfile(candidate.name);
  const requiredDeploy = ROLE_DEPLOY_TYPE[role] || "both";
  if (!compatibleDeployType(requiredDeploy, profile?.deployType)) return -1000;

  let score = (6 - candidate.tier) * 5 + trainingScore(candidate.name, playerOps);
  score += functionMatchScore(profile, needs);

  if (profile?.roleHints.includes(role)) score += 14;
  if (candidate.role === role) score += 8;
  if (!profile && candidate.role !== role) score -= 30;

  return score;
}

function selectOperatorsForRole(
  candidates: CandidateOperator[],
  role: string,
  count: number,
  usedNames: Set<string>,
  mapData: MapData,
  analysis: TacticalAnalysis,
  playerOps?: Map<string, PlayerOperator>
): CandidateOperator[] {
  if (count <= 0) return [];
  const needs = buildFunctionNeeds(role, mapData, analysis);
  return candidates
    .filter(op => !usedNames.has(op.name))
    .filter(op => !playerOps || playerOps.size === 0 || playerOps.has(op.name))
    .map(op => ({ op, score: scoreCandidate(op, role, needs, playerOps) }))
    .filter(item => item.score > -100)
    .sort((a, b) => b.score - a.score || a.op.tier - b.op.tier)
    .slice(0, count)
    .map(item => item.op);
}

function buildSelectionReason(operatorName: string, role: string, mapData: MapData, analysis: TacticalAnalysis): string {
  const needs = buildFunctionNeeds(role, mapData, analysis);
  const profile = getOperatorProfile(operatorName);
  const matched = profile ? needs.filter(need => profile.functions.includes(need)) : [];
  if (matched.length > 0) {
    return `${ROLE_NAMES[role] || role} slot matched functions: ${matched.join(", ")}`;
  }
  return `${ROLE_NAMES[role] || role} slot selected by role and training priority`;
}

function findDeploymentPoint(mapData: MapData, row: number, col: number): MapData["deploymentPoints"][0] | undefined {
  return (mapData.deploymentPoints || []).find(point => point.row === row && point.col === col);
}

function canDeployToPosition(operatorName: string, role: string, row: number, col: number, mapData: MapData): boolean {
  const point = findDeploymentPoint(mapData, row, col);
  if (!point) return true;
  const deployType = getOperatorProfile(operatorName)?.deployType || ROLE_DEPLOY_TYPE[role] || "both";
  if (deployType === "both") return true;
  return point.buildableType === deployType;
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

  const selectedByRole: Record<string, CandidateOperator[]> = {};
  const operatorGaps: string[] = [];
  const candidatePool = buildCandidatePool();
  const usedSelectedNames = new Set<string>();
  let totalSelected = 0;

  for (const role of DEPLOY_ROLE_ORDER) {
    const count = roleCounts[role] || 0;
    const selected = selectOperatorsForRole(candidatePool, role, count, usedSelectedNames, mapData, tacticalAnalysis, playerOps);
    selectedByRole[role] = selected;
    selected.forEach(op => usedSelectedNames.add(op.name));
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
  const deploymentReasons: Record<string, string> = {};

  for (const role of DEPLOY_ROLE_ORDER) {
    const deps = byRole[role] || [];
    const selected = selectedByRole[role] || [];
    let selectedIdx = 0;
    for (const deployment of deps) {
      if (selectedIdx >= selected.length) break;
      const operator = selected[selectedIdx];
      if (!canDeployToPosition(operator.name, role, deployment.position.row, deployment.position.col, mapData)) continue;
      const location: [number, number] = [deployment.position.row, deployment.position.col];
      const direction = inferDirection(deployment.position, mapData.routes);
      actions.push({ type: "Deploy", name: operator.name, location, direction });
      deployedNames.add(operator.name);
      usedPositions.add(`${deployment.position.row},${deployment.position.col}`);
      deploymentReasons[operator.name] = buildSelectionReason(operator.name, role, mapData, tacticalAnalysis);
      selectedIdx++;
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
        while (!deployedNames.has(operator.name) && unusedIdx < unusedDeployments.length) {
          const d = unusedDeployments[unusedIdx++];
          if (!canDeployToPosition(operator.name, role, d.position.row, d.position.col, mapData)) continue;
          const location: [number, number] = [d.position.row, d.position.col];
          const direction = inferDirection(d.position, mapData.routes);
          actions.push({ type: "Deploy", name: operator.name, location, direction });
          deployedNames.add(operator.name);
          usedPositions.add(`${d.position.row},${d.position.col}`);
          deploymentReasons[operator.name] = buildSelectionReason(operator.name, role, mapData, tacticalAnalysis);
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
        while (pointIdx < mapData.deploymentPoints.length) {
          const pt = mapData.deploymentPoints[pointIdx++];
          if (!canDeployToPosition(operator.name, role, pt.row, pt.col, mapData)) continue;
          const location: [number, number] = [pt.row, pt.col];
          const direction = inferDirection(pt, mapData.routes);
          actions.push({ type: "Deploy", name: operator.name, location, direction });
          deploymentReasons[operator.name] = buildSelectionReason(operator.name, role, mapData, tacticalAnalysis);
          break;
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
      deploymentReasons,
    },
  };
}
