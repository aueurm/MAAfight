# MAAfight v2

MAAfight 是一个本地 MAA copilot JSON v3 草稿生成器。默认用 GUI：选关卡，生成脚本，验证脚本，然后调用 MAA 进入演习并执行作业。

## 默认用法

1. 安装依赖。

```bash
npm install
```

2. 启动 GUI。

```bash
npm run gui
```

3. 在页面里填写 `MAA 路径`。

可以填 MAA 安装目录、`MAA.exe` 或 `MaaCore.dll`：

```text
D:\app\MAA
C:\Tools\MAA\MAA.exe
C:\Tools\MAA\MaaCore.dll
```

填过一次后会保存到 `.maafight/config.json`。如果不想在 GUI 填，也可以设置环境变量：

```powershell
$env:MAAFIGHT_MAA_PATH="D:\app\MAA"
npm run gui
```

4. 填关卡。

例如：

```text
1-7
3-8
GT-1
```

5. 可选：填 `operators JSON 文件路径`。

不填时会尝试读取 `.maafight/operators.json`。也可以在 GUI 里粘贴并保存 MAA 导出的干员库。

6. 点击 `分析并生成脚本`。

生成模式只有 `传统` 和 `DeepSeek`：

- `传统` 使用本地 v2 确定性搜索，生成通过静态校验的草稿。
- `DeepSeek` 调用 DeepSeek API 生成结构化候选，最多根据静态错误修正 3 次。候选只写入 `output/.candidates/`，不会直接发布到正式输出路径。

DeepSeek 仅为 `MANUAL` 技能生成手动开技动作；`AUTO` 与 `PASSIVE` 技能部署后由游戏自行触发。它可使用 MAA 原生的击杀、费用、费用变化、冷却和计时条件安排手动开技或撤退；多个条件按 MAA 的 AND 语义执行。

使用 DeepSeek 前，在仓库根目录的 `.env` 配置 `DEEPSEEK_API_KEY`。该文件已被 Git 忽略，不能提交。

7. 点击 `验证脚本并进入演习`。

这一步会：

- 先验证当前 JSON。
- 调用 MAA 的 `StartUp` 唤醒明日方舟。
- 复用 MAA 的关卡导航进入目标关卡详情页。
- 如果 MAA 当前不支持自动导航该关卡，页面会提示你先手动打开关卡详情页。
- 如果代理指挥开启，就先取消代理指挥。
- 点击 `演习`，进入编队页。
- 使用刚生成的 JSON 文件执行 MAA `Copilot` 作业。
- 作业结束后读取结算星级，并把结果写入可学习反馈。

建议先用演习测试新脚本。DeepSeek 候选只有在 GUI 返回三星结果后，才会复制到 `output/` 并标记为已验证；未通过演习的候选始终留在 `.candidates/`。

## MAA 和模拟器要求

- MAA 的连接设置需要已经配好。
- MAA 的 `config/gui.json` 里需要有可用的 `Connect.AdbPath`、`Connect.Address` 和 `Connect.ConnectConfig`。
- `npm run gui` 会尝试复用 MAA 的模拟器启动配置启动 MuMu；如果没有配置，也可以手动先启动模拟器。

## 常用 CLI

GUI 是默认入口；下面这些命令用于调试或批处理。

```bash
npm run build
node dist/index.js generate --stage GT-1 --output GT-1.json --pretty
node dist/index.js validate --file GT-1.json
node dist/index.js run probe --pretty
node dist/index.js run connect --maa D:\app\MAA --pretty
```

## 使用提示

- 部分活动或插曲关卡需要手动打开到关卡详情页后再执行。
- DeepSeek 候选的静态错误会在同一次生成中回传给下一轮 API 请求；它不会被当成已通关作业。
- 输出目录和文件名可以留空，系统会自动使用默认值。

## 更多文档

- [架构说明](docs/architecture.md)
- [算法边界](docs/algorithm-boundary.md)
- [MAA 执行评估层](docs/maa-execution.md)
- [导出契约](docs/maa-copilot-export-contract.md)
