# ADB 战斗观察器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 让 \`run observe-battle\` 在 Copilot 运行时以 ADB 只读截图保存、识别结算，不建立第二个 MaaCore 会话或注入点击。

**Architecture:** 在 \`probe.ts\` 抽出只解析 ADB 路径和设备地址的函数，复用 MAA GUI 配置但不调用 MaaCore。战斗观察器调用原始 \`adb exec-out screencap\`，把 RGBA_8888 帧转换为既有识别器使用的 BGR，并以 BMP 保存帧；结算页观察器维持现有 MaaCore 路径。

**Tech Stack:** TypeScript、Node.js \`child_process.spawnSync\`、ADB 原始 \`screencap\`、Jest。

---

## 文件职责

- \`src/runner/probe.ts\`：只读解析 MAA GUI 中的 ADB 连接信息。
- \`src/runner/screenObserver.ts\`：战斗观察器的 ADB 原始帧获取、RGBA→BGR 转换、BMP 保存；结算观察器不变。
- \`__tests__/RunResultStore.test.ts\`：验证只读 ADB 解析不启动 MaaCore。
- \`__tests__/ScreenObserver.test.ts\`：验证战斗观察器只发送 ADB \`screencap\`，不会点击或调用 MaaCore。
- \`__tests__/RunCli.test.ts\`：验证 CLI 路径仍写 manifest、不写 RunResult。
- \`docs/cli-design.md\`、\`docs/maa-execution.md\`：说明战斗观察器的只读边界和 BMP 帧。

### Task 1: 提供不连接 MaaCore 的 ADB 解析

**Files:**
- Modify: \`src/runner/probe.ts:44-60,382-430\`
- Test: \`__tests__/RunResultStore.test.ts:209-301\`

- [ ] **Step 1: 写失败测试**

导入 \`resolveMaaAdbCaptureEnvironment\`，复用现有临时 \`gui.json\` 夹具：

~~~ts
const result = resolveMaaAdbCaptureEnvironment({
  maaPath: path.join(maaDir, "MAA.exe"),
  env: { MAAFIGHT_MAA_PATH: "" },
  pathEnv: "",
});
expect(result).toMatchObject({
  adbPath,
  address: "127.0.0.1:16384",
  connectConfig: "MuMuEmulator12",
});
expect(childProcess.spawnSync).not.toHaveBeenCalled();
~~~

- [ ] **Step 2: 运行 CLI 回归测试**

Run: \`npx jest __tests__/RunResultStore.test.ts --runInBand\`

Expected: FAIL，函数尚未导出。

- [ ] **Step 3: 实现最小解析函数**

在 \`probe.ts\` 新增下列公共类型和函数；它只调用现有 \`findMaaForConnect\`、\`readMaaGuiConnectConfig\`、\`findOnPath\`，绝不调用 \`runMaaCoreConnectProbe\`：

~~~ts
export interface MaaAdbCaptureEnvironment {
  maaFound: boolean;
  maaPath: string | null;
  maaInstallDir: string | null;
  adbPath: string | null;
  address: string | null;
  connectConfig: string;
  warnings: string[];
}

export function resolveMaaAdbCaptureEnvironment(
  options: MaaConnectOptions = {}
): MaaAdbCaptureEnvironment {
  const warnings: string[] = [];
  const maa = findMaaForConnect(options, warnings);
  const guiConfig = maa ? readMaaGuiConnectConfig(maa.installDir) : {};
  const adbPath = options.adbPath || guiConfig.adbPath || findOnPath(["adb.exe", "adb"], options);
  const address = options.address || guiConfig.address || null;
  if (!maa) warnings.push("MAA not found. Use --maa <path> or set MAAFIGHT_MAA_PATH.");
  if (!adbPath) warnings.push("adb path not found. Use --adb <path> or configure MAA GUI connection.");
  if (adbPath && !existingFile(adbPath)) warnings.push("adb path does not exist: " + adbPath);
  if (!address) warnings.push("adb address is missing. Use --address <serial-or-host:port>.");
  return {
    maaFound: Boolean(maa), maaPath: maa?.path ?? null, maaInstallDir: maa?.installDir ?? null,
    adbPath: adbPath ?? null, address,
    connectConfig: options.connectConfig || guiConfig.connectConfig || "General", warnings,
  };
}
~~~

重构 \`connectMaaEnvironment\` 从该函数取 MAA、ADB、地址和 warning，再保留原有 MaaCore 连接握手。

- [ ] **Step 4: 运行相关测试**

Run: \`npx jest __tests__/RunResultStore.test.ts --runInBand\`

Expected: PASS。

- [ ] **Step 5: 提交**

~~~bash
git add src/runner/probe.ts __tests__/RunResultStore.test.ts
git commit -m "refactor(runner): resolve ADB capture without MaaCore"
~~~

### Task 2: 将战斗帧采集改为原始 ADB 截图

**Files:**
- Modify: \`src/runner/screenObserver.ts:1-150,291-331,568-650\`
- Test: \`__tests__/ScreenObserver.test.ts:191-420\`

- [ ] **Step 1: 写失败测试**

将战斗观察器 setup mock 改为 \`resolveMaaAdbCaptureEnvironment\`。用 12 字节头（1280、720、格式 1）加 RGBA 像素的 Buffer 模拟 ADB 输出，断言：

~~~ts
expect(spawn.mock.calls[0][0]).toBe("C:\\MAA\\adb.exe");
expect(spawn.mock.calls[0][1]).toEqual([
  "-s", "127.0.0.1:16384", "exec-out", "screencap",
]);
expect(spawn.mock.calls.flat().join("\n")).not.toMatch(/Asst|click|powershell/i);
expect(observation.frames[0].file).toBe("1000.bmp");
~~~

保留“结算标题加星星才结束”和“超时保留帧”案例；删除播放点击、选择页误点击与二次播放确认案例。

- [ ] **Step 2: 运行失败测试**

Run: \`npx jest __tests__/ScreenObserver.test.ts --runInBand\`

Expected: FAIL，当前实现仍调用 \`connectMaaEnvironment\` 和 MaaCore helper。

- [ ] **Step 3: 实现原始帧转换与只读捕获**

保留 \`runMaaCoreScreencap\` 给 \`observeMaaScreen\` 使用。为战斗路径新增以下最小 helper：

~~~ts
function decodeAdbScreencap(raw: Buffer): Buffer {
  if (raw.length < 12) throw new Error("adb screencap returned no header");
  const width = raw.readUInt32LE(0);
  const height = raw.readUInt32LE(4);
  const format = raw.readUInt32LE(8);
  if (width !== WIDTH || height !== HEIGHT || format !== 1 || raw.length !== 12 + width * height * 4) {
    throw new Error("unsupported adb screencap");
  }
  const bgr = Buffer.alloc(width * height * BYTES_PER_PIXEL);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = 12 + pixel * 4;
    const target = pixel * 3;
    bgr[target] = raw[source + 2];
    bgr[target + 1] = raw[source + 1];
    bgr[target + 2] = raw[source];
  }
  return bgr;
}

function captureAdbBgr(adbPath: string, address: string, timeoutMs: number): Buffer {
  const result = childProcess.spawnSync(adbPath, ["-s", address, "exec-out", "screencap"], {
    encoding: "buffer", timeout: timeoutMs, windowsHide: true,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error("adb screencap failed");
  return decodeAdbScreencap(result.stdout);
}
~~~

\`observeMaaBattle\` 用 \`resolveMaaAdbCaptureEnvironment\` 解析连接；每帧调用 \`captureAdbBgr\`，再以现有 \`writeBmpFromBgr\` 写入 \`frames/<timestamp>.bmp\`。删除播放点击、战斗 HUD / 暂停检测和观察器内的一切点击分支；暂停画面只记录为普通帧。保留结算识别、manifest、单调时间戳和失败状态。

- [ ] **Step 4: 运行测试**

Run: \`npx jest __tests__/ScreenObserver.test.ts --runInBand\`

Expected: PASS。

- [ ] **Step 5: 提交**

~~~bash
git add src/runner/screenObserver.ts __tests__/ScreenObserver.test.ts
git commit -m "fix(runner): observe battles through read-only ADB"
~~~

### Task 3: 更新 CLI 回归与运行文档

**Files:**
- Modify: \`__tests__/RunCli.test.ts:376-460\`
- Modify: \`docs/cli-design.md:51-55\`
- Modify: \`docs/maa-execution.md:34-38,94\`

- [ ] **Step 1: 写 CLI 失败测试**

将 \`observe-battle\` mock 改为返回原始 RGBA 截图。断言 CLI 调用 \`adb -s <address> exec-out screencap\`，没有 PowerShell / MaaCore helper，仍输出 settled manifest，且不写 \`run-results.jsonl\`。

- [ ] **Step 2: 运行失败测试**

Run: \`npx jest __tests__/RunCli.test.ts --runInBand\`

Expected: PASS；Task 2 已实现 ADB 捕获，此测试覆盖 CLI 参数传递路径。

- [ ] **Step 3: 更新文档和 CLI 测试**

将两份文档的 \`run observe-battle\` 描述统一为：通过 ADB 原始 \`exec-out screencap\` 每 5 秒保存 BMP；只读、无 MaaCore 连接、无点击。保留 \`observe-screen\` 的 MaaCore 结算页说明。CLI 不新增参数或状态字段。

- [ ] **Step 4: 运行完整验证**

Run: \`npm run build:node && npm test\`

Expected: build 成功；全部 Jest suites PASS。

- [ ] **Step 5: 提交**

~~~bash
git add __tests__/RunCli.test.ts docs/cli-design.md docs/maa-execution.md
git commit -m "docs(runner): document read-only battle observation"
~~~

## 自检

- “无第二 MaaCore 会话”由 Task 1 的零 spawn 断言与 Task 2 的 ADB 命令断言覆盖。
- “无点击”由 Task 2 的命令文本断言覆盖，并由 Task 2 删除播放恢复代码。
- “保留结算识别与帧”由 Task 2 的结算、超时和 manifest 用例覆盖。
- 计划不涉及 engine、copilot 或 pipeline，符合不改脚本生成的范围。
