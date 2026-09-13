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
import type { EmulatorStartupStatus } from "../src/shared/emulatorStartup";
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

function pendingChild(pid?: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(() => true),
  });
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
  let emulatorStatus: EmulatorStartupStatus;
  let getEmulatorStatus: jest.Mock<EmulatorStartupStatus, []>;

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
    emulatorStatus = { state: "skipped" };
    getEmulatorStatus = jest.fn(() => emulatorStatus);
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
    await registerGuiRoutes(app, { configCwd: cwd, openDir: async () => undefined, emulatorStatus: getEmulatorStatus });
  });

  afterEach(async () => {
    jest.useRealTimers();
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

  function nextStartupRead(): Promise<void> {
    return new Promise(resolve => {
      getEmulatorStatus.mockImplementationOnce(() => {
        resolve();
        return emulatorStatus;
      });
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

  it("waits for existing MuMu startup while other GUI routes remain available", async () => {
    await app.ready();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    emulatorStatus = { state: "starting" };
    const startedWaiting = nextStartupRead();
    const pending = enter();
    await startedWaiting;

    expect(spawn).not.toHaveBeenCalled();
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    expect((await app.inject("/api/emulator-status")).json().state).toBe("starting");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(spawn).not.toHaveBeenCalled();

    emulatorStatus = { state: "ready" };
    await jest.advanceTimersByTimeAsync(500);
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(executedJson).toBe(originalJson);
  });

  it("reports startup failure before launching the practice helper", async () => {
    await app.ready();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    emulatorStatus = { state: "starting" };
    const startedWaiting = nextStartupRead();
    const pending = enter();
    await startedWaiting;
    emulatorStatus = { state: "failed", message: "Android 启动超时，请确认 MuMu 窗口提示。" };
    await jest.advanceTimersByTimeAsync(500);

    const response = await pending;
    expect(response.statusCode).toBe(400);
    expect(response.json().errors).toEqual(["MuMu 启动未完成：Android 启动超时，请确认 MuMu 窗口提示。"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  });

  it("bounds waiting even when the startup status never settles", async () => {
    await app.ready();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    emulatorStatus = { state: "starting" };
    const startedWaiting = nextStartupRead();
    const pending = enter();
    await startedWaiting;
    await jest.advanceTimersByTimeAsync(195_000);

    const response = await pending;
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0]).toContain("等待 MuMu 启动超时（195 秒）");
    expect(spawn).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  });

  it("allows manual startup recovery after an earlier background check failed", async () => {
    emulatorStatus = { state: "failed", message: "Earlier startup timed out" };
    const response = await enter();
    expect(response.statusCode).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  (process.platform === "win32" ? it : it.skip)("covers preparation time and stops the whole practice process tree before reporting timeout", async () => {
    await app.ready();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const helper = pendingChild(24680);
    spawn.mockImplementationOnce(() => helper as unknown as ChildProcess);
    let completeStop!: (error: Error | null, stdout: string, stderr: string) => void;
    const stop: jest.SpyInstance = jest.spyOn(childProcess, "execFile");
    stop.mockImplementation((_command, _args, _options, callback) => {
      completeStop = callback;
      return pendingChild() as unknown as ChildProcess;
    });

    const pending = enter();
    let finished = false;
    void pending.then(() => { finished = true; });
    await new Promise(setImmediate);
    await jest.advanceTimersByTimeAsync(900_000);
    expect(stop).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(360_000);

    expect(stop).toHaveBeenCalledWith("taskkill.exe", ["/PID", "24680", "/T", "/F"], { windowsHide: true, timeout: 10_000 }, expect.any(Function));
    expect(helper.kill).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    // A late successful helper exit must not publish or record a rehearsal after timeout.
    helper.stdout.emit("data", JSON.stringify({ ok: true, copilotTaskId: 17 }));
    helper.emit("close", 0);
    completeStop(null, "", "");

    const response = await pending;
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0]).toContain("进入演习超时（21 分钟，含唤醒、导航和战斗）");
    expect(observer).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  (process.platform === "win32" ? it : it.skip)("reports that process cleanup was not confirmed when tree termination fails", async () => {
    await app.ready();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const helper = pendingChild(24680);
    spawn.mockImplementationOnce(() => helper as unknown as ChildProcess);
    const stop: jest.SpyInstance = jest.spyOn(childProcess, "execFile");
    stop.mockImplementation((_command, _args, _options, callback) => {
      setImmediate(() => callback(new Error("Access denied"), "", ""));
      return pendingChild() as unknown as ChildProcess;
    });

    const pending = enter();
    await new Promise(setImmediate);
    await jest.advanceTimersByTimeAsync(1_260_000);

    const response = await pending;
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0]).toContain("未能确认演习子进程已全部停止");
    expect(helper.kill).toHaveBeenCalledTimes(1);
    expect(observer).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
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

  it("shows a structured UTF-8 helper error without PowerShell stack output", async () => {
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => {
        const output = Buffer.from(JSON.stringify({ ok: false, error: "未找到所选关卡：1-7" }));
        const split = output.indexOf(Buffer.from("未")) + 1;
        child.stdout.emit("data", output.subarray(0, split));
        child.stdout.emit("data", output.subarray(split));
        child.stderr.emit("data", "At C:\\private-path\\helper.ps1:630\n+ CategoryInfo: OperationStopped");
        child.emit("close", 1);
      });
      return child as unknown as ChildProcess;
    });

    const response = await enter();
    expect(response.statusCode).toBe(400);
    expect(response.json().errors).toEqual(["进入演习失败：未找到所选关卡：1-7"]);
    expect(observer).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  });

  it("keeps legacy helper diagnostics concise when structured output is absent", async () => {
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => {
        child.stderr.emit("data", "Navigation timed out\nAt C:\\private-path\\helper.ps1:630\n+ throw ...");
        child.emit("close", 1);
      });
      return child as unknown as ChildProcess;
    });

    const response = await enter();
    expect(response.statusCode).toBe(400);
    expect(response.json().errors).toEqual(["进入演习失败：Navigation timed out"]);
    expect(feedback).not.toHaveBeenCalled();
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
    const args = spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("-Stage") + 1]).toBe("GT-1");
  });

  it.each([
    ["10-2", "10-2", "Normal"],
    ["main_10-01", "10-2", "Normal"],
    ["tough_10-01", "10-2", "Hard"],
    ["tough_11-06", "11-7", "Hard"],
    ["H10-1", "H10-1", "Hard"],
    ["hard_10-01", "H10-1", "Hard"],
    ["H9-1", "H9-1", undefined],
    ["main_01-07", "1-7", undefined],
    ["GT-1", "GT-1", undefined],
  ])("preserves the official stage name and passes the difficulty for %s", async (requestedStage, officialCode, difficulty) => {
    const script = JSON.parse(originalJson);
    script.stage_name = officialCode;
    originalJson = JSON.stringify(script);
    fs.writeFileSync(candidatePath, originalJson, "utf8");

    const response = await enter({ stage: requestedStage, scriptHash: undefined });
    expect(response.statusCode).toBe(200);
    const args = spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("-Stage") + 1]).toBe(officialCode);
    if (difficulty) expect(args[args.indexOf("-Difficulty") + 1]).toBe(difficulty);
    else expect(args).not.toContain("-Difficulty");
    expect(JSON.parse(executedJson).stage_name).toBe(officialCode);
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
