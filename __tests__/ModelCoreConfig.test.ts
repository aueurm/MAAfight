import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const generateScript = require("../scripts/generate-script");
const { modelRosterFeatures, placeSkillDaemonLast, selectGeneratedOperators } = require("../src/model-core/appGenerator");

describe("model-core config", () => {
  it("places SkillDaemon after every finite action", () => {
    expect(placeSkillDaemonLast([
      { type: "Deploy", name: "A" },
      { type: "SkillDaemon" },
      { type: "Deploy", name: "B" },
      { type: "SkillDaemon" },
    ])).toEqual([
      { type: "Deploy", name: "A" },
      { type: "Deploy", name: "B" },
      { type: "SkillDaemon" },
    ]);
  });

  it("uses all owned E2 players and prioritizes referenced operators", () => {
    const players = new Map([
      ["阿米娅", { id: "char_002_amiya", name: "阿米娅", own: true, elite: 2, level: 60, rarity: 5, potential: 1 }],
      ["银灰", { id: "char_172_svrash", name: "银灰", own: true, elite: 2, level: 60, rarity: 6, potential: 1 }],
      ["12F", { id: "char_009_12fce", name: "12F", own: true, elite: 0, level: 30, rarity: 2, potential: 6 }],
    ]);
    const roster = modelRosterFeatures({ opers: [{ name: "阿米娅", skill: 3, skill_usage: 1 }] }, players);
    const opers = selectGeneratedOperators(
      [{ name: "阿米娅", skill: 3, skill_usage: 1 }],
      [{ type: "Deploy", name: "银灰" }, { type: "Skill", name: "银灰" }, { type: "SkillDaemon" }],
    );

    expect(roster.map((operator: { operatorId: string }) => operator.operatorId)).toEqual(["阿米娅", "银灰"]);
    expect(opers).toEqual([{ name: "银灰", skill: 1, skill_usage: 1 }, { name: "阿米娅", skill: 3, skill_usage: 1 }]);
  });

  it("loads default config file", () => {
    const config = generateScript.loadModelCoreConfig("configs/model-core.json");

    expect(config.delayBuckets).toEqual([0, 250, 500, 750, 1000, 1500, 3000, 5000]);
    expect(config.beamSearch).toMatchObject({ beamSize: 8, topActionsPerState: 16, maxSteps: 16, candidateActionsPerState: 500 });
  });

  it("uses defaults when config is missing and lets CLI override config", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-model-core-config-"));
    const configPath = path.join(cwd, "model-core.json");
    fs.writeFileSync(configPath, JSON.stringify({
      beamSearch: {
        beamSize: 12,
        topActionsPerState: 24,
        maxSteps: 17,
        candidateActionsPerState: 700,
      },
    }), "utf8");

    try {
      expect(generateScript.parseArgs(["--stage", "S", "--roster", "r.json", "--out", "o.json"])).toMatchObject({
        beamSize: 8,
        topActionsPerState: 16,
        maxSteps: 16,
        candidateActionsPerState: 500,
      });
      expect(generateScript.parseArgs(["--config", configPath, "--stage", "S", "--roster", "r.json", "--out", "o.json"])).toMatchObject({
        beamSize: 12,
        topActionsPerState: 24,
        maxSteps: 17,
        candidateActionsPerState: 700,
      });
      expect(generateScript.parseArgs(["--config", configPath, "--beamSize", "4", "--stage", "S", "--roster", "r.json", "--out", "o.json"])).toMatchObject({
        beamSize: 4,
        topActionsPerState: 24,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("excludes unavailable operators from generation roster", () => {
    const options = generateScript.parseArgs([
      "--stage", "S",
      "--roster", "r.json",
      "--out", "o.json",
      "--excludeOperator", "圣聆初雪",
      "--excludeOperators", "A,B",
    ]);
    const filtered = generateScript.filterExcludedRoster([
      { operatorId: "圣聆初雪", name: "圣聆初雪" },
      { operatorId: "A", name: "A" },
      { operatorId: "C", name: "C" },
    ], options.excludeOperators);

    expect(options.excludeOperators).toEqual(["圣聆初雪", "A", "B"]);
    expect(filtered).toEqual([{ operatorId: "C", name: "C" }]);
  });

  it("generate CLI reuses successful feedback when useFeedback is enabled", () => {
    const root = path.resolve(__dirname, "..");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-model-core-feedback-cli-"));
    const rosterPath = path.join(cwd, "roster.json");
    const feedbackPath = path.join(cwd, "feedback.jsonl");
    const outputPath = path.join(cwd, "generated.json");

    try {
      fs.writeFileSync(rosterPath, JSON.stringify({
        stageFeatures: {
          stageId: "TEST-FEEDBACK",
          rows: 3,
          cols: 3,
          deploymentPoints: [{ x: 1, y: 1, buildableType: "all" }],
        },
        rosterFeatures: [{ operatorId: "A", name: "A" }],
      }), "utf8");
      fs.writeFileSync(feedbackPath, `${JSON.stringify({
        stageHash: "stage-hash",
        rosterHash: "roster-hash",
        engineVersion: "cpu-core-v0",
        scriptHash: "success-script",
        result: "success",
        timestamp: "2026-07-06T00:00:00.000Z",
        script: {
          stageId: "TEST-FEEDBACK",
          actions: [{ type: "SkillDaemon", delay: 0 }, { type: "End", delay: 0 }],
        },
      })}\n`, "utf8");
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      const summary = JSON.parse(cp.execFileSync(process.execPath, [
        "scripts/generate-script.js",
        "--stage", "TEST-FEEDBACK",
        "--roster", rosterPath,
        "--out", outputPath,
        "--useFeedback", "true",
        "--feedbackFile", feedbackPath,
        "--stageHash", "stage-hash",
        "--rosterHash", "roster-hash",
      ], { cwd: root, encoding: "utf8" }));
      const generated = JSON.parse(fs.readFileSync(outputPath, "utf8"));

      expect(summary.reused).toBe(true);
      expect(summary.feedbackRecords).toBe(1);
      expect(generated.actions).toEqual([{ type: "SkillDaemon" }]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("generate CLI writes beam and candidate debug dumps", () => {
    const root = path.resolve(__dirname, "..");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-model-core-dumps-"));
    const rosterPath = path.join(cwd, "roster.json");
    const outputPath = path.join(cwd, "generated.json");
    const beamsPath = path.join(cwd, "beams.json");
    const candidatesPath = path.join(cwd, "candidates.jsonl");

    try {
      fs.writeFileSync(rosterPath, JSON.stringify({
        stageFeatures: {
          stageId: "TEST-DUMPS",
          rows: 3,
          cols: 3,
          deploymentPoints: [{ x: 1, y: 1, buildableType: "all" }],
        },
        rosterFeatures: [{ operatorId: "A", name: "A" }],
      }), "utf8");
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      const summary = JSON.parse(cp.execFileSync(process.execPath, [
        "scripts/generate-script.js",
        "--stage", "TEST-DUMPS",
        "--roster", rosterPath,
        "--out", outputPath,
        "--beamSize", "4",
        "--topActionsPerState", "8",
        "--maxSteps", "2",
        "--candidateActionsPerState", "12",
        "--dumpBeams", beamsPath,
        "--dumpCandidates", candidatesPath,
      ], { cwd: root, encoding: "utf8" }));
      const beams = JSON.parse(fs.readFileSync(beamsPath, "utf8"));
      const candidates = fs.readFileSync(candidatesPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

      expect(summary.validationPassed).toBe(true);
      expect(beams.length).toBeGreaterThan(0);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]).toHaveProperty("featureSummary");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
