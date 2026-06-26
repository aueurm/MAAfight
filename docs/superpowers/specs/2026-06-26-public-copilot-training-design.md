# Public Copilot Training Design

## Goal

Use a larger PRTS Plus public copilot corpus to improve MAAfight v2 candidate ranking while preserving the existing combat model and MAA copilot contract.

The first rollout downloads and trains on 1,000-2,000 jobs. After the pipeline, reports, and benchmark are stable, the same tooling can run a 3,000-6,000 job preset.

## Non-Goals

- Do not copy full public action sequences into generated scripts.
- Do not infer exact DPS, elite stats, or hidden mechanics from public jobs.
- Do not reintroduce the old rules generator or any fallback script path.
- Do not output non-MAA actions such as `Wait` or `SkillUse`.
- Do not describe ranking scores as pass rate or kill rate.

## Data Sources

The downloader uses the existing PRTS Plus API shape already handled by `scripts/analyze-prts-plus.js`:

- broad latest windows for general priors;
- several historical windows for drift coverage;
- same-stage samples for failed local stages and common simple stages;
- same-activity samples when exact same-stage coverage is thin.

All network fetches write resumable raw job files under a training data directory, plus a manifest of downloaded, skipped, failed, and duplicate IDs.

## Feature Boundary

Same-stage public jobs may only contribute aggregated features:

- deployment heatmaps by tile;
- common facing directions by tile;
- common first few deployment positions as counts, not copied sequences;
- action-type ratios such as deploy, retreat, and skill actions;
- operator, profession, branch, and skill usage counts;
- timing buckets and relative pressure-window hints.

The training artifacts must not store or replay a complete public job action list for a stage.

## Artifacts

`src/data/copilotPrior.v1.json` stores aggregated copilot behavior priors:

- schema and source metadata;
- global priors;
- same-stage priors keyed by stage content hash;
- same-activity priors;
- similar-map priors derived from map traits;
- confidence and sample counts for each bucket.

`src/data/operatorCombatCalibration.v1.json` stores weak-supervision calibration over the existing `operatorCombat.v2` facts:

- operator and skill usage priors by context;
- profession and branch fit priors;
- confidence nudges for partial/base skill coverage;
- local feedback overrides derived from killed/total outcomes.

This calibration layer only changes ranking. It does not mutate `operatorCombat.v2` or claim new GameData facts.

## Training Flow

1. `scripts/sync-prts-plus-corpus.js --preset conservative` downloads 1,000-2,000 jobs across multiple windows and target stage sets.
2. `scripts/build-copilot-prior.js --input data/prts-plus-training --report` builds `copilotPrior.v1` and a compact feature report.
3. `scripts/build-operator-calibration.js --input data/prts-plus-training --feedback .maafight/feedback.jsonl` builds calibration data from public usage plus local outcomes.
4. `scripts/evaluate-priors.js --holdout data/prts-plus-training --benchmark` reports old-vs-new fit and runs the existing benchmark gate.

If the local npm launcher is broken, the equivalent direct Node commands are acceptable.

## Runtime Integration

Generation ranking combines signals in this priority order:

1. local feedback by matching stage revision and player hash, especially killed/total;
2. same-stage public aggregate priors;
3. same-activity and similar-map aggregate priors;
4. global corpus priors;
5. existing combat facts and deterministic beam search.

`CandidateBuilder` may use copilot priors to bias tile, direction, and early deployment choices. `Scoring` may add small prior bonuses or penalties. Operator and skill selection may use calibration nudges, but unsupported-mechanic gaps and hard model constraints still win.

## Reports

The report stays short and always includes three sections:

- data quality: downloaded, parsed, duplicate, failed, map-matched, coordinate-valid, and filtered counts;
- fit evaluation: holdout fit for deployment tile, direction, first-step buckets, action ratios, and old-vs-new deltas;
- training impact: benchmark result, diversity result, changed ranking examples, and feedback override checks.

The end of the report includes a project summary, explanation of the feature boundary, and recommendations for whether to scale to 3,000-6,000 jobs.

## Error Handling

- Network errors retry with backoff and leave failed IDs in the manifest.
- Bad JSON, missing actions, missing deployments, map mismatch, and coordinate overflow are counted and skipped.
- Schema mismatch fails the build.
- Same-stage buckets with too few samples fall back to same-activity, then similar-map, then global priors.
- Highly duplicated stage samples are capped so one stage cannot dominate the global prior.

## Tests And Verification

Unit tests cover:

- downloader resume and manifest behavior using mocked API responses;
- feature extraction without full-sequence leakage;
- prior and calibration schema validation;
- same-stage to same-activity to global fallback;
- feedback priority over public priors;
- MAA contract validation for generated output.

Acceptance commands:

```powershell
node scripts\sync-prts-plus-corpus.js --preset conservative
node scripts\build-copilot-prior.js --input data\prts-plus-training --report
node scripts\build-operator-calibration.js --input data\prts-plus-training --feedback .maafight\feedback.jsonl
node scripts\evaluate-priors.js --holdout data\prts-plus-training --benchmark
node scripts\clean-dist.js
node node_modules\typescript\bin\tsc
node node_modules\jest\bin\jest.js --coverage
node scripts\build-corpus-model.js --audit-only
node scripts\benchmark.js --skip-build
```

The conservative preset passes when it produces both artifacts, emits the short report, improves holdout fit over the current public corpus baseline, does not regress benchmark diversity or protocol validation, and proves local killed/total feedback outranks public priors.

## Claude Code Review Prompt

```text
You are reviewing C:\workspace\work_with_AI\MAAfight.

Context:
- MAAfight v2 generates local MAA copilot JSON v3 drafts.
- It does not execute MAA, ADB, image recognition, or claim pass-rate.
- Existing model: src/data/operatorCombat.v2.json from GameData facts.
- New public-data work should add:
  - src/data/copilotPrior.v1.json for aggregated deployment/action priors.
  - src/data/operatorCombatCalibration.v1.json for weak ranking calibration.
- Public PRTS Plus jobs may be used only as aggregate features. Do not allow copying full action sequences into generated scripts.
- Local killed/total feedback must outrank public priors.
- Output must keep official MAA actions only and must not emit Wait or SkillUse.

Please inspect the implementation for correctness, data leakage, feedback priority, schema safety, benchmark regressions, and MAA contract regressions.

Focus files:
- scripts/sync-prts-plus-corpus.js
- scripts/build-copilot-prior.js
- scripts/build-operator-calibration.js
- scripts/evaluate-priors.js
- scripts/analyze-prts-plus.js
- src/engine/CandidateBuilder.ts
- src/engine/Scoring.ts
- src/engine/index.ts
- src/feedback/FeedbackStore.ts
- src/core/pipeline.ts
- src/data/copilotPrior.v1.json
- src/data/operatorCombatCalibration.v1.json
- docs/corpus-generator.md
- training-results/public-copilot-report.md

Run:
- node scripts\clean-dist.js
- node node_modules\typescript\bin\tsc
- node node_modules\jest\bin\jest.js --coverage
- node scripts\build-corpus-model.js --audit-only
- node scripts\benchmark.js --skip-build

If npm works, npm run build:node, npm test, and npm run corpus:audit are also acceptable.

Output format:
- Findings first, sorted P0/P1/P2/P3 with file and line references.
- Do not list style nits unless they hide a correctness issue.
- Do not edit files.
- End with commands run, residual risks, and whether this is safe to merge.
```
