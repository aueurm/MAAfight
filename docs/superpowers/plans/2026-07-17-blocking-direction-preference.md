# Blocking Direction Preference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefer melee units facing the highest-threat incoming route and later ranged units covering every already-deployed melee blocking point.

**Architecture:** Keep cached static route placement scores unchanged. During `buildCandidate`, add a deterministic soft bonus using the current deployment sequence: melee direction is selected from nearby ground-route threat, while a ranged placement is rewarded for covering prior melee positions. The bonus only reorders legal choices and never rejects a placement.

**Tech Stack:** TypeScript, Jest, existing `MapData` routes and `rotateDirection`.

---

### Task 1: Define deterministic direction and blocker coverage bonuses

**Files:**

- Modify: `src/engine/CandidateBuilder.ts:312-375`
- Test: `__tests__/EngineV2.test.ts`

- [x] **Step 1: Write failing placement tests**

```ts
function testPick(name: string, position: "MELEE" | "RANGED", range: Array<[number, number]> = [[0, 0]]): EnginePick {
  return {
    operatorId: name, name, role: "guard", skill: 1, skillRank: 10,
    profile: { operatorId: name, name, role: "guard", subProfession: null, position, damageType: "physical",
      skill: 1, skillRank: 10, baseRangeId: null, skillRangeId: null, range,
      attributes: { hp: 1, atk: 1, def: 1, res: 0, cost: 1, block: 1, attackInterval: 1, attackSpeed: 100 },
      metrics: { normalDps: 1, burstDps: 1, cycleDps: 1, healingHps: 0, physicalEhp: 1, artsEhp: 1, controlSeconds: 0 },
      maxTargets: 1, confidence: "exact", modelCoverageGaps: [] },
  };
}

function makeBlockCoverageMap(): MapData {
  const mapData = makeMapData();
  mapData.routes = [{ id: 0, motionMode: "walk", startPosition: { row: 0, col: 0 },
    checkpoints: [{ row: 0, col: 2 }, { row: 0, col: 3 }], endPosition: { row: 0, col: 5 } }];
  mapData.deploymentPoints = [
    { row: 2, col: 2, buildableType: "melee" }, { row: 2, col: 1, buildableType: "melee" },
    { row: 1, col: 2, buildableType: "ranged" },
  ];
  return mapData;
}

it("faces a melee blocker toward the highest-threat incoming route", () => {
  const mapData = makeMapData();
  mapData.deploymentPoints = [{ row: 2, col: 2, buildableType: "melee" }];
  const built = buildCandidate({ stageCode: "V2-1", mapData, facts: extractStageFacts(mapData),
    picks: [testPick("melee", "MELEE", [[0, 1], [0, 2]])], positionVariant: 0, timingVariant: 0, options: {} });
  expect(built.script.actions.find(action => action.type === "Deploy")?.direction).toBe("Left");
});

it("strongly prefers a ranged direction covering all earlier melee blockers", () => {
  const mapData = makeBlockCoverageMap();
  const built = buildCandidate({ stageCode: "V2-1", mapData, facts: extractStageFacts(mapData),
    picks: [testPick("melee-a", "MELEE"), testPick("melee-b", "MELEE"), testPick("ranged", "RANGED", [[-1, 0], [-1, 1]])],
    positionVariant: 0, timingVariant: 0, options: {} });
  expect(built.script.actions.filter(action => action.type === "Deploy")[2].direction).toBe("Left");
});
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --runInBand __tests__/EngineV2.test.ts`

Expected: the two new expectations fail because placement sorting only uses static route coverage.

- [x] **Step 3: Add minimal dynamic bonuses in `buildCandidate`**

```ts
const meleeBlocks: Array<{ row: number; col: number }> = [];
const placements = rankedPlacements(pick, input.facts)
  .filter(({ point }) => !usedPositions.has(`${point.row},${point.col}`))
  .map(placement => ({ ...placement, score: placement.score + placementPreference(pick, placement, meleeBlocks, input.mapData) }))
  .sort((left, right) => right.score - left.score || left.point.row - right.point.row
    || left.point.col - right.point.col || left.direction.localeCompare(right.direction));
if (pick.profile.position === "MELEE") meleeBlocks.push(placement.point);
```

`placementPreference` must use `rotateDirection` for attack-range coverage, return zero before any melee deployment, and use the highest weighted nearby ground-route direction for a melee pick. Route weight is `count * (maxHp + atk * 10)` with a `2x` elite or `3x` boss multiplier.

- [x] **Step 4: Run focused test and build**

Run: `npm test -- --runInBand __tests__/EngineV2.test.ts && npm run build:node`

Expected: tests pass and TypeScript compiles.

### Task 2: Verify generator compatibility and rehearsal candidate

**Files:**

- Modify: `docs/superpowers/plans/2026-07-17-blocking-direction-preference.md`
- Test: `__tests__/EngineV2.test.ts`

- [x] **Step 1: Run the complete regression suite**

Run: `npm test`

Expected: all Jest suites pass.

- [x] **Step 2: Generate and validate a player-library rehearsal candidate**

Run: `node dist/index.js generate --stage 3-8 --operators .maafight/operators.json --output output/.candidates/practice-03-08-direction-v1.json --pretty && node dist/index.js validate --file output/.candidates/practice-03-08-direction-v1.json`

Expected: protocol validation succeeds, `metadata.playerOperatorsUsed` is true, and no operator gap is reported.

- [x] **Step 3: Commit the focused implementation**

```bash
git add src/engine/CandidateBuilder.ts __tests__/EngineV2.test.ts docs/superpowers/plans/2026-07-17-blocking-direction-preference.md
git commit -m "feat(engine): prefer blockers and incoming routes"
```
