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
  endTime: number;
  cost: number;
  affordable: boolean;
}

export interface DeploymentTimeline {
  deployments: PlannedDeployment[];
  actionTimes: number[];
  reasons: string[];
  time: number;
  wallTime: number;
  speedMultiplier: number;
  stopwatchWallTime?: number;
}

export function costTick(options: MapOptions): number {
  const raw = options.costIncreaseTime;
  // 保留游戏数据中的长周期；不能把关卡内几乎不回费的 999999 改成每秒一费。
  return Number.isFinite(raw) && raw > 0 ? raw : Number.POSITIVE_INFINITY;
}

export function costAt(time: number, options: MapOptions): number {
  const tick = costTick(options);
  return Math.min(options.maxCost, options.initialCost + Math.floor(Math.max(0, time) / tick + 1e-9));
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

export function planDeploymentTimeline(script: Pick<BattleScript, "actions">, options: MapOptions,
  assumptions: { deploymentInteractionSeconds?: number } = {}): DeploymentTimeline {
  const tick = costTick(options);
  const deployments: PlannedDeployment[] = [];
  const actionTimes: number[] = [];
  const active: Array<{ deployment: PlannedDeployment; location?: [number, number] }> = [];
  const reasons = new Set<string>();
  let time = 0;
  let wallTime = 0;
  let speedMultiplier = 1;
  let stopwatchWallTime: number | undefined;
  let blocked = false;
  let available = Math.min(options.maxCost, Math.max(0, options.initialCost));
  let tickRemainder = 0;
  const advance = (wallSeconds: number): void => {
    const gameSeconds = Math.max(0, wallSeconds) * speedMultiplier;
    const total = tickRemainder + gameSeconds;
    const gained = Number.isFinite(tick) ? Math.floor(total / tick + 1e-9) : 0;
    tickRemainder = Number.isFinite(tick) ? Math.max(0, total - gained * tick) : 0;
    available = Math.min(options.maxCost, available + gained);
    time += gameSeconds;
    wallTime += Math.max(0, wallSeconds);
  };
  const waitForCost = (target: number): void => {
    if (blocked || available >= target) return;
    if (target > options.maxCost || !Number.isFinite(tick)) {
      reasons.add("cost_timeline_unaffordable");
      blocked = true;
      return;
    }
    advance(Math.max(0, (target - available) * tick - tickRemainder) / speedMultiplier);
  };

  for (const [actionIndex, action] of script.actions.entries()) {
    // 击杀/死亡冷却依赖实际战斗，不能把其后的动作当成立即执行。
    if ((action.kills || 0) > 0 || (action.cooling !== undefined && action.cooling >= 0) || (action.cost_changes || 0) < 0) {
      reasons.add("action_condition_timing_unknown");
      blocked = true;
    }
    if (!blocked) {
      waitForCost(available + Math.max(0, action.cost_changes || 0));
      waitForCost(Math.max(0, action.costs || 0));
      if ((action.elapsed_time || 0) > 0) {
        if (stopwatchWallTime === undefined) {
          reasons.add("stopwatch_not_started");
          blocked = true;
        }
        else advance(Math.max(0, stopwatchWallTime + action.elapsed_time! / 1000 - wallTime));
      }
    }
    // MAA 的 pre_delay 从原生条件满足后开始，pre/post/elapsed_time 均为真实毫秒。
    if (!blocked) advance((action.pre_delay || 0) / 1000);
    actionTimes.push(blocked ? Number.POSITIVE_INFINITY : time);
    if (action.type === "Deploy") {
      if (!blocked) advance(Math.max(0, assumptions.deploymentInteractionSeconds || 0));
      const cost = Math.max(0, action.costs || 0);
      const deployment = { actionIndex, name: action.name, time: blocked ? Number.POSITIVE_INFINITY : time,
        endTime: Number.POSITIVE_INFINITY, cost, affordable: !blocked && available >= cost };
      deployments.push(deployment);
      if (deployment.affordable) {
        available -= cost;
        active.push({ deployment, location: action.location });
      }
    }
    if (blocked) continue;
    if (action.type === "Retreat") {
      const index = active.findIndex(item => action.location
        ? item.location?.[0] === action.location[0] && item.location?.[1] === action.location[1]
        : item.deployment.name === action.name);
      if (index >= 0) active.splice(index, 1)[0].deployment.endTime = time;
    }
    if (action.type === "ResetStopwatch") stopwatchWallTime = wallTime;
    if (action.type === "SpeedUp") speedMultiplier = speedMultiplier === 1 ? 2 : 1;
    advance((action.post_delay || 0) / 1000);
  }
  return { deployments, actionTimes, reasons: [...reasons].sort(), time, wallTime, speedMultiplier, stopwatchWallTime };
}
