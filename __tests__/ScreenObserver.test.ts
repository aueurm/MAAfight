import { sampleSettlementStars } from "../src/runner/screenObserver";

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
});
