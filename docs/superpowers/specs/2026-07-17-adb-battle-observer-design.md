# ADB 战斗观察器设计

## 目标

`run observe-battle` 在 Copilot 演习期间只读取 MuMu 画面，不创建第二个 MaaCore 会话，也不发送任何点击。正常作业运行优先于截图和暂停恢复。

## 范围

仅修改战斗期间的 `observeMaaBattle` / `run observe-battle`。现有的结算页 `observeMaaScreen` 保持不变，因为它不参与本次并行演习监视路径。

## 设计

1. 在 `src/runner/probe.ts` 增加一个只解析 ADB 路径、设备地址和 MAA GUI 连接配置的公共函数。它不得调用 `AsstConnect`、加载 MaaCore 或创建 MaaCore handle。
2. `observeMaaBattle` 改用该解析结果执行 `adb -s <address> exec-out screencap`。读取原始截图头的宽、高与 RGBA 格式，验证为 1280 × 720、RGBA_8888 后转换为既有星级识别使用的 BGR 缓冲区。
3. 每一帧通过现有 BMP 写入函数保存到 `frames/`。截图、暂停检测与结算识别均为只读；删除战斗观察器中的播放点击与暂停恢复状态。
4. ADB 缺失、截图命令失败或原始帧格式不符时，观察器写入 manifest 并返回已有的失败状态；不得尝试通过 MaaCore 或 ADB 点击补救。

## 数据流

```text
enter-practice.ps1 (唯一 MaaCore / Copilot 控制者)
        │
        ├── MuMu
        │
run observe-battle ── ADB screencap (只读) ──> BGR 分析 + BMP 帧 + manifest
```

## 验证

1. 单元测试模拟 ADB 原始 RGBA 帧，验证转换、帧保存和结算识别。
2. 单元测试验证暂停帧只被记录，命令参数中不出现点击或 MaaCore API。
3. 运行 Node 构建与完整测试套件；得到用户允许后，再运行一次 11-20 演习确认 Copilot 能自行持续执行。

## 不做

- 不改干员选择、费用条件或脚本动作。
- 不增加自动播放、自动暂停或任意屏幕点击。
- 不把 MAA Core 改造成可共享的长期服务。
