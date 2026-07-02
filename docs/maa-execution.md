# MAA 执行评估层

> 状态：分阶段落地中。当前 v2 已有 dry-run skeleton、MAA callback import、结算页截图观察、结果 summary、本机 MAA / ADB probe、MaaCore 连接握手和 GUI 进入演习 helper。`run` 本身仍不会启动 MAA 任务或开始作战；`enter-practice` 只导航到关卡详情页并点击演习入口。

## 目标

MAAfight 的静态评分只能用于候选排序，不能证明通关。MAA 执行评估层的目标是把生成结果接入真实运行闭环：

```text
BattleScript
  -> Navigator
  -> SafetyGate
  -> MAA Executor
  -> Observer
  -> FeedbackStore
```

执行层不进入 `src/engine/`。引擎仍只负责生成候选；执行评估层只负责调用外部 MAA、确认安全入口、观察结果并记录反馈。

## 外部能力边界

MAA 的 `Fight` 任务具有关卡导航能力，适合参考或复用导航逻辑。但 `Fight` 是理智作战入口，不选择演习模式，不能直接作为默认评测入口。

MAA 的 `Copilot` 任务可执行作业文件，并支持 `use_sanity_potion: false`、自动编队等参数。该参数只表示理智不足时不使用理智药，不等于演习模式。

MAA 的 `SingleStep` 任务支持 `copilot` 的 `stage`、`start`、`action` 子任务。它适合作为 MAAfight 自己控制演习入口后的动作执行后端。

MAA 回调中的 `SubTaskExtraInfo.what = "StageDrops"` 包含 `stage`、`drops`、`stats` 和 `stars`。`stars` 可作为短期真实通关判定来源。

当前 probe 只用于确认本机是否存在 MAA / ADB：可通过 `--maa <path>` 或 `MAAFIGHT_MAA_PATH` 指定 MAA 目录或可执行文件；自动探测 `MaaPiCli.exe`、`MAA.exe`、`MaaWpfGui.exe`、`MaaCore.dll` 和 `adb devices`。若发现 `MaaPiCli.exe`，只尝试 `--help`、`--version` 或 `-h`；若发现 `MaaCore.dll`，只通过子进程 helper 调用 `AsstGetVersion` 读取版本。不调用 `AsstConnect`、`AsstAppendTask`、`Fight` 或 `SingleStep start/action`，不启动 GUI，不连接游戏，不消耗理智。probe 成功只表示环境具备候选能力，不代表可以实战。

当前 connect 只用于 MaaCore 与 adb 目标的连接握手：优先读取 MAA GUI 配置中的 `Connect.AdbPath`、`Connect.Address` 和 `Connect.ConnectConfig`，也可通过 CLI 参数覆盖。它只调用 `AsstCreate`、`AsstConnect`、`AsstConnected` 和 `AsstDestroy`，不调用 `AsstAppendTask` 或 `AsstStart`，不会执行 `Fight`、`Copilot` 或 `SingleStep`。connect 成功只代表 MaaCore 已连上 adb 目标，不代表已进入关卡或可以开始评测。

当前 `run observe-screen` 只用于 Copilot 已结束后的结果观察：复用 MaaCore `AsstAsyncScreencap` + `AsstGetImageBgr` / `AsstGetImage` 获取当前截图，不直接调用 `adb shell screencap`。观察器只采样 1280x720 结算页固定星星区域颜色，判断 `stars = 0 / 1 / 2 / 3`；识别不到星星时保留 `outcome = "unknown"`。每次观察保留一张 debug screenshot 和 `samples.json`，用于后续校准 ROI 与阈值。

当前 `scripts/enter-practice.ps1` 和 GUI `/api/enter-practice` 是实验性演习入口：通过 MAA `Fight times=0` 复用关卡导航，确认 1280x720 关卡详情页后，若代理指挥开关亮起则先关闭，再点击演习按钮。它不点击普通开始按钮，也不执行 MAA Copilot 作业。

参考：

- [MAA 集成文档](https://docs.maa.plus/zh-cn/protocol/integration.html)
- [MAA 回调消息协议](https://docs.maa.plus/zh-cn/protocol/callback-schema.html)

## 分层职责

### Navigator

负责把游戏界面带到目标关卡入口。

可选实现：

1. `manual`：用户手动进入目标关卡页面，MAAfight 只做截图确认。
2. `maa-navigation`：参考或调用 MAA 日常 `Fight` 的关卡导航能力，但必须在普通作战开始前停住。
3. `custom-lite`：MAAfight 自己维护少量白名单入口，例如主线、物资筹备、芯片本和活动普通图。

如果 MAA 导航只能通过完整 `Fight` 任务触发，且无法在普通作战开始前停止，则不得用于默认评测。

### SafetyGate

默认只允许演习评测。

执行前必须确认：

1. 当前关卡与目标关卡一致。
2. 画面存在演习入口或已处于演习流程。
3. 未出现理智药、源石或普通作战确认入口。

确认失败时直接中止。正常理智作战只能通过显式参数开启，例如未来的 `--mode normal --allow-sanity`。

### MAA Executor

负责把 MAAfight 生成的动作交给 MAA 执行。

优先级：

1. 已安全进入演习流程后，使用 `SingleStep action` 逐条执行动作。
2. 确认不会触发普通作战时，才考虑使用完整 `Copilot` 作业执行。
3. 不使用 `Fight` 任务作为默认执行器。

### Observer

负责把 MAA 结束信号转成可学习结果。

短期使用 MAA 回调：

| 信号 | 结果 |
| --- | --- |
| `StageDrops.stars == 3` | `clear` |
| `StageDrops.stars < 3` | `partial_clear` |
| MAA 任务错误 | `execution_error` |
| 任务结束但无 `StageDrops` | `unknown` |

当前截图观察器只识别结算页星星，不做 OCR，也不读取右上角敌人计数。后续若需要实时 `killed / total`，继续复用同一 MaaCore 截图通道，只增加两个数字区域的识别。

## RunResult

执行结果应独立于现有 `FeedbackRecord` 保存，再由反馈层决定是否可用于学习。

```ts
type RunOutcome =
  | "clear"
  | "partial_clear"
  | "failed"
  | "execution_error"
  | "unknown";

interface RunResult {
  schemaVersion: 1;
  runId: string;
  scriptHash: string;
  stageId: string;
  mode: "manual-practice" | "manual-normal";
  outcome: RunOutcome;
  stars?: number;
  killed?: number;
  total?: number;
  source: "maa_callback" | "screen_observer" | "manual" | "dry_run";
  errorType?: string;
  message?: string;
  maaVersion?: string;
  emulator?: string;
  createdAt: string;
}
```

`clear` 可折算为 `killed == total`；`partial_clear` 或 `failed` 若没有截图识别结果，不应伪造 `killed / total`。

## 默认运行模式

| 模式 | 状态 | 说明 |
| --- | --- | --- |
| `manual-practice` | 首期目标 | 用户手动到关卡页，MAAfight 确认演习入口后执行。 |
| `maa-navigation-practice` | 中期目标 | 复用 MAA 导航到关卡页，再由 SafetyGate 点击演习。 |
| `manual-normal` | 调试用途 | 用户手动进入普通作战，必须显式允许理智消耗。 |
| `normal` | 默认禁用 | 自动导航并消耗理智，必须双重确认。 |

## 分阶段任务

### P0：安全半自动

- 新增 `RunMode = manual-practice | manual-normal`。
- 截图确认目标关卡。
- 截图确认演习入口。
- 识别失败时中止。

### P1：MAA 动作执行

- 封装 MAA `SingleStep action`。
- 支持 `Deploy`、`Skill`、`Retreat`、`SpeedUp` 和 `SkillDaemon` 的最小执行子集。
- 记录 `RunResult`。

### P2：结果观测

- 解析 MAA `StageDrops` 回调。
- 用 `stars` 计算真实 3 星通过率。
- 增加 `unknown` 与 `execution_error` 区分。
- 通过 `run observe-screen` 在结算页采样星星颜色，写入 `source: "screen_observer"`。

### P3：导航复用

- 参考或调用 MAA 日常关卡导航。
- 只允许导航到关卡入口，不允许默认进入普通作战。
- 白名单支持主线、资源本、芯片本和活动普通图。

### P4：截图观察器

- 识别战斗中敌人计数。
- 失败时记录最后一次有效 `killed / total`。
- 将失败样本用于候选排序调整。
