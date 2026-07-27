import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { connectMaaEnvironment, resolveMaaAdbCaptureEnvironment, type MaaConnectOptions } from "./probe";
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
const SETTLEMENT_POLL_INTERVAL_MS = 5_000;
// ponytail: fixed window covers Copilot completing before the battle; expose configuration only if a slower client actually needs it.
const SETTLEMENT_WAIT_MS = 90_000;
const BATTLE_FRAME_INTERVAL_MS = 5_000;
const BATTLE_FRAME_WAIT_MS = 600_000;

const STAR_ROIS = [
  { name: "star1", cx: 102, cy: 322, radius: 24 },
  { name: "star2", cx: 174, cy: 322, radius: 24 },
  { name: "star3", cx: 246, cy: 322, radius: 24 },
] as const;
const SETTLEMENT_TITLE_ROI = { minX: 45, maxX: 380, minY: 176, maxY: 280 };
const SETTLEMENT_TITLE_BRIGHT_RATIO = 0.15;
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

export type BattleObservationStatus = "settled" | "timeout" | "connect_failed" | "capture_failed";

export interface BattleFrame {
  file: string;
  capturedAt: number;
}

export interface BattleObservation {
  status: BattleObservationStatus;
  frames: BattleFrame[];
  frameDir: string;
  manifestPath: string;
  outcome?: RunOutcome;
  stars?: number;
  warnings: string[];
}

export interface BattleObserverOptions extends ScreenObserverOptions {
  maximumWaitMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => void;
}

export interface SettlementPollOptions {
  maximumWaitMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => void;
}

interface CaptureResult {
  maaCoreVersion: string | null;
  bgrPath: string;
  bgrBytes: number;
  screenshotPath?: string;
  screenshotBytes?: number;
}

interface CapturedSettlement {
  capture: CaptureResult;
  bgr: Buffer;
  sampled: StarObservation;
  recognized: boolean;
}

type BattleManifest = Omit<BattleObservation, "status"> & {
  status: BattleObservationStatus | "observing";
};

type MaaCoreScreencapOptions = Required<Pick<ScreenObserverOptions, "debugDir" | "userDir">> & {
  maaInstallDir: string;
  adbPath: string;
  address: string;
  connectConfig: string;
  timeoutMs: number;
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

function sleepSynchronously(milliseconds: number): void {
  const duration = Math.max(0, Math.floor(milliseconds));
  if (duration > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

export function pollUntilRecognized<T extends { recognized: boolean }>(
  capture: () => T,
  options: SettlementPollOptions = {},
): T {
  const now = options.now || Date.now;
  const sleep = options.sleep || sleepSynchronously;
  const deadline = now() + Math.max(0, options.maximumWaitMs ?? SETTLEMENT_WAIT_MS);
  const interval = Math.max(1, options.intervalMs ?? SETTLEMENT_POLL_INTERVAL_MS);
  let current = capture();
  while (!current.recognized && now() < deadline) {
    sleep(Math.min(interval, deadline - now()));
    current = capture();
  }
  return current;
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

export function isSettlementTitleScreen(bgr: Buffer, width = WIDTH, height = HEIGHT): boolean {
  if (bgr.length < width * height * BYTES_PER_PIXEL) return false;

  let brightPixels = 0;
  let pixels = 0;
  for (let y = SETTLEMENT_TITLE_ROI.minY; y <= SETTLEMENT_TITLE_ROI.maxY; y++) {
    for (let x = SETTLEMENT_TITLE_ROI.minX; x <= SETTLEMENT_TITLE_ROI.maxX; x++) {
      const offset = (y * width + x) * BYTES_PER_PIXEL;
      if (isBrightWhite(bgr[offset], bgr[offset + 1], bgr[offset + 2])) brightPixels++;
      pixels++;
    }
  }
  // ponytail: calibrated against real 11-20 result and battle frames; use OCR only if the client result layout changes.
  return brightPixels / pixels >= SETTLEMENT_TITLE_BRIGHT_RATIO;
}

function isVerifiedSettlement(bgr: Buffer, sampled: StarObservation): boolean {
  return sampled.recognized && isSettlementTitleScreen(bgr);
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
  const script = [
    `$dir = ${powershellLiteral(options.maaInstallDir)}`,
    `$userDir = ${powershellLiteral(options.userDir)}`,
    `$resourceDir = ${powershellLiteral(options.maaInstallDir)}`,
    `$adb = ${powershellLiteral(options.adbPath)}`,
    `$address = ${powershellLiteral(options.address)}`,
    `$config = ${powershellLiteral(options.connectConfig)}`,
    `$bgrPath = ${powershellLiteral(bgrPath)}`,
    `$screenshotPath = ${powershellLiteral(screenshotPath)}`,
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

function decodeAdbScreencap(raw: Buffer): Buffer {
  if (raw.length < 12) throw new Error("adb screencap returned no header");
  const width = raw.readUInt32LE(0);
  const height = raw.readUInt32LE(4);
  const format = raw.readUInt32LE(8);
  const imageBytes = width * height * 4;
  const headerBytes = raw.length - imageBytes;
  // ponytail: normalize Android's 12/16-byte RGBA headers and 16:9 frames for the fixed-coordinate recognizer.
  if (width * HEIGHT !== height * WIDTH || format !== 1 || (headerBytes !== 12 && headerBytes !== 16)) {
    throw new Error(`unsupported adb screencap: ${width}x${height}, format ${format}, ${raw.length} bytes`);
  }
  const bgr = Buffer.alloc(SCREEN_BYTES);
  for (let y = 0; y < HEIGHT; y++) {
    const sourceY = Math.floor(y * height / HEIGHT);
    for (let x = 0; x < WIDTH; x++) {
      const sourceX = Math.floor(x * width / WIDTH);
      const source = headerBytes + (sourceY * width + sourceX) * 4;
      const target = (y * WIDTH + x) * BYTES_PER_PIXEL;
      bgr[target] = raw[source + 2];
      bgr[target + 1] = raw[source + 1];
      bgr[target + 2] = raw[source];
    }
  }
  return bgr;
}

function captureAdbBgr(adbPath: string, address: string, timeoutMs: number): Buffer {
  const result = childProcess.spawnSync(adbPath, ["-s", address, "exec-out", "screencap"], {
    encoding: "buffer",
    maxBuffer: IMAGE_BUFFER_BYTES,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    throw new Error(`adb screencap failed${detail ? `: ${detail}` : ""}`);
  }
  return decodeAdbScreencap(result.stdout);
}

function writeBattleManifest(filePath: string, observation: BattleManifest): void {
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
    const captureSettlement = (): CapturedSettlement => {
      const capture = runMaaCoreScreencap(captureOptions);
      const bgr = fs.readFileSync(capture.bgrPath);
      const sampled = sampleSettlementStars(bgr);
      if (isFailureContinueScreen(bgr)) {
        return { capture, bgr, sampled: { ...sampled, outcome: "failed", stars: 0, recognized: true }, recognized: true };
      }
      return { capture, bgr, sampled, recognized: isVerifiedSettlement(bgr, sampled) };
    };
    const { capture, bgr, sampled, recognized } = pollUntilRecognized(captureSettlement);
    if (!recognized) {
      warnings.push("Settlement result was not recognized after 90 seconds; current screen was left unchanged.");
    }

    let debugScreenshotPath = capture.screenshotPath && fs.existsSync(capture.screenshotPath)
      ? capture.screenshotPath
      : undefined;
    if (!debugScreenshotPath && bgr.length >= SCREEN_BYTES) {
      debugScreenshotPath = path.join(debugDir, "screenshot.bmp");
      writeBmpFromBgr(bgr, debugScreenshotPath);
    }
    fs.rmSync(capture.bgrPath, { force: true });

    const finalSample = recognized
      ? sampled
      : { ...sampled, outcome: "unknown" as const, stars: undefined, recognized: false };
    const observation: ScreenObservation = {
      ...finalSample,
      debugScreenshotPath,
      debugSamplesPath,
      maaVersion: capture.maaCoreVersion || connect.maaCoreVersion || undefined,
      message: recognized
        ? `Screen observer sampled settlement stars: ${finalSample.stars}.`
        : "Screen observer captured current MAA screenshot, but the settlement result was not recognized.",
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

export function observeMaaBattle(options: BattleObserverOptions): BattleObservation {
  const debugDir = path.resolve(options.debugDir);
  const frameDir = path.join(debugDir, "frames");
  const manifestPath = path.join(debugDir, "manifest.json");
  const frames: BattleFrame[] = [];
  const now = options.now || Date.now;
  const sleep = options.sleep || sleepSynchronously;
  const warnings: string[] = [];
  const finish = (status: BattleObservationStatus, extra: Pick<BattleObservation, "outcome" | "stars"> = {}): BattleObservation => {
    const observation = { status, frames, frameDir, manifestPath, warnings, ...extra };
    writeBattleManifest(manifestPath, observation);
    return observation;
  };

  fs.mkdirSync(frameDir, { recursive: true });
  const captureEnvironment = resolveMaaAdbCaptureEnvironment(options);
  warnings.push(...captureEnvironment.warnings);
  if (!captureEnvironment.adbPath || !captureEnvironment.address) {
    return finish("connect_failed");
  }
  const deadline = now() + Math.max(0, options.maximumWaitMs ?? BATTLE_FRAME_WAIT_MS);
  const interval = Math.max(1, options.intervalMs ?? BATTLE_FRAME_INTERVAL_MS);
  let lastCapturedAt = -1;
  const captureFrame = (): { bgr: Buffer; sampled: StarObservation } => {
    const capturedAt = Math.max(now(), lastCapturedAt + 1);
    lastCapturedAt = capturedAt;
    const bgr = captureAdbBgr(captureEnvironment.adbPath!, captureEnvironment.address!, options.timeoutMs || 30000);
    const file = `${capturedAt}.bmp`;
    writeBmpFromBgr(bgr, path.join(frameDir, file));
    frames.push({ file, capturedAt });
    return { bgr, sampled: sampleSettlementStars(bgr) };
  };

  while (now() <= deadline) {
    try {
      const frame = captureFrame();
      if (isVerifiedSettlement(frame.bgr, frame.sampled)) {
        return finish("settled", { outcome: frame.sampled.outcome, stars: frame.sampled.stars });
      }
      if (isFailureContinueScreen(frame.bgr)) {
        return finish("settled", { outcome: "failed", stars: 0 });
      }
      writeBattleManifest(manifestPath, { status: "observing", frames, frameDir, manifestPath, warnings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Battle observer capture failed: ${message}`);
      return finish("capture_failed");
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    sleep(Math.min(interval, remaining));
  }

  return finish("timeout");
}
