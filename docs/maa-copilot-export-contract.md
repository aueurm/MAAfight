# MAA Copilot 导出契约

> 适用范围：`ScriptGenerator`、`ScriptExporter`、`MAAProtocolValidator`、`pipeline`、GUI 导出入口。
>
> 状态：长期维护规则。修改 MAA copilot 输出结构前必须先读本文。

## 目的

本文把 MAAfight 对 MAA copilot JSON 的理解固化成开发约束，避免再次出现以下问题：

- 把 `先锋：伊内丝 / 风笛` 这类 UI 展示文本写进 `name` 字段，导致 MAA 无法识别干员。
- 默认输出 `groups` / `opers` 混合结构，让 GUI 预览和组队语义变得混乱。
- 编队人数偏少，没有尽量给出 12 人阵容。
- 固定输出“不使用模组”，忽略已有或推荐模组信息。
- 把高精度爆发技能简单降级成 warning-only，导致可执行性过度保守。
- 用 `AI-Generated`、`metadata.source: "ai"` 等文案破坏项目定位。

MAAfight 是规则化 MAA copilot 草稿生成器。导出的 JSON 必须优先保证 MAA 能按协议识别，而不是优先追求 GUI 展示好看。

## 默认导出策略

默认导出必须使用固定编队模式：

- `squadMode` 默认值是 `fixed`。
- 顶层 `opers` 尽量补满 12 名真实干员。
- 即使部分干员不会部署，也可以作为编队补位进入 `opers`。
- 默认 `groups` 为空。
- `actions[].name` 默认引用真实干员名。
- 文件默认命名优先使用“关卡编号 + 关卡名”，例如 `CF-9_决战！燃烧的狩魂！.json`。

只有用户显式选择 `groups` 或 `hybrid` 时，才允许输出非默认编队结构。

## `name` 字段约束

所有写入 MAA 协议 `name` 字段的值，都必须是协议可识别的名字。

### 顶层 `opers[].name`

必须是真实干员名。

禁止写入：

- 职业前缀。
- 任务说明。
- 候选列表。
- 技能等级展示。
- 模组展示。
- 练度展示。
- GUI 拼接文本。

错误示例：

```json
{ "name": "先锋：伊内丝 / 风笛" }
{ "name": "伊内丝 [精2 70] 技能 2 [Lv.7] 不使用模组" }
```

正确示例：

```json
{ "name": "伊内丝", "skill": 2 }
{ "name": "风笛", "skill": 2 }
```

### `groups[].opers[].name`

也必须是真实干员名。

`groups` 只能表达“从这些真实干员中任选其一”，不能把展示文本塞进候选项。

### `groups[].name`

可以是非干员名，但只允许在显式 `groups` 模式使用。

群组名必须短、稳定，并且与 `actions[].name` 精确匹配。

正确示例：

```json
{
  "groups": [
    {
      "name": "补伤害",
      "opers": [
        { "name": "逻各斯", "skill": 1 },
        { "name": "维什戴尔", "skill": 3 }
      ]
    }
  ],
  "actions": [
    { "type": "Deploy", "name": "补伤害", "location": [3, 4], "direction": "Right" }
  ]
}
```

### `actions[].name`

`Deploy` 的 `name` 只能是：

1. 顶层 `opers[].name` 中的真实干员名。
2. 显式 `groups` 模式下的 `groups[].name`。

如果 `actions[].name` 既不是干员名，也不是已定义群组名，`MAAProtocolValidator` 必须给出 warning。

## 禁止的展示文本字符

干员名字段中不应出现明显展示拼接字符：

- `:`
- `：`
- `/`
- `[`
- `]`

这些字符通常意味着代码把 GUI 文案、候选列表或练度说明误写进协议字段。

例外：如果未来存在官方干员名本身包含这些字符，必须在 validator 中显式白名单处理，不能直接放宽整体规则。

## `groups` 使用边界

`groups` 是 MAA 协议支持的候选干员组，但不是 MAAfight 的默认导出结构。

默认不用 `groups` 的原因：

- MAAfight 已经根据玩家干员库选出了具体编队。
- 默认输出候选组会增加 MAA GUI 识别和展示歧义。
- 用户期望通常是导入后得到一套明确的 12 人编队。

显式 `groups` 模式必须满足：

- 顶层 `opers` 为空，避免同时固定编队和候选组。
- `actions[].name` 引用群组名。
- `groups[].opers[].name` 全部是真实干员名。
- 群组名不能包含候选列表或练度描述。

`hybrid` 仅作为兼容和调试模式保留，不得重新成为默认值。

## 12 人编队约束

生成器应把编队分为两类：

1. 必部署干员：来自 `recommendedTasks`、部署动作和关键战术需求。
2. 补位干员：用于补足 12 人，提供治疗、防空、阻挡、Boss 输出、回费、快速复部署或容错能力。

约束：

- `opers` 应优先包含所有会被 `Deploy` 的干员。
- 补位干员不应自动生成多余部署动作。
- 玩家干员库足够时，尽量输出 12 人。
- 玩家干员库不足时，保留 `operatorGaps` 和 warning，不得为了凑数写入不存在的干员。
- 关卡 `characterLimit` 是部署上限，不是编队人数上限。

## 技能策略

技能选择应优先使用离线强度数据：

- 优先读取 `operatorStrength.cn.json` 的 `skillPriority`。
- 缺失时再回退到默认干员池里的 `skill`。
- 不同 `BattleTask` 可以有不同 `skill_usage` 策略。

`skill_usage` 约束：

- 自动触发或无需手动开的技能可用 `0`。
- 回费、永续、挂机、常规输出技能可用 `1`。
- 固定次数技能使用 `2` + `skill_times`。
- 避免默认使用 `3`，官方文档中它仍偏占位性质。

高精度爆发技能不能被一刀切排除出 `SkillDaemon`。

允许做法：

- 继续交给 `SkillDaemon` 或 `skill_usage` 输出。
- 在 metadata、warning 或 explain 中标记风险。
- 后续再补技能轴或更细任务规则。

禁止做法：

- 仅因为 `high_precision_required` 标签，就把可执行技能降级成“只 warning，不输出自动技能”。

## 模组与练度策略

`requirements` 是 MAA 协议字段，但官方文档中属于保留接口。它可以帮助人工检查和 GUI 展示，不应被当成 MAA 会强制切换配置的证明。

输出顺序：

1. 如果玩家 operators JSON 明确包含 `module` / `module_level`，优先使用玩家真实数据。
2. 如果玩家数据缺失，但强度数据存在 `modulePriority`，允许输出推荐模组。
3. 如果两者都缺失，再回退为 `module: 0`、`module_level: 0`。

推荐模组约定：

| `modulePriority` | `requirements.module` | `requirements.module_level` |
| --- | --- | --- |
| `core` | `1` | `3` |
| `recommended` | `1` | `3` |
| `optional` | `1` | `1` |
| `none` / 缺失 | `0` | `0` |

`skill_level` 应优先使用玩家数据中的 `skill_level` / `skillLevel`。缺失时可以使用 fallback，但不能把 fallback 描述成真实专精。

## operators JSON 与 copilot JSON 的区别

不要把 MAA copilot 作业文件误认为 operators JSON。

operators JSON 通常是干员数组：

```json
[
  { "id": "char_002_amiya", "name": "阿米娅", "own": true }
]
```

copilot JSON 通常包含：

```json
{
  "stage_name": "CF-9",
  "opers": [],
  "groups": [],
  "actions": []
}
```

如果样本包含 `stage_name`、`actions`、`groups`，它是作业文件，不是干员库导出。

## metadata 约束

metadata 只能用于 GUI 展示、调试、warning 和 explain。

必须保持：

- metadata 不改变 MAA 执行语义。
- metadata 不作为通关承诺。
- `metadata.source` 使用规则化来源，例如 `maafight-rule`。
- 不再使用 `ai` 或 `AI-Generated` 表达。

## 修改前检查清单

改动以下文件前，必须对照本文检查：

- `src/battle/ScriptGenerator.ts`
- `src/battle/ScriptExporter.ts`
- `src/battle/MAAProtocolValidator.ts`
- `src/core/pipeline.ts`
- `web/src/App.tsx`
- `src/player/OperatorBox.ts`

检查项：

- 默认导出仍是 `fixed`。
- 默认 `groups` 仍为空。
- `opers` 尽量补满 12 名真实干员。
- 每个 `Deploy` 的 `name` 能匹配真实干员名或显式群组名。
- 干员名字段没有职业、候选列表、练度说明或模组说明。
- `module > 0` 时同时考虑 `module_level`。
- 高精度爆发技能没有被统一降级成 warning-only。
- CLI stdout 输出 JSON 时仍可解析。
- metadata 没有改变 MAA 协议语义。

## 必要测试

修改导出策略时，至少补充或更新以下测试：

- 默认 pipeline / GUI 生成结果为 `fixed`。
- 默认 `groups` 为空。
- `opers` 在玩家干员库足够时尽量为 12 人。
- 未部署补位干员只出现在 `opers`，不产生多余 `Deploy`。
- `requirements.module_level` 能被导出。
- `MAAProtocolValidator` 能提示展示文本污染的 `name`。
- 默认文件名包含关卡编号和关卡名。

## 相关文档

- [MAA Copilot 格式理解与生成策略](maa-copilot-format-review.md)
- [数据格式规范](data-format.md)
- [CLI 与 GUI 使用说明](cli-design.md)
- [MAA 干员练度导出格式](maa-operator-export.md)
- [干员强度数据维护说明](operator-strength-data.md)
