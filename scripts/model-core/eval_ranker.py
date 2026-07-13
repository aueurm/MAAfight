#!/usr/bin/env python
"""Offline evaluation for CPU linear action ranker."""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from statistics import median
from typing import Dict, Iterable, List, Tuple


TOP_KS = [1, 3, 5, 10]
DELAY_BUCKETS = {0, 250, 500, 750, 1000, 1500, 3000, 5000}
DIRECTIONS = {"Up", "Down", "Left", "Right", "None"}


@dataclass
class Row:
    group_id: str
    label: int
    features: Dict[str, float]
    action: Dict[str, object]


def finite(value: object) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    number = float(value) if isinstance(value, (int, float)) else 0.0
    return number if math.isfinite(number) else 0.0


def read_jsonl(path: str) -> List[Row]:
    rows: List[Row] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            features = raw.get("features") or {}
            if not isinstance(features, dict):
                raise ValueError(f"features must be object at {path}:{line_number}")
            action = raw.get("action") or {}
            rows.append(Row(
                group_id=str(raw.get("group_id", "")),
                label=int(raw.get("label", 0)),
                features={key: finite(value) for key, value in features.items()},
                action=action if isinstance(action, dict) else {},
            ))
    return rows


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
        result[group_id] = (positives[0], negatives)
    return result


def load_model(path: str) -> Dict[str, object]:
    with open(path, "r", encoding="utf-8") as handle:
        model = json.load(handle)
    if not isinstance(model.get("featureNames"), list) or not isinstance(model.get("weights"), list):
        raise ValueError("model must contain featureNames and weights")
    if len(model["featureNames"]) != len(model["weights"]):
        raise ValueError("featureNames and weights length mismatch")
    return model


def score_row(row: Row, model: Dict[str, object]) -> float:
    feature_names = model["featureNames"]
    weights = model["weights"]
    normalization = model.get("normalization") or {}
    score = finite(model.get("bias", 0.0))
    for name, weight in zip(feature_names, weights):
        stat = normalization.get(name, {}) if isinstance(normalization, dict) else {}
        mean = finite(stat.get("mean", 0.0)) if isinstance(stat, dict) else 0.0
        std = finite(stat.get("std", 1.0)) if isinstance(stat, dict) else 1.0
        if std == 0:
            std = 1.0
        value = row.features.get(name, 0.0)
        if name == "operator_public_usage_prior":
            operator_id = row.action.get("operatorId") or row.action.get("name")
            priors = model.get("operatorPriors") or {}
            value = priors.get(operator_id, 0.0) if isinstance(priors, dict) else 0.0
        score += finite(weight) * ((finite(value) - mean) / std)
    return score


def action_type(action: Dict[str, object]) -> str:
    raw = str(action.get("type", "Unknown"))
    if raw == "END":
        return "End"
    return raw


def same_position(left: Dict[str, object], right: Dict[str, object]) -> bool:
    return left.get("x") == right.get("x") and left.get("y") == right.get("y")


def same_operator(left: Dict[str, object], right: Dict[str, object]) -> bool:
    left_operator = left.get("operatorId") or left.get("name") or left.get("operator")
    right_operator = right.get("operatorId") or right.get("name") or right.get("operator")
    return bool(left_operator and right_operator and left_operator == right_operator)


def same_direction(left: Dict[str, object], right: Dict[str, object]) -> bool:
    return left.get("direction") == right.get("direction")


def same_delay(left: Dict[str, object], right: Dict[str, object]) -> bool:
    return finite(left.get("delay", 0)) == finite(right.get("delay", 0))


def is_delay_bucket(value: object) -> bool:
    return int(finite(value)) in DELAY_BUCKETS


def is_valid_action(action: Dict[str, object]) -> bool:
    kind = action_type(action)
    if kind in {"End", "SkillDaemon", "SpeedUp"}:
        return True
    if not is_delay_bucket(action.get("delay", 0)):
        return False
    if kind in {"SkillUse", "Skill", "Retreat"}:
        return bool(action.get("operatorId") or action.get("name"))
    if kind != "Deploy":
        return False
    if not (action.get("operatorId") or action.get("name")):
        return False
    if not isinstance(action.get("x"), int) or not isinstance(action.get("y"), int):
        return False
    return action.get("direction") in DIRECTIONS


def validator_report(rows: List[Row]) -> Dict[str, float]:
    total = len(rows)
    valid = sum(1 for row in rows if is_valid_action(row.action))
    positives = [row for row in rows if row.label == 1]
    valid_positives = sum(1 for row in positives if is_valid_action(row.action))
    return {
        "rowCount": total,
        "validActionCount": valid,
        "invalidActionCount": total - valid,
        "validatorPassRate": valid / total if total else 0.0,
        "positiveValidatorPassRate": valid_positives / len(positives) if positives else 0.0,
    }


def ranked_groups_by_score(rows: List[Row], scorer) -> Dict[str, List[Tuple[Row, float, int]]]:
    groups = group_rows(rows)
    ranked: Dict[str, List[Tuple[Row, float, int]]] = {}
    for group_id, (positive, negatives) in groups.items():
        scored = [(positive, scorer(positive), 0)]
        scored += [(row, scorer(row), index + 1) for index, row in enumerate(negatives)]
        scored.sort(key=lambda item: (-item[1], json.dumps(item[0].action, ensure_ascii=False, sort_keys=True)))
        ranked[group_id] = scored
    return ranked


def ranked_groups(rows: List[Row], model: Dict[str, object]) -> Dict[str, List[Tuple[Row, float, int]]]:
    return ranked_groups_by_score(rows, lambda row: score_row(row, model))


def rule_core_proxy_score(row: Row) -> float:
    features = row.features
    return (
        features.get("position_prior", 0.0) * 2.0
        + features.get("direction_prior", 0.0)
        + features.get("timing_prior", 0.0)
        + features.get("operator_public_usage_prior", 0.0)
        + features.get("is_legal_deploy_cell", 0.0)
        - features.get("tile_type_invalid", 0.0) * 2.0
    )


def handwritten_score(row: Row) -> float:
    features = row.features
    return (
        features.get("action_type_deploy", 0.0) * 0.4
        + features.get("action_type_skill_daemon", 0.0) * 0.1
        + features.get("action_type_end", 0.0) * 0.05
        + features.get("is_legal_deploy_cell", 0.0) * 1.2
        + features.get("is_tile_type_fit", 0.0) * 0.8
        + features.get("position_prior", 0.0) * 0.8
        + features.get("direction_prior", 0.0) * 0.5
        + features.get("timing_prior", 0.0) * 0.3
        - features.get("is_duplicate_operator", 0.0) * 1.5
        - features.get("is_occupied_cell", 0.0) * 1.5
        - features.get("tile_type_invalid", 0.0) * 2.0
    )


def compact_report(report: Dict[str, object]) -> Dict[str, object]:
    return {
        "metrics": report["metrics"],
        "deployMetrics": report["deployMetrics"],
        "byActionType": report["byActionType"],
    }


def ablation_report(rows: List[Row], model: Dict[str, object]) -> Dict[str, object]:
    baselines = {
        "ruleCoreProxy": ranked_groups_by_score(rows, rule_core_proxy_score),
        "handwrittenScoring": ranked_groups_by_score(rows, handwritten_score),
        "actionRanker": ranked_groups(rows, model),
    }
    return {
        name: compact_report(evaluate_ranked(ranked, len(rows), {"version": name, "modelType": name}, bad_limit=0)["report"])
        for name, ranked in baselines.items()
    }


def top_hit(rank: int, k: int) -> float:
    return 1.0 if rank <= k else 0.0


def empty_top_metrics() -> Dict[str, float]:
    return {f"top{k}": 0.0 for k in TOP_KS}


def add_top_metrics(target: Dict[str, float], rank: int) -> None:
    for k in TOP_KS:
        target[f"top{k}"] += top_hit(rank, k)


def evaluate_ranked(ranked: Dict[str, List[Tuple[Row, float, int]]], row_count: int, model: Dict[str, object], bad_limit: int = 20) -> Dict[str, object]:
    ranks: List[int] = []
    pairwise_hits = 0.0
    pairwise_total = 0.0
    margins: List[float] = []
    top_counts = empty_top_metrics()
    by_type_raw: Dict[str, Dict[str, float]] = {}
    deploy_raw = {name: {f"top{k}": 0.0 for k in TOP_KS} for name in ["position", "direction", "delay", "operator"]}
    deploy_count = 0
    bad_cases = []

    for group_id, scored in ranked.items():
        positive_index = next(index for index, (row, _, _) in enumerate(scored) if row.label == 1)
        positive, positive_score, _ = scored[positive_index]
        rank = positive_index + 1
        ranks.append(rank)
        add_top_metrics(top_counts, rank)

        kind = action_type(positive.action)
        by_type = by_type_raw.setdefault(kind, {"count": 0.0, **empty_top_metrics()})
        by_type["count"] += 1
        add_top_metrics(by_type, rank)

        negative_scores = [score for row, score, _ in scored if row.label == 0]
        if negative_scores:
            margins.append(positive_score - max(negative_scores))
        for row, score, _ in scored:
            if row.label == 0:
                pairwise_hits += 1.0 if positive_score > score else 0.5 if positive_score == score else 0.0
                pairwise_total += 1.0

        if kind == "Deploy":
            deploy_count += 1
            for k in TOP_KS:
                top_actions = [row.action for row, _, _ in scored[:k]]
                if any(same_position(positive.action, action) for action in top_actions):
                    deploy_raw["position"][f"top{k}"] += 1
                if any(same_direction(positive.action, action) for action in top_actions):
                    deploy_raw["direction"][f"top{k}"] += 1
                if any(same_delay(positive.action, action) for action in top_actions):
                    deploy_raw["delay"][f"top{k}"] += 1
                if any(same_operator(positive.action, action) for action in top_actions):
                    deploy_raw["operator"][f"top{k}"] += 1

        if rank > 1 and len(bad_cases) < bad_limit:
            bad_cases.append({
                "group_id": group_id,
                "positive_rank": rank,
                "positive_action": positive.action,
                "top_candidates": [
                    {"score": score, "action": row.action}
                    for row, score, _ in scored[:10]
                ],
            })

    group_count = len(ranked)
    metrics = {
        "top1": top_counts["top1"] / group_count if group_count else 0.0,
        "top3": top_counts["top3"] / group_count if group_count else 0.0,
        "top5": top_counts["top5"] / group_count if group_count else 0.0,
        "top10": top_counts["top10"] / group_count if group_count else 0.0,
        "meanPositiveRank": sum(ranks) / group_count if group_count else 0.0,
        "medianPositiveRank": median(ranks) if ranks else 0.0,
        "pairwiseAccuracy": pairwise_hits / pairwise_total if pairwise_total else 0.0,
        "meanScoreMargin": sum(margins) / len(margins) if margins else 0.0,
    }
    by_action_type = {
        key: {
            "count": int(value["count"]),
            **{f"top{k}": value[f"top{k}"] / value["count"] if value["count"] else 0.0 for k in TOP_KS},
        }
        for key, value in sorted(by_type_raw.items())
    }
    deploy_metrics = {
        name: {
            "count": deploy_count,
            **{f"top{k}": values[f"top{k}"] / deploy_count if deploy_count else 0.0 for k in TOP_KS},
        }
        for name, values in deploy_raw.items()
    }
    report = {
        "modelVersion": model.get("version", "unknown"),
        "modelType": model.get("modelType", "unknown"),
        "groupCount": group_count,
        "rowCount": row_count,
        "metrics": metrics,
        "byActionType": by_action_type,
        "deployMetrics": deploy_metrics,
    }
    return {"report": report, "badCases": bad_cases}


def write_json(path: str, value: object) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def write_jsonl(path: str, rows: Iterable[object]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate CPU action ranker on valid JSONL")
    parser.add_argument("--model", required=True)
    parser.add_argument("--valid", required=True)
    parser.add_argument("--out", default="data/model-core/eval_report.json")
    parser.add_argument("--badCases", default="data/model-core/bad_cases.jsonl")
    parser.add_argument("--dumpBadCases", type=int, default=20)
    return parser.parse_args(argv)


def main(argv: List[str] | None = None) -> Dict[str, object]:
    args = parse_args(argv)
    model = load_model(args.model)
    rows = read_jsonl(args.valid)
    result = evaluate_ranked(ranked_groups(rows, model), len(rows), model, max(0, args.dumpBadCases))
    result["report"]["validator"] = validator_report(rows)
    result["report"]["ablation"] = ablation_report(rows, model)
    result["report"]["ablationNotes"] = {
        "ruleCoreProxy": "valid.jsonl has candidate rows, not full legacy CandidateBuilder scripts; this proxy scores public prior and legality features for offline comparison.",
        "handwrittenScoring": "wide enumerator plus fixed feature weights; use as B baseline before trusting model C.",
        "actionRanker": "wide enumerator plus trained linear ranker.",
    }
    write_json(args.out, result["report"])
    if args.dumpBadCases > 0:
        write_jsonl(args.badCases, result["badCases"])
    print(json.dumps({
        "output": args.out,
        "badCases": args.badCases if args.dumpBadCases > 0 else None,
        "metrics": result["report"]["metrics"],
        "validator": result["report"]["validator"],
        "ablation": {
            name: value["metrics"]
            for name, value in result["report"]["ablation"].items()
        },
        "groupCount": result["report"]["groupCount"],
        "rowCount": result["report"]["rowCount"],
    }, ensure_ascii=False, indent=2))
    return result


if __name__ == "__main__":
    main()
