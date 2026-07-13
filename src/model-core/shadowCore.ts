import { validateMAAProtocol } from "../copilot/MAAProtocolValidator";
import { validateScript } from "../copilot/ScriptValidator";
import type { BattleScript, BattleScriptAction } from "../types";
import { copilotJsonToBattleDsl } from "./battleDsl";
import { hashBattleScript } from "./modelCoreFeedback";

export type ShadowCoreMode = "rule-core" | "model-core" | "hybrid-core";
export type ShadowCoreName = "rule-core" | "model-core";

export interface ShadowScriptSummary {
  core: ShadowCoreName;
  scriptHash: string;
  validationPassed: boolean;
  scriptValidation: ReturnType<typeof validateScript>;
  protocolValidation: ReturnType<typeof validateMAAProtocol>;
  actionCount: number;
  firstThree: string[];
  deployCells: string[];
  directions: string[];
}

export interface ShadowComparison {
  mode: ShadowCoreMode;
  selectedCore: ShadowCoreName;
  selectionReason: string;
  ruleCore?: ShadowScriptSummary;
  modelCore?: ShadowScriptSummary;
}

function deployActions(script: BattleScript): BattleScriptAction[] {
  return (script.actions || []).filter(action => action.type === "Deploy");
}

function deployCell(action: BattleScriptAction): string {
  const location = Array.isArray(action.location) ? action.location : [];
  return `${location[0]},${location[1]}`;
}

export function summarizeShadowScript(core: ShadowCoreName, script: BattleScript): ShadowScriptSummary {
  const scriptValidation = validateScript(script);
  const protocolValidation = validateMAAProtocol(script);
  const deploys = deployActions(script);
  return {
    core,
    scriptHash: hashBattleScript(copilotJsonToBattleDsl(script)),
    validationPassed: scriptValidation.valid && protocolValidation.valid,
    scriptValidation,
    protocolValidation,
    actionCount: Array.isArray(script.actions) ? script.actions.length : 0,
    firstThree: deploys.slice(0, 3).map(action => `${action.name || ""}@${deployCell(action)}:${action.direction || ""}`),
    deployCells: [...new Set(deploys.map(deployCell))],
    directions: [...new Set(deploys.map(action => String(action.direction || "")))],
  };
}

export function compareShadowScripts(input: {
  mode: ShadowCoreMode;
  ruleScript?: BattleScript;
  modelScript?: BattleScript;
}): ShadowComparison {
  const ruleCore = input.ruleScript ? summarizeShadowScript("rule-core", input.ruleScript) : undefined;
  const modelCore = input.modelScript ? summarizeShadowScript("model-core", input.modelScript) : undefined;

  if (input.mode === "rule-core") {
    if (!ruleCore) throw new Error("rule-core mode requires ruleScript");
    return { mode: input.mode, selectedCore: "rule-core", selectionReason: "explicit rule-core mode", ruleCore };
  }
  if (input.mode === "model-core") {
    if (!modelCore) throw new Error("model-core mode requires modelScript");
    return { mode: input.mode, selectedCore: "model-core", selectionReason: "explicit model-core mode", modelCore };
  }

  if (!ruleCore || !modelCore) throw new Error("hybrid-core mode requires both ruleScript and modelScript");
  if (!ruleCore.validationPassed && modelCore.validationPassed) {
    return { mode: input.mode, selectedCore: "model-core", selectionReason: "rule-core failed validation", ruleCore, modelCore };
  }
  return {
    mode: input.mode,
    selectedCore: "rule-core",
    selectionReason: ruleCore.validationPassed ? "shadow mode keeps rule-core unless it fails validation" : "both cores failed validation",
    ruleCore,
    modelCore,
  };
}
