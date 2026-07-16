# 干员偏好校准 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以最小的固定偏好加分，使 10 关代表集约半数关卡的部署干员至少一半来自偏好名单。

**Architecture:** 保持 `CandidateBuilder.ts` 的技能白名单和所有能力评分不变，只对 `PREFERENCE_BONUS` 做离散校准。通过临时、无玩家库的运行目录生成代表集，并按实际 `Deploy` 动作统计结果。

**Tech Stack:** TypeScript、Node.js、Jest、PowerShell。

---

### Task 1: 测量并选择最小达标加分

**Files:**

- Modify: `src/engine/CandidateBuilder.ts:29`
- Test: `__tests__/EngineV2.test.ts:111-126`

- [x] **Step 1: 逐档试验固定加分**

已试验 `8`、`8.5`、`9`、`10`。每档均以无玩家库的临时 `MAAFIGHT_HOME` 为 `scripts/benchmark.js` 的 10 个 `DEFAULT_STAGES` 生成脚本，并传入 `--new-candidate`。

- [x] **Step 2: 按实际部署统计各档结果**

对每份候选脚本读取 `actions.filter(action => action.type === "Deploy")`。偏好名单为 `PREFERRED_SKILLS` 的所有键加上 `斩业星熊`、`塞雷娅`、`酒神`；单关达标条件为：

```ts
const qualifies = preferredDeployments * 2 >= deployments.length;
```

结果为：`8` 为 4 / 10，`8.5` 为 5 / 10，`9` 为 6 / 10，`10` 为 7 / 10；因此选择 `8.5`。

- [x] **Step 3: 写入选定的唯一加分值**

仅修改 `src/engine/CandidateBuilder.ts` 中这一行：

```ts
const PREFERENCE_BONUS = 8.5;
```

不要修改 `PREFERRED_SKILLS`、`PREFERRED_OPERATORS`、`preferenceBonus`、`marginalScore` 或 `pickOptions`。

- [x] **Step 4: 运行回归验证**

Run: `npm test -- --runInBand __tests__/EngineV2.test.ts`

Expected: PASS，且玩家干员库中的艾雅法拉仍只使用 S2。

- [x] **Step 5: 构建并验证最终代表集**

Run: `npm run build:node && npm test -- --runInBand`

Expected: 构建成功，全部 Jest 测试通过；最终 10 份脚本均通过 `node dist/index.js validate --file <script>`。

- [x] **Step 6: 报告并提交**

报告最终加分值、10 关中达标关数，以及每关的“偏好部署人数 / 部署总人数”。随后执行：

```bash
git add src/engine/CandidateBuilder.ts docs/superpowers/plans/2026-07-17-operator-preference-calibration.md
git commit -m "tune(engine): increase operator preference bonus"
```
