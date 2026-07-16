import type { SpawnSyncReturns } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCli } from "../src/index";
import type { BattleScript } from "../src/types";

const childProcess = require("child_process") as typeof import("child_process");

function script(overrides: Partial<BattleScript> = {}): BattleScript {
  return {
    stage_name: "TEST-1",
    minimum_required: "v6.0.0",
    actions: [
      { type: "SpeedUp" },
      { type: "Deploy", name: "test", location: [1, 1], direction: "Right" },
      { type: "SkillDaemon" },
    ],
    doc: { title: "test", details: "" },
    groups: [],
    opers: [{ name: "test", skill: 1 }],
    generatedAt: "2026-06-30T00:00:00.000Z",
    metadata: { source: "test" },
    version: 3,
    ...overrides,
  };
}

describe("run command", () => {
  let cwd: string;
  let oldHome: string | undefined;
  let oldPath: string | undefined;
  let oldMaaPath: string | undefined;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-run-cli-"));
    oldHome = process.env.MAAFIGHT_HOME;
    oldPath = process.env.Path;
    oldMaaPath = process.env.MAAFIGHT_MAA_PATH;
    process.env.MAAFIGHT_HOME = cwd;
    process.env.MAAFIGHT_MAA_PATH = "";
    logSpy = jest.spyOn(console, "log").mockImplementation();
    errorSpy = jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    if (oldHome === undefined) {
      delete process.env.MAAFIGHT_HOME;
    } else {
      process.env.MAAFIGHT_HOME = oldHome;
    }
    if (oldPath === undefined) {
      delete process.env.Path;
    } else {
      process.env.Path = oldPath;
    }
    if (oldMaaPath === undefined) {
      delete process.env.MAAFIGHT_MAA_PATH;
    } else {
      process.env.MAAFIGHT_MAA_PATH = oldMaaPath;
    }
    jest.restoreAllMocks();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function writeScript(value: unknown): string {
    const file = path.join(cwd, "script.json");
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
    return file;
  }

  function writeCallbackLog(stars: number): string {
    const file = path.join(cwd, "maa-callback.jsonl");
    fs.writeFileSync(file, JSON.stringify({
      msg: "SubTaskExtraInfo",
      details: {
        what: "StageDrops",
        details: { stars },
      },
    }) + "\n", "utf8");
    return file;
  }

  function blankBgr(): Buffer {
    const width = 1280;
    const height = 720;
    return Buffer.alloc(width * height * 3, 8);
  }

  function failedResultBgr(): Buffer {
    const buffer = blankBgr();
    for (let y = 346; y <= 374; y++) {
      for (let x = 136; x <= 164; x++) {
        const offset = (y * 1280 + x) * 3;
        buffer[offset] = 255;
        buffer[offset + 1] = 255;
        buffer[offset + 2] = 255;
      }
    }
    return buffer;
  }

  function bgrWithStars(stars: number): Buffer {
    const width = 1280;
    const buffer = blankBgr();
    const centers = [[102, 322], [174, 322], [246, 322]];
    centers.forEach(([cx, cy], index) => {
      const lit = index < stars;
      for (let y = cy - 14; y <= cy + 14; y++) {
        for (let x = cx - 14; x <= cx + 14; x++) {
          const offset = (y * width + x) * 3;
          buffer[offset] = lit ? 45 : 150;
          buffer[offset + 1] = lit ? 180 : 150;
          buffer[offset + 2] = lit ? 235 : 150;
        }
      }
    });
    return buffer;
  }

  it("records a manual-practice dry run", async () => {
    const file = writeScript(script());

    await runCli(["run", "--file", file, "--mode", "manual-practice"]);

    const recordPath = path.join(cwd, ".maafight", "run-results.jsonl");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8").trim());
    expect(record).toMatchObject({
      stageId: "TEST-1",
      mode: "manual-practice",
      outcome: "unknown",
      source: "dry_run",
      errorType: "MAA_EXECUTION_NOT_IMPLEMENTED",
    });
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ scriptHash: record.scriptHash });
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("MAA execution is not implemented yet");
  });

  it("rejects manual-normal without --allow-sanity", async () => {
    const file = writeScript(script());

    await expect(runCli(["run", "--file", file, "--mode", "manual-normal"]))
      .rejects.toThrow("--allow-sanity");
    expect(fs.existsSync(path.join(cwd, ".maafight", "run-results.jsonl"))).toBe(false);
  });

  it("fails invalid scripts", async () => {
    const file = writeScript(script({ stage_name: "", actions: [] }));

    await expect(runCli(["run", "--file", file, "--mode", "manual-practice"]))
      .rejects.toThrow("Invalid copilot script");
    expect(fs.existsSync(path.join(cwd, ".maafight", "run-results.jsonl"))).toBe(false);
  });

  it("imports a callback log as maa_callback RunResult", async () => {
    const file = writeScript(script());
    const callbackLog = writeCallbackLog(3);

    await runCli(["run", "--file", file, "--callback-log", callbackLog]);

    const recordPath = path.join(cwd, ".maafight", "run-results.jsonl");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8").trim());
    expect(record).toMatchObject({
      stageId: "TEST-1",
      outcome: "clear",
      stars: 3,
      source: "maa_callback",
    });
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("callback import");
  });

  it("prints run summary for a stage", async () => {
    const file = writeScript(script());
    const callbackLog = writeCallbackLog(3);
    await runCli(["run", "--file", file, "--mode", "manual-practice"]);
    await runCli(["run", "--file", file, "--callback-log", callbackLog]);
    logSpy.mockClear();

    await runCli(["run", "summary", "--stage", "TEST-1"]);

    const summary = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(summary).toMatchObject({
      stageId: "TEST-1",
      total: 2,
      clear: 1,
      dry_run: 1,
      realResultCount: 1,
      passRate: 1,
    });
  });

  it("prints run probe JSON without writing RunResult", async () => {
    const maaDir = path.join(cwd, "maa");
    fs.mkdirSync(maaDir);
    fs.writeFileSync(path.join(maaDir, "MaaPiCli.exe"), "", "utf8");
    fs.writeFileSync(path.join(cwd, "adb.exe"), "", "utf8");
    process.env.Path = cwd;
    jest.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
      if (String(command).endsWith("MaaPiCli.exe") && Array.isArray(args) && args[0] === "--help") {
        return { stdout: "maa help", stderr: "", status: 0, signal: null, output: [null, "maa help", ""], pid: 1 } as SpawnSyncReturns<string>;
      }
      if (String(command).endsWith("adb.exe")) {
        return {
          stdout: "List of devices attached\nemulator-5554\tdevice\n",
          stderr: "",
          status: 0,
          signal: null,
          output: [null, "List of devices attached\nemulator-5554\tdevice\n", ""],
          pid: 1,
        } as SpawnSyncReturns<string>;
      }
      return { stdout: "", stderr: "unexpected", status: 1, signal: null, output: [null, "", "unexpected"], pid: 1 } as SpawnSyncReturns<string>;
    });

    await runCli(["run", "probe", "--maa", maaDir]);

    const output = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(output).toMatchObject({
      maaFound: true,
      maaKind: "cli",
      maaStdout: "maa help",
      adbDevices: [{ serial: "emulator-5554", status: "device" }],
      readyForExecution: true,
    });
    expect(fs.existsSync(path.join(cwd, ".maafight", "run-results.jsonl"))).toBe(false);
  });

  it("prints run connect JSON without writing RunResult", async () => {
    const maaDir = path.join(cwd, "maa");
    const configDir = path.join(maaDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(maaDir, "MAA.exe"), "", "utf8");
    fs.writeFileSync(path.join(maaDir, "MaaCore.dll"), "", "utf8");
    const adbPath = path.join(cwd, "adb.exe");
    fs.writeFileSync(adbPath, "", "utf8");
    fs.writeFileSync(path.join(configDir, "gui.json"), JSON.stringify({
      Current: "Default",
      Configurations: {
        Default: {
          "Connect.AdbPath": adbPath,
          "Connect.Address": "127.0.0.1:16384",
          "Connect.ConnectConfig": "MuMuEmulator12",
        },
      },
    }), "utf8");
    jest.spyOn(childProcess, "spawnSync").mockImplementation((command) => {
      if (String(command).endsWith("powershell.exe")) {
        return {
          stdout: JSON.stringify({
            maaCoreVersion: "v6.13.0",
            setUserDir: true,
            loadResource: true,
            connectSuccess: true,
            asstConnected: true,
          }),
          stderr: "",
          status: 0,
          signal: null,
          output: [null, "", ""],
          pid: 1,
        } as SpawnSyncReturns<string>;
      }
      return { stdout: "", stderr: "unexpected", status: 1, signal: null, output: [null, "", "unexpected"], pid: 1 } as SpawnSyncReturns<string>;
    });

    await runCli(["run", "connect", "--maa", maaDir]);

    const output = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(output).toMatchObject({
      maaFound: true,
      maaCoreVersion: "v6.13.0",
      adbPath,
      address: "127.0.0.1:16384",
      connectConfig: "MuMuEmulator12",
      connectSuccess: true,
      asstConnected: true,
    });
    expect(fs.existsSync(path.join(cwd, ".maafight", "run-results.jsonl"))).toBe(false);
  });

  it("observes current MaaCore screenshot and records screen_observer RunResult", async () => {
    const file = writeScript(script());
    const debugDir = path.join(cwd, "screen-debug");
    const maaDir = path.join(cwd, "maa");
    const configDir = path.join(maaDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(maaDir, "MAA.exe"), "", "utf8");
    fs.writeFileSync(path.join(maaDir, "MaaCore.dll"), "", "utf8");
    const adbPath = path.join(cwd, "adb.exe");
    fs.writeFileSync(adbPath, "", "utf8");
    fs.writeFileSync(path.join(configDir, "gui.json"), JSON.stringify({
      Current: "Default",
      Configurations: {
        Default: {
          "Connect.AdbPath": adbPath,
          "Connect.Address": "127.0.0.1:16384",
          "Connect.ConnectConfig": "MuMuEmulator12",
        },
      },
    }), "utf8");
    let captureScript = "";
    jest.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
      if (String(command).endsWith("powershell.exe") && Array.isArray(args)) {
        const helperScript = String(args[args.length - 1]);
        if (helperScript.includes("AsstAsyncScreencap")) {
          captureScript = helperScript;
          const bgrPath = path.join(debugDir, "screen.bgr");
          const screenshotPath = path.join(debugDir, "screenshot.png");
          fs.mkdirSync(debugDir, { recursive: true });
          fs.writeFileSync(bgrPath, bgrWithStars(3));
          fs.writeFileSync(screenshotPath, "png", "utf8");
          return {
            stdout: JSON.stringify({
              maaCoreVersion: "v6.13.0",
              bgrPath,
              bgrBytes: 1280 * 720 * 3,
              screenshotPath,
              screenshotBytes: 3,
            }),
            stderr: "",
            status: 0,
            signal: null,
            output: [null, "", ""],
            pid: 1,
          } as SpawnSyncReturns<string>;
        }
        return {
          stdout: JSON.stringify({
            maaCoreVersion: "v6.13.0",
            setUserDir: true,
            loadResource: true,
            connectSuccess: true,
            asstConnected: true,
          }),
          stderr: "",
          status: 0,
          signal: null,
          output: [null, "", ""],
          pid: 1,
        } as SpawnSyncReturns<string>;
      }
      return { stdout: "", stderr: "unexpected", status: 1, signal: null, output: [null, "", "unexpected"], pid: 1 } as SpawnSyncReturns<string>;
    });

    await runCli(["run", "observe-screen", "--file", file, "--maa", maaDir, "--debug-dir", debugDir]);

    const recordPath = path.join(cwd, ".maafight", "run-results.jsonl");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8").trim());
    expect(record).toMatchObject({
      stageId: "TEST-1",
      outcome: "clear",
      stars: 3,
      source: "screen_observer",
      maaVersion: "v6.13.0",
    });
    expect(fs.existsSync(path.join(debugDir, "screenshot.png"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(debugDir, "samples.json"), "utf8"))).toMatchObject({ stars: 3 });
    expect(captureScript).toContain("AsstAsyncScreencap");
    expect(captureScript).toContain("AsstGetImageBgr");
    expect(captureScript).toContain("AsstGetImage");
    expect(captureScript).not.toMatch(/adb\s+shell\s+screencap/i);
  });

  it("clicks through a failed result screen before sampling settlement stars", async () => {
    const file = writeScript(script());
    const debugDir = path.join(cwd, "screen-debug");
    const maaDir = path.join(cwd, "maa");
    const configDir = path.join(maaDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(maaDir, "MAA.exe"), "", "utf8");
    fs.writeFileSync(path.join(maaDir, "MaaCore.dll"), "", "utf8");
    const adbPath = path.join(cwd, "adb.exe");
    fs.writeFileSync(adbPath, "", "utf8");
    fs.writeFileSync(path.join(configDir, "gui.json"), JSON.stringify({
      Current: "Default",
      Configurations: {
        Default: {
          "Connect.AdbPath": adbPath,
          "Connect.Address": "127.0.0.1:16384",
          "Connect.ConnectConfig": "MuMuEmulator12",
        },
      },
    }), "utf8");
    const captureScripts: string[] = [];
    jest.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
      if (String(command).endsWith("powershell.exe") && Array.isArray(args)) {
        const helperScript = String(args[args.length - 1]);
        if (helperScript.includes("AsstAsyncScreencap")) {
          captureScripts.push(helperScript);
          const bgrPath = path.join(debugDir, "screen.bgr");
          const screenshotPath = path.join(debugDir, "screenshot.png");
          fs.mkdirSync(debugDir, { recursive: true });
          fs.writeFileSync(bgrPath, captureScripts.length === 1 ? failedResultBgr() : bgrWithStars(0));
          fs.writeFileSync(screenshotPath, "png", "utf8");
          return {
            stdout: JSON.stringify({
              maaCoreVersion: "v6.13.0",
              bgrPath,
              bgrBytes: 1280 * 720 * 3,
              screenshotPath,
              screenshotBytes: 3,
            }),
            stderr: "",
            status: 0,
            signal: null,
            output: [null, "", ""],
            pid: 1,
          } as SpawnSyncReturns<string>;
        }
        return {
          stdout: JSON.stringify({
            maaCoreVersion: "v6.13.0",
            setUserDir: true,
            loadResource: true,
            connectSuccess: true,
            asstConnected: true,
          }),
          stderr: "",
          status: 0,
          signal: null,
          output: [null, "", ""],
          pid: 1,
        } as SpawnSyncReturns<string>;
      }
      return { stdout: "", stderr: "unexpected", status: 1, signal: null, output: [null, "", "unexpected"], pid: 1 } as SpawnSyncReturns<string>;
    });

    await runCli(["run", "observe-screen", "--file", file, "--maa", maaDir, "--debug-dir", debugDir]);

    const recordPath = path.join(cwd, ".maafight", "run-results.jsonl");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8").trim());
    expect(record).toMatchObject({
      stageId: "TEST-1",
      outcome: "failed",
      stars: 0,
      source: "screen_observer",
    });
    expect(captureScripts).toHaveLength(2);
    expect(captureScripts[0]).toContain("$clickX = -1");
    expect(captureScripts[1]).toContain("$clickX = 640");
    expect(captureScripts[1]).toContain("$clickY = 650");
    expect(JSON.parse(fs.readFileSync(path.join(debugDir, "samples.json"), "utf8"))).toMatchObject({
      outcome: "failed",
      stars: 0,
    });
  });
});
