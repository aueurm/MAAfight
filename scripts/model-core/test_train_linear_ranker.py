import importlib.util
import json
import os
import sys
import tempfile
import unittest


SCRIPT_PATH = os.path.join(os.path.dirname(__file__), "train_linear_ranker.py")
SPEC = importlib.util.spec_from_file_location("train_linear_ranker", SCRIPT_PATH)
trainer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = trainer
SPEC.loader.exec_module(trainer)


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def toy_rows():
    rows = []
    for group in range(8):
      rows.append({"group_id": f"g{group}", "label": 1, "features": {"good": 1, "bad": 0}, "action": {"type": "Deploy"}})
      rows.append({"group_id": f"g{group}", "label": 0, "features": {"good": 0, "bad": 1}, "action": {"type": "End"}})
      rows.append({"group_id": f"g{group}", "label": 0, "features": {"good": 0.1, "bad": 0.8}, "action": {"type": "SkillDaemon"}})
    return rows


class TrainLinearRankerTest(unittest.TestCase):
    def test_read_jsonl_and_group_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "train.jsonl")
            write_jsonl(path, toy_rows())
            rows = trainer.read_jsonl(path)
            groups = trainer.group_rows(rows)

            self.assertEqual(len(rows), 24)
            self.assertEqual(len(groups), 8)
            positive, negatives = groups["g0"]
            self.assertEqual(positive.label, 1)
            self.assertEqual(len(negatives), 2)

    def test_loss_decreases_on_toy_dataset_and_seed_is_stable(self):
        rows = [trainer.Row(str(row["group_id"]), int(row["label"]), row["features"], row["action"]) for row in toy_rows()]
        left = trainer.train_model(rows, rows, epochs=4, lr=0.2, l2=0.0, seed=7)
        right = trainer.train_model(rows, rows, epochs=4, lr=0.2, l2=0.0, seed=7)

        self.assertLess(left["history"][-1]["loss"], left["history"][0]["loss"])
        self.assertEqual(left["weights"], right["weights"])
        self.assertGreaterEqual(left["metrics"]["valid_top1_accuracy"], 1.0)

    def test_group_weights_balance_skill_actions_without_overweighting_retreat(self):
        rows = [
            trainer.Row("deploy-1", 1, {"x": 1}, {"type": "Deploy"}),
            trainer.Row("deploy-1", 0, {"x": 0}, {"type": "End"}),
            trainer.Row("deploy-2", 1, {"x": 1}, {"type": "Deploy"}),
            trainer.Row("deploy-2", 0, {"x": 0}, {"type": "End"}),
            trainer.Row("skill-1", 1, {"x": 1}, {"type": "SkillUse"}),
            trainer.Row("skill-1", 0, {"x": 0}, {"type": "End"}),
            trainer.Row("skill-1", 0, {"x": 0.2}, {"type": "Deploy"}),
            trainer.Row("skill-1", 0, {"x": 0.3}, {"type": "Retreat"}),
        ]
        groups = trainer.group_rows(rows)
        weights = trainer.balanced_group_weights(groups)

        self.assertEqual(weights["deploy-1"], 1.0)
        self.assertEqual(weights["deploy-2"], 1.0)
        self.assertGreater(weights["skill-1"], 1.0)
        self.assertLess(weights["skill-1"], weights["deploy-1"] + weights["deploy-2"])
        self.assertAlmostEqual(weights["skill-1"] / len(groups["skill-1"][1]), weights["skill-1"] / 3)

    def test_operator_priors_are_learned_only_from_positive_deploys(self):
        rows = [
            trainer.Row("a1", 1, {"operator_public_usage_prior": 0}, {"type": "Deploy", "operatorId": "A"}),
            trainer.Row("a2", 1, {"operator_public_usage_prior": 0}, {"type": "Deploy", "operatorId": "A"}),
            trainer.Row("b1", 1, {"operator_public_usage_prior": 0}, {"type": "Deploy", "operatorId": "B"}),
            trainer.Row("n1", 0, {"operator_public_usage_prior": 0}, {"type": "Deploy", "operatorId": "C"}),
        ]

        priors = trainer.operator_public_usage_priors(rows)

        self.assertEqual(priors["A"], 1.0)
        self.assertGreater(priors["A"], priors["B"])
        self.assertNotIn("C", priors)

    def test_model_json_can_be_written_and_metrics_computed(self):
        with tempfile.TemporaryDirectory() as tmp:
            train_path = os.path.join(tmp, "train.jsonl")
            valid_path = os.path.join(tmp, "valid.jsonl")
            out_path = os.path.join(tmp, "model.json")
            write_jsonl(train_path, toy_rows())
            write_jsonl(valid_path, toy_rows())

            model = trainer.main(["--train", train_path, "--valid", valid_path, "--out", out_path, "--epochs", "2", "--lr", "0.1", "--seed", "3"])

            self.assertTrue(os.path.exists(out_path))
            with open(out_path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            self.assertEqual(loaded["modelType"], "linear_pairwise_ranker")
            self.assertEqual(loaded["featureNames"], model["featureNames"])
            self.assertIn("valid_top3_recall", loaded["metrics"])
            self.assertEqual(loaded["trainConfig"]["balanceSkillActions"], "sqrt_inverse_frequency")
            self.assertEqual(loaded["trainConfig"]["bestEpoch"], 1)

    def test_non_numeric_features_raise_with_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.jsonl")
            write_jsonl(path, [{"group_id": "g", "label": 1, "features": {"x": "bad"}, "action": {}}])

            with self.assertRaisesRegex(ValueError, "Non-numeric feature"):
                trainer.read_jsonl(path)


if __name__ == "__main__":
    unittest.main()
