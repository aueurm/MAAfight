# 高早压关先锋首发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让高部署需求关卡在玩家有 E2 先锋时由先锋占据 Beam 第一个槽位。

**Architecture:** 复用现有 `EncounterContext.demand.deployment`，只约束 `buildSquadBeam` 的首槽候选集合。后续槽位、能力评分、部署和主力接替逻辑保持不变。

**Tech Stack:** TypeScript、Jest、engine v2 Beam Search。

---

## File structure

- Modify: `src/engine/CandidateBuilder.ts` — 为高部署需求 Beam 首槽限定现有先锋候选。
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
