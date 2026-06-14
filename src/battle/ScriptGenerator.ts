import type { BattleScript, EnemyRoute, MapData, PlayerOperator, TacticalAnalysis } from "../types";
import { OPERATOR_POOLS, ROLE_NAMES, OperatorEntry } from "../shared/operatorDB";
import { getOperatorProfile, type OperatorProfile, type TacticalFunction } from "../data/operatorProfiles";
import { DPTimeline, estimateDeployCost } from "./DPTimeline";
import { scoreOperatorStrength, type OperatorStrengthScore } from "./OperatorStrengthScorer";
import { scoreDeploymentPositions, type PositionPurpose } from "./PositionScorer";
import type {
  BattleTask,
  DPTimelineEntry,
  OperatorSelectionCandidateTrace,
  OperatorSelectionTrace,
  PositionScore,
  PositionScoreSummary,
} from "./types";

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

interface TaskSlot {
  task: BattleTask;
  roleCandidates: string[];
  source: "battlePlan" | "fallback";
}

interface SelectedTask {
  task: BattleTask;
  role: string;
  operator: CandidateOperator;
  score: number;
  reasons: string[];
  strength?: OperatorStrengthScore;
  consideredCandidates: OperatorSelectionCandidateTrace[];
}

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

const DEPLOY_ROLE_ORDER = [
  "vanguard", "guard", "tank", "sniper", "caster", "medic", "support", "specialist",
];

const ROLE_DEFAULT_TASK: Record<string, BattleTask> = {
  vanguard: "early_dp",
  guard: "lane_hold",
  tank: "lane_block",
  sniper: "physical_dps",
  caster: "arts_damage",
  medic: "healing",
  support: "support",
  specialist: "fast_redeploy",
};

const TASK_ROLE_CANDIDATES: Record<BattleTask, string[]> = {
  early_dp: ["vanguard"],
  lane_block: ["tank", "guard"],
  lane_hold: ["guard", "tank"],
  anti_air: ["sniper"],
  physical_dps: ["sniper", "guard"],
  arts_damage: ["caster"],
  healing: ["medic"],
  boss_kill: ["caster", "guard", "sniper"],
  elite_control: ["support", "caster", "specialist"],
  support: ["support"],
  fast_redeploy: ["specialist"],
};

const TASK_FUNCTION_NEEDS: Record<BattleTask, TacticalFunction[]> = {
  early_dp: ["early_dp"],
  lane_block: ["main_tank", "healing_tank", "lane_holder"],
  lane_hold: ["lane_holder", "sustained_dps", "aoe_clear"],
  anti_air: ["anti_air", "physical_burst"],
  physical_dps: ["physical_burst", "sustained_dps"],
  arts_damage: ["arts_burst", "arts_dps", "aoe_clear"],
  healing: ["healer", "buff"],
  boss_kill: ["boss_killer", "arts_burst", "physical_burst"],
  elite_control: ["control", "debuff", "arts_burst"],
  support: ["buff", "control", "debuff"],
  fast_redeploy: ["fast_redeploy", "control", "boss_killer"],
};

export interface GeneratorConfig {
  includeSpeedUp?: boolean;
  includeRetreat?: boolean;
  autoSelectOperators?: boolean;
  deploymentTimeout?: number;
  skillDelay?: number;
  playerOperators?: Map<string, PlayerOperator>;
}

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

function buildRoleFunctionNeeds(role: string, mapData: MapData, analysis: TacticalAnalysis): TacticalFunction[] {
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

  return needs;
}

function buildFunctionNeeds(task: BattleTask, role: string, mapData: MapData, analysis: TacticalAnalysis): TacticalFunction[] {
  return dedupeFunctions([
    ...(TASK_FUNCTION_NEEDS[task] || []),
    ...buildRoleFunctionNeeds(role, mapData, analysis),
  ]);
}

function trainingScore(name: string, playerOps?: Map<string, PlayerOperator>): number {
  const op = playerOps?.get(name);
  if (!op) return 0;
  return op.elite * 1000 + op.level * 3 + op.rarity * 15 + op.potential * 2;
}

function playerInvestmentScore(name: string, playerOps?: Map<string, PlayerOperator>): number {
  const op = playerOps?.get(name);
  if (!op) return 50;
  const eliteBase = op.elite >= 2 ? 74 : op.elite === 1 ? 48 : 18;
  const maxLevel = op.elite >= 2 ? 90 : op.elite === 1 ? 80 : 50;
  const levelScore = Math.min(20, (Math.max(0, op.level) / maxLevel) * 20);
  const rarityScore = Math.max(0, Math.min(6, op.rarity)) * 0.8;
  const potentialScore = Math.max(0, Math.min(6, op.potential)) * 0.4;
  return clampScore(eliteBase + levelScore + rarityScore + potentialScore);
}

function lowInvestmentPenalty(name: string, playerOps?: Map<string, PlayerOperator>): number {
  const op = playerOps?.get(name);
  if (!op) return 0;
  if (op.elite === 0 && op.level < 50) return 20;
  if (op.elite === 1 && op.level < 40) return 8;
  return 0;
}

function functionMatchScore(profile: OperatorProfile | undefined, needs: TacticalFunction[]): number {
  if (!profile) return 0;
  return needs.reduce((score, need, index) => {
    if (!profile.functions.includes(need)) return score;
    return score + Math.max(16, 40 - index * 4);
  }, 0);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function taskFitScore(input: {
  candidate: CandidateOperator;
  profile?: OperatorProfile;
  needs: TacticalFunction[];
  directRoleMatch: boolean;
  hintedRoleMatch: boolean;
  strength: OperatorStrengthScore;
}): number {
  const functionScore = Math.min(35, functionMatchScore(input.profile, input.needs) * 0.45);
  let score = input.directRoleMatch ? 58 : input.hintedRoleMatch ? 52 : 24;
  score += functionScore;
  if (input.strength.roleStrengthScore >= 80) score += 16;
  else if (input.strength.roleStrengthScore >= 65) score += 10;
  else if (input.strength.roleStrengthScore <= 20) score -= 18;
  if (!input.profile && input.directRoleMatch) score += 8;
  return clampScore(score);
}

function costAndDeployScore(role: string, operatorName: string, playerOps?: Map<string, PlayerOperator>): number {
  const cost = estimateDeployCost(role, operatorName, playerOps);
  return clampScore(100 - cost * 2.5);
}

function weightedCandidateScore(input: {
  taskFit: number;
  strength: OperatorStrengthScore;
  investment: number;
  costDeploy: number;
  playerMode: boolean;
  penalty: number;
}): number {
  const score = input.playerMode
    ? input.taskFit * 0.30
      + input.strength.strengthScore * 0.25
      + input.strength.roleStrengthScore * 0.20
      + input.investment * 0.15
      + input.strength.automationScore * 0.05
      + input.costDeploy * 0.05
    : input.taskFit * 0.35
      + input.strength.strengthScore * 0.30
      + input.strength.roleStrengthScore * 0.25
      + input.strength.automationScore * 0.05
      + input.costDeploy * 0.05;
  return clampScore(score - input.penalty);
}

function chooseRoleForCandidate(candidate: CandidateOperator, task: BattleTask, roleCandidates: string[]): string {
  const profile = getOperatorProfile(candidate.name);
  if (roleCandidates.includes(candidate.role)) return candidate.role;
  const hinted = profile?.roleHints.find(role => roleCandidates.includes(role));
  return hinted || roleCandidates[0] || candidate.role;
}

interface CandidateTaskScore {
  role: string;
  score: number;
  reasons: string[];
  strength: OperatorStrengthScore;
  rejectedReason?: string;
}

function scoreCandidateForTask(
  candidate: CandidateOperator,
  task: BattleTask,
  roleCandidates: string[],
  mapData: MapData,
  analysis: TacticalAnalysis,
  playerOps?: Map<string, PlayerOperator>
): CandidateTaskScore {
  const role = chooseRoleForCandidate(candidate, task, roleCandidates);
  const profile = getOperatorProfile(candidate.name);
  const directRoleMatch = roleCandidates.includes(candidate.role);
  const hintedRoleMatch = Boolean(profile?.roleHints.some(hint => roleCandidates.includes(hint)));
  const strength = scoreOperatorStrength(candidate, task, { skillDaemonMode: true });
  const reasons: string[] = [];

  if (playerOps && playerOps.size > 0 && !directRoleMatch && !hintedRoleMatch) {
    return {
      role,
      score: -1000,
      strength,
      reasons,
      rejectedReason: "role mismatch for owned operator selection",
    };
  }

  const needs = buildFunctionNeeds(task, role, mapData, analysis);
  const requiredDeploy = ROLE_DEPLOY_TYPE[role] || "both";
  if (!compatibleDeployType(requiredDeploy, profile?.deployType)) {
    return {
      role,
      score: -1000,
      strength,
      reasons,
      rejectedReason: "deployment type incompatible",
    };
  }

  const functionScore = functionMatchScore(profile, needs);
  const hasTaskEvidence = directRoleMatch || hintedRoleMatch || functionScore > 0 || strength.roleStrengthScore >= 60;
  if (!hasTaskEvidence) {
    return {
      role,
      score: -1000,
      strength,
      reasons,
      rejectedReason: "no task fit evidence",
    };
  }

  const taskFit = taskFitScore({ candidate, profile, needs, directRoleMatch, hintedRoleMatch, strength });
  const investment = playerInvestmentScore(candidate.name, playerOps);
  const costDeploy = costAndDeployScore(role, candidate.name, playerOps);
  const score = weightedCandidateScore({
    taskFit,
    strength,
    investment,
    costDeploy,
    playerMode: Boolean(playerOps && playerOps.size > 0),
    penalty: lowInvestmentPenalty(candidate.name, playerOps),
  });

  reasons.push(
    `task fit ${Math.round(taskFit)}`,
    `strength ${Math.round(strength.strengthScore)}`,
    `role strength ${Math.round(strength.roleStrengthScore)}`,
    `investment ${Math.round(investment)}`,
    `automation ${Math.round(strength.automationScore)}`,
    `cost/deploy ${Math.round(costDeploy)}`
  );
  reasons.push(...strength.reasons);

  return { role, score, strength, reasons };
}

interface TaskSelectionResult {
  selected?: SelectedTask;
  trace: OperatorSelectionTrace;
}

function selectOperatorForTask(
  candidates: CandidateOperator[],
  slot: TaskSlot,
  usedNames: Set<string>,
  remainingRoleCounts: Record<string, number>,
  mapData: MapData,
  analysis: TacticalAnalysis,
  playerOps?: Map<string, PlayerOperator>
): TaskSelectionResult {
  const roleCandidates = slot.roleCandidates.filter(role => (remainingRoleCounts[role] || 0) > 0);
  if (roleCandidates.length === 0) {
    return {
      trace: {
        task: slot.task,
        reasons: ["no remaining role quota"],
        consideredCandidates: [],
      },
    };
  }

  const ranked = candidates
    .filter(op => !usedNames.has(op.name))
    .filter(op => !playerOps || playerOps.size === 0 || playerOps.has(op.name))
    .map(op => {
      const scored = scoreCandidateForTask(op, slot.task, roleCandidates, mapData, analysis, playerOps);
      return {
        op,
        role: scored.role,
        score: scored.score,
        training: trainingScore(op.name, playerOps),
        reasons: scored.reasons,
        strength: scored.strength,
        rejectedReason: scored.rejectedReason,
      };
    })
    .sort((a, b) => b.score - a.score || b.training - a.training || a.op.tier - b.op.tier);

  const consideredCandidates = ranked.slice(0, 8).map((item): OperatorSelectionCandidateTrace => ({
    name: item.op.name,
    score: Math.round(item.score),
    strengthTier: item.strength.strengthTier,
    rejectedReason: item.rejectedReason || ((remainingRoleCounts[item.role] || 0) <= 0 ? "role quota exhausted" : undefined),
  }));

  const best = ranked.find(item => !item.rejectedReason && item.score > -100 && (remainingRoleCounts[item.role] || 0) > 0);
  const trace: OperatorSelectionTrace = {
    task: slot.task,
    selected: best?.op.name,
    score: best ? Math.round(best.score) : undefined,
    reasons: best?.reasons || ["no compatible operator selected"],
    consideredCandidates,
  };

  if (!best) return { trace };
  return {
    selected: {
      task: slot.task,
      role: best.role,
      operator: best.op,
      score: best.score,
      reasons: best.reasons,
      strength: best.strength,
      consideredCandidates,
    },
    trace,
  };
}

function roleCountsFromRequirements(analysis: TacticalAnalysis): Record<string, number> {
  const req = analysis.requirements;
  return {
    vanguard: req.vanguardCount,
    guard: req.guardCount,
    tank: req.tankCount,
    sniper: req.sniperCount,
    caster: req.casterCount,
    medic: req.medicCount,
    support: req.supportCount,
    specialist: req.specialistCount,
  };
}

function buildFallbackSlots(analysis: TacticalAnalysis): TaskSlot[] {
  const counts = roleCountsFromRequirements(analysis);
  const slots: TaskSlot[] = [];
  for (const role of DEPLOY_ROLE_ORDER) {
    const count = counts[role] || 0;
    for (let i = 0; i < count; i++) {
      slots.push({ task: ROLE_DEFAULT_TASK[role], roleCandidates: [role], source: "fallback" });
    }
  }
  return slots;
}

function buildTaskSlots(analysis: TacticalAnalysis): TaskSlot[] {
  const tasks = analysis.battlePlan?.recommendedTasks || analysis.recommendedTasks || [];
  if (tasks.length === 0) return buildFallbackSlots(analysis);

  const roleCounts = roleCountsFromRequirements(analysis);
  const slots = tasks
    .map((task): TaskSlot => ({
      task,
      roleCandidates: TASK_ROLE_CANDIDATES[task] || [],
      source: "battlePlan",
    }))
    .filter(slot => slot.roleCandidates.some(role => (roleCounts[role] || 0) > 0));

  return slots.length > 0 ? slots : buildFallbackSlots(analysis);
}

function rolePurpose(role: string): PositionPurpose {
  const deployType = ROLE_DEPLOY_TYPE[role] || "both";
  return deployType === "melee" || deployType === "ranged" ? deployType : "both";
}

function canDeployToPosition(operatorName: string, role: string, row: number, col: number, mapData: MapData): boolean {
  const point = (mapData.deploymentPoints || []).find(dp => dp.row === row && dp.col === col);
  if (!point) return true;
  const deployType = getOperatorProfile(operatorName)?.deployType || ROLE_DEPLOY_TYPE[role] || "both";
  if (deployType === "both") return true;
  return point.buildableType === deployType;
}

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

function buildSelectionReason(
  selected: SelectedTask,
  mapData: MapData,
  analysis: TacticalAnalysis,
  position?: PositionScore
): string {
  const needs = buildFunctionNeeds(selected.task, selected.role, mapData, analysis);
  const profile = getOperatorProfile(selected.operator.name);
  const matched = profile ? needs.filter(need => profile.functions.includes(need)) : [];
  const taskPart = `task ${selected.task}`;
  const rolePart = ROLE_NAMES[selected.role] || selected.role;
  const positionPart = position
    ? `; position score ${Math.round(position.score)} (${position.reasons.join(", ")})`
    : "";
  const strengthPart = selected.strength
    ? `; strength ${selected.strength.strengthTier || "neutral"} score ${Math.round(selected.score)}`
    : `; score ${Math.round(selected.score)}`;

  if (matched.length > 0) {
    return `${rolePart} ${taskPart} matched functions: ${matched.join(", ")}${strengthPart}${positionPart}`;
  }
  return `${rolePart} ${taskPart} selected by role, strength, and training priority${strengthPart}${positionPart}`;
}

const KEY_TASK_MIN_ROLE_SCORE: Partial<Record<BattleTask, number>> = {
  early_dp: 75,
  anti_air: 70,
  healing: 75,
  boss_kill: 80,
};

function isLowStrengthTier(tier?: string): boolean {
  return tier === "C" || tier === "D";
}

function addStrengthWarnings(selected: SelectedTask, warnings: string[]): void {
  const strength = selected.strength;
  if (!strength?.profile) {
    warnings.push(`No strength data for ${selected.operator.name}; scored with fallback for ${selected.task}.`);
    return;
  }

  if (isLowStrengthTier(strength.strengthTier)) {
    warnings.push(`Task ${selected.task} selected low strength operator ${selected.operator.name} (${strength.strengthTier}).`);
  }

  const minRoleScore = KEY_TASK_MIN_ROLE_SCORE[selected.task];
  if (minRoleScore !== undefined && strength.roleStrengthScore < minRoleScore) {
    warnings.push(`${selected.task} lacks a high-strength dedicated pick; selected ${selected.operator.name} with role strength ${Math.round(strength.roleStrengthScore)}.`);
  }

  if (selected.task === "boss_kill" && strength.roleStrengthScore < 80) {
    warnings.push(`boss_kill lacks high-strength burst output; selected ${selected.operator.name}.`);
  }
  if (selected.task === "anti_air" && strength.roleStrengthScore < 70) {
    warnings.push(`anti_air lacks a reliable high-strength anti-air pick; selected ${selected.operator.name}.`);
  }
  if (selected.task === "early_dp" && strength.roleStrengthScore < 75) {
    warnings.push(`early_dp lacks a reliable DP engine; selected ${selected.operator.name}.`);
  }
  if (selected.task === "healing" && strength.roleStrengthScore < 75) {
    warnings.push(`healing lacks a high-strength medic/protection pick; selected ${selected.operator.name}.`);
  }
  if (strength.profile.tags.includes("high_precision_required")) {
    warnings.push(`${selected.operator.name} is marked high_precision_required; SkillDaemon timing may be less stable.`);
  }
}

function addDeployWithTimeline(input: {
  actions: BattleScript["actions"];
  timeline: DPTimeline;
  dpEntries: DPTimelineEntry[];
  operatorName: string;
  role: string;
  task: BattleTask;
  cost: number;
  location: [number, number];
  direction: string;
  minGap: number;
  hasPriorDeploy: boolean;
}): void {
  const afterTime = input.hasPriorDeploy
    ? input.timeline.currentTime + Math.max(0, input.minGap || 0)
    : input.timeline.currentTime;
  const deployTime = input.timeline.nextDeployableTime(input.cost, afterTime);
  const waitBefore = Math.max(0, Math.ceil(deployTime - input.timeline.currentTime));
  const estimatedDP = input.timeline.getEstimatedDPAt(deployTime);

  if (waitBefore > 0) {
    input.actions.push({ type: "Wait", time: waitBefore });
  }

  input.actions.push({
    type: "Deploy",
    name: input.operatorName,
    location: input.location,
    direction: input.direction,
  });

  input.timeline.commitDeploy(input.cost, deployTime);
  input.dpEntries.push({
    operatorName: input.operatorName,
    role: input.role,
    task: input.task,
    cost: input.cost,
    earliestTime: Math.round(afterTime),
    deployTime: Math.round(deployTime),
    waitBefore,
    estimatedDP: Math.round(estimatedDP),
  });
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
  const operatorGaps: string[] = [];
  const deploymentReasons: Record<string, string> = {};
  const positionScoreSummary: PositionScoreSummary[] = [];
  const operatorSelectionTrace: OperatorSelectionTrace[] = [];
  const dpEntries: DPTimelineEntry[] = [];
  const warnings = [...(tacticalAnalysis.battlePlan?.warnings || [])];

  if (cfg.includeSpeedUp) {
    actions.push({ type: "SpeedUp" });
  }

  const candidates = buildCandidatePool();
  const slots = buildTaskSlots(tacticalAnalysis);
  const remainingRoleCounts = roleCountsFromRequirements(tacticalAnalysis);
  const usedNames = new Set<string>();
  const selectedTasks: SelectedTask[] = [];

  for (const slot of slots) {
    const selection = selectOperatorForTask(
      candidates,
      slot,
      usedNames,
      remainingRoleCounts,
      mapData,
      tacticalAnalysis,
      playerOps
    );
    operatorSelectionTrace.push(selection.trace);
    const selected = selection.selected;

    if (!selected) {
      if (playerOps && playerOps.size > 0) {
        const roles = slot.roleCandidates.map(role => ROLE_NAMES[role] || role).join("/");
        operatorGaps.push(`${slot.task} (${roles}): need 1, selected 0`);
      }
      continue;
    }

    selectedTasks.push(selected);
    addStrengthWarnings(selected, warnings);
    usedNames.add(selected.operator.name);
    remainingRoleCounts[selected.role] = Math.max(0, (remainingRoleCounts[selected.role] || 0) - 1);
  }

  if (selectedTasks.length > 12) {
    selectedTasks.length = 12;
  }

  const selectedByRole = new Map<string, CandidateOperator[]>();
  for (const selected of selectedTasks) {
    const list = selectedByRole.get(selected.role) || [];
    list.push(selected.operator);
    selectedByRole.set(selected.role, list);
  }

  for (const role of DEPLOY_ROLE_ORDER) {
    const selected = selectedByRole.get(role);
    if (!selected || selected.length === 0) continue;
    groups.push({
      name: ROLE_NAMES[role] || role,
      opers: buildCopilotOperList(selected.map(op => ({ name: op.name, skill: op.skill })), playerOps),
    });
  }

  const usedPositions = new Set<string>();
  const corePositions: Array<{ row: number; col: number }> = [];
  const dpTimeline = DPTimeline.fromMapData(mapData);
  let hasPriorDeploy = false;

  for (const selected of selectedTasks) {
    const profileDeployType = getOperatorProfile(selected.operator.name)?.deployType;
    const purpose = profileDeployType && profileDeployType !== "both"
      ? profileDeployType
      : rolePurpose(selected.role);
    const scoredPositions = scoreDeploymentPositions({
      mapData,
      task: selected.task,
      purpose,
      usedPositions,
      corePositions,
      limit: 5,
    });
    const position = scoredPositions.find(candidate =>
      canDeployToPosition(selected.operator.name, selected.role, candidate.row, candidate.col, mapData)
    );

    positionScoreSummary.push({
      operatorName: selected.operator.name,
      task: selected.task,
      role: selected.role,
      selected: position,
      topCandidates: scoredPositions,
    });

    if (!position) {
      warnings.push(`No compatible deployment position for ${selected.task} (${selected.operator.name}).`);
      continue;
    }

    const location: [number, number] = [position.row, position.col];
    const direction = inferDirection(position, mapData.routes);
    const cost = estimateDeployCost(selected.role, selected.operator.name, playerOps);

    addDeployWithTimeline({
      actions,
      timeline: dpTimeline,
      dpEntries,
      operatorName: selected.operator.name,
      role: selected.role,
      task: selected.task,
      cost,
      location,
      direction,
      minGap: cfg.deploymentTimeout || 0,
      hasPriorDeploy,
    });

    usedPositions.add(`${position.row},${position.col}`);
    if (selected.task === "early_dp" || selected.task === "lane_block" || selected.task === "lane_hold") {
      corePositions.push({ row: position.row, col: position.col });
    }
    deploymentReasons[selected.operator.name] = buildSelectionReason(selected, mapData, tacticalAnalysis, position);
    hasPriorDeploy = true;
  }

  const hasDeploy = actions.some(a => a.type === "Deploy");
  if (hasDeploy) {
    actions.push({ type: "SkillDaemon" });
  }

  const dpTimelineSummary = {
    initialDP: dpTimeline.initialDP,
    dpPerSecond: dpTimeline.dpPerSecond,
    entries: dpEntries,
    warnings,
  };

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
      battlePlan: tacticalAnalysis.battlePlan,
      pressureWindows: tacticalAnalysis.pressureWindows || tacticalAnalysis.battlePlan?.pressureWindows,
      recommendedTasks: tacticalAnalysis.recommendedTasks || tacticalAnalysis.battlePlan?.recommendedTasks,
      positionScoreSummary,
      dpTimelineSummary,
      operatorSelectionTrace,
      warnings,
    },
  };
}
