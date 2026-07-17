# 战斗过程截图观察 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在演习期间保存连续 MaaCore 截图，供人工定位漏怪发生前后的站位与路线。

**Architecture:** 在 `screenObserver.ts` 中复用已有 MaaCore 截图和结算星星采样，新增独立 `observeMaaBattle` 循环。它将 PNG 帧及清单写入独立目录；CLI 仅调用该函数和打印结果，不写 `RunResult` 或学习反馈。

**Tech Stack:** TypeScript、Node.js 标准库、MaaCore P/Invoke PowerShell helper、Jest。

---

## 文件结构

- `src/runner/screenObserver.ts`：过程观察返回类型、帧清单写入和观测循环；复用 `runMaaCoreScreencap` 与 `sampleSettlementStars`。
- `src/index.ts`：暴露 `run observe-battle`，为每次运行创建独立观察目录。
- `__tests__/ScreenObserver.test.ts`：覆盖帧写入、结算停止和超时。
- `__tests__/RunCli.test.ts`：覆盖 CLI 路由、默认目录及非成功状态。
- `docs/cli-design.md`、`docs/maa-execution.md`：说明只观察、无 OCR、无反馈写入的边界。

### Task 1: 过程观察器与单元测试

**Files:**

- Modify: `src/runner/screenObserver.ts`
- Modify: `__tests__/ScreenObserver.test.ts`

- [ ] **Step 1: 写入失败测试**

在 `__tests__/ScreenObserver.test.ts` mock `connectMaaEnvironment` 和现有 `childProcess.spawnSync` MaaCore 截图 helper，以可注入时钟推进采样循环，验证三个结果：

```ts
expect(observation.status).toBe("settled");
expect(observation.frames).toEqual([
  { file: "1000.png", capturedAt: 1000 },
  { file: "6000.png", capturedAt: 6000 },
]);
expect(JSON.parse(fs.readFileSync(observation.manifestPath, "utf8"))).toMatchObject({
  status: "settled",
  outcome: "partial_clear",
  stars: 2,
});
```

第二个测试令所有帧均为非结算画面，推进时钟至截止点，并断言：

```ts
expect(observation.status).toBe("timeout");
expect(observation.outcome).toBeUndefined();
expect(observation.frames).toHaveLength(3);
```

- [ ] **Step 2: 运行新测试，确认失败**

Run: `npm test -- --runInBand __tests__/ScreenObserver.test.ts`

Expected: FAIL，提示 `observeMaaBattle` 尚未导出。

- [ ] **Step 3: 写入最小观察器**

在 `src/runner/screenObserver.ts` 增加以下公开类型和函数，不修改 `observeMaaScreen`：

```ts
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
```

`observeMaaBattle` 使用 `frameDir = path.join(path.resolve(options.debugDir), "frames")`。每轮调用现有 `runMaaCoreScreencap({ ...captureOptions, debugDir: frameDir })`，把返回的 `screenshot.png` 原子改名为 `${capturedAt}.png`，再读取 BGR 给 `sampleSettlementStars`。每保存一帧就覆写 `manifest.json`；清单内部可使用 `observing`，但函数返回值只能使用已声明的四种公开状态。识别到结算即写 `settled`、星数和 `RunOutcome` 后返回。默认间隔为 5,000 毫秒，截止为 600,000 毫秒。

连接失败也创建清单并返回 `connect_failed`。截图缺少 PNG、MaaCore 抛错或 BGR 读取失败时保留已写帧和清单，返回 `capture_failed`。超过截止时间返回 `timeout`。帧文件使用 `${capturedAt}.png`；固定 5 秒间隔保证正常运行不重复，测试使用递增时钟。不要把 BMP 伪装为 PNG，不增加 OCR，不调用点击 API。

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- --runInBand __tests__/ScreenObserver.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交过程观察器**

```bash
git add src/runner/screenObserver.ts __tests__/ScreenObserver.test.ts
git commit -m "feat(runner): capture battle observation frames"
```

### Task 2: CLI 路由与集成测试

**Files:**

- Modify: `src/index.ts`
- Modify: `__tests__/RunCli.test.ts`

- [ ] **Step 1: 写入失败测试**

在 `__tests__/RunCli.test.ts` 为 `run observe-battle` 增加 mock MaaCore 截图序列。断言标准输出包含观察结果，目录位于 `.maafight/battle-observer/<uuid>/`，且没有写入 `.maafight/run-results.jsonl`：

```ts
await runCli(["run", "observe-battle", "--maa", maaDir]);
expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
  status: "settled",
  stars: 3,
});
expect(fs.existsSync(path.join(cwd, ".maafight", "run-results.jsonl"))).toBe(false);
expect(process.exitCode).toBeUndefined();
```

为超时场景追加独立测试，断言 `process.exitCode === 1`，并在该测试的 `finally` 中恢复之前的 `process.exitCode`，避免污染后续 CLI 测试。

- [ ] **Step 2: 运行新测试，确认失败**

Run: `npm test -- --runInBand __tests__/RunCli.test.ts`

Expected: FAIL，提示 `observe-battle` 不支持。

- [ ] **Step 3: 接入 CLI**

在 `src/index.ts` 导入 `observeMaaBattle`，并在 `observe-screen` 分支之前处理：

```ts
if (args.subcommand === "observe-battle") {
  const stateDir = getRuntimePaths().homeDir;
  const runId = new RunResultStore(stateDir).createRunId();
  const observation = observeMaaBattle({
    maaPath: args.maa,
    adbPath: args.adb,
    address: args.address,
    connectConfig: args.connectConfig,
    debugDir: args.debugDir || path.join(stateDir, ".maafight", "battle-observer", runId),
    userDir: path.join(stateDir, ".maafight", "maa-core"),
  });
  console.error(`Battle observer manifest: ${observation.manifestPath}`);
  console.log(JSON.stringify(observation, null, args.pretty ? 2 : 0));
  if (observation.status !== "settled") process.exitCode = 1;
  return;
}
```

同时添加 `import * as path from "path"`、帮助文本和 `observe-battle` 示例。此命令不接受 `--file`，因为它只监视已经启动的演习。

- [ ] **Step 4: 运行 CLI 测试，确认通过**

Run: `npm test -- --runInBand __tests__/RunCli.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交 CLI 路由**

```bash
git add src/index.ts __tests__/RunCli.test.ts
git commit -m "feat(cli): add battle frame observer"
```

### Task 3: 文档、全量验证与实战验证

**Files:**

- Modify: `docs/cli-design.md`
- Modify: `docs/maa-execution.md`

- [ ] **Step 1: 更新命令文档**

在两个文档中添加以下真实调用和边界：

```powershell
node dist/index.js run observe-battle --maa D:\app\MAA --pretty
```

说明输出目录包含 `frames/<unix-ms>.png` 和 `manifest.json`；命令不操作屏幕、不启动 Copilot、不读取敌人计数、不记录学习反馈；连接、截图或超时均以非零退出码返回。

- [ ] **Step 2: 构建与全量测试**

Run: `npm run build:node`

Expected: PASS。

Run: `npm test`

Expected: PASS。

- [ ] **Step 3: 演习实测**

在 11-20 启动脚本后运行：

```powershell
node dist/index.js run observe-battle --maa D:\app\MAA --pretty
```

Expected: `.maafight/battle-observer/<runId>/frames/` 至少包含一张过程 PNG，`manifest.json` 最终为 `settled` 并保存星数。若本轮未三星，查看结算前两帧，记录漏怪发生前的前线与敌方路线；不凭截图自动改写评分。

- [ ] **Step 4: 提交文档和验证结果**

```bash
git add docs/cli-design.md docs/maa-execution.md
git commit -m "docs(runner): document battle observation"
```

## 自检

- 规格的 5 秒采样、10 分钟上限、PNG 帧、清单、结算停止、超时保留、无 OCR、无自动反馈都分别由 Task 1 至 Task 3 覆盖。
- 计划不新增依赖、不改 `src/engine/`、不改 `observe-screen` 的 RunResult 行为。
- 类型命名在所有任务中一致；函数最终返回只使用 `settled | timeout | connect_failed | capture_failed` 四种公开状态，`manifest.json` 的进行中记录仅是落盘状态。
