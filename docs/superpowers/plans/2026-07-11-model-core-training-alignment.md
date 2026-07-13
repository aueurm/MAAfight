# Model Core Training Alignment Implementation Plan

> **For agentic workers:** Execute inline in the current worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align model-core training samples with inference candidates, support group/redeploy state, balance skill learning, and produce protocol-valid holdout scripts with a complete basic deployment plan.

**Architecture:** Keep the existing BattleDSL, candidate enumerator, linear ranker, and Beam Search. Fix state semantics at `candidateEnumerator`, filter impossible positives in `actionDataset`, add only action-progress interaction features required by a linear model, and balance pairwise updates by positive action type. No new dependency or parallel model stack.

**Tech Stack:** TypeScript, Node.js, Python stdlib, Jest, unittest.

---

### Task 1: Retreat and redeploy state

**Files:**
- Modify: `src/model-core/candidateEnumerator.ts`
- Test: `__tests__/CandidateEnumerator.test.ts`

- [x] Add a failing test proving Retreat must target an active operator, releases its cell, and makes that operator deployable again.
- [x] Keep imported Retreat in state history and enumerate the resulting redeploy; do not generate untimed Retreat before condition support exists.
- [x] Replace permanent `everDeployed` / occupied sets with active operator-to-cell state.
- [x] Run `npx jest __tests__/CandidateEnumerator.test.ts --runInBand`.

### Task 2: Filter impossible positive samples

**Files:**
- Modify: `src/model-core/actionDataset.ts`
- Test: `__tests__/ActionDataset.test.ts`

- [x] Add a failing test for group-name Deploy and flattened group alternatives.
- [x] Resolve each group action and roster entry to its first declared real operator; retain full history while omitting SpeedUp, untimed Retreat, and impossible positives.
- [x] Assert every emitted positive row is legal under its own partial state.
- [x] Run `npx jest __tests__/ActionDataset.test.ts --runInBand`.

### Task 3: Balance tactical action learning

**Files:**
- Modify: `src/model-core/featureExtractor.ts`
- Modify: `scripts/model-core/train_linear_ranker.py`
- Test: `__tests__/ActionDataset.test.ts`
- Test: `scripts/model-core/test_train_linear_ranker.py`

- [x] Add action-progress and active / used-operator interactions so the linear model can condition action type on sequence state.
- [x] Normalize each training group by its negative count and apply square-root balancing only to SkillUse.
- [x] Learn train-only operator usage priors and retain the best validation epoch.
- [x] Run focused Jest and Python unit tests.

### Task 4: Retrain and evaluate

**Files:**
- Regenerate: `data/model-core/latest-100/*`
- Regenerate: `models/cpu-action-ranker-latest-100.json`
- Generate: `data/model-core/holdout-2025-06-18/*`

- [x] Build a 500-script training dataset with a script-level validation split.
- [x] Train the CPU linear ranker and evaluate the zero-overlap historical 100-script holdout.
- [x] Re-run five selected public scripts in teacher-forced and free-run modes.
- [x] Require all scripts to pass validators and produce a complete fixed-roster basic deployment plan without untimed Retreat or raw-score length drift.

### Task 5: Regression and application validation

**Files:**
- Update model artifact only if Task 4 improves holdout and free-run results.

- [x] Run `npm run build:node` and focused tests; full verification is part of final handoff.
- [x] Promote the improved model artifact only after zero-overlap holdout and five-script free-run validation.
- [x] Keep model mode experimental unless real MAA rehearsal succeeds; offline imitation is not a clear-rate claim.
