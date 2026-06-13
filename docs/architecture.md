# 总体架构

## 模块分层

```
┌─────────────────────────────────────────────────────┐
│  CLI 入口 (index.ts)                                │
│  maafight generate --stage OF-1                    │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│  PRTSMapLoader                                      │
│  - 关卡索引管理 (stage ID → 文件路径)              │
│  - HTTP 下载 / 本地缓存 / 本地加载                 │
│  - 敌人数据库管理                                   │
└───────────────────────┬─────────────────────────────┘
                        │  PRTS.Map JSON (游戏引擎格式)
┌───────────────────────▼─────────────────────────────┐
│  PRTSMapAdapter                                     │
│  - 瓦片分析 → 可部署点位                           │
│  - 路径分析 → 隘口/战略要点                        │
│  - 波次分析 → 刷怪区/出怪时间线                    │
│  - 敌人属性提取                                     │
│  - 部署顺序推断                                     │
└───────────────────────┬─────────────────────────────┘
                        │  MapData (MAAfight 内部格式)
┌───────────────────────▼─────────────────────────────┐
│  BattleAnalyzer (v2)                                │
│  - 精确敌人组成估算 (HP/ATK/DEF)                   │
│  - 难度评级                                         │
│  - 干员需求分析                                     │
│  - 策略推荐                                         │
└───────────────────────┬─────────────────────────────┘
                        │  TacticalAnalysis
┌───────────────────────▼─────────────────────────────┐
│  ScriptGenerator                                    │
│  - 编排 Deploy 序列                                 │
│  - 生成 groups 编队                                 │
│  - 插入 SpeedUp / SkillDaemon                      │
│  - 方向自动判定                                     │
└───────────────────────┬─────────────────────────────┘
                        │  BattleScript
┌───────────────────────▼─────────────────────────────┐
│  ScriptValidator                                    │
│  - 字段完整性检查                                   │
│  - Action type 校验                                 │
│  - 干员名有效性校验                                 │
│  - 评分                                             │
└───────────────────────┬─────────────────────────────┘
                        │  ValidationResult
┌───────────────────────▼─────────────────────────────┐
│  ScriptExporter                                     │
│  - 输出 MAA copilot JSON v3                         │
└─────────────────────────────────────────────────────┘
```

## 数据流

```
用户输入 stage ID
    │
    ▼
PRTSMapLoader.resolve("a001_01")
    → levelIndex["a001_01"] = "activities/a001/level_a001_01.json"
    → 检查本地缓存 → 未命中 → HTTP 下载
    → 解析 JSON → PRTSLevelData
    │
    ▼
PRTSMapAdapter.adapt(prtsLevelData)
    → tiles 分析 → deploymentPoints[]
    → routes 分析 → strategicPoints[], highThreatAreas[]
    → waves 分析 → spawnTimeline[]
    → enemyDbRefs 分析 → enemyComposition[]
    → deploymentPoints 排列 → deploymentOrder[]
    → 返回 MapData
    │
    ▼
BattleAnalyzer.analyze(mapData)
    → 计算敌人总 HP/DPS → 难度评级
    → 分析部署需求 → 干员推荐
    → 生成战术策略
    → 返回 TacticalAnalysis
    │
    ▼
ScriptGenerator.generate(stageId, mapData, tacticalAnalysis)
    → 按角色分组部署
    → 生成 Deploy actions
    → 插入 SpeedUp, SkillDaemon
    → 返回 BattleScript
    │
    ▼
ScriptValidator.validate(script)
    → 字段校验
    → 返回 ValidationResult
    │
    ▼
ScriptExporter.export(script)
    → 格式化 copilot JSON
    → 输出到 stdout / 文件
```

## 目录结构

```
MAAfight/
├── package.json
├── tsconfig.json
├── jest.config.js
├── CLAUDE.md
├── docs/                      # 设计文档
│   ├── architecture.md        # 本文档
│   ├── data-format.md         # 数据格式规范
│   ├── prts-map-adapter.md    # 适配器设计
│   ├── battle-analyzer-v2.md  # 分析器增强
│   ├── cli-design.md          # CLI 设计
│   └── implementation-roadmap.md
├── src/
│   ├── index.ts               # CLI 入口
│   ├── types.ts               # 类型定义
│   ├── loader/
│   │   ├── PRTSMapLoader.ts   # 地图数据加载
│   │   └── levelIndex.ts      # 关卡索引 (stage ID → 路径)
│   ├── adapter/
│   │   └── PRTSMapAdapter.ts  # 格式转换
│   ├── battle/
│   │   ├── BattleAnalyzer.ts  # [迁移+增强]
│   │   ├── ScriptGenerator.ts # [迁移]
│   │   ├── ScriptValidator.ts # [迁移]
│   │   └── ScriptExporter.ts  # [迁移]
│   └── shared/
│       └── operatorDB.ts      # 干员数据库
├── __tests__/
│   ├── loader.test.ts
│   ├── adapter.test.ts
│   ├── BattleAnalyzer.test.ts # [迁移]
│   ├── ScriptGenerator.test.ts# [迁移]
│   ├── ScriptValidator.test.ts# [迁移]
│   └── ScriptExporter.test.ts # [迁移]
└── cache/                     # 关卡 JSON 缓存 (gitignore)
```

## 关键设计决策

### 1. PRTSMapLoader 缓存策略

- 首次运行时下载关卡 JSON，存入本地 `cache/` 目录
- 后续运行直接读取本地缓存
- 敌人数据库（5.6MB）单独缓存，所有关卡共享
- 支持 `--no-cache` 强制重新下载

### 2. 格式适配为独立层

PRTSMapAdapter 是独立模块，不嵌入 BattleAnalyzer。理由：
- 将来可能支持其他数据源（手动 JSON、MAA 截图识别）
- 单一职责：格式转换与战术分析分离
- 单独可测试

### 3. BattleAnalyzer 增量增强

v1 接口不变，v2 在 TacticalAnalysis 中增加字段：
- `enemyDetails[]` — 每种敌人的精确 HP/ATK/DEF
- `spawnTimeline[]` — 精确到秒的出怪时间线
- `dpsRequirement` — 基于敌人总 HP 计算的 DPS 需求

### 4. 不引入外部依赖

- 网络请求使用 Node.js 内置 `https` 模块
- 文件操作使用内置 `fs`
- 命令行解析使用内置 `process.argv`（阶段 1 MVP），后期可选 `commander`
