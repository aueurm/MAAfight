# CLI 与 GUI 使用说明

## 概述

MAAfight 提供 CLI 和本地 Web GUI 两种入口。

两者使用同一套生成主链路：

```text
PRTS.Map 数据 -> MapData -> TacticalAnalysis -> BattleScript -> MAA copilot JSON v3
```

CLI 入口在 `src/index.ts`。GUI server 在 `src/gui/server.ts`，复用 `src/core/pipeline.ts`。

MAAfight 只生成脚本草稿，不执行战斗，不调用 ADB，也不承诺生成脚本一定通关。

## 快速命令

```bash
npm install
npm run build
npm run gui

node dist/index.js generate --stage GT-1 --output script.json --pretty
node dist/index.js validate --file script.json
```

安装或 `npm link` 后可直接使用：

```bash
maafight gui
maafight generate --stage GT-1 --output script.json --pretty
```

## 命令总览

```text
maafight <command> [options]
```

| 命令 | 作用 |
| --- | --- |
| `generate` | 生成 MAA copilot JSON v3 |
| `analyze` | 只输出战斗分析结果 |
| `validate` | 验证已有脚本 |
| `list` | 搜索或列出关卡 |
| `info` | 查看关卡基础信息 |
| `init` | 初始化本地玩家干员库 |
| `operators info` | 查看玩家干员库统计 |
| `gui` | 启动本地 Web GUI |

## `generate`

生成作战脚本。

```bash
maafight generate --stage <关卡ID或关卡代号> [options]
maafight generate --data <本地PRTS.Map JSON> [options]
```

常用示例：

```bash
maafight generate --stage GT-1 --output script.json --pretty
maafight generate --stage 3-8 --operators Arknights_OperBox_Export.json
maafight generate --stage GT-1 --explain
maafight generate --data ./level_custom.json --stage CUSTOM-1 --output custom.json
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--stage`, `-s` | 关卡代号、内部 ID 或索引可解析输入 |
| `--data`, `-d` | 使用本地 PRTS.Map JSON，跳过索引下载 |
| `--output`, `-o` | 输出文件路径；未指定时输出到 stdout |
| `--pretty` | 美化 JSON |
| `--no-cache` | 强制重新下载关卡 JSON |
| `--operators` | 使用 MAA 干员识别导出的 JSON |
| `--config` | 读取生成器配置 JSON |
| `--explain` | 将规划解释、风险和部署原因输出到 stderr |
| `--quiet` | 减少非 JSON 日志 |

当 `--output` 未指定时，stdout 应保持 JSON 可解析；warning 和 explain 文本走 stderr。

默认导出使用固定编队模式：`opers` 尽量补满 12 名真实干员，`actions[].name` 默认引用真实干员名，`groups` 为空。需要候选替换时再显式选择 `groups` 模式。

未指定输出文件名时，GUI / pipeline 会优先使用“关卡编号 + 关卡名”的文件名，例如 `CF-9_决战！燃烧的狩魂！.json`。

导出字段约束见 [MAA Copilot 导出契约](maa-copilot-export-contract.md)。尤其注意：不要把 `先锋：伊内丝 / 风笛`、`[Lv.7]`、`不使用模组` 这类展示文本写进任何干员 `name` 字段。

## `analyze`

只分析关卡，不生成脚本。

```bash
maafight analyze --stage GT-1 --pretty
maafight analyze --data ./level_GT-1.json --pretty
```

输出包含：

- 敌人组成。
- 难度评级。
- 职业需求。
- 关键时机。
- `pressureWindows`。
- `recommendedTasks`。
- `battlePlan`。

## `validate`

验证已有 copilot JSON。

```bash
maafight validate --file script.json
```

验证包括两层：

- `ScriptValidator`：检查内部结构、坐标和 action 合法性。
- `MAAProtocolValidator`：检查 MAA copilot v3 协议兼容性。

协议 warning 不等于脚本一定不可用。它用于提示 MAA schema 或执行侧可能不支持的字段和 action。

## `list`

搜索或列出关卡。

```bash
maafight list --search GT
maafight list --category main
maafight list --category weekly --limit 20
```

常见类别：

```text
main, hard, campaign, weekly, crisis, activity
```

`list` 输出中的 `code` 通常是游戏内可见关卡代号，`stageId` 是 PRTS.Map 内部 ID。

## `info`

查看关卡基础信息。

```bash
maafight info --stage GT-1
maafight info --data ./level_GT-1.json
```

输出地图尺寸、部署点数量、路线数、波次数、敌人类型、部署上限和初始费用。

## `init` 与 `operators info`

初始化本地玩家干员库：

```bash
maafight init --operators Arknights_OperBox_Export.json
maafight init --operators-stdin
```

初始化后写入：

```text
.maafight/
  config.json
  operators.json
```

查看统计：

```bash
maafight operators info
maafight operators info --operators Arknights_OperBox_Export.json
```

生成时如果未显式传 `--operators`，会尝试加载 `.maafight/operators.json`。没有本地干员库时，生成器回退到默认干员池。

## `gui`

启动本地 Web GUI。

```bash
npm run gui
maafight gui
```

默认端口：

```text
http://localhost:14514
```

如果端口被占用，会尝试 `14515` 到 `14523`。

GUI 目前是本地生成控制台，支持：

- 关卡输入和候选提示。
- operators JSON 文件选择、路径输入、粘贴保存。
- 编队模式：默认 `fixed`，可显式选择 `groups` 或 `hybrid`。
- pretty JSON 开关。
- 输出目录和文件名设置。
- 分析、生成、验证。
- JSON 预览和复制。
- 复制调试信息。

## Windows 内测包

生成内测包：

```bash
npm run release:preview
```

生成结果：

```text
release/
  MAAfight-GUI-v{version}-preview-win-x64/
  MAAfight-GUI-v{version}-preview-win-x64.zip
```

测试者解压后双击 `start-gui.bat`，浏览器会打开本地 GUI。

`start-gui.bat` 会设置：

- `MAAFIGHT_HOME`
- `MAAFIGHT_OUTPUT_DIR`
- `MAAFIGHT_CACHE_DIR`
- `MAAFIGHT_LOG_DIR`
- `MAAFIGHT_WEB_ROOT`

如果包内存在 `runtime/node.exe`，会优先使用它；否则使用系统 `node`。

## 环境变量

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `MAAFIGHT_HOME` | 本地运行根目录 | 当前工作目录 |
| `MAAFIGHT_OUTPUT_DIR` | GUI 默认输出目录 | `$MAAFIGHT_HOME/output` |
| `MAAFIGHT_CACHE_DIR` | PRTS.Map 缓存目录 | `$MAAFIGHT_HOME/cache` |
| `MAAFIGHT_LOG_DIR` | GUI 日志目录 | `$MAAFIGHT_HOME/logs` |
| `MAAFIGHT_WEB_ROOT` | GUI 前端静态资源目录 | 开发：`web/dist`；发布包：`app/web-dist` |
| `MAAFIGHT_DATA_URL` | PRTS.Map 数据源 | `https://map.ark-nights.com` |

## 退出码

当前 CLI 主要以 `0` 表示成功，非 `0` 表示参数、文件、网络、解析或生成过程失败。

不要依赖细分退出码做稳定集成；如果需要机器读取结果，优先读取 stdout JSON 或 `validate` 输出。
