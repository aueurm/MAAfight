import { exportToCopilotFormat } from "../copilot/ScriptExporter";
import { validateMAAProtocol } from "../copilot/MAAProtocolValidator";
import { validateScript } from "../copilot/ScriptValidator";
import { type BattleAction, validateBattleDsl } from "../copilot/battleDsl";
import { parseDeepSeekBattleDsl } from "./BattleDslParser";
import type { StageFacts } from "../engine/types";
import type { BattleScript, BattleScriptAction, MapData, PlayerOperator } from "../types";

const DIRECTIONS = new Set(["Up", "Down", "Left", "Right", "None"]);
const MAX_ATTEMPTS = 3;

export interface DeepSeekCandidate {
  stageId: string;
  operators: Array<{ name: string; skill: number; skillUsage: number }>;
  actions: BattleAction[];
}

interface PlanningCombatOperator {
  position: "MELEE" | "RANGED";
  role?: string;
  subProfession?: string | null;
  skills: Array<{
    unlockPhase: number;
    levels: Array<{
      rank: number;
      skillType: string;
      maxTargets?: number;
      metrics?: { burstDps?: number; cycleDps?: number | null };
    }>;
  }>;
}

type Facing = "Up" | "Down" | "Left" | "Right";

interface BlueGateFront {
  goal: { x: number; y: number };
  blockingPoints: Array<{
    x: number;
    y: number;
    direction: Facing;
    safeSupportPoints: Array<{ x: number; y: number; direction: Facing; distance: number; routeDistance: number }>;
  }>;
}

export interface DeepSeekCompileEnvironment {
  stageName: string;
  mapData: MapData;
  players: Map<string, PlayerOperator>;
  getCombatOperatorByName(name: string): PlanningCombatOperator | undefined;
  facts?: StageFacts;
  now?: () => Date;
}

export interface DeepSeekCompileResult {
  valid: boolean;
  errors: string[];
  script?: BattleScript;
  copilotJson?: string;
  dslValidation?: ReturnType<typeof validateBattleDsl>;
  scriptValidation?: ReturnType<typeof validateScript>;
  protocolValidation?: ReturnType<typeof validateMAAProtocol>;
}

export interface DeepSeekFeedback {
  previousAttempt: number | null;
  errors: string[];
}

export interface DeepSeekGenerationResult extends DeepSeekCompileResult {
  attempts: number;
}

export interface DeepSeekGenerationInput extends DeepSeekCompileEnvironment {
  requestCandidate(input: { context: unknown; feedback: DeepSeekFeedback }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function candidateFrom(value: unknown): DeepSeekCandidate | null {
  if (!isRecord(value) || typeof value.stageId !== "string" || !Array.isArray(value.operators) || !Array.isArray(value.actions)) return null;
  return value as unknown as DeepSeekCandidate;
}

function validationResult(errors: string[], extra: Omit<DeepSeekCompileResult, "valid" | "errors"> = {}): DeepSeekCompileResult {
  return { valid: errors.length === 0, errors, ...extra };
}

function skillType(combat: PlanningCombatOperator | undefined, skill: number, skillLevel?: number): string | undefined {
  const levels = combat?.skills[skill - 1]?.levels || [];
  return levels.find(level => level.rank === (skillLevel ?? 10))?.skillType || levels.at(-1)?.skillType;
}

function skillAnnihilationPower(combat: PlanningCombatOperator | undefined, skill: number, skillLevel?: number): number {
  const levels = combat?.skills[skill - 1]?.levels || [];
  const level = levels.find(item => item.rank === (skillLevel ?? 10)) || levels.at(-1);
  return Math.round(Math.max(level?.metrics?.burstDps || 0, level?.metrics?.cycleDps || 0) * (level?.maxTargets || 1));
}

function hasNativeCondition(action: Record<string, unknown>): boolean {
  return ["kills", "costs", "costChanges", "cost_changes", "cooling", "timeElapsed", "time_elapsed"].some(key => action[key] !== undefined);
}

function hasTimeElapsed(action: BattleAction): boolean {
  const raw = action as unknown as Record<string, unknown>;
  return raw.timeElapsed !== undefined || raw.time_elapsed !== undefined;
}

function conditions(action: BattleAction): Pick<BattleScriptAction, "kills" | "costs" | "cost_changes" | "cooling" | "time_elapsed"> {
  return {
    ...(action.kills !== undefined ? { kills: action.kills } : {}),
    ...(action.costs !== undefined ? { costs: action.costs } : {}),
    ...(action.costChanges !== undefined ? { cost_changes: action.costChanges } : {}),
    ...(action.cooling !== undefined ? { cooling: action.cooling } : {}),
    ...(action.timeElapsed !== undefined ? { time_elapsed: action.timeElapsed } : {}),
  };
}

function facingIncomingEnemy(point: { row: number; col: number }, goal: { row: number; col: number }): Facing | undefined {
  if (goal.col > point.col) return "Left";
  if (goal.col < point.col) return "Right";
  if (goal.row > point.row) return "Up";
  if (goal.row < point.row) return "Down";
  return undefined;
}

function buildBlueGateFronts(input: DeepSeekCompileEnvironment): BlueGateFront[] {
  const routeKeys = new Set((input.facts?.routeCells || []).map(point => `${point.row},${point.col}`));
  const deploymentByKey = new Map(input.mapData.deploymentPoints.map(point => [`${point.row},${point.col}`, point]));
  const blueGateFronts = new Map<string, BlueGateFront>();
  const routesByGoal = new Map<string, typeof input.mapData.routes>();

  for (const route of input.mapData.routes) {
    if (route.motionMode !== "walk") continue;
    const key = `${route.endPosition.row},${route.endPosition.col}`;
    const routes = routesByGoal.get(key) || [];
    routes.push(route);
    routesByGoal.set(key, routes);
  }

  for (const [key, routes] of routesByGoal) {
    const goal = routes[0].endPosition;
    const entry: BlueGateFront = { goal: { x: goal.col, y: goal.row }, blockingPoints: [] };
    const adjacent = input.mapData.deploymentPoints.filter(point =>
      point.buildableType !== "ranged" && Math.abs(point.row - goal.row) + Math.abs(point.col - goal.col) === 1
    );
    const roadAdjacent = adjacent.filter(point => input.mapData.tiles[point.row]?.[point.col]?.key === "road");
    const entrances = roadAdjacent.length ? roadAdjacent : adjacent;

    for (const point of entrances) {
      const direction = facingIncomingEnemy(point, goal);
      if (direction) entry.blockingPoints.push({ x: point.col, y: point.row, direction, safeSupportPoints: [] });
    }

    if (!entry.blockingPoints.length) for (const route of routes) {
      const path = [route.startPosition, ...route.checkpoints, route.endPosition];
      for (let index = path.length - 2; index >= 0; index--) {
        const point = deploymentByKey.get(`${path[index].row},${path[index].col}`);
        const direction = facingIncomingEnemy(path[index], path[index + 1]);
        if (!point || point.buildableType === "ranged" || !direction) continue;
        if (!entry.blockingPoints.some(cell => cell.x === point.col && cell.y === point.row)) {
          entry.blockingPoints.push({ x: point.col, y: point.row, direction, safeSupportPoints: [] });
        }
        break;
      }
    }

    for (const front of entry.blockingPoints) {
      front.safeSupportPoints = input.mapData.deploymentPoints.flatMap(point => {
        if (point.buildableType !== "ranged") return [];
        const dx = front.x - point.col;
        const dy = front.y - point.row;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance === 0 || distance > 4) return [];
        const direction: Facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "Right" : "Left") : (dy > 0 ? "Down" : "Up");
        const routeDistance = Math.min(...[...routeKeys].map(cell => {
          const [row, col] = cell.split(",").map(Number);
          return Math.abs(row - point.row) + Math.abs(col - point.col);
        }), 99);
        return [{ x: point.col, y: point.row, direction, distance, routeDistance }];
      }).sort((left, right) => right.routeDistance - left.routeDistance || left.distance - right.distance).slice(0, 6);
    }
    blueGateFronts.set(key, entry);
  }

  return [...blueGateFronts.values()];
}

export function buildDeepSeekContext(input: DeepSeekCompileEnvironment): unknown {
  const routeKeys = new Set((input.facts?.routeCells || []).map(point => `${point.row},${point.col}`));
  const goalKeys = new Set((input.facts?.goalCells || []).map(point => `${point.row},${point.col}`));
  const chokeKeys = new Set((input.facts?.chokeCells || []).map(point => `${point.row},${point.col}`));
  const blueGateFronts = buildBlueGateFronts(input);
  const roster = [...input.players.values()].flatMap(player => {
    if (!player.own || player.elite !== 2) return [];
    const combat = input.getCombatOperatorByName(player.name);
    if (!combat) return [];
    return [{
      name: player.name,
      elite: player.elite,
      level: player.level,
      rarity: player.rarity,
      position: combat.position,
      role: combat.role,
      subProfession: combat.subProfession,
      skills: combat.skills.flatMap((skill, index) => {
        if (skill.unlockPhase > player.elite) return [];
        const level = skill.levels.find(item => item.rank === (player.skillLevel ?? 10)) || skill.levels.at(-1);
        const power = Math.round(Math.max(level?.metrics?.burstDps || 0, level?.metrics?.cycleDps || 0) * (level?.maxTargets || 1));
        return [{
          index: index + 1,
          unlockPhase: skill.unlockPhase,
          skillType: skillType(combat, index + 1, player.skillLevel) || "UNKNOWN",
          ...(power > 0 ? { annihilationPower: power } : {}),
          ...(level?.maxTargets ? { maxTargets: level.maxTargets } : {}),
        }];
      }),
    }];
  });
  return {
    stageId: input.stageName,
    coordinateConvention: "x=column, y=row; exported MAA coordinates are converted after validation",
    allowedOperatorNames: roster.map(operator => operator.name),
    stage: {
      characterLimit: input.mapData.options.characterLimit,
      initialCost: input.mapData.options.initialCost,
      summary: input.facts?.summary,
      pressureWindows: input.facts?.pressureWindows || [],
      blueGateFronts,
      deploymentPoints: input.mapData.deploymentPoints.map(point => ({
        x: point.col,
        y: point.row,
        type: point.buildableType,
        onRoute: routeKeys.has(`${point.row},${point.col}`),
        isGoal: goalKeys.has(`${point.row},${point.col}`),
        isChoke: chokeKeys.has(`${point.row},${point.col}`),
      })),
      routes: input.mapData.routes.map(route => ({
        motionMode: route.motionMode,
        path: [route.startPosition, ...route.checkpoints, route.endPosition].map(point => ({ x: point.col, y: point.row })),
      })),
      enemies: input.mapData.enemyDetails,
    },
    roster,
  };
}

export function compileDeepSeekCandidate(rawCandidate: unknown, environment: DeepSeekCompileEnvironment): DeepSeekCompileResult {
  const parsedDsl = isRecord(rawCandidate) && "battleDsl" in rawCandidate ? parseDeepSeekBattleDsl(rawCandidate.battleDsl) : null;
  if (parsedDsl && !parsedDsl.valid) return validationResult(parsedDsl.errors.map(error => `INVALID_BATTLE_DSL: ${error}`));
  const candidate = parsedDsl?.candidate ? { stageId: environment.stageName, ...parsedDsl.candidate } : candidateFrom(rawCandidate);
  if (!candidate) return validationResult(["INVALID_CANDIDATE: expected stageId, operators, and actions"]);
  const errors: string[] = [];
  if (candidate.stageId !== environment.stageName) errors.push(`INVALID_STAGE: expected ${environment.stageName}`);
  if (candidate.operators.length !== 12) errors.push("INVALID_SQUAD_SIZE: expected exactly 12 operators");
  if (!candidate.actions.length) return validationResult([...errors, "INVALID_ACTIONS: expected a non-empty action array"]);

  const highPressure = (environment.facts?.bossCount || 0) > 0;
  const selected = new Map<string, { skill: number; skillUsage: number; combat?: PlanningCombatOperator; skillType?: string; skillLevel?: number; skillPower: number }>();
  for (const operator of candidate.operators) {
    if (!operator || typeof operator.name !== "string") {
      errors.push("INVALID_OPERATOR: name is required");
      continue;
    }
    if (selected.has(operator.name)) errors.push(`DUPLICATE_OPERATOR: ${operator.name}`);
    const player = environment.players.get(operator.name);
    const combat = environment.getCombatOperatorByName(operator.name);
    if (!player?.own || !combat) errors.push(`UNAVAILABLE_OPERATOR: ${operator.name}`);
    if (player?.elite !== 2) errors.push(`NON_ELITE_2_OPERATOR: ${operator.name}`);
    const skill = Number(operator.skill);
    const skillRecord = combat?.skills[skill - 1];
    if (!Number.isInteger(skill) || !skillRecord || skillRecord.unlockPhase > (player?.elite ?? -1)) {
      errors.push(`INVALID_SKILL: ${operator.name} skill ${operator.skill}`);
    }
    if (!Number.isInteger(operator.skillUsage) || operator.skillUsage < 0 || operator.skillUsage > 3) {
      errors.push(`INVALID_SKILL_USAGE: ${operator.name}`);
    }
    selected.set(operator.name, {
      skill,
      skillUsage: Number(operator.skillUsage),
      combat,
      skillType: skillType(combat, skill, player?.skillLevel),
      skillLevel: player?.skillLevel,
      skillPower: skillAnnihilationPower(combat, skill, player?.skillLevel),
    });
  }

  if (candidate.actions.some(action => action?.type === "SkillUse") && candidate.actions.some(action => action?.type === "SkillDaemon")) {
    errors.push("MIXED_SKILL_CONTROL: SkillUse and SkillDaemon are mutually exclusive");
  }
  const manualSkillActions = candidate.actions.filter(action => action?.type === "SkillUse");
  if (highPressure && manualSkillActions.length !== 1) {
    errors.push(`BOSS_MANUAL_SKILL_REQUIRED: expected exactly one SkillUse, got ${manualSkillActions.length}`);
  }
  if (highPressure && manualSkillActions.length === 1) {
    const manualName = manualSkillActions[0].operatorId;
    const manual = manualName ? selected.get(manualName) : undefined;
    const squadMaximum = Math.max(0, ...[...selected.values()].flatMap(operator =>
      (operator.combat?.skills || []).flatMap((_, index) =>
        skillType(operator.combat, index + 1, operator.skillLevel) === "MANUAL"
          ? [skillAnnihilationPower(operator.combat, index + 1, operator.skillLevel)]
          : []
      )
    ));
    if (squadMaximum > 0 && (!manual || manual.skillPower < squadMaximum * 0.8)) {
      errors.push(`BOSS_MANUAL_SKILL_TOO_WEAK: ${manualName || "<missing>"} annihilationPower=${manual?.skillPower || 0}; selected squad maximum MANUAL annihilationPower=${squadMaximum}; choose a high-burst skill`);
    }
  }

  const active = new Map<string, string>();
  const occupied = new Set<string>();
  for (const [index, action] of candidate.actions.entries()) {
    const rawAction = action as unknown as Record<string, unknown>;
    const type = rawAction.type;
    const name = rawAction.operatorId;
    if (type === "Deploy") {
      if (typeof name !== "string" || !selected.has(name)) errors.push(`UNSELECTED_OPERATOR: action ${index}`);
      if (typeof name === "string" && active.has(name)) errors.push(`ALREADY_DEPLOYED: ${name}`);
      if (!DIRECTIONS.has(String(rawAction.direction))) errors.push(`INVALID_DIRECTION: action ${index}`);
      const point = environment.mapData.deploymentPoints.find(item => item.row === rawAction.y && item.col === rawAction.x);
      if (!point) errors.push(`INVALID_DEPLOY_CELL: action ${index}`);
      const position = typeof name === "string" ? selected.get(name)?.combat?.position : undefined;
      if (point && position === "MELEE" && point.buildableType === "ranged") errors.push(`POSITION_MISMATCH: ${name}`);
      if (point && position === "RANGED" && point.buildableType === "melee") errors.push(`POSITION_MISMATCH: ${name}`);
      const cell = `${rawAction.y},${rawAction.x}`;
      if (occupied.has(cell)) errors.push(`OCCUPIED_CELL: action ${index}`);
      if (typeof name === "string" && point && !active.has(name) && !occupied.has(cell)) {
        active.set(name, cell);
        occupied.add(cell);
        if (active.size > environment.mapData.options.characterLimit) {
          errors.push(`CHARACTER_LIMIT: action ${index} Deploy ${name} active=${active.size}/${environment.mapData.options.characterLimit}`);
        }
      }
    } else if (type === "SkillUse") {
      if (typeof name !== "string" || !active.has(name)) errors.push(`SKILL_OPERATOR_NOT_ACTIVE: action ${index} name=${name || "<missing>"}`);
      const selectedSkill = typeof name === "string" ? selected.get(name)?.skill : undefined;
      if (rawAction.skillIndex !== undefined && rawAction.skillIndex !== selectedSkill) errors.push(`SKILL_MISMATCH: action ${index}`);
      const selectedType = typeof name === "string" ? selected.get(name)?.skillType : undefined;
      if (selectedType && selectedType !== "MANUAL") errors.push(`NON_MANUAL_SKILL_USE: ${name} skill ${selectedSkill}`);
      if (typeof name === "string" && selected.get(name)?.skillUsage !== 2) errors.push(`MANUAL_SKILL_USAGE_REQUIRED: ${name} must use skillUsage=2`);
    } else if (type === "Retreat") {
      if (typeof name !== "string" || !active.has(name)) errors.push(`RETREAT_OPERATOR_NOT_ACTIVE: action ${index}`);
      if (!(Number(rawAction.delay) > 0) && !hasNativeCondition(rawAction)) errors.push(`UNTIMED_RETREAT: action ${index}`);
      if (typeof name === "string") {
        const cell = active.get(name);
        if (cell) occupied.delete(cell);
        active.delete(name);
      }
    }
  }
  for (const { goal, blockingPoints } of buildBlueGateFronts(environment)) for (const front of blockingPoints) {
    const covered = candidate.actions.some(action => action?.type === "Deploy"
      && action.x === front.x && action.y === front.y && action.direction === front.direction
      && selected.get(action.operatorId || "")?.combat?.position === "MELEE");
    if (!covered) {
      errors.push(`MISSING_BLUE_GATE_FRONT: goal (${goal.x},${goal.y}) needs MELEE deploy(${front.x},${front.y},${front.direction})`);
    }
    if (highPressure && front.safeSupportPoints.length) {
      const supportKeys = new Set(front.safeSupportPoints.map(point => `${point.x},${point.y},${point.direction}`));
      const hasMedic = candidate.actions.some(action => action?.type === "Deploy"
        && supportKeys.has(`${action.x},${action.y},${action.direction}`)
        && selected.get(action.operatorId || "")?.combat?.role === "medic");
      if (!hasMedic) {
        errors.push(`MISSING_BLUE_GATE_HEALER: goal (${goal.x},${goal.y}) needs RANGED medic at a safeSupportPoint`);
      }
    }
  }
  if (candidate.actions.filter(action => action?.type === "End").length !== 1 || candidate.actions.at(-1)?.type !== "End") {
    errors.push("INVALID_END: End must appear exactly once at the end");
  }

  const normalizedActions: BattleAction[] = candidate.actions.some(hasTimeElapsed)
    ? [{ type: "ResetStopwatch", delay: 0 }, ...candidate.actions]
    : candidate.actions;
  const dsl = { stageId: environment.stageName, actions: normalizedActions };
  const dslValidation = validateBattleDsl(dsl);
  errors.push(...dslValidation.errors.map(error => `BATTLE_DSL_${error.code}: ${error.message}`));
  if (errors.length) return validationResult(errors, { dslValidation });

  const delay = (action: BattleAction) => Number(action.delay) > 0 ? { pre_delay: Number(action.delay) } : {};
  const actions: BattleScriptAction[] = [];
  for (const action of normalizedActions) {
    if (action.type === "End") continue;
    if (action.type === "SpeedUp" || action.type === "SkillDaemon" || action.type === "ResetStopwatch") actions.push({ type: action.type, ...delay(action) });
    else if (action.type === "Deploy") actions.push({ type: "Deploy", name: action.operatorId!, location: [action.y!, action.x!], direction: action.direction, ...delay(action) });
    else if (action.type === "SkillUse") actions.push({ type: "Skill", name: action.operatorId!, ...(action.skillIndex !== undefined ? { skill: action.skillIndex } : {}), ...conditions(action), ...delay(action) });
    else actions.push({ type: "Retreat", name: action.operatorId!, ...conditions(action), ...delay(action) });
  }
  const script: BattleScript = {
    stage_name: environment.stageName,
    minimum_required: "v6.0.0",
    doc: { title: `${environment.stageName} DeepSeek candidate`, details: "Internal candidate; not rehearsal-verified." },
    opers: candidate.operators.map(operator => ({ name: operator.name, skill: operator.skill, skill_usage: operator.skillUsage })),
    groups: [],
    actions,
    generatedAt: (environment.now || (() => new Date()))().toISOString(),
    metadata: { source: "maafight-deepseek-core" },
    version: 3,
  };
  const scriptValidation = validateScript(script, environment.mapData);
  const protocolValidation = validateMAAProtocol(script);
  errors.push(...scriptValidation.errors.map(error => `SCRIPT_${error.code}: ${error.message}`));
  errors.push(...protocolValidation.errors.map(error => `PROTOCOL_${error.code}: ${error.message}`));
  return validationResult(errors, {
    dslValidation,
    scriptValidation,
    protocolValidation,
    script,
    copilotJson: exportToCopilotFormat(script),
  });
}

export async function generateDeepSeekScript(input: DeepSeekGenerationInput): Promise<DeepSeekGenerationResult> {
  const context = buildDeepSeekContext(input);
  let feedback: DeepSeekFeedback = { previousAttempt: null, errors: [] };
  let latest: DeepSeekCompileResult = validationResult(["DeepSeek did not return a candidate"]);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = await input.requestCandidate({ context, feedback });
    latest = compileDeepSeekCandidate(candidate, input);
    if (latest.valid) return { ...latest, attempts: attempt };
    feedback = { previousAttempt: attempt, errors: latest.errors };
  }
  return { ...latest, attempts: MAX_ATTEMPTS };
}
