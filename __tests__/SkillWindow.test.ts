import { estimateSkillWindow } from "../src/engine/SkillWindow";
import type { ResolvedOperatorProfile } from "../src/engine/types";
import { getCombatOperatorByName, resolveOperatorProfile } from "../src/engine/CombatModel";

function profile(overrides: Partial<ResolvedOperatorProfile> = {}): ResolvedOperatorProfile {
  return { operatorId: "window-test", name: "window-test", role: "guard", subProfession: null,
    position: "MELEE", damageType: "physical", skill: 1, skillRank: 7, skillDuration: 5, rawDuration: 5,
    durationType: "NONE", skillType: "MANUAL", spType: "INCREASE_WITH_TIME", spCost: 10, initSp: 0,
    spIncrement: 1, respawnTime: 70, baseRangeId: null, skillRangeId: null, baseRange: [[0, 0]], range: [[0, 0], [0, 1]],
    attributes: { hp: 1000, atk: 100, def: 100, res: 0, cost: 10, block: 1, attackInterval: 1, attackSpeed: 100 },
    metrics: { normalDps: 100, burstDps: 1000, cycleDps: 400, healingHps: 0, physicalEhp: 1000, artsEhp: 1000, controlSeconds: 0 },
    maxTargets: 1, confidence: "exact", modelCoverageGaps: [], ...overrides };
}

const window = (start: number, end: number) => ({ deployedAt: 0, windowStart: start, windowEnd: end });

describe("finite skill-window damage", () => {
  it("gives a late burst no skill damage before startup, then integrates only its active seconds", () => {
    expect(estimateSkillWindow(profile(), window(0, 5))).toMatchObject({ normalDamage: 500, skillDamage: 0, firstReadyAt: 10 });
    expect(estimateSkillWindow(profile(), window(0, 20))).toMatchObject({ normalSeconds: 15, skillSeconds: 5, totalDamage: 6500 });
    expect(estimateSkillWindow(profile(), window(20, 30))).toMatchObject({ normalSeconds: 5, skillSeconds: 5, totalDamage: 5500 });
  });

  it("spends initial SP once and respects the natural recovery increment", () => {
    expect(estimateSkillWindow(profile({ initSp: 9 }), window(7, 12)).skillSeconds).toBe(0);
    expect(estimateSkillWindow(profile({ spIncrement: 2 }), window(0, 10)))
      .toMatchObject({ firstReadyAt: 5, rechargeSeconds: 5, skillSeconds: 5 });
  });

  it("honors explicit activation, auto-once and game-automatic skill semantics", () => {
    expect(estimateSkillWindow(profile(), { ...window(0, 30), skillUsage: 0 }).skillDamage).toBe(0);
    expect(estimateSkillWindow(profile(), { ...window(0, 30), skillUsage: 0, activationTimes: [28] }))
      .toMatchObject({ normalSeconds: 28, skillSeconds: 2, skillDamage: 2000 });
    expect(estimateSkillWindow(profile(), { ...window(0, 45), skillUsage: 2 }).skillSeconds).toBe(5);
    expect(estimateSkillWindow(profile({ skillType: "AUTO" }), { ...window(0, 45), skillUsage: 0 }).skillSeconds).toBe(15);
  });

  it("clips deployment/retreat boundaries and does not double-count premature repeated commands", () => {
    const result = estimateSkillWindow(profile(), { ...window(0, 40), deployedAt: 5, activeUntil: 18, activationTimes: [15, 16] });
    expect(result).toMatchObject({ normalSeconds: 10, skillSeconds: 3, totalDamage: 4000 });
    expect(estimateSkillWindow(profile(), { ...window(0, 3), deployedAt: 5 }).totalDamage).toBe(0);
  });

  it("stops new manual auto-activations when the helper ends while retaining active tails and normal attacks", () => {
    const partialTail = estimateSkillWindow(profile(), { ...window(0, 45), skillUsage: 1, autoActivationUntil: 12 });
    expect(partialTail).toMatchObject({ skillSeconds: 5, normalSeconds: 40, totalDamage: 9000 });
    expect(partialTail.coverageGaps).toContain("auto_activation_ends_with_script");
    expect(estimateSkillWindow(profile(), { ...window(25, 35), autoActivationUntil: 28 }))
      .toMatchObject({ skillSeconds: 5, normalSeconds: 5 });
    expect(estimateSkillWindow(profile(), { ...window(25, 35), autoActivationUntil: 25 }))
      .toMatchObject({ skillSeconds: 0, normalDamage: 1000 });
    for (const skillUsage of [1, 2]) {
      expect(estimateSkillWindow(profile(), { ...window(0, 30), skillUsage, autoActivationUntil: 10 }).skillSeconds).toBe(0);
      expect(estimateSkillWindow(profile(), { ...window(0, 30), skillUsage, autoActivationUntil: 12 }).skillSeconds).toBe(5);
    }
    expect(estimateSkillWindow(profile({ durationSemantics: "indefinite", rawDuration: -1 }),
      { ...window(20, 30), autoActivationUntil: 12 }).skillSeconds).toBe(10);
  });

  it("keeps game automatic, passive and explicit manual activations independent of the auto cutoff", () => {
    const automatic = estimateSkillWindow(profile({ skillType: "AUTO" }), { ...window(0, 45), autoActivationUntil: 0 });
    expect(automatic.skillSeconds).toBe(15);
    expect(automatic.coverageGaps).not.toContain("auto_activation_ends_with_script");
    expect(estimateSkillWindow(profile({ skillType: "PASSIVE" }), { ...window(0, 10), autoActivationUntil: 0 }).skillSeconds).toBe(5);
    expect(estimateSkillWindow(profile(), { ...window(20, 30), skillUsage: 0, activationTimes: [22], autoActivationUntil: 0 }))
      .toMatchObject({ skillSeconds: 5, normalSeconds: 5 });
  });

  it("supports proven indefinite skills while withholding ammo, instant and unknown-SP skill damage", () => {
    expect(estimateSkillWindow(profile({ rawDuration: -1, skillDuration: 0, durationSemantics: "indefinite" }), window(0, 30)))
      .toMatchObject({ normalSeconds: 10, skillSeconds: 20 });
    for (const candidate of [profile({ rawDuration: -1, durationType: "AMMO" }), profile({ rawDuration: 0, skillDuration: 0 }),
      profile({ rawDuration: -1, skillDuration: 0 }),
      profile({ spType: "INCREASE_WHEN_ATTACK" }), profile({ spType: "INCREASE_WHEN_TAKEN_DAMAGE" })]) {
      const result = estimateSkillWindow(candidate, window(0, 30));
      expect(result.skillDamage).toBe(0);
      expect(result.coverageGaps.length).toBeGreaterThan(0);
    }
  });

  it("handles finite passive effects and never credits idle liberator or bard attacks", () => {
    expect(estimateSkillWindow(profile({ skillType: "PASSIVE", spType: "NONE" }), window(0, 10)))
      .toMatchObject({ skillSeconds: 5, normalSeconds: 5 });
    expect(estimateSkillWindow(profile({ subProfession: "liberator" }), window(0, 5)).totalDamage).toBe(0);
    expect(estimateSkillWindow(profile({ subProfession: "bard" }), window(0, 30)).totalDamage).toBe(0);
    expect(estimateSkillWindow(profile({ subProfession: "bearer" }), window(10, 15)).totalDamage).toBe(0);
  });

  it("withholds attacks forbidden outside skills, including startup, recharge and a missing activation", () => {
    const restricted = profile({ normalAttackSuppressed: true, normalAttackEvidence: "description:技能未开启时无法普通攻击" });
    expect(estimateSkillWindow(restricted, window(0, 10))).toMatchObject({ normalDamage: 0, skillDamage: 0 });
    expect(estimateSkillWindow(restricted, window(0, 30))).toMatchObject({ normalDamage: 0, skillDamage: 10000 });
    expect(estimateSkillWindow(restricted, window(15, 25))).toMatchObject({ normalDamage: 0, skillDamage: 0 });
    expect(estimateSkillWindow(restricted, { ...window(0, 40), skillUsage: 0 }).totalDamage).toBe(0);
    expect(estimateSkillWindow(restricted, { ...window(0, 40), skillUsage: 0, activationTimes: [28] }))
      .toMatchObject({ normalDamage: 0, skillDamage: 5000 });
  });

  it("uses the audited Angelina skill restriction without disabling her ordinary first skill", () => {
    for (const skill of [2, 3]) {
      const resolved = resolveOperatorProfile(getCombatOperatorByName("安洁莉娜")!, skill);
      expect(resolved.normalAttackSuppressed).toBe(true);
      expect(resolved.normalAttackEvidence).toBe("description:技能未开启时无法普通攻击");
      expect(estimateSkillWindow(resolved, { ...window(0, 15), skillUsage: 0 }).totalDamage).toBe(0);
    }
    const ordinary = resolveOperatorProfile(getCombatOperatorByName("安洁莉娜")!, 1);
    expect(ordinary.normalAttackSuppressed).toBe(false);
    expect(estimateSkillWindow(ordinary, { ...window(0, 15), skillUsage: 0 }).normalDamage).toBeGreaterThan(0);
  });

  it("does not infer an activation or downstream queue timing when the command precedes readiness", () => {
    const result = estimateSkillWindow(profile(), { ...window(0, 30), skillUsage: 0, activationTimes: [2, 28] });
    expect(result.skillDamage).toBe(0);
    expect(result.coverageGaps).toContain("manual_skill_activation_unready");
  });

  it("distinguishes audited GameData instant, indefinite, passive and no-attack skills", () => {
    for (const [name, skill] of [["灰烬", 3], ["夕", 1], ["温蒂", 3], ["莱恩哈特", 2], ["红", 2]] as const) {
      const resolved = resolveOperatorProfile(getCombatOperatorByName(name)!, skill);
      const result = estimateSkillWindow(resolved, { ...window(100, 115), activationTimes: [25] });
      expect(resolved.durationSemantics).toBe("unknown");
      expect(result.skillDamage).toBe(0);
      expect(result.coverageGaps.length).toBeGreaterThan(0);
    }
    const continuous = resolveOperatorProfile(getCombatOperatorByName("温蒂")!, 2);
    expect(continuous.rawDuration).toBe(0);
    expect(continuous.durationSemantics).toBe("indefinite");
    expect(estimateSkillWindow(continuous, window(100, 115)).skillSeconds).toBe(15);
    const passive = resolveOperatorProfile(getCombatOperatorByName("森蚺")!, 1);
    expect(passive.durationSemantics).toBe("indefinite");
    expect(estimateSkillWindow(passive, window(0, 15)).skillSeconds).toBe(15);
    const bearer = resolveOperatorProfile(getCombatOperatorByName("桃金娘")!, 1);
    expect(estimateSkillWindow(bearer, window(9, 17)).totalDamage).toBe(0);
  });
});
