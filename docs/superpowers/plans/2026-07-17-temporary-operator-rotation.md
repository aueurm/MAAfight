# 临时干员轮换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 让传统模式按费用、技能驻场时间和干员实际再部署时间轮换先锋与快速复活，而不使用固定击杀数。

**Architecture:** 战斗数据构建器从角色属性帧与潜能属性中生成再部署时间；CombatModel 将其解析到玩家实际档案。CandidateBuilder 维护活动干员与占用格，在人数达到上限时只以先锋接替主力，并在构造末尾为一名可验证的快速复活生成撤退与二次部署。

**Tech Stack:** Node.js、TypeScript、Jest、既有 MAA Copilot JSON v3 导出。

---

### Task 1: 将真实再部署时间写入战斗模型

**Files:**
- Modify: scripts/build-operator-combat-model.js:73-86,235-279
- Modify: __tests__/CombatModelBuilder.test.ts:9-118
- Modify: src/data/operatorCombat.v2.json（由构建器机械生成）

- [ ] **Step 1: 写入会失败的构建器断言**

在 fixture 的两个 E2 属性帧加上 respawnTime: 18，并加入第三个潜能条目的加法修正；随后断言产物保留两项数据：

~~~ts
potentialRanks: [
  {}, {},
  { buff: { attributes: { attributeModifiers: [
    { attributeType: "RESPAWN_TIME", formulaItem: "ADDITION", value: -2 },
  ] } } },
],

expect(model.operators.char_test).toMatchObject({
  respawnTime: 18,
  potentialRespawnTimeModifiers: [0, 0, -2],
});
~~~

- [ ] **Step 2: 运行单测，确认字段尚未生成**

Run: npm test -- --runInBand __tests__/CombatModelBuilder.test.ts

Expected: FAIL，respawnTime 与 potentialRespawnTimeModifiers 缺失。

- [ ] **Step 3: 最小化编译器改动**

在构建器新增仅处理当前上游已出现的 ADDITION 修正的辅助函数，并在 compileOperator 返回值写入基准与每个潜能层级的修正：

~~~js
function potentialRespawnTimeModifiers(character) {
  return (character.potentialRanks || []).map(rank => (rank?.buff?.attributes?.attributeModifiers || [])
    .filter(modifier => modifier?.attributeType === "RESPAWN_TIME" && modifier?.formulaItem === "ADDITION")
    .reduce((total, modifier) => total + number(modifier.value), 0));
}

// compileOperator 的返回对象中
respawnTime: Math.max(0, number(frames.at(-1)?.data?.respawnTime)),
potentialRespawnTimeModifiers: potentialRespawnTimeModifiers(character),
~~~

- [ ] **Step 4: 运行构建器单测，确认通过**

Run: npm test -- --runInBand __tests__/CombatModelBuilder.test.ts

Expected: PASS。

- [ ] **Step 5: 用已固定的本地 GameData 重建运行时模型**

Run:

~~~powershell
node scripts/build-operator-combat-model.js --game-data C:\tmp\ArknightsGameData\zh_CN\gamedata\excel --commit b327f67a1d73fe9a2501f4e159603a30da75911f
~~~

Expected: 输出新的 modelVersion 与 operatorCount，并只机械更新 src/data/operatorCombat.v2.json。

- [ ] **Step 6: 提交模型数据变更**

~~~powershell
git add scripts/build-operator-combat-model.js __tests__/CombatModelBuilder.test.ts src/data/operatorCombat.v2.json
git commit -m "feat(model): expose operator redeploy time"
~~~

### Task 2: 解析玩家实际再部署时间与技能驻场时长

**Files:**
- Modify: src/engine/CombatModel.ts:8-68,147-206
- Modify: src/engine/types.ts:67-91
- Modify: __tests__/EngineV2.test.ts:100-130

- [ ] **Step 1: 写入会失败的档案解析测试**

在现有模型加载测试后加入夜刀实例，明确验证潜能 3 应包含前三个潜能条目：

~~~ts
const yato = getCombatOperatorByName("麒麟R夜刀")!;
const profile = resolveOperatorProfile(yato, 1, {
  id: yato.id, name: yato.name, rarity: yato.rarity,
  own: true, elite: 2, level: 90, potential: 3,
});

expect(profile.respawnTime).toBe(16);
expect(profile.skillDuration).toBe(20);
~~~

- [ ] **Step 2: 运行测试，确认运行时档案尚未暴露字段**

Run: npm test -- --runInBand __tests__/EngineV2.test.ts

Expected: FAIL，ResolvedOperatorProfile 没有 respawnTime 和 skillDuration。

- [ ] **Step 3: 扩展运行时记录与档案**

为 CombatOperatorRecord 加入模型字段，为 ResolvedOperatorProfile 加入已解析字段；只按玩家已解锁潜能数叠加编译器输出的数组：

~~~ts
const potentialCount = Math.max(0, Math.min(
  record.potentialRespawnTimeModifiers.length,
  player?.potential ?? 0,
));
const respawnTime = Math.max(0, record.respawnTime
  + record.potentialRespawnTimeModifiers.slice(0, potentialCount)
    .reduce((total, modifier) => total + modifier, 0));

// resolveOperatorProfile 的 resolved 对象中
skillDuration: Math.max(0, levelRecord?.duration || 0),
respawnTime,
~~~

- [ ] **Step 4: 运行档案与类型检查**

Run: npm run build:node; npm test -- --runInBand __tests__/EngineV2.test.ts

Expected: TypeScript 编译成功，档案测试通过。

- [ ] **Step 5: 提交档案解析变更**

~~~powershell
git add src/engine/CombatModel.ts src/engine/types.ts __tests__/EngineV2.test.ts
git commit -m "feat(engine): resolve player redeploy timing"
~~~

### Task 3: 以活动名额构造先锋接替与快活二次部署

**Files:**
- Modify: src/engine/CandidateBuilder.ts:425-507
- Modify: __tests__/EngineV2.test.ts:61-105,170-240

- [ ] **Step 1: 写入三个会失败的候选动作测试**

扩展 testPick，使其可指定 role、subProfession、cost、skillDuration 与 respawnTime。加入以下断言：

~~~ts
expect(actions.map(action => action.type)).toEqual([
  "SpeedUp", "Deploy", "Deploy", "Retreat", "Deploy", "SkillDaemon",
]);
expect(actions[3]).toMatchObject({ type: "Retreat", name: "先锋", costs: 20 });
expect(actions[3]).not.toHaveProperty("kills");
expect(actions[4]).toMatchObject({ type: "Deploy", name: "后备主力", costs: 20 });

expect(executorActions.filter(action => action.type === "Deploy")).toHaveLength(2);
expect(executorActions.find(action => action.type === "Retreat")).toMatchObject({ pre_delay: 20_000 });
expect(executorActions.filter(action => action.type === "Deploy")[1]).toMatchObject({ pre_delay: 16_000 });

expect(unknownRespawnActions.filter(action => action.type === "Deploy")).toHaveLength(1);
expect(temporaryGoalMapActions.find(action => action.type === "Deploy" && action.name === "先锋")?.location)
  .not.toEqual([2, 5]);
~~~

temporaryGoalMap 同时提供蓝门邻接格 [2, 5] 与普通近战格。每个测试用格数至少等于并发上限；同时逐序计算 Deploy 加一、Retreat 减一，断言活动数从不超过 characterLimit，并以 validateMAAProtocol 验证脚本。

- [ ] **Step 2: 运行候选构造测试，确认当前实现没有撤退动作**

Run: npm test -- --runInBand __tests__/EngineV2.test.ts

Expected: FAIL，当前候选只有部署与 SkillDaemon。

- [ ] **Step 3: 以一个活动干员表替换永久已用格表**

在 buildCandidate 内使用 Map<string, ActiveDeployment> 追踪 operatorId、pick 和 placement，同时用占用格集合限制当前在场单位。新增的内部结构为：

~~~ts
interface ActiveDeployment {
  pick: EnginePick;
  placement: RankedPlacement;
}

const active = new Map<string, ActiveDeployment>();
const occupiedPositions = new Set<string>();
~~~

部署时写入二者；撤退时从二者删除。因此同一快速复活可以在撤退后复用原部署格，而主力仍不能重叠。

- [ ] **Step 4: 实现先锋费用接替**

当下一名非临时主力到来而 active.size === characterLimit 时，仅寻找已在场的非蓝门先锋；在其后备主力费用足够时插入紧邻动作：

~~~ts
actions.push({
  type: "Retreat",
  name: vanguard.pick.name,
  costs: Math.round(nextPick.profile.attributes.cost),
});
active.delete(vanguard.pick.operatorId);
occupiedPositions.delete(String(vanguard.placement.point.row) + "," + String(vanguard.placement.point.col));
~~~

下一条动作必须是已有的 Deploy(nextPick)。适格先锋不存在时，后续 Task 5 的普通非前线轮换负责接替。

- [ ] **Step 5: 实现一名快速复活的驻场与二次部署**

快速复活仅指 subProfession === "executor"、不在蓝门前线、skillDuration > 0 且 respawnTime > 0 的在场干员。所有主力部署动作完成后，对第一个符合条件的干员追加：

~~~ts
actions.push({ type: "Retreat", name: executor.pick.name, pre_delay: executor.pick.profile.skillDuration * 1000 });
actions.push({
  type: "Deploy",
  name: executor.pick.name,
  location: [executor.placement.point.row, executor.placement.point.col],
  direction: executor.placement.direction,
  costs: Math.round(executor.pick.profile.attributes.cost),
  pre_delay: executor.pick.profile.respawnTime * 1000,
});
~~~

在代码旁保留：

~~~ts
// ponytail: rotate one executor; add threat-window scheduling only after rehearsals prove it changes a result.
~~~

没有精确数据时不追加第二次 Deploy。临时先锋和快速复活在有其他可选点时过滤掉蓝门前线格；若没有其他可选点，跳过该临时干员，不能让它承担会被自动撤退的前线职责。

- [ ] **Step 6: 运行候选构造测试与节点构建**

Run: npm run build:node; npm test -- --runInBand __tests__/EngineV2.test.ts __tests__/MAAProtocolValidator.test.ts

Expected: TypeScript 编译成功，三个新动作测试与既有协议测试通过。

- [ ] **Step 7: 提交候选构造变更**

~~~powershell
git add src/engine/CandidateBuilder.ts __tests__/EngineV2.test.ts
git commit -m "feat(engine): rotate temporary operators"
~~~

### Task 4: 全量验证与困难关卡演习反馈

**Files:**
- Verify: src/engine/CandidateBuilder.ts
- Verify: src/data/operatorCombat.v2.json
- Output only: output/.candidates/

- [ ] **Step 1: 运行全量静态验证**

Run: npm test; npm run build:node; npm run corpus:audit

Expected: 所有测试、Node 构建和语料审计成功；无 Wait、SkillUse、固定 kills 撤退动作或超额活动干员。

- [ ] **Step 2: 生成并校验困难关卡候选**

Run:

~~~powershell
node dist/index.js generate --stage 11-20 --output output/.candidates/11-20-rotation.json --pretty
node dist/index.js validate --file output/.candidates/11-20-rotation.json
~~~

Expected: 静态协议有效，候选仅保留在 output/.candidates/。

- [ ] **Step 3: 在 MuMu 演习并记录可观察结果**

用既有 GUI runner 运行该候选，等待结算观察器返回星数与失败状态。记录部署、撤退、二次部署是否实际执行以及是否因费用、冷却或前线空缺失败。

- [ ] **Step 4: 只根据本次观察修正一个根因**

若演习发现错误，先保存运行反馈到既有反馈路径，再只修改触发该错误的共享规则，重跑 Task 4 的静态验证与演习。未获真实三星结果的候选不得移动到 output/。

### Task 5: 满员后的普通后备轮换

**Files:**
- Modify: `src/engine/CandidateBuilder.ts:525-533`
- Test: `__tests__/EngineV2.test.ts:389-416`

- [ ] **Step 1: 写入失败回归测试**

~~~ts
it("rotates a non-frontline operator when a reserve arrives after the vanguard", () => {
  const mapData = makeMapData();
  mapData.options.characterLimit = 2;
  mapData.deploymentPoints = [
    { row: 2, col: 5, buildableType: "melee" },
    { row: 1, col: 3, buildableType: "ranged" },
    { row: 2, col: 3, buildableType: "melee" },
  ];
  const built = buildCandidate({
    stageCode: "V2-1", mapData, facts: extractStageFacts(mapData), openingPressure: false,
    picks: [
      testPick("前线", "MELEE", [[0, 0]], { role: "tank", subProfession: "protector" }),
      testPick("非前线", "RANGED"),
      testPick("后备", "MELEE", [[0, 0]], { cost: 20 }),
    ],
    positionVariant: 0, timingVariant: 0, options: {},
  });

  expect(built.script.actions.map(action => [action.type, action.name])).toEqual([
    ["SpeedUp", undefined], ["Deploy", "前线"], ["Deploy", "非前线"],
    ["Retreat", "非前线"], ["Deploy", "后备"], ["SkillDaemon", undefined],
  ]);
  expect(built.script.actions[3]).toMatchObject({ costs: 20 });
});
~~~

- [ ] **Step 2: 运行测试确认旧实现跳过后备**

Run: `npx jest __tests__/EngineV2.test.ts --runInBand`

Expected: FAIL，动作中没有 `Retreat 非前线` 与 `Deploy 后备`。

- [ ] **Step 3: 扩展既有接替选择**

将满员分支中的先锋变量改为同一 `replacement`：先找非蓝门先锋；找不到时依次寻找非蓝门、非医疗、非快活的非偏好单位，再寻找同条件的任意单位。`Retreat.costs` 继续使用下一名后备的实际费用，下一动作仍由现有 `addDeployment` 生成。

- [ ] **Step 4: 运行定向测试、构建和全量测试**

Run: `npx jest __tests__/EngineV2.test.ts --runInBand`

Run: `npm run build:node`

Run: `npm test`

Expected: 全部成功，协议活动人数始终不超过关卡上限。

- [ ] **Step 5: 生成 11-20 v5 并实机演习**

Run: `node dist/index.js generate --stage 11-20 --output output/.candidates/practice-11-20-reserves-v5.json --pretty --new-candidate`

Expected: Mon3tr、斩业星熊、赤刃明霄陈均出现于 Deploy 动作；静态校验通过后在 MuMu 演习观察后期替换。
