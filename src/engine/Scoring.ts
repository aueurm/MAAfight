import corpusJson from "../data/corpusPrior.v1.json";
import copilotPriorJson from "../data/copilotPrior.v1.json";
import type { BattleScript, BattleScriptAction } from "../types";
import { getCombatModelInfo } from "./CombatModel";
import { clamp, rotateDirection } from "./helpers";
import type { EncounterContext, EnginePick, ScoreBreakdown, StageFacts } from "./types";

interface CorpusStats {
  averages: { actions: number; deploys: number; skills: number; fixedOpers: number };
  rates: { speedUp: number; skillDaemon: number };
  position: { averageRouteDistance: number; averageBlueBoxDistance: number; averageChokepointDistance: number };
}

const corpusModel = corpusJson as unknown as {
  modelVersion: string;
  contexts: Record<string, CorpusStats>;
};
const copilotPrior = copilotPriorJson as unknown as {
  modelVersion?: string;
  contexts?: Record<string, CorpusStats>;
  stages?: Record<string, CorpusStats>;
};
const routeKeyCache = new WeakMap<StageFacts, Set<string>>();

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function nearest(point: { row: number; col: number }, targets: Array<{ row: number; col: number }>): number {
  return targets.length
    ? Math.min(...targets.map(target => Math.abs(point.row - target.row) + Math.abs(point.col - target.col)))
    : 0;
}

function contexts(facts: StageFacts): string[] {
  return [
    "global",
    facts.bossCount > 0 ? "boss" : "no_boss",
    facts.flyingRouteCount > 0 ? "flying" : "ground_only",
    facts.laneCount > 1 ? "multi_lane" : "single_lane",
    facts.totalHp >= 150000 ? "pressure_high" : facts.totalHp >= 60000 ? "pressure_medium" : "pressure_low",
    facts.rows * facts.cols >= 100 ? "map_large" : facts.rows * facts.cols >= 60 ? "map_medium" : "map_small",
  ].filter(name => corpusModel.contexts[name]);
}

function rangeCoverage(action: BattleScriptAction, pick: EnginePick, facts: StageFacts): number {
  if (!action.location || facts.routeCells.length === 0) return 0;
  let routeKeys = routeKeyCache.get(facts);
  if (!routeKeys) {
    routeKeys = new Set(facts.routeCells.map(cell => `${cell.row},${cell.col}`));
    routeKeyCache.set(facts, routeKeys);
  }
  const covered = new Set<string>();
  for (const offset of pick.profile.range) {
    const [row, col] = rotateDirection(offset, action.direction || "Right");
    const key = `${action.location[0] + row},${action.location[1] + col}`;
    if (routeKeys.has(key)) covered.add(key);
  }
  return covered.size / facts.routeCells.length;
}

function stageDps(pick: EnginePick, defense: number, resistance: number, modeledDps: number): number {
  const profile = pick.profile;
  const confidenceFactor = profile.confidence === "exact" ? 1 : profile.confidence === "partial" ? 0.9 : 0.75;
  if (profile.damageType === "heal") return 0;
  if (profile.damageType === "arts") return modeledDps * Math.max(0.05, 1 - resistance / 100) * confidenceFactor;
  const interval = Math.max(0.1, profile.attributes.attackInterval * 100 / Math.max(1, profile.attributes.attackSpeed));
  const normalAtDefense = Math.max(profile.attributes.atk * 0.05, profile.attributes.atk - defense) / interval;
  return normalAtDefense * modeledDps / Math.max(1, profile.metrics.normalDps) * confidenceFactor;
}

function deployedPairs(script: BattleScript, picks: EnginePick[]): Array<{ action: BattleScriptAction; pick: EnginePick }> {
  const byName = new Map(picks.map(pick => [pick.name, pick]));
  return script.actions
    .filter(action => action.type === "Deploy" && action.name && !(action.cooling && action.cooling > 0))
    .map(action => ({ action, pick: byName.get(action.name!) }))
    .filter((pair): pair is { action: BattleScriptAction; pick: EnginePick } => Boolean(pair.pick));
}

function engagementScore(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext
): number {
  const deployed = deployedPairs(script, picks).map(pair => ({
    ...pair,
    coverage: rangeCoverage(pair.action, pair.pick, facts),
  }));
  if (deployed.length === 0 || encounter.windows.length === 0) return 0;
  const healing = deployed.reduce((sum, { pick }) => sum + pick.profile.metrics.healingHps, 0);
  const durability = deployed.reduce((sum, { pick }) => sum
    + (pick.profile.metrics.physicalEhp + pick.profile.metrics.artsEhp) / 2
      * Math.max(1, pick.profile.attributes.block), 0);
  const windowScores = encounter.windows.map(window => {
    let availableDamage = 0;
    for (const group of window.groups) {
      const groupDamage = deployed.reduce((sum, { pick, coverage }) => {
        if (group.motionMode === "fly" && pick.profile.position === "MELEE") return sum;
        const cycle = pick.profile.metrics.cycleDps ?? pick.profile.metrics.normalDps;
        const burstWeight = group.boss || group.elite ? 0.6 : encounter.demand.burst * 0.35;
        const modeled = cycle * (1 - burstWeight) + pick.profile.metrics.burstDps * burstWeight;
        const targets = Math.min(group.count, pick.profile.maxTargets);
        return sum + stageDps(pick, group.def, group.res, modeled) * targets * (0.25 + coverage * 0.75);
      }, 0);
      availableDamage += groupDamage;
    }
    const requiredDps = window.totalHp / 15;
    const damageFit = Math.min(1, availableDamage / Math.max(1, requiredDps));
    const incoming = window.totalAttack * 0.2;
    const survivalFit = Math.min(1, (durability + healing * 15) / Math.max(1, incoming * 15));
    const control = deployed.reduce((sum, { pick }) => sum + pick.profile.metrics.controlSeconds, 0);
    const controlFit = Math.min(1, control / Math.max(1, window.groups.length * 2));
    return (damageFit * 0.62 + survivalFit * 0.30 + controlFit * 0.08) * 100;
  });
  return clamp(average(windowScores));
}

function cheapCombatScore(picks: EnginePick[], encounter: EncounterContext): number {
  const damage = picks.reduce((sum, pick) => sum + stageDps(
    pick,
    encounter.averageDefense,
    encounter.averageResistance,
    pick.profile.metrics.cycleDps ?? pick.profile.metrics.normalDps
  ), 0);
  const peak = Math.max(1, ...encounter.windows.map(window => window.totalHp / 15));
  const healing = picks.reduce((sum, pick) => sum + pick.profile.metrics.healingHps, 0);
  return clamp(Math.min(1, damage / peak) * 75 + Math.min(1, healing / 1200) * 25);
}

function positionScore(script: BattleScript, picks: EnginePick[], facts: StageFacts): number {
  const deployed = deployedPairs(script, picks);
  if (!deployed.length) return 0;
  const coverage = average(deployed.map(({ action, pick }) => rangeCoverage(action, pick, facts)));
  const routeFit = average(deployed.map(({ action }) => Math.max(0, 1 - nearest(
    { row: action.location![0], col: action.location![1] }, facts.routeCells
  ) / 4)));
  const unique = new Set(deployed.map(({ action }) => `${action.location![0]},${action.location![1]}`)).size / deployed.length;
  return clamp((coverage * 0.45 + routeFit * 0.35 + unique * 0.20) * 100);
}

function timingScore(script: BattleScript, facts: StageFacts): number {
  let available = facts.initialCost;
  let wait = 0;
  for (const action of script.actions.filter(action => action.type === "Deploy" && !(action.cooling && action.cooling > 0))) {
    const cost = action.costs || 0;
    if (cost > available) wait += cost - available;
    available = Math.max(0, available - cost) + 10;
    wait += (action.pre_delay || 0) / 1000;
  }
  return clamp(100 - wait * 2.5);
}

function corpusScore(script: BattleScript, facts: StageFacts): number {
  const stats = contexts(facts).map(name => corpusModel.contexts[name]);
  const baseScore = scoreShape(script, stats);
  const publicStats = [
    copilotPrior.stages?.[facts.stageId],
    ...contexts(facts).map(name => copilotPrior.contexts?.[name]),
  ].filter((stat): stat is CorpusStats => Boolean(stat));
  const publicScore = scoreShape(script, publicStats);
  if (publicScore === null) return baseScore ?? 50;
  if (baseScore === null) return publicScore;
  return clamp(baseScore * 0.98 + publicScore * 0.02);
}

function scoreShape(script: BattleScript, stats: CorpusStats[]): number | null {
  if (!stats.length) return null;
  const deployCount = script.actions.filter(action => action.type === "Deploy").length;
  const expectedActions = average(stats.map(stat => stat.averages.actions));
  const expectedDeploys = average(stats.map(stat => stat.averages.deploys));
  const closeness = (actual: number, expected: number) => Math.max(0, 1 - Math.abs(actual - expected) / Math.max(1, expected));
  const shape = average([closeness(script.actions.length, expectedActions), closeness(deployCount, expectedDeploys)]);
  const grammar = average([
    1 - Math.abs(Number(script.actions.some(action => action.type === "SpeedUp")) - average(stats.map(stat => stat.rates.speedUp))),
    1 - Math.abs(Number(script.actions.some(action => action.type === "SkillDaemon")) - average(stats.map(stat => stat.rates.skillDaemon))),
  ]);
  return clamp((shape * 0.65 + grammar * 0.35) * 100);
}

function taskScore(picks: EnginePick[], encounter: EncounterContext): number {
  const physical = picks.reduce((sum, pick) => sum + (pick.profile.damageType === "physical" ? 1 : 0), 0);
  const arts = picks.reduce((sum, pick) => sum + (pick.profile.damageType === "arts" ? 1 : 0), 0);
  const healing = picks.reduce((sum, pick) => sum + pick.profile.metrics.healingHps, 0);
  const blocking = picks.reduce((sum, pick) => sum + (pick.profile.position === "MELEE" ? pick.profile.attributes.block : 0), 0);
  const antiAir = picks.reduce((sum, pick) => sum + Number(pick.profile.position === "RANGED" && pick.profile.range.length >= 3), 0);
  const coverage = picks.reduce((sum, pick) => sum + pick.profile.range.length + pick.profile.maxTargets, 0);
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
    Math.min(1, coverage / Math.max(8, encounter.demand.coverage * 60)),
    Math.min(1, singleTarget / Math.max(500, encounter.demand.singleTarget * 5000)),
    Math.min(1, area / Math.max(500, encounter.demand.area * 7000)
      + Number([...subclasses].some(value => value && ["aoesniper", "bombarder", "splashcaster", "chain", "reaper", "centurion"].includes(value))) * 0.25),
    Math.min(1, laneHold / Math.max(2, encounter.demand.laneHold * 12)),
    Math.min(1, support / Math.max(300, encounter.demand.support * 3000)
      + Number([...subclasses].some(value => value && ["slower", "underminer", "bard", "ritualist", "blessing", "alchemist"].includes(value))) * 0.25),
  ];
  return average(checks) * 100;
}

function automationScore(script: BattleScript): number {
  let score = 70;
  if (script.actions[0]?.type === "SpeedUp") score += 10;
  if (script.actions.at(-1)?.type === "SkillDaemon") score += 15;
  if (!script.actions.some(action => action.type === "Wait" || action.type === "SkillUse")) score += 5;
  return clamp(score);
}

function breakdown(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext,
  full: boolean
): ScoreBreakdown {
  return {
    combat: full ? engagementScore(script, picks, facts, encounter) : cheapCombatScore(picks, encounter),
    position: positionScore(script, picks, facts),
    timing: timingScore(script, facts),
    corpus: corpusScore(script, facts),
    tasks: taskScore(picks, encounter),
    automation: automationScore(script),
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

export function weightedScore(value: ScoreBreakdown): number {
  return clamp(
    value.combat * 0.30 + value.position * 0.20 + value.timing * 0.15
      + value.corpus * 0.15 + value.tasks * 0.10 + value.automation * 0.10
  );
}

export function getModelVersions(): { corpus: string; combat: string; gameDataCommit: string } {
  const combat = getCombatModelInfo();
  const publicVersion = copilotPrior.modelVersion ? `+${copilotPrior.modelVersion}` : "";
  return { corpus: `${corpusModel.modelVersion}${publicVersion}`, combat: combat.modelVersion, gameDataCommit: combat.commit };
}
