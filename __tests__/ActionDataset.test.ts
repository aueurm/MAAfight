import {
  buildActionTrainingSamplesForOperation,
  isValidSplit,
  rosterFeaturesFromCopilot,
  trainingRowsForSample,
  type PublicOperation,
} from "../src/model-core/actionDataset";
import { actionKey, isBasicallyLegalAction } from "../src/model-core/candidateEnumerator";
import { FEATURE_KEYS, extractActionFeatures } from "../src/model-core/featureExtractor";

function operation(id: number | string = 1): PublicOperation {
  return {
    id,
    source: "unit",
    content: {
      stage_name: "TEST-1",
      opers: [{ name: "A" }, { name: "B" }, { name: "C" }],
      groups: [],
      actions: [
        { type: "Deploy", name: "A", location: [1, 1], direction: "Right" },
        { type: "SkillDaemon" },
        { type: "Deploy", name: "B", location: [2, 1], direction: "Left", pre_delay: 260 },
        { type: "Skill", name: "A" },
      ],
    },
    feature: {
      operatorNames: ["A", "B", "C"],
      map: {
        rows: 4,
        cols: 5,
        initialCost: 10,
        characterLimit: 8,
        weightedHp: 1000,
        deploymentPoints: [
          { x: 1, y: 1, buildableType: "all" },
          { x: 2, y: 1, buildableType: "all" },
          { x: 3, y: 2, buildableType: "all" },
        ],
      },
    },
  };
}

describe("model-core action dataset", () => {
  it("splits four actions into five next-action samples with END", () => {
    const samples = buildActionTrainingSamplesForOperation(operation(), { negativeCount: 6, seed: 42 });

    expect(samples).toHaveLength(5);
    expect(samples[0].partialActions).toEqual([]);
    expect(samples[2].partialActions.map(action => action.type)).toEqual(["Deploy", "SkillDaemon"]);
    expect(samples.at(-1)?.positiveAction.type).toBe("End");
  });

  it("omits positive actions outside the inference candidate space without rewriting history", () => {
    const source = operation();
    source.content!.groups = [{ name: "任选组", opers: [{ name: "A" }, { name: "B" }] }];
    source.content!.actions = [
      { type: "SpeedUp" },
      { type: "Deploy", name: "任选组", location: [3, 2], direction: "Right" },
      { type: "Deploy", name: "A", location: [1, 1], direction: "Right" },
      { type: "Retreat", name: "A" },
      { type: "Deploy", name: "A", location: [2, 1], direction: "Left" },
    ];

    const samples = buildActionTrainingSamplesForOperation(source, { negativeCount: 3, seed: 42 });

    expect(samples.map(sample => sample.positiveAction.type)).toEqual(["Deploy", "Deploy", "End"]);
    expect(samples[0].positiveAction.operatorId).toBe("A");
    expect(samples[0].partialActions.map(action => action.type)).toEqual(["SpeedUp"]);
    expect(samples[0].meta?.stepIndex).toBe(1);
    expect(samples[1].partialActions.map(action => action.type)).toEqual(["SpeedUp", "Deploy", "Deploy", "Retreat"]);
    expect(samples[1].meta?.stepIndex).toBe(4);
    expect(samples.every(sample => isBasicallyLegalAction(sample.positiveAction, {
      stageFeatures: sample.stageFeatures,
      rosterFeatures: sample.rosterFeatures,
      partialActions: sample.partialActions,
    }))).toBe(true);
  });

  it("resolves each group to its first choice instead of flattening every alternative", () => {
    const roster = rosterFeaturesFromCopilot({
      opers: [{ name: "固定" }],
      groups: [{ name: "奶盾组", opers: [{ name: "首选" }, { name: "备选" }] }],
    }, { operatorNames: ["固定", "首选", "备选", "额外"] });

    expect(roster.map(operator => operator.operatorId)).toEqual(["固定", "首选"]);
  });

  it("enriches known operators with combat cost and position", () => {
    const roster = rosterFeaturesFromCopilot({ opers: [{ name: "银灰" }] });
    const features = extractActionFeatures({
      stageFeatures: { rows: 3, cols: 3, deploymentPoints: [{ x: 1, y: 1, buildableType: "melee" }] },
      rosterFeatures: roster,
      partialActions: [],
      candidateAction: { type: "Deploy", operatorId: "银灰", x: 1, y: 1, direction: "Right", delay: 0 },
    });

    expect(roster[0]).toMatchObject({ position: "MELEE" });
    expect(roster[0].cost).toBeGreaterThan(0);
    expect(features.operator_position_melee).toBe(1);
    expect(features.operator_position_ranged).toBe(0);
  });

  it("creates one positive row and multiple unique negative rows per group", () => {
    const [sample] = buildActionTrainingSamplesForOperation(operation(), { negativeCount: 6, seed: 42 });
    const rows = trainingRowsForSample(sample);
    const positives = rows.filter(row => row.label === 1);
    const negatives = rows.filter(row => row.label === 0);
    const positiveKey = actionKey(sample.positiveAction);

    expect(positives).toHaveLength(1);
    expect(negatives.length).toBeGreaterThan(1);
    expect(negatives.every(row => actionKey(row.action) !== positiveKey)).toBe(true);
    expect(new Set(negatives.map(row => actionKey(row.action))).size).toBe(negatives.length);
  });

  it("uses same-stage rejected script actions as hard negatives", () => {
    const rejected = {
      stageId: "TEST-1",
      actions: [
        { type: "Deploy" as const, operatorId: "B", x: 3, y: 2, direction: "Down" as const, delay: 0 as const },
      ],
    };
    const [sample] = buildActionTrainingSamplesForOperation(operation(), {
      negativeCount: 3,
      seed: 42,
      rejectedSamples: [rejected],
      rejectedPerSample: 1,
    });

    expect(sample.negativeActions[0]).toEqual(rejected.actions[0]);
    expect(trainingRowsForSample(sample).filter(row => row.label === 0).map(row => actionKey(row.action))).toContain(actionKey(rejected.actions[0]));
  });

  it("ignores rejected actions from other stages", () => {
    const [sample] = buildActionTrainingSamplesForOperation(operation(), {
      negativeCount: 3,
      seed: 42,
      rejectedSamples: [{
        stageId: "OTHER",
        actions: [{ type: "Deploy" as const, operatorId: "B", x: 3, y: 2, direction: "Down" as const, delay: 0 as const }],
      }],
      rejectedPerSample: 1,
    });

    expect(sample.negativeActions[0]).not.toMatchObject({ x: 3, y: 2, direction: "Down" });
  });

  it("is stable with the same seed", () => {
    const left = buildActionTrainingSamplesForOperation(operation(), { negativeCount: 6, seed: 7 });
    const right = buildActionTrainingSamplesForOperation(operation(), { negativeCount: 6, seed: 7 });

    expect(left).toEqual(right);
  });

  it("keeps feature keys stable and delay buckets legal", () => {
    const [sample] = buildActionTrainingSamplesForOperation(operation(), { negativeCount: 6, seed: 42 });
    const rows = trainingRowsForSample(sample);
    const featureKeys = Object.keys(rows[0].features).sort();

    expect(featureKeys).toEqual([...FEATURE_KEYS].sort());
    expect(rows.every(row => [0, 250, 500, 750, 1000, 1500, 3000, 5000].includes(row.action.delay ?? 0))).toBe(true);
  });

  it("preserves typed map cells when teacher actions reuse them", () => {
    const source = operation();
    (source.feature!.map as { deploymentPoints: Array<Record<string, unknown>> }).deploymentPoints[0].buildableType = "melee";
    const [sample] = buildActionTrainingSamplesForOperation(source, { negativeCount: 2, seed: 42 });
    const point = sample.stageFeatures.deploymentPoints?.find(candidate => candidate.x === 1 && candidate.y === 1);
    const features = extractActionFeatures({
      stageFeatures: sample.stageFeatures,
      rosterFeatures: sample.rosterFeatures,
      partialActions: sample.partialActions,
      candidateAction: sample.positiveAction,
    });

    expect(point?.buildableType).toBe("melee");
    expect(features.tile_type_melee).toBe(1);
  });

  it("separates deploy delay from non-deploy timing", () => {
    const [sample] = buildActionTrainingSamplesForOperation(operation(), { negativeCount: 2, seed: 42 });
    const base = {
      stageFeatures: sample.stageFeatures,
      rosterFeatures: sample.rosterFeatures,
      partialActions: sample.partialActions,
    };
    const deploy = extractActionFeatures({
      ...base,
      candidateAction: { type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 5000 },
    });
    const skill = extractActionFeatures({
      ...base,
      candidateAction: { type: "SkillUse", operatorId: "A", delay: 5000 },
    });

    expect(deploy.delay_bucket).toBe(1);
    expect(deploy.deploy_delay_bucket).toBe(1);
    expect(skill.delay_bucket).toBe(1);
    expect(skill.deploy_delay_bucket).toBe(0);
  });

  it("measures deploy distance to shared chokepoints", () => {
    const features = extractActionFeatures({
      stageFeatures: {
        rows: 3,
        cols: 3,
        deploymentPoints: [{ x: 1, y: 1, buildableType: "melee" }],
        map: { chokeCells: [{ x: 2, y: 1 }] },
      },
      rosterFeatures: [{ operatorId: "A", position: "MELEE" }],
      partialActions: [],
      candidateAction: { type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 0 },
    });

    expect(features.distance_to_chokepoint).toBe(1);
  });

  it("adds action-specific sequence progress features", () => {
    const sample = buildActionTrainingSamplesForOperation(operation(), { negativeCount: 6, seed: 42 })[3];
    const skill = extractActionFeatures({
      stageFeatures: sample.stageFeatures,
      rosterFeatures: sample.rosterFeatures,
      partialActions: sample.partialActions,
      candidateAction: sample.positiveAction,
    });
    const end = extractActionFeatures({
      stageFeatures: sample.stageFeatures,
      rosterFeatures: sample.rosterFeatures,
      partialActions: sample.partialActions,
      candidateAction: { type: "End", delay: 0 },
    });

    expect(skill.skill_use_progress).toBeGreaterThan(0);
    expect(skill.skill_use_active_operator_share).toBeGreaterThan(0);
    expect(skill.end_progress).toBe(0);
    expect(skill.end_used_operator_share).toBe(0);
    expect(end.end_progress).toBe(skill.skill_use_progress);
    expect(end.end_used_operator_share).toBeGreaterThan(0);
    expect(end.skill_use_progress).toBe(0);
    expect(end.skill_use_active_operator_share).toBe(0);
  });

  it("splits by script without leaking one script into both train and valid", () => {
    const trainScripts = new Set<string>();
    const validScripts = new Set<string>();
    for (let id = 1; id <= 20; id++) {
      const target = isValidSplit(String(id), 0.3, 42) ? validScripts : trainScripts;
      for (const sample of buildActionTrainingSamplesForOperation(operation(id), { negativeCount: 2, seed: 42 })) {
        target.add(sample.meta!.scriptId!);
      }
    }

    for (const id of trainScripts) expect(validScripts.has(id)).toBe(false);
  });

  it("writes rows as parseable JSONL objects", () => {
    const [sample] = buildActionTrainingSamplesForOperation(operation(), { negativeCount: 3, seed: 42 });
    const lines = trainingRowsForSample(sample).map(row => JSON.stringify(row));

    expect(lines.map(line => JSON.parse(line)).every(row => row.group_id && row.features && row.action)).toBe(true);
  });

  it("does not crash without stage facts and fills feature defaults", () => {
    const samples = buildActionTrainingSamplesForOperation({ ...operation(), feature: undefined }, { negativeCount: 2, seed: 42 });
    const features = extractActionFeatures({
      stageFeatures: samples[0].stageFeatures,
      rosterFeatures: samples[0].rosterFeatures,
      partialActions: [],
      candidateAction: samples[0].positiveAction,
    });

    expect(features.map_width).toBe(0);
    expect(Object.keys(features).sort()).toEqual([...FEATURE_KEYS].sort());
  });
});
