import { getOperatorStrengthProfile } from "../src/battle/OperatorStrength";
import { scoreOperatorStrength } from "../src/battle/OperatorStrengthScorer";

describe("OperatorStrengthScorer", () => {
  it("should resolve aliases from strength data", () => {
    const profile = getOperatorStrengthProfile("Wis'adel");
    expect(profile?.name).toBe("维什戴尔");
  });

  it("should return neutral fallback for operators without strength data", () => {
    const score = scoreOperatorStrength({ name: "不存在的干员" }, "physical_dps");
    expect(score.score).toBe(50);
    expect(score.strengthTier).toBeUndefined();
    expect(score.reasons[0]).toContain("neutral fallback");
  });

  it("should penalize high precision operators in SkillDaemon mode", () => {
    const score = scoreOperatorStrength({ name: "鸿雪" }, "boss_kill", { skillDaemonMode: true });
    expect(score.automationScore).toBeLessThan(70);
    expect(score.reasons.join(" ")).toContain("high precision");
  });
});
