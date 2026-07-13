#!/usr/bin/env python
"""Train a CPU-only linear pairwise action ranker."""

from __future__ import annotations

import argparse
import json
import math
import os
import random
from collections import Counter
from dataclasses import dataclass
from typing import Dict, Iterable, List, Tuple


VERSION = "cpu-action-ranker-v0"
MODEL_TYPE = "linear_pairwise_ranker"


@dataclass
class Row:
    group_id: str
    label: int
    features: Dict[str, float]
    action: object


def clean_number(value: object, *, feature: str, group_id: str) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if not isinstance(value, (int, float)):
        raise ValueError(f"Non-numeric feature {feature!r} in group {group_id!r}")
    number = float(value)
    return number if math.isfinite(number) else 0.0


def read_jsonl(path: str) -> List[Row]:
    rows: List[Row] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            group_id = str(raw.get("group_id", ""))
            features = raw.get("features") or {}
            if not isinstance(features, dict):
                raise ValueError(f"features must be an object at {path}:{line_number}")
            rows.append(Row(
                group_id=group_id,
                label=int(raw.get("label", 0)),
                features={name: clean_number(value, feature=name, group_id=group_id) for name, value in features.items()},
                action=raw.get("action"),
            ))
    return rows


def feature_names(rows: Iterable[Row]) -> List[str]:
    names = set()
    for row in rows:
        names.update(row.features.keys())
    return sorted(names)


def group_rows(rows: Iterable[Row]) -> Dict[str, Tuple[Row, List[Row]]]:
    grouped: Dict[str, List[Row]] = {}
    for row in rows:
        grouped.setdefault(row.group_id, []).append(row)
    result: Dict[str, Tuple[Row, List[Row]]] = {}
    for group_id, group in grouped.items():
        positives = [row for row in group if row.label == 1]
        negatives = [row for row in group if row.label == 0]
        if len(positives) != 1:
            raise ValueError(f"group {group_id!r} must have exactly one positive row, got {len(positives)}")
        if negatives:
            result[group_id] = (positives[0], negatives)
    return result


def positive_action_type(row: Row) -> str:
    if isinstance(row.action, dict):
        value = row.action.get("type")
        if isinstance(value, str) and value:
            return value
    return "unknown"


def balanced_group_weights(groups: Dict[str, Tuple[Row, List[Row]]]) -> Dict[str, float]:
    counts = Counter(positive_action_type(positive) for positive, _ in groups.values())
    if not counts:
        return {}
    reference_count = max(counts.values())
    return {
        group_id: math.sqrt(reference_count / counts[positive_action_type(positive)])
        if positive_action_type(positive) == "SkillUse"
        else 1.0
        for group_id, (positive, _) in groups.items()
    }


def action_operator_id(row: Row) -> str | None:
    if not isinstance(row.action, dict):
        return None
    value = row.action.get("operatorId") or row.action.get("name")
    return value.strip() if isinstance(value, str) and value.strip() else None


def operator_public_usage_priors(rows: Iterable[Row]) -> Dict[str, float]:
    counts = Counter(
        operator_id
        for row in rows
        if row.label == 1 and positive_action_type(row) == "Deploy"
        for operator_id in [action_operator_id(row)]
        if operator_id
    )
    if not counts:
        return {}
    maximum = math.log1p(max(counts.values()))
    return {operator_id: math.log1p(count) / maximum for operator_id, count in counts.items()}


def apply_operator_public_usage_priors(rows: Iterable[Row], priors: Dict[str, float]) -> None:
    for row in rows:
        row.features["operator_public_usage_prior"] = priors.get(action_operator_id(row) or "", 0.0)


def normalization_stats(rows: List[Row], names: List[str]) -> Dict[str, Dict[str, float]]:
    stats: Dict[str, Dict[str, float]] = {}
    for name in names:
        values = [row.features.get(name, 0.0) for row in rows]
        mean = sum(values) / max(1, len(values))
        variance = sum((value - mean) ** 2 for value in values) / max(1, len(values))
        std = math.sqrt(variance) or 1.0
        stats[name] = {"mean": mean, "std": std}
    return stats


def vector(row: Row, names: List[str], normalization: Dict[str, Dict[str, float]]) -> List[float]:
    values: List[float] = []
    for name in names:
        raw = row.features.get(name, 0.0)
        stat = normalization.get(name, {"mean": 0.0, "std": 1.0})
        std = stat.get("std") or 1.0
        values.append((raw - stat.get("mean", 0.0)) / std)
    return values


def dot(weights: List[float], values: List[float], bias: float = 0.0) -> float:
    return bias + sum(weight * value for weight, value in zip(weights, values))


def softplus_negative_margin(margin: float) -> float:
    if margin >= 0:
        return math.log1p(math.exp(-margin))
    return -margin + math.log1p(math.exp(margin))


def sigmoid_negative(margin: float) -> float:
    if margin >= 0:
        exp_neg = math.exp(-margin)
        return -exp_neg / (1.0 + exp_neg)
    return -1.0 / (1.0 + math.exp(margin))


def evaluate(rows: List[Row], names: List[str], weights: List[float], bias: float, normalization: Dict[str, Dict[str, float]]) -> Dict[str, float]:
    groups = group_rows(rows)
    if not groups:
        return {
            "valid_top1_accuracy": 0.0,
            "valid_top3_recall": 0.0,
            "valid_top5_recall": 0.0,
            "mean_positive_rank": 0.0,
            "pairwise_accuracy": 0.0,
        }
    top1 = top3 = top5 = rank_sum = 0.0
    pairwise_hits = pairwise_total = 0.0
    for positive, negatives in groups.values():
        rows_with_scores = [(positive, dot(weights, vector(positive, names, normalization), bias), 0)]
        rows_with_scores += [(row, dot(weights, vector(row, names, normalization), bias), index + 1) for index, row in enumerate(negatives)]
        rows_with_scores.sort(key=lambda item: (-item[1], item[2]))
        rank = next(index + 1 for index, (row, _, _) in enumerate(rows_with_scores) if row.label == 1)
        top1 += rank <= 1
        top3 += rank <= 3
        top5 += rank <= 5
        rank_sum += rank
        pos_score = rows_with_scores[rank - 1][1]
        for row, score, _ in rows_with_scores:
            if row.label == 0:
                pairwise_hits += 1.0 if pos_score > score else 0.5 if pos_score == score else 0.0
                pairwise_total += 1.0
    group_count = len(groups)
    return {
        "valid_top1_accuracy": top1 / group_count,
        "valid_top3_recall": top3 / group_count,
        "valid_top5_recall": top5 / group_count,
        "mean_positive_rank": rank_sum / group_count,
        "pairwise_accuracy": pairwise_hits / pairwise_total if pairwise_total else 0.0,
    }


def train_model(
    train_rows: List[Row],
    valid_rows: List[Row],
    *,
    epochs: int,
    lr: float,
    l2: float,
    seed: int,
) -> Dict[str, object]:
    operator_priors = operator_public_usage_priors(train_rows)
    apply_operator_public_usage_priors(train_rows, operator_priors)
    apply_operator_public_usage_priors(valid_rows, operator_priors)
    names = feature_names(train_rows)
    normalization = normalization_stats(train_rows, names)
    grouped = group_rows(train_rows)
    group_weights = balanced_group_weights(grouped)
    weights = [0.0 for _ in names]
    bias = 0.0
    rng = random.Random(seed)
    history: List[Dict[str, float]] = []
    best_weights = list(weights)
    best_metrics: Dict[str, float] | None = None
    best_epoch = 0

    for epoch in range(max(0, epochs)):
        items = list(grouped.items())
        rng.shuffle(items)
        total_loss = 0.0
        total_weight = 0.0
        for group_id, (positive, negatives) in items:
            pos_vec = vector(positive, names, normalization)
            pair_weight = group_weights[group_id] / len(negatives)
            for negative in negatives:
                neg_vec = vector(negative, names, normalization)
                delta = [p - n for p, n in zip(pos_vec, neg_vec)]
                margin = dot(weights, delta)
                grad_margin = sigmoid_negative(margin)
                total_loss += pair_weight * softplus_negative_margin(margin)
                total_weight += pair_weight
                for index, diff in enumerate(delta):
                    weights[index] -= lr * pair_weight * (grad_margin * diff + l2 * weights[index])
        metrics = evaluate(valid_rows, names, weights, bias, normalization) if valid_rows else evaluate(train_rows, names, weights, bias, normalization)
        epoch_loss = total_loss / max(1.0, total_weight)
        history.append({"epoch": epoch + 1, "loss": epoch_loss, **metrics})
        print(json.dumps(history[-1], ensure_ascii=False))

        metric_key = (
            metrics["valid_top5_recall"], metrics["valid_top3_recall"], metrics["valid_top1_accuracy"],
            -metrics["mean_positive_rank"], metrics["pairwise_accuracy"],
        )
        best_key = None if best_metrics is None else (
            best_metrics["valid_top5_recall"], best_metrics["valid_top3_recall"], best_metrics["valid_top1_accuracy"],
            -best_metrics["mean_positive_rank"], best_metrics["pairwise_accuracy"],
        )
        if best_key is None or metric_key > best_key:
            best_weights = list(weights)
            best_metrics = dict(metrics)
            best_epoch = epoch + 1

    weights = best_weights
    metrics = best_metrics or (evaluate(valid_rows, names, weights, bias, normalization) if valid_rows else evaluate(train_rows, names, weights, bias, normalization))
    return {
        "version": VERSION,
        "modelType": MODEL_TYPE,
        "featureNames": names,
        "weights": weights,
        "bias": bias,
        "normalization": normalization,
        "operatorPriors": operator_priors,
        "trainConfig": {
            "epochs": epochs,
            "lr": lr,
            "l2": l2,
            "seed": seed,
            "balanceSkillActions": "sqrt_inverse_frequency",
            "normalizeNegativesPerGroup": True,
            "bestEpoch": best_epoch,
        },
        "metrics": metrics,
        "history": history,
    }


def write_json(path: str, value: object) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train CPU linear pairwise action ranker")
    parser.add_argument("--train", required=True)
    parser.add_argument("--valid", required=True)
    parser.add_argument("--out", default="models/cpu-action-ranker.json")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--lr", type=float, default=0.05)
    parser.add_argument("--l2", type=float, default=0.0001)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args(argv)


def main(argv: List[str] | None = None) -> Dict[str, object]:
    args = parse_args(argv)
    train_rows = read_jsonl(args.train)
    valid_rows = read_jsonl(args.valid)
    model = train_model(train_rows, valid_rows, epochs=args.epochs, lr=args.lr, l2=args.l2, seed=args.seed)
    write_json(args.out, model)
    print(json.dumps({"output": args.out, "metrics": model["metrics"], "featureCount": len(model["featureNames"])}, ensure_ascii=False, indent=2))
    return model


if __name__ == "__main__":
    main()
