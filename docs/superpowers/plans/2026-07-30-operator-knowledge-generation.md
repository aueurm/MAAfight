# Operator Knowledge Generation Implementation Plan

> **For Codex:** Execute the plan task-by-task in this session. Preserve the existing manual knowledge overlay and unrelated working-tree changes.

**Goal:** 为当前战斗模型中的全部干员从技能描述生成确定性战略标签与 12 维向量，并在不改动核心规划逻辑的前提下作为可再生知识层加载。

**Architecture:** 新增一个独立生成脚本，读取上游 `character_table.json`、`skill_table.json` 和已生成的战斗模型；生成层以技能描述的稳定关键词和现有战斗指标计算标签、空间元数据和向量。知识加载器以生成层为基底、手工 `operatorKnowledge.v1.json` 为覆盖层；游戏数据更新器在临时目录中同时生成两份模型后原子替换。

**Tech Stack:** Node.js CommonJS scripts、TypeScript、Jest。

---

### Task 1: 定义生成模型的最小契约并接入知识加载

**Files:**
- Modify: `src/engine/OperatorKnowledge.ts`
- Create: `src/engine/OperatorKnowledgeData.ts`
- Create: `src/data/operatorKnowledge.generated.v1.json`
- Test: `__tests__/OperatorKnowledge.test.ts`

1. 先为 generated + manual 合并写失败测试：手工字段覆盖生成字段，标签数组去重，生成向量在无手工向量时可用。
2. 新模块校验 generated 数据的 schema、12 个固定向量轴和来源提交；按 `id` / `name` 合并生成层与手工层。
3. 将现有 `OperatorKnowledge` 改为复用该数据模块，保留当前公开 API 与手工增量干员行为。
4. 运行 `npm test -- --runInBand __tests__/OperatorKnowledge.test.ts`，确认从失败变为通过。

### Task 2: 实现描述驱动的确定性知识生成器

**Files:**
- Create: `scripts/build-operator-knowledge.js`
- Test: `__tests__/OperatorKnowledgeGeneration.test.ts`

1. 以最小 fixture 写失败测试，验证描述关键词映射、无命中不猜测、范围变化和向量输出稳定。
2. 脚本读取 `character_table.json`、`skill_table.json` 与 `operatorCombat.v2.json`，只处理战斗模型实际包含的干员。
3. 使用固定中文关键词表提取能力与空间标签，结合既有战斗指标计算 12 维向量；输出来源 commit、规则版本与可追溯性元数据。
4. 运行对应 Jest 测试，确认 fixture 输出确定且完整。

### Task 3: 将生成层纳入游戏数据原子更新

**Files:**
- Modify: `scripts/update-game-data.js`
- Modify: `__tests__/GameDataUpdater.test.ts`

1. 扩展更新器测试，要求暂存目录同时包含战斗模型和 generated knowledge，且来源提交一致。
2. 在暂存目录生成知识层，校验干员集合与 commit 后，再与现有模型一起替换目标文件。
3. 运行更新器测试；保留手工知识文件，禁止更新器写入或删除它。

### Task 4: 生成全量数据并做回归验证

**Files:**
- Modify: `src/data/operatorKnowledge.generated.v1.json`
- Modify: `docs/operator-knowledge.md`

1. 使用上游固定 commit 的游戏数据生成实际 generated knowledge 文件，确认条目数等于当前战斗模型的 412 名干员。
2. 文档记录 generated/manual 两层职责、刷新命令与来源一致性校验。
3. 执行 `npm run build:node`、`npm test -- --runInBand`、`npm run corpus:audit`。
4. 检查 `git diff --check`，仅报告本任务涉及的改动；不提交，因为当前工作区包含用户的未提交改动。
