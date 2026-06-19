# MAA Copilot v2 导出契约

## 固定输出

- `version: 3`
- `minimum_required: "v6.0.0"`
- `opers` 尽量为 12 名真实干员
- `groups: []`
- 默认省略 `requirements`
- 文件名、`stage_name` 和标题使用正式关卡编号

v2 不提供 groups / hybrid 生成模式。

## 名字

`opers[].name` 和 `actions[].name` 必须是真实干员名，不得拼接职业、候选列表、练度或模组说明。Deploy 名字必须存在于 `opers`。

## 动作

只允许 MAA 官方动作：`Deploy`、`Skill`、`Retreat`、`SpeedUp`、`BulletTime`、`SkillUsage`、`Output`、`SkillDaemon`、`MoveCamera`、`ResetStopwatch`。

禁止输出 `Wait` 和 `SkillUse`。等待与条件使用 `costs`、`cost_changes`、`kills`、`time_elapsed`、`pre_delay` 和 `post_delay`。

exporter 必须保留 `cooling`、`distance`、`skip_if_not_ready`、`doc` 和 `doc_color`。

## 坐标

内部位置为 `[row, col]`，MAA 位置为 `[x, y]`；导出时转换为 `[col, row]`。

## Requirements

默认完整省略。只有 `requirementsMode: "player"` 才导出玩家数据；缺失字段不得使用推荐值伪造。该字段不是 MAA 强制切换配置的证明。

## 验证

写文件前必须同时通过 `ScriptValidator` 和 `MAAProtocolValidator`。失败时抛出错误，不写降级脚本。

必要测试：fixed 12 人、空 groups、真实名字、坐标转换、条件字段保留、默认无 requirements、官方动作集合、正式关卡编号。
