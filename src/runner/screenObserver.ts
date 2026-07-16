import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { connectMaaEnvironment, type MaaConnectOptions } from "./probe";
import type { RunOutcome } from "./types";

const WIDTH = 1280;
const HEIGHT = 720;
const BYTES_PER_PIXEL = 3;
const LIT_RATIO = 0.04;
const NEUTRAL_RATIO = 0.04;
// ponytail: saved MAA result screens calibrate this fixed grey-star palette range; use template matching only if MAA restyles the result UI.
const NEUTRAL_DOMINANT_RATIO_MIN = 0.2;
const NEUTRAL_DOMINANT_RATIO_MAX = 0.5;
const SCREEN_BYTES = WIDTH * HEIGHT * BYTES_PER_PIXEL;
const IMAGE_BUFFER_BYTES = 16 * 1024 * 1024;
const RESULT_CONTINUE_CLICK = { x: 640, y: 650, waitMs: 1000 };

const STAR_ROIS = [
  { name: "star1", cx: 102, cy: 322, radius: 24 },
  { name: "star2", cx: 174, cy: 322, radius: 24 },
  { name: "star3", cx: 246, cy: 322, radius: 24 },
] as const;
const FAILURE_TITLE_ROI = { minX: 100, maxX: 199, minY: 340, maxY: 379 };
const FAILURE_TITLE_BRIGHT_RATIO = 0.15;

export interface StarSample {
  name: string;
  center: { x: number; y: number };
  radius: number;
  pixels: number;
  litPixels: number;
  neutralPixels: number;
  litRatio: number;
  neutralRatio: number;
  neutralDominantRatio: number;
  lit: boolean;
  recognized: boolean;
}

export interface StarObservation {
  width: number;
  height: number;
  outcome: RunOutcome;
  stars?: number;
  samples: StarSample[];
  recognized: boolean;
}

export interface ScreenObservation extends StarObservation {
  debugScreenshotPath?: string;
  debugSamplesPath: string;
  errorType?: string;
  maaVersion?: string;
  message: string;
  warnings: string[];
}

export interface ScreenObserverOptions extends MaaConnectOptions {
  debugDir: string;
  userDir?: string;
  timeoutMs?: number;
}

interface CaptureResult {
  maaCoreVersion: string | null;
  bgrPath: string;
  bgrBytes: number;
  screenshotPath?: string;
  screenshotBytes?: number;
}

interface ScreenClick {
  x: number;
  y: number;
  waitMs: number;
}

type MaaCoreScreencapOptions = Required<Pick<ScreenObserverOptions, "debugDir" | "userDir">> & {
  maaInstallDir: string;
  adbPath: string;
  address: string;
  connectConfig: string;
  timeoutMs: number;
  click?: ScreenClick;
};

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function ratio(count: number, total: number): number {
  return total > 0 ? Number((count / total).toFixed(4)) : 0;
}

function isGold(b: number, g: number, r: number): boolean {
  return r >= 170 && g >= 115 && b <= 105 && r - b >= 70 && g - b >= 35;
}

function isCyanBlue(b: number, g: number, r: number): boolean {
  return b >= 140 && g >= 105 && r <= 135 && b - r >= 55 && g - r >= 25;
}

function isLitStar(b: number, g: number, r: number): boolean {
  return isGold(b, g, r) || isCyanBlue(b, g, r);
}

function isNeutralStar(b: number, g: number, r: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max >= 25 && max <= 225 && max - min <= 30;
}

function isBrightWhite(b: number, g: number, r: number): boolean {
  return b >= 220 && g >= 220 && r >= 220;
}

function outcomeFromStars(stars: number): RunOutcome {
  if (stars === 3) return "clear";
  if (stars === 0) return "failed";
  return "partial_clear";
}

export function sampleSettlementStars(bgr: Buffer, width = WIDTH, height = HEIGHT): StarObservation {
  if (bgr.length < width * height * BYTES_PER_PIXEL) {
    return { width, height, outcome: "unknown", samples: [], recognized: false };
  }

  const samples = STAR_ROIS.map(roi => {
    let pixels = 0;
    let litPixels = 0;
    let neutralPixels = 0;
    let neutralDominantPixels = 0;
    const neutralColors = new Map<number, number>();
    const minX = Math.max(0, roi.cx - roi.radius);
    const maxX = Math.min(width - 1, roi.cx + roi.radius);
    const minY = Math.max(0, roi.cy - roi.radius);
    const maxY = Math.min(height - 1, roi.cy + roi.radius);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const offset = (y * width + x) * BYTES_PER_PIXEL;
        const b = bgr[offset];
        const g = bgr[offset + 1];
        const r = bgr[offset + 2];
        pixels++;
        if (isLitStar(b, g, r)) litPixels++;
        if (isNeutralStar(b, g, r)) {
          neutralPixels++;
          const color = b | (g << 8) | (r << 16);
          const count = (neutralColors.get(color) || 0) + 1;
          neutralColors.set(color, count);
          neutralDominantPixels = Math.max(neutralDominantPixels, count);
        }
      }
    }

    const litRatio = ratio(litPixels, pixels);
    const neutralRatio = ratio(neutralPixels, pixels);
    const neutralDominantRatio = ratio(neutralDominantPixels, pixels);
    const lit = litRatio >= LIT_RATIO;
    const recognized = lit || (
      neutralRatio >= NEUTRAL_RATIO
      && neutralDominantRatio >= NEUTRAL_DOMINANT_RATIO_MIN
      && neutralDominantRatio <= NEUTRAL_DOMINANT_RATIO_MAX
    );
    return {
      name: roi.name,
      center: { x: roi.cx, y: roi.cy },
      radius: roi.radius,
      pixels,
      litPixels,
      neutralPixels,
      litRatio,
      neutralRatio,
      neutralDominantRatio,
      lit,
      recognized,
    };
  });

  if (samples.some(sample => !sample.recognized)) {
    return { width, height, outcome: "unknown", samples, recognized: false };
  }

  const stars = samples.filter(sample => sample.lit).length;
  return { width, height, outcome: outcomeFromStars(stars), stars, samples, recognized: true };
}

export function isFailureContinueScreen(bgr: Buffer, width = WIDTH, height = HEIGHT): boolean {
  if (bgr.length < width * height * BYTES_PER_PIXEL) return false;

  let brightPixels = 0;
  let pixels = 0;
  for (let y = FAILURE_TITLE_ROI.minY; y <= FAILURE_TITLE_ROI.maxY; y++) {
    for (let x = FAILURE_TITLE_ROI.minX; x <= FAILURE_TITLE_ROI.maxX; x++) {
      const offset = (y * width + x) * BYTES_PER_PIXEL;
      if (isBrightWhite(bgr[offset], bgr[offset + 1], bgr[offset + 2])) brightPixels++;
      pixels++;
    }
  }
  // ponytail: fixed Official-client title ROI; add locale-aware image matching only if this screen changes.
  return brightPixels / pixels >= FAILURE_TITLE_BRIGHT_RATIO;
}

function runMaaCoreScreencap(options: MaaCoreScreencapOptions): CaptureResult {
  fs.mkdirSync(options.debugDir, { recursive: true });
  fs.mkdirSync(options.userDir, { recursive: true });
  const bgrPath = path.join(options.debugDir, "screen.bgr");
  const screenshotPath = path.join(options.debugDir, "screenshot.png");
  const clickX = options.click ? Math.trunc(options.click.x) : -1;
  const clickY = options.click ? Math.trunc(options.click.y) : -1;
  const clickWaitMs = options.click ? Math.max(0, Math.trunc(options.click.waitMs)) : 0;
  const script = [
    `$dir = ${powershellLiteral(options.maaInstallDir)}`,
    `$userDir = ${powershellLiteral(options.userDir)}`,
    `$resourceDir = ${powershellLiteral(options.maaInstallDir)}`,
    `$adb = ${powershellLiteral(options.adbPath)}`,
    `$address = ${powershellLiteral(options.address)}`,
    `$config = ${powershellLiteral(options.connectConfig)}`,
    `$bgrPath = ${powershellLiteral(bgrPath)}`,
    `$screenshotPath = ${powershellLiteral(screenshotPath)}`,
    `$clickX = ${clickX}`,
    `$clickY = ${clickY}`,
    `$clickWaitMs = ${clickWaitMs}`,
    "[System.Environment]::SetEnvironmentVariable('PATH', $dir + ';' + $env:PATH, 'Process')",
    "$code = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class MaaCoreScreenObserver {",
    "  [DllImport(\"kernel32\", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool SetDllDirectory(string lpPathName);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern IntPtr AsstGetVersion();",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern byte AsstSetUserDir(string path);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern byte AsstLoadResource(string path);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr AsstCreate();",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern void AsstDestroy(IntPtr handle);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern byte AsstConnect(IntPtr handle, string adb_path, string address, string config);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern byte AsstConnected(IntPtr handle);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern int AsstAsyncClick(IntPtr handle, int x, int y, byte block);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern int AsstAsyncScreencap(IntPtr handle, byte block);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern UInt64 AsstGetImageBgr(IntPtr handle, byte[] buff, UInt64 buff_size);",
    "  [DllImport(\"MaaCore.dll\", CallingConvention = CallingConvention.Cdecl)] public static extern UInt64 AsstGetImage(IntPtr handle, byte[] buff, UInt64 buff_size);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $code",
    "[MaaCoreScreenObserver]::SetDllDirectory($dir) | Out-Null",
    "$versionPtr = [MaaCoreScreenObserver]::AsstGetVersion()",
    "$version = if ($versionPtr -eq [IntPtr]::Zero) { $null } else { [Runtime.InteropServices.Marshal]::PtrToStringAnsi($versionPtr) }",
    "if (-not ([MaaCoreScreenObserver]::AsstSetUserDir($userDir) -ne 0)) { throw 'AsstSetUserDir failed' }",
    "if (-not ([MaaCoreScreenObserver]::AsstLoadResource($resourceDir) -ne 0)) { throw 'AsstLoadResource failed' }",
    "$handle = [MaaCoreScreenObserver]::AsstCreate()",
    "if ($handle -eq [IntPtr]::Zero) { throw 'AsstCreate failed' }",
    "try {",
    "  if (-not ([MaaCoreScreenObserver]::AsstConnect($handle, $adb, $address, $config) -ne 0)) { throw 'AsstConnect failed' }",
    "  if (-not ([MaaCoreScreenObserver]::AsstConnected($handle) -ne 0)) { throw 'AsstConnected failed' }",
    "  if ($clickX -ge 0 -and $clickY -ge 0) {",
    "    $clickCallId = [MaaCoreScreenObserver]::AsstAsyncClick($handle, [int]$clickX, [int]$clickY, 1)",
    "    if ($clickCallId -le 0) { throw \"AsstAsyncClick failed at $clickX,$clickY\" }",
    "    if ($clickWaitMs -gt 0) { Start-Sleep -Milliseconds $clickWaitMs }",
    "  }",
    "  [MaaCoreScreenObserver]::AsstAsyncScreencap($handle, 1) | Out-Null",
    `  $bgr = New-Object byte[] ${SCREEN_BYTES}`,
    "  $bgrSize = [MaaCoreScreenObserver]::AsstGetImageBgr($handle, $bgr, [UInt64]$bgr.Length)",
    "  if ($bgrSize -le 0) { throw 'AsstGetImageBgr returned no data' }",
    "  if ($bgrSize -gt $bgr.Length) { throw \"AsstGetImageBgr needs $bgrSize bytes\" }",
    "  [IO.File]::WriteAllBytes($bgrPath, $bgr[0..([int]$bgrSize - 1)])",
    `  $image = New-Object byte[] ${IMAGE_BUFFER_BYTES}`,
    "  $imageSize = [MaaCoreScreenObserver]::AsstGetImage($handle, $image, [UInt64]$image.Length)",
    "  $screenshotBytes = 0",
    "  $savedScreenshotPath = $null",
    "  if ($imageSize -gt 0 -and $imageSize -le $image.Length) {",
    "    [IO.File]::WriteAllBytes($screenshotPath, $image[0..([int]$imageSize - 1)])",
    "    $screenshotBytes = [int]$imageSize",
    "    $savedScreenshotPath = $screenshotPath",
    "  }",
    "  @{ maaCoreVersion = $version; bgrPath = $bgrPath; bgrBytes = [int]$bgrSize; screenshotPath = $savedScreenshotPath; screenshotBytes = $screenshotBytes } | ConvertTo-Json -Compress",
    "} finally {",
    "  [MaaCoreScreenObserver]::AsstDestroy($handle)",
    "}",
  ].join("\n");
  const result = childProcess.spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const jsonLine = stdout.split(/\r?\n/).reverse().find(line => line.trim().startsWith("{"));
  if (result.status !== 0 || !jsonLine) {
    const detail = [stderr, result.error?.message].filter(Boolean).join(": ");
    throw new Error(`MaaCore screen observer failed${detail ? `: ${detail}` : ""}`);
  }
  return JSON.parse(jsonLine) as CaptureResult;
}

function writeBmpFromBgr(bgr: Buffer, filePath: string, width = WIDTH, height = HEIGHT): void {
  const rowSize = Math.ceil((width * BYTES_PER_PIXEL) / 4) * 4;
  const pixelBytes = rowSize * height;
  const headerBytes = 54;
  const output = Buffer.alloc(headerBytes + pixelBytes);

  output.write("BM", 0, "ascii");
  output.writeUInt32LE(output.length, 2);
  output.writeUInt32LE(headerBytes, 10);
  output.writeUInt32LE(40, 14);
  output.writeInt32LE(width, 18);
  output.writeInt32LE(height, 22);
  output.writeUInt16LE(1, 26);
  output.writeUInt16LE(24, 28);
  output.writeUInt32LE(pixelBytes, 34);

  for (let y = 0; y < height; y++) {
    const sourceStart = (height - 1 - y) * width * BYTES_PER_PIXEL;
    const targetStart = headerBytes + y * rowSize;
    bgr.copy(output, targetStart, sourceStart, sourceStart + width * BYTES_PER_PIXEL);
  }
  fs.writeFileSync(filePath, output);
}

function writeDebugSamples(filePath: string, observation: Omit<ScreenObservation, "debugSamplesPath">): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(observation, null, 2), "utf8");
}

function unknownObservation(debugSamplesPath: string, message: string, errorType: string, warnings: string[]): ScreenObservation {
  return {
    width: WIDTH,
    height: HEIGHT,
    outcome: "unknown",
    samples: [],
    recognized: false,
    debugSamplesPath,
    errorType,
    message,
    warnings,
  };
}

export function observeMaaScreen(options: ScreenObserverOptions): ScreenObservation {
  const debugDir = path.resolve(options.debugDir);
  const debugSamplesPath = path.join(debugDir, "samples.json");
  const connect = connectMaaEnvironment(options);
  const warnings = [...connect.warnings];

  if (!connect.connectSuccess || !connect.asstConnected || !connect.maaInstallDir || !connect.adbPath || !connect.address) {
    const observation = unknownObservation(
      debugSamplesPath,
      "Screen observer could not connect MaaCore; settlement stars were not sampled.",
      "SCREEN_OBSERVER_CONNECT_FAILED",
      warnings,
    );
    writeDebugSamples(debugSamplesPath, observation);
    return observation;
  }

  try {
    const captureOptions: MaaCoreScreencapOptions = {
      debugDir,
      userDir: path.resolve(options.userDir || path.join(process.cwd(), ".maafight", "maa-core")),
      maaInstallDir: connect.maaInstallDir,
      adbPath: connect.adbPath,
      address: connect.address,
      connectConfig: connect.connectConfig,
      timeoutMs: options.timeoutMs || 30000,
    };
    let capture = runMaaCoreScreencap(captureOptions);
    let bgr = fs.readFileSync(capture.bgrPath);
    let sampled = sampleSettlementStars(bgr);

    if (!sampled.recognized && isFailureContinueScreen(bgr)) {
      fs.rmSync(capture.bgrPath, { force: true });
      capture = runMaaCoreScreencap({ ...captureOptions, click: RESULT_CONTINUE_CLICK });
      bgr = fs.readFileSync(capture.bgrPath);
      sampled = sampleSettlementStars(bgr);
      warnings.push("Initial result screen had no settlement stars; clicked once and resampled.");
    } else if (!sampled.recognized) {
      warnings.push("Settlement stars were not recognized; skipped result-screen click.");
    }

    let debugScreenshotPath = capture.screenshotPath && fs.existsSync(capture.screenshotPath)
      ? capture.screenshotPath
      : undefined;
    if (!debugScreenshotPath && bgr.length >= SCREEN_BYTES) {
      debugScreenshotPath = path.join(debugDir, "screenshot.bmp");
      writeBmpFromBgr(bgr, debugScreenshotPath);
    }
    fs.rmSync(capture.bgrPath, { force: true });

    const observation: ScreenObservation = {
      ...sampled,
      debugScreenshotPath,
      debugSamplesPath,
      maaVersion: capture.maaCoreVersion || connect.maaCoreVersion || undefined,
      message: sampled.recognized
        ? `Screen observer sampled settlement stars: ${sampled.stars}.`
        : "Screen observer captured current MAA screenshot, but settlement stars were not recognized.",
      warnings,
    };
    writeDebugSamples(debugSamplesPath, observation);
    return observation;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const observation = unknownObservation(
      debugSamplesPath,
      `Screen observer capture failed: ${message}`,
      "SCREEN_OBSERVER_CAPTURE_FAILED",
      warnings,
    );
    writeDebugSamples(debugSamplesPath, observation);
    return observation;
  }
}
