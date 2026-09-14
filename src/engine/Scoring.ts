import corpusJson from "../data/corpusPrior.v1.json";
import copilotPriorJson from "../data/copilotPrior.v1.json";
import type { BattleScript, BattleScriptAction, MapData } from "../types";
import { getCombatModelInfo } from "./CombatModel";
import { clamp } from "./helpers";
import { canTargetAir, coversTemporalCell, temporalRangeCells, temporalThreatWeight } from "./TemporalCoverage";
import { planDeploymentTimeline } from "./TimelinePlanner";
import { estimateSkillWindow, type SkillWindowOptions } from "./SkillWindow";
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

function rangeCoverage(action: BattleScriptAction, pick: EnginePick, encounter: EncounterContext, time: number, endTime: number, skillOptions: Partial<SkillWindowOptions>): number {
  if (!action.location) return 0;
  const basePick = { ...pick, profile: { ...pick.profile, range: pick.profile.baseRange || pick.profile.range } };
  const location = { row: action.location[0], col: action.location[1] };
  const baseCells = temporalRangeCells(basePick, location, action.direction || "Right");
  const skillCells = temporalRangeCells(pick, location, action.direction || "Right");
  let score = 0;
  for (const bucket of encounter.temporalPressure.buckets) {
    const bucketEnd = bucket.time + encounter.temporalPressure.bucketSeconds;
    if (bucketEnd <= time || bucket.time >= endTime) continue;
    const estimate = estimateSkillWindow(pick.profile, { ...skillOptions, deployedAt: time, activeUntil: endTime,
      windowStart: bucket.time, windowEnd: bucketEnd });
    for (const cell of bucket.cells) {
      const key = `${cell.row},${cell.col}`;
      score += temporalThreatWeight(pick, cell) * (
        (baseCells.has(key) ? estimate.normalSeconds : 0) + (skillCells.has(key) ? estimate.skillSeconds : 0));
    }
  }
  return score / (score + 50);
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

function deployedPairs(script: BattleScript, picks: EnginePick[], mapData: MapData): Array<{
  action: BattleScriptAction; pick: EnginePick; time: number; endTime: number;
  skillOptions: Partial<SkillWindowOptions>;
}> {
  const byName = new Map(picks.map(pick => [pick.name, pick]));
  const plannedTimeline = planDeploymentTimeline(script, mapData.options);
  const autoActivationUntil = script.actions.some(action => action.type === "SkillDaemon") ? undefined : plannedTimeline.time;
  const timeline = new Map(plannedTimeline.deployments
    .filter(deployment => deployment.affordable)
    .map(deployment => [deployment.actionIndex, deployment]));
  return script.actions.flatMap((action, actionIndex) => {
    const pick = action.type === "Deploy" && action.name && !action.cooling ? byName.get(action.name) : undefined;
    const deployment = timeline.get(actionIndex);
    if (!pick || !deployment || !action.location) return [];
    const manualActions = script.actions.flatMap((entry, index) => entry.type === "Skill" && entry.name === pick.name
      ? [plannedTimeline.actionTimes[index]] : []);
    const skillOptions: Partial<SkillWindowOptions> = {
      skillUsage: script.opers?.find(operator => operator.name === pick.name)?.skill_usage ?? 0,
      autoActivationUntil,
      ...(manualActions.length ? { activationTimes: manualActions.filter(Number.isFinite) } : {}),
    };
    return [{ action, pick, time: deployment.time, endTime: deployment.endTime, skillOptions }];
  });
}

function engagementScore(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext,
  mapData: MapData,
): number {
  const deployed = deployedPairs(script, picks, mapData);
  if (deployed.length === 0 || encounter.windows.length === 0) return 0;
  const windowScores = facts.criticalWindows.map(window => {
    const buckets = facts.temporalPressure.buckets.filter(bucket => bucket.time >= window.start && bucket.time < window.end);
    let groundDamage = 0;
    let airDamage = 0;
    let healing = 0;
    let durability = 0;
    let control = 0;
    for (const bucket of buckets) {
      const available = deployed.filter(deployment => deployment.time < bucket.time + facts.temporalPressure.bucketSeconds
        && bucket.time < deployment.endTime);
      durability += available.reduce((sum, { pick }) => sum
        + (pick.profile.metrics.physicalEhp + pick.profile.metrics.artsEhp) / 2
          * Math.max(1, pick.profile.attributes.block), 0) / Math.max(1, buckets.length);
      control += available.reduce((sum, { pick }) => sum + pick.profile.metrics.controlSeconds, 0) / Math.max(1, buckets.length);
      for (const deployment of available) {
        const estimate = estimateSkillWindow(deployment.pick.profile, { ...deployment.skillOptions, deployedAt: deployment.time,
          activeUntil: deployment.endTime, windowStart: bucket.time, windowEnd: Math.min(window.end, bucket.time + facts.temporalPressure.bucketSeconds) });
        const metrics = deployment.pick.profile.metrics;
        const legacyHealing = metrics.normalHps === undefined && metrics.skillHps === undefined;
        const healingAmount = legacyHealing ? (estimate.normalSeconds + estimate.skillSeconds) * metrics.healingHps
          : estimate.normalSeconds * (metrics.normalHps ?? 0) + estimate.skillSeconds * (metrics.skillHps ?? 0);
        const bucketSeconds = Math.max(1e-9, Math.min(window.end, bucket.time + facts.temporalPressure.bucketSeconds) - bucket.time);
        healing += healingAmount / bucketSeconds / Math.max(1, buckets.length);
        const basePick = { ...deployment.pick, profile: { ...deployment.pick.profile, range: deployment.pick.profile.baseRange || deployment.pick.profile.range } };
        for (const [pick, modeledDamage] of [[basePick, estimate.normalDamage], [deployment.pick, estimate.skillDamage]] as const) {
          const covered = bucket.cells.filter(cell => coversTemporalCell(pick,
            { row: deployment.action.location![0], col: deployment.action.location![1] }, deployment.action.direction || "Right", cell));
          const groundHp = covered.reduce((sum, cell) => sum + cell.groundHp, 0);
          const airHp = canTargetAir(pick) ? covered.reduce((sum, cell) => sum + cell.airHp, 0) : 0;
          const totalHp = groundHp + airHp;
          if (!totalHp) continue;
          const damage = stageDps(pick, encounter.averageDefense, encounter.averageResistance, modeledDamage);
          // The finite single-target budget cannot simultaneously deal its full damage to ground and air.
          groundDamage += damage * groundHp / totalHp;
          airDamage += damage * airHp / totalHp;
        }
      }
    }
    const groundFit = window.groundHp ? Math.min(1, groundDamage / window.groundHp) : 1;
    const airFit = window.airHp ? Math.min(1, airDamage / window.airHp) : 1;
    const damageFit = (groundFit * window.groundHp + airFit * window.airHp) / Math.max(1, window.groundHp + window.airHp);
    const incoming = window.incomingAttack * 0.2;
    const survivalFit = Math.min(1, (durability + healing * 15) / Math.max(1, incoming * 15));
    const controlFit = Math.min(1, control / Math.max(1, window.groundCount + window.airCount));
    return (damageFit * 0.62 + survivalFit * 0.30 + controlFit * 0.08) * 100;
  });
  return clamp(average(windowScores));
}

function positionScore(script: BattleScript, picks: EnginePick[], facts: StageFacts, encounter: EncounterContext, mapData: MapData): number {
  const deployed = deployedPairs(script, picks, mapData);
  if (!deployed.length) return 0;
  const coverage = average(deployed.map(({ action, pick, time, endTime, skillOptions }) => rangeCoverage(action, pick, encounter, time, endTime, skillOptions)));
  const routeFit = average(deployed.map(({ action }) => Math.max(0, 1 - nearest(
    { row: action.location![0], col: action.location![1] }, facts.routeCells
  ) / 4)));
  const unique = new Set(deployed.map(({ action }) => `${action.location![0]},${action.location![1]}`)).size / deployed.length;
  return clamp((coverage * 0.45 + routeFit * 0.35 + unique * 0.20) * 100);
}

function timingScore(script: BattleScript, mapData: MapData): number {
  const deployments = planDeploymentTimeline(script, mapData.options).deployments;
  const lastDeployment = deployments.length ? Math.max(...deployments.map(deployment => deployment.time)) : 0;
  return clamp(100 - lastDeployment * 2.5);
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
  if (script.actions.at(-1)?.type === "SkillDaemon" || script.actions.some(action => action.type === "Skill")) score += 15;
  if (!script.actions.some(action => action.type === "Wait" || action.type === "SkillUse")) score += 5;
  return clamp(score);
}

function breakdown(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext,
  mapData: MapData,
): ScoreBreakdown {
  return {
    combat: engagementScore(script, picks, facts, encounter, mapData),
    position: positionScore(script, picks, facts, encounter, mapData),
    timing: timingScore(script, mapData),
    corpus: corpusScore(script, facts),
    tasks: taskScore(picks, encounter),
    automation: automationScore(script),
  };
}

export function cheapScoreCandidate(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext,
  mapData: MapData,
): ScoreBreakdown {
  return breakdown(script, picks, facts, encounter, mapData);
}

export function scoreCandidate(
  script: BattleScript,
  picks: EnginePick[],
  facts: StageFacts,
  encounter: EncounterContext,
  mapData: MapData,
): { breakdown: ScoreBreakdown; coverage: number; skillCoverage: number; coverageGaps: string[] } {
  const pairs = deployedPairs(script, picks, mapData);
  const deployed = pairs.map(pair => pair.pick);
  const skillCoverage = deployed.length
    ? average(deployed.map(pick => pick.profile.confidence === "exact" ? 1 : pick.profile.confidence === "partial" ? 0.5 : 0.25))
    : 0;
  return {
    breakdown: breakdown(script, picks, facts, encounter, mapData),
    coverage: deployed.length ? 1 : 0,
    skillCoverage,
    coverageGaps: [...new Set(pairs.flatMap(({ pick, time, endTime, skillOptions }) => [...pick.profile.modelCoverageGaps,
      ...estimateSkillWindow(pick.profile, { ...skillOptions, deployedAt: time, activeUntil: endTime,
        windowStart: time, windowEnd: time + 15 }).coverageGaps]))].sort(),
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
