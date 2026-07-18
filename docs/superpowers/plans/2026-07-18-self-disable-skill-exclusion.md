# 自我失能技能排除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 传统 `rule-core` 在构造候选技能时排除技能结束后令自身或友方失能的已确认技能。

**Architecture:** 在 `CandidateBuilder` 的候选技能枚举处维护精确的“干员名 → 技能序号”只读表，并在现有偏好技能过滤之前去除这些技能。测试只通过公开的 `buildSquadBeam` 验证候选数与最终技能，不新增测试专用接口。

**Tech Stack:** TypeScript、Jest、现有 engine v2 CombatModel。

---

## File structure

- Modify: `src/engine/CandidateBuilder.ts` — 在 `pickOptions` 的技能枚举链中加入精确排除表。
- Modify: `__tests__/EngineV2.test.ts` — 以单干员 Beam Search 验证禁用技能不参与候选、未禁用技能数量保持可用。

### Task 1: 写出候选排除的回归测试

**Files:**
- Modify: `__tests__/EngineV2.test.ts:192-206`
- Test: `__tests__/EngineV2.test.ts`

- [ ] **Step 1: 在现有偏好技能测试后写入失败测试**

```ts
  it("excludes self-disabling skills while retaining the other skill choices", () => {
    const exclusions = new Map<string, { blocked: number[]; choices: number }>([
      ["阿米娅", { blocked: [2, 3], choices: 1 }],
      ["幽灵鲨", { blocked: [2], choices: 1 }],
      ["雷蛇", { blocked: [2], choices: 1 }],
      ["远山", { blocked: [2], choices: 1 }],
      ["布洛卡", { blocked: [2], choices: 1 }],
      ["断罪者", { blocked: [2], choices: 1 }],
      ["森蚺", { blocked: [3], choices: 2 }],
      ["蚀清", { blocked: [1], choices: 1 }],
      ["极光", { blocked: [2], choices: 1 }],
      ["洛洛", { blocked: [2], choices: 1 }],
      ["苍苔", { blocked: [2], choices: 1 }],
    ]);
    const mapData = makeMapData();
    const facts = extractStageFacts(mapData);
    const encounter = buildEncounterContext(mapData, facts);

    for (const [name, { blocked, choices }] of exclusions) {
      const record = getCombatOperatorByName(name)!;
      const players = new Map([[record.id, {
        id: record.id, name: record.name, rarity: record.rarity, own: true,
        elite: 2, level: 60, potential: 1,
      }] as [string, PlayerOperator]]);
      const beam = buildSquadBeam(facts, encounter, { playerOperators: players });

      expect(beam.expandedStates).toBe(choices);
      expect(blocked).not.toContain(beam.squads[0][0]?.skill);
    }
  });
```

- [ ] **Step 2: 运行该测试，确认旧实现失败**

Run: `npx jest __tests__/EngineV2.test.ts --runInBand`

Expected: FAIL，`expandedStates` 仍包含被禁用技能，例如阿米娅为 `3` 而非 `1`。

### Task 2: 在候选构造处过滤精确名单

**Files:**
- Modify: `src/engine/CandidateBuilder.ts:15-31`
- Modify: `src/engine/CandidateBuilder.ts:221-236`
- Test: `__tests__/EngineV2.test.ts`

- [ ] **Step 1: 在 `PREFERRED_SKILLS` 后新增精确名单**

```ts
// ponytail: static list until the combat model exposes self-disable effects; replace it with that explicit field when available.
const SELF_DISABLE_SKILLS: Readonly<Record<string, readonly number[]>> = {
  "阿米娅": [2, 3], "幽灵鲨": [2], "雷蛇": [2], "远山": [2],
  "布洛卡": [2], "断罪者": [2], "森蚺": [3], "蚀清": [1],
  "极光": [2], "洛洛": [2], "苍苔": [2],
};
```

- [ ] **Step 2: 在 `pickOptions` 中先读取并过滤该名单**

```ts
    const preferredSkills = PREFERRED_SKILLS[record.name];
    const excludedSkills = SELF_DISABLE_SKILLS[record.name];
    return Array.from({ length: skillCount }, (_, index) => index + 1)
      .filter(skill => !excludedSkills || !excludedSkills.includes(skill))
      .filter(skill => !preferredSkills || preferredSkills.includes(skill))
```

- [ ] **Step 3: 运行定向测试，确认通过**

Run: `npx jest __tests__/EngineV2.test.ts --runInBand`

Expected: PASS，全部 `EngineV2` 用例通过。

- [ ] **Step 4: 构建与完整回归**

Run: `npm run build:node && npm test`

Expected: TypeScript 构建成功，全部 Jest 套件通过。

- [ ] **Step 5: 提交实现和回归测试**

```bash
git add src/engine/CandidateBuilder.ts __tests__/EngineV2.test.ts
git commit -m "fix(engine): exclude self-disabling skills"
```
