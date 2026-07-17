import type { SpawnSyncReturns } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as probe from "../src/runner/probe";
import {
  isFailureContinueScreen,
  isPausedScreen,
  isSettlementTitleScreen,
  observeMaaBattle,
  pollUntilRecognized,
  sampleSettlementStars,
} from "../src/runner/screenObserver";

const childProcess = require("child_process") as typeof import("child_process");

const width = 1280;
const height = 720;

function blank(): Buffer {
  return Buffer.alloc(width * height * 3, 8);
}

function paint(buffer: Buffer, cx: number, cy: number, b: number, g: number, r: number): void {
  for (let y = cy - 14; y <= cy + 14; y++) {
    for (let x = cx - 14; x <= cx + 14; x++) {
      const offset = (y * width + x) * 3;
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
    }
  }
}

function paintRectangle(buffer: Buffer, minX: number, maxX: number, minY: number, maxY: number, b: number, g: number, r: number): void {
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const offset = (y * width + x) * 3;
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
    }
  }
}

function paintSettlementTitle(buffer: Buffer): void {
  paintRectangle(buffer, 45, 380, 176, 280, 255, 255, 255);
}

function paintPauseTitle(buffer: Buffer): void {
  paintRectangle(buffer, 455, 825, 275, 415, 180, 180, 180);
}

function diffuseGreyBackground(): Buffer {
  const bgr = Buffer.alloc(width * height * 3, 8);
  for (let y = 298; y <= 346; y++) {
    for (let x = 78; x <= 270; x++) {
      const offset = (y * width + x) * 3;
      if ((x + y) % 4 === 0) {
        bgr[offset] = 35;
        bgr[offset + 1] = 85;
        bgr[offset + 2] = 135;
      } else {
        const tone = 35 + ((x * 7 + y * 11) % 150);
        bgr[offset] = tone;
        bgr[offset + 1] = tone;
        bgr[offset + 2] = tone;
      }
    }
  }
  return bgr;
}

describe("sampleSettlementStars", () => {
  it("counts lit cyan-blue settlement stars", () => {
    const bgr = blank();
    paint(bgr, 102, 322, 240, 210, 50);
    paint(bgr, 174, 322, 240, 210, 50);
    paint(bgr, 246, 322, 240, 210, 50);

    expect(sampleSettlementStars(bgr)).toMatchObject({
      recognized: true,
      stars: 3,
      outcome: "clear",
    });
  });

  it("counts lit gold stars and grey unlit stars", () => {
    const bgr = blank();
    paint(bgr, 102, 322, 45, 180, 235);
    paint(bgr, 174, 322, 45, 180, 235);
    paint(bgr, 246, 322, 150, 150, 150);

    expect(sampleSettlementStars(bgr)).toMatchObject({
      recognized: true,
      stars: 2,
      outcome: "partial_clear",
    });
  });

  it("counts lit cyan-blue stars and dark grey unlit star", () => {
    const bgr = blank();
    paint(bgr, 102, 322, 240, 210, 50);
    paint(bgr, 174, 322, 240, 210, 50);
    paint(bgr, 246, 322, 45, 45, 45);

    expect(sampleSettlementStars(bgr)).toMatchObject({
      recognized: true,
      stars: 2,
      outcome: "partial_clear",
    });
  });

  it("keeps outcome unknown when star regions are not recognized", () => {
    expect(sampleSettlementStars(blank())).toMatchObject({
      recognized: false,
      outcome: "unknown",
    });
  });

  it("keeps outcome unknown when a non-result screen is uniformly grey at the star locations", () => {
    const bgr = Buffer.alloc(width * height * 3, 80);

    expect(sampleSettlementStars(bgr)).toMatchObject({
      recognized: false,
      outcome: "unknown",
    });
    expect(isFailureContinueScreen(bgr)).toBe(false);
  });

  it("does not mistake diffuse grey artwork for unlit stars", () => {
    expect(sampleSettlementStars(diffuseGreyBackground())).toMatchObject({
      recognized: false,
      outcome: "unknown",
    });
  });

  it("recognizes the mission-failed title before allowing a result-screen click", () => {
    const bgr = blank();
    paint(bgr, 150, 360, 255, 255, 255);

    expect(isFailureContinueScreen(bgr)).toBe(true);
  });

  it("requires the result title in addition to recognized stars", () => {
    const bgr = blank();
    paint(bgr, 102, 322, 240, 210, 50);
    paint(bgr, 174, 322, 240, 210, 50);
    paint(bgr, 246, 322, 240, 210, 50);

    expect(sampleSettlementStars(bgr).recognized).toBe(true);
    expect(isSettlementTitleScreen(bgr)).toBe(false);
    paintSettlementTitle(bgr);
    expect(isSettlementTitleScreen(bgr)).toBe(true);
  });

  it("recognizes the fixed pause overlay", () => {
    const bgr = blank();
    paintPauseTitle(bgr);

    expect(isPausedScreen(bgr)).toBe(true);
  });
});

describe("pollUntilRecognized", () => {
  it("polls an unrecognized frame until a settlement frame is returned", () => {
    let now = 0;
    const capture = jest.fn()
      .mockReturnValueOnce({ recognized: false })
      .mockReturnValueOnce({ recognized: false })
      .mockReturnValue({ recognized: true, stars: 0 });

    expect(pollUntilRecognized(capture, {
      maximumWaitMs: 10,
      intervalMs: 5,
      now: () => now,
      sleep: milliseconds => { now += milliseconds; },
    })).toMatchObject({ recognized: true, stars: 0 });
    expect(capture).toHaveBeenCalledTimes(3);
  });
});

describe("observeMaaBattle", () => {
  let debugDir: string;

  beforeEach(() => {
    debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-battle-observer-"));
    jest.spyOn(probe, "connectMaaEnvironment").mockReturnValue({
      maaFound: true,
      maaPath: "C:\\MAA\\MAA.exe",
      maaInstallDir: "C:\\MAA",
      maaCorePath: "C:\\MAA\\MaaCore.dll",
      maaCoreVersion: "v6.14.1",
      adbPath: "C:\\MAA\\adb.exe",
      address: "127.0.0.1:16384",
      connectConfig: "MuMuEmulator12",
      connectAttempted: true,
      connectCommand: "",
      connectExitCode: 0,
      connectSuccess: true,
      asstConnected: true,
      setUserDir: true,
      loadResource: true,
      warnings: [],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(debugDir, { recursive: true, force: true });
  });

  function screenshotResult(bgr: Buffer, frameDir: string): SpawnSyncReturns<string> {
    const bgrPath = path.join(frameDir, "screen.bgr");
    const screenshotPath = path.join(frameDir, "screenshot.png");
    fs.mkdirSync(frameDir, { recursive: true });
    fs.writeFileSync(bgrPath, bgr);
    fs.writeFileSync(screenshotPath, "png", "utf8");
    return {
      stdout: JSON.stringify({
        maaCoreVersion: "v6.14.1",
        bgrPath,
        bgrBytes: bgr.length,
        screenshotPath,
        screenshotBytes: 3,
      }),
      stderr: "",
      status: 0,
      signal: null,
      output: [null, "", ""],
      pid: 1,
    };
  }

  function bgrWithStars(stars: number): Buffer {
    const bgr = blank();
    const centers = [102, 174, 246];
    for (let index = 0; index < centers.length; index++) {
      paint(bgr, centers[index], 322, index < stars ? 240 : 150, index < stars ? 210 : 150, index < stars ? 50 : 150);
    }
    return bgr;
  }

  function bgrWithSettlement(stars: number): Buffer {
    const bgr = bgrWithStars(stars);
    paintSettlementTitle(bgr);
    return bgr;
  }

  function bgrWithPause(): Buffer {
    const bgr = blank();
    paintPauseTitle(bgr);
    return bgr;
  }

  it("saves frames until the settlement screen", () => {
    let time = 1000;
    let captures = 0;
    jest.spyOn(childProcess, "spawnSync").mockImplementation((_command, args) => {
      const script = String(args?.[args.length - 1]);
      const frameDir = script.match(/\$bgrPath = '(.+)\\screen\.bgr'/)?.[1];
      if (!frameDir) throw new Error("frame directory was not passed to MaaCore helper");
      return screenshotResult(captures++ === 0 ? blank() : bgrWithSettlement(2), frameDir);
    });

    const observation = observeMaaBattle({
      debugDir,
      now: () => time,
      sleep: (milliseconds: number) => { time += milliseconds; },
      maximumWaitMs: 10_000,
      intervalMs: 5_000,
    });

    expect(observation).toMatchObject({ status: "settled", outcome: "partial_clear", stars: 2 });
    expect(observation.frames).toEqual([
      { file: "1000.png", capturedAt: 1000 },
      { file: "6000.png", capturedAt: 6000 },
    ]);
    expect(JSON.parse(fs.readFileSync(observation.manifestPath, "utf8"))).toMatchObject({
      status: "settled",
      outcome: "partial_clear",
      stars: 2,
      frames: observation.frames,
    });
  });

  it("does not settle when battle colors only match the star regions", () => {
    let time = 1000;
    jest.spyOn(childProcess, "spawnSync").mockImplementation((_command, args) => {
      const script = String(args?.[args.length - 1]);
      const frameDir = script.match(/\$bgrPath = '(.+)\\screen\.bgr'/)?.[1];
      if (!frameDir) throw new Error("frame directory was not passed to MaaCore helper");
      return screenshotResult(bgrWithStars(3), frameDir);
    });

    const observation = observeMaaBattle({
      debugDir,
      now: () => time,
      sleep: (milliseconds: number) => { time += milliseconds; },
      maximumWaitMs: 10_000,
      intervalMs: 5_000,
    });

    expect(observation).toMatchObject({ status: "timeout" });
    expect(observation.frames).toHaveLength(3);
  });

  it("clicks play once and continues observing after a paused frame", () => {
    let time = 1000;
    const captures = [bgrWithPause(), blank(), bgrWithSettlement(2)];
    const spawn = jest.spyOn(childProcess, "spawnSync").mockImplementation((_command, args) => {
      const script = String(args?.[args.length - 1]);
      const frameDir = script.match(/\$bgrPath = '(.+)\\screen\.bgr'/)?.[1];
      if (!frameDir) throw new Error("frame directory was not passed to MaaCore helper");
      const bgr = captures.shift();
      if (!bgr) throw new Error("unexpected MaaCore capture");
      return screenshotResult(bgr, frameDir);
    });

    const observation = observeMaaBattle({
      debugDir,
      now: () => time,
      sleep: (milliseconds: number) => { time += milliseconds; },
      maximumWaitMs: 10_000,
      intervalMs: 5_000,
    });

    expect(observation).toMatchObject({ status: "settled", outcome: "partial_clear", stars: 2 });
    expect(observation.frames).toHaveLength(3);
    expect(spawn.mock.calls.some(([, args]) => String(args?.[args.length - 1]).includes("$clickX = 1205"))).toBe(true);
  });

  it("returns paused when the confirmation frame remains paused", () => {
    let time = 1000;
    const captures = [bgrWithPause(), bgrWithPause()];
    jest.spyOn(childProcess, "spawnSync").mockImplementation((_command, args) => {
      const script = String(args?.[args.length - 1]);
      const frameDir = script.match(/\$bgrPath = '(.+)\\screen\.bgr'/)?.[1];
      if (!frameDir) throw new Error("frame directory was not passed to MaaCore helper");
      const bgr = captures.shift();
      if (!bgr) throw new Error("unexpected MaaCore capture");
      return screenshotResult(bgr, frameDir);
    });

    const observation = observeMaaBattle({
      debugDir,
      now: () => time,
      sleep: (milliseconds: number) => { time += milliseconds; },
    });

    expect(observation).toMatchObject({ status: "paused" });
    expect(observation.frames).toHaveLength(2);
  });

  it("keeps captured frames when the observation times out", () => {
    let time = 1000;
    let captures = 0;
    jest.spyOn(childProcess, "spawnSync").mockImplementation((_command, args) => {
      const script = String(args?.[args.length - 1]);
      const frameDir = script.match(/\$bgrPath = '(.+)\\screen\.bgr'/)?.[1];
      if (!frameDir) throw new Error("frame directory was not passed to MaaCore helper");
      captures++;
      return screenshotResult(blank(), frameDir);
    });

    const observation = observeMaaBattle({
      debugDir,
      now: () => time,
      sleep: (milliseconds: number) => { time += milliseconds; },
      maximumWaitMs: 10_000,
      intervalMs: 5_000,
    });

    expect(observation).toMatchObject({ status: "timeout" });
    expect(observation.outcome).toBeUndefined();
    expect(observation.frames).toHaveLength(3);
    expect(captures).toBe(3);
  });
});
