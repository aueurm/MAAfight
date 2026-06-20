#!/bin/bash
# MAAfight 实测脚本 — 端到端验证
# 用法: bash scripts/test-pipeline.sh [--offline]

set -euo pipefail
cd "$(dirname "$0")/.."

OFFLINE=false
[[ "${1:-}" == "--offline" ]] && OFFLINE=true

# ── 测试关卡列表 ──
LEVELS=(
  "a001_01"
  "main_00-01"
  "main_03-08"
  "hard_05-01"
  "weekly_armor_1"
  "weekly_fly_1"
  "camp_01"
  "crisis_v2_01-01"
  "act42side_10"
  "a001_ex01"
)

# ── 构建 ──
echo "==> Building..."
npm run build --silent 2>&1 || { echo "BUILD FAILED"; exit 1; }
echo ""

OUTDIR="test-results"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

pass=0
fail=0
failed_levels=()

# ── 逐关测试 ──
for stage in "${LEVELS[@]}"; do
  echo "── ${stage} ──────────────────────────────"

  # generate
  outfile="$OUTDIR/${stage}.json"
  if node dist/index.js generate --stage "$stage" --output "$outfile" --quiet 2>&1; then
    echo "  generate  OK  → $outfile"
  else
    echo "  generate  FAIL"
    ((fail++)) || true
    failed_levels+=("$stage (generate)")
    continue
  fi

  # validate
  result=$(node dist/index.js validate --file "$outfile" 2>&1) || true
  if echo "$result" | grep -q "valid"; then
    echo "  validate  OK  ($(echo "$result" | head -1))"
  else
    echo "  validate  FAIL: $result"
    ((fail++)) || true
    failed_levels+=("$stage (validate)")
    continue
  fi

  # info (不阻塞)
  node dist/index.js info --stage "$stage" --quiet 2>&1 | grep -E "Stage:|Map Size:|Routes:|Enemy Types:" || true

  ((pass++)) || true
  echo ""
done

# ── 汇总 ──
echo "=========================================="
echo "  Pass: $pass / ${#LEVELS[@]}"
[[ $fail -gt 0 ]] && echo "  Fail: $fail  → ${failed_levels[*]}"
echo "  Output: $OUTDIR/"
echo "=========================================="

[[ $fail -eq 0 ]] && exit 0 || exit 1
