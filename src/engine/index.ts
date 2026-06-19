import { createHash } from "crypto";
import { exportToCopilotFormat } from "../copilot/ScriptExporter";
import type { BattleScript, MapData } from "../types";
import { buildCandidate } from "./CandidateBuilder";
import { scoreCandidate, getModelVersions, weightedScore } from "./Scoring";
import { extractStageFacts } from "./StageFacts";
import type { EngineOptions, EngineResult, ScoreBreakdown } from "./types";

export { extractStageFacts } from "./StageFacts";
export type { EngineOptions, EngineResult, ScoreBreakdown, StageFacts } from "./types";

export function computeScriptHash(script: BattleScript): string {
  return createHash("sha256").update(exportToCopilotFormat(script, { compress: true })).digest("hex");
}

function hardConstraints(script: BattleScript, mapData: MapData): boolean {
  const operatorNames = new Set(script.opers.map(operator => operator.name));
  const deploys = script.actions.filter(action => action.type === "Deploy");
  const occupied = new Set<string>();
  for (const action of deploys) {
    if (!action.name || !operatorNames.has(action.name) || !action.location) return false;
    const key = `${action.location[0]},${action.location[1]}`;
    if (occupied.has(key)) return false;
    occupied.add(key);
    const point = mapData.deploymentPoints.find(candidate => candidate.row === action.location![0] && candidate.col === action.location![1]);
    if (!point) return false;
  }
  return script.groups.length === 0 && script.opers.length <= 12 && deploys.length > 0;
}

export function generateCopilotScript(stageCode: string, mapData: MapData, options: EngineOptions = {}): EngineResult {
  const facts = extractStageFacts(mapData);
  const versions = getModelVersions();
  const candidates: EngineResult[] = [];
  let evaluatedCandidates = 0;
  let rejectedCandidates = 0;

  for (let operatorVariant = 0; operatorVariant < 3; operatorVariant++) {
    for (let positionVariant = 0; positionVariant < 3; positionVariant++) {
      for (let timingVariant = 0; timingVariant < 3; timingVariant++) {
        if (evaluatedCandidates >= 64) break;
        evaluatedCandidates++;
        const built = buildCandidate({
          stageCode,
          mapData,
          facts,
          operatorVariant,
          positionVariant,
          timingVariant,
          options,
        });
        const scriptHash = computeScriptHash(built.script);
        if (!hardConstraints(built.script, mapData) || options.excludedHashes?.has(scriptHash)) {
          rejectedCandidates++;
          continue;
        }
        const scored = scoreCandidate(built.script, built.picks, facts);
        const feedback = options.feedbackAdjustment?.(built.script, scriptHash, scored.breakdown) || 0;
        const score = Math.max(0, Math.min(100, weightedScore(scored.breakdown) + feedback));
        const warnings = [...built.warnings, ...scored.coverageGaps];
        built.script.metadata = {
          ...built.script.metadata,
          candidateScore: score,
          candidateScoreBreakdown: { ...scored.breakdown },
          corpusModelVersion: versions.corpus,
          combatModelVersion: versions.combat,
          combatCoverage: scored.coverage,
          warnings,
        };
        candidates.push({
          script: built.script,
          facts,
          scriptHash,
          score,
          breakdown: scored.breakdown,
          modelVersion: versions.corpus,
          combatModelVersion: versions.combat,
          combatCoverage: scored.coverage,
          evaluatedCandidates,
          rejectedCandidates,
          warnings,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.scriptHash.localeCompare(b.scriptHash));
  const beam = candidates.slice(0, 24);
  const best = beam[0];
  if (!best) throw new Error("V2 engine produced no protocol-safe candidate");
  return { ...best, evaluatedCandidates, rejectedCandidates };
}
