# GUI Model Core Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GUI 可选择传统、模型、综合三种生成模式，并由共享 TypeScript pipeline 直接调用现有 CPU action ranker。

**Architecture:** `generateStage` 继续作为 CLI / GUI 唯一生成入口。模型模式复用 v2 已选出的 12 人阵容，把当前 `MapData` / `StageFacts` 转成 model-core 特征后在进程内执行 Beam Search；综合模式同时生成两份脚本并复用现有 shadow 比较规则，默认保留通过验证的传统脚本。

**Tech Stack:** TypeScript、Node.js、Fastify、React、Jest；不新增依赖。

---

### Task 1: 应用内 model-core 适配

**Files:**
- Create: `src/model-core/appGenerator.ts`
- Modify: `src/model-core/candidateEnumerator.ts`
- Test: `__tests__/CandidateEnumerator.test.ts`

- [ ] 从 `MapData`、`StageFacts`、v2 选出的 `BattleScript.opers` 和玩家干员库构造 `StageFeatures` / `OperatorFeatures`。
- [ ] 调用现有 `generateBattleScript`，把结果转回内部 `[row, col]` 坐标的 `BattleScript`，保留 12 人阵容并补 `SpeedUp` / `SkillDaemon`。
- [ ] 在基础合法性检查中限制同时部署数不超过 `characterLimit`。
- [ ] 运行 `npx jest __tests__/CandidateEnumerator.test.ts --runInBand`，期望 PASS。

### Task 2: 共享 pipeline 三模式

**Files:**
- Modify: `src/core/pipeline.ts`
- Modify: `src/gui/types.ts`
- Modify: `src/gui/routes.ts`

- [ ] 定义 `rule-core | model-core | hybrid-core` 输入；缺省保持 `rule-core`。
- [ ] `model-core` 选择模型脚本；`hybrid-core` 同时生成并调用 `compareShadowScripts`；任何模型加载或搜索错误直接返回失败。
- [ ] 返回 `requestedCore`、`selectedCore` 和 shadow 比较摘要，并按实际所选 core 写 generation 记录。

### Task 3: GUI 模式选择与模型发布

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `.gitignore`
- Modify: `scripts/release-preview.js`
- Add: `models/cpu-action-ranker-latest-100.json`（复用当前训练产物）

- [ ] 增加传统 / 模型 / 综合三段单选控件，并把选择发送到 `/api/generate`。
- [ ] 结果区显示请求模式和最终选择 core。
- [ ] 默认模型路径为 `models/cpu-action-ranker-latest-100.json`；预览发布包复制该文件，不新增路径配置页面。

### Task 4: 端到端验证

**Files:**
- Modify: `__tests__/guiServer.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/model-core.md`

- [ ] 覆盖默认传统模式、显式模型模式和综合模式，断言输出文件、协议验证和 `selectedCore`。
- [ ] 运行 `npx jest __tests__/CandidateEnumerator.test.ts __tests__/guiServer.test.ts --runInBand`，期望 PASS。
- [ ] 运行 `node node_modules/typescript/bin/tsc --noEmit` 与 `npm run build:web`，期望成功。

### Task 5: 接入后清理与全链路验收

**Files:**
- Delete: `scripts/battledsl.py`
- Delete: `src/dataset/actionTrainingSamples.ts`
- Delete: `__tests__/ActionTrainingSamples.test.ts`
- Delete: `web/package.json`
- Modify: `src/gui/types.ts`
- Modify: `.gitignore`

- [x] 删除已由 `src/model-core/battleDsl.ts`、`src/model-core/actionDataset.ts` 取代且无生产调用的旧实现及对应旧测试。
- [x] 删除重复的 Web manifest，统一使用根 `package.json` 和根 `node_modules`。
- [x] 删除未使用的 GUI API 泛型，忽略 Python 缓存文件。
- [x] 保留独立 shadow CLI；它仍支持应用 pipeline 不覆盖的离线 `roster/data` 工作流。
- [x] 运行 Node/Web 构建、完整 Jest、corpus audit、benchmark、model-core smoke test。
- [x] 使用真实地图和本机干员库分别生成并验证 `rule-core`、`model-core`、`hybrid-core`。
- [x] benchmark 强制 `--new-candidate` 隔离本机历史反馈，并按导出契约断言生成脚本不含 `requirements`。
- [x] 多样性门槛使用生产 1.2 秒搜索截止下稳定可复现的下限 `38 operators / 8 squads`。
