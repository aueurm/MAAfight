# Model-core 泛化 P0 设计

## 目标

让 CPU action ranker 的训练、离线评估和运行时候选空间一致，并建立可复现的未见地图族评测与 MAA 演习基准。

本期只处理 model-core。不改 `hybrid-core` 决策，不引入新依赖，不把离线排序指标描述为通关率，也不自动晋升新模型。

## 非目标

- 不更换线性 ranker，不引入 LightGBM、角色 head 或 value model。
- 不实现 skill ID 学习、无条件 Retreat、实时击杀 OCR 或反馈驱动生成。
- 不改变默认 Beam 策略；长度归一化仅作为显式消融项。

## 训练与推理一致性

训练样本在教师历史动作形成的状态上调用与 `beamSearch` 相同的 `enumerateCandidateActions()`：

```text
教师历史状态
  -> runtime candidate enumerator（无 publicPriorActions）
  -> Oracle：真实下一动作是否可枚举
  -> 可枚举：生成一组正/负排序行
  -> 不可枚举：只计入 Oracle 报告，不伪造排序样本
```

`fullActions` 只用于构造每一步的历史，绝不传给 `publicPriorActions`。因此训练与运行时不再使用未来教师动作作为候选来源。

P0 明确保持简单关卡边界：训练跳过 Retreat 正样本，候选器不生成无条件 Retreat；手动技能仍只使用已有 `SkillUse` / `SkillDaemon` 语义，不声称已经完成技能编号学习。

## 地图族切分

每个作业从其已解析的地图数据生成以下元数据：

```ts
interface StageFamilyMetadata {
  stageId: string;
  topologyHash?: string;
  routeHash?: string;
  stageFamilyHash?: string;
  status: "complete" | "incomplete";
}
```

- `topologyHash`：尺寸、可部署格类型、出生/目标/禁用格的规范化表示。
- `routeHash`：规范化敌方路线。
- `stageFamilyHash`：`topologyHash + routeHash`。
- 只有 `status: "complete"` 的作业可进入 stage-family train / valid 切分；同一 family 必须完全位于一个集合。
- 缺少路线或拓扑的作业被明确统计为 `incomplete`，可保留在训练语料统计中，但不得进入或支撑“未见地图族”泛化结论。

默认切分保持可复现：以 family hash 与 seed 分到 train / valid；报告实际样本和 family 数量，而非假定固定比例。

## 泛化模型基线

新训练产物不使用具体干员的全局使用率：

- 训练器不计算或注入 `operator_public_usage_prior`。
- 运行时不回填该 prior。
- 应用生成不因干员不在训练 `operatorPriors` 中而剔除其玩家阵容。

模型仍使用现有的成本、稀有度、位置和地图/状态特征。P0 通过特征审计报告其在 train、valid 与运行时的非零率、均值、方差和正负差异；不会在无证据时新增交叉特征。

## 报告与 Beam 消融

数据集构建输出机器可读报告，至少包含：

- 语料、stage、complete family、incomplete family 和各 split 数量；
- Oracle 的 exact / type / operator / cell / direction / delay recall；
- 因 Oracle 缺失而跳过的样本数；
- 每个特征在 train / valid 的非零率、均值、标准差和正负差异。

Beam 消融在同一模型和 held-out family 上比较默认累计 log-softmax 与显式长度归一化参数。报告动作数、首次 End 步、重复动作率、validator 通过率及离线排序指标。默认配置保持不变；只有后续证据支持时才单独讨论上线参数。

## MAA 演习基准

基准从 `complete` 的 stage-family holdout 中，以固定 seed 选取 3 个 simple 关卡。若关卡不可导航、未解锁、生成或验证失败，记录原因并按确定顺序选择下一个候选，不能静默替换。

对每个最终关卡分别运行旧模型快照和 P0 新模型：

```text
生成 -> ScriptValidator + MAAProtocolValidator
     -> 演习 SafetyGate
     -> MAA Copilot
     -> StageDrops / 结算截图星级
     -> benchmark report
```

只允许已有的演习入口；不允许普通理智作战。MAA 路径可来自已有 `.maafight` 配置、环境变量或显式参数。当前探测未自动找到 MAA 时，基准必须清晰报为环境阻塞，不能把未执行写成失败或成功。

可选固定间隔截图只作为诊断产物，记录文件路径与时间；不从截图估算 `killed / total`，星级仍是唯一实战结果。

## 验收

1. 训练候选与运行时同输入的候选集合一致，且没有 future public prior。
2. 完整 stage family 不跨 train / valid；不完整地图不能被标为泛化 holdout。
3. Oracle 缺失、特征分布与 Beam 消融均有可复现报告。
4. 新模型不依赖具体干员全局热度，玩家库中的已拥有精二干员不因训练 OOV 被过滤。
5. 集中 Jest、Python 训练/评估测试、model-core smoke test 和编译通过。
6. 3 个随机 simple holdout 关卡的旧/新模型演习报告完整记录；若 MAA 环境不可用，报告该外部阻塞且其余离线验收仍完整执行。
