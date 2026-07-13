import importlib.util
import json
import os
import sys
import tempfile
import unittest


SCRIPT_PATH = os.path.join(os.path.dirname(__file__), "eval_ranker.py")
SPEC = importlib.util.spec_from_file_location("eval_ranker", SCRIPT_PATH)
evaluator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = evaluator
SPEC.loader.exec_module(evaluator)


def row(group_id, label, score, action):
    return {
        "group_id": group_id,
        "label": label,
        "features": {"score": score},
        "action": action,
    }


def model():
    return {
        "version": "cpu-action-ranker-v0",
        "modelType": "linear_pairwise_ranker",
        "featureNames": ["score"],
        "weights": [1.0],
        "bias": 0.0,
        "normalization": {"score": {"mean": 0.0, "std": 1.0}},
    }


def write_json(path, value):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle)


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for item in rows:
            handle.write(json.dumps(item) + "\n")


class EvalRankerTest(unittest.TestCase):
    def test_topk_pairwise_and_action_type_metrics(self):
        rows = [
            row("g1", 1, 3, {"type": "Deploy", "operatorId": "A", "x": 1, "y": 1, "direction": "Right", "delay": 500}),
            row("g1", 0, 2, {"type": "End"}),
            row("g1", 0, 1, {"type": "SkillDaemon"}),
            row("g2", 0, 5, {"type": "End"}),
            row("g2", 0, 4, {"type": "SkillDaemon"}),
            row("g2", 1, 3, {"type": "End"}),
        ]
        ranked = evaluator.ranked_groups([evaluator.Row(str(r["group_id"]), int(r["label"]), r["features"], r["action"]) for r in rows], model())
        result = evaluator.evaluate_ranked(ranked, len(rows), model(), bad_limit=10)
        metrics = result["report"]["metrics"]

        self.assertEqual(metrics["top1"], 0.5)
        self.assertEqual(metrics["top3"], 1.0)
        self.assertEqual(metrics["medianPositiveRank"], 2.0)
        self.assertEqual(metrics["pairwiseAccuracy"], 0.5)
        self.assertEqual(result["report"]["byActionType"]["Deploy"]["top1"], 1.0)
        self.assertEqual(result["report"]["byActionType"]["End"]["top3"], 1.0)

    def test_positive_at_third_has_top3_but_not_top1(self):
        rows = [
            evaluator.Row("g", 0, {"score": 3}, {"type": "End"}),
            evaluator.Row("g", 0, {"score": 2}, {"type": "SkillDaemon"}),
            evaluator.Row("g", 1, {"score": 1}, {"type": "SkillUse"}),
        ]
        report = evaluator.evaluate_ranked(evaluator.ranked_groups(rows, model()), len(rows), model())["report"]

        self.assertEqual(report["metrics"]["top1"], 0.0)
        self.assertEqual(report["metrics"]["top3"], 1.0)

    def test_score_ties_do_not_prefer_positive_row_order(self):
        rows = [
            evaluator.Row("g", 1, {"score": 1}, {"type": "End"}),
            evaluator.Row("g", 0, {"score": 1}, {"type": "Deploy", "operatorId": "A", "x": 1, "y": 1, "direction": "Right", "delay": 0}),
        ]
        report = evaluator.evaluate_ranked(evaluator.ranked_groups(rows, model()), len(rows), model())["report"]

        self.assertEqual(report["metrics"]["top1"], 0.0)
        self.assertEqual(report["metrics"]["top3"], 1.0)

    def test_deploy_detail_metrics(self):
        rows = [
            evaluator.Row("g", 0, {"score": 4}, {"type": "Deploy", "operatorId": "B", "x": 9, "y": 9, "direction": "Left", "delay": 0}),
            evaluator.Row("g", 1, {"score": 3}, {"type": "Deploy", "operatorId": "A", "x": 1, "y": 2, "direction": "Right", "delay": 500}),
            evaluator.Row("g", 0, {"score": 2}, {"type": "Deploy", "operatorId": "A", "x": 8, "y": 8, "direction": "Down", "delay": 750}),
            evaluator.Row("g", 0, {"score": 1}, {"type": "Deploy", "operatorId": "C", "x": 1, "y": 2, "direction": "Down", "delay": 0}),
        ]
        deploy = evaluator.evaluate_ranked(evaluator.ranked_groups(rows, model()), len(rows), model())["report"]["deployMetrics"]

        self.assertEqual(deploy["position"]["top1"], 0.0)
        self.assertEqual(deploy["position"]["top3"], 1.0)
        self.assertEqual(deploy["operator"]["top1"], 0.0)
        self.assertEqual(deploy["direction"]["top3"], 1.0)
        self.assertEqual(deploy["delay"]["top3"], 1.0)
        self.assertEqual(deploy["operator"]["top3"], 1.0)

    def test_validator_rate_and_ablation_report(self):
        rows = [
            evaluator.Row("g", 1, {
                "score": 3,
                "action_type_deploy": 1,
                "is_legal_deploy_cell": 1,
                "is_tile_type_fit": 1,
                "position_prior": 0.9,
                "direction_prior": 0.8,
                "timing_prior": 0.7,
            }, {"type": "Deploy", "operatorId": "A", "x": 1, "y": 1, "direction": "None", "delay": 500}),
            evaluator.Row("g", 0, {
                "score": 2,
                "action_type_deploy": 1,
                "is_legal_deploy_cell": 1,
                "position_prior": 0.1,
                "direction_prior": 0.1,
            }, {"type": "Deploy", "operatorId": "B", "x": 2, "y": 1, "direction": "Side", "delay": 500}),
            evaluator.Row("g", 0, {"score": 1, "action_type_end": 1}, {"type": "End"}),
        ]

        self.assertTrue(evaluator.is_valid_action(rows[0].action))
        self.assertFalse(evaluator.is_valid_action(rows[1].action))
        validator = evaluator.validator_report(rows)
        ablation = evaluator.ablation_report(rows, model())

        self.assertEqual(validator["validatorPassRate"], 2 / 3)
        self.assertEqual(validator["positiveValidatorPassRate"], 1.0)
        self.assertEqual(ablation["ruleCoreProxy"]["metrics"]["top1"], 1.0)
        self.assertEqual(ablation["handwrittenScoring"]["metrics"]["top1"], 1.0)
        self.assertEqual(ablation["actionRanker"]["metrics"]["top1"], 1.0)

    def test_bad_cases_limit_and_output_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            model_path = os.path.join(tmp, "model.json")
            valid_path = os.path.join(tmp, "valid.jsonl")
            report_path = os.path.join(tmp, "eval_report.json")
            bad_path = os.path.join(tmp, "bad_cases.jsonl")
            write_json(model_path, model())
            write_jsonl(valid_path, [
                row("g1", 0, 3, {"type": "End"}),
                row("g1", 1, 1, {"type": "SkillDaemon"}),
                row("g2", 0, 3, {"type": "End"}),
                row("g2", 1, 1, {"type": "SkillDaemon"}),
            ])

            evaluator.main(["--model", model_path, "--valid", valid_path, "--out", report_path, "--badCases", bad_path, "--dumpBadCases", "1"])

            self.assertTrue(os.path.exists(report_path))
            with open(report_path, "r", encoding="utf-8") as handle:
                report = json.load(handle)
                self.assertEqual(report["groupCount"], 2)
                self.assertIn("validator", report)
                self.assertIn("ablation", report)
            with open(bad_path, "r", encoding="utf-8") as handle:
                bad_cases = [json.loads(line) for line in handle if line.strip()]
            self.assertEqual(len(bad_cases), 1)


if __name__ == "__main__":
    unittest.main()
