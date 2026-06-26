# Public Copilot Training Report

## Data Quality

- Parsed jobs: 1100
- Unique stages: 408
- Source windows: 3
- Full sequences in artifact: no

## Fit Evaluation

- Holdout jobs: 203
- Public prior fit: 0.7322
- Existing corpus prior fit: 0.4233
- Delta: 0.3089

## Training Impact

- Artifact: `src/data/copilotPrior.v1.json`
- Runtime integration: scoring-only weak prior
- Feedback priority: local killed/total remains outside this artifact and is applied after scoring

| Stage | Jobs |
| --- | --- |
| act2break_01 | 123 |
| act24side_ex08 | 23 |
| act2break_12 | 22 |
| act2break_02 | 20 |
| act24side_ex02 | 15 |
| act2break_05 | 14 |
| act24side_09 | 13 |
| act24side_ex03 | 13 |
| act24side_ex04 | 13 |
| act24side_s01 | 13 |

## Summary

This run builds aggregate priors only: heatmaps, directions, first-deploy counts, action ratios, and operator/skill usage counts. It does not store complete public action sequences. Scale to the standard preset only after local simple-stage feedback improves.
