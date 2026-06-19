import corpusJson from "../data/corpusPrior.v1.json";
import combatJson from "../data/operatorCombat.v1.json";
import type { BattleScript } from "../types";
import { isMeleeRole } from "./CandidateBuilder";
import type { EnginePick, ScoreBreakdown, StageFacts } from "./types";

interface RoleStats {
  hp: number;
  atk: number;
  def: number;
  res: number;
  attackInterval: number;
  block: number;
  rangeRadius: number;
}

interface CorpusStats {
  averages: { actions: number; deploys: number; skills: number; fixedOpers: number };
  rates: { speedUp: number; skillDaemon: number };
  position: { averageRouteDistance: number; averageBlueBoxDistance: number; averageChokepointDistance: number };
}

interface OperatorPhase extends RoleStats {
  elite: number;
  minLevel?: number;
  maxLevel: number;
  min?: Pick<RoleStats, "hp" | "atk" | "def" | "res">;
}

interface OperatorRecord {
  phases: OperatorPhase[];
  coverageGaps?: string[];
}

const combatModel = combatJson as unknown as {
  modelVersion: string;
  source: { exactOperatorCount: number };
  roleBaselines: Record<string, RoleStats>;
  operators: Record<string, OperatorRecord>;
};
const corpusModel = corpusJson as unknown as {
  modelVersion: string;
  contexts: Record<string, CorpusStats>;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function nearest(point: { row: number; col: number }, targets: Array<{ row: number; col: number }>): number {
  if (!targets.length) return 0;
  return Math.min(...targets.map(target => Math.abs(point.row - target.row) + Math.abs(point.col - target.col)));
}

function contexts(facts: StageFacts): string[] {
  const names = [
    "global",
    facts.bossCount > 0 ? "boss" : "no_boss",
    facts.flyingRouteCount > 0 ? "flying" : "ground_only",
    facts.laneCount > 1 ? "multi_lane" : "single_lane",
    facts.totalHp >= 150000 ? "pressure_high" : facts.totalHp >= 60000 ? "pressure_medium" : "pressure_low",
    facts.rows * facts.cols >= 100 ? "map_large" : facts.rows * facts.cols >= 60 ? "map_medium" : "map_small",
  ];
  return names.filter(name => corpusModel.contexts[name]);
}

function statsForPick(pick: EnginePick): { stats?: RoleStats; exact: boolean } {
  const record = combatModel.operators[pick.name];
  const baseline = combatModel.roleBaselines[pick.role];
  if (!record?.phases?.length) return { stats: baseline, exact: false };
  const requestedElite = pick.player?.elite ?? Math.min(2, record.phases.at(-1)?.elite || 0);
  const phase = record.phases.find(candidate => candidate.elite === requestedElite) || record.phases.at(-1)!;
  const level = Math.max(phase.minLevel || 1, Math.min(pick.player?.level || phase.maxLevel, phase.maxLevel));
  const span = Math.max(1, phase.maxLevel - (phase.minLevel || 1));
  const ratio = (level - (phase.minLevel || 1)) / span;
  const interpolate = (key: "hp" | "atk" | "def" | "res") => {
    const maximum = phase[key];
    const minimum = phase.min?.[key];
    return minimum === undefined ? maximum : minimum + (maximum - minimum) * ratio;
  };
  return {
    exact: true,
    stats: {
      hp: interpolate("hp"),
      atk: interpolate("atk"),
      def: interpolate("def"),
      res: interpolate("res"),
      attackInterval: phase.attackInterval,
      block: phase.block,
      rangeRadius: baseline?.rangeRadius || 1,
    },
  };
}

function combatScore(picks: EnginePick[], facts: StageFacts): { score: number; coverage: number; gaps: string[] } {
  const deployed = picks.slice(0, Math.min(9, facts.characterLimit || 9));
  let dps = 0;
  let effectiveHp = 0;
  let healing = 0;
  let exact = 0;
  for (const pick of deployed) {
    const resolved = statsForPick(pick);
    const stats = resolved.stats;
    if (!stats) continue;
    if (resolved.exact) exact++;
    if (pick.role === "medic") {
      healing += stats.atk / Math.max(0.1, stats.attackInterval);
      continue;
    }
    const mitigation = pick.role === "caster"
      ? Math.max(0.05, 1 - facts.averageResistance / 100)
      : Math.max(0.05, (stats.atk - facts.averageDefense * 0.35) / Math.max(1, stats.atk));
    dps += stats.atk / Math.max(0.1, stats.attackInterval) * mitigation;
    if (isMeleeRole(pick.role)) effectiveHp += stats.hp * (1 + stats.def / 1000) * Math.max(1, stats.block);
  }
  const peak = [...facts.pressureWindows].sort((a, b) => b.totalHp - a.totalHp)[0];
  const requiredDps = (peak?.totalHp || facts.totalHp) / 15;
  const incoming = (peak?.totalAttack || facts.totalAttack) * 0.2;
  const damage = Math.min(1, dps / Math.max(1, requiredDps));
  const survival = Math.min(1, (effectiveHp + healing * 15) / Math.max(1, incoming * 15));
  const coverage = deployed.length ? exact / deployed.length : 0;
  return {
    score: clamp((damage * 0.6 + survival * 0.4) * 100),
    coverage,
    gaps: coverage < 1 ? ["exact operator combat data is incomplete; role baselines were used"] : [],
  };
}

function positionScore(script: BattleScript, facts: StageFacts): number {
  const deploys = script.actions.filter(action => action.type === "Deploy" && action.location);
  if (!deploys.length) return 0;
  const routeFit = average(deploys.map(action => Math.max(0, 1 - nearest({ row: action.location![0], col: action.location![1] }, facts.routeCells) / 4)));
  const unique = new Set(deploys.map(action => `${action.location![0]},${action.location![1]}`)).size / deploys.length;
  const laneCoverage = Math.min(1, deploys.length / Math.max(1, facts.laneCount * 2));
  return clamp((routeFit * 0.5 + unique * 0.25 + laneCoverage * 0.25) * 100);
}

function timingScore(script: BattleScript, facts: StageFacts): number {
  let available = facts.initialCost;
  let wait = 0;
  const deploys = script.actions.filter(action => action.type === "Deploy");
  for (const action of deploys) {
    const cost = action.costs || 0;
    if (cost > available) wait += cost - available;
    available = Math.max(0, available - cost) + 10;
    wait += (action.pre_delay || 0) / 1000;
  }
  return clamp(100 - wait * 2.5);
}

function corpusScore(script: BattleScript, facts: StageFacts): number {
  const stats = contexts(facts).map(name => corpusModel.contexts[name]);
  if (!stats.length) return 50;
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

function taskScore(picks: EnginePick[], facts: StageFacts): number {
  const roles = new Set(picks.map(pick => pick.role));
  const checks = [roles.has("vanguard"), roles.has("medic"), roles.has("sniper"), roles.has("caster")];
  if (facts.groundRouteCount > 0) checks.push(roles.has("tank") || roles.has("guard"));
  if (facts.flyingRouteCount > 0) checks.push(picks.filter(pick => pick.role === "sniper").length >= 2);
  if (facts.bossCount > 0) checks.push(picks.filter(pick => pick.role === "guard" || pick.role === "caster").length >= 2);
  return checks.filter(Boolean).length / checks.length * 100;
}

function automationScore(script: BattleScript): number {
  let score = 70;
  if (script.actions[0]?.type === "SpeedUp") score += 10;
  if (script.actions.at(-1)?.type === "SkillDaemon") score += 15;
  if (!script.actions.some(action => action.type === "Wait" || action.type === "SkillUse")) score += 5;
  return clamp(score);
}

export function scoreCandidate(script: BattleScript, picks: EnginePick[], facts: StageFacts): {
  breakdown: ScoreBreakdown;
  coverage: number;
  coverageGaps: string[];
} {
  const combat = combatScore(picks, facts);
  return {
    breakdown: {
      combat: combat.score,
      position: positionScore(script, facts),
      timing: timingScore(script, facts),
      corpus: corpusScore(script, facts),
      tasks: taskScore(picks, facts),
      automation: automationScore(script),
    },
    coverage: combat.coverage,
    coverageGaps: combat.gaps,
  };
}

export function weightedScore(breakdown: ScoreBreakdown): number {
  return clamp(
    breakdown.combat * 0.30 +
    breakdown.position * 0.20 +
    breakdown.timing * 0.15 +
    breakdown.corpus * 0.15 +
    breakdown.tasks * 0.10 +
    breakdown.automation * 0.10
  );
}

export function getModelVersions(): { corpus: string; combat: string } {
  return { corpus: corpusModel.modelVersion, combat: combatModel.modelVersion };
}
