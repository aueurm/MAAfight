import { createHash } from "crypto";
import { performance } from "perf_hooks";
import { validateMAAProtocol } from "../copilot/MAAProtocolValidator";
import { exportToCopilotFormat } from "../copilot/ScriptExporter";
import { validateScript } from "../copilot/ScriptValidator";
import { hasCatalogOperator } from "../shared/operatorCatalog";
import type { BattleScript, MapData } from "../types";
import { buildCandidate, buildCandidatePerturbations, buildSquadBeam, type CandidatePerturbation } from "./CandidateBuilder";
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
export type { CandidateScoreBreakdown, EngineOptions, EngineResult, ScoreBreakdown, SearchStats, StageFacts } from "./types";

const DEFAULT_SEARCH: SearchConfig = {
  squadBeamWidth: 32,
  candidateFrontierLimit: 512,
  candidatePoolLimit: 1024,
  positionVariantCount: 6,
  directionVariantCount: 4,
  timingVariantCount: 9,
  orderVariantCount: 5,
  skillVariantCount: 4,
  minimumFullCandidates: 64,
  defaultFullCandidates: 192,
  maximumFullCandidates: 384,
  deadlineMs: 1200,
  deadlineCheckInterval: 8,
  diversityFirstDeployLimit: 64,
  diversityFirstThreeLimit: 4,
  diversityDeployCellsLimit: 64,
  diversityDirectionLimit: 256,
  diversityTimingLimit: 256,
  diversitySkillStrategyLimit: 512,
  diversitySquadLimit: 64,
  diversityReservedPerGroup: 2,
};

type DiversityGroup = "publicPrior" | "base" | "perturbation" | "feedbackAvoidance";

interface DiversityCandidate {
  script: BattleScript;
  scriptHash: string;
  squadSignature: string;
  cheapScore: number;
  diversityGroups?: DiversityGroup[];
}

interface CheapCandidate extends DiversityCandidate {
  picks: EnginePick[];
  warnings: string[];
}

interface DiversitySignature {
  firstDeploy: string;
  firstThree: string;
  deployCells: string;
  directions: string;
  timing: string;
  skillStrategy: string;
  squad: string;
}

const engagementCache = new Map<string, ReturnType<typeof scoreCandidate>>();
const DIVERSITY_GROUPS: DiversityGroup[] = ["publicPrior", "base", "perturbation", "feedbackAvoidance"];
const VALID_DIRECTIONS = new Set(["Right", "Down", "Left", "Up"]);

export function computeScriptHash(script: BattleScript): string {
  return createHash("sha256").update(exportToCopilotFormat(script, { compress: true })).digest("hex");
}

export function isCandidateProtocolSafe(
  script: BattleScript,
  mapData: MapData,
  picks: EnginePick[] = [],
  stageCode?: string
): boolean {
  if (!validateScript(script, mapData).valid || !validateMAAProtocol(script).valid) return false;
  if (stageCode !== undefined && script.stage_name !== stageCode) return false;
  if (!script.minimum_required || !Array.isArray(script.opers) || !Array.isArray(script.groups)) return false;
  if (script.groups.length !== 0 || script.opers.length === 0 || script.opers.length > 12) return false;
  const operatorNames = new Set(script.opers.map(operator => operator.name));
  if (operatorNames.size !== script.opers.length || [...operatorNames].some(name => !hasCatalogOperator(name))) return false;
  const pickByName = new Map(picks.map(pick => [pick.name, pick]));
  const deploys = script.actions.filter(action => action.type === "Deploy");
  const occupied = new Set<string>();
  const deploymentPoint = (row: number, col: number) =>
    mapData.deploymentPoints.find(point => point.row === row && point.col === col);

  for (const action of script.actions) {
    if ((action.type === "Deploy" || action.type === "Skill" || action.type === "Retreat")
      && (!action.name || !operatorNames.has(action.name))) {
      return false;
    }
  }
  for (const action of deploys) {
    if (!action.name || !action.location || !VALID_DIRECTIONS.has(action.direction || "")) return false;
    const [row, col] = action.location;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
    const key = `${action.location[0]},${action.location[1]}`;
    if (occupied.has(key)) return false;
    occupied.add(key);
    const point = deploymentPoint(row, col);
    if (!point || mapData.tiles[row]?.[col]?.buildableType === "none") return false;
    const pick = pickByName.get(action.name);
    if (pick && point.buildableType !== "all") {
      const expected = pick.profile.position === "MELEE" ? "melee" : "ranged";
      if (point.buildableType !== expected) return false;
    }
  }
  return deploys.length > 0;
}

function engagementKey(candidate: CheapCandidate, encounterHash: string, combatVersion: string): string {
  const actions = candidate.script.actions.map(action => ({
    type: action.type,
    name: action.name,
    location: action.location,
    direction: action.direction,
    costs: action.costs,
    pre_delay: action.pre_delay,
    skip_if_not_ready: action.skip_if_not_ready,
  }));
  return createHash("sha256").update(JSON.stringify({
    scorer: "candidate-score-v2",
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
    .sort((left, right) => right.score - left.score
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
  const search = options.search || {};
  const config = { ...DEFAULT_SEARCH, ...search };
  if (search.completeCandidateLimit !== undefined) config.candidateFrontierLimit = search.completeCandidateLimit;
  if (search.candidateVariantLimit !== undefined) config.candidatePoolLimit = search.candidateVariantLimit;
  return config;
}

function breakdownWithFeedbackPenalty(breakdown: ScoreBreakdown, penalty: number): ScoreBreakdown {
  const feedbackPenalty = Math.max(0, penalty);
  return {
    ...breakdown,
    timing: Math.max(0, breakdown.timing - Math.min(6, feedbackPenalty * 0.2)),
    feedbackPenalty,
  };
}

function deployActions(script: BattleScript): Array<BattleScript["actions"][number] & { location: [number, number] }> {
  return script.actions.filter((action): action is BattleScript["actions"][number] & { location: [number, number] } =>
    action.type === "Deploy" && Boolean(action.location));
}

function cellKey(location: [number, number]): string {
  return `${location[0]},${location[1]}`;
}

function deployActionKey(action: BattleScript["actions"][number] & { location: [number, number] }): string {
  return `${action.name || "?"}@${cellKey(action.location)}:${action.direction || "None"}`;
}

function skillStrategy(script: BattleScript): string {
  const hasDaemon = script.actions.some(action => action.type === "SkillDaemon");
  const hasManual = script.actions.some(action => action.type === "Skill");
  if (hasDaemon && hasManual) return "mixed";
  if (hasDaemon) return "daemon";
  if (hasManual) return "manual";
  return "none";
}

function diversitySignature(candidate: DiversityCandidate): DiversitySignature {
  const deploys = deployActions(candidate.script);
  const deployCells = [...new Set(deploys.map(action => cellKey(action.location)))].sort();
  return {
    firstDeploy: deploys[0] ? cellKey(deploys[0].location) : "none",
    firstThree: deploys.slice(0, 3).map(deployActionKey).join("|") || "none",
    deployCells: deployCells.join("|") || "none",
    directions: deploys.map(action => action.direction || "None").join("|") || "none",
    timing: deploys.map(action => Math.round(Math.max(0, action.pre_delay ?? action.time_elapsed ?? action.time ?? 0) / 1000)).join("|") || "none",
    skillStrategy: skillStrategy(candidate.script),
    squad: candidate.squadSignature,
  };
}

function diversityGroupsFor(perturbation: CandidatePerturbation, feedbackPenalty: number, hasFeedback: boolean): DiversityGroup[] {
  const groups: DiversityGroup[] = [];
  const isBase = perturbation.positionVariant === 0
    && perturbation.directionVariant === 0
    && perturbation.orderVariant === 0
    && perturbation.skillVariant === 0;
  if (perturbation.positionVariant === 0 && perturbation.directionVariant === 0) groups.push("publicPrior");
  if (isBase) groups.push("base");
  if (!isBase) groups.push("perturbation");
  if (hasFeedback && feedbackPenalty <= 0.5) groups.push("feedbackAvoidance");
  return groups;
}

function underLimit(counts: Map<string, number>, key: string, limit: number): boolean {
  return (counts.get(key) || 0) < Math.max(1, Math.floor(limit));
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) || 0) + 1);
}

export function selectDiverseCheapCandidates<T extends DiversityCandidate>(
  candidates: T[],
  limit: number,
  config: SearchConfig
): T[] {
  const selected: T[] = [];
  const selectedHashes = new Set<string>();
  const firstDeployCounts = new Map<string, number>();
  const firstThreeCounts = new Map<string, number>();
  const deployCellsCounts = new Map<string, number>();
  const directionCounts = new Map<string, number>();
  const timingCounts = new Map<string, number>();
  const skillStrategyCounts = new Map<string, number>();
  const squadCounts = new Map<string, number>();
  const target = Math.max(0, Math.floor(limit));
  const ordered = [...candidates].sort((left, right) =>
    right.cheapScore - left.cheapScore || left.scriptHash.localeCompare(right.scriptHash));

  const add = (candidate: T): boolean => {
    if (selected.length >= target || selectedHashes.has(candidate.scriptHash)) return false;
    const signature = diversitySignature(candidate);
    if (!underLimit(firstDeployCounts, signature.firstDeploy, config.diversityFirstDeployLimit)
      || !underLimit(firstThreeCounts, signature.firstThree, config.diversityFirstThreeLimit)
      || !underLimit(deployCellsCounts, signature.deployCells, config.diversityDeployCellsLimit)
      || !underLimit(directionCounts, signature.directions, config.diversityDirectionLimit)
      || !underLimit(timingCounts, signature.timing, config.diversityTimingLimit)
      || !underLimit(skillStrategyCounts, signature.skillStrategy, config.diversitySkillStrategyLimit)
      || !underLimit(squadCounts, signature.squad, config.diversitySquadLimit)) {
      return false;
    }
    selected.push(candidate);
    selectedHashes.add(candidate.scriptHash);
    increment(firstDeployCounts, signature.firstDeploy);
    increment(firstThreeCounts, signature.firstThree);
    increment(deployCellsCounts, signature.deployCells);
    increment(directionCounts, signature.directions);
    increment(timingCounts, signature.timing);
    increment(skillStrategyCounts, signature.skillStrategy);
    increment(squadCounts, signature.squad);
    return true;
  };

  for (const group of DIVERSITY_GROUPS) {
    let kept = 0;
    for (const candidate of ordered) {
      if (kept >= config.diversityReservedPerGroup || selected.length >= target) break;
      if (!candidate.diversityGroups?.includes(group)) continue;
      if (add(candidate)) kept++;
    }
  }
  for (const candidate of ordered) add(candidate);

  return selected.sort((left, right) =>
    right.cheapScore - left.cheapScore || left.scriptHash.localeCompare(right.scriptHash));
}

export function generateCopilotScript(stageCode: string, mapData: MapData, options: EngineOptions = {}): EngineResult {
  const now = options.now || (() => performance.now());
  const startedAt = now();
  const config = configFor(options);
  const facts = extractStageFacts(mapData);
  const encounter = buildEncounterContext(mapData, facts);
  const versions = getModelVersions();
  const squadBeam = buildSquadBeam(facts, encounter, { ...options, search: config });
  const perturbations = buildCandidatePerturbations(stageCode, facts, config);
  const cheapCandidates: CheapCandidate[] = [];
  let rejectedCandidates = 0;
  const hasFeedback = Boolean(options.feedbackPenalty || options.feedbackAdjustment);

  for (const perturbation of perturbations) {
    for (const picks of squadBeam.squads) {
      if (cheapCandidates.length >= config.candidatePoolLimit) break;
      const built = buildCandidate({
        stageCode,
        mapData,
        facts,
        picks,
        positionVariant: perturbation.positionVariant,
        directionVariant: perturbation.directionVariant,
        timingVariant: Math.round(perturbation.timingDelayMs / 250),
        timingDelayMs: perturbation.timingDelayMs,
        orderVariant: perturbation.orderVariant,
        skillVariant: perturbation.skillVariant,
        options: { ...options, search: config },
      });
      const scriptHash = computeScriptHash(built.script);
      if (!isCandidateProtocolSafe(built.script, mapData, built.picks, stageCode) || options.excludedHashes?.has(scriptHash)) {
        rejectedCandidates++;
        continue;
      }
      const cheapBreakdown = cheapScoreCandidate(built.script, built.picks, facts, encounter);
      const cheapPenalty = options.feedbackPenalty?.(built.script, scriptHash, cheapBreakdown);
      const legacyAdjustment = cheapPenalty === undefined
        ? options.feedbackAdjustment?.(built.script, scriptHash, cheapBreakdown) || 0
        : 0;
      const feedbackPenalty = Math.max(0, cheapPenalty ?? -legacyAdjustment);
      cheapCandidates.push({
        script: built.script,
        picks: built.picks,
        scriptHash,
        squadSignature: squadSignature(built.picks),
        cheapScore: weightedScore(cheapBreakdown),
        diversityGroups: diversityGroupsFor(perturbation, feedbackPenalty, hasFeedback),
        warnings: [...squadBeam.warnings, ...built.warnings],
      });
    }
    if (cheapCandidates.length >= config.candidatePoolLimit) break;
  }
  const frontier = selectDiverseCheapCandidates(cheapCandidates, config.candidateFrontierLimit, config);
  if (frontier.length === 0) throw new Error("V2 skill engine produced no protocol-valid candidate before scoring");

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
    const explicitPenalty = options.feedbackPenalty?.(candidate.script, candidate.scriptHash, scored.breakdown);
    const legacyAdjustment = explicitPenalty === undefined
      ? options.feedbackAdjustment?.(candidate.script, candidate.scriptHash, scored.breakdown) || 0
      : 0;
    const breakdown = breakdownWithFeedbackPenalty(scored.breakdown, explicitPenalty ?? -legacyAdjustment);
    const score = weightedScore(breakdown);
    const warnings = [...new Set([...candidate.warnings, ...scored.coverageGaps])];
    candidate.script.metadata = {
      ...candidate.script.metadata,
      candidateScore: score,
      candidateScoreBreakdown: { ...breakdown },
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
      breakdown,
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
          && distinctSquadMargin(results) >= 1;
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
  if (!validateScript(best.script, mapData).valid || !validateMAAProtocol(best.script).valid) {
    throw new Error("V2 best candidate failed final validation");
  }
  return best;
}

export function clearSearchCaches(): void {
  engagementCache.clear();
}
