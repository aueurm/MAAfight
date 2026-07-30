# DeepSeek Operator Knowledge Runtime Design

## Goal

确保 deepseek-core 的实际生成路径始终收到已解析的干员知识，并将生成层的确定性标签转换为明确、可执行的选人和站位提示。

## Scope

覆盖 `generateDeepSeekScript`、DeepSeek context、system prompt 和相应测试。不会修改 rule-core 搜索、MAA 协议导出、战斗评分或将描述标签变成候选合法性的硬性拒绝条件。

## Design

`DeepSeekGenerationInput` 必须提供 `getOperatorKnowledge`。`generateDeepSeekScript` 在建立 context 前检查该解析器；缺失时直接报错。CLI / GUI 共用的 pipeline 已按当前选中技能调用 `resolveOperatorProfile`，再把结果传给解析器，因此同一技能的范围、标签和向量会进入 DeepSeek context。

context 顶层新增 `operatorKnowledgeModel`，包含知识模型版本、生成来源 commit、生成条目数和固定的向量轴。每名干员保留现有的 `knowledge`，每个技能保留自身的 `knowledge`；不复制原始技能描述，也不改变 BattleDSL 契约。

system prompt 对结构化字段给出确定性解释：`preferred` 是同职责候选的优先信号，`avoided` 仅在没有替代方案时使用，`sustainedHealing` 用于长期前线治疗；`frontline`、`healing`、`control`、`area`、`anti-air`、`burst` 和范围变化标签分别影响职责匹配、支援与位置选择。`spatial.range` 是实际技能射程，`attackPattern`、`coverage`、`positionEffect` 和 `skillRangeBehavior` 是覆盖判断依据。向量仅作为相似性和排序提示，不可推断不存在的能力或通关结果。

## Error Handling

缺少运行时知识解析器时，生成入口直接失败并给出明确错误；知识模型与战斗模型的 commit / 条目数不一致仍由现有 CombatModel 初始化校验阻止。静态编译器不因标签偏好拒绝候选，仍仅执行 BattleDSL、地图和 MAA 协议校验。

## Tests

新增或更新 DeepSeek tests，验证：

1. 生成入口缺少知识解析器时失败。
2. context 包含与当前战斗模型一致的知识模型元数据。
3. 解析器针对不同技能的输出进入对应 `roster.skills[].knowledge`。
4. HTTP 请求的 system prompt 包含标签和空间语义约束，且不泄露 API key。
