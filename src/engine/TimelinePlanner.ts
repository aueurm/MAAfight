import type { BattleScript, MapData, MapOptions } from "../types";
import type { StageFacts } from "./types";

export type TimelineEventType = "first_spawn" | "fire_zone" | "blue_box_threat" | "flying_wave"
  | "boss_arrival" | "cost_ready" | "coverage_loss";

export interface TimelineEvent {
  type: TimelineEventType;
  time: number;
  severity: number;
  cost?: number;
}

export interface PlannedDeployment {
  actionIndex: number;
  name?: string;
  time: number;
  cost: number;
  affordable: boolean;
}

export interface DeploymentTimeline {
  deployments: PlannedDeployment[];
  reasons: string[];
}

export function costAt(time: number, options: MapOptions): number {
  const tick = Math.max(0.01, options.costIncreaseTime || 1);
  return Math.min(options.maxCost, options.initialCost + Math.floor(Math.max(0, time) / tick));
}

export function buildTimelineEvents(mapData: MapData, facts: StageFacts): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const spawnTimes = mapData.spawnTimeline.map(spawn => Math.max(0, spawn.time));
  const firstSpawn = spawnTimes.length ? Math.min(...spawnTimes) : 0;
  events.push({ type: "first_spawn", time: firstSpawn, severity: 1 });

  for (const window of facts.criticalWindows) {
    events.push({ type: "fire_zone", time: window.start, severity: window.severity });
    if (window.goalThreat > 0) events.push({ type: "blue_box_threat", time: window.start, severity: window.goalThreat });
    if (window.airHp > 0) events.push({ type: "flying_wave", time: window.start, severity: window.airHp });
    if (window.bossWeight > 0) events.push({ type: "boss_arrival", time: window.start, severity: window.bossWeight });
    events.push({ type: "cost_ready", time: window.start, severity: 1, cost: costAt(window.start, mapData.options) });
  }
  if (facts.coverageGaps.length) events.push({ type: "coverage_loss", time: firstSpawn, severity: facts.coverageGaps.length });
  return events.sort((left, right) => left.time - right.time || left.type.localeCompare(right.type));
}

export function planDeploymentTimeline(script: Pick<BattleScript, "actions">, options: MapOptions): DeploymentTimeline {
  const tick = Math.max(0.01, options.costIncreaseTime || 1);
  const deployments: PlannedDeployment[] = [];
  const reasons = new Set<string>();
  let time = 0;
  let available = Math.min(options.maxCost, Math.max(0, options.initialCost));
  let tickRemainder = 0;
  const advance = (seconds: number): void => {
    const total = tickRemainder + Math.max(0, seconds);
    const gained = Math.floor(total / tick);
    tickRemainder = total - gained * tick;
    available = Math.min(options.maxCost, available + gained);
    time += Math.max(0, seconds);
  };

  for (const [actionIndex, action] of script.actions.entries()) {
    advance((action.pre_delay || 0) / 1000);
    if (action.type !== "Deploy" || action.cooling) continue;
    const cost = Math.max(0, action.costs || 0);
    if (cost > options.maxCost) {
      reasons.add("cost_timeline_unaffordable");
      deployments.push({ actionIndex, name: action.name, time, cost, affordable: false });
      continue;
    }
    if (available < cost) advance(Math.max(0, (cost - available) * tick - tickRemainder));
    const affordable = available >= cost;
    if (!affordable) reasons.add("cost_timeline_unaffordable");
    else available -= cost;
    deployments.push({ actionIndex, name: action.name, time, cost, affordable });
  }
  return { deployments, reasons: [...reasons].sort() };
}
