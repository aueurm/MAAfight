import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import type { FastifyInstance } from "fastify";
import { createGuiServer } from "../src/gui/server";
import { startMumu } from "../src/runner/emulatorStartup";
import * as logger from "../src/runtime/logger";
import * as playerConfig from "../src/player/PlayerConfig";
import type { EmulatorStartupStatus } from "../src/shared/emulatorStartup";

const childProcess = require("child_process") as typeof import("child_process");

describe("GUI and emulator startup are independent", () => {
  let app: FastifyInstance;
  beforeEach(() => { jest.spyOn(logger, "writeGuiLog").mockImplementation(() => undefined); });
  afterEach(async () => { await app?.close(); jest.restoreAllMocks(); });

  it("serves the GUI and other routes while booting, then reports failure", async () => {
    let finish!: (status: EmulatorStartupStatus) => void;
    let signal!: AbortSignal;
    const start = jest.fn((abort: AbortSignal) => {
      signal = abort;
      return new Promise<EmulatorStartupStatus>(resolve => { finish = resolve; });
    });
    app = await createGuiServer({ startEmulator: start });
    await app.listen({ host: "127.0.0.1", port: 0 });
    expect(start).toHaveBeenCalledTimes(1);
    expect((await app.inject("/")).statusCode).toBe(200);
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    expect((await app.inject("/api/stages?q=GT&limit=1")).statusCode).toBe(200);
    expect((await app.inject("/api/emulator-status")).json()).toMatchObject({ state: "starting" });
    finish({ state: "failed", message: "Android 启动超时" });
    await new Promise(setImmediate);
    expect((await app.inject("/api/emulator-status")).json()).toEqual({ success: true, state: "failed", message: "Android 启动超时" });
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    await app.close();
    expect(signal.aborted).toBe(true);
  });

  it("keeps serving when the launcher throws", async () => {
    app = await createGuiServer({ startEmulator: async () => { throw new Error("launcher unavailable"); } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise(setImmediate);
    expect((await app.inject("/api/emulator-status")).json()).toMatchObject({ state: "failed", message: expect.stringContaining("launcher unavailable") });
    expect((await app.inject("/api/health")).statusCode).toBe(200);
  });
});

(process.platform === "win32" ? describe : describe.skip)("MuMu helper result handling", () => {
  let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: jest.Mock };
  beforeEach(() => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn() });
    jest.spyOn(childProcess, "spawn").mockReturnValue(child as unknown as ChildProcess);
    jest.spyOn(playerConfig, "loadConfiguredMaaPath").mockReturnValue(null);
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it.each([
    [{ usable: true, bootCompleted: true }, 0, "ready"],
    [{ usable: false, warning: "ADB unavailable" }, 0, "failed"],
    [{ usable: true, bootCompleted: false }, 0, "failed"],
    [{ usable: true, bootCompleted: true }, 1, "failed"],
    [{ skipped: true }, 0, "skipped"],
    [null, 0, "failed"],
  ])("only reports readiness after boot confirmation: %j", async (result, code, state) => {
    const pending = startMumu(process.cwd(), new AbortController().signal);
    child.stdout.emit("data", `${JSON.stringify(result)}\n`);
    child.emit("close", code);
    expect(await pending).toMatchObject({ state });
  });

  it("reports the helper's reason and ignores later exit events", async () => {
    const pending = startMumu(process.cwd(), new AbortController().signal);
    child.stdout.emit("data", '{"warning":"Android boot timed out"}\n');
    child.emit("close", 1);
    child.emit("error", new Error("late error"));
    expect(await pending).toMatchObject({ state: "failed", message: expect.stringContaining("Android boot timed out") });
  });

  it("cancels only the startup helper when the GUI closes", async () => {
    const abort = new AbortController();
    const pending = startMumu(process.cwd(), abort.signal);
    abort.abort();
    expect(await pending).toEqual({ state: "skipped" });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("reports a bounded failure if the helper never exits", async () => {
    jest.useFakeTimers();
    try {
      const pending = startMumu(process.cwd(), new AbortController().signal);
      jest.advanceTimersByTime(210_000);
      expect(await pending).toMatchObject({ state: "failed", message: expect.stringContaining("超时") });
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
