import generatedJson from "../data/operatorKnowledge.generated.v1.json";
import manualJson from "../data/operatorKnowledge.v1.json";

export const OPERATOR_VECTOR_AXES = [
  "frontline", "ranged", "physical", "arts", "healing", "burst",
  "area", "control", "antiAir", "rangeCoverage", "skillRangeChange", "mobility",
] as const;

export type KnowledgeSkill = { preferred?: boolean; avoid?: boolean; sustainedHealing?: boolean; tags?: string[] };
export type KnowledgeSpatial = {
  attackPattern?: string;
  coverage?: string;
  skillRangeBehavior?: string;
  positionEffect?: string;
  range?: Array<[number, number]>;
  skillRanges?: Record<string, Array<[number, number]>>;
  routeCoverageWeight?: number;
  routeDistanceWeight?: number;
};

export interface OperatorKnowledgeEntry {
  id?: string;
  name: string;
  fallbackTo?: string;
  role?: string;
  profession?: string;
  subProfession?: string | null;
  position?: "MELEE" | "RANGED";
  damageType?: "physical" | "arts" | "heal";
  rarity?: number;
  roles?: string[];
  capabilities?: string[];
  capabilityWeights?: Record<string, number>;
  usageScenarios?: string[];
  deployment?: { selectionBias?: number; temporary?: boolean; canReceiveAllyHealing?: boolean };
  spatial?: KnowledgeSpatial;
  skills?: Record<string, KnowledgeSkill>;
  relationships?: { similarTo?: string[]; replaces?: string[]; combosWith?: string[] };
  vector?: number[];
  provenance?: { source?: "manual" | "external" | "battle-feedback"; confidence?: number };
}

export interface OperatorKnowledgeModel {
  schemaVersion: number;
  modelVersion: string;
  vectorAxes: string[];
  operators: OperatorKnowledgeEntry[];
}

interface GeneratedKnowledgeSource {
  repository: string;
  commit: string;
  ruleVersion: string;
  operatorCount: number;
}

interface GeneratedOperatorKnowledgeModel extends OperatorKnowledgeModel {
  source: GeneratedKnowledgeSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function strings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new Error(`Operator knowledge ${field} must be a string array`);
  return value;
}

function finite(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Operator knowledge ${field} must be finite`);
  return value;
}

function validateRange(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some(offset => !Array.isArray(offset) || offset.length !== 2
    || offset.some(item => typeof item !== "number" || !Number.isFinite(item)))) {
    throw new Error(`Operator knowledge ${field} must be [row, col][]`);
  }
}

function parseEntry(value: unknown): OperatorKnowledgeEntry {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) throw new Error("Operator knowledge entry requires name");
  if (value.id !== undefined && typeof value.id !== "string") throw new Error("Operator knowledge id must be a string");
  if (value.fallbackTo !== undefined && typeof value.fallbackTo !== "string") throw new Error("Operator knowledge fallbackTo must be a string");
  if (value.vector !== undefined && (!Array.isArray(value.vector) || value.vector.length !== OPERATOR_VECTOR_AXES.length
    || value.vector.some(item => typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1))) {
    throw new Error(`Operator knowledge vector for ${value.name} must match vectorAxes`);
  }
  const entry = value as unknown as OperatorKnowledgeEntry;
  for (const field of ["deployment", "spatial", "relationships", "provenance"] as const) {
    if (entry[field] !== undefined && !isRecord(entry[field])) throw new Error(`Operator knowledge ${field} for ${entry.name} must be an object`);
  }
  if (entry.position !== undefined && entry.position !== "MELEE" && entry.position !== "RANGED") throw new Error(`Operator knowledge position for ${entry.name} is invalid`);
  if (entry.damageType !== undefined && !["physical", "arts", "heal"].includes(entry.damageType)) throw new Error(`Operator knowledge damageType for ${entry.name} is invalid`);
  for (const field of ["roles", "capabilities", "usageScenarios"] as const) strings(entry[field], field);
  if (entry.capabilityWeights !== undefined) {
    if (!isRecord(entry.capabilityWeights)) throw new Error(`Operator knowledge capabilityWeights for ${entry.name} must be an object`);
    for (const [key, weight] of Object.entries(entry.capabilityWeights)) finite(weight, `capabilityWeights.${key} for ${entry.name}`);
  }
  for (const field of ["similarTo", "replaces", "combosWith"] as const) strings(entry.relationships?.[field], `relationships.${field}`);
  for (const [index, skill] of Object.entries(entry.skills || {})) {
    if (!/^\d+$/.test(index) || !isRecord(skill)) throw new Error(`Operator knowledge skill for ${entry.name} is invalid`);
    strings(skill.tags, `skills.${index}.tags`);
  }
  finite(entry.deployment?.selectionBias, `deployment.selectionBias for ${entry.name}`);
  if (entry.spatial?.range !== undefined) validateRange(entry.spatial.range, `spatial.range for ${entry.name}`);
  for (const [skill, range] of Object.entries(entry.spatial?.skillRanges || {})) {
    if (!/^\d+$/.test(skill)) throw new Error(`Operator knowledge spatial skill range for ${entry.name} is invalid`);
    validateRange(range, `spatial.skillRanges.${skill} for ${entry.name}`);
  }
  finite(entry.spatial?.routeCoverageWeight, `spatial.routeCoverageWeight for ${entry.name}`);
  finite(entry.spatial?.routeDistanceWeight, `spatial.routeDistanceWeight for ${entry.name}`);
  finite(entry.provenance?.confidence, `provenance.confidence for ${entry.name}`);
  return entry;
}

export function parseOperatorKnowledge(value: unknown): OperatorKnowledgeModel {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.modelVersion !== "string" || !Array.isArray(value.vectorAxes)
    || value.vectorAxes.join("|") !== OPERATOR_VECTOR_AXES.join("|") || !Array.isArray(value.operators)) {
    throw new Error("Operator knowledge v1 is missing or incompatible");
  }
  const operators = value.operators.map(parseEntry);
  const seen = new Set<string>();
  for (const entry of operators) {
    const key = entry.id || entry.name;
    if (seen.has(key)) throw new Error(`Duplicate operator knowledge entry: ${key}`);
    seen.add(key);
  }
  return { schemaVersion: 1, modelVersion: value.modelVersion, vectorAxes: [...value.vectorAxes], operators };
}

function parseGeneratedKnowledge(value: unknown): GeneratedOperatorKnowledgeModel {
  const model = parseOperatorKnowledge(value);
  if (!isRecord(value) || !isRecord(value.source) || typeof value.source.repository !== "string"
    || !/^[a-f0-9]{40}$/i.test(String(value.source.commit || "")) || typeof value.source.ruleVersion !== "string"
    || !Number.isInteger(value.source.operatorCount) || value.source.operatorCount !== model.operators.length) {
    throw new Error("Generated operator knowledge source is missing or incompatible");
  }
  return {
    ...model,
    source: value.source as unknown as GeneratedKnowledgeSource,
    operators: model.operators.map(entry => entry.provenance ? entry : { ...entry, provenance: { source: "external", confidence: 0.8 } }),
  };
}

function unique(values: string[] | undefined): string[] | undefined {
  return values ? [...new Set(values)].sort() : undefined;
}

function mergeSkills(base?: Record<string, KnowledgeSkill>, override?: Record<string, KnowledgeSkill>): Record<string, KnowledgeSkill> | undefined {
  if (!base && !override) return undefined;
  return Object.fromEntries([...new Set([...Object.keys(base || {}), ...Object.keys(override || {})])].sort().map(index => {
    const left = base?.[index];
    const right = override?.[index];
    return [index, { ...left, ...right, tags: unique([...(left?.tags || []), ...(right?.tags || [])]) }];
  }));
}

function mergeEntry(base: OperatorKnowledgeEntry, override: OperatorKnowledgeEntry): OperatorKnowledgeEntry {
  const baseRelationships = base.relationships || {};
  const overrideRelationships = override.relationships || {};
  return {
    ...base,
    ...override,
    roles: unique([...(base.roles || []), ...(override.roles || [])]),
    capabilities: unique([...(base.capabilities || []), ...(override.capabilities || [])]),
    usageScenarios: unique([...(base.usageScenarios || []), ...(override.usageScenarios || [])]),
    capabilityWeights: { ...(base.capabilityWeights || {}), ...(override.capabilityWeights || {}) },
    deployment: { ...(base.deployment || {}), ...(override.deployment || {}) },
    spatial: { ...(base.spatial || {}), ...(override.spatial || {}), skillRanges: { ...(base.spatial?.skillRanges || {}), ...(override.spatial?.skillRanges || {}) } },
    skills: mergeSkills(base.skills, override.skills),
    relationships: {
      similarTo: unique([...(baseRelationships.similarTo || []), ...(overrideRelationships.similarTo || [])]),
      replaces: unique([...(baseRelationships.replaces || []), ...(overrideRelationships.replaces || [])]),
      combosWith: unique([...(baseRelationships.combosWith || []), ...(overrideRelationships.combosWith || [])]),
    },
  };
}

const generatedModel = parseGeneratedKnowledge(generatedJson);
const manualModel = parseOperatorKnowledge(manualJson);
const mergedOperators = [...generatedModel.operators];
const generatedIndex = new Map<string, number>();
for (const [index, entry] of mergedOperators.entries()) {
  if (entry.id) generatedIndex.set(`id:${entry.id}`, index);
  generatedIndex.set(`name:${entry.name}`, index);
}
for (const entry of manualModel.operators) {
  const index = (entry.id ? generatedIndex.get(`id:${entry.id}`) : undefined) ?? generatedIndex.get(`name:${entry.name}`);
  if (index === undefined) mergedOperators.push(entry);
  else mergedOperators[index] = mergeEntry(mergedOperators[index], entry);
}

const byId = new Map<string, OperatorKnowledgeEntry>();
const byName = new Map<string, OperatorKnowledgeEntry>();
for (const entry of mergedOperators) {
  if (entry.id) byId.set(entry.id, entry);
  byName.set(entry.name, entry);
}
const manualSupplementalIds = new Set(manualModel.operators.flatMap(entry => entry.id ? [entry.id] : []));

export function getOperatorKnowledgeEntry(id: string, name: string): OperatorKnowledgeEntry | undefined {
  return byId.get(id) || byName.get(name);
}

export function listSupplementalKnowledgeEntries(): OperatorKnowledgeEntry[] {
  return mergedOperators.filter(entry => Boolean(entry.id && manualSupplementalIds.has(entry.id)));
}

export function getOperatorKnowledgeDataInfo(): { modelVersion: string; vectorAxes: readonly string[]; generatedCommit: string; generatedOperatorCount: number } {
  return {
    modelVersion: `${generatedModel.modelVersion}+${manualModel.modelVersion}`,
    vectorAxes: OPERATOR_VECTOR_AXES,
    generatedCommit: generatedModel.source.commit.toLowerCase(),
    generatedOperatorCount: generatedModel.source.operatorCount,
  };
}
