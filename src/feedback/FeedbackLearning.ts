import type { SearchBias } from "../engine/types";
import type { FeedbackRecord } from "./FeedbackStore";

export type { SearchBias } from "../engine/types";

function emptyBias(): SearchBias {
  return { openingCoverage: 0, antiAir: 0, bossBurst: 0, healing: 0, costSafety: 0, routeWeights: {} };
}

function addRouteWeight(weights: Record<number, number>, routeId: number | undefined, value: number): void {
  if (routeId === undefined) return;
  weights[routeId] = Math.min(2, (weights[routeId] || 0) + value);
}

export function deriveSearchBias(records: readonly FeedbackRecord[]): SearchBias {
  const bias = emptyBias();
  for (const record of records) {
    if (!record.usableForLearning || record.ratio >= 1) continue;
    const loss = Math.max(0.1, 1 - record.ratio);
    if (record.firstLeak) {
      const early = record.firstLeak.time <= 30 ? 2 : 0.5;
      bias.openingCoverage += early * loss;
      addRouteWeight(bias.routeWeights, record.firstLeak.routeId, early * loss);
    }
    if (record.failureTags?.includes("flying")) bias.antiAir += loss;
    if (record.failureTags?.some(tag => tag === "multiPhase" || tag === "revive" || tag === "summon")) bias.bossBurst += loss;
    if (record.failureTags?.includes("antiHeal") || record.operatorDeaths?.length) bias.healing += loss;
    if (record.deploymentFailures?.length) bias.costSafety += loss;
  }
  return {
    openingCoverage: Math.min(2, bias.openingCoverage),
    antiAir: Math.min(2, bias.antiAir),
    bossBurst: Math.min(2, bias.bossBurst),
    healing: Math.min(2, bias.healing),
    costSafety: Math.min(2, bias.costSafety),
    routeWeights: Object.fromEntries(Object.entries(bias.routeWeights).sort(([left], [right]) => Number(left) - Number(right))),
  };
}
