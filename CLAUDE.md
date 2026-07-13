# MAAfight v2

## 项目定位

MAAfight 是一个 TypeScript / Node.js 本地工具，提供 CLI 和 Web GUI。它读取 PRTS.Map 关卡数据，通过语料先验和确定性 Beam Search 生成可导入 MAA 的 copilot JSON v3 草稿。

生成引擎不直接执行 MAA、ADB 或图像识别，也不把候选评分当作通关率。GUI / runner 可以调用本机 MAA 进入演习、执行 Copilot 并读取结算结果，用于实战验证和反馈闭环。

## 核心流水线

```text
Stage ID / code / local data
  -> PRTSMapLoader
  -> PRTSMapAdapter
  -> StageFacts
  -> CandidateBuilder
  -> six-part scoring
  -> deterministic Beam Search
  -> ScriptValidator / MAAProtocolValidator
  -> ScriptExporter
```

主要模块：

- `src/engine/StageFacts.ts`：提取关卡事实和 15 秒压力窗口。
- `src/engine/CandidateBuilder.ts`：构造编队、点位和动作候选。
- `src/engine/Scoring.ts`：局部交战与五项辅助评分。
- `src/engine/index.ts`：确定性 Beam Search。
- `src/copilot/`：MAA 协议验证与导出。
- `src/core/pipeline.ts`：CLI / GUI 共用生成入口。
- `src/feedback/`：实战反馈记录与复用。
- `src/model-core/`：BattleDSL、候选枚举、CPU ranker 与状态内归一化 Beam Search。
- `src/runner/`：本机 MAA 执行、画面观测与演习结果采集。

仓库中不得重新引入旧 rules 生成器、旧 `src/battle/` 模块或生成失败 fallback。旧实现只保留在 GitHub 历史中。

## 开发约束

- 默认 fixed 12 人、`groups: []`。
- 默认省略 `requirements`；`player` 模式只导出真实玩家数据。
- 只输出 MAA 官方动作，不输出 `Wait`、`SkillUse`。
- 内部 `[row, col]` 导出为 MAA `[x, y]`。
- 模型、搜索或协议验证失败时直接报错。
- CLI stdout 输出 JSON 时，warning 和 explain 走 stderr。
- 评分只用于候选排序，不得描述为歼灭率或通关率。

修改 engine、copilot、pipeline 或 GUI 生成入口前，先读 `docs/maa-copilot-export-contract.md`。

## 常用命令

```bash
npm run build
npm test
npm run corpus:audit
node scripts/benchmark.js --skip-build
npm run gui
```

PowerShell 中运行 `claude` 打开 Claude Code TUI；非交互验收使用 `claude -p "<prompt>"`。

文档入口见 `docs/README.md`。
