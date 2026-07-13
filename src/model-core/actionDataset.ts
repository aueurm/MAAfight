import { getCombatOperatorByName } from "../engine/CombatModel";
import { copilotJsonToBattleDsl, type BattleAction, type BattleScript } from "./battleDsl";
import {
  actionKey,
  enumerateCandidateActions,
  isBasicallyLegalAction,
  type OperatorFeatures,
  type StageFeatures,
} from "./candidateEnumerator";
import { FEATURE_KEYS, extractActionFeatures, type ActionFeatureVector } from "./featureExtractor";

export interface ActionTrainingSample {
  stageFeatures: StageFeatures;
  rosterFeatures: OperatorFeatures[];
  partialActions: BattleAction[];
  positiveAction: BattleAction;
  negativeActions: BattleAction[];
  meta?: {
    stageId?: string;
    scriptId?: string;
    stepIndex?: number;
  };
}

export interface RankerTrainingRow {
  group_id: string;
  label: 0 | 1;
  features: ActionFeatureVector;
  action: BattleAction;
}

export interface BuildActionDatasetOptions {
  negativeCount?: number;
  seed?: number;
  validRatio?: number;
  rejectedSamples?: RejectedActionSample[];
  rejectedPerSample?: number;
}

export interface PublicOperation {
  id?: string | number;
  source?: string;
  content?: Record<string, unknown>;
  feature?: Record<string, unknown>;
}

export interface RejectedActionSample {
  stageId?: string;
  actions?: BattleAction[];
}

const DEFAULT_NEGATIVE_COUNT = 50;

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function operatorName(value: unknown): string | undefined {
  const item = record(value);
  const name = item.operatorId || item.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

export function rosterFeaturesFromCopilot(content: Record<string, unknown>, feature: Record<string, unknown> = {}): OperatorFeatures[] {
  const groups = Array.isArray(content.groups) ? content.groups : [];
  const fixed = Array.isArray(content.opers) ? content.opers : [];
  const featureNames = Array.isArray(feature.operatorNames) ? feature.operatorNames.map(name => ({ name })) : [];
  const contentEntries = [
    ...fixed,
    ...groups.flatMap(group => {
      const opers = record(group).opers;
      return Array.isArray(opers) && opers.length ? [opers[0]] : [];
    }),
  ];
  const entries = contentEntries.length ? contentEntries : featureNames;
  const seen = new Set<string>();
  const result: OperatorFeatures[] = [];
  for (const entry of entries) {
    const raw = record(entry);
    const id = operatorName(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const combat = getCombatOperatorByName(id);
    const rawPosition = String(raw.position || "").toUpperCase();
    result.push({
      ...raw,
      operatorId: id,
      name: id,
      position: rawPosition === "MELEE" || rawPosition === "RANGED" ? rawPosition : combat?.position,
      rarity: raw.rarity ?? combat?.rarity,
      cost: raw.cost ?? combat?.e2.reference.cost,
    });
  }
  return result;
}

function resolveGroupActions(content: Record<string, unknown>): Record<string, unknown> {
  const groups = Array.isArray(content.groups) ? content.groups : [];
  const representatives = new Map<string, string>();
  for (const group of groups) {
    const raw = record(group);
    const name = operatorName(raw);
    const opers = Array.isArray(raw.opers) ? raw.opers : [];
    const representative = operatorName(opers[0]);
    if (name && representative) representatives.set(name, representative);
  }
  const actions = Array.isArray(content.actions) ? content.actions : [];
  return {
    ...content,
    actions: actions.map(value => {
      const action = record(value);
      const representative = representatives.get(String(action.name || ""));
      return representative ? { ...action, name: representative } : value;
    }),
  };
}

function pointFrom(value: unknown): { x: number; y: number; buildableType?: string } | null {
  const raw = record(value);
  const x = numberValue(raw.x ?? raw.col);
  const y = numberValue(raw.y ?? raw.row);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return {
    x: x!,
    y: y!,
    ...(typeof raw.buildableType === "string" ? { buildableType: raw.buildableType.toLowerCase() } : {}),
  };
}

export function stageFeaturesFromOperation(operation: PublicOperation, script: BattleScript): StageFeatures {
  const feature = record(operation.feature);
  const map = record(feature.map);
  const deployPoints = [
    ...(Array.isArray(map.deploymentPoints) ? map.deploymentPoints : []),
    ...(Array.isArray(feature.deployLocations) ? feature.deployLocations : []),
    ...script.actions.filter(action => action.type === "Deploy").map(action => ({ x: action.x, y: action.y })),
  ].map(pointFrom).filter((point): point is { x: number; y: number; buildableType?: string } => Boolean(point));
  const deploymentPointByKey = new Map<string, { x: number; y: number; buildableType?: string }>();
  for (const point of deployPoints) {
    const key = `${point.x},${point.y}`;
    if (!deploymentPointByKey.has(key)) deploymentPointByKey.set(key, point);
  }
  const deploymentPoints = [...deploymentPointByKey.values()];
  return {
    stageId: script.stageId,
    stageName: script.stageId,
    rows: numberValue(map.rows),
    cols: numberValue(map.cols),
    map: {
      ...map,
      ...(deploymentPoints.length ? { deploymentPoints } : {}),
    },
    deploymentPoints,
  };
}

function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function isValidSplit(scriptId: string, validRatio = 0.1, seed = 42): boolean {
  const ratio = Math.max(0, Math.min(1, validRatio));
  return stableHash(`${seed}:${scriptId}`) / 0xFFFFFFFF < ratio;
}

function groupId(sample: ActionTrainingSample): string {
  const stageId = sample.meta?.stageId || sample.stageFeatures.stageId || sample.stageFeatures.stageName || "unknown";
  const scriptId = sample.meta?.scriptId || "script";
  const step = sample.meta?.stepIndex ?? sample.partialActions.length;
  return `${stageId}/script_${scriptId}/step_${step}`;
}

function sampleStageId(sample: Omit<ActionTrainingSample, "negativeActions">): string {
  return String(sample.meta?.stageId || sample.stageFeatures.stageId || sample.stageFeatures.stageName || "");
}

function rejectedActionsForStep(
  sample: Omit<ActionTrainingSample, "negativeActions">,
  options: BuildActionDatasetOptions
): BattleAction[] {
  const limit = Math.max(0, Math.trunc(options.rejectedPerSample ?? (options.rejectedSamples?.length ? 4 : 0)));
  if (!limit || !options.rejectedSamples?.length) return [];
  const stageId = sampleStageId(sample);
  const step = sample.meta?.stepIndex ?? sample.partialActions.length;
  return options.rejectedSamples
    .filter(rejected => rejected.stageId === stageId)
    .map(rejected => rejected.actions?.[step])
    .filter((action): action is BattleAction => Boolean(action))
    .slice(0, limit);
}

export function trainingRowsForSample(sample: ActionTrainingSample): RankerTrainingRow[] {
  return [
    { label: 1 as const, action: sample.positiveAction },
    ...sample.negativeActions.map(action => ({ label: 0 as const, action })),
  ].map(row => ({
    group_id: groupId(sample),
    label: row.label,
    action: row.action,
    features: extractActionFeatures({
      stageFeatures: sample.stageFeatures,
      rosterFeatures: sample.rosterFeatures,
      partialActions: sample.partialActions,
      candidateAction: row.action,
    }),
  }));
}

export function negativeActionsForStep(
  sample: Omit<ActionTrainingSample, "negativeActions">,
  fullActions: BattleAction[],
  options: BuildActionDatasetOptions = {}
): BattleAction[] {
  const negativeCount = Math.max(0, Math.trunc(options.negativeCount ?? DEFAULT_NEGATIVE_COUNT));
  const positiveKey = actionKey(sample.positiveAction);
  const seen = new Set<string>();
  const negatives: BattleAction[] = [];
  const accept = (action: BattleAction): boolean => {
    const key = actionKey(action);
    if (key === positiveKey || seen.has(key)) return false;
    if (!isBasicallyLegalAction(action, {
      stageFeatures: sample.stageFeatures,
      rosterFeatures: sample.rosterFeatures,
      partialActions: sample.partialActions,
    })) return false;
    seen.add(key);
    negatives.push(action);
    return true;
  };
  for (const action of rejectedActionsForStep(sample, options)) {
    accept(action);
    if (negatives.length >= negativeCount) return negatives;
  }
  const candidates = enumerateCandidateActions({
    stageFeatures: sample.stageFeatures,
    rosterFeatures: sample.rosterFeatures,
    partialActions: sample.partialActions,
    publicPriorActions: fullActions,
  }, {
    maxCandidates: Math.max(negativeCount * 4, 100),
    seed: (options.seed ?? 42) + (sample.meta?.stepIndex ?? 0),
  });
  for (const candidate of candidates) {
    accept(candidate.action);
    if (negatives.length >= negativeCount) break;
  }
  return negatives;
}

export function buildActionTrainingSamplesFromBattleDsl(
  script: BattleScript,
  stageFeatures: StageFeatures,
  rosterFeatures: OperatorFeatures[],
  options: BuildActionDatasetOptions = {}
): ActionTrainingSample[] {
  const actions = script.actions.at(-1)?.type === "End" ? script.actions : [...script.actions, { type: "End" as const, delay: 0 as const }];
  return actions.flatMap((positiveAction, stepIndex) => {
    const partialActions = actions.slice(0, stepIndex);
    const base = {
      stageFeatures,
      rosterFeatures,
      partialActions,
      positiveAction,
      meta: {
        stageId: script.stageId,
        scriptId: String(script.meta?.scriptId || script.meta?.operationId || "unknown"),
        stepIndex,
      },
    };
    if (positiveAction.type === "SpeedUp" || positiveAction.type === "Retreat" || !isBasicallyLegalAction(positiveAction, {
      stageFeatures,
      rosterFeatures,
      partialActions,
    })) return [];
    return [{
      ...base,
      negativeActions: negativeActionsForStep(base, actions, options),
    }];
  });
}

export function buildActionTrainingSamplesForOperation(
  operation: PublicOperation,
  options: BuildActionDatasetOptions = {}
): ActionTrainingSample[] {
  const content = record(operation.content);
  const resolvedContent = resolveGroupActions(content);
  const script = copilotJsonToBattleDsl(resolvedContent);
  script.meta = {
    ...(script.meta || {}),
    scriptId: operation.id,
    operationId: operation.id,
    source: operation.source,
  };
  return buildActionTrainingSamplesFromBattleDsl(
    script,
    stageFeaturesFromOperation(operation, script),
    rosterFeaturesFromCopilot(resolvedContent, record(operation.feature)),
    options
  );
}

export function featureCount(): number {
  return FEATURE_KEYS.length;
}

export const DEFAULT_ACTION_DATASET_OPTIONS = {
  negativeCount: DEFAULT_NEGATIVE_COUNT,
  seed: 42,
  validRatio: 0.1,
} as const;
