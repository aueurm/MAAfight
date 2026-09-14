# MAAfight 时空战术规划器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 public API、CLI/GUI pipeline、反馈存储和 MAA Copilot v3 导出契约的前提下，完成时空压力、联合规划、事件技能、机制与反馈学习升级。

**Architecture:** adapter 只保留结构化路线/机制事实；engine 以纯函数构建路线时间线、压力图、可行性、联合 Beam 和事件。只有通过硬约束的候选才能进入质量排序；反馈只产生下一轮搜索偏置。

**Tech Stack:** TypeScript、Node.js、Jest、现有 MAA Copilot validator/exporter。

---

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `src/types.ts` | 兼容路线 checkpoint、敌人机制和脚本元数据类型。 |
| `src/adapter/PRTSMapAdapter.ts` | 保留路径等待及可见性，不生成战术。 |
| `src/engine/RouteTimeline.ts` | spawn 的确定性 cell/time 位置轨迹。 |
| `src/engine/TemporalPressure.ts` | `time × cell` 敌方压力和关键窗口。 |
| `src/engine/Feasibility.ts` | 费用、伤害、对空、阻挡、治疗和机制硬约束。 |
| `src/engine/TimelinePlanner.ts` / `SkillPlanner.ts` | 内部事件、费用和合法技能动作。 |
| `src/engine/JointPlanner.ts` | `(operator, skill, location, direction)` Beam。 |
| `src/engine/EnemyMechanics.ts` | 机制修正和 coverage gaps。 |
| `src/feedback/FeedbackLearning.ts` | v3 反馈到下一轮搜索偏置。 |

### Task 1: 路线 checkpoint 与机制事实

**Files:**
- Modify: `src/types.ts`
- Modify: `src/adapter/PRTSMapAdapter.ts`
- Test: `__tests__/adapter.test.ts`

- [ ] **Step 1: 写出等待 checkpoint 的失败测试。**

```ts
expect(mapData.routes[0].checkpoints).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: "MOVE", row: 2, col: 3 }),
  expect.objectContaining({ type: "WAIT_FOR_SECONDS", waitSeconds: 4 }),
]));
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npx jest __tests__/adapter.test.ts --runInBand`

Expected: FAIL，因为当前 adapter 丢弃所有非 MOVE checkpoint。

- [ ] **Step 3: 加入向后兼容的类型。**

```ts
export type EnemyMechanic = "stealth" | "unblockable" | "flying" | "invulnerable"
  | "multiPhase" | "revive" | "split" | "summon" | "deathExplosion"
  | "specialTargeting" | "antiHeal" | "elementalDamage" | "taunt"
  | "shiftImmune" | "tileInteraction" | "blockAmplified" | "damageReflect";

export interface RouteCheckpoint {
  row: number; col: number;
  type?: "MOVE" | "WAIT_CURRENT_FRAGMENT_TIME" | "WAIT_FOR_SECONDS" | "DISAPPEAR" | "APPEAR_AT_POS";
  waitSeconds?: number;
}
```

将 `EnemyRoute.checkpoints` 改为 `RouteCheckpoint[]`，给 `EnemyDetail` 加可选 `mechanics?: EnemyMechanic[]`；旧 `{ row, col }` fixture 不需修改。

- [ ] **Step 4: 规范化 checkpoint。**

```ts
function normalizeCheckpointType(type: PRTSCheckpoint["type"]): RouteCheckpoint["type"] {
  if (type === "MOVE" || type === 0) return "MOVE";
  if (type === "WAIT_CURRENT_FRAGMENT_TIME" || type === 1) return "WAIT_CURRENT_FRAGMENT_TIME";
  if (type === "WAIT_FOR_SECONDS" || type === 5) return "WAIT_FOR_SECONDS";
  if (type === "DISAPPEAR" || type === 6) return "DISAPPEAR";
  return "APPEAR_AT_POS";
}
```

`adaptRoutes` 用 MOVE/APPEAR checkpoint 判定路径有效，保留等待 checkpoint，并仅为 `WAIT_FOR_SECONDS` 写非负 `waitSeconds`。

- [ ] **Step 5: 验证。**

Run: `npx jest __tests__/adapter.test.ts --runInBand`

Expected: PASS。

### Task 2: 路线时间线与时空压力

**Files:**
- Create: `src/engine/RouteTimeline.ts`
- Create: `src/engine/TemporalPressure.ts`
- Modify: `src/engine/types.ts`
- Test: `__tests__/TemporalPressure.test.ts`

- [ ] **Step 1: 写慢速、等待、飞行和蓝门压力的失败测试。**

```ts
const pressure = buildTemporalPressure(mapData, { bucketSeconds: 1 });
expect(pressure.cellsAt(2).get("2,2")?.groundHp).toBe(5000);
expect(pressure.cellsAt(6).get("2,3")?.groundHp).toBe(5000);
expect(pressure.cellsAt(2).get("2,2")?.blockDemand).toBe(1);
expect(pressure.criticalWindows.some(window => window.goalThreat > 0)).toBe(true);
```

- [ ] **Step 2: 运行失败测试。**

Run: `npx jest __tests__/TemporalPressure.test.ts --runInBand`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现路径离散化和 spawn 轨迹。**

```ts
export function manhattanCells(from: Cell, to: Cell): Cell[] {
  const cells: Cell[] = [{ ...from }];
  let { row, col } = from;
  while (row !== to.row || col !== to.col) {
    if (row !== to.row) row += Math.sign(to.row - row);
    else col += Math.sign(to.col - col);
    cells.push({ row, col });
  }
  return cells;
}
```

`buildRouteTimeline` 只将 MOVE/APPEAR、起点和终点组成几何路径；按 `moveSpeed` 每秒推进，显式等待停在最近 cell，未知片段等待写 `route_wait_unknown`。

- [ ] **Step 4: 实现压力累计。**

```ts
export interface TemporalCellPressure {
  groundHp: number; airHp: number; incomingAttack: number; blockDemand: number;
  eliteWeight: number; bossWeight: number; goalThreat: number; mergeWeight: number;
  routeIds: number[]; enemyIds: string[]; coverageGaps: string[];
}
```

对每个时间位置累积 HP、攻击与地面阻挡需求；距蓝门不超过 2 cell 时增加 `goalThreat`；多路线共用 cell 时增加 `mergeWeight`；输出必须按时间、cell key、id 稳定排序。

- [ ] **Step 5: 验证。**

Run: `npx jest __tests__/TemporalPressure.test.ts --runInBand`

Expected: PASS。

### Task 3: StageFacts、Encounter 与机制需求

**Files:**
- Create: `src/engine/EnemyMechanics.ts`
- Modify: `src/engine/StageFacts.ts`
- Modify: `src/engine/EncounterContext.ts`
- Modify: `src/engine/types.ts`
- Test: `__tests__/EngineV2.test.ts`
- Test: `__tests__/EnemyMechanics.test.ts`

- [ ] **Step 1: 写关键窗口与机制修正的失败测试。**

```ts
expect(extractStageFacts(delayedRoute).pressureWindows
  .find(window => window.start === 15)?.totalHp).toBeGreaterThan(0);
expect(buildMechanicAdjustment(["unblockable"]).blockMultiplier).toBeLessThan(1);
expect(buildMechanicAdjustment(["antiHeal"]).healingMultiplier).toBeLessThan(1);
```

- [ ] **Step 2: 接入压力图。**

`extractStageFacts` 从 `buildTemporalPressure` 生成既有 15 秒 `pressureWindows`，并新增 `temporalPressure`、`criticalWindows`、`coverageGaps`。几何 `routeCells` 仅取移动路径。

- [ ] **Step 3: 实现机制转换。**

```ts
export interface MechanicAdjustment {
  demand: Partial<CapabilityDemand>;
  blockMultiplier: number; healingMultiplier: number; denseMeleePenalty: number;
  coverageGaps: string[];
}
```

不可阻挡降低 block 价值并增加控制/爆发需求；死亡爆炸增加密集近战惩罚；飞行提高对空需求；未知标签写 `unknown_enemy_mechanic:<tag>`。

- [ ] **Step 4: 验证。**

Run: `npx jest __tests__/EngineV2.test.ts __tests__/EnemyMechanics.test.ts --runInBand`

Expected: PASS，既有 flying/Boss/multi-route 测试不回归。

### Task 4: 时空落点、费用与可行性门槛

**Files:**
- Create: `src/engine/TimelinePlanner.ts`
- Create: `src/engine/Feasibility.ts`
- Modify: `src/engine/CandidateBuilder.ts`
- Modify: `src/engine/Scoring.ts`
- Modify: `src/engine/index.ts`
- Test: `__tests__/Feasibility.test.ts`

- [ ] **Step 1: 写费用不足、无对空、无治疗的失败测试。**

```ts
expect(evaluateFeasibility(noAntiAir, facts, encounter).feasible).toBe(false);
expect(evaluateFeasibility(expensiveOpening, facts, encounter).reasons)
  .toContain("cost_timeline_unaffordable");
```

- [ ] **Step 2: 实现费用时间线。**

```ts
export function costAt(time: number, options: MapOptions): number {
  const tick = Math.max(0.01, options.costIncreaseTime || 1);
  return Math.min(options.maxCost, options.initialCost + Math.floor(time / tick));
}
```

`planTimeline` 以初始费用、自然回复、部署费、部署顺序和冷却推导最早可用事件；只有模型/知识中存在明确数值时才加入回费，否则写 `dp_recovery_unknown`。

- [ ] **Step 3: 替换静态覆盖。**

`temporalCoverageScore(action, pick, pressure)` 只计量攻击范围真实命中的 bucket/cell，按 HP、Boss、汇流、蓝门和未被现有火力覆盖的边际收益加权；飞行目标不由近战计入，治疗只计入前排 cell。

- [ ] **Step 4: 实现硬约束。**

```ts
export interface FeasibilityResult {
  feasible: boolean;
  reasons: string[];
  coverageGaps: string[];
}
```

逐个关键窗口检查地面/空中 DPS、阻挡或控制、前排治疗/生存、费用、部署格、角色上限和机制方案。失败候选在 `cheapScoreCandidate` 前被 `generateCopilotScript` 拒绝。

- [ ] **Step 5: 验证。**

Run: `npx jest __tests__/Feasibility.test.ts __tests__/EngineV2.test.ts --runInBand && npm run build:node`

Expected: PASS。

### Task 5: 联合 Beam 与事件部署

**Files:**
- Create: `src/engine/JointPlanner.ts`
- Modify: `src/engine/CandidateBuilder.ts`
- Modify: `src/engine/index.ts`
- Test: `__tests__/JointPlanner.test.ts`
- Test: `__tests__/TimelinePlanner.test.ts`

- [ ] **Step 1: 写联合选位的失败测试。**

```ts
const plan = buildJointPlan(mapData, facts, encounter, options);
const cells = plan.decisions.map(item => item.location.join(","));
expect(new Set(cells).size).toBe(cells.length);
expect(plan.decisions.some(item => item.location[0] === 2 && item.location[1] === 3)).toBe(true);
```

- [ ] **Step 2: 实现局部候选和 Beam 状态。**

```ts
export interface JointDecision { pick: EnginePick; location: [number, number]; direction: Direction; }
export interface JointState {
  decisions: JointDecision[]; occupied: Set<string>; coverage: CoverageState;
  cost: CostTimeline; score: number; signature: string;
}
```

每个干员技能仅保留最多 6 个时空边际收益最高位置；状态扩展拒绝格位冲突、严重重复火力、未治疗前排和低价值占用关键格。stable tie-breaker 为 score、signature。

- [ ] **Step 3: 用事件替换 0/250/500/750 ms 变体。**

`TimelinePlanner` 生成 `first_spawn`、`fire_zone`、`blue_box_threat`、`flying_wave`、`boss_arrival`、`cost_ready`、`coverage_loss`。将事件映射为 `costs`、`kills`、`time_elapsed`、`cooling`、`pre_delay`，从 `index.ts` 删除 position/timing 的 4 × 4 枚举。

- [ ] **Step 4: 让 CandidateBuilder 仅编码联合计划。**

保留 `buildCandidate` 作为兼容入口，优先读取联合决策；维持固定 12 人 `opers`、空 groups、默认无 requirements 和现有坐标转换。

- [ ] **Step 5: 验证。**

Run: `npx jest __tests__/JointPlanner.test.ts __tests__/TimelinePlanner.test.ts __tests__/EngineV2.test.ts --runInBand`

Expected: PASS，script hash 对相同输入稳定。

### Task 6: 技能策略和协议互斥

**Files:**
- Create: `src/engine/SkillPlanner.ts`
- Modify: `src/engine/CombatModel.ts`
- Modify: `src/engine/types.ts`
- Modify: `src/engine/CandidateBuilder.ts`
- Test: `__tests__/SkillPlanner.test.ts`

- [ ] **Step 1: 写 Boss 保留与 daemon 互斥失败测试。**

```ts
const skillPlan = planSkillActions(bossPlan);
expect(skillPlan.actions).toContainEqual(expect.objectContaining({ type: "Skill" }));
expect(skillPlan.actions.some(action => action.type === "SkillDaemon")).toBe(false);
```

- [ ] **Step 2: 暴露现存 combat model 字段。**

```ts
skillType: levelRecord?.skillType || "UNKNOWN",
spType: levelRecord?.spType || "UNKNOWN",
spCost: Math.max(0, levelRecord?.spCost || 0),
initSp: Math.max(0, levelRecord?.initSp || 0),
```

将字段加入 `ResolvedOperatorProfile`，不改变已生成 JSON 的 schema。

- [ ] **Step 3: 实现分类。**

```ts
export type SkillStrategy = "daemon" | "opening" | "sustain" | "burst" | "boss" | "defense" | "emergency" | "passive";
```

按 `skillType`、`spType`、duration、知识 tag 和关键窗口选择策略。无手动策略时追加 `SkillDaemon`；有条件手动 `Skill` 时不混用 daemon；未知 SP、无敌和无目标窗口写 coverage gap。

- [ ] **Step 4: 验证。**

Run: `npx jest __tests__/SkillPlanner.test.ts __tests__/MAAProtocolValidator.test.ts --runInBand`

Expected: PASS，导出没有 `Wait` 或 `SkillUse`。

### Task 7: v3 反馈学习

**Files:**
- Create: `src/feedback/FeedbackLearning.ts`
- Modify: `src/feedback/FeedbackStore.ts`
- Modify: `src/core/pipeline.ts`
- Modify: `src/engine/types.ts`
- Modify: `src/engine/index.ts`
- Test: `__tests__/FeedbackStore.test.ts`
- Test: `__tests__/FeedbackLearning.test.ts`

- [ ] **Step 1: 写旧记录和新偏置的失败测试。**

```ts
expect(store.loadFeedback().records[0].ratio).toBe(0.8);
expect(deriveSearchBias([earlyLeak]).openingCoverage).toBeGreaterThan(0);
expect(deriveSearchBias([airLeak]).antiAir).toBeGreaterThan(0);
```

- [ ] **Step 2: 添加可选 schema v3 字段。**

```ts
firstLeak?: { time: number; routeId?: number; location?: [number, number] };
operatorDeaths?: Array<{ name: string; time: number }>;
deploymentFailures?: Array<{ name?: string; time?: number; reason: string }>;
remainingEnemyIds?: string[];
failureTags?: EnemyMechanic[];
```

`recordFeedback` 原参数不变。v1/v2 记录必须继续被 `loadFeedback`、成功复用和失败排除读取。

- [ ] **Step 3: 将失败转为受版本隔离的 bias。**

```ts
export interface SearchBias {
  openingCoverage: number; antiAir: number; bossBurst: number; healing: number;
  costSafety: number; routeWeights: Record<number, number>;
}
```

只使用同 stage content hash、干员库 hash、engine version 的可学习记录；pipeline 传入 engine，engine 只调整搜索和排序，不能绕过 Feasibility。

- [ ] **Step 4: 验证。**

Run: `npx jest __tests__/FeedbackStore.test.ts __tests__/FeedbackLearning.test.ts __tests__/Pipeline.test.ts --runInBand`

Expected: PASS。

### Task 8: 全量回归、文档和职责提交

**Files:**
- Modify: `__tests__/EngineV2.test.ts`
- Modify: `__tests__/CliGeneration.test.ts`
- Modify: `__tests__/ScriptExporter.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/algorithm-boundary.md`

- [ ] **Step 1: 添加最终兼容性断言。**

```ts
expect(result.script.opers).toHaveLength(12);
expect(result.script.groups).toEqual([]);
expect(result.script.actions.some(action => action.type === "Wait" || action.type === "SkillUse")).toBe(false);
expect(validateMAAProtocol(result.script).valid).toBe(true);
```

- [ ] **Step 2: 更新边界文档。**

明确时空模型、coverage gaps、候选得分不代表通关率，以及真实三星演习才可发布的规则。

- [ ] **Step 3: 运行全量验证。**

Run: `npm run build:node && npm test && npm run corpus:audit && node scripts/benchmark.js --skip-build`

Expected: 每项退出码为 0，候选只使用官方动作，不输出密钥。

- [ ] **Step 4: 职责拆分提交。**

```bash
git add src/types.ts src/adapter/PRTSMapAdapter.ts src/engine/RouteTimeline.ts src/engine/TemporalPressure.ts __tests__/TemporalPressure.test.ts
git commit -m "feat(engine): model temporal route pressure"
```

后续分别提交可行性、联合/时间线/技能、机制和反馈；绝不暂存用户已有的 `src/data/stage_index.json` 或 `src/loader/levelPaths.json`。
