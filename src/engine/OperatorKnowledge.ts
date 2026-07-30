import {
  getOperatorKnowledgeDataInfo,
  getOperatorKnowledgeEntry,
  listSupplementalKnowledgeEntries as listSupplementalEntries,
  OPERATOR_VECTOR_AXES,
  parseOperatorKnowledge,
  type OperatorKnowledgeEntry,
} from "./OperatorKnowledgeData";
import type { ResolvedOperatorProfile } from "./types";

export { OPERATOR_VECTOR_AXES, parseOperatorKnowledge } from "./OperatorKnowledgeData";
export type { OperatorKnowledgeEntry } from "./OperatorKnowledgeData";

export interface KnowledgeSubject {
  id: string;
  name: string;
  role?: string;
  profession?: string;
  subProfession?: string | null;
  position?: "MELEE" | "RANGED";
  damageType?: "physical" | "arts" | "heal";
  rarity?: number;
  baseMetrics?: { normalDps: number; burstDps: number; healingHps: number; controlSeconds: number };
}

export interface ResolvedOperatorKnowledge {
  source: "derived" | "manual" | "external" | "battle-feedback";
  roles: string[];
  capabilities: string[];
  capabilityWeights: Record<string, number>;
  usageScenarios: string[];
  preferredSkills: number[];
  avoidedSkills: number[];
  sustainedHealingSkills: number[];
  skillTags: Record<number, string[]>;
  deployment: { selectionBias: number; temporary: boolean; canReceiveAllyHealing: boolean };
  spatial: {
    attackPattern: string;
    coverage: string;
    skillRangeBehavior: string;
    positionEffect?: string;
    range: Array<[number, number]>;
    skillRanges: Record<string, Array<[number, number]>>;
    routeCoverageWeight: number;
    routeDistanceWeight: number;
  };
  relationships: { similarTo: string[]; replaces: string[]; combosWith: string[] };
  vector: number[];
}

const profileCache = new WeakMap<ResolvedOperatorProfile, ResolvedOperatorKnowledge>();

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function metadataFor(operator: KnowledgeSubject): OperatorKnowledgeEntry | undefined {
  return getOperatorKnowledgeEntry(operator.id, operator.name);
}

export function getKnowledgeRangeOverride(operator: KnowledgeSubject, skill: number): { range: Array<[number, number]>; source: "base" | "skill" } | undefined {
  const spatial = metadataFor(operator)?.spatial;
  const skillRange = spatial?.skillRanges?.[String(skill)];
  const range = skillRange || spatial?.range;
  return range ? { range: range.map(offset => [offset[0], offset[1]]), source: skillRange ? "skill" : "base" } : undefined;
}

function derivedCapabilities(operator: KnowledgeSubject, profile?: ResolvedOperatorProfile): string[] {
  const metrics = profile?.metrics || operator.baseMetrics;
  const range = profile?.range || [];
  return unique([
    operator.position === "MELEE" ? "frontline" : undefined,
    operator.position === "RANGED" ? "ranged-damage" : undefined,
    operator.damageType === "arts" ? "arts-damage" : operator.damageType === "physical" ? "physical-damage" : undefined,
    (metrics?.healingHps || 0) > 0 || operator.role === "medic" ? "healing" : undefined,
    (metrics?.burstDps || 0) > (metrics?.normalDps || 0) * 1.25 ? "burst" : undefined,
    (profile?.maxTargets || 1) > 1 ? "area" : undefined,
    (metrics?.controlSeconds || 0) > 0 ? "control" : undefined,
    operator.position === "RANGED" && range.some(([, col]) => col >= 2) ? "anti-air" : undefined,
  ]);
}

function derivedVector(operator: KnowledgeSubject, profile?: ResolvedOperatorProfile): number[] {
  const metrics = profile?.metrics || operator.baseMetrics;
  const range = profile?.range || [];
  return [
    Number(operator.position === "MELEE"), Number(operator.position === "RANGED"), Number(operator.damageType === "physical"), Number(operator.damageType === "arts"),
    clamp((metrics?.healingHps || 0) / 1000), clamp(Math.max(0, (metrics?.burstDps || 0) - (metrics?.normalDps || 0)) / 3000),
    clamp(((profile?.maxTargets || 1) - 1) / 4), clamp((metrics?.controlSeconds || 0) / 6),
    Number(operator.position === "RANGED" && range.some(([, col]) => col >= 2)), clamp(range.length / 12),
    Number(Boolean(profile?.skillRangeId && profile.skillRangeId !== profile.baseRangeId)), clamp(1 - (profile?.respawnTime || 70) / 100),
  ];
}

function vectorFor(operator: KnowledgeSubject, metadata: OperatorKnowledgeEntry | undefined, profile?: ResolvedOperatorProfile): number[] {
  const vector = metadata?.vector ? metadata.vector.map(clamp) : derivedVector(operator, profile);
  const capabilities = new Set([...(metadata?.capabilities || []), ...derivedCapabilities(operator, profile)]);
  const axisForCapability: Record<string, number> = { frontline: 0, healing: 4, burst: 5, area: 6, control: 7, "anti-air": 8 };
  for (const capability of capabilities) if (axisForCapability[capability] !== undefined) vector[axisForCapability[capability]] = 1;
  if (Object.keys(metadata?.spatial?.skillRanges || {}).length > 0) vector[10] = 1;
  return vector;
}

export function getOperatorKnowledge(operator: KnowledgeSubject, profile?: ResolvedOperatorProfile): ResolvedOperatorKnowledge {
  if (profile) {
    const cached = profileCache.get(profile);
    if (cached) return cached;
  }
  const metadata = metadataFor(operator);
  const skills = Object.entries(metadata?.skills || {}).map(([index, skill]) => ({ index: Number(index), skill }));
  const spatial = metadata?.spatial || {};
  const rangeOverride = getKnowledgeRangeOverride(operator, profile?.skill || 1);
  const result: ResolvedOperatorKnowledge = {
    source: metadata?.provenance?.source ?? (metadata ? "manual" : "derived"),
    roles: unique([operator.role, operator.subProfession || undefined, ...(metadata?.roles || [])]),
    capabilities: unique([...derivedCapabilities(operator, profile), ...(metadata?.capabilities || [])]),
    capabilityWeights: { ...(metadata?.capabilityWeights || {}) },
    usageScenarios: unique(metadata?.usageScenarios || []),
    preferredSkills: skills.filter(item => item.skill.preferred).map(item => item.index).sort((a, b) => a - b),
    avoidedSkills: skills.filter(item => item.skill.avoid).map(item => item.index).sort((a, b) => a - b),
    sustainedHealingSkills: skills.filter(item => item.skill.sustainedHealing).map(item => item.index).sort((a, b) => a - b),
    skillTags: Object.fromEntries(skills.map(item => [item.index, unique(item.skill.tags || [])])),
    deployment: {
      selectionBias: metadata?.deployment?.selectionBias || 0,
      temporary: metadata?.deployment?.temporary || false,
      canReceiveAllyHealing: metadata?.deployment?.canReceiveAllyHealing ?? true,
    },
    spatial: {
      attackPattern: spatial.attackPattern || ((profile?.maxTargets || 1) > 1 ? "area" : "single-target"),
      coverage: spatial.coverage || "range-cells",
      skillRangeBehavior: spatial.skillRangeBehavior || (profile?.skillRangeId && profile.skillRangeId !== profile.baseRangeId ? "changes" : "unchanged"),
      positionEffect: spatial.positionEffect,
      routeCoverageWeight: spatial.routeCoverageWeight ?? 1,
      routeDistanceWeight: spatial.routeDistanceWeight ?? 1,
      range: (profile?.range || rangeOverride?.range || []).map(offset => [offset[0], offset[1]]),
      skillRanges: Object.fromEntries(Object.entries(spatial.skillRanges || {}).map(([skill, range]) => [skill, range.map(offset => [offset[0], offset[1]])])),
    },
    relationships: {
      similarTo: unique([...(metadata?.relationships?.similarTo || []), ...(metadata?.fallbackTo ? [metadata.fallbackTo] : [])]),
      replaces: unique(metadata?.relationships?.replaces || []),
      combosWith: unique(metadata?.relationships?.combosWith || []),
    },
    vector: vectorFor(operator, metadata, profile),
  };
  if (profile) profileCache.set(profile, result);
  return result;
}

function cosine(left: number[], right: number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const leftLength = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightLength = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return leftLength && rightLength ? dot / (leftLength * rightLength) : 0;
}

export function resolveKnowledgeFallback<T extends KnowledgeSubject>(entry: OperatorKnowledgeEntry, candidates: T[]): T | undefined {
  if (entry.fallbackTo) {
    const explicit = candidates.find(candidate => candidate.id === entry.fallbackTo || candidate.name === entry.fallbackTo);
    if (!explicit) throw new Error(`Operator knowledge fallback target not found: ${entry.fallbackTo}`);
    return explicit;
  }
  if (!entry.vector || candidates.length === 0) return undefined;
  const target = vectorFor({ id: entry.id || entry.name, name: entry.name, role: entry.role, subProfession: entry.subProfession, position: entry.position, damageType: entry.damageType }, entry);
  return [...candidates].sort((left, right) => cosine(target, vectorFor(right, metadataFor(right))) - cosine(target, vectorFor(left, metadataFor(left)))
    || left.id.localeCompare(right.id))[0];
}

export function listSupplementalKnowledgeEntries(): OperatorKnowledgeEntry[] {
  return listSupplementalEntries();
}

export function getOperatorKnowledgeModelInfo(): { modelVersion: string; vectorAxes: readonly string[]; generatedCommit: string; generatedOperatorCount: number } {
  return getOperatorKnowledgeDataInfo();
}
