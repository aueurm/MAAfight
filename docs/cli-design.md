# v2 CLI 与 GUI

## CLI

```bash
maafight generate --stage GT-1 --output GT-1.json --pretty
maafight generate --data ./level_GT-1.json --stage GT-1 --output GT-1.json
maafight generate --stage GT-1 --new-candidate
maafight analyze --stage GT-1 --pretty
maafight validate --file GT-1.json
maafight feedback record --file GT-1.json --killed 42 --total 42
maafight feedback summary --stage GT-1
maafight run --file GT-1.json --mode manual-practice
maafight run probe --maa C:\Tools\MAA
maafight run connect --maa C:\Tools\MAA
maafight run observe-screen --file GT-1.json --maa C:\Tools\MAA
maafight run --file GT-1.json --callback-log maa-callback.jsonl
maafight run summary --stage GT-1
maafight gui
```

生成参数：

| 参数 | 说明 |
| --- | --- |
| `--stage` | 正式关卡编号或内部 ID |
| `--data` | 本地 PRTS.Map JSON |
| `--output` | 输出文件；省略时 JSON 写入 stdout |
| `--operators` | 玩家干员库 |
| `--requirements none\|player` | 默认省略或导出玩家真实要求 |
| `--new-candidate` | 不复用已有 100% 实测结果 |
| `--explain` | 向 stderr 输出事实摘要与候选评分 |

v2 没有生成器或编队模式选项。stdout 输出 JSON 时，warning 和 explain 必须走 stderr。

执行评估命令形态：

```bash
maafight run --file GT-1.json --mode manual-practice
maafight run probe --maa C:\Tools\MAA
maafight run connect --maa C:\Tools\MAA --address 127.0.0.1:16384
maafight run observe-screen --file GT-1.json --maa C:\Tools\MAA --address 127.0.0.1:16384
maafight run --file GT-1.json --callback-log maa-callback.jsonl
maafight run summary --stage GT-1
maafight run --file GT-1.json --mode manual-normal --allow-sanity
```

当前 `run` 实现了 dry-run skeleton、MAA callback import、结算页截图观察、结果 summary、`run probe` 环境探测和 `run connect` MaaCore 连接握手：dry-run 只读取并校验脚本、写入 `source: "dry_run"` 的 `RunResult`，不会调用 MAA、ADB 或模拟器，也不计入真实通过率。传入 `--callback-log` 时只导入已有 MAA 回调 JSON / JSONL，识别 `StageDrops` 并写入 `source: "maa_callback"` 的 `RunResult`。

`run observe-screen` 在 Copilot 已结束、画面停留在结算页时使用 MaaCore `AsstAsyncScreencap` + `AsstGetImageBgr` / `AsstGetImage` 获取当前截图，只采样固定星星区域颜色，不做 OCR，不直接调用 `adb shell screencap`。识别不到星星时写入 `source: "screen_observer"`、`outcome: "unknown"`，并保留 debug screenshot 与 `samples.json`。

`run probe` 只检查本机 MAA / ADB 是否存在，并最多调用 `MaaPiCli.exe --help` / `--version` / `-h` 或 MaaCore `AsstGetVersion` 这类安全只读探测，不会启动 GUI、连接游戏或开始作战。`run connect` 只调用 MaaCore `AsstCreate`、`AsstConnect`、`AsstConnected` 和 `AsstDestroy`，不追加任务、不调用 `AsstStart`，不执行 `Fight` 或 `SingleStep`；connect 成功只代表 MaaCore 已连上 adb 目标，不代表可以实战。普通理智作战模式必须显式传入 `--allow-sanity`。

## GUI API

- `GET /api/config`
- `GET /api/stages`
- `POST /api/analyze`
- `POST /api/generate`
- `POST /api/validate`
- `POST /api/feedback`
- `GET /api/feedback/summary`
- `POST /api/enter-practice`

`POST /api/enter-practice` 调用本地 `scripts/enter-practice.ps1`：用 MAA `Fight times=0` 导航到关卡详情页，截图确认后关闭已亮起的代理指挥，再点击演习入口；传入脚本路径时继续执行 MAA `Copilot` 作业，读取结算星级并把结果写入反馈。

后续执行评估接口：

- `POST /api/run`
- `GET /api/run/:id`
- `GET /api/run/summary`

`/api/config` 返回 `engine: "v2"`。`/api/generate` 只接受 v2 公共字段，不提供旧生成器选择。

## 本地目录

```text
.maafight/operators.json
.maafight/generations.jsonl
.maafight/feedback.jsonl
.maafight/run-results.jsonl
.maafight/screen-observer/<runId>/
cache/levels/
output/
logs/
```
