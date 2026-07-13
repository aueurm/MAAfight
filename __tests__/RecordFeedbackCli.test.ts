import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const recordFeedback = require("../scripts/record-feedback");

function copilot() {
  return {
    stage_name: "TEST-FEEDBACK",
    minimum_required: "v6.0.0",
    doc: { title: "test", details: "" },
    opers: [{ name: "A" }],
    groups: [],
    version: 3,
    actions: [{ type: "Deploy", name: "A", location: [1, 1], direction: "Right" }],
  };
}

describe("record-feedback CLI", () => {
  it("parses rehearsal boolean options", () => {
    expect(recordFeedback.parseArgs([
      "--stageHash", "stage",
      "--rosterHash", "roster",
      "--script", "script.json",
      "--result", "failure",
      "--entered", "true",
      "--completed", "false",
      "--threeStar", "false",
    ])).toMatchObject({ enteredBattle: true, completed: false, threeStar: false });
    expect(() => recordFeedback.parseBoolean("maybe")).toThrow("Expected boolean value");
  });

  it("defaults direct rule-core feedback to the rule baseline version", () => {
    expect(recordFeedback.defaultEngineVersion(recordFeedback.parseArgs(["--core", "rule-core"]))).toBe("v2-skill-v1");
    expect(recordFeedback.defaultEngineVersion(recordFeedback.parseArgs([]))).toBe("cpu-core-v0");
  });

  it("rejects unknown core names", () => {
    expect(() => recordFeedback.main(["--core", "typo"])).toThrow("--core must be rule-core or model-core");
  });

  it("writes structured rehearsal feedback and rejected samples", () => {
    const root = path.resolve(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-record-feedback-"));
    const scriptPath = path.join(tmp, "script.json");
    const feedbackPath = path.join(tmp, "feedback.jsonl");
    const rejectedPath = path.join(tmp, "rejected.jsonl");

    try {
      fs.writeFileSync(scriptPath, JSON.stringify(copilot()), "utf8");
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      const output = cp.execFileSync(process.execPath, [
        "scripts/record-feedback.js",
        "--stageHash", "stage",
        "--rosterHash", "roster",
        "--script", scriptPath,
        "--result", "failure",
        "--entered", "true",
        "--completed", "false",
        "--threeStar", "false",
        "--feedbackFile", feedbackPath,
        "--rejectedOut", rejectedPath,
      ], { cwd: root, stdio: "pipe", encoding: "utf8" });
      const summary = JSON.parse(output);
      const feedback = fs.readFileSync(feedbackPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
      const rejected = fs.readFileSync(rejectedPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));

      expect(summary).toMatchObject({
        result: "failure",
        rehearsal: { enteredBattle: true, completed: false, threeStar: false },
        firstThreeDeploys: ["A@1,1:Right"],
        deployCells: ["1,1"],
        directions: ["Right"],
        delayBuckets: [0, 0],
        rejectedCount: 1,
      });
      expect(feedback[0].rehearsal).toEqual({ enteredBattle: true, completed: false, threeStar: false });
      expect(rejected[0].rehearsal).toEqual({ enteredBattle: true, completed: false, threeStar: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exports rejected samples to the default model-core path for failures", () => {
    const root = path.resolve(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-record-feedback-default-"));
    const scriptPath = path.join(tmp, "script.json");

    try {
      fs.writeFileSync(scriptPath, JSON.stringify(copilot()), "utf8");
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      const output = cp.execFileSync(process.execPath, [
        path.join(root, "scripts/record-feedback.js"),
        "--stageHash", "stage",
        "--rosterHash", "roster",
        "--script", scriptPath,
        "--result", "failure",
      ], { cwd: tmp, stdio: "pipe", encoding: "utf8" });
      const summary = JSON.parse(output);
      const rejectedPath = path.join(tmp, "data", "model-core", "rejected_samples.jsonl");

      expect(summary.rejectedOut).toBe(path.join("data", "model-core", "rejected_samples.jsonl"));
      expect(fs.existsSync(rejectedPath)).toBe(true);
      expect(fs.readFileSync(rejectedPath, "utf8")).toContain("\"stageHash\":\"stage\"");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("can record feedback directly from a shadow report", () => {
    const root = path.resolve(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-record-feedback-shadow-"));
    const scriptPath = path.join(tmp, "model.json");
    const feedbackPath = path.join(tmp, "feedback.jsonl");
    const rejectedPath = path.join(tmp, "rejected.jsonl");
    const shadowPath = path.join(tmp, "shadow-report.json");

    try {
      fs.writeFileSync(scriptPath, JSON.stringify(copilot()), "utf8");
      fs.writeFileSync(shadowPath, JSON.stringify({
        selectedCore: "model-core",
        context: {
          stageHash: "stage-from-shadow",
          rosterHash: "roster-from-shadow",
          modelEngineVersion: "cpu-core-v0",
          ruleEngineVersion: "v2-skill-v1",
        },
        paths: { modelCore: scriptPath },
      }), "utf8");
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      const output = cp.execFileSync(process.execPath, [
        "scripts/record-feedback.js",
        "--shadowReport", shadowPath,
        "--core", "model-core",
        "--result", "failure",
        "--feedbackFile", feedbackPath,
        "--rejectedOut", rejectedPath,
      ], { cwd: root, stdio: "pipe", encoding: "utf8" });
      const summary = JSON.parse(output);
      const feedback = fs.readFileSync(feedbackPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));

      expect(summary).toMatchObject({
        stageHash: "stage-from-shadow",
        rosterHash: "roster-from-shadow",
        engineVersion: "cpu-core-v0",
        sourceCore: "model-core",
      });
      expect(feedback[0]).toMatchObject({ stageHash: "stage-from-shadow", rosterHash: "roster-from-shadow" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("defaults rule-core shadow feedback to the rule baseline version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-record-feedback-rule-version-"));
    const shadowPath = path.join(tmp, "shadow-report.json");

    try {
      fs.writeFileSync(shadowPath, JSON.stringify({
        selectedCore: "rule-core",
        context: {
          stageHash: "stage-from-shadow",
          rosterHash: "roster-from-shadow",
        },
        paths: { ruleCore: "rule.json" },
      }), "utf8");

      expect(recordFeedback.applyShadowReport(recordFeedback.parseArgs([
        "--shadowReport", shadowPath,
        "--core", "rule-core",
        "--result", "success",
      ])).engineVersion).toBe("v2-skill-v1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails clearly when shadow report lacks feedback context", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-record-feedback-shadow-missing-"));
    const shadowPath = path.join(tmp, "shadow-report.json");

    try {
      fs.writeFileSync(shadowPath, JSON.stringify({
        selectedCore: "model-core",
        context: {},
        paths: {},
      }), "utf8");

      expect(() => recordFeedback.main([
        "--shadowReport", shadowPath,
        "--core", "model-core",
        "--result", "failure",
      ])).toThrow("Missing required feedback fields after applying --shadowReport: stageHash, rosterHash, script");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
