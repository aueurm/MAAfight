# MAA Copilot v2 导出契约

## 固定输出

- `version: 3`
- `minimum_required: "v6.0.0"`
- `opers` 尽量为 12 名真实干员
- `groups: []`
- 默认省略 `requirements`
- 文件名、`stage_name` 和标题使用正式关卡编号

v2 始终导出空 `groups`。

## 名字

`opers[].name` 和 `actions[].name` 必须是真实干员名，不得拼接职业、候选列表、练度或模组说明。Deploy 名字必须存在于 `opers`。

## 动作

只允许 MAA 官方动作：`Deploy`、`Skill`、`Retreat`、`SpeedUp`、`BulletTime`、`SkillUsage`、`Output`、`SkillDaemon`、`MoveCamera`、`ResetStopwatch`。

禁止输出 `Wait` 和 `SkillUse`。等待与条件使用 `costs`、`cost_changes`、`kills`、`cooling`、`elapsed_time`、`pre_delay` 和 `post_delay`。多个原生条件由 MAA 按 AND 语义处理。

`deepseek-core` 默认调用 `deepseek-v4-pro`，模型只返回 JSON 外壳中的函数式 `battleDsl`；本地再解析为既有候选动作。`skill` 和 `retreat` 的 `costChanges`、`timeElapsed` 等条件只在提供时参与 MAA 的 AND 判断，`timeElapsed` 单位为真实时间毫秒，编译时转换为 MAA `elapsed_time`；存在 `timeElapsed` 时在动作首部插入 `ResetStopwatch`。只允许为手动技能生成 MAA `Skill`；自动和被动技能正常部署后由游戏处理。显式手动 `Skill` 的干员必须使用 `skill_usage: 0`；`1` 为自动开技，`2` 为自动开技指定次数（默认一次）。手动 `Skill` 与 `SkillDaemon` 互斥；撤退必须有正 `pre_delay` 或至少一个原生条件；不向模型开放 `skip_if_not_ready`。

exporter 必须保留 `cooling`、`distance`、`skip_if_not_ready`、`doc` 和 `doc_color`。

MAA 6.17.5 的技能超时使用 `timeout`（毫秒，`-1` 表示不限）；导出须保留。旧 `skip_if_not_ready` 仍可读取，但不能与 `timeout` 同时提供，否则 MAA 会跳过该动作。

`elapsed_time`、`pre_delay` 和 `post_delay` 均使用真实时间毫秒，倍速不会改变 MAA 秒表。MAA 先等待全部条件满足，再执行 `pre_delay`。规则引擎的游戏时间需按当时倍速换算。旧字段 `time_elapsed` 不受 MAA 支持，校验和导出必须拒绝并要求重新生成，不能猜测旧脚本单位。

## 坐标

内部位置为 `[row, col]`，MAA 位置为 `[x, y]`；导出时转换为 `[col, row]`。

## Requirements

MAAfight 生成的 copilot 始终省略 `requirements`。

## 验证

写文件前必须同时通过 BattleDSL、`ScriptValidator` 和 `MAAProtocolValidator`。失败时抛出错误，不写降级脚本。

`deepseek-core` 的静态合法脚本只能写入 `output/.candidates/`。只有 GUI 记录到真实三星演习结果时，才可复制到正式 `output/` 路径并更新 `doc.details` 为已验证。

必要测试：fixed 12 人、空 groups、真实名字、坐标转换、条件字段保留、默认无 requirements、官方动作集合、正式关卡编号。
