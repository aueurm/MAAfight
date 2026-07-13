import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compareShadowScripts, summarizeShadowScript } from "../src/model-core/shadowCore";
import { copilotJsonToBattleDsl } from "../src/model-core/battleDsl";
import { hashBattleScript } from "../src/model-core/modelCoreFeedback";
import type { BattleScript } from "../src/types";

function script(stageName = "TEST-SHADOW", direction = "Right"): BattleScript {
  return {
    stage_name: stageName,
    minimum_required: "v6.0.0",
    doc: { title: stageName, details: "" },
    opers: [{ name: "A" }, { name: "B" }],
    groups: [],
    version: 3,
    generatedAt: "2026-07-06T00:00:00.000Z",
    metadata: { source: "test" },
    actions: [
      { type: "Deploy", name: "A", location: [1, 1], direction },
      { type: "Deploy", name: "B", location: [2, 1], direction: "None" },
      { type: "SkillDaemon" },
    ],
  };
}

describe("model-core shadow compare", () => {
  it("summarizes validation, first deploys, cells, and directions", () => {
    const summary = summarizeShadowScript("model-core", script());

    expect(summary.validationPassed).toBe(true);
    expect(summary.scriptHash).toBe(hashBattleScript(copilotJsonToBattleDsl(script())));
    expect(summary.actionCount).toBe(3);
    expect(summary.firstThree).toEqual(["A@1,1:Right", "B@2,1:None"]);
    expect(summary.deployCells).toEqual(["1,1", "2,1"]);
    expect(summary.directions).toEqual(["Right", "None"]);
  });

  it("keeps rule-core in hybrid shadow unless rule-core fails validation", () => {
    const validRule = script("TEST-SHADOW", "Left");
    const validModel = script("TEST-SHADOW", "Right");
    const invalidRule = script("");

    expect(compareShadowScripts({ mode: "hybrid-core", ruleScript: validRule, modelScript: validModel }).selectedCore).toBe("rule-core");
    expect(compareShadowScripts({ mode: "hybrid-core", ruleScript: invalidRule, modelScript: validModel }).selectedCore).toBe("model-core");
  });

  it("CLI writes a comparison report from existing rule and model scripts", () => {
    const root = path.resolve(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-shadow-"));
    const rulePath = path.join(tmp, "rule.json");
    const modelPath = path.join(tmp, "model.json");
    const rosterPath = path.join(tmp, "roster.json");

    try {
      fs.writeFileSync(rulePath, `${JSON.stringify(script("TEST-SHADOW", "Left"))}\n`, "utf8");
      fs.writeFileSync(modelPath, `${JSON.stringify(script("TEST-SHADOW", "Right"))}\n`, "utf8");
      fs.writeFileSync(rosterPath, JSON.stringify({
        stageFeatures: { stageId: "TEST-SHADOW", rows: 3, cols: 3, deploymentPoints: [{ x: 1, y: 1 }] },
        rosterFeatures: [{ operatorId: "A", name: "A" }, { operatorId: "B", name: "B" }],
      }), "utf8");
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      cp.execFileSync(process.execPath, [
        "scripts/model-core-shadow.js",
        "--mode", "hybrid-core",
        "--stage", "TEST-SHADOW",
        "--roster", rosterPath,
        "--rule", rulePath,
        "--modelScript", modelPath,
        "--outDir", tmp,
      ], { cwd: root, stdio: "pipe" });

      const reportPath = path.join(tmp, "shadow-report-TEST-SHADOW.json");
      const selectedPath = path.join(tmp, "selected-TEST-SHADOW.json");
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      const selected = JSON.parse(fs.readFileSync(selectedPath, "utf8"));
      expect(report.selectedCore).toBe("rule-core");
      expect(report.ruleCore.scriptHash).toBe(hashBattleScript(copilotJsonToBattleDsl(script("TEST-SHADOW", "Left"))));
      expect(report.ruleCore.firstThree[0]).toBe("A@1,1:Left");
      expect(report.modelCore.firstThree[0]).toBe("A@1,1:Right");
      expect(report.context).toMatchObject({ modelEngineVersion: "cpu-core-v0", ruleEngineVersion: "v2-skill-v1" });
      expect(report.context.stageHash).toMatch(/^[a-f0-9]{64}$/);
      expect(report.context.rosterHash).toMatch(/^[a-f0-9]{64}$/);
      expect(report.paths.selected).toBe(path.resolve(selectedPath));
      expect(selected.actions[0].direction).toBe("Left");

      const modelOnlyReportPath = path.join(tmp, "model-only-report.json");
      const modelOnlySelectedPath = path.join(tmp, "model-only-selected.json");
      cp.execFileSync(process.execPath, [
        "scripts/model-core-shadow.js",
        "--mode", "model-core",
        "--stage", "TEST-SHADOW",
        "--roster", rosterPath,
        "--modelScript", modelPath,
        "--outDir", tmp,
        "--report", modelOnlyReportPath,
        "--selectedOut", modelOnlySelectedPath,
      ], { cwd: root, stdio: "pipe" });
      const modelOnlyReport = JSON.parse(fs.readFileSync(modelOnlyReportPath, "utf8"));
      const modelOnlySelected = JSON.parse(fs.readFileSync(modelOnlySelectedPath, "utf8"));

      expect(modelOnlyReport.selectedCore).toBe("model-core");
      expect(modelOnlyReport.ruleCore).toBeUndefined();
      expect(modelOnlySelected.actions[0].direction).toBe("Right");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
