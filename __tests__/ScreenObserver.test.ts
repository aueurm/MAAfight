import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as probe from "../src/runner/probe";
import {
  isFailureContinueScreen,
  isSettlementTitleScreen,
  observeMaaScreen,
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

  it("recognizes the mission-failed title as a terminal result", () => {
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

describe("observeMaaScreen", () => {
  let debugDir: string;

  beforeEach(() => {
    debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-screen-observer-"));
    jest.spyOn(probe, "connectMaaEnvironment").mockReturnValue({
      maaFound: true,
      maaPath: "C:\\MAA\\MAA.exe",
      maaInstallDir: "C:\\MAA",
      maaCorePath: "C:\\MAA\\MaaCore.dll",
      maaCoreVersion: "test",
      adbPath: "C:\\MAA\\adb.exe",
      address: "127.0.0.1:16384",
      connectConfig: "MuMuEmulator12",
      connectAttempted: true,
      connectCommand: null,
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

  it("captures a settlement screen without issuing an input command", () => {
    const bgr = blank();
    paint(bgr, 102, 322, 240, 210, 50);
    paint(bgr, 174, 322, 240, 210, 50);
    paint(bgr, 246, 322, 240, 210, 50);
    paintSettlementTitle(bgr);
    const spawn = jest.spyOn(childProcess, "spawnSync").mockImplementation((_command, args) => {
      const script = String(args?.[args.length - 1] || "");
      const bgrPath = script.match(/\$bgrPath = '([^']+)'/)?.[1];
      if (!bgrPath) throw new Error("screen observer did not declare a BGR output path");
      fs.mkdirSync(path.dirname(bgrPath), { recursive: true });
      fs.writeFileSync(bgrPath, bgr);
      const stdout = JSON.stringify({ maaCoreVersion: "test", bgrPath, bgrBytes: bgr.length, screenshotBytes: 0 });
      return { stdout, stderr: "", status: 0, signal: null, output: [null, stdout, ""], pid: 1 } as never;
    });

    expect(observeMaaScreen({ debugDir, userDir: path.join(debugDir, "maa-core") })).toMatchObject({
      recognized: true,
      outcome: "clear",
      stars: 3,
    });
    expect(spawn.mock.calls.flat().join("\n")).not.toContain("AsstAsyncClick");
  });
});

describe("observeMaaBattle", () => {
  let debugDir: string;

  beforeEach(() => {
    debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-battle-observer-"));
    jest.spyOn(probe, "resolveMaaAdbCaptureEnvironment").mockReturnValue({
      maaFound: true,
      maaPath: "C:\\MAA\\MAA.exe",
      maaInstallDir: "C:\\MAA",
      adbPath: "C:\\MAA\\adb.exe",
      address: "127.0.0.1:16384",
      connectConfig: "MuMuEmulator12",
      warnings: [],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(debugDir, { recursive: true, force: true });
  });

  function adbResult(bgr: Buffer, sourceWidth = width, sourceHeight = height, headerBytes = 12) {
    const raw = Buffer.alloc(headerBytes + sourceWidth * sourceHeight * 4);
    raw.writeUInt32LE(sourceWidth, 0);
    raw.writeUInt32LE(sourceHeight, 4);
    raw.writeUInt32LE(1, 8);
    for (let y = 0; y < sourceHeight; y++) {
      const bgrY = Math.floor(y * height / sourceHeight);
      for (let x = 0; x < sourceWidth; x++) {
        const bgrX = Math.floor(x * width / sourceWidth);
        const source = (bgrY * width + bgrX) * 3;
        const target = 12 + (y * sourceWidth + x) * 4;
        raw[target] = bgr[source + 2];
        raw[target + 1] = bgr[source + 1];
        raw[target + 2] = bgr[source];
        raw[target + 3] = 255;
      }
    }
    return { stdout: raw, stderr: Buffer.alloc(0), status: 0, signal: null, output: [null, raw, Buffer.alloc(0)], pid: 1 } as never;
  }

  function mockBattleFrames(frames: Buffer[], sourceWidth = width, sourceHeight = height, headerBytes = 12) {
    return jest.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
      const bgr = frames.shift();
      if (!bgr) throw new Error("unexpected battle capture");
      if (command !== "C:\\MAA\\adb.exe") throw new Error(`unexpected capture command: ${command}`);
      expect(args).toEqual(["-s", "127.0.0.1:16384", "exec-out", "screencap"]);
      return adbResult(bgr, sourceWidth, sourceHeight, headerBytes);
    });
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

  function bgrWithMissionFailure(): Buffer {
    const bgr = blank();
    paint(bgr, 150, 360, 255, 255, 255);
    return bgr;
  }

  function bgrWithPause(): Buffer {
    const bgr = blank();
    paintPauseTitle(bgr);
    return bgr;
  }

  it("normalizes a 1600x900 capture and saves frames until the settlement screen", () => {
    let time = 1000;
    const spawn = mockBattleFrames([blank(), bgrWithSettlement(2)], 1600, 900, 16);

    const observation = observeMaaBattle({
      debugDir,
      now: () => time,
      sleep: (milliseconds: number) => { time += milliseconds; },
      maximumWaitMs: 10_000,
      intervalMs: 5_000,
    });

    expect(observation).toMatchObject({ status: "settled", outcome: "partial_clear", stars: 2 });
    expect(observation.frames).toEqual([
      { file: "1000.bmp", capturedAt: 1000 },
      { file: "6000.bmp", capturedAt: 6000 },
    ]);
    expect(spawn.mock.calls[0][0]).toBe("C:\\MAA\\adb.exe");
    expect(spawn.mock.calls[0][1]).toEqual(["-s", "127.0.0.1:16384", "exec-out", "screencap"]);
    expect(spawn.mock.calls.flat().join("\n")).not.toMatch(/Asst|click|powershell/i);
    expect(JSON.parse(fs.readFileSync(observation.manifestPath, "utf8"))).toMatchObject({
      status: "settled",
      outcome: "partial_clear",
      stars: 2,
      frames: observation.frames,
    });
  });

  it("records a mission failure terminally without controlling it", () => {
    let time = 1000;
    const spawn = mockBattleFrames([bgrWithMissionFailure()]);

    const observation = observeMaaBattle({
      debugDir,
      now: () => time,
      sleep: (milliseconds: number) => { time += milliseconds; },
      maximumWaitMs: 0,
    });

    expect(observation).toMatchObject({ status: "settled", outcome: "failed", stars: 0 });
    expect(observation.frames).toHaveLength(1);
    expect(spawn.mock.calls.flat().join("\n")).not.toMatch(/Asst|click|powershell/i);
  });

  it("does not settle when battle colors only match the star regions", () => {
    let time = 1000;
    mockBattleFrames([bgrWithStars(3), bgrWithStars(3), bgrWithStars(3)]);

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

  it("records a paused battle without controlling it", () => {
    let time = 1000;
    const spawn = mockBattleFrames([bgrWithPause()]);

    const observation = observeMaaBattle({
      debugDir,
      now: () => time,
      sleep: (milliseconds: number) => { time += milliseconds; },
      maximumWaitMs: 0,
    });

    expect(observation).toMatchObject({ status: "timeout" });
    expect(observation.frames).toHaveLength(1);
    expect(spawn.mock.calls.flat().join("\n")).not.toMatch(/Asst|click|powershell/i);
  });

  it("keeps captured frames when the observation times out", () => {
    let time = 1000;
    const spawn = mockBattleFrames([blank(), blank(), blank()]);

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
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});
