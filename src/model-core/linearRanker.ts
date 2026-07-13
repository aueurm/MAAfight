import * as fs from "fs";
import type { BattleAction } from "./battleDsl";

export interface CpuActionRankerModel {
  version: string;
  modelType: "linear_pairwise_ranker" | string;
  featureNames: string[];
  weights: number[];
  bias?: number;
  normalization?: Record<string, { mean?: number; std?: number }>;
  operatorPriors?: Record<string, number>;
  trainConfig?: Record<string, unknown>;
  metrics?: Record<string, number>;
}

export interface RankInput {
  action: BattleAction;
  features: Record<string, number>;
}

export interface RankedAction {
  action: BattleAction;
  score: number;
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export class LinearActionRanker {
  readonly model: CpuActionRankerModel;

  private constructor(model: CpuActionRankerModel) {
    if (!Array.isArray(model.featureNames) || !Array.isArray(model.weights)) {
      throw new Error("Invalid linear ranker model: featureNames and weights are required");
    }
    if (model.featureNames.length !== model.weights.length) {
      throw new Error("Invalid linear ranker model: featureNames and weights length mismatch");
    }
    this.model = model;
  }

  static loadFromJson(pathOrObject: string | CpuActionRankerModel): LinearActionRanker {
    const model = typeof pathOrObject === "string"
      ? JSON.parse(fs.readFileSync(pathOrObject, "utf8"))
      : pathOrObject;
    return new LinearActionRanker(model);
  }

  score(features: Record<string, number>): number {
    let score = finite(this.model.bias);
    for (let index = 0; index < this.model.featureNames.length; index++) {
      const name = this.model.featureNames[index];
      const stat = this.model.normalization?.[name] || {};
      const std = finite(stat.std) || 1;
      const value = (finite(features[name]) - finite(stat.mean)) / std;
      score += finite(this.model.weights[index]) * value;
    }
    return score;
  }

  operatorPrior(operatorId: string | undefined): number {
    return operatorId ? finite(this.model.operatorPriors?.[operatorId]) : 0;
  }

  rank(candidates: RankInput[]): RankedAction[] {
    return candidates
      .map((candidate, index) => ({ action: candidate.action, score: this.score(candidate.features), index }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ action, score }) => ({ action, score }));
  }
}
