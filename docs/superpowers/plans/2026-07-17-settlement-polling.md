# Settlement Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wait for an MAA practice battle to reach a recognizable settlement screen before recording its result.

**Architecture:** Keep the existing MaaCore screenshot channel and failure-screen click guard. Move the wait into `observeMaaScreen`, so CLI and GUI callers share one synchronous 5-second poll loop that ends at a recognized star screen or after 90 seconds.

**Tech Stack:** TypeScript, Node.js `Atomics.wait`, Jest.

---

### Task 1: Add deterministic settlement polling

**Files:**

- Modify: `src/runner/screenObserver.ts:1-406`
- Test: `__tests__/ScreenObserver.test.ts`

- [x] **Step 1: Write the failing pure polling test**

```ts
it("polls an unrecognized frame until a settlement frame is returned", () => {
  let now = 0;
  const capture = jest.fn()
    .mockReturnValueOnce({ recognized: false })
    .mockReturnValueOnce({ recognized: false })
    .mockReturnValue({ recognized: true, stars: 0 });

  expect(pollUntilRecognized(capture, {
    maximumWaitMs: 10, intervalMs: 5,
    now: () => now, sleep: milliseconds => { now += milliseconds; },
  })).toMatchObject({ recognized: true, stars: 0 });
  expect(capture).toHaveBeenCalledTimes(3);
});
```

- [x] **Step 2: Verify the focused test fails**

Run: `npm test -- --runInBand __tests__/ScreenObserver.test.ts`

Expected: the test cannot import `pollUntilRecognized` before implementation.

- [x] **Step 3: Add the shared polling loop**

```ts
const SETTLEMENT_POLL_INTERVAL_MS = 5_000;
const SETTLEMENT_WAIT_MS = 90_000;

export function pollUntilRecognized<T extends { recognized: boolean }>(capture: () => T, options: SettlementPollOptions = {}): T {
  const now = options.now || Date.now;
  const sleep = options.sleep || sleepSynchronously;
  const deadline = now() + Math.max(0, options.maximumWaitMs ?? SETTLEMENT_WAIT_MS);
  let current = capture();
  while (!current.recognized && now() < deadline) {
    sleep(Math.min(options.intervalMs ?? SETTLEMENT_POLL_INTERVAL_MS, deadline - now()));
    current = capture();
  }
  return current;
}
```

Wrap the existing capture/sample sequence in this function inside `observeMaaScreen`. Preserve the existing failure-title click guard, allow it at most once during the poll, and write only the final sample to the debug files.

- [x] **Step 4: Run focused test and build**

Run: `npm test -- --runInBand __tests__/ScreenObserver.test.ts && npm run build:node`

Expected: polling test passes and TypeScript compiles.

### Task 2: Keep the execution contract current and rehearse

**Files:**

- Modify: `docs/cli-design.md:49`
- Modify: `docs/maa-execution.md:34,92`

- [x] **Step 1: Document the 5-second / 90-second observer policy**

State that the observer polls an unrecognized post-Copilot screen every 5 seconds for at most 90 seconds; it remains `unknown` after the deadline and does not click non-failure screens.

- [x] **Step 2: Run the complete regression suite**

Run: `npm test`

Expected: all suites pass.

- [x] **Step 3: Rehearse 11-20 and observe once**

Run: `powershell -ExecutionPolicy Bypass -File scripts/enter-practice.ps1 -Stage '11-20' -ScriptPath 'output/.candidates/practice-11-20-direction-v1.json'`, then `node dist/index.js run observe-screen --file output/.candidates/practice-11-20-direction-v1.json --mode manual-practice --maa 'D:\\app\\MAA' --pretty`.

Expected: the observer waits through the active battle and records a star result or a 90-second `unknown`, without normal-mode combat.

- [x] **Step 4: Commit the focused fix**

```bash
git add src/runner/screenObserver.ts __tests__/ScreenObserver.test.ts docs/cli-design.md docs/maa-execution.md docs/superpowers/plans/2026-07-17-settlement-polling.md
git commit -m "fix(runner): wait for settlement before observing"
```
