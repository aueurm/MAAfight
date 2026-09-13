# 出怪调度时基核验

检查日期：2026-09-13。关卡与敌人使用 [固定 GameData 快照](https://github.com/Kengxxiao/ArknightsGameData/commit/0ef7f952dfd018392200157a5c79a6511ba69122)。本说明补充 [兼容性检查](compatibility-2026-09.md)。

## 已修正的事实转换

原 adapter 丢弃了 `SPAWN.preDelay`，并在进入下一 fragment 时忽略上一 fragment 的出怪调度长度，导致延迟刷新的敌人过早进入压力窗口。固定快照的 118,382 条 SPAWN 动作都提供有限、非负的 `preDelay`，其中 92,760 条大于 0，最大为 524 秒。

`EnemySpawn.preDelay` 现在保留原始动作延迟，由 `buildSpawnTimeline` 统一换算；`highThreatAreas.firstSpawnTime` 从同一份时间线取得，避免两套时钟分歧。

1. wave 起点加上 `wave.preDelay`。
2. fragment 起点为上一 fragment 的调度完成点加 `fragment.preDelay`。
3. 同一 fragment 内各 SPAWN 动作并行。第 `i` 个敌人的出生时刻为 `fragmentStart + action.preDelay + i * action.interval`，`i` 从 0 开始。
4. fragment 的出怪调度完成点取原始 SPAWN 调度的最晚时刻，包括未启用 hiddenGroup 的调度跨度；空 fragment 保留其起点。wave 结束后再加 `wave.postDelay`。

这些字段均为游戏秒，支持小数。原始 SPAWN 的负数或非有限 `preDelay` 明确报错，不改变其含义。旧内部 `EnemySpawn` 未提供该新增字段时，按 0 处理。

## 参考实现与回归证据

一手参考是 [PRTS.Map 当前地图逻辑分包](https://map.ark-nights.com/route-map.chunk.f1529.esm.js)，由其首页 `bundle.45c53.esm.js` 引用；页面同时链接 [Houdou/prts-map](https://github.com/Houdou/prts-map)。读取日期为 2026-09-13，分包 SHA-256 为 `da35e9d2b246af9e844b226c54fbb00f4d5995804efc40b115c941e637562c54`。

该分包的出怪列表逻辑固定 `b` 为 fragment 起点，使用 `r = b + e.preDelay` 计算动作时刻，再以 `k = max(k, b + e.preDelay + (e.count - 1) * e.interval)` 推进调度完成点；进入下一 fragment 前赋值 `r = k`，wave 末尾另加 `postDelay`。这是地图查看器的调度参考，不能替代完整游戏运行时。

H5-1 的原始动作和当前调度结果如下。旧实现曾把这四条路线的首个敌人全部放在第 0 秒。

| routeIndex | action.preDelay | count / interval | 当前出生时刻 |
| --- | --- | --- | --- |
| 7 | 14 | 1 / 1 | 14 |
| 8 | 23 | 2 / 3 | 23、26 |
| 11 | 11 | 1 / 1 | 37 |
| 12 | 22 | 1 / 1 | 48 |

`__tests__/adapter.test.ts` 覆盖字符串和数字 SPAWN 枚举、兄弟动作并行、连续出怪、下一 fragment、空 fragment、wave 前后延迟、小数秒和威胁区域时刻一致性。上述 H5-1 断言直接使用固定快照。

## 默认 hiddenGroup 集合

同一份 PRTS.Map 分包先按关卡难度应用原始 rune，再将 `level_hidden_group_enable.blackboard[].valueStr` 加入默认启用集合。默认 NORMAL / RUNE 的难度位为 1，`NORMAL` / `1` 和 `ALL` / `3` 生效，`NONE` / `0`、`FOUR_STAR` / `2` 不生效。分包在出怪列表中检查 `hiddenGroup`，未启用的非空分组不生成敌人；没有启用集合时只保留无分组动作。

adapter 现在采用这套固定原始关卡的默认配置。危机合约 `crisis_v2_01-01` 只启用 `noduskls`，因此默认敌人数由错误的 46 修正为 30。`waves`、`spawnTimeline`、`enemyDetails`、`highThreatAreas` 和 StageFacts 使用同一有效敌人集合。仅被禁用分组引用的路线被移除，共享路线和原本未引用的路线保留；原始 `route.id` 不重新编号。

分组过滤不改变原始 SPAWN 的 fragment 调度跨度。PRTS.Map 的 `k = max(...)` 位于 hiddenGroup 检查之前，adapter 通过 `FragmentInfo.spawnScheduleDuration` 保留该顺序。这是查看器调度基线，不表示未启用的敌人会出现在实战。

`__tests__/PRTSHiddenGroups.test.ts` 覆盖无启用集合、字符串和数字难度位、共享路线、原始索引保留、禁用分组的调度跨度、crisis 的 30 / 46 对照，以及普通 GT-1 的 42 个敌人保持不变。未知难度位（如 `EASY`、`SIX_STAR`）、默认配置下适用的 `level_hidden_group_disable` 和非法分组数据均明确报错，不猜测新语义或外部合约覆盖。

## 模型限制与验收边界

当前时间线是出怪调度基线。`blockFragment`、死亡或清场等待、`maxTimeWaitingForNextWave`、剧情及其他非 SPAWN 动作的调度持续时间没有完整建模；它们可能使后续出怪进一步推迟。不能将该基线称为精确实战时间。

上述 hiddenGroup 支持仅覆盖固定原始关卡的默认配置，不覆盖玩家额外选择的合约、外部 rune 或挑战难度。其他条件 rune、预置物和动态地图仍需要另外解释；crisis 的芦苇燃烧和元素伤害、MT-10 的睡眠格、激活预置物和扩图事件尚未完整建模。输入可解析不等于能够准确判断战斗。

此次修复会改变所有相关关卡的压力时间分布，应重新集成验证。搜索超时只表示预算内尚未找到完成候选；它既不证明关卡不可行，也不能直接改写为 benchmark 的预期成功。
