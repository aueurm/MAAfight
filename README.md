# MAAfight

AI 驱动的明日方舟 MAA copilot 战斗脚本生成器。

**一行命令，关卡 ID → MAA 可用的 copilot JSON。**

```
maafight generate --stage a001_01 --output script.json
```

## 这是什么

[MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights) 已内置完整的战斗执行引擎（图像识别、ADB 操控、任务队列）。但它不会帮你写作战脚本。

**MAAfight 补上这个缺口** — 从 [PRTS.Map](https://map.ark-nights.com/) 获取精确游戏数据（地图、敌人路线、波次、HP/ATK/DEF），自动分析战术需求，生成符合 MAA copilot v3 格式的战斗脚本。

```
关卡 ID ──▶ [地图数据获取 → 格式适配 → 战术分析 → 策略生成 → 脚本编排] ──▶ copilot JSON → MAA 执行
```

MAAfight **不做**的：不控制 ADB、不做图像识别、不执行任务调度。它只输出 JSON，剩下的交给 MAA。

## 快速开始

```bash
# 安装依赖 & 构建
npm install
npm run build

# 生成作战脚本
node dist/index.js generate --stage a001_01 --output script.json --pretty

# 用 MAA 加载 script.json → 自动战斗
```

## 命令

### generate — 生成作战脚本

```bash
maafight generate --stage <关卡ID> [--output <路径>] [--pretty] [--no-cache]
maafight generate --data <本地JSON> [--stage <名称>] [--output <路径>]
maafight generate --stage a001_01 --output script.json --pretty
maafight generate --data ./level_OF-3.json --stage OF-3 --output of3.json
maafight generate --stage main_03-08 --operators my_operators.json
```

`--data` 接受本地 PRTS.Map 格式的关卡 JSON 文件，绕过索引查找——适用于 PRTS.Map 未收录的早期活动（OF、MT、GT 等）。`--stage` 在此模式下设置输出脚本的关卡名称（可选，默认取文件名）。

`--operators` 可指定 MAA 干员导出 JSON，用你的真实练度匹配干员。

### analyze — 不生成脚本，只分析关卡

```bash
maafight analyze --stage <关卡ID> [--pretty]
maafight analyze --data <本地JSON> [--pretty]
maafight analyze --stage camp_01 --pretty
```

输出：敌人构成、难度评级、干员需求、推荐策略、部署位置建议。

### validate — 验证已有脚本

```bash
maafight validate --file <脚本路径>
maafight validate --file script.json
```

检查 action 类型合法性、部署坐标是否越界、格式是否正确。输出评分 0-100。

### list — 列出可用关卡

```bash
maafight list [--search <关键词>] [--category <类别>] [--limit <数量>]
maafight list --search boss            # 搜 BOSS 关
maafight list --category weekly        # 周一资源本
maafight list --category crisis --limit 20
```

类别：`main` `hard` `campaign` `weekly` `crisis` `activity`

### info — 查看关卡详情

```bash
maafight info --stage <关卡ID>
maafight info --data <本地JSON>
maafight info --stage crisis_v2_01-01
```

输出：地图尺寸、可部署点数、路线数、波次数、敌人种类等。

## 关卡 ID 速查

**不要猜 ID，用搜索找到确定的 ID：**

```bash
maafight list --search "关键词"     # 模糊搜索关卡名
maafight list --category main       # 按类别浏览
maafight info --stage <找到的ID>    # 确认关卡详情
```

### 常用 ID 格式

| 类别 | ID 格式 | 示例 | 搜索方式 |
| --- | --- | --- | --- |
| 主线 | `main_章-关` | `main_03-08` (碎骨) | `list --category main` |
| 困难 | `hard_章-关` | `hard_05-04` | `list --category hard` |
| 剿灭 | `camp_编号` | `camp_01` (切尔诺伯格) | `list --category campaign` |
| 资源本 | `weekly_类型_编号` | `weekly_armor_1` (重甲) | `list --category weekly` |
| 危机合约 | `crisis_v2_区域-关` | `crisis_v2_01-01` | `list --category crisis` |
| 活动 | `活动ID_编号` | `a001_01` | `list --search 活动名` |

### 已知不支持

- **早期 SideStory**：OF (火蓝之心)、MT (玛莉娅·临光)、GT (骑兵与猎人)、DM (生于黑夜) 等未被 PRTS.Map 收录
- 变通方案：获取 PRTS.Map 格式的关卡 JSON 文件后，使用 `--data` 参数直接生成

> 共收录 **3174** 个关卡，10 关实测验证全通过（[详情](docs/test-levels.md)）

## 工作原理

每个关卡经过 5 步流水线处理：

| 步骤 | 模块 | 在做什么 |
| --- | --- | --- |
| 1. 数据获取 | PRTSMapLoader | 从 PRTS.Map 下载关卡 JSON（地图瓦片、敌人路线、波次、属性）并缓存 |
| 2. 格式适配 | PRTSMapAdapter | 游戏引擎格式 → 内部分析格式（可部署点、隘口、刷怪时间线） |
| 3. 战术分析 | BattleAnalyzer | 分析敌人构成、计算 DPS 需求、评级难度、推荐干员组合 |
| 4. 脚本生成 | ScriptGenerator | 干员选择 + 部署顺序 + 朝向推断 + 技能轴编排 |
| 5. 验证导出 | ScriptValidator + ScriptExporter | 合法性校验 + MAA copilot v3 JSON 输出 |

### 难度评级

基于真实 HP/ATK/DEF 数据计算，不靠盲猜：

- **easy** — 少量普通敌人
- **medium** — 多波次或高血量
- **hard** — 精英敌人混合
- **extreme** — BOSS + 精英 + 高 DPS 需求

### 朝向推断

根据敌人路线起点→终点向量自动推断干员朝向：

```
敌人从北向南 → 干员朝 Up（向上迎击）
敌人从西向东 → 干员朝 Left（向左迎击）
```

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MAAFIGHT_CACHE_DIR` | `./cache/levels` | 关卡数据缓存 |
| `MAAFIGHT_DATA_URL` | `https://map.ark-nights.com` | PRTS.Map 数据源 |
| `MAAFIGHT_LOG_LEVEL` | `info` | 日志级别 |

## 干员练度接入

如果你有 MAA 导出的干员数据，可以让 MAAfight 根据你的真实练度匹配干员：

```bash
maafight generate --stage a001_01 --operators my_operators.json
```

干员导出格式见 [docs/maa-operator-export.md](docs/maa-operator-export.md)。

## 开发

```bash
npm install
npm run build          # TypeScript 编译
npx jest --coverage    # 86 测试 + 覆盖率
bash scripts/test-pipeline.sh   # 10 关实测脚本
```

详细架构见 [docs/architecture.md](docs/architecture.md)。

## 设计文档

| 文档 | 说明 |
| --- | --- |
| [架构总览](docs/architecture.md) | 模块划分、数据流、技术选型 |
| [数据格式](docs/data-format.md) | 内部 MapData 与 copilot JSON 格式规范 |
| [适配器设计](docs/prts-map-adapter.md) | PRTS.Map 格式 → 内部格式的转换逻辑 |
| [战术分析](docs/battle-analyzer-v2.md) | 难度评级、DPS 计算、策略推荐 |
| [CLI 设计](docs/cli-design.md) | 命令行接口设计决策 |
| [审计报告](docs/audit-findings.md) | 测试覆盖率、Bug 跟踪、验收标准 |
| [实测关卡](docs/test-levels.md) | 10 关实测结果 |

## 许可证

MIT
