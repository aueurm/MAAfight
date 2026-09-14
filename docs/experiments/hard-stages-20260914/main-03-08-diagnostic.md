# 3-8 / main_03-08：v3d benchmark 新增失败诊断

结论：当前证据支持有限搜索未覆盖仍可行的已知方案。不能把本次失败解释为关卡无解，也不能归因于分阶段 HPS 门槛。具体哪项末轮改动改变了搜索结果，尚未单独证实，本轮不猜测、不修改生产代码。

## benchmark 与唯一一次重试

| 记录 | 结果 | 关键数值 |
| --- | --- | --- |
| `benchmark-final.results.json` / v3c | 生成、验证、分析通过 | 生成 CLI 2344 ms |
| `benchmark-final-v3d.results.json` | 生成失败 | CLI 2168 ms；拒绝 18 个候选 |
| 本次唯一一次定向重试 | 生成失败 | 进程内 pipeline 1296.65 ms；拒绝 20 个候选 |

原 benchmark 错误：

```text
V2 skill engine search deadline exceeded during joint placement; rejected 18 candidates: route_damage_shortfall
```

重试错误相同，拒绝数量为 20。重试使用当前 `dist`、同一 `test-data/operators-e2-96.json`、`newCandidate: true` 及默认搜索预算。网络禁用，`writeOutput: false`，在进程内将 `FeedbackStore.appendGeneration` 设为无操作，避免写入输出和反馈历史；同时为 Feasibility 加入内存诊断快照。计时含诊断开销，与完整 CLI 时间不可直接比较。未再次执行完整生成或整轮 benchmark。

## 固定 v3c 脚本的当前模型对照

脚本来源：`.maafight/generations.jsonl`，`createdAt = 2026-09-14T13:21:31.836Z`。

- 已记录脚本 SHA-256：`899231f42a0d8ddac234dda4516a335ed6567754486b05ebee3a90b5e52933d4`。
- 已记录关卡内容 hash：`46f0a7280ff20b1318b2e5b99c327fcc6b581c99d0d4cd4ac25462013d805808`。
- 保持原脚本动作、点位、技能及次序不变，按同一玩家库重新解析当前 v3d 干员 profile，再调用当前 Feasibility：`feasible: true`，`reasons: []`。
- 该队中的安洁莉娜 S3 已带 `normalAttackSuppressed: true`，依据为“技能未开启时无法普通攻击”；正确禁普攻后，原脚本仍通过。
- 原队没有 `self_removal_unmodeled` profile。
- 为辨别禁普攻是否直接使原脚本失败，仅在内存关闭该标志作对照，仍然通过。此对照不用于生成或建议回退模型。

这证明至少存在一个在当前 Feasibility 下仍成立的既有方案；它不证明真实通关，也不证明增加搜索预算必然找到该方案。

## 当前候选的直接拒绝证据

前 4 个当前候选都没有禁普攻或自移除 profile。缺伤集中在 route 4、9、10；相关路线峰值 HP 为 16500，现有 10% 路线伤害门槛为 1650。

| 当前候选 | route 4 伤害 | route 9 伤害 | route 10 伤害 |
| --- | ---: | ---: | ---: |
| 1 | 1220.22 | 732.13 | 976.18 |
| 2 | 1628.89 | 814.44 | 未触发该路线短缺 |
| 3 | 1220.22 | 732.13 | 976.18 |
| 4 | 1376.13 | 825.68 | 1100.91 |

这几份候选的两条主防线均已生成，位置为内部 `[row,col] = [4,9] / [3,9]`。不能将此处短缺归因为末条防线被部署名额挤掉。

分阶段 HPS 在当前 Feasibility 中影响 `maximumSurvival` 和 `survival_exposure_upper_bound` 提示，不直接参与 `route_damage_shortfall` 判定。容量、禁普攻与自移除修复是否通过其他搜索步骤产生间接影响，本次未单独归因。

本轮处理：如实保留 benchmark 新失败，不放宽测试、不回退正确模型；生产代码和游戏状态未修改，截图为 0 张。
