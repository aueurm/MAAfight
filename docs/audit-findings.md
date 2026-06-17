# 审计与质量记录

## 定位

本文不是实时测试报告，而是长期维护用的质量记录。

当前准确状态应以本地命令为准：

```bash
npm run build
npm test
node scripts/benchmark.js --skip-build
```

如果这些命令输出与本文冲突，以命令输出为准，并更新本文。

## 当前质量边界

MAAfight 的验证目标是：

- 能从 PRTS.Map 数据生成结构合法的 MAA copilot JSON v3。
- 能用内部验证器发现明显字段、坐标和 action 问题。
- 能用协议验证器提示 MAA copilot 兼容性风险。
- 能通过 metadata 和 explain 暴露规划依据、warning 和 operator gaps。

验证目标不是：

- 证明脚本一定通关。
- 模拟真实战斗结果。
- 覆盖 MAA 实际执行中的识别延迟、点击延迟、帧率、倍速和技能时机误差。

## 已覆盖的质量点

- `PRTSMapAdapter` 支持字符串枚举和数字枚举形式的 PRTS.Map 数据。
- `routes` 中的 `null` 条目会被跳过。
- `enemyDbRefs[].overwrittenData` 缺失或为 `null` 时使用安全回退。
- `WaveInfo` 保留 `postDelay`。
- `BattleAnalyzer` 在敌人详情缺失时仍能 fallback。
- `BattlePlanner` 输出 `pressureWindows` 和 `recommendedTasks`。
- `ScriptGenerator` 支持玩家干员库、任务化选人、粗费用和部署点评分。
- 玩家干员库不足时保留 `operatorGaps`。
- `ScriptValidator` 覆盖 action 类型、坐标越界和不可部署点等错误。
- `MAAProtocolValidator` 对协议兼容性风险输出 warning，包括展示文本污染 `name` 字段和部署名未声明等问题。
- `PlanningReport` 汇总 confidence、known risks、protocol warnings 和部署解释。
- GUI server、player config、operator strength、level index 等模块有对应测试文件。

## 仍需关注

### 协议兼容性

MAA 官方协议和项目内部 action 之间仍可能存在差异。

特别需要关注：

- `Wait`
- `SkillUse`
- `requirements`
- `time_elapsed`
- 编队模式下 `groups` / `opers` 的语义

这些问题应通过 `MAAProtocolValidator` 暴露，不应静默吞掉。

涉及 `opers`、`groups`、`actions[].name`、默认 fixed 12 人编队、模组推荐或 SkillDaemon 策略的改动，必须先对照 [MAA Copilot 导出契约](maa-copilot-export-contract.md)。

### 网络与缓存

`PRTSMapLoader` 依赖远端静态 JSON 和本地缓存。网络失败、重定向、超时、缓存损坏等路径需要持续实测。

### 规则规划质量

`pressureWindows`、`recommendedTasks`、粗费用和部署点评分都是启发式。

它们应该通过更多关卡 benchmark 和 GUI 调试信息迭代，不应被包装成通关证明。

### 干员数据

离线强度数据和默认干员池都需要人工维护。

低置信度或争议较大的条目应在 `src/data/operatorStrength.cn.json` 中标记，并通过 metadata 给出可解释信息。

## 实测记录

当前实测关卡列表见 [实测关卡列表](test-levels.md)。

扩展实测集时优先加入：

- 飞行压力明显的关卡。
- 高防 / 高抗关卡。
- Boss 关卡。
- 多路线和多蓝门关卡。
- 有特殊地块或 rune 的关卡。

## 更新规则

1. 不写固定测试数量，除非刚刚在同一变更中运行并记录命令输出。

2. 不写“所有问题已清零”。

3. 不把 benchmark 通过解释成脚本可通关。

4. 文档只保留当前维护有价值的信息，历史修复清单通过 git 历史查询。
