import modelJson from "../data/operatorCombat.v2.json";
import type { PlayerOperator } from "../types";
import type {
  CombatAttributes,
  CombatMetrics,
  EngineRole,
  ResolvedOperatorProfile,
} from "./types";

interface SkillLevelRecord {
  rank: number;
  spType: string;
  spCost: number;
  initSp: number;
  duration: number;
  rangeId: string | null;
  maxTargets: number;
  metrics: CombatMetrics;
  confidence: "exact" | "partial";
  modelCoverageGaps: string[];
}

interface SkillRecord {
  id: string;
  unlockPhase: number;
  levels: SkillLevelRecord[];
  modelCoverageGaps: string[];
}

interface ModuleRecord {
  id: string;
  index: number;
  levels: Array<{
    level: number;
    attributes: Record<string, number>;
    confidence: "exact" | "partial";
    modelCoverageGaps: string[];
  }>;
}

export interface CombatOperatorRecord {
  id: string;
  name: string;
  role: EngineRole;
  profession: string;
  subProfession: string | null;
  position: "MELEE" | "RANGED";
  rarity: number;
  e2: {
    minLevel: number;
    maxLevel: number;
    rangeId: string | null;
    min: CombatAttributes;
    max: CombatAttributes;
    trust: CombatAttributes;
    reference: CombatAttributes;
  };
  damageType: "physical" | "arts" | "heal";
  baseMetrics: CombatMetrics;
  skills: SkillRecord[];
  modules: ModuleRecord[];
  modelCoverageGaps: string[];
}

interface CombatModelV2 {
  schemaVersion: number;
  modelVersion: string;
  source: { commit: string; exactOperatorCount: number };
  ranges: Record<string, Array<[number, number]>>;
  nameIndex: Record<string, string>;
  operators: Record<string, CombatOperatorRecord>;
}

const model = modelJson as unknown as CombatModelV2;
if (model.schemaVersion !== 2 || !model.source?.commit || !model.operators || model.source.exactOperatorCount <= 0) {
  throw new Error("Operator combat model v2 is missing or incompatible");
}

const profileCache = new Map<string, ResolvedOperatorProfile>();

function interpolate(minimum: number, maximum: number, ratio: number): number {
  return minimum + (maximum - minimum) * ratio;
}

function addModule(attributes: CombatAttributes, record: CombatOperatorRecord, player?: PlayerOperator): {
  attributes: CombatAttributes;
  gaps: string[];
} {
  if (!player?.module) return { attributes, gaps: [] };
  const module = record.modules.find(candidate => candidate.index === player.module);
  if (!module) return { attributes, gaps: ["unknown_player_module"] };
  const requestedLevel = player.moduleLevel ?? 1;
  const level = module.levels.find(candidate => candidate.level === requestedLevel) || module.levels.at(-1);
  if (!level) return { attributes, gaps: ["missing_module_level"] };
  return {
    attributes: {
      ...attributes,
      hp: attributes.hp + (level.attributes.max_hp || 0),
      atk: attributes.atk + (level.attributes.atk || 0),
      def: attributes.def + (level.attributes.def || 0),
      res: attributes.res + (level.attributes.magic_resistance || 0),
    },
    gaps: [...level.modelCoverageGaps],
  };
}

function metricsAtAttributes(base: CombatMetrics, source: CombatAttributes, resolved: CombatAttributes): CombatMetrics {
  const attackRatio = source.atk > 0 ? resolved.atk / source.atk : 1;
  const hpRatio = source.hp > 0 ? resolved.hp / source.hp : 1;
  return {
    normalDps: base.normalDps * attackRatio,
    burstDps: base.burstDps * attackRatio,
    cycleDps: base.cycleDps === null ? null : base.cycleDps * attackRatio,
    healingHps: base.healingHps * attackRatio,
    physicalEhp: base.physicalEhp * hpRatio,
    artsEhp: base.artsEhp * hpRatio,
    controlSeconds: base.controlSeconds,
  };
}

export function getCombatModelInfo(): { modelVersion: string; commit: string; operatorCount: number } {
  return {
    modelVersion: model.modelVersion,
    commit: model.source.commit,
    operatorCount: model.source.exactOperatorCount,
  };
}

export function getCombatOperatorByName(name: string): CombatOperatorRecord | undefined {
  const id = model.nameIndex[name];
  return id ? model.operators[id] : undefined;
}

export function getCombatOperator(idOrName: string): CombatOperatorRecord | undefined {
  return model.operators[idOrName] || getCombatOperatorByName(idOrName);
}

export function listCombatOperators(): CombatOperatorRecord[] {
  return Object.values(model.operators);
}

export function roleForOperatorName(name: string): EngineRole | undefined {
  return getCombatOperatorByName(name)?.role;
}

export function resolveOperatorProfile(
  record: CombatOperatorRecord,
  skill: number,
  player?: PlayerOperator
): ResolvedOperatorProfile {
  const skillRank = Math.max(1, Math.min(10, player?.skillLevel ?? 10));
  const cacheKey = [
    model.modelVersion, record.id, player?.elite ?? 2, player?.level ?? record.e2.maxLevel,
    player?.potential ?? 1, skill, skillRank, player?.module ?? 0, player?.moduleLevel ?? 0,
    player ? "player" : "reference",
  ].join("|");
  const cached = profileCache.get(cacheKey);
  if (cached) return cached;

  const level = Math.max(record.e2.minLevel, Math.min(player?.level ?? record.e2.maxLevel, record.e2.maxLevel));
  const span = Math.max(1, record.e2.maxLevel - record.e2.minLevel);
  const ratio = (level - record.e2.minLevel) / span;
  const base: CombatAttributes = {
    hp: interpolate(record.e2.min.hp, record.e2.max.hp, ratio) + record.e2.trust.hp,
    atk: interpolate(record.e2.min.atk, record.e2.max.atk, ratio) + record.e2.trust.atk,
    def: interpolate(record.e2.min.def, record.e2.max.def, ratio) + record.e2.trust.def,
    res: interpolate(record.e2.min.res, record.e2.max.res, ratio) + record.e2.trust.res,
    cost: player?.cost ?? interpolate(record.e2.min.cost, record.e2.max.cost, ratio),
    block: interpolate(record.e2.min.block, record.e2.max.block, ratio),
    attackInterval: interpolate(record.e2.min.attackInterval, record.e2.max.attackInterval, ratio),
    attackSpeed: interpolate(record.e2.min.attackSpeed, record.e2.max.attackSpeed, ratio),
  };
  const moduleResolved = addModule(base, record, player);
  const skillRecord = record.skills[Math.max(0, Math.min(skill - 1, record.skills.length - 1))];
  const levelRecord = skillRecord?.levels[Math.max(0, Math.min(skillRank - 1, skillRecord.levels.length - 1))];
  const gaps = [
    ...record.modelCoverageGaps,
    ...(skillRecord?.modelCoverageGaps || []),
    ...(levelRecord?.modelCoverageGaps || []),
    ...moduleResolved.gaps,
    ...(!player?.skillLevel && player ? ["assumed_skill_rank_10"] : []),
    ...(player ? ["assumed_max_trust"] : []),
  ];
  const sourceMetrics = levelRecord?.metrics || record.baseMetrics;
  const resolved: ResolvedOperatorProfile = {
    operatorId: record.id,
    name: record.name,
    role: record.role,
    subProfession: record.subProfession,
    position: record.position,
    damageType: record.damageType,
    skill,
    skillRank,
    baseRangeId: record.e2.rangeId,
    skillRangeId: levelRecord?.rangeId || null,
    range: model.ranges[levelRecord?.rangeId || record.e2.rangeId || ""] || [[0, 0]],
    attributes: moduleResolved.attributes,
    metrics: metricsAtAttributes(sourceMetrics, record.e2.reference, moduleResolved.attributes),
    maxTargets: levelRecord?.maxTargets || 1,
    confidence: levelRecord ? levelRecord.confidence : "base",
    modelCoverageGaps: [...new Set(gaps)].sort(),
  };
  profileCache.set(cacheKey, resolved);
  return resolved;
}
