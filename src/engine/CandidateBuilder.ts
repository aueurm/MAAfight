import { OPERATOR_POOLS, type OperatorEntry } from "../shared/operatorDB";
import type { BattleScript, BattleScriptOper, DeploymentPoint } from "../types";
import type { CandidateBuildInput, EnginePick, EngineRole, StageFacts } from "./types";

const MELEE_ROLES = new Set<EngineRole>(["vanguard", "guard", "tank", "specialist"]);
const COSTS: Record<EngineRole, number> = {
  vanguard: 11,
  guard: 19,
  tank: 21,
  sniper: 14,
  caster: 20,
  medic: 17,
  support: 15,
  specialist: 12,
};

function rolePlan(facts: StageFacts): EngineRole[] {
  const plan: EngineRole[] = ["vanguard", "tank", "guard", "medic", "sniper", "caster", "medic"];
  if (facts.flyingRouteCount > 0) plan.splice(5, 0, "sniper");
  if (facts.bossCount > 0) plan.push("guard", "caster");
  plan.push("support", "specialist", "guard", "sniper", "caster", "tank", "vanguard");
  return plan;
}

function investmentScore(pick: EnginePick): number {
  const player = pick.player;
  if (!player) return 0;
  return player.elite * 30 + Math.min(30, player.level / 3) + Math.min(10, player.potential * 2);
}

function poolForRole(role: EngineRole, input: CandidateBuildInput): EnginePick[] {
  const playerOperators = input.options.playerOperators;
  return ((OPERATOR_POOLS[role] || []) as OperatorEntry[])
    .filter(operator => !playerOperators || playerOperators.size === 0 || playerOperators.has(operator.name))
    .map(operator => ({
      ...operator,
      role,
      player: playerOperators?.get(operator.name),
    }))
    .sort((a, b) => a.tier - b.tier || investmentScore(b) - investmentScore(a) || a.name.localeCompare(b.name));
}

export function selectSquad(input: CandidateBuildInput): { picks: EnginePick[]; warnings: string[] } {
  const used = new Set<string>();
  const picks: EnginePick[] = [];
  const warnings: string[] = [];

  for (const role of rolePlan(input.facts)) {
    if (picks.length >= 12) break;
    const available = poolForRole(role, input).filter(operator => !used.has(operator.name));
    if (available.length === 0) continue;
    const index = Math.min(input.operatorVariant, available.length - 1);
    const selected = available[index];
    picks.push(selected);
    used.add(selected.name);
  }

  if (picks.length < 12) warnings.push(`Only ${picks.length} owned catalog operators are available for the fixed squad.`);
  return { picks, warnings };
}

function distance(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

function nearestDistance(point: DeploymentPoint, targets: Array<{ row: number; col: number }>): number {
  return targets.length ? Math.min(...targets.map(target => distance(point, target))) : 0;
}

function compatible(role: EngineRole, point: DeploymentPoint): boolean {
  if (point.buildableType === "all") return true;
  return MELEE_ROLES.has(role) ? point.buildableType === "melee" : point.buildableType === "ranged";
}

function positionScore(role: EngineRole, point: DeploymentPoint, facts: StageFacts): number {
  const routeDistance = nearestDistance(point, facts.routeCells);
  const chokeDistance = nearestDistance(point, facts.chokeCells);
  const goalDistance = nearestDistance(point, facts.goalCells);
  if (MELEE_ROLES.has(role)) {
    return 120 - routeDistance * 28 - chokeDistance * 8 - goalDistance * 1.5;
  }
  const rangeFit = routeDistance <= 3 ? 35 - Math.abs(routeDistance - 2) * 8 : -routeDistance * 12;
  return 80 + rangeFit - chokeDistance * 3 - goalDistance;
}

function directionFor(point: DeploymentPoint, facts: StageFacts): string {
  const targets = facts.routeCells.length ? facts.routeCells : facts.goalCells;
  const target = [...targets].sort((a, b) => distance(point, a) - distance(point, b))[0];
  if (!target) return "Right";
  const rowDelta = target.row - point.row;
  const colDelta = target.col - point.col;
  if (Math.abs(colDelta) >= Math.abs(rowDelta)) return colDelta >= 0 ? "Right" : "Left";
  return rowDelta >= 0 ? "Down" : "Up";
}

function toOper(pick: EnginePick, requirementsMode: "none" | "player"): BattleScriptOper {
  const operator: BattleScriptOper = { name: pick.name, skill: pick.skill, skill_usage: 1 };
  if (requirementsMode === "player" && pick.player) {
    operator.requirements = {
      elite: pick.player.elite,
      level: pick.player.level,
      ...(pick.player.skillLevel !== undefined ? { skill_level: pick.player.skillLevel } : {}),
      ...(pick.player.module !== undefined ? { module: pick.player.module } : {}),
      ...(pick.player.moduleLevel !== undefined ? { module_level: pick.player.moduleLevel } : {}),
      potential: pick.player.potential,
    };
  }
  return operator;
}

export function buildCandidate(input: CandidateBuildInput): { script: BattleScript; picks: EnginePick[]; warnings: string[] } {
  const squad = selectSquad(input);
  const usedPositions = new Set<string>();
  const actions: BattleScript["actions"] = [{ type: "SpeedUp" }];
  const deployLimit = Math.min(9, input.facts.characterLimit || 9, input.facts.deploymentPoints.length);
  const deployOrder = [...squad.picks].sort((a, b) => {
    const order: EngineRole[] = ["vanguard", "tank", "guard", "medic", "sniper", "caster", "support", "specialist"];
    return order.indexOf(a.role) - order.indexOf(b.role);
  });

  for (const pick of deployOrder) {
    if (actions.filter(action => action.type === "Deploy").length >= deployLimit) break;
    const positions = input.facts.deploymentPoints
      .filter(point => compatible(pick.role, point))
      .filter(point => !usedPositions.has(`${point.row},${point.col}`))
      .sort((a, b) => positionScore(pick.role, b, input.facts) - positionScore(pick.role, a, input.facts)
        || a.row - b.row || a.col - b.col);
    if (positions.length === 0) continue;
    const position = positions[Math.min(input.positionVariant, positions.length - 1)];
    usedPositions.add(`${position.row},${position.col}`);
    const cost = pick.player?.cost || COSTS[pick.role];
    actions.push({
      type: "Deploy",
      name: pick.name,
      location: [position.row, position.col],
      direction: directionFor(position, input.facts),
      costs: cost,
      ...(input.timingVariant > 0 ? { pre_delay: input.timingVariant * 500 } : {}),
    });
  }
  actions.push({ type: "SkillDaemon" });

  const requirementsMode = input.options.requirementsMode || "none";
  const script: BattleScript = {
    stage_name: input.stageCode,
    minimum_required: "v6.0.0",
    doc: {
      title: `${input.stageCode} MAAfight v2`,
      details: input.facts.summary,
    },
    opers: squad.picks.map(pick => toOper(pick, requirementsMode)),
    groups: [],
    actions,
    generatedAt: new Date().toISOString(),
    metadata: {
      source: "maafight-v2-corpus",
      difficulty: input.facts.difficulty,
      playerOperatorsUsed: Boolean(input.options.playerOperators?.size),
      operatorGaps: squad.picks.length < 12 ? [`fixed squad missing ${12 - squad.picks.length} operators`] : [],
      warnings: [...squad.warnings],
    },
    version: 3,
  };
  return { script, picks: squad.picks, warnings: squad.warnings };
}

export function isMeleeRole(role: EngineRole): boolean {
  return MELEE_ROLES.has(role);
}
