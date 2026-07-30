import type { BattleScript, MapOptions } from "../types";

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

export function planDeploymentTimeline(script: BattleScript, options: MapOptions): DeploymentTimeline {
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
