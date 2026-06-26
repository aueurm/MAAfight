# v2 数据格式

## MapData

`PRTSMapAdapter` 输出纯结构化 `MapData`：地图格、部署点、路线、波次、敌人详情、出怪时间线和关卡选项。adapter 不生成部署顺序。

## StageFacts

`extractStageFacts(MapData)` 输出不可依赖旧战术对象的事实模型：

```typescript
interface StageFacts {
  enemyCount: number;
  totalHp: number;
  totalAttack: number;
  bossCount: number;
  flyingRouteCount: number;
  laneCount: number;
  pressureWindows: PressureWindow[];
  deploymentPoints: DeploymentPoint[];
  difficulty: "easy" | "medium" | "hard" | "extreme";
}
```

`PressureWindow` 固定为 15 秒，记录敌人数、HP、攻击、飞行、精英和 Boss 压力。

## EngineResult

```typescript
interface EngineResult {
  script: BattleScript;
  facts: StageFacts;
  scriptHash: string;
  score: number;
  breakdown: {
    combat: number;
    position: number;
    timing: number;
    corpus: number;
    tasks: number;
    automation: number;
  };
  modelVersion: string;
  combatModelVersion: string;
  combatCoverage: number;
  skillCoverage: number;
  coverageGaps: string[];
  stageContentHash: string;
  gameDataCommit: string;
  searchStats: SearchStats;
}
```

分项和总分只用于候选排序。

## BattleScript

内部坐标使用 `[row, col]`，exporter 转换为 MAA `[x, y]`。默认输出 fixed 12 人、`groups: []`、`version: 3`、`minimum_required: v6.0.0`。

默认省略 `requirements`；显式 `player` 模式只使用玩家 JSON 中的真实数据。
