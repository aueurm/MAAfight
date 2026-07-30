# 技能描述驱动的干员知识生成设计

## 目标

为当前 GameData 中全部 412 名干员生成可复现的策略标签与 12 维知识向量。生成结果必须来自 `skill_table.json` 的技能描述、既有战斗模型和攻击范围，不能覆盖人工确认的策略数据。

## 数据边界

新增 `src/data/operatorKnowledge.generated.v1.json` 作为机器生成层；保留 `src/data/operatorKnowledge.v1.json` 作为人工覆盖层。

生成层每名干员包含 `id`、`name`、`capabilities`、`skills` 标签、空间范围行为、完整 `vector` 与 `provenance: { source: "external" }`。人工层的同名或同 id 条目按字段覆盖生成层；数组能力取并集，`skills` 和 `spatial.skillRanges` 按技能序号合并。

这样更新 GameData 时可重建全部描述特征，同时保留已人工校准的优选/禁用技能、持续治疗、选人权重和空间校正。

## 描述提取

更新脚本下载的 `skill_table.json` 提供每个等级的描述原文。生成器会去除格式控制符和变量占位，统一分析最高等级说明。规则只识别下列稳定战术语义：

- `治疗`、`回复生命`：`healing`
- `眩晕`、`束缚`、`冻结`、`睡眠`、`停顿`、`击退`、`拖拽`：`control`
- `攻击范围扩大`、`攻击范围缩小`、`攻击范围`：技能空间标签与 `skillRangeChange`
- `攻击范围内所有`、`攻击范围内的所有`、`多个目标`、`额外攻击`：`area`
- `飞行`、`空中单位`：`anti-air`
- `阻挡数`、`防御力`、`护盾`、`嘲讽`：`frontline`
- `立即`、`大幅`、`攻击力`、`攻击速度`：`burst`

未命中的描述不产生臆测标签。现有 `operatorCombat.v2.json` 的治疗、控制、目标数、范围与数值会补足描述无法精确表达的维度。

## 向量

沿用固定轴：`frontline`、`ranged`、`physical`、`arts`、`healing`、`burst`、`area`、`control`、`antiAir`、`rangeCoverage`、`skillRangeChange`、`mobility`。

基础值由角色位置、伤害类型、E2 S10 指标、攻击范围和复活时间计算。描述标签只将相应轴提升至 `1`，不会降低数值模型已给出的能力。每个向量元素均限制在 `0..1`。

## 更新流程

`scripts/update-game-data.js` 在重建 `operatorCombat.v2.json` 后调用新的知识生成脚本，并与关卡/敌人数据一起原子替换生成层。手工知识文件不参与替换。

生成层会记录 GameData commit、描述规则版本和干员数量。加载器拒绝生成层与战斗模型 commit 不一致、错误 schema、缺失干员或错误向量。

## 消费与兼容性

`OperatorKnowledge.ts` 合并两层后再向 rule-core 和 DeepSeek 暴露统一视图。既有人工条目和未带生成层的旧工作区仍可加载；此时沿用既有的数值派生向量。

rule-core 只使用合并后的标签、权重和空间数据进行候选排序。DeepSeek context 接收相同的结构化知识，但 BattleDSL、地图和 MAA 协议验证不变。

## 验证

- 生成器测试使用最小 `character_table.json`、`skill_table.json` 和战斗模型夹具，断言描述标签、向量和范围变化。
- 更新脚本测试断言生成层与战斗模型使用同一 commit，并且人工文件未被写入。
- 全量生成断言 412 个 generated entries、唯一 id/name 和合法 12 维向量。
- 现有 engine、DeepSeek、CLI 和 GUI 回归测试继续通过。
