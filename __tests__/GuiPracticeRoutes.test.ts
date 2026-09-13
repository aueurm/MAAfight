import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fastify, { type FastifyInstance } from "fastify";
import { registerGuiRoutes } from "../src/gui/routes";
import { computeScriptHash } from "../src/engine";
import { exportToCopilotFormat } from "../src/copilot/ScriptExporter";
import { FeedbackStore } from "../src/feedback/FeedbackStore";
import * as screenObserver from "../src/runner/screenObserver";
import * as logger from "../src/runtime/logger";
import type { BattleScript } from "../src/types";

const childProcess = require("child_process") as typeof import("child_process");

function candidate(): BattleScript {
  return {
    version: 3,
    stage_name: "GT-1",
    minimum_required: "v6.0.0",
    doc: { title: "GT-1", details: "Internal candidate; not rehearsal-verified." },
    opers: [{ name: "芬", skill: 1, skill_usage: 1 }],
    groups: [],
    actions: [{ type: "Deploy", name: "芬", location: [1, 2], direction: "Right" }, { type: "SkillDaemon" }],
    metadata: { source: "maafight-deepseek-core" },
    generatedAt: "2026-09-12T00:00:00.000Z",
  };
}

describe("GUI practice execution identity", () => {
  let cwd: string;
  let app: FastifyInstance;
  let candidatePath: string;
  let outputPath: string;
  let originalJson: string;
  let scriptHash: string;
  let runPath: string;
  let executedJson: string;
  let beforeRead: (() => void) | undefined;
  let afterRead: (() => void) | undefined;
  let spawn: jest.SpyInstance;
  let observer: jest.SpyInstance;
  let feedback: jest.SpyInstance;

  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-practice-"));
    candidatePath = path.join(cwd, "output", ".candidates", "GT-1.json");
    outputPath = path.join(cwd, "output", "GT-1.json");
    const script = candidate();
    scriptHash = computeScriptHash(script);
    script.metadata.scriptHash = scriptHash;
    originalJson = exportToCopilotFormat(script);
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, originalJson, "utf8");
    beforeRead = undefined;
    afterRead = undefined;
    runPath = "";
    executedJson = "";
    jest.spyOn(logger, "writeGuiLog").mockImplementation(() => undefined);
    feedback = jest.spyOn(FeedbackStore.prototype, "recordPracticeTestResult").mockReturnValue(null);
    observer = jest.spyOn(screenObserver, "observeMaaScreen").mockReturnValue({
      width: 1280, height: 720, recognized: true, outcome: "clear", stars: 3, samples: [],
      debugSamplesPath: "samples.json", message: "Observed three-star settlement", warnings: [],
    });
    spawn = jest.spyOn(childProcess, "spawn").mockImplementation((_command, args) => {
      const argumentsList = args as string[];
      runPath = argumentsList[argumentsList.indexOf("-ScriptPath") + 1];
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => {
        beforeRead?.();
        executedJson = fs.readFileSync(runPath, "utf8");
        afterRead?.();
        child.stdout.emit("data", JSON.stringify({ ok: true, stage: "GT-1", copilotTaskId: 17, scriptPath: runPath, navigationSkipped: true }));
        child.emit("close", 0);
      });
      return child as unknown as ChildProcess;
    });
    app = fastify({ logger: false });
    await registerGuiRoutes(app, { configCwd: cwd, openDir: async () => undefined });
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function enter(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST", url: "/api/enter-practice",
      payload: { stage: "GT-1", scriptPath: candidatePath, scriptHash, ...overrides },
    });
  }

  it("runs a private snapshot and publishes unchanged content with its actual generated hash", async () => {
    const response = await enter();
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.result).toMatchObject({ testResult: "三星", originalScriptPath: candidatePath, scriptHash, publishedOutputPath: outputPath });
    expect(runPath).not.toBe(candidatePath);
    expect(path.dirname(runPath)).toBe(path.join(cwd, ".maafight", "copilot-run"));
    expect(executedJson).toBe(originalJson);
    expect(fs.readFileSync(candidatePath, "utf8")).toBe(originalJson);
    const published = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(published.actions).toEqual(JSON.parse(originalJson).actions);
    expect(published.actions[0].location).toEqual([2, 1]);
    expect(published.doc.details).toBe("Three-star rehearsal verified.");
    expect(feedback).toHaveBeenCalledWith({ scriptHash, testResult: "三星", currentOperatorBoxHash: "default-loadout" });
  });

  it("rejects an unrelated request hash before starting a rehearsal", async () => {
    const response = await enter({ scriptHash: "unrelated-script-hash" });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors.join("\n")).toContain("scriptHash does not match");
    expect(spawn).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("refuses to publish a replaced candidate and attributes the result only to the executed snapshot", async () => {
    const replacement = JSON.parse(originalJson);
    replacement.stage_name = "OF-1";
    replacement.actions = [{ type: "Output", doc: "never executed" }];
    const replacedJson = JSON.stringify(replacement);
    beforeRead = () => fs.writeFileSync(candidatePath, replacedJson, "utf8");

    const response = await enter();
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(executedJson).toBe(originalJson);
    expect(fs.readFileSync(candidatePath, "utf8")).toBe(replacedJson);
    expect(body.result.testResult).toBe("三星");
    expect(body.result.publishedOutputPath).toBeUndefined();
    expect(body.warnings.join("\n")).toContain("Candidate changed during rehearsal");
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ scriptHash, testResult: "三星" }));
  });

  it("keeps executing the snapshot when the source is changed and then restored during the run", async () => {
    const replacement = JSON.parse(originalJson);
    replacement.actions = [{ type: "Output", doc: "temporary replacement" }];
    beforeRead = () => fs.writeFileSync(candidatePath, JSON.stringify(replacement), "utf8");
    afterRead = () => fs.writeFileSync(candidatePath, originalJson, "utf8");

    const response = await enter();

    expect(response.statusCode).toBe(200);
    expect(executedJson).toBe(originalJson);
    expect(response.json().result.publishedOutputPath).toBe(outputPath);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8")).actions).toEqual(JSON.parse(originalJson).actions);
  });

  it("computes feedback identity even when the caller omits scriptHash", async () => {
    const response = await enter({ scriptHash: undefined });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.scriptHash).toBe(scriptHash);
    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ scriptHash }));
  });

  it("rejects a stage different from the script before starting a rehearsal", async () => {
    const response = await enter({ stage: "OF-1" });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors.join("\n")).toContain("does not match requested stage");
    expect(spawn).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  });

  it("accepts an internal stage identifier that resolves to the script's official code", async () => {
    const response = await enter({ stage: "a001_01" });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.publishedOutputPath).toBe(outputPath);
  });

  it("rejects a changed private snapshot before observing or recording a result", async () => {
    afterRead = () => fs.writeFileSync(runPath, JSON.stringify({ stage_name: "GT-1", actions: [] }), "utf8");

    const response = await enter();

    expect(response.statusCode).toBe(400);
    expect(response.json().errors.join("\n")).toContain("Rehearsal snapshot changed");
    expect(observer).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it.each(["failed", "unknown"] as const)("does not publish a %s observation", async outcome => {
    observer.mockReturnValue({ outcome, stars: outcome === "failed" ? 0 : undefined, recognized: outcome === "failed", warnings: [] });

    const response = await enter();

    expect(response.statusCode).toBe(200);
    expect(response.json().result.publishedOutputPath).toBeUndefined();
    expect(fs.existsSync(outputPath)).toBe(false);
    if (outcome === "unknown") expect(feedback).not.toHaveBeenCalled();
    else expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ scriptHash, testResult: "失败" }));
  });
});
