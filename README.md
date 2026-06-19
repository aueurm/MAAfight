# MAAfight v2

MAAfight 是一个 TypeScript / Node.js 本地工具，读取 PRTS.Map 关卡数据，使用语料先验、静态战斗数据和确定性 Beam Search 生成 MAA copilot JSON v3 草稿。

v2 只有一套生成引擎。仓库中不存在旧规则生成器或 fallback 战斗链路；旧实现只保留在 GitHub `v1.0.0-alpha` 历史中。

## 快速开始

```bash
npm install
npm run build
node dist/index.js generate --stage GT-1 --output GT-1.json --pretty
```

启动本地 GUI：

```bash
npm run gui
```

## 数据流

```text
PRTS.Map
  -> loader / adapter
  -> StageFacts
  -> CandidateBuilder
  -> Combat + Corpus + Position + Timing scoring
  -> deterministic Beam Search
  -> protocol validation
  -> MAA copilot JSON v3
```

`candidateScore` 只用于候选排序，不是通关率。歼灭率只来自 MAA 实际执行后的 `killed / total` 反馈。

## 生成约束

- 固定 12 人编队，`groups: []`。
- 默认省略 `requirements`。
- `--requirements player` 仅导出玩家库中的真实数据。
- 只生成 MAA 官方动作，不输出 `Wait`、`SkillUse`。
- 模型、搜索或协议验证失败时直接报错，不生成降级脚本。
- 不控制 ADB，不执行 MAA，不把静态评分描述为通关证明。

## 常用命令

```bash
maafight generate --stage GT-1 --output GT-1.json --pretty
maafight generate --data ./level_custom.json --stage CUSTOM-1 --output CUSTOM-1.json
maafight generate --stage GT-1 --new-candidate
maafight analyze --stage GT-1 --pretty
maafight validate --file GT-1.json
maafight init --operators Arknights_OperBox_Export.json
maafight feedback record --file GT-1.json --killed 42 --total 42
maafight feedback summary --stage GT-1
```

生成时未传 `--operators`，会尝试读取 `.maafight/operators.json`。完整玩家库不会复制到生成记录或反馈文件。

## 模型维护

```bash
npm run corpus:audit
npm run model:build
node scripts/build-operator-combat-model.js --game-data <excel-dir> --commit <upstream-commit>
```

公开游戏数据可参考 [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)。更新模型时必须锁定上游 commit 并记录输入 hash。

## 验证

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/jest/bin/jest.js --runInBand --coverage=false
node scripts/benchmark.js --skip-build
```

详细说明见 [docs/README.md](docs/README.md)。
