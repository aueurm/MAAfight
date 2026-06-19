# v2 语料驱动引擎

## 语料模型

`scripts/build-corpus-model.js` 将两个目录中的 200 份全歼作业编译为 `src/data/corpusPrior.v1.json`。产物只保存动作语法、相对点位和地图上下文统计，不保存作者、文档或完整作业。

```bash
npm run corpus:audit
npm run model:build
```

按关卡留一统计禁止同关作业成为生成捷径。

## 静态战斗数据

```bash
node scripts/build-operator-combat-model.js --game-data <excel-dir> --commit <upstream-commit>
```

推荐上游：[Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)；按干员拆分的数据见 [`zh_CN/gamedata/bakemuzzledata/character`](https://github.com/Kengxxiao/ArknightsGameData/tree/master/zh_CN/gamedata/bakemuzzledata/character)。

当前构建器接收包含 `character_table.json` 的目录。更新时必须锁定 commit、记录输入 hash，并复核许可证和字段结构。

## 搜索

v2 从 `MapData` 直接构造候选，不调用旧分析器或旧脚本生成器：

1. 展开 3 组选人偏移。
2. 展开 3 组点位偏移。
3. 展开 3 组时序偏移。
4. 应用硬约束和六项评分。
5. 按分数和 script hash 确定性排序，Beam 宽度为 24，最多评估 64 个完整候选。

基础权重：局部交战 30%、点位 20%、费用时序 15%、语料 15%、功能覆盖 10%、自动化 10%。

搜索失败时直接报错，不生成 fallback。
