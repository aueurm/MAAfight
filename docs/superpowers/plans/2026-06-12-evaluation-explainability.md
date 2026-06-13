# Evaluation & Explainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an evaluation and explainability layer so generated copilot scripts can be checked for MAA protocol compatibility, assigned confidence/support signals, and inspected by users.

**Architecture:** Keep tactical generation unchanged for this slice. Add pure post-processing modules that combine `MapData`, `TacticalAnalysis`, `BattleScript`, internal validation, and protocol validation into a report, then expose it through CLI and benchmark output.

**Tech Stack:** Node.js, TypeScript, Jest, existing MAAfight pipeline.

---

### Task 1: MAA Protocol Validator

**Files:**
- Create: `src/battle/MAAProtocolValidator.ts`
- Modify: `src/types.ts`
- Test: `__tests__/MAAProtocolValidator.test.ts`

- [ ] Add protocol issue/result types.
- [ ] Check official action type compatibility, treating `Wait` and `SkillUse` as warnings because they are internal/current aliases.
- [ ] Warn that `requirements` is informational/reserved, not an execution constraint.
- [ ] Warn when `time_elapsed` is used before `ResetStopwatch`.
- [ ] Warn when `MoveCamera` is not followed by delay.
- [ ] Run `node node_modules\jest\bin\jest.js --runTestsByPath __tests__/MAAProtocolValidator.test.ts`.

### Task 2: Planning Report

**Files:**
- Create: `src/battle/PlanningReport.ts`
- Modify: `src/types.ts`
- Test: `__tests__/PlanningReport.test.ts`

- [ ] Add `PlanningReport` and `SupportLevel` types.
- [ ] Compute confidence from internal validation, protocol warnings, boss/rune/high-difficulty risks, and enemy data availability.
- [ ] Generate human-readable explain text with stage, strategy, deployment order, risks, and protocol warnings.
- [ ] Run `node node_modules\jest\bin\jest.js --runTestsByPath __tests__/PlanningReport.test.ts`.

### Task 3: CLI Integration

**Files:**
- Modify: `src/index.ts`
- Test: existing CLI covered by benchmark

- [ ] Parse `--explain`.
- [ ] In `generate`, emit explain text to stderr when writing JSON to file, and avoid mixing explain text with stdout JSON.
- [ ] In `validate`, print protocol compatibility warnings after internal validation warnings.

### Task 4: Benchmark Quality Reports

**Files:**
- Create: `benchmark/stages/basic.json`
- Modify: `scripts/benchmark.js`

- [ ] Load benchmark stages from JSON when present.
- [ ] For each generated stage, run `analyze` and `generate --explain`, then write `benchmark-results/reports/<stage>.json`.
- [ ] Add summary counts for valid scripts, high/medium/low confidence, protocol warnings, and unsupported stages.
- [ ] Keep current command checks intact.

### Task 5: Final Verification

**Commands:**
- `node node_modules\typescript\bin\tsc --noEmit`
- `node node_modules\jest\bin\jest.js --coverage`
- `node scripts\benchmark.js --skip-build`
