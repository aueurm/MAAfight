# DeepSeek Operator Knowledge Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every DeepSeek generation receives resolved operator knowledge and understands generated strategic and spatial tags.

**Architecture:** Keep `buildDeepSeekContext` backward-compatible for static compiler use, but require a knowledge resolver at `generateDeepSeekScript`, the production generation boundary. Expose immutable knowledge-model identity in the context and expand only the system prompt’s interpretation rules; candidate legality remains governed by existing deterministic validators.

**Tech Stack:** TypeScript, Node.js, Jest.

---

### Task 1: Lock the DeepSeek knowledge contract with failing tests

**Files:**
- Modify: `__tests__/DeepSeekCore.test.ts`

- [ ] **Step 1: Add a failing generation-boundary test**

```ts
await expect(generateDeepSeekScript({
  ...environment(),
  requestCandidate: async () => ({ battleDsl: battleDsl() }),
} as unknown as DeepSeekGenerationInput)).rejects.toThrow(
  "DeepSeek generation requires getOperatorKnowledge"
);
```

- [ ] **Step 2: Run the focused test to prove the current boundary accepts an incomplete environment**

Run: `npm test -- --runInBand __tests__/DeepSeekCore.test.ts`

Expected: FAIL because `generateDeepSeekScript` currently builds a fallback context instead of requiring a runtime knowledge resolver.

- [ ] **Step 3: Add context and prompt expectations**

```ts
expect(context.operatorKnowledgeModel).toMatchObject({
  modelVersion: expect.any(String),
  generatedCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
  generatedOperatorCount: 412,
  vectorAxes: expect.any(Array),
});
expect(skillTwo.knowledge).toMatchObject({
  tags: ["skill-2"],
  spatial: { skillRangeBehavior: "extends", range: [[0, 2]] },
});
expect(systemPrompt).toContain("positionEffect");
expect(systemPrompt).toContain("avoided");
expect(systemPrompt).toContain("通关保证");
```

- [ ] **Step 4: Run the focused test after adding expectations**

Run: `npm test -- --runInBand __tests__/DeepSeekCore.test.ts`

Expected: FAIL only on the new runtime-model metadata, per-skill resolver, and prompt assertions.

### Task 2: Require runtime knowledge and expose its identity

**Files:**
- Modify: `src/deepseek-core/DeepSeekCompiler.ts`

- [ ] **Step 1: Require the resolver on the production input type**

```ts
export interface DeepSeekGenerationInput extends DeepSeekCompileEnvironment {
  getOperatorKnowledge: NonNullable<DeepSeekCompileEnvironment["getOperatorKnowledge"]>;
  requestCandidate(input: { context: unknown; feedback: DeepSeekFeedback }): Promise<unknown>;
}
```

- [ ] **Step 2: Reject missing runtime knowledge before context construction**

```ts
export async function generateDeepSeekScript(input: DeepSeekGenerationInput): Promise<DeepSeekGenerationResult> {
  if (!input.getOperatorKnowledge) throw new Error("DeepSeek generation requires getOperatorKnowledge");
  const context = buildDeepSeekContext(input);
  // existing retry loop remains unchanged
}
```

- [ ] **Step 3: Attach the shared knowledge-model identity to the context**

```ts
const knowledgeModel = getOperatorKnowledgeModelInfo();
return {
  stageId: input.stageName,
  operatorKnowledgeModel: {
    modelVersion: knowledgeModel.modelVersion,
    generatedCommit: knowledgeModel.generatedCommit,
    generatedOperatorCount: knowledgeModel.generatedOperatorCount,
    vectorAxes: knowledgeModel.vectorAxes,
  },
  operatorKnowledgeVectorAxes: OPERATOR_VECTOR_AXES,
  // existing stage and roster fields
};
```

- [ ] **Step 4: Preserve per-skill resolution**

Keep `knowledgeFor(input, player, combat, index + 1)` for every emitted skill and do not substitute primary-skill spatial data. This is the production path supplied by `src/core/pipeline.ts` through `resolveOperatorProfile(operator, skill, player)`.

- [ ] **Step 5: Run the focused tests**

Run: `npm test -- --runInBand __tests__/DeepSeekCore.test.ts`

Expected: PASS.

### Task 3: Make tag semantics explicit to the model

**Files:**
- Modify: `src/deepseek-core/DeepSeekCore.ts`
- Modify: `docs/operator-knowledge.md`

- [ ] **Step 1: Replace the generic knowledge sentence with concise decision rules**

```ts
const KNOWLEDGE_PROMPT = "operatorKnowledgeModel 标识本次知识数据；只使用 roster 中实际给出的知识。preferred 仅在职责相同的候选中优先，avoided 仅在没有满足职责的替代时使用，sustainedHealing 用于长期支援已建立的前线。frontline、healing、control、area、anti-air、burst 及 skills[].knowledge.tags 是选人信号；spatial.range 是该技能的实际相对射程，attackPattern、coverage、positionEffect、skillRangeBehavior 决定站位与覆盖判断。vector 的含义以 operatorKnowledgeModel.vectorAxes 为准，只能用于相似性和候选排序；不得由标签或向量杜撰能力、射程或通关保证。";
```

- [ ] **Step 2: Document the DeepSeek boundary**

Add a short `## DeepSeek runtime` section stating that production DeepSeek generation requires the pipeline resolver, exposes model identity plus each skill’s resolved knowledge, and treats tags as ranking evidence rather than a pass-rate claim.

- [ ] **Step 3: Run the focused tests again**

Run: `npm test -- --runInBand __tests__/DeepSeekCore.test.ts`

Expected: PASS with the prompt assertions.

### Task 4: Verify the production build and regression surface

**Files:**
- Verify only: `src/core/pipeline.ts`

- [ ] **Step 1: Confirm the pipeline remains the sole production resolver path**

Run: `rg -n -C 2 "getOperatorKnowledge: \(name, skill, player\)" src/core/pipeline.ts`

Expected: the resolver calls `resolveOperatorProfile(operator, skill, player)` before returning knowledge.

- [ ] **Step 2: Build TypeScript and run the full test suite**

Run: `npm run build:node`

Expected: TypeScript exits 0.

Run: `npm test -- --runInBand`

Expected: all Jest suites pass.

- [ ] **Step 3: Check whitespace-only errors**

Run: `git diff --check`

Expected: no diff errors. Do not commit because the worktree contains pre-existing user changes.
