import { buildMechanicAdjustment } from "../src/engine/EnemyMechanics";

describe("enemy mechanisms", () => {
  it("turns known mechanics into conservative planning adjustments", () => {
    expect(buildMechanicAdjustment(["unblockable"]).blockMultiplier).toBeLessThan(1);
    expect(buildMechanicAdjustment(["antiHeal"]).healingMultiplier).toBeLessThan(1);
    expect(buildMechanicAdjustment(["deathExplosion"]).denseMeleePenalty).toBeGreaterThan(0);
  });

  it("records unknown runtime tags as coverage gaps", () => {
    expect(buildMechanicAdjustment(["unknown" as never]).coverageGaps).toContain("unknown_enemy_mechanic:unknown");
  });
});
