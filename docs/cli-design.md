# v2 CLI 与 GUI

## CLI

```bash
maafight generate --stage GT-1 --output GT-1.json --pretty
maafight generate --data ./level_GT-1.json --stage GT-1 --output GT-1.json
maafight generate --stage GT-1 --new-candidate
maafight analyze --stage GT-1 --pretty
maafight validate --file GT-1.json
maafight feedback record --file GT-1.json --killed 42 --total 42
maafight feedback summary --stage GT-1
maafight gui
```

生成参数：

| 参数 | 说明 |
| --- | --- |
| `--stage` | 正式关卡编号或内部 ID |
| `--data` | 本地 PRTS.Map JSON |
| `--output` | 输出文件；省略时 JSON 写入 stdout |
| `--operators` | 玩家干员库 |
| `--requirements none\|player` | 默认省略或导出玩家真实要求 |
| `--new-candidate` | 不复用已有 100% 实测结果 |
| `--explain` | 向 stderr 输出事实摘要与候选评分 |

v2 没有生成器或编队模式选项。stdout 输出 JSON 时，warning 和 explain 必须走 stderr。

## GUI API

- `GET /api/config`
- `GET /api/stages`
- `POST /api/analyze`
- `POST /api/generate`
- `POST /api/validate`
- `POST /api/feedback`
- `GET /api/feedback/summary`

`/api/config` 返回 `engine: "v2"`。`/api/generate` 只接受 v2 公共字段，不提供旧生成器选择。

## 本地目录

```text
.maafight/operators.json
.maafight/generations.jsonl
.maafight/feedback.jsonl
cache/levels/
output/
logs/
```
