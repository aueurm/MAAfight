# CLI 接口设计

## 概述

MAAfight 是纯 CLI 工具，通过命令行参数控制所有行为。MVP 阶段使用 `process.argv` 手动解析，后续可选 `commander`。

## CLI 架构

```
maafight <command> [options]
```

## 命令

### `generate` — 生成战斗脚本

核心命令，执行完整流水线。

```
maafight generate --stage <stageId> [options]
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--stage` | string | 是 | 关卡标识, 支持多种格式 (见下方) |
| `--output`, `-o` | string | 否 | 输出文件路径, 默认 stdout |
| `--no-cache` | flag | 否 | 强制从网络重新下载关卡数据 |
| `--config` | string | 否 | 脚本生成配置 JSON 文件路径 |
| `--pretty` | flag | 否 | 美化 JSON 输出 (默认紧凑) |
| `--quiet` | flag | 否 | 只输出 JSON, 不输出日志 |

#### Stage ID 格式

```
maafight generate --stage a001_01           # PRTS.Map 内部 ID
maafight generate --stage OF-1              # 玩家可见代号
maafight generate --stage "activities/a001/level_a001_01.json"  # 完整路径
maafight generate --stage 0-1               # 主线代号
maafight generate --stage CE-5              # 物资筹备
```

#### 输出格式

成功时输出 copilot JSON 到 stdout (或 `--output` 指定文件):

```json
{
  "stage_name": "a001_01",
  "minimum_required": "v4.0.0",
  "doc": {
    "title": "a001_01 AI-Generated",
    "details": "swarm composition with 18 enemies, rated easy"
  },
  "opers": [],
  "groups": [
    {
      "name": "先锋",
      "opers": [
        { "name": "推进之王", "skill": 2, "skill_usage": 1 },
        { "name": "风笛", "skill": 2, "skill_usage": 1 }
      ]
    }
  ],
  "actions": [
    { "type": "SpeedUp" },
    { "type": "Deploy", "name": "推进之王", "location": [3, 5], "direction": "Right" },
    { "type": "SkillDaemon" }
  ],
  "version": 3
}
```

失败时返回非零 exit code + stderr 错误信息:

```
Error: Stage "UNKNOWN-1" not found in level index
Try: maafight list --search "UNKNOWN" to find matching stages
```

### `list` — 列出支持的关卡

```
maafight list [options]
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `--search`, `-s` | string | 模糊搜索关卡名 |
| `--category`, `-c` | string | 按分类过滤: main, activity, crisis, roguelike, weekly |
| `--limit` | number | 最大输出数, 默认 50 |

#### 输出示例

```
$ maafight list --search "CE-"

  stageId      code     category    name
  ──────────────────────────────────────────
  weekly_ce_1   CE-1    weekly     货物运送 CE-1
  weekly_ce_2   CE-2    weekly     货物运送 CE-2
  weekly_ce_3   CE-3    weekly     货物运送 CE-3
  weekly_ce_4   CE-4    weekly     货物运送 CE-4
  weekly_ce_5   CE-5    weekly     货物运送 CE-5
```

### `analyze` — 仅执行战术分析

```
maafight analyze --stage <stageId> [--no-cache]
```

输出 TacticalAnalysis JSON，不生成脚本:

```
$ maafight analyze --stage a001_01
{
  "summary": "swarm composition with 18 enemies, rated easy",
  "enemyComposition": {
    "totalCount": 18,
    "normalCount": 15,
    "eliteCount": 3,
    "bossCount": 0,
    "compositionType": "mixed",
    "totalHP": 35000,
    "averageDEF": 120
  },
  "requirements": {
    "vanguardCount": 2,
    "medicCount": 1,
    "tankCount": 1,
    ...
  }
}
```

### `validate` — 验证已有脚本

```
maafight validate --file <script.json>
```

### `info` — 查看关卡详情

```
maafight info --stage <stageId>
```

输出关卡基本信息:

```
$ maafight info --stage a001_01

  Stage: a001_01
  Category: main
  Map Size: 7 x 10
  Deployable: 12 (8 melee, 4 ranged)
  Enemy Types: 3
  Boss: None
  Max Deploy Limit: 8
  Life Points: 10
  Initial Cost: 10
```

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MAAFIGHT_CACHE_DIR` | 缓存目录 | `./cache` |
| `MAAFIGHT_DATA_URL` | PRTS.Map 数据源 URL | `https://map.ark-nights.com` |
| `MAAFIGHT_LOG_LEVEL` | 日志级别 | `info` |

---

## 退出码

| Code | 含义 |
|------|------|
| 0 | 成功 |
| 1 | 一般错误 (参数无效等) |
| 2 | 关卡未找到 |
| 3 | 网络错误 (无法下载数据) |
| 4 | 脚本生成失败 (无法满足需求) |
| 5 | 脚本验证失败 |

---

## 实现骨架

```typescript
// src/index.ts
import { PRTSMapLoader } from "./loader/PRTSMapLoader";
import { PRTSMapAdapter } from "./adapter/PRTSMapAdapter";
import { analyzeBattle } from "./battle/BattleAnalyzer";
import { generateScript } from "./battle/ScriptGenerator";
import { validateScript } from "./battle/ScriptValidator";
import { exportToCopilotFormat } from "./battle/ScriptExporter";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "generate":
      await cmdGenerate(args);
      break;
    case "list":
      cmdList(args);
      break;
    case "analyze":
      await cmdAnalyze(args);
      break;
    case "validate":
      cmdValidate(args);
      break;
    case "info":
      await cmdInfo(args);
      break;
    default:
      printHelp();
      process.exit(1);
  }
}

async function cmdGenerate(args: Args) {
  const loader = new PRTSMapLoader();
  const adapter = new PRTSMapAdapter(loader);

  const prtsData = await loader.load(args.stage, { noCache: args.noCache });
  const mapData = adapter.adapt(prtsData, args.stage);
  const analysis = analyzeBattle(mapData);
  const config = args.config ? JSON.parse(fs.readFileSync(args.config, "utf-8")) : {};
  const script = generateScript(args.stage, mapData, analysis, config);
  const validation = validateScript(script);

  if (!validation.valid && !args.quiet) {
    console.error("Warning: Script validation had errors:");
    validation.errors.forEach(e => console.error(`  - [${e.code}] ${e.message}`));
  }

  const output = exportToCopilotFormat(script, { compress: !args.pretty });

  if (args.output) {
    fs.writeFileSync(args.output, output);
    if (!args.quiet) console.error(`Script written to: ${args.output}`);
  } else {
    console.log(output);
  }
}

// 手动参数解析 (MVP)
function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", stage: "", noCache: false, pretty: false, quiet: false };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "generate" || arg === "list" || arg === "analyze" || arg === "validate" || arg === "info") {
      args.command = arg;
    } else if (arg === "--stage" || arg === "-s") {
      args.stage = argv[++i];
    } else if (arg === "--output" || arg === "-o") {
      args.output = argv[++i];
    } else if (arg === "--no-cache") {
      args.noCache = true;
    } else if (arg === "--pretty") {
      args.pretty = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    }
    i++;
  }

  if (!args.command) {
    console.error("Usage: maafight <command> [options]");
    console.error("Commands: generate, list, analyze, validate, info");
    process.exit(1);
  }

  return args;
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
```

## 文件扩展名约定

- PRTS.Map 关卡 JSON 缓存: `<cacheDir>/levels/<path>.json`
- 输出脚本: `<stageId>_ai.json` (如未指定 `--output`)
- 配置 JSON: `<user指定>.json`
