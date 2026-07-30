import type { EnemyMechanic } from "../types";
import type { CapabilityDemand } from "./types";

export interface MechanicAdjustment {
  demand: Partial<CapabilityDemand>;
  blockMultiplier: number;
  healingMultiplier: number;
  denseMeleePenalty: number;
  coverageGaps: string[];
}

export function buildMechanicAdjustment(mechanics: readonly string[]): MechanicAdjustment {
  const adjustment: MechanicAdjustment = {
    demand: {}, blockMultiplier: 1, healingMultiplier: 1, denseMeleePenalty: 0, coverageGaps: [],
  };
  for (const mechanic of [...new Set(mechanics)].sort()) {
    if (mechanic === "flying") adjustment.demand.antiAir = (adjustment.demand.antiAir || 0) + 0.4;
    else if (mechanic === "unblockable") {
      adjustment.blockMultiplier *= 0.25;
      adjustment.demand.control = (adjustment.demand.control || 0) + 0.35;
      adjustment.demand.burst = (adjustment.demand.burst || 0) + 0.2;
    } else if (mechanic === "antiHeal") {
      adjustment.healingMultiplier *= 0.35;
      adjustment.demand.sustain = (adjustment.demand.sustain || 0) + 0.3;
    } else if (mechanic === "deathExplosion") adjustment.denseMeleePenalty += 0.35;
    else if (mechanic === "multiPhase" || mechanic === "revive") adjustment.demand.sustain = (adjustment.demand.sustain || 0) + 0.25;
    else if (mechanic === "summon" || mechanic === "split") adjustment.demand.area = (adjustment.demand.area || 0) + 0.25;
    else if (mechanic === "stealth") adjustment.demand.block = (adjustment.demand.block || 0) + 0.2;
    else if (!isKnownMechanic(mechanic)) adjustment.coverageGaps.push(`unknown_enemy_mechanic:${mechanic}`);
  }
  return adjustment;
}

function isKnownMechanic(value: string): value is EnemyMechanic {
  return new Set<EnemyMechanic>([
    "stealth", "unblockable", "flying", "invulnerable", "multiPhase", "revive", "split", "summon",
    "deathExplosion", "specialTargeting", "antiHeal", "elementalDamage", "taunt", "shiftImmune",
    "tileInteraction", "blockAmplified", "damageReflect",
  ]).has(value as EnemyMechanic);
}
