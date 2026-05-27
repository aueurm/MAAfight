# 实现路线图

> 更新: 2026-05-23 | 86 测试全绿 | 92.1% stmts / 85.3% branch

---

## 已完成阶段

### 阶段 0-1: 项目初始化 + 核心流水线迁移

- TypeScript 项目骨架、Jest 配置
- 从 `battle-ipc.js` 迁移 4 个核心模块（Analyzer / Generator / Validator / Exporter）
- 类型定义 (`src/types.ts`)、干员数据库 (`src/shared/operatorDB.ts`)

### 阶段 2: PRTS.Map 集成

- `PRTSMapLoader`: HTTP 下载 / 缓存 / 敌人数据库加载
- `PRTSMapAdapter`: 瓦片→部署点、路径→隘口、波次→时间线、敌人属性提取
- 关卡索引: 3174 关，支持多格式 stage ID 查找

### 阶段 3: BattleAnalyzer 增强 (v2)

- 精确敌人分析（真实 HP/ATK/DEF 替代盲猜）
- DPS 需求计算、难度评分、地图推荐
- 保留 v1 启发式回退路径

### 阶段 4: CLI 入口

- 5 个命令: `generate` / `analyze` / `list` / `validate` / `info`
- `--operators` 参数支持干员练度集成

### 阶段 5: 干员练度集成

- `src/player/OperatorBox.ts`: 加载 MAA 导出 JSON，按练度排序
- `ScriptGenerator` 优选已拥有干员，copilot `opers` 带 `requirements`
- `__tests__/OperatorBox.test.ts`: 7 个测试

---

## 待规划方向

- **AI/LLM 战术增强**: 用 LLM 分析关卡数据，生成更智能的部署策略
- **干员技能数据库**: 扩展 operatorDB 包含技能等级、专精、模组
- **批量生成**: 一键为多关卡生成脚本
- **MAA 插件化**: 作为 MAA 外部工具，消除 CLI 使用门槛
- **关卡可视化**: 地图布局预览
- **生态集成**: 企鹅物流通关数据、PRTS.Wiki 敌人机制
