# Public Copilot Training Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one conservative public-copilot training path that emits an aggregate prior and lets scoring use it without copying public scripts.

**Architecture:** Reuse the existing PRTS Plus analyzer output and corpus-prior scoring shape. A single Node script orchestrates multi-window downloads, aggregates features into `src/data/copilotPrior.v1.json`, writes a compact report, and Scoring reads the prior as a weak bonus.

**Tech Stack:** Node.js, TypeScript, Jest, JSON artifacts.

---

### Task 1: Train Public Prior

**Files:**
- Create: `scripts/train-public-copilot.js`
- Create: `src/data/copilotPrior.v1.json`
- Test: `__tests__/PublicCopilotTraining.test.ts`

- [ ] Write tests for reuse-only training from fixture corpus directories.
- [ ] Implement `--preset conservative|standard`, `--reuse-corpus`, `--report`, `--input`, and `--output`.
- [ ] Aggregate only counts: stage buckets, context buckets, directions, first actions, action ratios, operator and skill usage.
- [ ] Write `training-results/public-copilot-report.md` when `--report` is set.

### Task 2: Use Prior In Scoring

**Files:**
- Modify: `src/engine/Scoring.ts`
- Test: `__tests__/EngineV2.test.ts`

- [ ] Import `copilotPrior.v1.json`.
- [ ] Add a small scoring bonus for same-stage or context prior fit.
- [ ] Keep `CandidateBuilder` unchanged.
- [ ] Add one deterministic test proving prior loading does not break protocol-safe generation.

### Task 3: Docs

**Files:**
- Modify: `docs/corpus-generator.md`
- Modify: `docs/superpowers/specs/2026-06-26-public-copilot-training-design.md`

- [ ] Document the one-script training command.
- [ ] Keep the no full-sequence-copy boundary explicit.

### Task 4: Verify

- [ ] Run `node scripts\train-public-copilot.js --reuse-corpus --input data\prts-plus-latest-100 --input data\prts-plus-2025-06-18-100 --report`.
- [ ] Run `node scripts\clean-dist.js`.
- [ ] Run `node node_modules\typescript\bin\tsc`.
- [ ] Run `node node_modules\jest\bin\jest.js --coverage`.
- [ ] Run `node scripts\build-corpus-model.js --audit-only`.
- [ ] Run `node scripts\benchmark.js --skip-build`.
