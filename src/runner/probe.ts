import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

export type MaaKind = "cli" | "gui_only" | "core_only";

export interface AdbDevice {
  serial: string;
  status: string;
}

export interface MaaProbeResult {
  maaFound: boolean;
  maaPath: string | null;
  maaKind: MaaKind | null;
  maaInstallDir: string | null;
  maaProbeCommand: string | null;
  maaExitCode: number | null;
  maaStdout: string;
  maaStderr: string;
  maaCorePath: string | null;
  maaCoreFound: boolean;
  maaCoreVersion: string | null;
  maaCoreProbeCommand: string | null;
  maaCoreExitCode: number | null;
  adbPath: string | null;
  adbDevices: AdbDevice[];
  readyForExecution: boolean;
  warnings: string[];
}

export interface MaaProbeOptions {
  maaPath?: string;
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
}

export interface MaaConnectOptions extends MaaProbeOptions {
  adbPath?: string;
  address?: string;
  connectConfig?: string;
}

export interface MaaConnectResult {
  maaFound: boolean;
  maaPath: string | null;
  maaInstallDir: string | null;
  maaCorePath: string | null;
  maaCoreVersion: string | null;
  adbPath: string | null;
  address: string | null;
  connectConfig: string;
  connectAttempted: boolean;
  connectCommand: string | null;
  connectExitCode: number | null;
  connectSuccess: boolean;
  asstConnected: boolean;
  setUserDir: boolean | null;
  loadResource: boolean | null;
  warnings: string[];
}

export interface MaaAdbCaptureEnvironment {
  maaFound: boolean;
  maaPath: string | null;
  maaInstallDir: string | null;
  adbPath: string | null;
  address: string | null;
  connectConfig: string;
  warnings: string[];
}

interface MaaCandidate {
  path: string;
  kind: MaaKind;
  priority: number;
  installDir: string;
}

const MAA_CANDIDATES: Array<{ name: string; kind: MaaKind; priority: number }> = [
  { name: "MaaPiCli.exe", kind: "cli", priority: 0 },
  { name: "MAA.exe", kind: "gui_only", priority: 1 },
  { name: "MaaWpfGui.exe", kind: "gui_only", priority: 1 },
  { name: "MaaCore.dll", kind: "core_only", priority: 2 },
];

function existingFile(filePath: string): string | null {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? path.resolve(filePath) : null;
  } catch {
    return null;
  }
}

function candidatesInDir(dir: string): MaaCandidate[] {
  return MAA_CANDIDATES.flatMap(candidate => {
    const found = existingFile(path.join(dir, candidate.name));
    return found ? [{ path: found, kind: candidate.kind, priority: candidate.priority, installDir: path.resolve(dir) }] : [];
  });
}

function candidatesFromInput(input?: string): { candidates: MaaCandidate[]; warning?: string } {
  const value = input?.trim();
  if (!value) return { candidates: [] };
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    return { candidates: [], warning: `MAA path does not exist: ${resolved}` };
  }
  if (fs.statSync(resolved).isDirectory()) return { candidates: candidatesInDir(resolved) };
  const name = path.basename(resolved).toLowerCase();
  const match = MAA_CANDIDATES.find(candidate => candidate.name.toLowerCase() === name);
  return match && existingFile(resolved)
    ? { candidates: [{ path: resolved, kind: match.kind, priority: match.priority, installDir: path.dirname(resolved) }] }
    : { candidates: [], warning: `MAA path is not a supported probe target: ${resolved}` };
}

function pathDirs(options: MaaProbeOptions): string[] {
  const value = options.pathEnv ?? options.env?.Path ?? options.env?.PATH ?? process.env.Path ?? process.env.PATH ?? "";
  return value.split(path.delimiter).map(item => item.trim()).filter(Boolean);
}

function findOnPath(names: string[], options: MaaProbeOptions): string | null {
  for (const dir of pathDirs(options)) {
    for (const name of names) {
      const found = existingFile(path.join(dir, name));
      if (found) return found;
    }
  }
  return null;
}

function findMaa(options: MaaProbeOptions, warnings: string[]): MaaCandidate | null {
  const envPath = options.env?.MAAFIGHT_MAA_PATH ?? process.env.MAAFIGHT_MAA_PATH;
  const inputs = [options.maaPath, envPath].filter((value): value is string => Boolean(value));
  const candidates: MaaCandidate[] = [];
  for (const input of inputs) {
    const result = candidatesFromInput(input);
    candidates.push(...result.candidates);
    if (result.warning) warnings.push(result.warning);
  }
  for (const dir of pathDirs(options)) candidates.push(...candidatesInDir(dir));
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0] ?? null;
}

function runSafeMaaProbe(maaPath: string): Pick<MaaProbeResult, "maaProbeCommand" | "maaExitCode" | "maaStdout" | "maaStderr"> {
  for (const arg of ["--help", "--version", "-h"]) {
    const result = childProcess.spawnSync(maaPath, [arg], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const exitCode = result.status ?? null;
    const command = `${maaPath} ${arg}`;
    if (exitCode === 0) return { maaProbeCommand: command, maaExitCode: exitCode, maaStdout: stdout, maaStderr: stderr };
    if (arg === "-h") {
      const errorText = result.error ? `${stderr}\n${result.error.message}`.trim() : stderr;
      return { maaProbeCommand: command, maaExitCode: exitCode, maaStdout: stdout, maaStderr: errorText };
    }
  }
  return { maaProbeCommand: null, maaExitCode: null, maaStdout: "", maaStderr: "" };
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readMaaGuiConnectConfig(installDir: string): { adbPath?: string; address?: string; connectConfig?: string } {
  try {
    const raw = fs.readFileSync(path.join(installDir, "config", "gui.json"), "utf8");
    const parsed = JSON.parse(raw) as { Current?: string; Configurations?: Record<string, Record<string, string>> };
    const current = parsed.Current || "Default";
    const config = parsed.Configurations?.[current] ?? parsed.Configurations?.Default;
    return {
      adbPath: config?.["Connect.AdbPath"],
      address: config?.["Connect.Address"],
      connectConfig: config?.["Connect.ConnectConfig"],
    };
  } catch {
    return {};
  }
}

function runMaaCoreVersionProbe(corePath: string): Pick<MaaProbeResult, "maaCoreVersion" | "maaCoreProbeCommand" | "maaCoreExitCode"> & { warning?: string } {
  const installDir = path.dirname(corePath);
  const script = [
    `$dir = ${powershellLiteral(installDir)}`,
    "[System.Environment]::SetEnvironmentVariable('PATH', $dir + ';' + $env:PATH, 'Process')",
    "$code = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class MaaCoreProbe {",
    "  [DllImport(\"kernel32\", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool SetDllDirectory(string lpPathName);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern IntPtr AsstGetVersion();",
    "}",
    "'@",
    "Add-Type -TypeDefinition $code",
    "[MaaCoreProbe]::SetDllDirectory($dir) | Out-Null",
    "$ptr = [MaaCoreProbe]::AsstGetVersion()",
    "if ($ptr -eq [IntPtr]::Zero) { exit 2 }",
    "[Runtime.InteropServices.Marshal]::PtrToStringAnsi($ptr)",
  ].join("\n");
  const result = childProcess.spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const exitCode = result.status ?? null;
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command AsstGetVersion(${corePath})`;
  return {
    maaCoreVersion: exitCode === 0 && stdout ? stdout : null,
    maaCoreProbeCommand: command,
    maaCoreExitCode: exitCode,
    warning: exitCode === 0 ? undefined : `MaaCore version probe failed${stderr ? `: ${stderr}` : ""}${result.error ? `: ${result.error.message}` : ""}`,
  };
}

function readMaaConnectFailure(userDir: string): string | null {
  try {
    const log = fs.readFileSync(path.join(userDir, "debug", "asst.log"), "utf8");
    const lines = log.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const adbMessage = [...lines].reverse().find(line => line.includes("cannot connect") || line.includes("failed to connect"));
    if (adbMessage) return adbMessage;
    const infoLine = [...lines].reverse().find(line => line.includes("ConnectionInfo") && line.includes("ConnectFailed"));
    const jsonStart = infoLine?.indexOf("{") ?? -1;
    if (infoLine && jsonStart >= 0) {
      const info = JSON.parse(infoLine.slice(jsonStart)) as { why?: string };
      return info.why || null;
    }
  } catch {
    return null;
  }
  return null;
}

function findMaaForConnect(options: MaaConnectOptions, warnings: string[]): MaaCandidate | null {
  const maa = findMaa(options, warnings);
  if (maa) return maa;
  const coreInput = options.maaPath?.trim();
  if (!coreInput) return null;
  const corePath = existingFile(coreInput);
  return corePath && path.basename(corePath).toLowerCase() === "maacore.dll"
    ? { path: corePath, kind: "core_only", priority: 2, installDir: path.dirname(corePath) }
    : null;
}

function runMaaCoreConnectProbe(
  corePath: string,
  installDir: string,
  adbPath: string,
  address: string,
  connectConfig: string,
): Omit<MaaConnectResult, "maaFound" | "maaPath" | "maaInstallDir" | "maaCorePath" | "adbPath" | "address" | "connectConfig" | "connectAttempted" | "warnings"> & { warning?: string } {
  const userDir = path.join(process.cwd(), ".maafight", "maa-core");
  fs.mkdirSync(userDir, { recursive: true });
  const resourceDir = installDir;
  const script = [
    `$dir = ${powershellLiteral(installDir)}`,
    `$userDir = ${powershellLiteral(userDir)}`,
    `$resourceDir = ${powershellLiteral(resourceDir)}`,
    `$adb = ${powershellLiteral(adbPath)}`,
    `$address = ${powershellLiteral(address)}`,
    `$config = ${powershellLiteral(connectConfig)}`,
    "[System.Environment]::SetEnvironmentVariable('PATH', $dir + ';' + $env:PATH, 'Process')",
    "$code = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class MaaCoreConnectProbe {",
    "  [DllImport(\"kernel32\", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool SetDllDirectory(string lpPathName);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern IntPtr AsstGetVersion();",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern byte AsstSetUserDir(string path);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern byte AsstLoadResource(string path);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr AsstCreate();",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern void AsstDestroy(IntPtr handle);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern byte AsstConnect(IntPtr handle, string adb_path, string address, string config);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern byte AsstConnected(IntPtr handle);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $code",
    "[MaaCoreConnectProbe]::SetDllDirectory($dir) | Out-Null",
    "$versionPtr = [MaaCoreConnectProbe]::AsstGetVersion()",
    "$version = if ($versionPtr -eq [IntPtr]::Zero) { $null } else { [Runtime.InteropServices.Marshal]::PtrToStringAnsi($versionPtr) }",
    "$setUserDir = [MaaCoreConnectProbe]::AsstSetUserDir($userDir) -ne 0",
    "$loadResource = [MaaCoreConnectProbe]::AsstLoadResource($resourceDir) -ne 0",
    "$handle = [MaaCoreConnectProbe]::AsstCreate()",
    "if ($handle -eq [IntPtr]::Zero) {",
    "  @{ maaCoreVersion = $version; setUserDir = $setUserDir; loadResource = $loadResource; connectSuccess = $false; asstConnected = $false } | ConvertTo-Json -Compress",
    "  exit 3",
    "}",
    "try {",
    "  $connectSuccess = [MaaCoreConnectProbe]::AsstConnect($handle, $adb, $address, $config) -ne 0",
    "  $asstConnected = [MaaCoreConnectProbe]::AsstConnected($handle) -ne 0",
    "  @{ maaCoreVersion = $version; setUserDir = $setUserDir; loadResource = $loadResource; connectSuccess = $connectSuccess; asstConnected = $asstConnected } | ConvertTo-Json -Compress",
    "  if ($connectSuccess -and $asstConnected) { exit 0 } else { exit 2 }",
    "} finally {",
    "  [MaaCoreConnectProbe]::AsstDestroy($handle)",
    "}",
  ].join("\n");
  const result = childProcess.spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const exitCode = result.status ?? null;
  const jsonLine = stdout.split(/\r?\n/).reverse().find(line => line.trim().startsWith("{"));
  const parsed = jsonLine ? JSON.parse(jsonLine) as Partial<MaaConnectResult> : {};
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command AsstConnect(${adbPath}, ${address}, ${connectConfig})`;
  const failure = readMaaConnectFailure(userDir);
  return {
    maaCoreVersion: typeof parsed.maaCoreVersion === "string" ? parsed.maaCoreVersion : null,
    connectCommand: command,
    connectExitCode: exitCode,
    connectSuccess: parsed.connectSuccess === true,
    asstConnected: parsed.asstConnected === true,
    setUserDir: typeof parsed.setUserDir === "boolean" ? parsed.setUserDir : null,
    loadResource: typeof parsed.loadResource === "boolean" ? parsed.loadResource : null,
    warning: exitCode === 0 ? undefined : `MaaCore connect failed${stderr ? `: ${stderr}` : ""}${result.error ? `: ${result.error.message}` : ""}${failure ? `: ${failure}` : ""}`,
  };
}

export function parseAdbDevices(output: string): AdbDevice[] {
  return output.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("List of devices"))
    .map(line => line.split(/\s+/))
    .filter(parts => parts.length >= 2)
    .map(([serial, status]) => ({ serial, status }));
}

function probeAdb(options: MaaProbeOptions, warnings: string[]): { adbPath: string | null; adbDevices: AdbDevice[] } {
  const adbPath = findOnPath(["adb.exe", "adb"], options);
  if (!adbPath) {
    warnings.push("adb not found on PATH.");
    return { adbPath: null, adbDevices: [] };
  }
  const result = childProcess.spawnSync(adbPath, ["devices"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.error) warnings.push(`adb devices failed: ${result.error.message}`);
  if (stderr.trim()) warnings.push(`adb devices stderr: ${stderr.trim()}`);
  return { adbPath, adbDevices: parseAdbDevices(stdout) };
}

export function probeMaaEnvironment(options: MaaProbeOptions = {}): MaaProbeResult {
  const warnings: string[] = [];
  const maa = findMaa(options, warnings);
  const adb = probeAdb(options, warnings);
  const maaProbe = maa?.kind === "cli"
    ? runSafeMaaProbe(maa.path)
    : { maaProbeCommand: null, maaExitCode: null, maaStdout: "", maaStderr: "" };
  const corePath = maa ? existingFile(path.join(maa.installDir, "MaaCore.dll")) : null;
  const coreProbe = corePath
    ? runMaaCoreVersionProbe(corePath)
    : { maaCoreVersion: null, maaCoreProbeCommand: null, maaCoreExitCode: null };

  if (!maa) {
    warnings.push("MAA not found. Use --maa <path> or set MAAFIGHT_MAA_PATH to the MAA directory or MaaPiCli.exe.");
  } else if (maa.kind === "gui_only") {
    warnings.push("Only MAA GUI executable was found; probe does not start GUI or run tasks.");
  } else if (maa.kind === "core_only") {
    warnings.push("Only MaaCore.dll was found; task execution is not implemented.");
  } else if (maaProbe.maaExitCode !== 0) {
    warnings.push("MaaPiCli safe probe command did not exit successfully.");
  }
  if (coreProbe.warning) warnings.push(coreProbe.warning);

  if (!adb.adbDevices.some(device => device.status === "device")) {
    warnings.push("No connected adb device is ready.");
  }

  return {
    maaFound: Boolean(maa),
    maaPath: maa?.path ?? null,
    maaKind: maa?.kind ?? null,
    maaInstallDir: maa?.installDir ?? null,
    ...maaProbe,
    maaCorePath: corePath,
    maaCoreFound: Boolean(corePath),
    maaCoreVersion: coreProbe.maaCoreVersion,
    maaCoreProbeCommand: coreProbe.maaCoreProbeCommand,
    maaCoreExitCode: coreProbe.maaCoreExitCode,
    adbPath: adb.adbPath,
    adbDevices: adb.adbDevices,
    readyForExecution: Boolean(maa?.kind === "cli" && maaProbe.maaExitCode === 0 && adb.adbDevices.some(device => device.status === "device")),
    warnings,
  };
}

export function resolveMaaAdbCaptureEnvironment(options: MaaConnectOptions = {}): MaaAdbCaptureEnvironment {
  const warnings: string[] = [];
  const maa = findMaaForConnect(options, warnings);
  const guiConfig = maa ? readMaaGuiConnectConfig(maa.installDir) : {};
  const adbPath = options.adbPath || guiConfig.adbPath || findOnPath(["adb.exe", "adb"], options);
  const address = options.address || guiConfig.address || null;
  const connectConfig = options.connectConfig || guiConfig.connectConfig || "General";

  if (!maa) warnings.push("MAA not found. Use --maa <path> or set MAAFIGHT_MAA_PATH.");
  if (!adbPath) warnings.push("adb path not found. Use --adb <path> or configure MAA GUI connection.");
  if (adbPath && !existingFile(adbPath)) warnings.push(`adb path does not exist: ${adbPath}`);
  if (!address) warnings.push("adb address is missing. Use --address <serial-or-host:port>.");

  return {
    maaFound: Boolean(maa),
    maaPath: maa?.path ?? null,
    maaInstallDir: maa?.installDir ?? null,
    adbPath: adbPath ?? null,
    address,
    connectConfig,
    warnings,
  };
}

export function connectMaaEnvironment(options: MaaConnectOptions = {}): MaaConnectResult {
  const environment = resolveMaaAdbCaptureEnvironment(options);
  const warnings = [...environment.warnings];
  const corePath = environment.maaInstallDir
    ? existingFile(path.join(environment.maaInstallDir, "MaaCore.dll"))
    : null;
  if (!corePath) warnings.push("MaaCore.dll not found; cannot connect.");

  const canAttempt = Boolean(corePath && environment.adbPath && existingFile(environment.adbPath) && environment.address);
  const connect = canAttempt
    ? runMaaCoreConnectProbe(corePath!, environment.maaInstallDir!, environment.adbPath!, environment.address!, environment.connectConfig)
    : {
      maaCoreVersion: null,
      connectCommand: null,
      connectExitCode: null,
      connectSuccess: false,
      asstConnected: false,
      setUserDir: null,
      loadResource: null,
    };
  if (connect.warning) warnings.push(connect.warning);

  return {
    maaFound: environment.maaFound,
    maaPath: environment.maaPath,
    maaInstallDir: environment.maaInstallDir,
    maaCorePath: corePath,
    maaCoreVersion: connect.maaCoreVersion,
    adbPath: environment.adbPath,
    address: environment.address,
    connectConfig: environment.connectConfig,
    connectAttempted: canAttempt,
    connectCommand: connect.connectCommand,
    connectExitCode: connect.connectExitCode,
    connectSuccess: connect.connectSuccess,
    asstConnected: connect.asstConnected,
    setUserDir: connect.setUserDir,
    loadResource: connect.loadResource,
    warnings,
  };
}
