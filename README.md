# MAAfight

> 预览版：本项目当前是 **MAA copilot JSON v3 本地生成工具**，不是 AI 驱动工具。

MAAfight 是一个 TypeScript / Node.js CLI 与本地 Web GUI 工具。它读取 [PRTS.Map](https://map.ark-nights.com/) 关卡数据，分析地图、路线、敌人波次和可部署位置，生成可导入 MAA 的 copilot JSON v3。

MAAfight 只负责生成脚本。它不执行战斗，不调用 ADB，不做图像识别，不修改 MAA，也不提供在线服务。

当前版本适合小范围测试。生成结果仍需要人工检查关卡名、干员、部署顺序、朝向和技能逻辑后再导入 MAA。

## 当前能力

- 通过关卡代号或 PRTS.Map 内部 ID 生成 MAA copilot JSON v3。
- 支持本地 Web GUI：源码目录使用 `npm run gui`；安装或 `npm link` 后可用 `maafight gui`。
- 支持 Windows-first 内测发布包：`npm run release:preview`。
- 支持关卡搜索、关卡信息查看、战术分析、脚本验证。
- 支持 MAA 干员识别导出的 operators JSON，用于优先选择玩家拥有的干员。
- 支持 `.maafight/operators.json` 本地干员库，初始化后生成时自动加载。
- 支持 GUI 里粘贴 operators JSON 并保存为默认干员库。
- 支持生成日志与“复制调试信息”，便于内测反馈。

## 快速开始

```bash
npm install
npm run build

# 启动本地 Web GUI
npm run gui

# 或直接用 CLI 生成
node dist/index.js generate --stage GT-1 --output script.json --pretty
```

注意：npm script 需要用 `npm run build`，不是 `npm build`。

GUI 默认打开：

```text
http://localhost:14514
```

如果端口被占用，会自动尝试 `14515` 到 `14523`。

## GUI 使用

```bash
# 源码目录开发运行
npm run gui

# 安装为命令或执行 npm link 后
maafight gui
```

GUI 第一版是“生成控制台”，包含：

- 关卡 ID / 关卡名输入与候选提示。
- operators JSON 文件选择、路径输入、JSON 粘贴保存。
- 编队模式：固定编队（fixed）、分组替换（groups）、混合模式（hybrid）。
- pretty JSON 开关。
- 输出目录和文件名设置。
- 分析关卡、生成脚本、验证脚本、打开输出目录。
- 成功后显示完整 `outputPath`。
- JSON 预览和复制 JSON。
- 复制调试信息。

浏览器文件选择不会暴露完整本地路径，所以 GUI 会读取所选 JSON 文件内容用于生成；如果需要按路径读取，也可以手动输入完整文件路径。

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

测试者使用方式：

1. 解压 zip。
2. 双击 `start-gui.bat`。
3. 浏览器打开本地 GUI。
4. 生成脚本。
5. 在包内 `output/` 找到生成的 JSON。

发布包目录结构：

```text
MAAfight-GUI-v{version}-preview-win-x64/
  app/
    dist/
    web-dist/
    package.json
    node_modules/
  output/
  cache/
  logs/
  examples/
  start-gui.bat
  README-TEST.md
  VERSION.txt
```

`start-gui.bat` 会设置：

- `MAAFIGHT_HOME`：解压后的包根目录。
- `MAAFIGHT_OUTPUT_DIR`：包内 `output/`。
- `MAAFIGHT_CACHE_DIR`：包内 `cache/`。
- `MAAFIGHT_LOG_DIR`：包内 `logs/`。
- `MAAFIGHT_WEB_ROOT`：包内 `app/web-dist`。

如果 `runtime/node.exe` 存在，会优先使用它；否则使用系统 `node`。

## 干员库

初始化本地干员库：

```bash
maafight init --operators Arknights_OperBox_Export.json
maafight init --operators-stdin
```

初始化后会写入：

```text
.maafight/
  config.json
  operators.json
```

`operators.json` 只保存 MAA 识别结果里 `own: true` 的干员。之后 `generate` 和 GUI 默认会加载这份本地干员库。

查看统计：

```bash
maafight operators info
maafight operators info --operators Arknights_OperBox_Export.json
```

如果没有初始化，生成器会退回默认干员池。当前选人逻辑仍是规则驱动和预设池驱动，不是 AI 自动理解每个账号的完整打法。

## CLI 命令

### generate

生成作战脚本。

```bash
maafight generate --stage <关卡ID或关卡代号> [--output <路径>] [--pretty] [--no-cache]
maafight generate --data <本地PRTS.Map JSON> [--stage <名称>] [--output <路径>]

maafight generate --stage GT-1 --output script.json --pretty
maafight generate --stage 3-8 --operators my_operators.json
maafight generate --stage GT-1 --explain
```

`--stage` 可以传游戏内关卡代号，例如 `GT-1`，也可以传内部 ID，例如 `a001_01`。

`--data` 用于直接读取本地 PRTS.Map 关卡 JSON，适合调试未收录或索引不完整的关卡。

### analyze

只分析关卡，不生成脚本。

```bash
maafight analyze --stage GT-1 --pretty
maafight analyze --data ./level_GT-1.json --pretty
```

输出包含敌人构成、难度评级、干员需求、关键时机和建议策略。

### validate

验证已有 copilot JSON。

```bash
maafight validate --file script.json
```

会检查基础格式、action 合法性、部署坐标、MAA copilot v3 协议兼容性，并输出评分。

### list

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

### info

查看关卡详情。

```bash
maafight info --stage GT-1
maafight info --data ./level_GT-1.json
```

输出地图尺寸、部署点、路线数、波次数、敌人类型、部署上限和初始费用。

## 关卡输入建议

优先使用游戏内可见关卡代号，例如：

```text
GT-1
0-1
3-8
H5-1
```

如果不知道准确关卡代号：

```bash
maafight list --search <关键词>
maafight info --stage <查到的code或stageId>
```

`list` 输出中的 `code` 是游戏内可见关卡代号，`stageId` 是 PRTS.Map 内部 ID。例如 `a001_01` 对应 `GT-1`。

更多实测关卡见 [docs/test-levels.md](docs/test-levels.md)。

## 工作流程

```text
关卡 ID / 关卡代号
  -> PRTSMapLoader 读取关卡 JSON
  -> PRTSMapAdapter 转换为内部 MapData
  -> BattleAnalyzer 规则分析敌人、路线和难度
  -> ScriptGenerator 生成部署与技能动作
  -> ScriptValidator / MAAProtocolValidator 校验
  -> ScriptExporter 导出 MAA copilot JSON v3
```

当前分析和生成逻辑是规则驱动：

- 使用 PRTS.Map 的真实地图、路线、波次和敌人属性。
- 根据部署点、路线方向和分析结果推断部署顺序与朝向。
- 根据默认干员池或玩家干员库选择候选干员。
- 输出 JSON 供 MAA 导入执行。

## 运行目录与环境变量

普通开发运行时，默认目录基于当前项目目录。

发布包运行时，`start-gui.bat` 会设置 `MAAFIGHT_HOME`，默认目录都落在解压目录内。

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `MAAFIGHT_HOME` | 本地运行根目录 | 当前工作目录 |
| `MAAFIGHT_OUTPUT_DIR` | GUI 默认输出目录 | `$MAAFIGHT_HOME/output` |
| `MAAFIGHT_CACHE_DIR` | PRTS.Map 缓存目录 | `$MAAFIGHT_HOME/cache` |
| `MAAFIGHT_LOG_DIR` | GUI 日志目录 | `$MAAFIGHT_HOME/logs` |
| `MAAFIGHT_WEB_ROOT` | GUI 前端静态资源目录 | 开发：`web/dist`；发布包：`app/web-dist` |
| `MAAFIGHT_DATA_URL` | PRTS.Map 数据源 | `https://map.ark-nights.com` |

GUI 生成时会实际写入后端文件系统。默认输出目录是 `output/`，页面成功后会显示完整保存路径。

## 日志与反馈

GUI 启动和生成动作会写入：

```text
logs/gui.log
```

日志会记录版本、端口、目录、关卡、编队模式、输出路径、warnings/errors 数量。

日志不会记录完整 operators JSON。

内测反馈建议提供：

- GUI 里的“复制调试信息”。
- `logs/gui.log`。
- 出问题的关卡 ID、编队模式、页面 warnings/errors。
- 如生成成功但效果不对，再提供对应 `output/*.json`。

## 开发与验证

```bash
npm install
npm run build
npm test
node scripts/benchmark.js --skip-build
npm run release:preview
```

常用脚本：

| 脚本 | 作用 |
| --- | --- |
| `npm run build` | 编译 TypeScript 并构建 Web GUI |
| `npm test` | 运行 Jest 覆盖率测试 |
| `npm run gui` | 构建并启动本地 GUI |
| `npm run benchmark` | 跑关卡生成 benchmark |
| `npm run release:preview` | 生成 Windows 内测包目录和 zip |

## 项目结构

```text
src/
  adapter/    PRTS.Map -> 内部 MapData 转换
  battle/     分析、生成、验证、导出
  core/       GUI/SDK 复用的 pipeline
  gui/        Fastify 本地 GUI server
  loader/     PRTS.Map 关卡与敌人数据加载
  player/     MAA operators JSON 解析与本地配置
  runtime/    MAAFIGHT_HOME、output/cache/logs 路径和日志
  shared/     干员池与共享数据
web/          Vite + React GUI
scripts/      benchmark 与 release 打包脚本
docs/         设计、审计、实测关卡和数据格式文档
```

## 相关文档

| 文档 | 说明 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 架构与模块划分 |
| [docs/data-format.md](docs/data-format.md) | 内部数据和 copilot JSON 格式 |
| [docs/prts-map-adapter.md](docs/prts-map-adapter.md) | PRTS.Map 适配设计 |
| [docs/battle-analyzer-v2.md](docs/battle-analyzer-v2.md) | 战术分析逻辑 |
| [docs/cli-design.md](docs/cli-design.md) | CLI 设计 |
| [docs/maa-operator-export.md](docs/maa-operator-export.md) | MAA 干员导出格式 |
| [docs/test-levels.md](docs/test-levels.md) | 实测关卡结果 |

## 许可证

MIT
