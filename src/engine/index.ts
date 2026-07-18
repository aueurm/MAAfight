import { createHash } from "crypto";
import { performance } from "perf_hooks";
import { exportToCopilotFormat } from "../copilot/ScriptExporter";
import type { BattleScript, MapData } from "../types";
import { buildCandidate, buildSquadBeam } from "./CandidateBuilder";
import { buildEncounterContext } from "./EncounterContext";
import { squadSignature } from "./helpers";
import { cheapScoreCandidate, getModelVersions, scoreCandidate, weightedScore } from "./Scoring";
import { extractStageFacts } from "./StageFacts";
import type {
  EngineOptions,
  EnginePick,
  EngineResult,
  ScoreBreakdown,
  SearchConfig,
  SearchStats,
} from "./types";

export { extractStageFacts } from "./StageFacts";
export type { EngineOptions, EngineResult, ScoreBreakdown, SearchStats, StageFacts } from "./types";

const DEFAULT_SEARCH: SearchConfig = {
  squadBeamWidth: 32,
  completeCandidateLimit: 512,
  minimumFullCandidates: 64,
  defaultFullCandidates: 192,
  maximumFullCandidates: 384,
  deadlineMs: 1200,
  deadlineCheckInterval: 8,
};

interface CheapCandidate {
  script: BattleScript;
  picks: EnginePick[];
  scriptHash: string;
  squadSignature: string;
  cheapScore: number;
  warnings: string[];
}

const engagementCache = new Map<string, ReturnType<typeof scoreCandidate>>();

export function computeScriptHash(script: BattleScript): string {
  return createHash("sha256").update(exportToCopilotFormat(script, { compress: true })).digest("hex");
}

function hardConstraints(script: BattleScript, mapData: MapData): boolean {
  const operatorNames = new Set(script.opers.map(operator => operator.name));
  const deploys = script.actions.filter(action => action.type === "Deploy");
  const occupied = new Set<string>();
  const active = new Map<string, string>();
  for (const action of script.actions) {
    if (action.type === "Deploy") {
      if (!action.name || !operatorNames.has(action.name) || !action.location) return false;
      const key = `${action.location[0]},${action.location[1]}`;
      if (active.has(action.name) || occupied.has(key)) return false;
      if (!mapData.deploymentPoints.some(point => point.row === action.location![0] && point.col === action.location![1])) return false;
      active.set(action.name, key);
      occupied.add(key);
      if (active.size > mapData.options.characterLimit) return false;
    } else if (action.type === "Retreat") {
      if (!action.name) return false;
      const key = active.get(action.name);
      if (!key) return false;
      active.delete(action.name);
      occupied.delete(key);
    }
  }
  return script.groups.length === 0 && script.opers.length <= 12 && deploys.length > 0;
}

function engagementKey(candidate: CheapCandidate, encounterHash: string, combatVersion: string): string {
  const actions = candidate.script.actions.filter(action => action.type === "Deploy").map(action => ({
    name: action.name,
    location: action.location,
    direction: action.direction,
    costs: action.costs,
    pre_delay: action.pre_delay,
  }));
  return createHash("sha256").update(JSON.stringify({
    scorer: "skill-engagement-v1",
    combatVersion,
    encounterHash,
    squad: candidate.squadSignature,
    actions,
  })).digest("hex");
}

function bestOf(results: EngineResult[]): EngineResult | undefined {
  const maximumScore = Math.max(...results.map(result => result.score));
  if (!Number.isFinite(maximumScore)) return undefined;
  return results
    .filter(result => result.score >= maximumScore - 0.5)
    .sort((left, right) => right.skillCoverage - left.skillCoverage
      || left.coverageGaps.length - right.coverageGaps.length
      || right.score - left.score
      || left.scriptHash.localeCompare(right.scriptHash))[0];
}

function distinctSquadMargin(results: EngineResult[]): number {
  const ordered = [...results].sort((left, right) => right.score - left.score || left.scriptHash.localeCompare(right.scriptHash));
  const first = ordered[0];
  if (!first) return 0;
  const firstSignature = String(first.script.metadata.squadSignature || "");
  const second = ordered.find(result => String(result.script.metadata.squadSignature || "") !== firstSignature);
  return second ? first.score - second.score : Number.POSITIVE_INFINITY;
}

function configFor(options: EngineOptions): SearchConfig {
  return { ...DEFAULT_SEARCH, ...options.search };
}

export function generateCopilotScript(stageCode: string, mapData: MapData, options: EngineOptions = {}): EngineResult {
  const now = options.now || (() => performance.now());
  const startedAt = now();
  const config = configFor(options);
  const facts = extractStageFacts(mapData);
  const encounter = buildEncounterContext(mapData, facts);
  const versions = getModelVersions();
  const squadBeam = buildSquadBeam(facts, encounter, { ...options, search: config });
  const cheapCandidates: CheapCandidate[] = [];
  let rejectedCandidates = 0;

  for (const picks of squadBeam.squads) {
    for (let positionVariant = 0; positionVariant < 4; positionVariant++) {
      for (let timingVariant = 0; timingVariant < 4; timingVariant++) {
        const built = buildCandidate({
          stageCode,
          mapData,
          facts,
          openingPressure: encounter.demand.deployment >= 0.5,
          picks,
          positionVariant,
          timingVariant,
          options,
        });
        const scriptHash = computeScriptHash(built.script);
        if (!hardConstraints(built.script, mapData) || options.excludedHashes?.has(scriptHash)) {
          rejectedCandidates++;
          continue;
        }
        const cheapBreakdown = cheapScoreCandidate(built.script, built.picks, facts, encounter);
        cheapCandidates.push({
          script: built.script,
          picks: built.picks,
          scriptHash,
          squadSignature: squadSignature(built.picks),
          cheapScore: weightedScore(cheapBreakdown),
          warnings: [...squadBeam.warnings, ...built.warnings],
        });
      }
    }
  }
  cheapCandidates.sort((left, right) => right.cheapScore - left.cheapScore || left.scriptHash.localeCompare(right.scriptHash));
  const frontier = cheapCandidates.slice(0, config.completeCandidateLimit);
  if (frontier.length === 0) throw new Error("V2 skill engine produced no protocol-safe candidate");

  const results: EngineResult[] = [];
  let target = Math.min(config.minimumFullCandidates, frontier.length);
  let budgetTier: 64 | 192 | 384 = 64;
  let bestAt32: EngineResult | undefined;
  let bestAt128: EngineResult | undefined;
  let terminationReason: SearchStats["terminationReason"] = "frontier-exhausted";

  for (let index = 0; index < frontier.length && results.length < target; index++) {
    const candidate = frontier[index];
    const cacheKey = engagementKey(candidate, encounter.hash, versions.combat);
    let scored = engagementCache.get(cacheKey);
    if (!scored) {
      scored = scoreCandidate(candidate.script, candidate.picks, facts, encounter);
      engagementCache.set(cacheKey, scored);
    }
    const feedback = options.feedbackAdjustment?.(candidate.script, candidate.scriptHash, scored.breakdown) || 0;
    const score = Math.max(0, Math.min(100, weightedScore(scored.breakdown) + feedback));
    const warnings = [...new Set([...candidate.warnings, ...scored.coverageGaps])];
    candidate.script.metadata = {
      ...candidate.script.metadata,
      candidateScore: score,
      candidateScoreBreakdown: { ...scored.breakdown },
      corpusModelVersion: versions.corpus,
      combatModelVersion: versions.combat,
      combatCoverage: scored.coverage,
      skillCoverage: scored.skillCoverage,
      coverageGaps: scored.coverageGaps,
      squadSignature: candidate.squadSignature,
      stageContentHash: encounter.hash,
      warnings,
    };
    results.push({
      script: candidate.script,
      facts,
      scriptHash: candidate.scriptHash,
      score,
      breakdown: scored.breakdown,
      modelVersion: versions.corpus,
      combatModelVersion: versions.combat,
      combatCoverage: scored.coverage,
      skillCoverage: scored.skillCoverage,
      coverageGaps: scored.coverageGaps,
      evaluatedCandidates: results.length + 1,
      rejectedCandidates,
      stageContentHash: encounter.hash,
      gameDataCommit: versions.gameDataCommit,
      searchStats: {} as SearchStats,
      warnings,
    });

    if (results.length === 32) bestAt32 = bestOf(results);
    if (results.length === 128) bestAt128 = bestOf(results);

    if (results.length % Math.max(1, config.deadlineCheckInterval) === 0 && now() - startedAt >= config.deadlineMs) {
      terminationReason = "deadline";
      break;
    }

    if (results.length === target) {
      if (target === Math.min(config.minimumFullCandidates, frontier.length)) {
        const currentBest = bestOf(results);
        const converged = (facts.difficulty === "easy" || facts.difficulty === "medium")
          && Boolean(bestAt32 && currentBest)
          && bestAt32!.script.metadata.squadSignature === currentBest!.script.metadata.squadSignature
          && currentBest!.score - bestAt32!.score <= 0.25
          && distinctSquadMargin(results) >= 1
          && currentBest!.coverageGaps.length === 0;
        if (converged || target >= frontier.length) {
          terminationReason = converged ? "converged" : "frontier-exhausted";
          break;
        }
        target = Math.min(config.defaultFullCandidates, frontier.length);
        budgetTier = 192;
      } else if (target === Math.min(config.defaultFullCandidates, frontier.length)) {
        const currentBest = bestOf(results);
        const competitive = distinctSquadMargin(results) < 0.5;
        const changed = Boolean(bestAt128 && currentBest)
          && bestAt128!.script.metadata.squadSignature !== currentBest!.script.metadata.squadSignature;
        if (facts.difficulty === "hard" || facts.difficulty === "extreme" || competitive || changed) {
          target = Math.min(config.maximumFullCandidates, frontier.length);
          budgetTier = 384;
          if (target === results.length) {
            terminationReason = "frontier-exhausted";
            break;
          }
        } else {
          terminationReason = "default-budget";
          break;
        }
      } else {
        terminationReason = target >= frontier.length ? "frontier-exhausted" : "maximum-budget";
        break;
      }
    }
  }

  const best = bestOf(results);
  if (!best) throw new Error("V2 skill engine deadline expired before a complete candidate was scored");
  const elapsedMs = Math.max(0, now() - startedAt);
  const searchStats: SearchStats = {
    expandedSquads: squadBeam.expandedStates,
    cheapCompleteCandidates: frontier.length,
    fullyScoredCandidates: results.length,
    rejectedCandidates,
    budgetTier,
    terminationReason,
    elapsedMs,
  };
  best.searchStats = searchStats;
  best.evaluatedCandidates = results.length;
  best.rejectedCandidates = rejectedCandidates;
  best.script.metadata = { ...best.script.metadata, searchStats };
  return best;
}

export function clearSearchCaches(): void {
  engagementCache.clear();
}
