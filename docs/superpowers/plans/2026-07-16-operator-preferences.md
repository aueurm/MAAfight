# 干员选择偏好 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在公共模型和玩家干员库两种模式下，优先保留用户指定的干员与技能，同时继续按关卡能力需求选择小队。

**Architecture:** 将固定的技能白名单和干员偏好名单放在 `CandidateBuilder.ts`，它们只影响已有的 `pickOptions` 和 `marginalScore`。现有能力计算继续使用每个干员、每个技能的战斗数据；玩家干员库仍只决定可选范围。

**Tech Stack:** TypeScript、Node.js、Jest。

---

### Task 1: 将偏好接入现有小队 Beam Search

**Files:**

- Modify: `src/engine/CandidateBuilder.ts:18-40, 151-213`
- Test: `__tests__/EngineV2.test.ts:96-109`

- [ ] **Step 1: 写入失败的玩家干员库技能限制测试**

在 `__tests__/EngineV2.test.ts` 的玩家库测试后添加：

```ts
  it("applies preferred skills after filtering the player roster", () => {
    const eyjafjalla = getCombatOperatorByName("艾雅法拉")!;
    const saria = getCombatOperatorByName("塞雷娅")!;
    const players = new Map([eyjafjalla, saria].map(record => [record.id, {
      id: record.id, name: record.name, rarity: record.rarity, own: true,
      elite: 2, level: 60, potential: 1,
    }] as [string, PlayerOperator]));
    const mapData = makeMapData();
    const facts = extractStageFacts(mapData);
    const picks = buildSquadBeam(facts, buildEncounterContext(mapData, facts), { playerOperators: players }).squads[0];

    expect(picks).toHaveLength(2);
    expect(picks.find(pick => pick.name === "艾雅法拉")?.skill).toBe(2);
    expect(picks.find(pick => pick.name === "塞雷娅")?.skill).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --runInBand __tests__/EngineV2.test.ts`

Expected: FAIL，因为当前艾雅法拉可能被选为 S1 或 S3。

- [ ] **Step 3: 在候选构造处加入最小的固定偏好**

在 `DIRECTIONS` 下定义以下常量，并在 `pickOptions` 过滤技能，在 `marginalScore` 的两个返回值各加 `preferenceBonus(pick)`：

```ts
const PREFERRED_SKILLS: Readonly<Record<string, readonly number[]>> = {
  "凛御银灰": [2], "忍冬": [3], "怒潮凛冬": [2], "赤刃明霄陈": [2, 3],
  "司霆惊蛰": [2, 3], "玛恩纳": [3], "乌尔比安": [2], "黍": [1],
  "维什戴尔": [3], "圣聆初雪": [2], "澄闪": [2, 3], "荒芜拉普兰德": [3],
  "逻各斯": [1], "艾雅法拉": [2], "凯尔希·思衡托": [2], "Mon3tr": [2, 3],
  "纯烬艾雅法拉": [1], "遥": [2], "塑心": [1], "新约能天使": [2, 3],
  "阿斯卡纶": [1], "歌蕾蒂娅": [1],
};
const PREFERRED_OPERATORS = new Set([...Object.keys(PREFERRED_SKILLS), "斩业星熊", "塞雷娅", "酒神"]);
const PREFERENCE_BONUS = 5;

function preferenceBonus(pick: EnginePick): number {
  return PREFERRED_OPERATORS.has(pick.name) ? PREFERENCE_BONUS : 0;
}
```

使用现有 `skillCount` 生成技能号后，仅在存在 `PREFERRED_SKILLS[record.name]` 时过滤不在该数组中的技能。保持 `eligibleOperators` 不变，使公共模型与玩家干员库都走同一个偏好分支。能力增益、费用惩罚、职业/伤害类型/对空/治疗/阻挡计算必须保持不变。

- [ ] **Step 4: 运行引擎测试确认通过**

Run: `npm test -- --runInBand __tests__/EngineV2.test.ts`

Expected: PASS。

- [ ] **Step 5: 构建并运行完整测试**

Run: `npm run build:node && npm test -- --runInBand`

Expected: TypeScript 编译成功，全部 Jest 测试通过。

- [ ] **Step 6: 提交实现**

```bash
git add src/engine/CandidateBuilder.ts __tests__/EngineV2.test.ts
git commit -m "feat(engine): prefer configured operators and skills"
```
