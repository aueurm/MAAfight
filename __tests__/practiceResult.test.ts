import { normalizePracticeTestResult } from "../src/shared/practiceResult";

describe("normalizePracticeTestResult", () => {
  it("maps practice entry and star outcomes to GUI labels", () => {
    expect(normalizePracticeTestResult({ ok: false })).toBe("进入失败");
    expect(normalizePracticeTestResult({ stars: 0 })).toBe("失败");
    expect(normalizePracticeTestResult({ stars: 1 })).toBe("失败");
    expect(normalizePracticeTestResult({ stars: 2 })).toBe("二星");
    expect(normalizePracticeTestResult({ stars: 3 })).toBe("三星");
  });

  it("keeps existing labels and avoids inventing a result without evidence", () => {
    expect(normalizePracticeTestResult({ testResult: "二星" })).toBe("二星");
    expect(normalizePracticeTestResult({ ok: true })).toBe("");
    expect(normalizePracticeTestResult(null, "失败")).toBe("失败");
  });
});
