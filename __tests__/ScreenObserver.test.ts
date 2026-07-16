import { isFailureContinueScreen, pollUntilRecognized, sampleSettlementStars } from "../src/runner/screenObserver";

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
