import {
  DELAY_BUCKETS,
  DIRECTIONS,
  normalizeDelayToBucket,
  type BattleAction,
  type DelayBucket,
  type Direction,
} from "./battleDsl";

export type CandidateSource =
  | "public_prior"
  | "legal_geometry"
  | "random_exploration"
  | "legacy_rule"
  | "failure_avoidance"
  | "skill"
  | "end";

export interface CandidateAction {
  action: BattleAction;
  source: CandidateSource;
  scoreHint?: number;
  meta?: Record<string, unknown>;
}

export interface CandidateEnumeratorConfig {
  maxCandidates?: number;
  seed?: number;
  delayBuckets?: number[];
  sourceQuota?: {
    publicPrior?: number;
    legalGeometry?: number;
    randomExploration?: number;
    legacyRule?: number;
    failureAvoidance?: number;
    skill?: number;
    end?: number;
  };
}

export interface StageFeatures {
  stageId?: string;
  stageName?: string;
  rows?: number;
  cols?: number;
  characterLimit?: number;
  map?: Record<string, unknown>;
  deploymentPoints?: Array<{ x?: number; y?: number; row?: number; col?: number; buildableType?: string }>;
}

export interface OperatorFeatures {
  operatorId?: string;
  name?: string;
  position?: "MELEE" | "RANGED" | "melee" | "ranged";
  [key: string]: unknown;
}

export interface CandidateEnumerationInput {
  stageFeatures: StageFeatures;
  rosterFeatures: OperatorFeatures[];
  partialActions: BattleAction[];
  publicPriorActions?: BattleAction[];
  legacyRuleActions?: BattleAction[];
}

type Point = { x: number; y: number; buildableType?: string };
type Rng = () => number;

const DEFAULT_MAX = 500;
const DEFAULT_QUOTA = {
  publicPrior: 0.4,
  legalGeometry: 0.25,
  randomExploration: 0.15,
  legacyRule: 0.1,
  failureAvoidance: 0.1,
  skill: 32,
  end: 1,
};

function finiteInt(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function pointKey(point: Pick<Point, "x" | "y">): string {
  return `${point.x},${point.y}`;
}

function operatorId(operator: OperatorFeatures): string | undefined {
  const id = operator.operatorId || operator.name;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function normalizeBuckets(values?: number[]): DelayBucket[] {
  const buckets = (values && values.length ? values : [...DELAY_BUCKETS]).map(normalizeDelayToBucket);
  return [...new Set(buckets)];
}

function seededRng(seed = 1): Rng {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: T[], rng: Rng): T | undefined {
  return items.length ? items[Math.floor(rng() * items.length)] : undefined;
}

function rows(input: CandidateEnumerationInput): number | undefined {
  return finiteInt(input.stageFeatures.rows ?? input.stageFeatures.map?.rows);
}

function cols(input: CandidateEnumerationInput): number | undefined {
  return finiteInt(input.stageFeatures.cols ?? input.stageFeatures.map?.cols);
}

function pointFrom(value: unknown): Point | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const x = finiteInt(raw.x ?? raw.col);
  const y = finiteInt(raw.y ?? raw.row);
  if (x === undefined || y === undefined) return null;
  return {
    x,
    y,
    ...(typeof raw.buildableType === "string" ? { buildableType: raw.buildableType.toLowerCase() } : {}),
  };
}

function legalCells(input: CandidateEnumerationInput): Point[] {
  const direct = input.stageFeatures.deploymentPoints || [];
  const fromMap = Array.isArray(input.stageFeatures.map?.deploymentPoints) ? input.stageFeatures.map.deploymentPoints : [];
  const points = [...direct, ...fromMap].map(pointFrom).filter((point): point is Point => Boolean(point));
  return [...new Map(points.map(point => [pointKey(point), point])).values()];
}

function deployedState(partialActions: BattleAction[]): { active: Set<string>; occupied: Set<string> } {
  const activeCells = new Map<string, string>();
  for (const action of partialActions) {
    if (action.type === "Deploy" && action.operatorId) {
      if (Number.isInteger(action.x) && Number.isInteger(action.y)) {
        activeCells.set(action.operatorId, pointKey({ x: action.x!, y: action.y! }));
      }
    }
    if (action.type === "Retreat" && action.operatorId) activeCells.delete(action.operatorId);
  }
  return {
    active: new Set(activeCells.keys()),
    occupied: new Set(activeCells.values()),
  };
}

function availableOperators(input: CandidateEnumerationInput): Array<{ id: string; feature: OperatorFeatures }> {
  const state = deployedState(input.partialActions);
  return input.rosterFeatures
    .map(feature => ({ id: operatorId(feature), feature }))
    .filter((item): item is { id: string; feature: OperatorFeatures } => Boolean(item.id))
    .filter(item => !state.active.has(item.id));
}

function deployedOperators(input: CandidateEnumerationInput): string[] {
  return [...deployedState(input.partialActions).active];
}

export function normalizeAction(action: BattleAction): BattleAction {
  const normalized: BattleAction = { type: action.type, delay: normalizeDelayToBucket(action.delay ?? 0) };
  if (action.operatorId) normalized.operatorId = action.operatorId.trim();
  if (action.x !== undefined) normalized.x = finiteInt(action.x);
  if (action.y !== undefined) normalized.y = finiteInt(action.y);
  if (action.direction) normalized.direction = DIRECTIONS.find(direction => direction.toLowerCase() === String(action.direction).toLowerCase()) ?? action.direction;
  if (action.skillIndex !== undefined) normalized.skillIndex = finiteInt(action.skillIndex);
  return normalized;
}

export function actionKey(action: BattleAction): string {
  return JSON.stringify(normalizeAction(action));
}

function tileFitsOperator(point: Point, operator: OperatorFeatures | undefined): boolean {
  const tile = point.buildableType;
  const position = String(operator?.position || "").toLowerCase();
  if (!tile || tile === "all") return true;
  if (!position) return true;
  return tile === position;
}

export function isBasicallyLegalAction(
  action: BattleAction,
  input: CandidateEnumerationInput,
  config: CandidateEnumeratorConfig = {}
): boolean {
  const buckets = normalizeBuckets(config.delayBuckets);
  if (!buckets.includes((action.delay ?? 0) as DelayBucket)) return false;
  const normalized = normalizeAction(action);
  if (normalized.type === "End" || normalized.type === "SkillDaemon") return true;
  if (normalized.type === "SkillUse") return Boolean(normalized.operatorId && deployedOperators(input).includes(normalized.operatorId));
  if (normalized.type !== "Deploy") {
    return normalized.type === "Retreat" && Boolean(normalized.operatorId && deployedOperators(input).includes(normalized.operatorId));
  }
  if (!normalized.operatorId || !Number.isInteger(normalized.x) || !Number.isInteger(normalized.y)) return false;
  if (!DIRECTIONS.includes(normalized.direction as Direction)) return false;

  const roster = new Map(input.rosterFeatures.map(feature => [operatorId(feature), feature]).filter((entry): entry is [string, OperatorFeatures] => Boolean(entry[0])));
  const operator = roster.get(normalized.operatorId);
  if (!operator || !availableOperators(input).some(item => item.id === normalized.operatorId)) return false;
  const deployLimit = finiteInt(input.stageFeatures.characterLimit ?? input.stageFeatures.map?.characterLimit);
  if (deployLimit !== undefined && deployedState(input.partialActions).active.size >= deployLimit) return false;

  const width = cols(input);
  const height = rows(input);
  if (normalized.x! < 0 || normalized.y! < 0) return false;
  if (width !== undefined && normalized.x! >= width) return false;
  if (height !== undefined && normalized.y! >= height) return false;
  if (deployedState(input.partialActions).occupied.has(pointKey({ x: normalized.x!, y: normalized.y! }))) return false;

  const cells = legalCells(input);
  const point = cells.find(cell => cell.x === normalized.x && cell.y === normalized.y);
  return Boolean(point && tileFitsOperator(point, operator));
}

export function dedupeCandidateActions(candidates: CandidateAction[]): CandidateAction[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = actionKey(candidate.action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asCandidate(action: BattleAction, source: CandidateSource, scoreHint?: number): CandidateAction {
  return { action: normalizeAction(action), source, ...(scoreHint !== undefined ? { scoreHint } : {}) };
}

function legalGeometry(input: CandidateEnumerationInput, limit: number, buckets: DelayBucket[]): CandidateAction[] {
  const operators = availableOperators(input);
  const cells = legalCells(input);
  const candidates: CandidateAction[] = [];
  if (!operators.length || !cells.length || limit <= 0) return candidates;
  for (let i = 0; candidates.length < limit && i < operators.length * cells.length * DIRECTIONS.length * buckets.length; i++) {
    const cell = cells[i % cells.length];
    const operator = operators[i % operators.length];
    const direction = DIRECTIONS[Math.floor(i / (operators.length * cells.length)) % DIRECTIONS.length];
    const delay = buckets[Math.floor(i / (operators.length * cells.length * DIRECTIONS.length)) % buckets.length];
    candidates.push(asCandidate({ type: "Deploy", operatorId: operator.id, x: cell.x, y: cell.y, direction, delay }, "legal_geometry"));
  }
  return candidates;
}

function randomExploration(input: CandidateEnumerationInput, limit: number, buckets: DelayBucket[], rng: Rng): CandidateAction[] {
  const operators = availableOperators(input);
  const cells = legalCells(input);
  const candidates: CandidateAction[] = [];
  for (let i = 0; i < limit * 4 && candidates.length < limit; i++) {
    const operator = pick(operators, rng);
    const cell = pick(cells, rng);
    const direction = pick([...DIRECTIONS], rng);
    const delay = pick(buckets, rng);
    if (operator && cell && direction !== undefined && delay !== undefined) {
      candidates.push(asCandidate({ type: "Deploy", operatorId: operator.id, x: cell.x, y: cell.y, direction, delay }, "random_exploration"));
    }
  }
  return candidates;
}

function failureAvoidance(input: CandidateEnumerationInput, limit: number, buckets: DelayBucket[]): CandidateAction[] {
  const operators = availableOperators(input);
  const cells = legalCells(input);
  const recentDeploys = input.partialActions.filter(action => action.type === "Deploy").slice(-3);
  const candidates: CandidateAction[] = [];
  for (const action of recentDeploys) {
    for (const operator of operators) candidates.push(asCandidate({ ...action, operatorId: operator.id }, "failure_avoidance"));
    for (const cell of cells) candidates.push(asCandidate({ ...action, x: cell.x, y: cell.y }, "failure_avoidance"));
    for (const direction of DIRECTIONS) candidates.push(asCandidate({ ...action, direction }, "failure_avoidance"));
    for (const delay of buckets) candidates.push(asCandidate({ ...action, delay }, "failure_avoidance"));
    if (candidates.length >= limit) break;
  }
  return candidates.slice(0, limit);
}

function fromProvided(actions: BattleAction[] | undefined, source: CandidateSource, limit: number): CandidateAction[] {
  return (actions || []).slice(0, limit).map(action => asCandidate(action, source));
}

function skillAndEnd(input: CandidateEnumerationInput, skillLimit: number): CandidateAction[] {
  const candidates: CandidateAction[] = [asCandidate({ type: "End", delay: 0 }, "end")];
  if (!input.partialActions.some(action => action.type === "SkillDaemon")) {
    candidates.unshift(asCandidate({ type: "SkillDaemon", delay: 0 }, "skill"));
  }
  for (const id of deployedOperators(input).slice(0, Math.max(0, skillLimit - candidates.length))) {
    candidates.push(asCandidate({ type: "SkillUse", operatorId: id, delay: 0 }, "skill"));
  }
  return candidates;
}

function quota(max: number, value: number | undefined, fallback: number): number {
  const actual = value ?? fallback;
  return actual <= 1 ? Math.floor(max * actual) : Math.floor(actual);
}

export function enumerateCandidateActions(
  input: CandidateEnumerationInput,
  config: CandidateEnumeratorConfig = {}
): CandidateAction[] {
  const maxCandidates = Math.max(0, Math.trunc(config.maxCandidates ?? DEFAULT_MAX));
  const buckets = normalizeBuckets(config.delayBuckets);
  const rng = seededRng(config.seed ?? 1);
  const sourceQuota = config.sourceQuota || {};
  const candidates = [
    ...skillAndEnd(input, quota(maxCandidates, sourceQuota.skill, DEFAULT_QUOTA.skill)),
    ...fromProvided(input.publicPriorActions, "public_prior", quota(maxCandidates, sourceQuota.publicPrior, DEFAULT_QUOTA.publicPrior)),
    ...legalGeometry(input, quota(maxCandidates, sourceQuota.legalGeometry, DEFAULT_QUOTA.legalGeometry), buckets),
    ...randomExploration(input, quota(maxCandidates, sourceQuota.randomExploration, DEFAULT_QUOTA.randomExploration), buckets, rng),
    ...fromProvided(input.legacyRuleActions, "legacy_rule", quota(maxCandidates, sourceQuota.legacyRule, DEFAULT_QUOTA.legacyRule)),
    ...failureAvoidance(input, quota(maxCandidates, sourceQuota.failureAvoidance, DEFAULT_QUOTA.failureAvoidance), buckets),
  ];
  const accepted: CandidateAction[] = [];
  for (const candidate of candidates) {
    if (isBasicallyLegalAction(candidate.action, input, { delayBuckets: buckets })) accepted.push(candidate);
  }
  for (const candidate of legalGeometry(input, maxCandidates, buckets)) {
    if (accepted.length >= maxCandidates) break;
    if (isBasicallyLegalAction(candidate.action, input, { delayBuckets: buckets })) accepted.push(candidate);
  }
  return dedupeCandidateActions(accepted).slice(0, maxCandidates);
}
