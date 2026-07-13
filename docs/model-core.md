# CPU BattleCore v0

CPU BattleCore v0 是 MAAfight 的本地 next-action ranking 闭环：

```text
Copilot corpus -> BattleDSL -> action dataset -> linear ranker -> eval -> beam search -> MAA JSON
```

它不训练 LLM，不使用 GPU，也不做 LoRA / DPO / RLHF。当前核心是：

```text
state + candidate_action -> score
```

## GUI

GUI 的“生成模式”可选：

- `传统`：只运行 `rule-core`，保持原 v2 行为。
- `模型`：从本机干员库中取模型认识的全部精二干员，在合法点位上生成动作，再收敛为实际使用的 fixed 12 人阵容。
- `综合`：同时生成两份脚本，复用 shadow validator 比较；当前安全规则在传统脚本有效时保留传统脚本。

三种模式都通过 `src/core/pipeline.ts`，不启动额外 Python / Node 子进程。默认权重文件仍为兼容路径 `models/cpu-action-ranker-latest-100.json`；当前内容由 2,000 份公共作业中的 541 份简单关卡脚本训练，训练语料显式排除 `1-7`，并在训练集外的 `1-7` MAA 演习三星后提升为默认模型。也可用 `MAAFIGHT_MODEL_CORE_PATH` 覆盖。

## CLI

```bash
npm run battle-dsl -- --input copilot.json --output roundtrip.json
npm run enumerate-candidates -- --job copilot.json --step 5 --maxCandidates 500 --seed 42
npm run build-action-dataset -- --input data/prts-plus-latest-100 --out data/model-core --negativeCount 50 --seed 42 --rejectedSamples data/model-core/rejected_samples.jsonl
python scripts/model-core/train_linear_ranker.py --train data/model-core/train.jsonl --valid data/model-core/valid.jsonl --out models/cpu-action-ranker.json --epochs 5 --lr 0.05 --l2 0.0001 --seed 42
python scripts/model-core/eval_ranker.py --model models/cpu-action-ranker.json --valid data/model-core/valid.jsonl --out data/model-core/eval_report.json
npm run generate-script -- --stage STAGE --roster roster.json --model models/cpu-action-ranker.json --out out/copilot.json --config configs/model-core.json --seed 42 --repeatPenalty 1
npm run record-feedback -- --stageHash STAGE_HASH --rosterHash ROSTER_HASH --script out/copilot.json --result failure --entered true --completed false --threeStar false
npm run shadow-core -- --mode hybrid-core --stage STAGE --rule old.json --roster roster.json --model models/cpu-action-ranker.json --outDir data/model-core/shadow
npm run model-core-retrain -- --input data/prts-plus-latest-100 --rejectedSamples data/model-core/rejected_samples.jsonl --modelOut models/cpu-action-ranker.json
npm run model-core-decision -- --eval data/model-core/eval_report.json --feedback data/model-core/feedback.jsonl
npm run model-core-smoke-test
```

`configs/model-core.json` 保存默认 delay buckets、候选枚举配额、beam search 参数和 ranker 版本。`generate-script` 支持 `--config`，并允许命令行参数覆盖配置。

## BattleDSL

内部动作格式在 [src/model-core/battleDsl.ts](../src/model-core/battleDsl.ts)：

```text
SpeedUp
Deploy operatorId x y direction delay
SkillDaemon
SkillUse operatorId delay
Retreat operatorId delay
End
```

delay bucket 为 `0 / 250 / 500 / 750 / 1000 / 1500 / 3000 / 5000`。方向允许 `Up / Down / Left / Right / None`。

## Candidates

[src/model-core/candidateEnumerator.ts](../src/model-core/candidateEnumerator.ts) 生成宽合法候选：

- public prior
- legal geometry
- random exploration
- legacy rule 输入
- failure avoidance 启发式
- SkillDaemon / SkillUse
- End

候选会做基础合法性过滤：干员存在、当前未部署、点位可部署、坐标整数、方向合法、delay 属于 bucket。历史 Retreat 会释放干员和格子，因此后续 Deploy 可表达再部署；在尚不能生成 kills / costs / time 条件前，候选枚举不输出无条件 Retreat。

## Dataset

[scripts/build-action-dataset.js](../scripts/build-action-dataset.js) 读取 analyzer corpus 输出：

```text
source/
  corpus/*.json
  features.json
```

输出：

```text
action_samples.jsonl
train.jsonl
valid.jsonl
```

每个 step 生成 1 个 positive action 和若干基本合法 negative actions，再展开成 pairwise ranker 行。数据构建遵守以下对齐规则：

- group 动作与 roster 都映射到 group 的首选真实干员，不把所有备选摊平成可同时部署的干员。
- SpeedUp、无条件 Retreat 和其他推理候选空间无法表达的正样本不参与训练，但完整动作历史仍用于后续状态计算。
- Retreat 历史会释放 active operator 与 occupied cell，后续再部署正样本保持合法。
- 线性特征包含动作类型与序列进度、在场比例、已用干员比例的交互项；纯状态特征不会被误当成同组候选差异。

如果传入 `--rejectedSamples data/model-core/rejected_samples.jsonl`，同关卡失败脚本的同 step 动作会作为 hard negative 优先加入训练行。旧格式 rejected sample 没有 `stageId` 时会跳过，避免跨关卡污染。

## Ranker And Eval

线性模型由 [scripts/model-core/train_linear_ranker.py](../scripts/model-core/train_linear_ranker.py) 训练，模型 JSON 包含：

- `featureNames`
- `weights`
- `bias`
- `normalization`
- `operatorPriors`
- `metrics`

训练器按每个 decision group 的负样本数归一化 pairwise 更新，只对稀少的 `SkillUse` 做平方根频率平衡。`operatorPriors` 只从训练集 positive Deploy 统计，并在应用内生成时回填到 roster。多 epoch 训练保留验证集 top-5 / top-3 / top-1 综合最优轮次，不用最后一轮覆盖更好的权重。

[scripts/model-core/eval_ranker.py](../scripts/model-core/eval_ranker.py) 输出 top-k、positive rank、pairwise accuracy、候选结构 validator pass rate，以及 Deploy 的点位 / 方向 / delay / 干员命中率。

报告中的 `ablation` 同时给出三组离线对比：

- `ruleCoreProxy`：用 public prior / legality 特征模拟旧 rule-core 的离线 proxy。
- `handwrittenScoring`：宽枚举 + 固定手写权重。
- `actionRanker`：宽枚举 + 训练出的线性 ranker。

`ruleCoreProxy` 不是完整旧 CandidateBuilder 生成脚本；`valid.jsonl` 只有候选行，没有完整旧引擎输出。完整 shadow 对比要在接入模式里比较两边生成的脚本。

## Beam Search

[src/model-core/beamSearch.ts](../src/model-core/beamSearch.ts) 默认参数来自 `configs/model-core.json`：

```json
{
  "beamSize": 8,
  "topActionsPerState": 16,
  "maxSteps": 16,
  "candidateActionsPerState": 500,
  "repeatPenalty": 1
}
```

`repeatPenalty` 会扣掉重复动作和重复部署方向，避免线性 ranker 把脚本压成同一个方向；可用配置或 `--repeatPenalty` 覆盖。

Beam 不直接累加 raw ranker 分。每个状态先对全部候选做 log-softmax，再累积动作对数分数；否则 pairwise 分数的任意正偏置会让长脚本靠重复 Skill 获利。End 只在基础阵容形成后开放，基础部署数取 roster 数、关卡 `characterLimit` 和可用点位数的最小值；在此之前只扩展 Deploy / SkillDaemon。

生成后先验证 BattleDSL，再导出 MAA Copilot JSON 并跑现有 validator。repair 只做结构性修复：去重 End、补 End、修正 delay bucket、丢弃非法 direction 动作。

## Feedback

[src/model-core/modelCoreFeedback.ts](../src/model-core/modelCoreFeedback.ts) 使用 JSONL 存储执行反馈：

```text
data/model-core/feedback.jsonl
data/model-core/rejected_samples.jsonl
```

相同 `stageHash + rosterHash + engineVersion` 的 success 脚本可直接复用；failure 脚本生成 fingerprint，并在后续生成时按前三部署、点位、方向、delay 和技能策略相似度扣分。它不推断复杂战术失败原因。

人工演习结果通过 `record-feedback` 结构化记录：

- `--entered true|false`：是否成功进入战斗。
- `--completed true|false`：是否执行完成。
- `--threeStar true|false`：是否三星。

CLI 摘要会输出失败脚本 hash、前三步部署、部署点集合、方向序列和 delay bucket 结构；失败记录默认刷新 `data/model-core/rejected_samples.jsonl`，也可以用 `--rejectedOut` 改路径。导出的 rejected samples 会保留这些演习字段。

`generate-script` 摘要会输出 `stageHash / rosterHash / engineVersion`，后续 `record-feedback` 直接复用这些值。

如果反馈来自 shadow report，可以直接让 `record-feedback` 读取上下文和脚本路径：

```bash
npm run record-feedback -- --shadowReport data/model-core/shadow/shadow-report-STAGE.json --core model-core --result failure --entered true --completed false --threeStar false
npm run record-feedback -- --shadowReport data/model-core/shadow/shadow-report-STAGE.json --core rule-core --result success --entered true --completed true --threeStar true
```

重新训练仍使用线性 ranker：

```bash
npm run model-core-retrain -- --input data/prts-plus-latest-100 --rejectedSamples data/model-core/rejected_samples.jsonl --modelOut models/cpu-action-ranker.json
```

该命令只串联现有 dataset / train / eval 流程，不引入 LightGBM。

升级判断也保持保守：

```bash
npm run model-core-decision -- --eval data/model-core/eval_report.json --feedback data/model-core/feedback.jsonl --shadowDir data/model-core/shadow
```

默认门槛：

- top-5 recall >= 0.6
- validator pass rate >= 0.9
- 至少 10 条 shadow comparison report
- shadow 中 model-core validator pass rate >= 0.9
- model-core 至少 10 条人工演习记录
- rule-core 至少 10 条人工演习基线记录
- model-core 三星率 >= 0.5
- model-core 三星率高于 rule-core 基线
- 至少 1 次失败后生成出不同脚本
- 至少 1 次失败反馈后出现后续成功 / 三星记录
- action ranker 的 top-5 高于 rule proxy / handwritten baseline

不满足任一项时，报告会给出 `doNotUpgradeModel: true` 和下一步建议。

旧逻辑基线可以用同一个反馈入口记录，`--core rule-core` 会默认写入 `v2-skill-v1`：

```bash
npm run record-feedback -- --core rule-core --stageHash STAGE_HASH --rosterHash ROSTER_HASH --script old.json --result success --entered true --completed true --threeStar true
```

## Shadow 接入

`npm run shadow-core` 提供三种模式：

- `rule-core`：只汇总旧生成脚本。
- `model-core`：只汇总 CPU ranker 生成脚本。
- `hybrid-core`：两边都生成 / 读取，输出对比报告，并保守选择 `rule-core`；只有旧脚本 validator 失败且 model-core 通过时才选择 `model-core`。

报告包含旧脚本 / 新脚本的 `scriptHash`、validator 结果、动作数、前三次部署、部署点集合和方向集合。传入 `--stage` 和 `--roster` 时，报告还会写入 `context.stageHash / context.rosterHash`，记录人工演习反馈时直接复用它们。这一步是 shadow mode，不替换默认 `maafight generate`。

默认输出会按 stage / data 文件名分桶，避免批量 shadow 时互相覆盖：

```text
rule-core-STAGE.json
model-core-STAGE.json
selected-STAGE.json
shadow-report-STAGE.json
```

显式传入 `--report` 或 `--selectedOut` 时仍使用指定路径。

## Manual Rehearsal

先选 10～20 个关卡，覆盖单线、多路线、飞行敌人、boss、高压开局、公共作业多和公共作业少的图。每个关卡先跑 shadow：

```bash
npm run shadow-core -- --mode hybrid-core --stage STAGE --rule old/STAGE.json --roster roster.json --model models/cpu-action-ranker.json --outDir data/model-core/shadow
```

人工演习后，把 model-core 和 rule-core 基线都记录下来：

```bash
npm run record-feedback -- --shadowReport data/model-core/shadow/shadow-report-STAGE.json --core model-core --result failure --entered true --completed false --threeStar false
npm run record-feedback -- --shadowReport data/model-core/shadow/shadow-report-STAGE.json --core rule-core --result success --entered true --completed true --threeStar true
```

记录字段只保留当前决策需要的信息：是否进入战斗、是否执行完成、是否三星。失败脚本的 hash、前三步、部署点集合、方向序列和 delay bucket 结构会由 CLI 摘要和 rejected samples 自动保留。

每轮演习后先跑保守判断：

```bash
npm run model-core-decision -- --eval data/model-core/eval_report.json --feedback data/model-core/feedback.jsonl --shadowDir data/model-core/shadow
```

没有足够 shadow report、model-core 演习记录、rule-core 基线记录，以及失败反馈后的不同生成 / 后续成功证据前，不进入 GBDT / LightGBM。

## Smoke Test

```bash
npm run model-core-smoke-test
```

该命令使用 toy corpus 跑通 BattleDSL roundtrip、候选枚举、dataset 构建、线性 ranker 训练、eval、beam search 和 MAA JSON validator。

## Limits

- v0 只做 CPU 线性 ranker，不做 GBDT / 神经网络。
- 没有模拟器状态，费用、技能可用性和带条件撤退时机仍是保守近似；无条件 Retreat 暂不生成。
- eval 好坏只说明公共作业 next-action 排序拟合，不等于通关率。
- 如果 top-k 很差，先检查 BattleDSL 质量、候选覆盖率、负样本质量、feature extractor 和 train / valid split，再考虑更强模型。
