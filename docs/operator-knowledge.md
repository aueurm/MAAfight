# Operator Knowledge v1

知识层分为两个文件：`src/data/operatorKnowledge.generated.v1.json` 是从固定 GameData commit 的技能描述和 `operatorCombat.v2.json` 自动生成的 412 名当前干员知识；`src/data/operatorKnowledge.v1.json` 是手工覆盖层。加载时先读取生成层，再按 id 或 name 合并手工字段，因此刷新游戏数据不会抹掉手工策略选择。

生成层只保存描述标签、语义化空间属性和 12 维向量；职业、基础攻击范围、数值技能效果继续复用 `operatorCombat.v2.json`，避免两份模型漂移。加载时会拒绝 commit 或干员数不一致的生成层。

使用现有更新入口即可同批刷新战斗模型与生成知识层：

```bash
node scripts/update-game-data.js --ref <commit-or-branch>
```

更新器会在临时目录先生成两份模型，通过来源 commit 和条目数校验后原子替换；它不会写入手工覆盖文件。

## DeepSeek runtime

生产 DeepSeek 生成必须由 pipeline 提供按当前技能解析的知识；缺少解析器会直接报错。context 会包含知识模型身份，以及每个技能自身的范围和标签。DeepSeek 将这些标签作为候选排序与站位依据，不得将其描述为通关保证；BattleDSL 的合法性仍由确定性校验器负责。

## 两类条目

已有干员用 `name` 或已有 `id` 覆盖策略信息，不改变属性、技能数值和 MAA 导出。

```json
{
  "name": "某干员",
  "capabilities": ["area", "control"],
  "usageScenarios": ["boss", "multi-lane"],
  "deployment": { "selectionBias": 4, "temporary": false },
  "skills": { "3": { "preferred": true } }
}
```

尚未进入 `operatorCombat.v2.json` 的新干员必须提供 `id`、`name`，以及 `fallbackTo` 或完整 `vector`。系统继承相似干员的可解析战斗档案，并在 `modelCoverageGaps` 标记 `knowledge_similarity_fallback:<id>`；这只是候选排序和静态规划的近似，不能代表通关率。

```json
{
  "id": "char_future_example",
  "name": "未来干员",
  "fallbackTo": "char_002_amiya",
  "role": "caster",
  "position": "RANGED",
  "damageType": "arts",
  "roles": ["burst-caster"],
  "capabilities": ["arts-damage", "burst", "area"],
  "capabilityWeights": { "burst": 0.5, "area": 0.25 },
  "usageScenarios": ["boss", "clustered-enemies"],
  "deployment": { "selectionBias": 2, "canReceiveAllyHealing": true },
  "relationships": { "similarTo": ["阿米娅"], "combosWith": ["塞雷娅"] },
  "provenance": { "source": "external", "confidence": 0.6 }
}
```

`fallbackTo` 可写现有干员的 id 或名字。未写 `fallbackTo` 时，系统以余弦相似度从现有战斗档案中选择最高分项；并列按 id 排序，保证结果可复现。

## 空间与技能

`spatial.range` 是基础攻击格相对坐标 `[row, col]`；`spatial.skillRanges` 按技能编号覆盖范围。它会直接覆盖继承档案的范围，因此新干员不必等待完整战斗模型更新就能提供可用的站位信息。

```json
{
  "spatial": {
    "attackPattern": "area",
    "coverage": "forward-extended",
    "skillRangeBehavior": "extends",
    "range": [[0, 0], [0, 1], [-1, 1], [1, 1]],
    "skillRanges": { "3": [[0, 0], [0, 1], [0, 2], [-1, 1], [1, 1]] },
    "routeCoverageWeight": 1.2,
    "routeDistanceWeight": 0.8
  },
  "skills": {
    "3": { "preferred": true, "tags": ["burst", "range-extension"] }
  }
}
```

`range` 和 `skillRanges` 的坐标仍是内部 `[row, col]`；MAA 导出继续在 exporter 统一转换成 `[x, y]`。`routeCoverageWeight` 和 `routeDistanceWeight` 只影响候选排序与站位排序，默认都是 `1`。

## 向量与未来生成

`vector` 是长度固定为 12、元素范围 `0..1` 的数值数组。维度顺序固定在根字段 `vectorAxes`：`frontline`、`ranged`、`physical`、`arts`、`healing`、`burst`、`area`、`control`、`antiAir`、`rangeCoverage`、`skillRangeChange`、`mobility`。

缺省时系统从战斗档案、技能范围和结构化能力自动生成向量。外部描述提取器或演习结果分析器可写入 `roles`、`capabilities`、`spatial`、`relationships`、`vector` 与 `provenance`，再通过同一 JSON 校验进入规划器；不会直接修改 planner 代码。

## 校验边界

加载时会拒绝错误 schema、重复条目、非法向量、非法范围或未知显式回退目标。静态候选仍须通过 BattleDSL、地图、`ScriptValidator` 和 `MAAProtocolValidator`；deepseek-core 的候选仍只会写入 `output/.candidates/`，直到真实三星演习发布。
