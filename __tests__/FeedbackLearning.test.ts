import { deriveSearchBias } from "../src/feedback/FeedbackLearning";
import type { FeedbackRecord } from "../src/feedback/FeedbackStore";

function record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    schemaVersion: 3, feedbackId: "feedback", scriptHash: "script", stageId: "stage", operatorBoxHash: "box",
    currentOperatorBoxHash: "box", operatorBoxChanged: false, killed: 5, total: 10, ratio: 0.5,
    usableForLearning: true, createdAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("feedback search bias", () => {
  it("turns early leaks, air failures, deaths and deploy failures into bounded search weights", () => {
    const bias = deriveSearchBias([record({
      firstLeak: { time: 12, routeId: 3, location: [2, 4] },
      operatorDeaths: [{ name: "frontline", time: 16 }],
      deploymentFailures: [{ name: "expensive", time: 5, reason: "cost" }],
      failureTags: ["flying"],
    })]);

    expect(bias.openingCoverage).toBeGreaterThan(0);
    expect(bias.antiAir).toBeGreaterThan(0);
    expect(bias.healing).toBeGreaterThan(0);
    expect(bias.costSafety).toBeGreaterThan(0);
    expect(bias.routeWeights[3]).toBeGreaterThan(0);
  });

  it("ignores complete or unusable feedback", () => {
    expect(deriveSearchBias([
      record({ ratio: 1 }),
      record({ feedbackId: "changed", usableForLearning: false }),
    ])).toEqual({ openingCoverage: 0, antiAir: 0, bossBurst: 0, healing: 0, costSafety: 0, routeWeights: {} });
  });
});
