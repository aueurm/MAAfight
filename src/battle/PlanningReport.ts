import type {
  BattleScript,
  MapData,
  PlanningReport,
  ProtocolValidationResult,
  SupportLevel,
  TacticalAnalysis,
  ValidationResult,
} from "../types";

export interface PlanningReportInput {
  mapData: MapData;
  analysis: TacticalAnalysis;
  script: BattleScript;
  validation: ValidationResult;
  protocol: ProtocolValidationResult;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function countDeployableTilesUsed(script: BattleScript): number {
  const used = new Set<string>();
  for (const action of script.actions || []) {
    if (action.type === "Deploy" && action.location) {
      used.add(`${action.location[0]},${action.location[1]}`);
    }
  }
  return used.size;
}

function detectBoss(mapData: MapData, analysis: TacticalAnalysis): boolean {
  return analysis.enemyComposition.bossCount > 0 || (mapData.enemyDetails || []).some(e => e.isBoss);
}

function collectKnownRisks(input: PlanningReportInput): string[] {
  const { mapData, analysis, protocol, script } = input;
  const risks: string[] = [];
  const hasEnemyData = (mapData.enemyDetails || []).length > 0;
  const bossDetected = detectBoss(mapData, analysis);
  const operatorGaps = script.metadata.operatorGaps || [];

  if (!hasEnemyData) {
    risks.push("enemy data unavailable; composition uses heuristics");
  }
  if (bossDetected) {
    risks.push("boss wave detected; skill timing model is heuristic only");
  }
  if ((mapData.runes || []).length > 0) {
    risks.push("special tile/rune detected");
  }
  if (analysis.requirements.difficultyRating === "extreme") {
    risks.push("extreme difficulty stage; generated script should be manually reviewed");
  }
  if (protocol.warnings.some(w => w.code === "NON_STANDARD_WAIT")) {
    risks.push("uses internal Wait action; MAA strict protocol may need delay conversion");
  }
  if (protocol.warnings.some(w => w.code === "REQUIREMENTS_RESERVED")) {
    risks.push("operator requirements are informational only in MAA");
  }
  if (operatorGaps.length > 0) {
    risks.push("player operator box lacks candidates for some requested roles");
  }

  return risks;
}

function rateSupportLevel(input: PlanningReportInput, knownRisks: string[]): SupportLevel {
  const { analysis, validation, protocol } = input;
  const difficulty = analysis.requirements.difficultyRating;

  if (!validation.valid || !protocol.valid) {
    return "unsupported";
  }
  if (
    detectBoss(input.mapData, analysis) ||
    (input.mapData.runes || []).length > 0 ||
    difficulty === "extreme" ||
    protocol.warnings.length >= 3
  ) {
    return "experimental";
  }
  if (difficulty === "hard" || protocol.warnings.length > 0 || validation.warnings.length > 0 || knownRisks.length > 0) {
    return "partial";
  }
  return "supported";
}

function calculateConfidence(input: PlanningReportInput, knownRisks: string[]): number {
  const { mapData, analysis, validation, protocol } = input;
  let confidence = 1;

  if (!validation.valid) confidence -= 0.25;
  confidence -= Math.min(0.3, (100 - validation.score) / 200);
  confidence -= Math.min(0.3, protocol.errors.length * 0.2);
  confidence -= Math.min(0.25, protocol.warnings.length * 0.05);
  confidence -= Math.min(0.2, validation.warnings.length * 0.04);

  if ((mapData.enemyDetails || []).length === 0) confidence -= 0.1;
  if (detectBoss(mapData, analysis)) confidence -= 0.1;
  if ((mapData.runes || []).length > 0) confidence -= 0.1;
  if (analysis.requirements.difficultyRating === "hard") confidence -= 0.05;
  if (analysis.requirements.difficultyRating === "extreme") confidence -= 0.15;
  confidence -= Math.min(0.15, knownRisks.length * 0.03);

  return clampConfidence(confidence);
}

export function buildPlanningReport(input: PlanningReportInput): PlanningReport {
  const { mapData, analysis, script, validation, protocol } = input;
  const knownRisks = collectKnownRisks(input);
  const scriptValid = validation.valid && protocol.valid;

  return {
    stage: script.stage_name || mapData.stageId,
    script_valid: scriptValid,
    deployable_tiles_used: countDeployableTilesUsed(script),
    enemy_data_used: (mapData.enemyDetails || []).length > 0,
    boss_detected: detectBoss(mapData, analysis),
    planner_confidence: calculateConfidence(input, knownRisks),
    supportLevel: rateSupportLevel(input, knownRisks),
    known_risks: knownRisks,
    protocolWarnings: protocol.warnings,
    validationScore: Math.min(validation.score, protocol.score),
    difficulty: analysis.requirements.difficultyRating,
    strategy: analysis.suggestedStrategy.name,
    operatorGaps: script.metadata.operatorGaps || [],
    actionCount: (script.actions || []).length,
    deployCount: (script.actions || []).filter(a => a.type === "Deploy").length,
    generatedAt: new Date().toISOString(),
  };
}

export function formatPlanningReport(report: PlanningReport, script: BattleScript): string {
  const lines: string[] = [
    `Stage: ${report.stage}`,
    `Support: ${report.supportLevel}`,
    `Confidence: ${report.planner_confidence.toFixed(2)}`,
  ];

  if (report.difficulty) lines.push(`Difficulty: ${report.difficulty}`);
  if (report.strategy) lines.push(`Strategy: ${report.strategy}`);

  lines.push("", "Deployments:");
  const deployActions = (script.actions || []).filter(a => a.type === "Deploy");
  if (deployActions.length === 0) {
    lines.push("- None");
  } else {
    deployActions.forEach((action, index) => {
      const location = action.location ? `[${action.location[0]}, ${action.location[1]}]` : "[unknown]";
      lines.push(`${index + 1}. ${action.name || "Unknown"}: ${location} ${action.direction || "Unknown"}`);
      lines.push(`   Reason: selected by current role and deployment-order heuristics`);
    });
  }

  lines.push("", "Known risks:");
  if (report.known_risks.length === 0) {
    lines.push("- None");
  } else {
    report.known_risks.forEach(risk => lines.push(`- ${risk}`));
  }

  lines.push("", "Operator gaps:");
  if (report.operatorGaps.length === 0) {
    lines.push("- None");
  } else {
    report.operatorGaps.forEach(gap => lines.push(`- ${gap}`));
  }

  lines.push("", "Protocol warnings:");
  if (report.protocolWarnings.length === 0) {
    lines.push("- None");
  } else {
    report.protocolWarnings.forEach(w => lines.push(`- [${w.code}] ${w.message}`));
  }

  return lines.join("\n");
}
