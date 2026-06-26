# Model-Driven Layered Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded operator pools with a deterministic GameData-backed catalog and layered squad/deployment/skill search.

**Architecture:** An offline builder compiles five pinned GameData tables into a deterministic v2 combat artifact. Runtime code resolves player/reference profiles, derives an internal encounter context, expands squad and deployment beams cheaply, then applies bounded skill-aware engagement scoring to complete candidates.

**Tech Stack:** Node.js, TypeScript, Jest, JSON build artifacts.

---

### Task 1: Build the v2 combat artifact

**Files:**
- Modify: `scripts/build-operator-combat-model.js`
- Replace: `src/data/operatorCombat.v1.json` with `src/data/operatorCombat.v2.json`
- Test: `__tests__/CombatModelBuilder.test.ts`

- [ ] Add failing fixtures for all five source tables, full commit validation, deterministic hashes, simple skills/modules/talents, and unsupported-mechanic gaps.
- [ ] Run `npx jest __tests__/CombatModelBuilder.test.ts --runInBand` and confirm the new expectations fail.
- [ ] Implement stable v2 compilation with `schemaVersion: 2`, source hashes, E2-capable catalog entries, ranges, skill profiles, reference metrics, confidence, and gaps.
- [ ] Run the focused test and confirm it passes.
- [ ] Build the committed artifact from the pinned latest GameData checkout and verify a second build is byte-identical.

### Task 2: Load and resolve model profiles

**Files:**
- Create: `src/engine/CombatModel.ts`
- Modify: `src/engine/types.ts`
- Test: `__tests__/EngineV2.test.ts`

- [ ] Add failing tests for schema rejection, ID/name lookup, reference profiles, real E2 player profiles, missing skill/module assumptions, and cache-key changes.
- [ ] Implement strict model loading, profession mapping, profile interpolation, assumptions, and the in-process profile cache without role fallback.
- [ ] Run the focused engine tests and confirm they pass.

### Task 3: Replace pool selection with layered search

**Files:**
- Create: `src/engine/EncounterContext.ts`
- Modify: `src/engine/CandidateBuilder.ts`, `src/engine/Scoring.ts`, `src/engine/index.ts`
- Test: `__tests__/EngineV2.test.ts`

- [ ] Add failing tests proving an old-pool outsider can be selected, E0/E1 are excluded, stage pressures change squads, repeated runs are deterministic, and no fixed role plan remains.
- [ ] Implement encounter hashing, capability demand, 32-wide marginal-utility squad beam, range-aware deployment expansion, and up to 512 cheap complete candidates.
- [ ] Implement 15-second skill engagement scoring, six-part ranking, base/skill coverage, in-memory engagement caching, 64/192/384 budgets, convergence checks, and the 1200 ms best-so-far deadline.
- [ ] Run focused engine and protocol tests and confirm they pass.

### Task 4: Migrate player, feedback, and pipeline contracts

**Files:**
- Modify: `src/player/OperatorBox.ts`, `src/feedback/FeedbackStore.ts`, `src/core/pipeline.ts`
- Test: `__tests__/OperatorBox.test.ts`, `__tests__/FeedbackStore.test.ts`, `__tests__/guiServer.test.ts`

- [ ] Add failing tests for model-derived role counts, cost-sensitive player hashes, `v2-skill-v1` reuse isolation, stage revision keys, skill coverage, and search telemetry.
- [ ] Implement the contract changes while preserving fixed squads, official actions, coordinate export, and real-only requirements.
- [ ] Run the focused suites and confirm they pass.

### Task 5: Add diversity and latency regression coverage

**Files:**
- Create: `test-data/operators-e2-96.json`
- Modify: `scripts/benchmark.js`, `docs/architecture.md`, `docs/algorithm-boundary.md`, `docs/corpus-generator.md`, `docs/data-format.md`

- [ ] Generate the sanitized E2 fixture from `.maafight/operators.json`, retaining only model and scoring fields.
- [ ] Add deterministic 10-stage union/signature reporting with gates of 40 operators and 8 squads.
- [ ] Add in-process engine, cold CLI, and warm pipeline P50/P95 reporting and strict SLA checks.
- [ ] Update docs for the v2 artifact, coverage semantics, search termination, assumptions, and no-fallback behavior.

### Task 6: Verify the complete change

- [ ] Read `~/.Codex/dev-rules-test.md` if present.
- [ ] Run `npm run build:node`.
- [ ] Run `npm test`.
- [ ] Run `npm run corpus:audit`.
- [ ] Run `node scripts/benchmark.js --skip-build` and record diversity and P95 results.
- [ ] Run `git diff --check` and verify `package-lock.json` is neither changed by this work nor staged.
