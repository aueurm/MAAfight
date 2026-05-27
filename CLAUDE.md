# MAAfight — AI 驱动的明日方舟自动战斗脚本生成器

## 项目定位

MAAfight 是一个**独立 CLI 工具**，输入关卡标识，输出 MAA 标准 copilot JSON 战斗脚本。

**核心洞察：** MAA 已经内置了完整的 copilot 战斗执行引擎（图像识别、ADB 操控、任务队列），不需要重造轮子。MAAfight 只做 MAA 不做的部分——**用 AI 自动生成战斗策略和脚本**。

```
MAAfight 的边界：
  关卡标识 ──▶ [PRTS.Map 数据获取 → 格式适配 → 战术分析 → 策略生成 → 脚本编排] ──▶ copilot JSON
                                                                          │
                                                                          ▼
                                                                     MAA 执行引擎
```

MAAfight **不做**的：
- 不控制 ADB / 模拟器
- 不做图像识别
- 不执行任务调度
- 不重复 MAA 已有的任何功能

## 核心流水线

```
StageID ──▶ PRTSMapLoader ──▶ PRTS.Map JSON
                  │
                  ▼
            PRTSMapAdapter ──▶ MapData (内部格式)
                  │
                  ▼
            BattleAnalyzer ──▶ TacticalAnalysis
                  │
                  ▼
            ScriptGenerator ──▶ BattleScript
                  │
                  ▼
            ScriptValidator ──▶ ValidationResult
                  │
                  ▼
            ScriptExporter ──▶ copilot JSON (MAA v3 格式)
```

### 0. 地图数据获取 (PRTSMapLoader) [新增]

- **数据源：** [PRTS.Map](https://map.ark-nights.com/) — 社区维护的明日方舟地图站
- **数据规模：** 2160 个关卡，覆盖主线/活动/危机合约/集成战略
- **数据格式：** 游戏引擎原始 JSON 导出，含瓦片地图、敌人路径、波次数据、敌人属性
- **获取方式：** 静态 JSON 文件 HTTP 下载，无需 OCR/CV
- **GitHub：** [Houdou/prts-map](https://github.com/Houdou/prts-map)

### 1. 格式适配 (PRTSMapAdapter) [新增]

将 PRTS.Map 的游戏引擎格式转换为 MAAfight 内部格式：
- `mapData.tiles[].buildableType` → `deploymentPoints` (可部署坐标)
- `routes[].checkpoints` → `strategicPoints` (路径交叉点 = 隘口)
- `routes[].startPosition` + `waves[]` → `highThreatAreas` (刷怪区)
- `enemyDbRefs[].attributes` → 精确敌人属性 (HP/ATK/DEF)
- `waves[].fragments[].preDelay` → 出怪时间线
- `mapData.tiles[].buildableType` 分布 → `deploymentOrder` (启发式推断)

### 2. 战术分析 (BattleAnalyzer) [增强]

- **输入：** MapData (内部格式) + 精确敌人数据
- **输出：** 战术分析（敌人组成、难度评级、干员需求、推荐策略）
- **增强点：** 当前版本通过 `spawnCount` 盲猜敌人组成；v2 利用精确 HP/ATK/DEF 做真实难度评估

### 3. 脚本生成 (ScriptGenerator)

- **输入：** 战术分析 + 地图数据
- **输出：** MAA copilot 格式战斗脚本（actions 序列 + groups 编队）
- 迁移自 `battle-ipc.js:generateScript`

### 4. 脚本验证 (ScriptValidator)

- 检查字段完整性、action type 合法性、干员名有效性
- 迁移自 `battle-ipc.js:validateScript`

### 5. 脚本导出 (ScriptExporter)

- **输出格式：** MAA copilot JSON v3
- 迁移自 `battle-ipc.js:exportToCopilotFormat`

## 技术选型

| 层面 | 选择 | 理由 |
|------|------|------|
| 运行时 | Node.js | 现有 battle-ipc.js CJS 实现直接复用 |
| 类型系统 | TypeScript | TS 源码 + 测试直接迁移 |
| 输出格式 | JSON (MAA copilot v3) | MAA 标准格式 |
| 地图数据源 | PRTS.Map 静态 JSON | 零爬虫、精确游戏数据 |
| 测试 | Jest | 已有 4 个测试文件 |

## 当前状态

86 测试全绿 | 92.1% stmts / 85.3% branch | TypeScript 编译通过

### 已完成

| 来源 | 文件 | 说明 |
|------|------|------|
| MAAfight | `src/battle/BattleAnalyzer.ts` | v2: 精确敌人属性 (HP/ATK/DEF) |
| MAAfight | `src/battle/ScriptGenerator.ts` | 含干员练度优选 |
| MAAfight | `src/battle/ScriptValidator.ts` | OOB 全覆盖 |
| MAAfight | `src/battle/ScriptExporter.ts` | MAA copilot v3 |
| MAAfight | `src/player/OperatorBox.ts` | 玩家干员数据加载 |
| MAAfight | `src/loader/PRTSMapLoader.ts` | HTTP 下载 + 缓存 |
| MAAfight | `src/loader/levelIndex.ts` | 3174 关索引 |
| MAAfight | `src/adapter/PRTSMapAdapter.ts` | PRTS.Map → 内部格式 |
| MAAfight | `src/index.ts` | CLI: 5 命令 + --operators |
| PRTS.Map | 3174 关卡 JSON | 静态文件 HTTP 下载 |
| PRTS.Map | 敌人数据库 5.6MB | 敌人属性完整 |

### 未来方向

- **LLM 战术增强**: 用 LLM 分析关卡数据，生成更智能的部署策略
- **干员技能数据库**: 扩展 operatorDB，补充技能/专精/模组数据
- **批量生成**: 一键为多关卡生成脚本
- **MAA 插件化**: 作为 MAA 外部工具，消除 CLI 使用门槛
- **关卡可视化**: 地图布局预览

## 详细设计文档

见 `docs/` 文件夹：
- [总体架构](docs/architecture.md)
- [数据格式规范](docs/data-format.md)
- [PRTS.Map 适配器](docs/prts-map-adapter.md)
- [BattleAnalyzer v2](docs/battle-analyzer-v2.md)
- [CLI 接口设计](docs/cli-design.md)
- [实现路线图](docs/implementation-roadmap.md)
- [审计报告](docs/audit-findings.md)
- [MAA 干员导出格式](docs/maa-operator-export.md)
