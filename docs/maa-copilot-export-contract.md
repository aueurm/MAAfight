# MAA Copilot v2 导出契约

## 固定输出

- `version: 3`
- `minimum_required: "v6.0.0"`
- `opers` 尽量为 12 名真实干员
- `groups: []`
- 默认省略 `requirements`
- 文件名、`stage_name` 和标题使用正式关卡编号

v2 始终导出空 `groups`。`hybrid-core` 只在生成阶段选择一份完整脚本，不产生 MAA groups 或混合动作脚本。

## 名字

`opers[].name` 和 `actions[].name` 必须是真实干员名，不得拼接职业、候选列表、练度或模组说明。Deploy 名字必须存在于 `opers`。

## 动作

只允许 MAA 官方动作：`Deploy`、`Skill`、`Retreat`、`SpeedUp`、`BulletTime`、`SkillUsage`、`Output`、`SkillDaemon`、`MoveCamera`、`ResetStopwatch`。

禁止输出 `Wait` 和 `SkillUse`。等待与条件使用 `costs`、`cost_changes`、`kills`、`time_elapsed`、`pre_delay` 和 `post_delay`。

exporter 必须保留 `cooling`、`distance`、`skip_if_not_ready`、`doc` 和 `doc_color`。

## 坐标

内部位置为 `[row, col]`，MAA 位置为 `[x, y]`；导出时转换为 `[col, row]`。

## Requirements

MAAfight 生成的 copilot 始终省略 `requirements`。

## 验证

写文件前必须同时通过 `ScriptValidator` 和 `MAAProtocolValidator`。失败时抛出错误，不写降级脚本。

必要测试：fixed 12 人、空 groups、真实名字、坐标转换、条件字段保留、默认无 requirements、官方动作集合、正式关卡编号。
