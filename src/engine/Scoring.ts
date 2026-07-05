import type { BattleScript, BattleScriptAction } from "../types";
import { getCombatModelInfo } from "./CombatModel";
import {
  average,
  copilotPrior,
  copilotPriorStats,
  corpusContextStats,
  corpusModel,
  publicPriorScoreFromStats,
  scriptDirectionPriorScore,
  scriptPositionPriorScore,
  scriptTimingPriorScore,
  type CopilotPriorStats,
} from "./CopilotPrior";
import { clamp } from "./helpers";
import type { CandidateScoreBreakdown, EncounterContext, EnginePick, LegacyScoreBreakdown, ScoreBreakdown, StageFacts } from "./types";

function nearest(point: { row: number; col: number }, targets: Array<{ row: number; col: number }>): number {
  return targets.length
    ? Math.min(...targets.map(target => Math.abs(point.row - target.row) + Math.abs(point.col - target.col)))
    : 0;
}

function deployActions(script: BattleScript): BattleScriptAction[] {
  return script.actions.filter(action => action.type === "Deploy" && action.location);
}

function deployedPairs(script: BattleScript, picks: EnginePick[]): Array<{ action: BattleScriptAction; pick: EnginePick }> {
  const byName = new Map(picks.map(pick => [pick.name, pick]));
  return script.actions
    .filter(action => action.type === "Deploy" && action.name)
    .map(action => ({ action, pick: byName.get(action.name!) }))
    .filter((pair): pair is { action: BattleScriptAction; pick: EnginePick } => Boolean(pair.pick));
}

function publicPriorScore(script: BattleScript, picks: EnginePick[], facts: StageFacts): number {
  return publicPriorScoreFromStats(script, picks, copilotPriorStats(script.stage_name, facts), corpusContextStats(facts));
}

function deploymentPointFor(action: BattleScriptAction, facts: StageFacts) {
  return action.location
    ? facts.deploymentPoints.find(point => point.row === action.location![0] && point.col === action.location![1])
    : undefined;
}

function deployTypeScore(action: BattleScriptAction, pick: EnginePick | undefined, facts: StageFacts): number {
  const point = deploymentPointFor(action, facts);
  if (!point) return 0;
  if (!pick || point.buildableType === "all") return 100;
  return (pick.profile.position === "MELEE" && point.buildableType === "melee")
    || (pick.profile.position === "RANGED" && point.buildableType === "ranged")
    ? 100
    : 0;
}

function geometrySanityScore(action: BattleScriptAction, facts: StageFacts): number {
  if (!action.location || !deploymentPointFor(action, facts)) return 0;
  const mapSpan = Math.max(1, facts.rows + facts.cols);
  const routeDistance = nearest({ row: action.location[0], col: action.location[1] }, facts.routeCells);
  const goalDistance = nearest({ row: action.location[0], col: action.location[1] }, facts.goalCells);
  const routePenalty = facts.routeCells.length ? Math.min(45, routeDistance / mapSpan * 140) : 10;
  const goalPenalty = facts.goalCells.length ? Math.min(25, goalDistance / mapSpan * 60) : 5;
  return clamp(100 - routePenalty - goalPenalty);
}

function placementScore(script: BattleScript, picks: EnginePick[], facts: StageFacts): number {
  const deployed = deployedPairs(script, picks);
  if (!deployed.length) return 0;
  const publicFit = scriptPositionPriorScore(script, copilotPriorStats(script.stage_name, facts));
  const typeFit = average(deployed.map(({ action, pick }) => deployTypeScore(action, pick, facts)));
  const geometry = average(deployed.map(({ action }) => geometrySanityScore(action, facts)));
  const unique = new Set(deployed.map(({ action }) => `${action.location![0]},${action.location![1]}`)).size / deployed.length * 100;
  const localFit = typeFit * 0.45 + geometry * 0.40 + unique * 0.15;
  return clamp(publicFit === null ? localFit : publicFit * 0.45 + localFit * 0.55);
}

function facingRouteScore(action: BattleScriptAction, facts: StageFacts): number {
  if (!action.location || !action.direction || facts.routeCells.length === 0) return 50;
  const target = facts.routeCells
    .map(cell => ({ cell, distance: nearest({ row: action.location![0], col: action.location![1] }, [cell]) }))
    .sort((left, right) => left.distance - right.distance)[0]?.cell;
  if (!target) return 50;
  const rowDelta = target.row - action.location[0];
  const colDelta = target.col - action.location[1];
  if (Math.abs(colDelta) >= Math.abs(rowDelta)) {
    if (colDelta > 0) return action.direction === "Right" ? 100 : 35;
    if (colDelta < 0) return action.direction === "Left" ? 100 : 35;
  }
  if (rowDelta > 0) return action.direction === "Down" ? 100 : 35;
  if (rowDelta < 0) return action.direction === "Up" ? 100 : 35;
  return 70;
}

function directionScore(script: BattleScript, facts: StageFacts): number {
  const deployed = deployActions(script);
  if (!deployed.length) return 0;
  const publicFit = scriptDirectionPriorScore(script, copilotPriorStats(script.stage_name, facts));
  const localFit = average(deployed.map(action => facingRouteScore(action, facts)));
  return clamp(publicFit === null ? localFit : publicFit * 0.60 + localFit * 0.40);
}

function actionDelayMs(action: BattleScriptAction): number {
  return Math.max(0, action.pre_delay ?? action.time_elapsed ?? action.time ?? 0);
}

function timedDeploys(script: BattleScript): Array<{ action: BattleScriptAction; cost: number; delayMs: number; elapsedSec: number }> {
  let elapsedSec = 0;
  return script.actions
    .filter(action => action.type === "Deploy")
    .map(action => {
      const delayMs = actionDelayMs(action);
      elapsedSec += delayMs / 1000;
      return {
        action,
        cost: Math.max(0, action.costs || 0),
        delayMs,
        elapsedSec,
      };
    });
}

function costFeasibilityScore(script: BattleScript, facts: StageFacts): number {
  let available = facts.initialCost;
  let totalDeficit = 0;
  let highCostRisk = 0;
  let previousCost = 0;
  for (const deploy of timedDeploys(script)) {
    available += deploy.delayMs / 1000 + Math.max(0, deploy.action.cost_changes || 0);
    const deficit = Math.max(0, deploy.cost - available);
    totalDeficit += deficit;
    if (previousCost >= 20 && deploy.cost >= 20 && deploy.delayMs < 3000) {
      highCostRisk += (3000 - deploy.delayMs) / 1000 + Math.max(0, previousCost + deploy.cost - 40) / 10;
    }
    available = Math.max(0, available - deploy.cost);
    previousCost = deploy.cost;
  }
  return clamp(100 - totalDeficit * 4 - highCostRisk * 8);
}

function deploymentPaceScore(script: BattleScript): number {
  const deploys = timedDeploys(script);
  if (deploys.length === 0) return 0;
  const lastDeploySec = deploys.at(-1)!.elapsedSec;
  const comfortableSec = Math.max(20, deploys.length * 6);
  return clamp(100 - Math.max(0, lastDeploySec - comfortableSec) * 2);
}

function delayReasonablenessScore(script: BattleScript): number {
  const deploys = timedDeploys(script);
  if (deploys.length === 0) return 0;
  return average(deploys.map(({ delayMs }) => {
    const seconds = delayMs / 1000;
    if (seconds <= 3) return 100;
    if (seconds <= 15) return 100 - (seconds - 3) * 2;
    return clamp(76 - (seconds - 15) * 3);
  }));
}

export function timingScoreFromStats(script: BattleScript, facts: StageFacts, priorStats: CopilotPriorStats[] = []): number {
  return clamp(
    costFeasibilityScore(script, facts) * 0.45
      + (scriptTimingPriorScore(script, priorStats) ?? 50) * 0.25
      + deploymentPaceScore(script) * 0.20
      + delayReasonablenessScore(script) * 0.10
  );
}

function timingScore(script: BattleScript, facts: StageFacts): number {
  return timingScoreFromStats(script, facts, copilotPriorStats(script.stage_name, facts));
}

function operatorPowerScore(picks: EnginePick[], encounter: EncounterContext): number {
  const physical = picks.reduce((sum, pick) => sum + (pick.profile.damageType === "physical" ? 1 : 0), 0);
  const arts = picks.reduce((sum, pick) => sum + (pick.profile.damageType === "arts" ? 1 : 0), 0);
  const healing = picks.reduce((sum, pick) => sum + pick.profile.metrics.healingHps, 0);
  const blocking = picks.reduce((sum, pick) => sum + (pick.profile.position === "MELEE" ? pick.profile.attributes.block : 0), 0);
  const antiAir = picks.reduce((sum, pick) => sum + Number(pick.profile.position === "RANGED" && pick.profile.range.length >= 3), 0);
  const singleTarget = picks.reduce((sum, pick) => sum + Number(pick.profile.maxTargets <= 1) * pick.profile.metrics.burstDps, 0);
  const area = picks.reduce((sum, pick) => sum + pick.profile.maxTargets * (pick.profile.metrics.cycleDps || 0), 0);
  const laneHold = picks.reduce((sum, pick) => sum + Number(pick.profile.position === "MELEE")
    * (pick.profile.attributes.block + pick.profile.metrics.physicalEhp / 10000), 0);
  const support = picks.reduce((sum, pick) => sum + pick.profile.metrics.healingHps + pick.profile.metrics.controlSeconds * 100, 0);
  const subclasses = new Set(picks.map(pick => pick.profile.subProfession));
  const checks = [
    Math.min(1, physical / Math.max(1, encounter.demand.physical * 3)),
    Math.min(1, arts / Math.max(1, encounter.demand.arts * 3)),
    Math.min(1, healing / Math.max(300, encounter.demand.healing * 1200)),
    Math.min(1, blocking / Math.max(2, encounter.demand.block * 8)),
    Math.min(1, antiAir / Math.max(1, encounter.demand.antiAir * 4)),
    Math.min(1, singleTarget / Math.max(500, encounter.demand.singleTarget * 5000)),
    Math.min(1, area / Math.max(500, encounter.demand.area * 7000)
      + Number([...subclasses].some(value => value && ["aoesniper", "bombarder", "splashcaster", "chain", "reaper", "centurion"].includes(value))) * 0.25),
    Math.min(1, laneHold / Math.max(2, encounter.demand.laneHold * 12)),
    Math.min(1, support / Math.max(300, encounter.demand.support * 3000)
      + Number([...subclasses].some(value => value && ["slower", "underminer", "bard", "ritualist", "blessing", "alchemist"].includes(value))) * 0.25),
  ];
  return average(checks) * 100;
}

function breakdown(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext,
  _full: boolean
): ScoreBreakdown {
  return {
    publicPrior: publicPriorScore(script, picks, facts),
    placement: placementScore(script, picks, facts),
    direction: directionScore(script, facts),
    timing: timingScore(script, facts),
    operatorPower: operatorPowerScore(picks, encounter),
    feedbackPenalty: 0,
  };
}

export function cheapScoreCandidate(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext
): ScoreBreakdown {
  return breakdown(script, picks, facts, encounter, false);
}

export function scoreCandidate(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext
): { breakdown: ScoreBreakdown; coverage: number; skillCoverage: number; coverageGaps: string[] } {
  const deployed = deployedPairs(script, picks).map(pair => pair.pick);
  const skillCoverage = deployed.length
    ? average(deployed.map(pick => pick.profile.confidence === "exact" ? 1 : pick.profile.confidence === "partial" ? 0.5 : 0.25))
    : 0;
  return {
    breakdown: breakdown(script, picks, facts, encounter, true),
    coverage: deployed.length ? 1 : 0,
    skillCoverage,
    coverageGaps: [...new Set(deployed.flatMap(pick => pick.profile.modelCoverageGaps))].sort(),
  };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function toCandidateScoreBreakdown(value: ScoreBreakdown | LegacyScoreBreakdown | Record<string, number>): CandidateScoreBreakdown {
  if ("publicPrior" in value || "placement" in value || "direction" in value || "operatorPower" in value || "feedbackPenalty" in value) {
    return {
      publicPrior: finite(value.publicPrior, 50),
      placement: finite(value.placement, 50),
      direction: finite(value.direction, finite(value.placement, 50)),
      timing: finite(value.timing, 50),
      operatorPower: finite(value.operatorPower, 50),
      feedbackPenalty: Math.max(0, finite(value.feedbackPenalty, 0)),
    };
  }
  return {
    publicPrior: finite(value.corpus, 50),
    placement: finite(value.position, 50),
    direction: finite(value.position, 50),
    timing: finite(value.timing, 50),
    operatorPower: average([finite(value.tasks, 50), finite(value.combat, 50)]),
    feedbackPenalty: 0,
  };
}

export function weightedScore(value: ScoreBreakdown | LegacyScoreBreakdown | Record<string, number>): number {
  const breakdown = toCandidateScoreBreakdown(value);
  return clamp(
    breakdown.publicPrior * 0.28
      + breakdown.placement * 0.22
      + breakdown.direction * 0.18
      + breakdown.timing * 0.20
      + breakdown.operatorPower * 0.12
      - breakdown.feedbackPenalty
  );
}

export function getModelVersions(): { corpus: string; combat: string; gameDataCommit: string } {
  const combat = getCombatModelInfo();
  const publicVersion = copilotPrior.modelVersion ? `+${copilotPrior.modelVersion}` : "";
  return { corpus: `${corpusModel.modelVersion}${publicVersion}`, combat: combat.modelVersion, gameDataCommit: combat.commit };
}
