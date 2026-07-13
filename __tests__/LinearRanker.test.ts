import fs from "fs";
import os from "os";
import path from "path";
import { LinearActionRanker, type CpuActionRankerModel } from "../src/model-core/linearRanker";

function model(): CpuActionRankerModel {
  return {
    version: "cpu-action-ranker-v0",
    modelType: "linear_pairwise_ranker",
    featureNames: ["a", "b", "missing"],
    weights: [2, -1, 5],
    bias: 0.5,
    normalization: {
      a: { mean: 1, std: 2 },
      b: { mean: 0, std: 1 },
      missing: { mean: 0, std: 1 },
    },
  };
}

describe("LinearActionRanker", () => {
  it("loads model JSON from object and file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-ranker-"));
    try {
      const file = path.join(tmp, "model.json");
      fs.writeFileSync(file, JSON.stringify(model()), "utf8");

      expect(LinearActionRanker.loadFromJson(model()).model.featureNames).toEqual(["a", "b", "missing"]);
      expect(LinearActionRanker.loadFromJson(file).model.weights).toEqual([2, -1, 5]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scores with feature order, missing values, and normalization", () => {
    const ranker = LinearActionRanker.loadFromJson(model());

    expect(ranker.score({ a: 5, b: 3 })).toBeCloseTo(0.5 + 2 * 2 - 3 + 0);
  });

  it("treats NaN and Infinity as zero", () => {
    const ranker = LinearActionRanker.loadFromJson({
      version: "cpu-action-ranker-v0",
      modelType: "linear_pairwise_ranker",
      featureNames: ["x", "y"],
      weights: [1, 1],
      bias: 1,
    });

    expect(ranker.score({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toBe(1);
  });

  it("exposes learned operator usage priors", () => {
    const ranker = LinearActionRanker.loadFromJson({
      ...model(),
      operatorPriors: { A: 0.75 },
    });

    expect(ranker.operatorPrior("A")).toBe(0.75);
    expect(ranker.operatorPrior("missing")).toBe(0);
  });

  it("ranks by descending score and keeps tie order stable", () => {
    const ranker = LinearActionRanker.loadFromJson({
      version: "cpu-action-ranker-v0",
      modelType: "linear_pairwise_ranker",
      featureNames: ["x"],
      weights: [1],
      bias: 0,
    });

    const ranked = ranker.rank([
      { action: { type: "End" }, features: { x: 1 } },
      { action: { type: "SkillDaemon" }, features: { x: 3 } },
      { action: { type: "Deploy", operatorId: "A" }, features: { x: 3 } },
    ]);

    expect(ranked.map(item => item.action.type)).toEqual(["SkillDaemon", "Deploy", "End"]);
    expect(ranked.map(item => item.score)).toEqual([3, 3, 1]);
  });
});
