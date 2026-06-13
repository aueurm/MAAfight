# MAAfight × MAA 干员练度集成 — 已全部完成

> 完成日期: 2026-05-23 | 基准: 86 测试全绿 | `npm run build` 成功

## 背景

MAA v6.10.5 的干员识别功能可导出玩家干员练度 JSON。本次集成使 ScriptGenerator 读取玩家数据，按练度优选已拥有干员，copilot 脚本带上 `requirements`。

参考：[docs/maa-operator-export.md](maa-operator-export.md)

---

## 已完成的 5 项任务

### 1. 类型定义
- `src/types.ts`: 新增 `PlayerOperator` 接口、`BattleScriptOper.requirements` 字段

### 2. OperatorBox 模块
- `src/player/OperatorBox.ts`: 加载 MAA 导出 JSON，过滤 `own: true`，提供 `get()`/`has()`/`priority()`/`sortedNames()` 查询
- `__tests__/OperatorBox.test.ts`: 7 个测试

### 3. ScriptGenerator 增强
- `GeneratorConfig` 增加 `playerOperators` 字段
- 新增 `selectOperators()`: 从干员池中筛选已拥有干员，按练度降序排列
- `deploymentOrder` 路径和默认部署路径均已改为调用 `selectOperators()`
- 所有 `opers` 条目在玩家数据可用时带上 `requirements`
- 向后兼容: `playerOperators` 为空时行为不变

### 4. CLI 集成
- `--operators <path>` 参数，`cmdGenerate` 和 `cmdAnalyze` 均支持
- 加载后输出 `Loaded N owned operators from player data`

### 5. 测试
- `__tests__/OperatorBox.test.ts`: 7 个测试（加载、过滤、优先级排序、空文件）
- `__tests__/ScriptGenerator.test.ts`: 3 个新测试（优选已拥有、回退默认池、requirements 字段）

---

## 验收

- [x] 全部 86 测试绿
- [x] TypeScript 编译通过
- [x] `--operators` 参数可用
- [x] 未提供 `--operators` 时行为一致（向后兼容）
