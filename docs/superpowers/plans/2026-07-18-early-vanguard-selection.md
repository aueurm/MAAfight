# 高早压关先锋首发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让高部署需求关卡在玩家有 E2 先锋时由先锋占据 Beam 第一个槽位。

**Architecture:** 复用现有 `EncounterContext.demand.deployment`，只约束 `buildSquadBeam` 的首槽候选集合。后续槽位、能力评分、部署和主力接替逻辑保持不变。

**Tech Stack:** TypeScript、Jest、engine v2 Beam Search。

---

## File structure

- Modify: `src/engine/CandidateBuilder.ts` — 为高部署需求 Beam 首槽限定现有先锋候选。
- Modify: `src/engine/types.ts` — 将已计算的高开局压力判断传给候选构造。
- Modify: `src/engine/index.ts` — 复用同一 `deployment` demand，不创建第二套压力阈值。
- Modify: `__tests__/EngineV2.test.ts` — 覆盖高需求强制先锋和低需求不改变评分两个分支。

### Task 1: 先锋首槽约束

**Files:**
- Modify: `__tests__/EngineV2.test.ts:192-238`
- Modify: `src/engine/CandidateBuilder.ts:263-281`

- [ ] **Step 1: 写入失败回归测试**

```ts
  it("opens high deployment demand with a vanguard without changing low-demand scoring", () => {
    const records = ["德克萨斯", "佩佩", "塞雷娅"].map(name => getCombatOperatorByName(name)!);
    const players = new Map(records.map(record => [record.id, {
      id: record.id, name: record.name, rarity: record.rarity, own: true,
      elite: 2, level: 60, potential: 1,
    }] as [string, PlayerOperator]));
    const highMap = makeMapData();
    highMap.deploymentPoints = [
      { row: 2, col: 2, buildableType: "all" },
      { row: 2, col: 3, buildableType: "all" },
    ];
    const highFacts = extractStageFacts(highMap);
    const highEncounter = buildEncounterContext(highMap, highFacts);
    const highPicks = buildSquadBeam(highFacts, highEncounter, { playerOperators: players }).squads[0];

    expect(highEncounter.demand.deployment).toBeGreaterThanOrEqual(0.5);
    expect(highPicks[0].role).toBe("vanguard");

    const lowMap = makeMapData();
    lowMap.options.initialCost = 30;
    lowMap.spawnTimeline = [
      { time: 0, enemyId: "enemy", count: 1, routeIndex: 0 },
      { time: 15, enemyId: "enemy", count: 9, routeIndex: 0 },
    ];
    const lowFacts = extractStageFacts(lowMap);
    const lowEncounter = buildEncounterContext(lowMap, lowFacts);
    const lowPicks = buildSquadBeam(lowFacts, lowEncounter, { playerOperators: players }).squads[0];

    expect(lowEncounter.demand.deployment).toBeLessThan(0.5);
    expect(lowPicks[0].role).not.toBe("vanguard");
  });
```

- [ ] **Step 2: 运行测试确认旧实现失败**

Run: `npx jest __tests__/EngineV2.test.ts --runInBand`

Expected: FAIL，高需求场景首位仍为非先锋。

- [ ] **Step 3: 在 Beam 首槽复用 deployment demand**

在 `available` 初始化后加入：

```ts
  // ponytail: one threshold gates early vanguard starts; calibrate per-stage only if rehearsals show false positives.
  const openingVanguards = encounter.demand.deployment >= 0.5
    ? available.filter(pick => pick.role === "vanguard")
    : [];
```

将展开循环改为：

```ts
      const slotOptions = slot === 0 && openingVanguards.length ? openingVanguards : available;
      for (const pick of slotOptions) {
```

- [ ] **Step 4: 运行定向测试、构建和全量回归**

Run: `npx jest __tests__/EngineV2.test.ts --runInBand`

Expected: PASS。

Run: `npm run build:node`

Expected: TypeScript 构建成功。

Run: `npm test`

Expected: 全部 Jest 测试通过。

- [ ] **Step 5: 生成并检查 11-20 候选**

Run: `node dist/index.js generate --stage 11-20 --output output/.candidates/practice-11-20-vanguard-v1.json --pretty --new-candidate`

Expected: 输出合法脚本，第一名 `opers` 与第一条 `Deploy` 均为先锋，随后可执行实机演习。

- [ ] **Step 6: 提交修复**

```bash
git add src/engine/CandidateBuilder.ts __tests__/EngineV2.test.ts
git commit -m "fix(engine): require vanguard for early pressure"
```

### Task 2: 高压力开局防线纵深

**Files:**
- Modify: `__tests__/EngineV2.test.ts`
- Modify: `src/engine/types.ts`
- Modify: `src/engine/index.ts`
- Modify: `src/engine/CandidateBuilder.ts`

- [ ] **Step 1: 写入失败回归测试**

构造双蓝门高压力地图，输入顺序为“先锋、高台、两名长期站场近战、近卫”，断言输出部署顺序为“先锋、两名前线、高台、近卫”，先锋与近卫均选择剩余合法点中的最近防御圈，而不是敌方入口公共交叉点；高台仍可选择较远但能覆盖全部阻挡点的位置。同时断言提丰只保留 S2/S3。

- [ ] **Step 2: 复用统一压力判断**

由 `generateCopilotScript` 把 `encounter.demand.deployment >= 0.5` 作为 `openingPressure` 传入 `buildCandidate`，避免部署阶段另造阈值。

- [ ] **Step 3: 建立防线后再部署高台**

高压力时将部署迭代顺序调整为首发先锋、每个地面蓝门的一名非临时近战、其余原顺序。长期站场近战优先 `LANE_HOLD_SUBPROFESSIONS`。

- [ ] **Step 4: 限制开局阵型的防御纵深**

除快活外，每次近战部署都计算剩余合法点到最近蓝门的最小距离，只保留 `最小距离 + 1` 圈内点位，再沿用原评分与位置变体排序。先锋额外排除最终蓝门前格；快活继续按现有前插与撤退逻辑运行。高台不使用该硬过滤，保留覆盖所有阻挡点的强建议与原路线距离评分。

- [ ] **Step 5: 验证并提交**

运行定向测试、TypeScript 构建、全量 Jest；重新生成并实机演习 11-20。
