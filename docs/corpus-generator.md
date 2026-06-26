# v2 语料驱动引擎

## 语料模型

`scripts/build-corpus-model.js` 将两个目录中的 200 份全歼作业编译为 `src/data/corpusPrior.v1.json`。产物只保存动作语法、相对点位和地图上下文统计，不保存作者、文档或完整作业。

```bash
npm run corpus:audit
npm run model:build
```

按关卡留一统计禁止同关作业成为生成捷径。

## 公开作业训练先验

`scripts/train-public-copilot.js` 将 PRTS Plus 多时间窗作业编译为 `src/data/copilotPrior.v1.json`。产物只保存同关 / 同上下文聚合特征，例如部署热力图、方向比例、前三次部署位置计数、动作比例和干员 / 技能使用计数，不保存完整动作序列。

```bash
node scripts/train-public-copilot.js --preset conservative --report
```

无网络或调试时可复用本地语料：

```bash
node scripts/train-public-copilot.js --reuse-corpus --input data/prts-plus-latest-100 --input data/prts-plus-2025-06-18-100 --report
```

首轮运行时只进入 `Scoring` 的弱排序分，不改候选展开；本地 killed / total 反馈仍在公开先验之后覆盖排序。

## 静态战斗数据

```bash
node scripts/build-operator-combat-model.js --game-data <excel-dir> --commit <upstream-commit>
```

推荐上游：[Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)。当前可解析 commit 为 `b327f67a1d73fe9a2501f4e159603a30da75911f`。

构建目录必须同时包含 `character_table.json`、`skill_table.json`、`range_table.json`、`uniequip_table.json` 和 `battle_equip_table.json`。`--commit` 必须是完整 SHA。产物 `src/data/operatorCombat.v2.json` 记录五张表的 SHA-256，稳定排序且不含构建时间；运行时不读取完整 GameData，也不解析描述文本。

## 搜索

v2 从 `MapData` 直接构造候选，不调用旧分析器或旧脚本生成器：

1. 从完整模型目录按关卡需求和队伍剩余能力缺口扩展 `(operator, skill)`，squad Beam 宽度为 32。
2. 使用真实范围格、位置和朝向生成最多 512 个廉价完整候选。
3. 廉价层计算基础交战、点位、费用、语料和能力覆盖。
4. 昂贵层按 15 秒窗口评分技能爆发、周期、治疗、控制和范围交集。
5. 完整评分预算为 64 / 192 / 384，每 8 个候选检查 1200 ms deadline。

基础权重：局部交战 30%、点位 20%、费用时序 15%、语料 15%、功能覆盖 10%、自动化 10%。

搜索失败时直接报错，不生成 fallback。
