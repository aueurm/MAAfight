import type { MapData, PlayerOperator } from "../types";

const ROLE_COSTS: Record<string, number> = {
  vanguard: 10,
  guard: 18,
  tank: 18,
  sniper: 14,
  caster: 20,
  medic: 16,
  support: 14,
  specialist: 12,
};

export class DPTimeline {
  readonly initialDP: number;
  readonly dpPerSecond: number;
  readonly maxDP?: number;
  currentTime = 0;
  spentDP = 0;

  constructor(initialDP: number, dpPerSecond: number, maxDP?: number) {
    this.initialDP = Math.max(0, initialDP || 0);
    this.dpPerSecond = dpPerSecond > 0 ? dpPerSecond : 1;
    this.maxDP = maxDP;
  }

  static fromMapData(mapData: MapData): DPTimeline {
    const options = mapData.options;
    const dpPerSecond = options?.costIncreaseTime && options.costIncreaseTime > 0
      ? 1 / options.costIncreaseTime
      : 1;
    return new DPTimeline(options?.initialCost || 0, dpPerSecond, options?.maxCost);
  }

  getEstimatedDPAt(time: number): number {
    const safeTime = Math.max(0, time || 0);
    const raw = this.initialDP + safeTime * this.dpPerSecond - this.spentDP;
    return Math.max(0, this.maxDP !== undefined ? Math.min(this.maxDP, raw) : raw);
  }

  nextDeployableTime(cost: number, afterTime: number): number {
    const safeCost = Math.max(0, cost || 0);
    const safeTime = Math.max(0, afterTime || 0);
    const available = this.getEstimatedDPAt(safeTime);
    if (available >= safeCost) return safeTime;
    return safeTime + (safeCost - available) / this.dpPerSecond;
  }

  commitDeploy(cost: number, time: number): void {
    this.currentTime = Math.max(this.currentTime, time || 0);
    this.spentDP += Math.max(0, cost || 0);
  }
}

export function estimateDeployCost(
  role: string,
  operatorName: string,
  playerOperators?: Map<string, PlayerOperator>
): number {
  const playerOperator = playerOperators?.get(operatorName) as (PlayerOperator & { cost?: number }) | undefined;
  if (typeof playerOperator?.cost === "number" && playerOperator.cost > 0) {
    return playerOperator.cost;
  }

  return ROLE_COSTS[role] || 15;
}
