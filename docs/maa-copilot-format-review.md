# MAA Copilot 格式理解与生成策略

> 状态：已按 2026-06-17 审阅意见确认方向
>
> 日期：2026-06-17

## 背景

当前生成结果在 MAA 导入 / 预览时暴露出几个格式与策略问题：

- 干员显示中出现类似 `先锋：伊内丝 / 风笛` 的组合文本，容易被 MAA 当成待识别名称的一部分。
- `requirements.module` 固定为 `0`，没有输出 `module_level`。
- `skill_level` 固定为 `7`，不能表达专精。
- 编队人数偏少或结构诡异，没有尽量构造 12 人编队。
- 技能选择、模组选择和干员强度排序仍不够可信。

本文记录 MAA copilot 格式理解、当前生成器偏差和已确认的改造方向。

长期开发约束已经沉淀到 [MAA Copilot 导出契约](maa-copilot-export-contract.md)。后续修改导出逻辑时，以契约为准；本文主要保留问题背景和推理过程。

## 已确认决策

2026-06-17 审阅确认：

- 默认导出改为固定 12 人编队。
- 默认不使用 `groups`；因为生成器已经对照玩家干员库给出编队，默认没有必要再做分组替换。
- `groups` 只保留为显式模式，用于需要候选替换的作业。
- 允许根据 `operatorStrength.cn.json` 的 `modulePriority` 输出推荐模组。
- `opers` 尽量补满 12 人，即使部分干员不会部署。
- 不采用“高精度爆发技能不交给 `SkillDaemon`，只输出 warning，后续再做技能轴”的保守策略。
- 默认文件名改为“关卡编号 + 关卡名”，便于辨认。

## 信息来源

已核对的一手来源：

- MAA 官方文档：[战斗流程协议](https://docs.maa.plus/zh-cn/protocol/copilot-schema.html)
- MAA 官方示例：[OF-1_credit_fight.json](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/archive/master-v1/resource/copilot/OF-1_credit_fight.json)

已核对的本项目代码：

- `src/battle/ScriptGenerator.ts`
- `src/battle/ScriptExporter.ts`
- `src/battle/MAAProtocolValidator.ts`
- `src/core/pipeline.ts`
- `src/shared/operatorDB.ts`
- `src/data/operatorStrength.cn.json`
- `src/types.ts`

需要补充确认的信息：

- 当前最新版 MAA operators JSON 是否已经包含技能专精、模组编号、模组等级、部署费用等字段。
- MAA GUI 对同时存在 `opers` 和 `groups` 的作业如何展示、识别和组队。

## 官方协议要点

### `opers`

`opers` 是指定干员列表。

每个条目可以包含：

- `name`
- `skill`
- `skill_usage`
- `skill_times`
- `requirements`

`name` 必须是真实干员名，不应该拼接职业、任务、多个候选人或展示文本。

### `groups`

`groups` 是候选干员组。

官方文档说明：

- `groups[].name` 是群组名。
- `actions[].name` 可以引用这个群组名。
- `groups[].opers[]` 内部才是真实候选干员。
- 候选干员“任选其一”，MAA 会按练度等因素选择。

官方示例中存在：

```json
{
  "actions": [
    { "type": "Deploy", "name": "先锋", "location": [5, 3], "direction": "Right" }
  ],
  "groups": [
    {
      "name": "先锋",
      "opers": [
        { "name": "推进之王", "skill": 2 },
        { "name": "风笛", "skill": 2 }
      ]
    }
  ]
}
```

因此，`先锋` 作为群组名本身是协议允许的。

问题不在“不能有群组名”，而在不能把群组展示文本误写成干员名。例如下面这种都应该禁止：

```json
{ "name": "先锋：伊内丝 / 风笛" }
{ "name": "先锋: 伊内丝 2 [Lv.7] 不使用模组 / 风笛 2 [Lv.7] 不使用模组" }
```

### `actions[].name`

`Deploy` 的 `name` 可以是：

- 真实干员名。
- `groups[].name` 中定义的群组名。

但它必须与某个真实干员名或群组名精确对应。

`actions[].name` 不应该包含职业前缀、冒号、候选列表、技能等级展示、模组展示或其他 UI 文本。

### `requirements`

官方协议支持的字段包括：

- `elite`
- `level`
- `skill_level`
- `module`
- `module_level`
- `potential`

但官方文档也说明 `requirements` 是保留接口，暂未实现。

这意味着：

- 可以把 `requirements` 作为人工检查、GUI 展示和作业说明。
- 不应该假设 MAA 会严格按照 `requirements` 自动筛选或切换干员配置。
- `module` 和 `module_level` 写入 JSON 不等于 MAA 会自动启用对应模组。

### action 类型

官方列出的 action 类型包括：

- `Deploy`
- `Skill`
- `Retreat`
- `SpeedUp`
- `BulletTime`
- `SkillUsage`
- `Output`
- `SkillDaemon`
- `MoveCamera`
- `ResetStopwatch`

当前项目中的 `Wait` 和 `SkillUse` 不在官方标准列表中。它们可以作为内部表达，但严格导出时应该转换为官方字段或给出明确 warning。

## 当前项目偏差

### 1. `hybrid` 输出可能造成展示和识别混乱

历史实现中 `src/core/pipeline.ts` 默认 `squadMode` 是 `hybrid`。

`hybrid` 会同时保留：

- 顶层 `opers`
- `groups`
- `actions` 中的真实干员名

这可能导致 MAA GUI 同时显示固定干员和群组候选，形成截图里那种“先列一批真实干员，再列一批职业组”的混合结果。

确认方向：默认使用 `fixed`。

### 2. `requirements` 信息不完整

当前 `ScriptGenerator` 里：

- `skill_level` 固定为 `7`。
- `module` 固定为 `0`。
- 没有 `module_level`。
- `potential` 来自玩家导出。
- 没有专精、技能等级、模组等级的真实数据源。

这会导致 MAA 预览中大量显示“不使用模组”，也无法表达“有模组尽量使用”。

确认方向：优先使用玩家干员数据中的真实 `module` / `module_level`；如果缺失，则允许根据 `modulePriority` 输出推荐模组。

### 3. 技能选择过于粗糙

当前 `src/shared/operatorDB.ts` 只有每个干员的默认 `skill` 和粗 tier。

`src/data/operatorStrength.cn.json` 已经有：

- `skillPriority`
- `modulePriority`
- `automationScore`
- `roleScores`
- `tags`

但生成器目前没有把这些信息充分用于：

- 根据任务选择技能。
- 判断 `skill_usage`。
- 判断是否适合 `SkillDaemon`。
- 判断是否需要人工开技能。

例如 Boss 爆发、挂机站场、回费、防空、治疗的技能选择规则不应该相同。

### 4. 编队人数没有明确 12 人目标

当前生成器会把 `selectedTasks` 截断到 12，但没有明确“尽量补满 12 人编队”。

关卡的 `characterLimit` 是部署上限，不等于可编入队伍人数。生成 MAA 草稿时，即使只部署 6-8 人，也应该尽量提供完整 12 人阵容：

- 主部署干员。
- 替补阻挡。
- 替补治疗。
- 替补防空。
- 低费补位。
- 快速复部署或容错位。

这能减少 MAA 组队时缺人、误选和人工补队成本。

### 5. 文案仍有旧定位残留

`ScriptGenerator` 当前还会生成：

- `doc.title: "${stageId} AI-Generated"`
- `metadata.source: "ai"`

这和当前“规则化生成器”的定位冲突。

## 建议生成策略

### 默认模式：固定 12 人编队

建议默认导出固定编队模式：

- 顶层 `opers` 尽量放 12 名真实干员。
- `actions[].name` 只引用真实干员名。
- 默认不输出 `groups`，或仅在用户显式选择 groups 模式时输出。
- 不在任何 `name` 字段中拼接职业、冒号、候选列表或展示说明。

这样最接近“MAA 直接识别真实干员并组队”的用户预期。

### groups 模式：显式 opt-in

如果需要保留候选替换能力，应作为显式模式：

- `actions[].name` 使用短、稳定的群组名，例如 `先锋1`、`治疗1`。
- `groups[].name` 与 action 精确匹配。
- `groups[].opers[].name` 全部是真实干员名。
- 顶层 `opers` 应为空，避免同时固定和分组造成 UI 混乱。

不建议默认输出 `hybrid`。

### 干员名净化规则

所有写入协议 `name` 的字段都应通过校验：

- 真实干员名必须来自玩家干员库、默认干员池或官方干员数据。
- 群组名只能出现在 `groups[].name` 和引用它的 `actions[].name`。
- 禁止在干员名中出现 `:`、`：`、`/`、`[`、`]` 这类展示拼接字符。
- 禁止把 `先锋：伊内丝 / 风笛` 这种 UI 文本写入 `name`。

### 12 人补队策略

建议把编队分成两层：

1. 必部署干员

   来自 `recommendedTasks`、部署动作和关键战术需求。

2. 备选补位干员

   在玩家拥有干员中按任务缺口、强度和泛用性补满 12 人。

补队优先级建议：

1. 已规划部署动作中的干员。
2. 缺口任务：治疗、防空、阻挡、Boss 输出、回费。
3. 高泛用高强度干员。
4. 自动化友好干员。
5. 低费或快速复部署容错位。

如果玩家干员库不足 12 人，应保留 `operatorGaps` 和 warning。

## 技能与模组策略

### 技能选择

建议以 `BattleTask` 为主，而不是只用职业默认技能。

示例规则：

| 任务 | 技能倾向 |
| --- | --- |
| `early_dp` | 回费技能优先，自动释放友好优先 |
| `lane_hold` | 站场、永续、低操作技能优先 |
| `anti_air` | 对空稳定输出技能优先 |
| `arts_damage` | 法伤输出技能优先 |
| `healing` | 稳定治疗或自动化友好技能优先 |
| `boss_kill` | 爆发技能优先，可进入 `SkillDaemon`，但仍需在 metadata 中保留风险说明 |
| `fast_redeploy` | 高频部署价值优先，通常不依赖自动技能 |

`skill_usage` 建议：

- 自动触发或不需要手动开的技能：`0`。
- 回费、永续、挂机技能：可用 `1`。
- 需要开固定次数的技能：用 `2` + `skill_times`。
- 高精度爆发技能：本阶段仍允许进入 `SkillDaemon`，不因高精度标签而降级为“只 warning 不执行”。
- 避免使用 `3`，官方文档里它仍偏占位性质。

### 模组输出

建议分两种模式：

1. 严格模式

   只有当玩家干员数据明确包含模组编号和等级时，才输出：

   ```json
   "requirements": {
     "module": 1,
     "module_level": 3
   }
   ```

2. 推荐模式

   如果只有 `operatorStrength.cn.json` 的 `modulePriority`，允许输出推荐模组字段。

   当前约定：

   - `core` / `recommended` -> `module: 1`、`module_level: 3`
   - `optional` -> `module: 1`、`module_level: 1`
   - `none` / 缺失 -> `module: 0`、`module_level: 0`

注意：这仍然是推荐要求，不是 MAA 执行层强制切换模组的证明。

如果后续要进一步精确化，需要确认：

- MAA operators JSON 是否导出模组信息。
- 如果不导出，是否允许根据强度数据做“推荐模组”而非“实际模组”。

## Validator 应补充的规则

建议在 `MAAProtocolValidator` 或新增严格导出检查中加入：

- `opers[].name` 必须是干员名，不能是群组名或展示拼接文本。
- `groups[].opers[].name` 必须是干员名。
- `actions[].name` 必须能匹配某个干员名或群组名。
- `groups[].name` 不能和真实干员名冲突。
- 禁止默认 `hybrid` 同时制造固定干员和群组候选的歧义。
- `requirements.module > 0` 时必须同时考虑 `module_level`。
- `requirements.skill_level` 不应固定写死为 `7`。
- 导出标准 MAA JSON 时不得出现 `Wait` / `SkillUse` 等非标准 action，或必须降级为 warning。

## 建议实施路线

### 阶段 1：文档和测试先行

- 确认本文结论。
- 增加 MAA copilot 格式兼容测试。
- 增加“name 字段不得含展示拼接字符”的测试。
- 增加“固定编队尽量 12 人”的测试。
- 增加 `requirements.module_level` 的导出测试。

### 阶段 2：改默认导出策略

- 默认从 `hybrid` 改为固定 12 人模式。
- actions 默认使用真实干员名。
- groups 作为显式 opt-in。
- 移除 `AI-Generated` 和 `metadata.source: "ai"`。

### 阶段 3：扩展玩家干员数据

- 扩展 `PlayerOperator`，保留未知字段。
- 如果 MAA 导出包含技能、模组、费用字段，则接入。
- 如果 MAA 导出不包含，则在文档中明确无法证明玩家实际模组。

### 阶段 4：技能与模组规则化

- 使用 `operatorStrength.cn.json` 的 `skillPriority`、`modulePriority`、`automationScore`。
- 为常用高强干员维护更准确的默认技能。
- 将 `skill_usage` 与任务和自动化标签绑定。
- 将模组分为“实际拥有”和“推荐使用”两类信息。

## 样本说明

本轮用户提供的 `MAACopilot_落叶逐火 - CF-9 - 决战！燃烧的狩魂！.json` 是 MAA copilot 作业示例，不是 MAA operators 导出文件。

该样本验证了 `groups` 的合法用法：

- `groups[].name` 可以是非干员名，例如 `补伤害`。
- `actions[].name` 可以引用该群组名。
- `groups[].opers[].name` 仍必须是真实干员名。

MAAfight 默认不使用 `groups`，但显式 `groups` 模式应保持这种合法结构。
