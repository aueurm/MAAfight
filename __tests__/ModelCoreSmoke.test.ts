import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.setTimeout(120000);

describe("model-core smoke test", () => {
  it("runs the toy end-to-end pipeline and writes parseable output", () => {
    const root = path.resolve(__dirname, "..");
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-model-core-smoke-test-"));

    try {
      cp.execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { cwd: root, stdio: "pipe" });
      const output = cp.execFileSync(process.execPath, ["scripts/model-core-smoke-test.js", "--workDir", workDir, "--skipBuild"], {
        cwd: root,
        stdio: "pipe",
        encoding: "utf8",
      });
      const summary = JSON.parse(output);

      expect(summary).toMatchObject({
        battleDsl: true,
        modelExists: true,
        generatedExists: true,
        validationPassed: true,
      });
      expect(summary.candidateCount).toBeGreaterThan(0);
      expect(summary.sampleCount).toBeGreaterThan(0);
      expect(summary.trainRowCount).toBeGreaterThan(0);
      expect(summary.rejectedSampleCount).toBe(1);
      expect(summary.stageHash).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.rosterHash).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.engineVersion).toBe("cpu-core-v0");
      expect(fs.existsSync(path.join(workDir, "generated.json"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(workDir, "generated.json"), "utf8")).actions.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
