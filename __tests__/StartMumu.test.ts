import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const describeOnWindows = process.platform === "win32" ? describe : describe.skip;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

describeOnWindows("MuMu startup readiness", () => {
  let fixtureRoot: string;
  let fakeExe: string;
  let stateDir: string;
  let configDir: string;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-start-"));
    fakeExe = path.join(fixtureRoot, "test-launcher.exe");
    const source = path.join(fixtureRoot, "launcher.cs");
    fs.writeFileSync(source, `
using System;
using System.IO;
using System.Threading;
class StartupFixture {
  static int Main(string[] args) {
    string root = Environment.GetEnvironmentVariable("MAAFIGHT_START_TEST_DIR");
    string command = String.Join(" ", args);
    File.AppendAllText(Path.Combine(root, "calls"), command + "\\n");
    if (command == "--launch") {
      File.WriteAllText(Path.Combine(root, "launched"), "1");
      if (File.Exists(Path.Combine(root, "ready-after-launch"))) {
        Thread.Sleep(600);
        File.WriteAllText(Path.Combine(root, "connectable"), "1");
        File.WriteAllText(Path.Combine(root, "boot"), "1");
      }
      return 0;
    }
    if (args.Length > 0 && args[0] == "connect") {
      if (!File.Exists(Path.Combine(root, "connectable"))) return 1;
      File.WriteAllText(Path.Combine(root, "connected"), "1");
      Console.WriteLine("connected");
      return 0;
    }
    if (!File.Exists(Path.Combine(root, "connected"))) return 1;
    if (command.EndsWith("get-state")) { Console.WriteLine("device"); return 0; }
    if (command.EndsWith("shell getprop sys.boot_completed")) {
      Console.WriteLine(File.Exists(Path.Combine(root, "boot")) ? File.ReadAllText(Path.Combine(root, "boot")) : "0");
      return 0;
    }
    return 1;
  }
}`);
    const compiled = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -Path ${literal(source)} -OutputAssembly ${literal(fakeExe)} -OutputType ConsoleApplication`,
    ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (compiled.error || compiled.status !== 0) throw new Error(compiled.error?.message || compiled.stderr);
  }, 20_000);

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(fixtureRoot, "state-"));
    configDir = path.join(stateDir, "config");
    fs.mkdirSync(configDir);
    configure();
  });

  afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  function configure(overrides: Record<string, unknown> = {}, address = "127.0.0.1:16384"): void {
    fs.writeFileSync(path.join(configDir, "gui.new.json"), JSON.stringify({
      Current: "Test", Configurations: { Test: { Gui: {
        StartUpSettings: { StartEmulator: true, EmulatorPath: fakeExe, EmulatorAddCommand: "--launch", EmulatorWaitSeconds: 0, ...overrides },
        ConnectSettings: { AdbPath: fakeExe, Address: address },
      } } },
    }));
  }

  function mark(name: string, value = "1"): void { fs.writeFileSync(path.join(stateDir, name), value); }

  function run(extra: string[] = [], timeoutSeconds = 3) {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.resolve(__dirname, "../scripts/start-mumu.ps1"),
      "-MaaDir", stateDir, "-TimeoutSeconds", String(timeoutSeconds), ...extra,
    ], { encoding: "utf8", timeout: 12_000, windowsHide: true, env: { ...process.env, MAAFIGHT_START_TEST_DIR: stateDir } });
    if (result.error) throw result.error;
    if (!result.stdout.trim()) throw new Error(result.stderr || "startup returned no JSON");
    return { exitCode: result.status, data: JSON.parse(result.stdout.trim()), calls: fs.existsSync(path.join(stateDir, "calls")) ? fs.readFileSync(path.join(stateDir, "calls"), "utf8") : "" };
  }

  it("reuses a booted device even if automatic launch is disabled and the shortcut is missing", () => {
    configure({ StartEmulator: false, EmulatorPath: "missing.exe" });
    mark("connected"); mark("boot");
    const result = run(["-CheckOnly"]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ ok: true, usable: true, adbReady: true, bootCompleted: true, started: false });
    expect(result.calls).not.toContain("--launch");
  });

  it("connects the configured TCP device without restarting the ADB server", () => {
    mark("connectable"); mark("boot");
    const result = run(["-CheckOnly"]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ usable: true, bootCompleted: true });
    expect(result.calls).toContain("connect 127.0.0.1:16384");
    expect(result.calls).not.toMatch(/kill-server|start-server|--launch/);
  });

  it("waits for delayed Android boot even when MAA configures zero launch delay", () => {
    mark("ready-after-launch");
    const result = run([], 6);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ ok: true, usable: true, adbReady: true, bootCompleted: true, started: true });
    expect(result.calls.match(/--launch/g)).toHaveLength(1);
  }, 12_000);

  it("does not call adb connect for a non-TCP device serial", () => {
    configure({}, "emulator-5554");
    const result = run(["-CheckOnly"]);
    expect(result.exitCode).toBe(1);
    expect(result.data).toMatchObject({ usable: false, bootCompleted: false, started: false });
    expect(result.calls).not.toContain("connect ");
  });

  it("reports timeout when ADB is connected but Android has not booted", () => {
    mark("connected");
    const result = run([], 1);
    expect(result.exitCode).toBe(1);
    expect(result.data).toMatchObject({ ok: false, usable: false, adbReady: true, bootCompleted: false, started: false });
    expect(result.data.warning).toMatch(/Android|boot/i);
    expect(result.calls).not.toContain("--launch");
  });

  it("returns a failed launch result if the launcher exits without a ready device", () => {
    const result = run([], 1);
    expect(result.exitCode).toBe(1);
    expect(result.data).toMatchObject({ ok: false, usable: false, adbReady: false, bootCompleted: false, started: true });
    expect(result.data.warning).toBeTruthy();
    expect(result.calls.match(/--launch/g)).toHaveLength(1);
  });

  it("preserves non-ASCII paths in the JSON error sent through stdout", () => {
    configure({ EmulatorPath: path.join(stateDir, "不存在的模拟器.exe") });
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.data.warning).toContain("不存在的模拟器.exe");
  });

  it.each([true, false])("uses the existing Explorer desktop for MuMu (desktop available: %s)", available => {
    const helper = path.resolve(__dirname, "../scripts/start-mumu.ps1");
    const command = `
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(helper)}, [ref]$null, [ref]$null)
$launch = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-Emulator' }, $true)
Invoke-Expression $launch.Extent.Text
function Get-DesktopShellApplication {
  ${available ? `
  $application = New-Object PSObject
  $application | Add-Member ScriptMethod ShellExecute {
    param($file, $arguments, $directory, $verb, $show)
    $global:launchCall = @{ file = $file; arguments = $arguments; directory = $directory; verb = $verb; show = $show }
  }
  return $application` : "return $null"}
}
try {
  $method = Start-Emulator 'C:\\MuMu\\MuMuNxDevice.exe' '-v 0' 'C:\\MuMu'
  @{ method = $method; call = $global:launchCall } | ConvertTo-Json -Compress
} catch { @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", timeout: 5_000, windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
    const data = JSON.parse(result.stdout.trim());
    if (available) {
      expect(data).toEqual({ method: "explorer", call: { file: "C:\\MuMu\\MuMuNxDevice.exe", arguments: "-v 0", directory: "C:\\MuMu", verb: "open", show: 1 } });
    } else {
      expect(data.error).toContain("interactive Windows Explorer desktop");
    }
  });
});
