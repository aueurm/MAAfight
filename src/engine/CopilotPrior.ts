import corpusJson from "../data/corpusPrior.v1.json";
import copilotPriorJson from "../data/copilotPrior.v1.json";
import type { BattleScript, BattleScriptAction } from "../types";
import { clamp } from "./helpers";
import type { EnginePick, StageFacts } from "./types";

export interface CopilotPriorStats {
  averages: { actions: number; deploys: number; skills: number; fixedOpers: number };
  rates: { speedUp: number; skillDaemon: number };
  actionTypesPerScript?: Record<string, number>;
  firstActionRates?: Record<string, number>;
  directionRates?: Record<string, number>;
  directionHeatmap?: Record<string, number>;
  deployHeatmap?: Record<string, number>;
  firstDeploys?: Record<string, number>;
  deployTiming?: Record<string, number>;
  skillTiming?: Record<string, number>;
  operatorUsage?: Record<string, number>;
  skillUsage?: Record<string, number>;
}

export const corpusModel = corpusJson as unknown as {
  modelVersion: string;
  contexts: Record<string, CopilotPriorStats>;
};

export const copilotPrior = copilotPriorJson as unknown as {
  modelVersion?: string;
  contexts?: Record<string, CopilotPriorStats>;
  stages?: Record<string, CopilotPriorStats>;
};

export function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function contextNames(facts: StageFacts): string[] {
  return [
    "global",
    facts.bossCount > 0 ? "boss" : "no_boss",
    facts.flyingRouteCount > 0 ? "flying" : "ground_only",
    facts.laneCount > 1 ? "multi_lane" : "single_lane",
    facts.totalHp >= 150000 ? "pressure_high" : facts.totalHp >= 60000 ? "pressure_medium" : "pressure_low",
    facts.rows * facts.cols >= 100 ? "map_large" : facts.rows * facts.cols >= 60 ? "map_medium" : "map_small",
  ].filter(name => corpusModel.contexts[name]);
}

export function corpusContextStats(facts: StageFacts): CopilotPriorStats[] {
  return contextNames(facts).map(name => corpusModel.contexts[name]);
}

export function copilotPriorStats(stageName: string | undefined, facts: StageFacts): CopilotPriorStats[] {
  const stageNames = [...new Set([stageName, facts.stageId].filter((name): name is string => Boolean(name)))];
  const stageStats = stageNames
    .map(name => copilotPrior.stages?.[name])
    .filter((stat): stat is CopilotPriorStats => Boolean(stat));
  const contextStats = contextNames(facts)
    .map(name => copilotPrior.contexts?.[name])
    .filter((stat): stat is CopilotPriorStats => Boolean(stat));
  return [...stageStats, ...contextStats];
}

export function countScore(counts: Record<string, number> | undefined, key: string): number | null {
  if (!counts || Object.keys(counts).length === 0) return null;
  const maximum = Math.max(1, ...Object.values(counts));
  return ((counts[key] || 0) / maximum) * 100;
}

function averageScore(values: Array<number | null>): number | null {
  const scores = values.filter((score): score is number => score !== null);
  return scores.length ? average(scores) : null;
}

function deployActions(script: BattleScript): BattleScriptAction[] {
  return script.actions.filter(action => action.type === "Deploy" && action.location);
}

export function positionPriorScore(
  stats: CopilotPriorStats[],
  row: number,
  col: number,
  deployIndex?: number
): number | null {
  const tile = `${row},${col}`;
  const heat = averageScore(stats.map(stat => countScore(stat.deployHeatmap, tile)));
  const first = deployIndex !== undefined && deployIndex < 3
    ? averageScore(stats.map(stat => countScore(stat.firstDeploys, `${deployIndex + 1}:${tile}`)))
    : null;
  if (heat === null) return first;
  if (first === null) return heat;
  return heat * 0.7 + first * 0.3;
}

export function directionPriorScore(
  stats: CopilotPriorStats[],
  direction: string | undefined,
  row?: number,
  col?: number
): number | null {
  if (!direction) return null;
  const local = row === undefined || col === undefined
    ? null
    : averageScore(stats.map(stat => countScore(stat.directionHeatmap, `${row},${col}:${direction}`)));
  const global = averageScore(stats.map(stat => countScore(stat.directionRates, direction)));
  if (local === null) return global;
  if (global === null) return local;
  return local * 0.7 + global * 0.3;
}

function timingBucket(value: unknown): string {
  const ms = Math.max(0, Number(value) || 0);
  return String(Math.round(ms / 250) * 250);
}

export function timingPriorScore(stats: CopilotPriorStats[], delayMs: unknown): number | null {
  return averageScore(stats.map(stat => countScore(stat.deployTiming, timingBucket(delayMs))));
}

export function timingVariantOrderFromStats(stats: CopilotPriorStats[], fallback = [0, 1, 2, 3]): number[] {
  const counts = new Map<number, number>();
  for (const stat of stats) {
    for (const [bucket, count] of Object.entries(stat.deployTiming || {})) {
      const variant = Math.round(Math.max(0, Number(bucket) || 0) / 250);
      counts.set(variant, (counts.get(variant) || 0) + count);
    }
  }
  const preferred = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .map(([variant]) => variant);
  return [...new Set([...preferred, ...fallback])].slice(0, fallback.length);
}

export function timingVariantOrder(stageName: string, facts: StageFacts, fallback = [0, 1, 2, 3]): number[] {
  return timingVariantOrderFromStats(copilotPriorStats(stageName, facts), fallback);
}

export function operatorPriorScore(stats: CopilotPriorStats[], picks: EnginePick[]): number | null {
  const scores = picks.flatMap(pick => stats.flatMap(stat => [
    countScore(stat.operatorUsage, pick.name),
    countScore(stat.skillUsage, `${pick.name}#${pick.skill}`),
  ].filter((score): score is number => score !== null)));
  return scores.length ? average(scores) : null;
}

function closeness(actual: number, expected: number): number {
  return Math.max(0, 1 - Math.abs(actual - expected) / Math.max(1, expected));
}

export function actionShapePriorScore(script: BattleScript, stats: CopilotPriorStats[]): number | null {
  if (!stats.length) return null;
  const deployCount = deployActions(script).length;
  const expectedActions = average(stats.map(stat => stat.averages.actions));
  const expectedDeploys = average(stats.map(stat => stat.averages.deploys));
  const countFit = average([closeness(script.actions.length, expectedActions), closeness(deployCount, expectedDeploys)]);

  const grammar = average([
    1 - Math.abs(Number(script.actions.some(action => action.type === "SpeedUp")) - average(stats.map(stat => stat.rates.speedUp))),
    1 - Math.abs(Number(script.actions.some(action => action.type === "SkillDaemon")) - average(stats.map(stat => stat.rates.skillDaemon))),
  ]);

  const actualTypes = script.actions.reduce<Record<string, number>>((counts, action) => {
    counts[action.type] = (counts[action.type] || 0) + 1;
    return counts;
  }, {});
  const typeNames = [...new Set(["Deploy", "Skill", "Retreat", "SpeedUp", "SkillDaemon", ...Object.keys(actualTypes)])];
  const typeFit = average(typeNames.map(type => closeness(
    actualTypes[type] || 0,
    average(stats.map(stat => stat.actionTypesPerScript?.[type] || 0))
  )));
  const firstAction = script.actions[0]?.type;
  const firstFit = firstAction ? averageScore(stats.map(stat => countScore(stat.firstActionRates, firstAction))) : null;

  return clamp((countFit * 0.45 + grammar * 0.25 + typeFit * 0.2 + (firstFit ?? 50) / 100 * 0.1) * 100);
}

export function scriptPositionPriorScore(script: BattleScript, stats: CopilotPriorStats[]): number | null {
  const scores = deployActions(script)
    .map((action, index) => positionPriorScore(stats, action.location![0], action.location![1], index))
    .filter((score): score is number => score !== null);
  return scores.length ? average(scores) : null;
}

export function scriptDirectionPriorScore(script: BattleScript, stats: CopilotPriorStats[]): number | null {
  const scores = deployActions(script)
    .map(action => directionPriorScore(stats, action.direction, action.location![0], action.location![1]))
    .filter((score): score is number => score !== null);
  return scores.length ? average(scores) : null;
}

export function scriptTimingPriorScore(script: BattleScript, stats: CopilotPriorStats[]): number | null {
  const scores = deployActions(script)
    .map(action => timingPriorScore(stats, action.pre_delay ?? action.time_elapsed ?? action.time ?? 0))
    .filter((score): score is number => score !== null);
  return scores.length ? average(scores) : null;
}

export function publicPriorScoreFromStats(
  script: BattleScript,
  picks: EnginePick[],
  publicStats: CopilotPriorStats[],
  fallbackStats: CopilotPriorStats[] = []
): number {
  const shape = actionShapePriorScore(script, publicStats) ?? actionShapePriorScore(script, fallbackStats) ?? 50;
  return clamp(
    (scriptPositionPriorScore(script, publicStats) ?? 50) * 0.35
      + (scriptDirectionPriorScore(script, publicStats) ?? 50) * 0.20
      + (scriptTimingPriorScore(script, publicStats) ?? 50) * 0.20
      + (operatorPriorScore(publicStats, picks) ?? 50) * 0.15
      + shape * 0.10
  );
}
