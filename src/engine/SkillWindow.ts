import type { ResolvedOperatorProfile } from "./types";

export interface SkillWindowOptions {
  deployedAt: number;
  windowStart: number;
  windowEnd: number;
  activeUntil?: number;
  skillUsage?: number;
  /** Exclusive cutoff for new MAA-controlled MANUAL activations, in game seconds. */
  autoActivationUntil?: number;
  /** Known planned activation times in game seconds; does not infer MAA waits for readiness. */
  activationTimes?: number[];
}

export interface SkillWindowEstimate {
  normalSeconds: number;
  skillSeconds: number;
  normalDamage: number;
  skillDamage: number;
  totalDamage: number;
  averageDps: number;
  firstReadyAt: number | null;
  rechargeSeconds: number | null;
  coverageGaps: string[];
}

/** Finite-window, single-target damage estimate before defense/resistance; not a battle simulator. */
export function estimateSkillWindow(profile: ResolvedOperatorProfile, options: SkillWindowOptions): SkillWindowEstimate {
  const start = Math.max(options.windowStart, options.deployedAt);
  const end = Math.min(options.windowEnd, options.activeUntil ?? Infinity);
  const seconds = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  const gaps = new Set<string>();
  const rawDuration = profile.rawDuration ?? profile.skillDuration;
  const ammo = profile.durationType === "AMMO" || profile.durationSemantics === "ammo";
  const indefinite = profile.durationSemantics === "indefinite" && !ammo;
  const passive = profile.skillType === "PASSIVE";
  const timeRecovery = profile.spType === "INCREASE_WITH_TIME";
  const increment = profile.spIncrement ?? 1;
  const knownSp = Number.isFinite(profile.spCost) && Number.isFinite(profile.initSp)
    && Number.isFinite(increment) && increment > 0;
  const rechargeSeconds = timeRecovery && knownSp ? Math.max(0, profile.spCost!) / increment : null;
  const firstReadyAt = passive ? options.deployedAt : rechargeSeconds !== null
    ? options.deployedAt + Math.max(0, profile.spCost! - profile.initSp!) / increment : null;
  let skillSeconds = 0;
  const duration = indefinite ? Infinity : Math.max(0, rawDuration);
  const overlap = (from: number, to: number): number => Math.max(0, Math.min(end, to) - Math.max(start, from));
  if (ammo) gaps.add("ammo_skill_duration_unknown");
  else if (!duration) gaps.add(passive ? "passive_duration_semantics_unknown" : "skill_duration_semantics_unknown");
  if (!["PASSIVE", "AUTO", "MANUAL"].includes(profile.skillType || "")) gaps.add("skill_type_unknown");
  if (!passive && firstReadyAt === null) gaps.add("skill_sp_timing_unknown");
  const autoActivationUntil = profile.skillType === "MANUAL" ? options.autoActivationUntil ?? Infinity : Infinity;
  if (profile.skillType === "MANUAL" && (options.skillUsage ?? 1) > 0 && options.activationTimes === undefined
    && Number.isFinite(autoActivationUntil)) gaps.add("auto_activation_ends_with_script");

  if (seconds && !ammo && duration > 0 && firstReadyAt !== null) {
    const automatic = profile.skillType === "AUTO" || (profile.skillType === "MANUAL" && (options.skillUsage ?? 1) > 0);
    if (passive) skillSeconds = overlap(options.deployedAt, options.deployedAt + duration);
    else if (profile.skillType === "MANUAL" && options.activationTimes !== undefined) {
      let readyAt = firstReadyAt;
      for (const requested of [...options.activationTimes].filter(Number.isFinite).sort((a, b) => a - b)) {
        if (requested < options.deployedAt) continue;
        if (requested < readyAt) {
          // MAA may wait/retry here, which also delays later actions; this estimator cannot invent their times.
          gaps.add("manual_skill_activation_unready");
          break;
        }
        const activation = requested;
        skillSeconds += overlap(activation, activation + duration);
        readyAt = activation + duration + rechargeSeconds!;
        if (indefinite) break;
      }
    } else if (automatic && firstReadyAt < autoActivationUntil) {
      if (indefinite || (profile.skillType === "MANUAL" && options.skillUsage === 2)) {
        skillSeconds = overlap(firstReadyAt, firstReadyAt + duration);
      } else {
        const period = duration + rechargeSeconds!;
        const lastActiveEnd = Number.isFinite(autoActivationUntil)
          ? firstReadyAt + (Math.ceil((autoActivationUntil - firstReadyAt) / period) - 1) * period + duration
          : Infinity;
        const cumulative = (time: number): number => {
          // Closing the helper prevents a later activation but never cancels an already active skill.
          const age = Math.max(0, Math.min(time, lastActiveEnd) - firstReadyAt);
          return Math.floor(age / period) * duration + Math.min(duration, age % period);
        };
        skillSeconds = cumulative(end) - cumulative(start);
      }
    }
  }
  skillSeconds = Math.min(seconds, Math.max(0, skillSeconds));
  const normalSeconds = seconds - skillSeconds;
  const doesDamage = profile.damageType !== "heal" && profile.subProfession !== "bard";
  // The nominal attack rate is retained for defense normalization, not credited during a forbidden attack state.
  const normalDps = doesDamage && profile.subProfession !== "liberator" && !profile.normalAttackSuppressed
    ? Math.max(0, profile.metrics.normalDps) : 0;
  // Standard-bearers stop attacking during skills; activation-only damage is not sustained DPS.
  const burstDps = doesDamage && profile.subProfession !== "bearer" ? Math.max(0, profile.metrics.burstDps) : 0;
  const normalDamage = normalSeconds * normalDps;
  const skillDamage = skillSeconds * burstDps;
  return { normalSeconds, skillSeconds, normalDamage, skillDamage, totalDamage: normalDamage + skillDamage,
    averageDps: (normalDamage + skillDamage) / Math.max(1e-9, options.windowEnd - options.windowStart),
    firstReadyAt, rechargeSeconds, coverageGaps: [...gaps].sort() };
}
