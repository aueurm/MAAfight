import { validateScript } from "../copilot/ScriptValidator";
import {
  battleDslToCopilotJson,
  DIRECTIONS,
  normalizeDelayToBucket,
  validateBattleDsl,
  type BattleAction,
  type BattleScript,
} from "./battleDsl";
import {
  actionKey,
  enumerateCandidateActions,
  isBasicallyLegalAction,
  type CandidateSource,
  type OperatorFeatures,
  type StageFeatures,
} from "./candidateEnumerator";
import { extractActionFeatures } from "./featureExtractor";
import { LinearActionRanker, type CpuActionRankerModel } from "./linearRanker";
import { computeFeedbackPenalty, type ScriptFingerprint } from "./modelCoreFeedback";
import type { BattleScript as MaaBattleScript } from "../types";

export interface BeamSearchConfig {
  beamSize?: number;
  topActionsPerState?: number;
  maxSteps?: number;
  candidateActionsPerState?: number;
  seed?: number;
  endBonus?: number;
  repeatPenalty?: number;
  collectDebug?: boolean;
}

export interface BeamState {
  actions: BattleAction[];
  cumulativeScore: number;
  ended: boolean;
  meta?: {
    stepScores?: number[];
    actionSources?: CandidateSource[];
  };
}

export interface GenerateScriptInput {
  stageFeatures: StageFeatures;
  rosterFeatures: OperatorFeatures[];
  stageId: string;
  rankerModelPath?: string;
  rankerModel?: CpuActionRankerModel;
  reusableSuccessScript?: BattleScript;
  failedFingerprints?: ScriptFingerprint[];
  feedbackPenaltyWeight?: number;
  config?: BeamSearchConfig;
}

export interface GeneratedBattleScript {
  stageId: string;
  actions: BattleAction[];
  score: number;
  beams?: BeamState[];
  meta?: Record<string, unknown>;
}

export interface CopilotGenerationResult {
  copilot: unknown;
  dslValidation: ReturnType<typeof validateBattleDsl>;
  copilotValidation: ReturnType<typeof validateScript>;
  repaired: boolean;
}

interface ResolvedConfig {
  beamSize: number;
  topActionsPerState: number;
  maxSteps: number;
  candidateActionsPerState: number;
  seed: number;
  endBonus: number;
  repeatPenalty: number;
  collectDebug: boolean;
}

const DEFAULT_CONFIG: ResolvedConfig = {
  beamSize: 8,
  topActionsPerState: 16,
  maxSteps: 16,
  candidateActionsPerState: 500,
  seed: 42,
  endBonus: 0,
  repeatPenalty: 1,
  collectDebug: false,
};

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.max(min, Math.min(max, number));
}

export function resolveBeamConfig(config: BeamSearchConfig = {}): ResolvedConfig {
  return {
    beamSize: clamp(config.beamSize, DEFAULT_CONFIG.beamSize, 4, 16),
    topActionsPerState: clamp(config.topActionsPerState, DEFAULT_CONFIG.topActionsPerState, 8, 32),
    maxSteps: clamp(config.maxSteps, DEFAULT_CONFIG.maxSteps, 1, 18),
    candidateActionsPerState: clamp(config.candidateActionsPerState, DEFAULT_CONFIG.candidateActionsPerState, 1, 1000),
    seed: Math.trunc(config.seed ?? DEFAULT_CONFIG.seed),
    endBonus: Number(config.endBonus ?? DEFAULT_CONFIG.endBonus),
    repeatPenalty: Number(config.repeatPenalty ?? DEFAULT_CONFIG.repeatPenalty),
    collectDebug: Boolean(config.collectDebug),
  };
}

function zeroRanker(): Pick<LinearActionRanker, "score" | "operatorPrior"> {
  return { score: () => 0, operatorPrior: () => 0 };
}

function loadRanker(input: GenerateScriptInput): Pick<LinearActionRanker, "score" | "operatorPrior"> {
  if (input.rankerModel) return LinearActionRanker.loadFromJson(input.rankerModel);
  if (input.rankerModelPath) return LinearActionRanker.loadFromJson(input.rankerModelPath);
  return zeroRanker();
}

function stateKey(state: BeamState): string {
  return state.actions.map(actionKey).join("|");
}

function minimumDeployments(input: GenerateScriptInput): number {
  const map = input.stageFeatures.map || {};
  const deployLimit = Number(input.stageFeatures.characterLimit ?? map.characterLimit);
  const directPoints = input.stageFeatures.deploymentPoints || [];
  const mapPoints = Array.isArray(map.deploymentPoints) ? map.deploymentPoints : [];
  const pointCount = new Set([...directPoints, ...mapPoints].map(point => `${point.x ?? point.col},${point.y ?? point.row}`)).size;
  const limits = [input.rosterFeatures.length];
  if (Number.isFinite(deployLimit) && deployLimit > 0) limits.push(Math.trunc(deployLimit));
  if (pointCount > 0) limits.push(pointCount);
  return Math.max(0, Math.min(...limits));
}

function actionScore(baseScore: number, action: BattleAction, state: BeamState, config: ResolvedConfig): number {
  let score = baseScore;
  if (action.type === "End") score += config.endBonus;
  if (config.repeatPenalty && state.actions.some(previous => actionKey(previous) === actionKey(action))) {
    score -= config.repeatPenalty;
  }
  if (config.repeatPenalty && action.type === "Deploy" && action.direction) {
    score -= config.repeatPenalty * state.actions.filter(previous => previous.type === "Deploy" && previous.direction === action.direction).length;
  }
  return score;
}

function sortStates(states: BeamState[]): BeamState[] {
  return [...states].sort((left, right) => right.cumulativeScore - left.cumulativeScore || stateKey(left).localeCompare(stateKey(right)));
}

function logNormalizer(scores: number[]): number {
  if (!scores.length) return 0;
  const maximum = Math.max(...scores);
  return maximum + Math.log(scores.reduce((sum, score) => sum + Math.exp(score - maximum), 0));
}

function endedState(state: BeamState): BeamState {
  if (state.ended || state.actions.at(-1)?.type === "End") return { ...state, ended: true };
  return {
    ...state,
    actions: [...state.actions, { type: "End", delay: 0 }],
    ended: true,
    meta: {
      stepScores: [...(state.meta?.stepScores || []), 0],
      actionSources: [...(state.meta?.actionSources || []), "end"],
    },
  };
}

function chooseFinalState(input: GenerateScriptInput, beam: BeamState[]): {
  state: BeamState;
  finalScore: number;
  feedbackPenalty: number;
  hardRejectedCandidates: number;
} {
  const states = sortStates(beam).map(endedState);
  const failed = input.failedFingerprints || [];
  if (!failed.length) {
    const state = sortStates(states.filter(item => item.ended))[0] || states[0];
    return { state, finalScore: state.cumulativeScore, feedbackPenalty: 0, hardRejectedCandidates: 0 };
  }

  const weight = Number(input.feedbackPenaltyWeight ?? 1);
  const scored = states.map(state => {
    const penalty = computeFeedbackPenalty({ stageId: input.stageId, actions: state.actions }, failed);
    const finalScore = Number.isFinite(penalty) ? state.cumulativeScore - penalty * weight : Number.NEGATIVE_INFINITY;
    return { state, finalScore, penalty };
  });
  const usable = scored.filter(item => Number.isFinite(item.finalScore));
  const best = [...(usable.length ? usable : scored)]
    .sort((left, right) => right.finalScore - left.finalScore || stateKey(left.state).localeCompare(stateKey(right.state)))[0];
  return {
    state: best.state,
    finalScore: Number.isFinite(best.finalScore) ? best.finalScore : best.state.cumulativeScore,
    feedbackPenalty: Number.isFinite(best.penalty) ? best.penalty : Number.POSITIVE_INFINITY,
    hardRejectedCandidates: scored.filter(item => !Number.isFinite(item.finalScore)).length,
  };
}

export function generateBattleScript(input: GenerateScriptInput): GeneratedBattleScript {
  if (input.reusableSuccessScript) {
    const reused = endedState({
      actions: input.reusableSuccessScript.actions,
      cumulativeScore: 0,
      ended: input.reusableSuccessScript.actions.at(-1)?.type === "End",
      meta: { stepScores: [], actionSources: [] },
    });
    return {
      stageId: input.stageId,
      actions: reused.actions,
      score: 0,
      beams: [reused],
      meta: { reused: true, feedbackPenalty: 0, actionRankerCumulativeScore: 0 },
    };
  }

  const config = resolveBeamConfig(input.config);
  const ranker = loadRanker(input);
  const requiredDeployments = minimumDeployments(input);
  const rosterFeatures = input.rosterFeatures.map(operator => ({
    ...operator,
    publicUsagePrior: operator.publicUsagePrior ?? ranker.operatorPrior(operator.operatorId || operator.name),
  }));
  let beam: BeamState[] = [{ actions: [], cumulativeScore: 0, ended: false, meta: { stepScores: [], actionSources: [] } }];
  const beamHistory: BeamState[][] = [];
  const candidateLog: unknown[] = [];

  for (let step = 0; step < config.maxSteps; step++) {
    const next: BeamState[] = [];
    for (const [stateIndex, state] of beam.entries()) {
      if (state.ended) {
        next.push(state);
        continue;
      }
      const deployedCount = state.actions.filter(action => action.type === "Deploy").length;
      const candidates = enumerateCandidateActions({
        stageFeatures: input.stageFeatures,
        rosterFeatures,
        partialActions: state.actions,
      }, {
        maxCandidates: config.candidateActionsPerState,
        seed: config.seed + step + stateIndex,
      }).filter(candidate => {
        if (deployedCount >= requiredDeployments) return true;
        return candidate.action.type === "Deploy" || candidate.action.type === "SkillDaemon";
      });
      const scored = candidates
        .map(candidate => {
          const features = extractActionFeatures({
            stageFeatures: input.stageFeatures,
            rosterFeatures,
            partialActions: state.actions,
            candidateAction: candidate.action,
          });
          const score = actionScore(ranker.score(features), candidate.action, state, config);
          if (config.collectDebug) {
            candidateLog.push({
              step,
              stateIndex,
              source: candidate.source,
              score,
              action: candidate.action,
              featureSummary: {
                step_index: features.step_index,
                action_type_deploy: features.action_type_deploy,
                action_type_end: features.action_type_end,
                cell_x_norm: features.cell_x_norm,
                cell_y_norm: features.cell_y_norm,
              },
            });
          }
          return { candidate, score };
        });
      const normalizer = logNormalizer(scored.map(item => item.score));
      const ranked = scored
        .map(item => ({ ...item, score: item.score - normalizer }))
        .sort((left, right) => right.score - left.score || actionKey(left.candidate.action).localeCompare(actionKey(right.candidate.action)))
        .slice(0, config.topActionsPerState);

      for (const { candidate, score } of ranked) {
        next.push({
          actions: [...state.actions, candidate.action],
          cumulativeScore: state.cumulativeScore + score,
          ended: candidate.action.type === "End",
          meta: {
            stepScores: [...(state.meta?.stepScores || []), score],
            actionSources: [...(state.meta?.actionSources || []), candidate.source],
          },
        });
      }
    }
    beam = sortStates(next).slice(0, config.beamSize);
    beamHistory.push(beam);
    if (beam.length > 0 && beam.every(state => state.ended)) break;
  }

  const best = chooseFinalState(input, beam);
  return {
    stageId: input.stageId,
    actions: best.state.actions,
    score: best.finalScore,
    beams: beam,
    meta: {
      config,
      beamHistory: config.collectDebug ? beamHistory : undefined,
      candidateLog: config.collectDebug ? candidateLog : undefined,
      actionRankerCumulativeScore: best.state.cumulativeScore,
      feedbackPenalty: Number.isFinite(best.feedbackPenalty) ? best.feedbackPenalty : "hard_reject",
      hardRejectedCandidates: best.hardRejectedCandidates,
      publicPriorScriptScore: 0,
      timingSanityScore: 0,
    },
  };
}

function normalizeGeneratedAction(action: BattleAction): BattleAction | null {
  const normalized: BattleAction = { ...action, delay: normalizeDelayToBucket(action.delay ?? 0) };
  if (normalized.type === "End" || normalized.type === "SkillDaemon") return normalized;
  if ((normalized.type === "SkillUse" || normalized.type === "Retreat") && normalized.operatorId) return normalized;
  if (normalized.type !== "Deploy") return null;
  if (!normalized.operatorId || !Number.isInteger(normalized.x) || !Number.isInteger(normalized.y)) return null;
  if (!DIRECTIONS.includes(normalized.direction as never)) return null;
  return normalized;
}

export function repairGeneratedScript(script: GeneratedBattleScript, input?: Pick<GenerateScriptInput, "stageFeatures" | "rosterFeatures">): GeneratedBattleScript {
  const actions: BattleAction[] = [];
  for (const action of script.actions) {
    if (action.type === "End") continue;
    const normalized = normalizeGeneratedAction(action);
    if (!normalized) continue;
    if (input && !isBasicallyLegalAction(normalized, {
      stageFeatures: input.stageFeatures,
      rosterFeatures: input.rosterFeatures,
      partialActions: actions,
    })) continue;
    actions.push(normalized);
  }
  actions.push({ type: "End", delay: 0 });
  return { ...script, actions };
}

function dslScript(generated: GeneratedBattleScript, rosterFeatures: OperatorFeatures[]): BattleScript {
  return {
    stageId: generated.stageId,
    actions: generated.actions,
    meta: {
      rawInput: {
        stage_name: generated.stageId,
        minimum_required: "v6.0.0",
        doc: { title: `${generated.stageId} CPU BattleCore v0`, details: "" },
        opers: rosterFeatures.map(operator => ({ name: operator.operatorId || operator.name })).filter(operator => operator.name),
        groups: [],
        version: 3,
      },
    },
  };
}

export function generatedScriptToCopilot(
  generated: GeneratedBattleScript,
  rosterFeatures: OperatorFeatures[],
  repairInput?: Pick<GenerateScriptInput, "stageFeatures" | "rosterFeatures">
): CopilotGenerationResult {
  let current = generated;
  let dslValidation = validateBattleDsl(dslScript(current, rosterFeatures));
  let copilot = battleDslToCopilotJson(dslScript(current, rosterFeatures));
  let copilotValidation = validateScript(copilot as MaaBattleScript);
  let repaired = false;
  if (!dslValidation.valid || !copilotValidation.valid) {
    current = repairGeneratedScript(current, repairInput);
    repaired = true;
    dslValidation = validateBattleDsl(dslScript(current, rosterFeatures));
    copilot = battleDslToCopilotJson(dslScript(current, rosterFeatures));
    copilotValidation = validateScript(copilot as MaaBattleScript);
  }
  if (!dslValidation.valid || !copilotValidation.valid) {
    throw new Error(JSON.stringify({ dslValidation, copilotValidation }, null, 2));
  }
  return { copilot, dslValidation, copilotValidation, repaired };
}
