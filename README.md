# MAAfight v2

MAAfight 是一个本地 MAA copilot JSON v3 草稿生成器。默认用 GUI：选关卡，生成脚本，验证脚本，然后调用 MAA 进入演习。

它不会把静态评分当作通关率，也不会默认开始普通理智作战。

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

生成结果会写入输出目录，并显示 JSON 预览。

7. 点击 `验证脚本并进入演习`。

这一步会：

- 先验证当前 JSON。
- 调用 MAA 的 `StartUp` 唤醒明日方舟。
- 复用 MAA 的关卡导航进入目标关卡详情页。
- 如果代理指挥开启，就先取消代理指挥。
- 点击 `演习`，进入编队页。

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

## 安全边界

- 生成链路只生成 MAA copilot JSON，不执行 MAA。
- GUI 的进入演习流程只点击演习入口，不点击普通 `开始行动`。
- `candidateScore` 只用于候选排序，不是通关率。
- 歼灭率只来自人工反馈或执行观察结果。

## 更多文档

- [架构说明](docs/architecture.md)
- [算法边界](docs/algorithm-boundary.md)
- [MAA 执行评估层](docs/maa-execution.md)
- [导出契约](docs/maa-copilot-export-contract.md)
