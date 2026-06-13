# MAAfight 审计报告

> 重审: 2026-05-23 (第六轮) | 基准: 86 测试全绿, TypeScript 编译通过, `npm run build` 成功, 覆盖率 92.1% stmts / 85.3% branch

## 执行摘要

所有已知 Bug 和正确性隐患已清零。残余 4 项为防御性回退分支和网络层测试缺口，不影响功能正确性。核心流水线端到端可运行。

---

## 实现进度

| 模块 | 文件 | 语句/分支覆盖 | 状态 |
| --- | --- | --- | --- |
| 类型定义 | `src/types.ts` | — | 完成 |
| 干员数据库 | `src/shared/operatorDB.ts` | 100% / 100% | 完成 |
| BattleAnalyzer | `src/battle/BattleAnalyzer.ts` | 99.4% / 86.8% | 完成 |
| ScriptGenerator | `src/battle/ScriptGenerator.ts` | 94.2% / 85.7% | 完成 |
| ScriptValidator | `src/battle/ScriptValidator.ts` | 100% / 97.6% | 完成 |
| ScriptExporter | `src/battle/ScriptExporter.ts` | 96.9% / 82.1% | 完成 |
| OperatorBox | `src/player/OperatorBox.ts` | 88.9% / 50.0% | 完成 |
| CLI 入口 | `src/index.ts` | — | 完成 |
| 关卡索引 | `src/loader/levelIndex.ts` | 100% / 92.9% | 完成 |
| 格式适配器 | `src/adapter/PRTSMapAdapter.ts` | 99.3% / 90.9% | 完成 |
| 地图加载器 | `src/loader/PRTSMapLoader.ts` | 36.7% / 61.4%* | 完成 |

> \* Loader 低覆盖率是 HTTP 网络代码路径无 mock，核心逻辑通过 adapter 集成测试覆盖

---

## 覆盖趋势

| 轮次 | 测试数 | Stmts | Branch | 关键变化 |
| --- | --- | --- | --- | --- |
| 初始 | 53 | 89.8% | 80.3% | P0/P1 修复完成 |
| 第三轮 | 65 | 92.5% | 84.1% | P2 全修, levelIndex 独立测试 |
| 第五轮 | 76 | 92.8% | 85.7% | ScriptGenerator 方向全覆盖, Q4 opers 聚合 |
| **第六轮** | **86** | **92.1%** | **85.3%** | OperatorBox 模块, 额外边界测试 |

---

## 仅余 — 低优先级

### Q1: ScriptGenerator 防御性回退分支（不可触发）

`OPERATOR_POOLS[role] || []` 和 `ROLE_NAMES[role] || role` 在当前代码中不可触发 — `byRole` 的 key 与 `OPERATOR_POOLS`/`ROLE_NAMES` 完全对齐。属于防御性编码，可留空。

### Q2: ScriptValidator tiles 子分支（单行残留）

分支覆盖 97.6%，单行 `tiles[0]?.length` 的 optional chaining 子分支未独立触发。功能上所有 OOB 场景均已覆盖。

### Q3: CLI 无自动化测试

`validate` 最易加测试（纯文件 I/O）。`generate`/`analyze` 依赖网络，需 mock。

### Q4: PRTSMapLoader 网络路径无测试

HTTP 下载、redirect、超时等分支未覆盖 (36.7%)。需 mock `https.get`，投入产出比低。

---

## 执行优先级

```text
Q3 (CLI 测试)       → 低优先级，手动验收即可
Q4 (Loader 测试)    → 需要 mock 框架，可推迟
Q1+Q2 (防御分支)    → 不可触发，留空即可
```

---

## 验收标准

- [x] P0/P1 Bug 全部修复 (6/6)
- [x] P2 正确性隐患全部修复 (3/3)
- [x] 架构问题全部修复 (3/3)
- [x] `npm run build` 成功
- [x] TypeScript 编译通过
- [x] 86 测试全绿
- [x] 覆盖率 > 85% branch
- [x] adapter 端到端流水线集成测试通过
- [x] BattleAnalyzer v2 使用真实 HP/ATK/DEF
- [x] 关卡索引 3174 关
- [x] CLI 加载敌人数据库
- [x] WaveInfo 保留 postDelay
- [x] isElite 优先用标签
- [x] ScriptGenerator 全方向覆盖
- [x] ScriptValidator OOB 全覆盖
- [x] opers 字段从 groups 聚合
- [x] levelIndex 独立测试覆盖 100%
- [x] 10 关实测全通过 (100/100 验证)
- [x] PRTS.Map URL 路径适配 (`/data/levels/`)
- [x] overwrittenData null 空安全
- [x] routes null 条目跳过

**所有已知问题已清零。核心流水线可端到端运行。**

---

## 实测发现 (第六轮)

实测 10 关时发现 3 个运行时 Bug，均已修复：

| Bug | 位置 | 原因 | 修复 |
| --- | --- | --- | --- |
| URL 404 | PRTSMapLoader L65 | PRTS.Map 路径加了 `/data/levels/` 前缀 | URL 拼接前加前缀 |
| null.attributes | PRTSMapAdapter L264 | 关卡 `enemyDbRefs[].overwrittenData` 可为 null | `?.attributes` |
| null.checkpoints | PRTSMapAdapter L53 | 关卡 `routes[]` 含 null 条目 | `if (!r) continue` |
