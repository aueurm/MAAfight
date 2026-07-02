export type PracticeTestResult = "进入失败" | "失败" | "二星" | "三星";

export interface PracticeResultLike {
  ok?: unknown;
  outcome?: unknown;
  stars?: unknown;
  testResult?: unknown;
}

function isPracticeTestResult(value: unknown): value is PracticeTestResult {
  return value === "进入失败" || value === "失败" || value === "二星" || value === "三星";
}

export function normalizePracticeTestResult(result?: PracticeResultLike | null, fallback: PracticeTestResult | "" = ""): PracticeTestResult | "" {
  if (!result) return fallback;
  if (isPracticeTestResult(result.testResult)) return result.testResult;
  if (result.ok === false) return "进入失败";

  const stars = typeof result.stars === "number" ? result.stars : undefined;
  if (stars === 3) return "三星";
  if (stars === 2) return "二星";
  if (stars === 0 || stars === 1) return "失败";

  if (result.outcome === "clear") return "三星";
  if (result.outcome === "failed" || result.outcome === "partial_clear") return "失败";

  return fallback;
}
