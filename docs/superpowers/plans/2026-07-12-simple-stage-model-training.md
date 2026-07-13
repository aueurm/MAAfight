# 简单关卡模型训练实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从约 2,000 份公共作业筛选简单关卡训练 model-core，扩大到地图全部合法部署点，并以训练集外 1-7 的 MAA 演习三星作为唯一完成门禁。

**Architecture:** 复用现有 PRTS Plus analyzer、action dataset、线性 ranker 和应用内 Beam Search。analyzer 只补回已经计算的完整部署点；dataset 在统一入口完成去重、简单关卡筛选和 1-7 排除；候选枚举改为格子优先覆盖。候选模型独立输出，1-7 三星后才晋升。

**Tech Stack:** TypeScript、Node.js、Python stdlib、Jest、PowerShell、MAA。

---

### Task 1: 持久化完整部署点

**Files:**
- Modify: `scripts/analyze-prts-plus.js`
- Test: `__tests__/PrtsPlusAnalyzer.test.ts`

- [ ] 在 `joinOperationWithMap` 测试中断言 `map.deploymentPoints` 包含地图全部 `{ row, col, buildableType }`。
- [ ] 运行 `npx jest __tests__/PrtsPlusAnalyzer.test.ts --runInBand`，确认旧实现失败。
- [ ] 在删除 `_join` 前执行：

```js
publicMetrics.deploymentPoints = join.deploymentPoints;
```

- [ ] 重跑聚焦测试，确认通过。

### Task 2: 简单关卡筛选和 1-7 隔离

**Files:**
- Modify: `scripts/build-action-dataset.js`
- Modify: `scripts/model-core-retrain.js`
- Test: `__tests__/ModelCoreRetrain.test.ts`

- [ ] 添加测试，覆盖 `--simpleOnly`、重复 `--excludeStage`、跨输入重复 ID 去重和 `main_01-07` 排除。
- [ ] 实现并导出以下筛选函数：

```js
function isSimpleOperation(operation) {
  const feature = operation.feature || {};
  const map = feature.map || {};
  return feature.mapMatched === true
    && Number(map.bossTypeCount || 0) === 0
    && Number(map.eliteTypeCount || 0) <= 1
    && Number(map.weightedHp || Infinity) <= 300000
    && Number(map.spawnCount || Infinity) <= 70
    && Number(feature.retreatCount || 0) <= 1;
}
```

- [ ] `build-action-dataset` 在构造样本前按 operation ID 去重，再执行 stage 排除和简单筛选；输出各类跳过数量。
- [ ] 对每个即将写出的 sample 检查 `meta.stageId` 不在排除集合中，命中即抛错。
- [ ] `model-core-retrain` 解析并透传同名参数。
- [ ] 运行 `npx jest __tests__/ModelCoreRetrain.test.ts --runInBand`。

### Task 3: 让固定预算覆盖全部合法格

**Files:**
- Modify: `src/model-core/candidateEnumerator.ts`
- Test: `__tests__/CandidateEnumerator.test.ts`

- [ ] 添加 3 名干员、3 个格子、仅允许 3 个 geometry Deploy 的测试；断言 3 个格子都出现。
- [ ] 将 `legalGeometry` 索引顺序改为格子优先、干员其次，方向和 delay 保持后续维度：

```ts
const cell = cells[i % cells.length];
const operator = operators[Math.floor(i / cells.length) % operators.length];
```

- [ ] 运行 `npx jest __tests__/CandidateEnumerator.test.ts --runInBand`。

### Task 4: 下载并构建约 2,000 份语料

**Files:**
- Generate: `data/prts-plus-simple-2000/`
- Generate: `data/model-core/simple-2000/`

- [ ] 运行：

```powershell
node scripts/analyze-prts-plus.js --limit 2000 --output data/prts-plus-simple-2000
```

- [ ] 构建 Node 产物。
- [ ] 运行：

```powershell
node scripts/build-action-dataset.js --input data/prts-plus-simple-2000 --out data/model-core/simple-2000 --simpleOnly --excludeStage main_01-07 --negativeCount 50 --validRatio 0.2 --seed 42
```

- [ ] 检查保留脚本数、关卡数、干员数、完整部署点覆盖，以及三个 JSONL 中 `main_01-07` 数量均为 0。

### Task 5: 训练候选模型

**Files:**
- Generate: `models/cpu-action-ranker-simple-2000-candidate.json`
- Generate: `data/model-core/simple-2000/eval_report.json`

- [ ] 训练并保留最佳 epoch：

```powershell
python scripts/model-core/train_linear_ranker.py --train data/model-core/simple-2000/train.jsonl --valid data/model-core/simple-2000/valid.jsonl --out models/cpu-action-ranker-simple-2000-candidate.json --epochs 8 --lr 0.03 --l2 0.0001 --seed 42
```

- [ ] 运行 eval、聚焦 Jest、Python trainer test、`npm run model-core-smoke-test`。
- [ ] 候选结构验证率不是 100% 时停止，不执行 MAA。

### Task 6: 生成并实测 1-7

**Files:**
- Generate: `data/model-core/simple-2000/1-7-model-core.json`
- Update on execution: `.maafight/feedback.jsonl`

- [ ] 使用候选模型、本机 `.maafight/operators.json` 和 `core: "model-core"` 生成 1-7，强制 `newCandidate: true`。
- [ ] 用 CLI 同时运行 ScriptValidator 和 MAAProtocolValidator。
- [ ] 通过以下安全演习入口执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/enter-practice.ps1 -Stage 1-7 -MaaDir D:\app\MAA -ScriptPath data/model-core/simple-2000/1-7-model-core.json
```

- [ ] 只有观察结果为 3 星时进入 Task 7；执行链路错误先修链路，进入战斗但未三星则记录反馈并返回 Task 4 或 Task 5 迭代。

### Task 7: 晋升与全量验证

**Files:**
- Replace after 3-star evidence: `models/cpu-action-ranker-latest-100.json`
- Modify: `docs/model-core.md`
- Modify: `docs/test-levels.md`

- [ ] 用哈希校验后晋升候选模型。
- [ ] 运行 `npm run build:node`、`npm test -- --runInBand`、`npm run corpus:audit`、`npm run model-core-smoke-test` 和 benchmark。
- [ ] 文档记录训练规模、1-7 零泄漏证据和真实三星结果，不把离线分数描述成通关率。
