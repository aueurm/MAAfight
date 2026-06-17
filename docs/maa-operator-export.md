# MAA 干员练度导出格式

> MAA v6.10.5+ | PR [#16635](https://github.com/MaaAssistantArknights/MaaAssistantArknights/pull/16635) | 2025-2026

## 概述

MAA 的 **干员识别 (OperBox Recognition)** 功能通过图像识别扫描玩家干员列表，产出所有干员的拥有状态和练度数据。支持 **JSON / Markdown / CSV** 三种导出格式。

导出包含游戏中**全体干员**（不限于已拥有），未拥有干员仅含基础信息、无练度字段。

---

## JSON 格式

### 顶层结构

导出为 **OperData 对象数组**：

```json
[
  { "id": "...", "name": "...", ... },
  { "id": "...", "name": "...", ... }
]
```

### 字段定义

| 字段 | 类型 | 已拥有 | 未拥有 | 说明 |
|------|------|--------|--------|------|
| `id` | string | ✓ | ✓ | 干员内部 ID，格式 `char_{编号}_{代号}`，如 `char_2024_chyue` |
| `name` | string | ✓ | ✓ | 干员中文名，如 `重岳` |
| `rarity` | int | ✓ | ✓ | 稀有度 1-6 星 |
| `own` | bool | ✓ | ✓ | 是否拥有 |
| `elite` | int | ✓ | ✗ | 精英化等级 (0=未精英, 1=精一, 2=精二) |
| `level` | int | ✓ | ✗ | 干员等级 (1-90) |
| `potential` | int | ✓ | ✗ | 潜能数 (0-6) |
| `skill_level` / `skillLevel` | int | 视版本而定 | ✗ | 技能等级 / 专精等级，存在时优先用于 `requirements.skill_level` |
| `module` | int | 视版本而定 | ✗ | 模组编号，存在时优先用于 `requirements.module` |
| `module_level` / `moduleLevel` | int | 视版本而定 | ✗ | 模组等级，存在时优先用于 `requirements.module_level` |
| `cost` | int | 视版本而定 | ✗ | 部署费用，存在时优先用于粗费用估算 |

### 示例

```json
[
  {
    "id": "char_002_amiya",
    "name": "阿米娅",
    "rarity": 5,
    "own": true,
    "elite": 2,
    "level": 80,
    "potential": 5
  },
  {
    "id": "char_2024_chyue",
    "name": "重岳",
    "rarity": 6,
    "own": true,
    "elite": 2,
    "level": 90,
    "potential": 3
  },
  {
    "id": "char_009_12fce",
    "name": "12F",
    "rarity": 2,
    "own": false
  }
]
```

---

## 数据规模

- MAA 导出的干员列表覆盖游戏中**全部已实装干员**（约 300+）
- 玩家通常拥有其中的 50-200 名
- 未拥有的干员仅 3 个字段：`id` / `name` / `rarity` / `own: false`

---

## 获取方式

1. 在 MAA 工具箱中运行**干员识别**
2. 识别完成后点击**导出 → JSON 文件**
3. 得到 `Arknights_OperBox_Export.json`

---

## 与 MAAfight 的集成

MAAfight 已有 `src/shared/operatorDB.ts` 定义干员池（按职业/星级），copilot 脚本格式已支持 `requirements` 字段：

```typescript
// copilot 格式中 opers 的 requirements
{
  "name": "重岳",
  "skill": 3,
  "requirements": {
    "elite": 2,
    "level": 90,
    "skill_level": 10,
    "module": 1,
    "module_level": 3,
    "potential": 1
  }
}
```

当前已经集成到 CLI、GUI 和 pipeline。

使用方式：

```bash
maafight generate --stage GT-1 --operators Arknights_OperBox_Export.json
maafight init --operators Arknights_OperBox_Export.json
maafight operators info
```

GUI 也支持选择、输入路径或粘贴 operators JSON。

集成行为：

1. 读取 MAA 导出 JSON，过滤 `own: true` 得到玩家拥有清单。
2. 生成时优先从玩家拥有干员中选择。
3. 综合稀有度、精英化、等级、任务适配、离线强度先验和自动化适配度排序。
4. 默认 `fixed` 模式下，`opers` 尽量补满 12 名真实干员；未部署的干员只作为编队补位，不生成部署动作。
5. 玩家干员库不足时，通过 `metadata.operatorGaps` 记录缺口，并保留兜底生成能力。
6. 本地初始化后，`.maafight/operators.json` 会作为默认干员库加载。
7. 如果玩家数据缺少模组信息，MAAfight 允许根据 `operatorStrength.cn.json` 的 `modulePriority` 输出推荐模组字段。

导出到 MAA copilot 时，干员库只用于选择真实干员和填充 `requirements`。不得把职业、候选列表、练度展示或模组展示拼进 `opers[].name`。完整约束见 [MAA Copilot 导出契约](maa-copilot-export-contract.md)。

注意：包含 `stage_name`、`actions`、`groups` 的文件是 MAA copilot 作业文件，不是 operators JSON。不要用作业文件作为玩家干员库样本。

### 关键映射

| MAA 导出 | MAAfight 内部 | copilot 格式 |
|----------|---------------|--------------|
| `id` | 干员唯一标识 | — |
| `name` | 干员名 | `opers[].name` / `groups[].opers[].name` |
| `elite` | 精英化等级 | `requirements.elite` |
| `level` | 等级 | `requirements.level` |
| `rarity` | 稀有度 | 用于优先级排序 |
| `potential` | 潜能 | `requirements.potential` |
| `skill_level` / `skillLevel` | 技能等级 / 专精 | `requirements.skill_level` |
| `module` | 模组编号 | `requirements.module` |
| `module_level` / `moduleLevel` | 模组等级 | `requirements.module_level` |
| `cost` | 部署费用 | 粗费用时间线 |

---

## 参考

- MAA 官方文档: [docs.maa.plus](https://docs.maa.plus)
- PR #16635: [feat: 干员识别支持导出 Json/Markdown/CSV](https://github.com/MaaAssistantArknights/MaaAssistantArknights/pull/16635)
- 源码: [`OperBoxData.cs`](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/dev-v2/src/MaaWpfGui/Models/OperBoxData.cs)
- 战斗流程协议: [copilot-schema](https://docs.maa.plus/zh-cn/protocol/copilot-schema.html)
