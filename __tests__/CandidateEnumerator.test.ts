import {
  actionKey,
  dedupeCandidateActions,
  enumerateCandidateActions,
  isBasicallyLegalAction,
  type CandidateEnumerationInput,
} from "../src/model-core/candidateEnumerator";
import { DELAY_BUCKETS, type BattleAction } from "../src/model-core/battleDsl";

function input(partialActions: BattleAction[] = []): CandidateEnumerationInput {
  return {
    stageFeatures: {
      stageId: "TEST",
      rows: 4,
      cols: 5,
      deploymentPoints: [
        { x: 1, y: 1, buildableType: "all" },
        { x: 2, y: 1, buildableType: "all" },
        { x: 3, y: 2, buildableType: "all" },
      ],
    },
    rosterFeatures: [
      { operatorId: "A" },
      { operatorId: "B" },
      { operatorId: "C" },
    ],
    partialActions,
  };
}

describe("candidate enumerator", () => {
  it("generates deploy, skill, and end candidates from simple state", () => {
    const candidates = enumerateCandidateActions(input([{ type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 0 }]), {
      maxCandidates: 40,
      seed: 42,
    });

    expect(candidates.some(candidate => candidate.action.type === "Deploy")).toBe(true);
    expect(candidates.some(candidate => candidate.action.type === "End")).toBe(true);
    expect(candidates.some(candidate => candidate.action.type === "SkillDaemon")).toBe(true);
    expect(candidates.some(candidate => candidate.action.type === "SkillUse" && candidate.action.operatorId === "A")).toBe(true);
  });

  it("filters unavailable operators, occupied cells, bad directions, and bad delays", () => {
    const state = input([{ type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 0 }]);

    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "B", x: 2, y: 1, direction: "None", delay: 250 }, state)).toBe(true);
    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "X", x: 2, y: 1, direction: "Right", delay: 0 }, state)).toBe(false);
    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "A", x: 2, y: 1, direction: "Right", delay: 0 }, state)).toBe(false);
    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "B", x: 99, y: 1, direction: "Right", delay: 0 }, state)).toBe(false);
    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "B", x: 4, y: 3, direction: "Right", delay: 0 }, state)).toBe(false);
    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "B", x: 2, y: 1, direction: "Side", delay: 0 }, state)).toBe(false);
    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "B", x: 2, y: 1, direction: "Right", delay: 123 as never }, state)).toBe(false);
  });

  it("releases operators and cells after retreat so they can be deployed again", () => {
    const deployed = input([
      { type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 0 },
    ]);
    const retreated = input([
      ...deployed.partialActions,
      { type: "Retreat", operatorId: "A", delay: 0 },
    ]);

    expect(isBasicallyLegalAction({ type: "Retreat", operatorId: "A", delay: 0 }, deployed)).toBe(true);
    expect(isBasicallyLegalAction({ type: "Retreat", operatorId: "A", delay: 0 }, retreated)).toBe(false);
    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "A", x: 2, y: 1, direction: "Right", delay: 0 }, retreated)).toBe(true);
    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "B", x: 1, y: 1, direction: "Right", delay: 0 }, retreated)).toBe(true);
  });

  it("does not emit untimed retreat but enumerates redeploy after imported retreat", () => {
    const deployed = input([
      { type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 0 },
    ]);
    const retreated = input([
      ...deployed.partialActions,
      { type: "Retreat", operatorId: "A", delay: 0 },
    ]);

    expect(enumerateCandidateActions(deployed, { maxCandidates: 100, seed: 42 })
      .some(candidate => candidate.action.type === "Retreat")).toBe(false);
    expect(enumerateCandidateActions(retreated, { maxCandidates: 100, seed: 42 })
      .some(candidate => candidate.action.type === "Deploy" && candidate.action.operatorId === "A")).toBe(true);
  });

  it("stops deploy candidates at the stage character limit", () => {
    const state = input([{ type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 0 }]);
    state.stageFeatures.characterLimit = 1;

    expect(isBasicallyLegalAction({ type: "Deploy", operatorId: "B", x: 2, y: 1, direction: "Right", delay: 0 }, state)).toBe(false);
    expect(enumerateCandidateActions(state, { maxCandidates: 40, seed: 42 }).some(candidate => candidate.action.type === "Deploy")).toBe(false);
  });

  it("keeps output stable for same seed and allows variation for different seeds", () => {
    const left = enumerateCandidateActions(input(), { maxCandidates: 20, seed: 1 }).map(candidate => actionKey(candidate.action));
    const right = enumerateCandidateActions(input(), { maxCandidates: 20, seed: 1 }).map(candidate => actionKey(candidate.action));
    const other = enumerateCandidateActions(input(), { maxCandidates: 20, seed: 2 }).map(candidate => actionKey(candidate.action));

    expect(left).toEqual(right);
    expect(other).not.toEqual(left);
  });

  it("caps candidates and uses only configured delay buckets", () => {
    for (const maxCandidates of [20, 200, 1000]) {
      const candidates = enumerateCandidateActions(input(), { maxCandidates, seed: 42 });

      expect(candidates.length).toBeLessThanOrEqual(maxCandidates);
      expect(candidates.every(candidate => DELAY_BUCKETS.includes((candidate.action.delay ?? 0) as never))).toBe(true);
    }
  });

  it("covers every legal cell before rotating operators", () => {
    const candidates = enumerateCandidateActions(input(), {
      maxCandidates: 5,
      seed: 42,
      sourceQuota: {
        publicPrior: 0,
        legalGeometry: 3,
        randomExploration: 0,
        legacyRule: 0,
        failureAvoidance: 0,
        skill: 0,
        end: 0,
      },
    });
    const deployCells = candidates
      .filter(candidate => candidate.source === "legal_geometry" && candidate.action.type === "Deploy")
      .map(candidate => `${candidate.action.x},${candidate.action.y}`);

    expect(new Set(deployCells)).toEqual(new Set(["1,1", "2,1", "3,2"]));
  });

  it("covers every operator while cycling legal cells", () => {
    const state = input();
    state.rosterFeatures = Array.from({ length: 20 }, (_, index) => ({ operatorId: `OP-${index}` }));
    const candidates = enumerateCandidateActions(state, {
      maxCandidates: 22,
      seed: 42,
      sourceQuota: { publicPrior: 0, legalGeometry: 20, randomExploration: 0, legacyRule: 0, failureAvoidance: 0, skill: 0, end: 0 },
    });
    const deploys = candidates.filter(candidate => candidate.source === "legal_geometry" && candidate.action.type === "Deploy");

    expect(new Set(deploys.map(candidate => candidate.action.operatorId)).size).toBe(20);
    expect(new Set(deploys.map(candidate => `${candidate.action.x},${candidate.action.y}`)).size).toBe(3);
  });

  it("dedupes candidates and does not rely only on legacy source", () => {
    const state = input();
    const duplicated = [
      { action: { type: "End" as const, delay: 0 as const }, source: "end" as const },
      { action: { type: "End" as const, delay: 0 as const }, source: "legacy_rule" as const },
    ];
    const candidates = enumerateCandidateActions({
      ...state,
      legacyRuleActions: [{ type: "Deploy", operatorId: "A", x: 1, y: 1, direction: "Right", delay: 0 }],
    }, { maxCandidates: 30, seed: 42 });

    expect(dedupeCandidateActions(duplicated)).toHaveLength(1);
    expect(new Set(candidates.map(candidate => actionKey(candidate.action))).size).toBe(candidates.length);
    expect(candidates.some(candidate => candidate.source !== "legacy_rule")).toBe(true);
  });
});
