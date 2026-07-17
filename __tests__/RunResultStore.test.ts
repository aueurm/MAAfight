import type { SpawnSyncReturns } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseCallbackMessages } from "../src/runner/callback";
import {
  connectMaaEnvironment,
  parseAdbDevices,
  probeMaaEnvironment,
  resolveMaaAdbCaptureEnvironment,
} from "../src/runner/probe";
import { RunResultStore } from "../src/runner/RunResultStore";
import type { RunResult } from "../src/runner/types";

const childProcess = require("child_process") as typeof import("child_process");

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    runId: "run-1",
    scriptHash: "hash-1",
    stageId: "TEST-1",
    mode: "manual-practice",
    outcome: "unknown",
    source: "dry_run",
    errorType: "MAA_EXECUTION_NOT_IMPLEMENTED",
    createdAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("RunResultStore", () => {
  let cwd: string;
  let store: RunResultStore;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-run-results-"));
    store = new RunResultStore(cwd);
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("writes run results to .maafight/run-results.jsonl", () => {
    store.append(result());

    expect(store.runResultsPath).toBe(path.join(cwd, ".maafight", "run-results.jsonl"));
    expect(store.load().records).toEqual([result()]);
    expect(fs.readFileSync(store.runResultsPath, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("skips malformed JSONL lines", () => {
    fs.mkdirSync(path.dirname(store.runResultsPath), { recursive: true });
    fs.writeFileSync(store.runResultsPath, "not-json\n", "utf8");

    expect(store.load().warnings).toHaveLength(1);
  });

  it("keeps dry-run records out of real pass rate", () => {
    store.append(result({ runId: "dry", source: "dry_run", outcome: "unknown" }));
    store.append(result({ runId: "clear", source: "maa_callback", outcome: "clear" }));

    expect(store.summary("TEST-1")).toMatchObject({
      total: 2,
      clear: 1,
      dry_run: 1,
      realResultCount: 1,
      passRate: 1,
    });
  });
});

function stageDrops(stars: number): unknown {
  return {
    msg: "SubTaskExtraInfo",
    details: {
      what: "StageDrops",
      details: { stars },
    },
  };
}

describe("parseCallbackMessages", () => {
  it("maps StageDrops stars 3 to clear", () => {
    expect(parseCallbackMessages([stageDrops(3)])).toMatchObject({ outcome: "clear", stars: 3 });
  });

  it("maps StageDrops stars 2 to partial_clear", () => {
    expect(parseCallbackMessages([stageDrops(2)])).toMatchObject({ outcome: "partial_clear", stars: 2 });
  });

  it("returns unknown when there is no StageDrops", () => {
    expect(parseCallbackMessages([{ msg: "TaskChainCompleted" }])).toMatchObject({ outcome: "unknown" });
  });
});

function spawnResult(stdout = "", stderr = "", status = 0): SpawnSyncReturns<string> {
  return { stdout, stderr, status, signal: null, output: [null, stdout, stderr], pid: 1 } as SpawnSyncReturns<string>;
}

describe("probeMaaEnvironment", () => {
  afterEach(() => jest.restoreAllMocks());

  it("reports missing MAA without probing tasks", () => {
    const result = probeMaaEnvironment({ env: { MAAFIGHT_MAA_PATH: "" }, pathEnv: "" });

    expect(result.maaFound).toBe(false);
    expect(result.readyForExecution).toBe(false);
    expect(result.warnings.some(warning => warning.includes("--maa"))).toBe(true);
  });

  it("finds a specified MaaPiCli.exe and runs a safe probe command", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-probe-"));
    try {
      const maaDir = path.join(cwd, "maa");
      fs.mkdirSync(maaDir);
      fs.writeFileSync(path.join(maaDir, "MaaPiCli.exe"), "", "utf8");
      fs.writeFileSync(path.join(cwd, "adb.exe"), "", "utf8");
      jest.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
        if (String(command).endsWith("MaaPiCli.exe") && Array.isArray(args) && args[0] === "--help") {
          return spawnResult("maa help");
        }
        if (String(command).endsWith("adb.exe")) {
          return spawnResult("List of devices attached\nemulator-5554\tdevice\n");
        }
        return spawnResult("", "unexpected command", 1);
      });

      const result = probeMaaEnvironment({ maaPath: maaDir, env: { MAAFIGHT_MAA_PATH: "" }, pathEnv: cwd });

      expect(result).toMatchObject({
        maaFound: true,
        maaKind: "cli",
        maaExitCode: 0,
        maaStdout: "maa help",
        readyForExecution: true,
      });
      expect(result.maaProbeCommand).toContain("--help");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("derives install dir from MAA.exe and probes MaaCore version safely", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-probe-gui-"));
    try {
      const maaDir = path.join(cwd, "maa");
      fs.mkdirSync(maaDir);
      const maaExe = path.join(maaDir, "MAA.exe");
      fs.writeFileSync(maaExe, "", "utf8");
      fs.writeFileSync(path.join(maaDir, "MaaCore.dll"), "", "utf8");
      jest.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
        if (String(command).endsWith("powershell.exe") && Array.isArray(args) && args.includes("-Command")) {
          return spawnResult("v5.99.0\n");
        }
        return spawnResult("List of devices attached\n");
      });

      const result = probeMaaEnvironment({ maaPath: maaExe, env: { MAAFIGHT_MAA_PATH: "" }, pathEnv: "" });

      expect(result).toMatchObject({
        maaFound: true,
        maaPath: maaExe,
        maaKind: "gui_only",
        maaInstallDir: maaDir,
        maaCoreFound: true,
        maaCorePath: path.join(maaDir, "MaaCore.dll"),
        maaCoreVersion: "v5.99.0",
        maaCoreExitCode: 0,
        readyForExecution: false,
      });
      expect(result.maaCoreProbeCommand).toContain("AsstGetVersion");
      expect(result.maaProbeCommand).toBeNull();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps probe non-ready when MaaCore version probe fails and no MaaPiCli exists", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-probe-core-fail-"));
    try {
      const maaDir = path.join(cwd, "maa");
      fs.mkdirSync(maaDir);
      fs.writeFileSync(path.join(maaDir, "MAA.exe"), "", "utf8");
      fs.writeFileSync(path.join(maaDir, "MaaCore.dll"), "", "utf8");
      jest.spyOn(childProcess, "spawnSync").mockImplementation((command) => {
        if (String(command).endsWith("powershell.exe")) return spawnResult("", "load failed", 1);
        return spawnResult("List of devices attached\nemulator-5554\tdevice\n");
      });

      const result = probeMaaEnvironment({ maaPath: maaDir, env: { MAAFIGHT_MAA_PATH: "" }, pathEnv: "" });

      expect(result).toMatchObject({
        maaKind: "gui_only",
        maaCoreFound: true,
        maaCoreVersion: null,
        maaCoreExitCode: 1,
        maaProbeCommand: null,
        readyForExecution: false,
      });
      expect(result.warnings.some(warning => warning.includes("MaaCore version probe failed"))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("parses adb devices output", () => {
    expect(parseAdbDevices("List of devices attached\nemulator-5554\tdevice\n127.0.0.1:5555\toffline\n")).toEqual([
      { serial: "emulator-5554", status: "device" },
      { serial: "127.0.0.1:5555", status: "offline" },
    ]);
  });
});

describe("connectMaaEnvironment", () => {
  afterEach(() => jest.restoreAllMocks());

  it("resolves GUI ADB capture settings without starting MaaCore", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-adb-capture-"));
    try {
      const maaDir = path.join(cwd, "maa");
      const configDir = path.join(maaDir, "config");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(maaDir, "MAA.exe"), "", "utf8");
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
      const spawn = jest.spyOn(childProcess, "spawnSync");

      const result = resolveMaaAdbCaptureEnvironment({
        maaPath: path.join(maaDir, "MAA.exe"), env: { MAAFIGHT_MAA_PATH: "" }, pathEnv: "",
      });

      expect(result).toMatchObject({
        adbPath,
        address: "127.0.0.1:16384",
        connectConfig: "MuMuEmulator12",
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses MAA GUI connection config and calls only MaaCore connect functions", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-connect-"));
    try {
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
      let helperScript = "";
      jest.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
        if (String(command).endsWith("powershell.exe") && Array.isArray(args)) {
          helperScript = String(args[args.length - 1]);
          return spawnResult(JSON.stringify({
            maaCoreVersion: "v6.13.0",
            setUserDir: true,
            loadResource: true,
            connectSuccess: true,
            asstConnected: true,
          }));
        }
        return spawnResult("", "unexpected command", 1);
      });

      const result = connectMaaEnvironment({ maaPath: path.join(maaDir, "MAA.exe"), env: { MAAFIGHT_MAA_PATH: "" }, pathEnv: "" });

      expect(result).toMatchObject({
        maaFound: true,
        maaInstallDir: maaDir,
        maaCorePath: path.join(maaDir, "MaaCore.dll"),
        maaCoreVersion: "v6.13.0",
        adbPath,
        address: "127.0.0.1:16384",
        connectConfig: "MuMuEmulator12",
        connectAttempted: true,
        connectExitCode: 0,
        connectSuccess: true,
        asstConnected: true,
      });
      expect(helperScript).toContain("AsstConnect");
      expect(helperScript).not.toContain("AsstAppendTask");
      expect(helperScript).not.toContain("AsstStart");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not attempt connect when adb address is missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-connect-missing-"));
    try {
      const maaDir = path.join(cwd, "maa");
      fs.mkdirSync(maaDir);
      fs.writeFileSync(path.join(maaDir, "MAA.exe"), "", "utf8");
      fs.writeFileSync(path.join(maaDir, "MaaCore.dll"), "", "utf8");
      jest.spyOn(childProcess, "spawnSync");

      const result = connectMaaEnvironment({ maaPath: maaDir, env: { MAAFIGHT_MAA_PATH: "" }, pathEnv: "" });

      expect(result.connectAttempted).toBe(false);
      expect(result.connectSuccess).toBe(false);
      expect(result.warnings.some(warning => warning.includes("--address"))).toBe(true);
      expect(childProcess.spawnSync).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
