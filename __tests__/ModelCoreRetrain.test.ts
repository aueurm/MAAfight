import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const retrain = require("../scripts/model-core-retrain");
const dataset = require("../scripts/build-action-dataset");
const smoke = require("../scripts/model-core-smoke-test");

describe("model-core retrain", () => {
  it("parses retrain options with feedback defaults", () => {
    expect(retrain.parseArgs([
      "--input", "data/public",
      "--epochs", "2",
      "--seed", "7",
      "--simpleOnly",
      "--excludeStage", "main_01-07",
      "--excludeStage", "main_00-01",
    ])).toMatchObject({
      inputs: ["data/public"],
      rejectedSamples: "data/model-core/rejected_samples.jsonl",
      epochs: 2,
      seed: 7,
      simpleOnly: true,
      excludeStages: ["main_01-07", "main_00-01"],
    });
  });

  it("deduplicates operations before excluding stages and filtering simple maps", () => {
    const simpleFeature = {
      mapMatched: true,
      stageName: "main_00-01",
      resolvedStage: { stageId: "main_00-01" },
      retreatCount: 1,
      map: {
        bossTypeCount: 0,
        eliteTypeCount: 1,
        weightedHp: 300000,
        spawnCount: 70,
      },
    };
    const operations = [
      { id: 1, feature: simpleFeature, content: { stage_name: "main_00-01" } },
      { id: 1, feature: simpleFeature, content: { stage_name: "main_00-01" } },
      {
        id: 2,
        feature: { ...simpleFeature, stageName: "main_01-07", resolvedStage: { stageId: "main_01-07" } },
        content: { stage_name: "main_01-07" },
      },
      {
        id: 3,
        feature: { ...simpleFeature, map: { ...simpleFeature.map, bossTypeCount: 1 } },
        content: { stage_name: "main_00-02" },
      },
    ];

    const selected = dataset.selectOperations(operations, {
      simpleOnly: true,
      excludeStages: ["main_01-07"],
    });

    expect(selected.operations.map((operation: { id: number }) => operation.id)).toEqual([1]);
    expect(selected.stats).toEqual({ duplicateCount: 1, excludedStageCount: 1, nonSimpleCount: 1 });
    expect(dataset.isSimpleOperation(operations[0])).toBe(true);
    expect(dataset.isSimpleOperation(operations[3])).toBe(false);
  });

  it("forwards simple-stage and exclusion options to dataset construction", () => {
    const options = retrain.parseArgs([
      "--input", "data/public",
      "--simpleOnly",
      "--excludeStage", "main_01-07",
    ]);
    const args = retrain.buildDatasetArgs(options, "data/out", "data/rejected.jsonl", false);

    expect(args).toEqual(expect.arrayContaining(["--simpleOnly", "--excludeStage", "main_01-07"]));
  });

  it("runs dataset build, linear training, and eval with rejected samples", () => {
    const root = path.resolve(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-retrain-"));
    const corpusDir = path.join(tmp, "corpus-input", "corpus");
    const dataOut = path.join(tmp, "dataset");
    const modelOut = path.join(tmp, "model.json");
    const evalOut = path.join(tmp, "eval.json");
    const rejectedPath = path.join(tmp, "rejected.jsonl");

    try {
      fs.mkdirSync(corpusDir, { recursive: true });
      fs.writeFileSync(path.join(corpusDir, "1.json"), JSON.stringify(smoke.fixtureCopilot()), "utf8");
      fs.writeFileSync(path.join(tmp, "corpus-input", "features.json"), JSON.stringify([smoke.fixtureFeature()]), "utf8");
      fs.writeFileSync(rejectedPath, `${JSON.stringify({
        stageId: "TEST-SMOKE",
        stageHash: "stage",
        rosterHash: "roster",
        engineVersion: "cpu-core-v0",
        scriptHash: "failed",
        fingerprint: {},
        actions: [{ type: "Deploy", operatorId: "B", x: 3, y: 1, direction: "Down", delay: 0 }],
      })}\n`, "utf8");
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      cp.execFileSync(process.execPath, [
        "scripts/model-core-retrain.js",
        "--input", path.join(tmp, "corpus-input"),
        "--dataOut", dataOut,
        "--modelOut", modelOut,
        "--evalOut", evalOut,
        "--rejectedSamples", rejectedPath,
        "--negativeCount", "4",
        "--validRatio", "0",
        "--epochs", "1",
        "--seed", "42",
      ], { cwd: root, stdio: "pipe" });

      expect(fs.existsSync(path.join(dataOut, "train.jsonl"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(modelOut, "utf8")).modelType).toBe("linear_pairwise_ranker");
      expect(JSON.parse(fs.readFileSync(evalOut, "utf8")).metrics.top5).toBeGreaterThanOrEqual(0);
      expect(fs.existsSync(path.join(path.dirname(evalOut), "bad_cases.jsonl"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("builds the dataset when the optional rejected samples file is missing", () => {
    const root = path.resolve(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-missing-rejected-"));
    const corpusDir = path.join(tmp, "corpus-input", "corpus");
    const dataOut = path.join(tmp, "dataset");

    try {
      fs.mkdirSync(corpusDir, { recursive: true });
      fs.writeFileSync(path.join(corpusDir, "1.json"), JSON.stringify(smoke.fixtureCopilot()), "utf8");
      fs.writeFileSync(path.join(tmp, "corpus-input", "features.json"), JSON.stringify([smoke.fixtureFeature()]), "utf8");
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      const output = cp.execFileSync(process.execPath, [
        "scripts/build-action-dataset.js",
        "--input", path.join(tmp, "corpus-input"),
        "--out", dataOut,
        "--negativeCount", "2",
        "--validRatio", "0",
        "--rejectedSamples", path.join(tmp, "missing-rejected.jsonl"),
      ], { cwd: root, encoding: "utf8" });
      const summary = JSON.parse(output);

      expect(summary.rejectedSampleCount).toBe(0);
      expect(fs.existsSync(path.join(dataOut, "train.jsonl"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
