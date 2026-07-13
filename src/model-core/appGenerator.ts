import { getCombatOperatorByName } from "../engine/CombatModel";
import type { StageFacts } from "../engine";
import type { BattleScript, BattleScriptAction, MapData, PlayerOperator } from "../types";
import { generateBattleScript } from "./beamSearch";
import type { BattleAction } from "./battleDsl";
import type { OperatorFeatures, StageFeatures } from "./candidateEnumerator";
import { LinearActionRanker } from "./linearRanker";

export interface AppModelGeneration {
  script: BattleScript;
  score: number;
  modelVersion: string;
}

function stageFeatures(mapData: MapData, facts: StageFacts): StageFeatures {
  const deploymentPoints = mapData.deploymentPoints.map(point => ({
    x: point.col,
    y: point.row,
    buildableType: point.buildableType,
  }));
  return {
    stageId: mapData.stageId,
    stageName: mapData.name,
    rows: facts.rows,
    cols: facts.cols,
    characterLimit: mapData.options.characterLimit,
    deploymentPoints,
    map: {
      rows: facts.rows,
      cols: facts.cols,
      deploymentPoints,
      initialCost: facts.initialCost,
      characterLimit: facts.characterLimit,
      weightedHp: facts.totalHp,
      averageDefense: facts.averageDefense,
      averageResistance: facts.averageResistance,
      flyingRouteCount: facts.flyingRouteCount,
      bossCount: facts.bossCount,
      pressureWindows: facts.pressureWindows,
      routeCount: mapData.routes.length,
      routeCells: facts.routeCells.map(point => ({ x: point.col, y: point.row })),
      goalCells: facts.goalCells.map(point => ({ x: point.col, y: point.row })),
      chokeCells: facts.chokeCells.map(point => ({ x: point.col, y: point.row })),
    },
  };
}

export function modelRosterFeatures(script: Pick<BattleScript, "opers">, players?: Map<string, PlayerOperator>): OperatorFeatures[] {
  const operators = players
    ? [...players.values()].filter(operator => operator.own && operator.elite >= 2)
    : script.opers;
  return operators.map(operator => {
    const player = players?.get(operator.name);
    const combat = getCombatOperatorByName(operator.name);
    return {
      operatorId: operator.name,
      name: operator.name,
      position: combat?.position,
      rarity: player?.rarity ?? combat?.rarity,
      cost: player?.cost ?? combat?.e2.reference.cost,
    };
  });
}

export function selectGeneratedOperators(
  existingOperators: BattleScript["opers"],
  actions: BattleScriptAction[],
  fallbackNames: string[] = [],
  allowedNames?: Set<string>,
): BattleScript["opers"] {
  const existingByName = new Map(existingOperators.map(operator => [operator.name, operator]));
  const referencedNames = actions.flatMap(action => "name" in action && action.name ? [action.name] : []);
  const names = [...new Set([...referencedNames, ...fallbackNames, ...existingOperators.map(operator => operator.name)])]
    .filter(name => !allowedNames || allowedNames.has(name));
  return names.slice(0, 12).map(name => existingByName.get(name) || { name, skill: 1, skill_usage: 1 });
}

function delay(action: BattleAction): Pick<BattleScriptAction, "pre_delay"> {
  return action.delay ? { pre_delay: action.delay } : {};
}

function toScriptAction(action: BattleAction): BattleScriptAction | null {
  if (action.type === "End") return null;
  if (action.type === "SkillDaemon") return { type: "SkillDaemon" };
  if (action.type === "SkillUse") return action.operatorId
    ? { type: "Skill", name: action.operatorId, ...delay(action) }
    : null;
  if (action.type === "Retreat") return action.operatorId
    ? { type: "Retreat", name: action.operatorId, ...delay(action) }
    : null;
  if (action.type !== "Deploy" || !action.operatorId || !Number.isInteger(action.x) || !Number.isInteger(action.y)) return null;
  return {
    type: "Deploy",
    name: action.operatorId,
    location: [action.y!, action.x!],
    direction: action.direction,
    ...delay(action),
  };
}

export function placeSkillDaemonLast(actions: BattleScriptAction[]): BattleScriptAction[] {
  return [...actions.filter(action => action.type !== "SkillDaemon"), { type: "SkillDaemon" }];
}

export function generateAppModelScript(input: {
  stageName: string;
  mapData: MapData;
  facts: StageFacts;
  squadScript: BattleScript;
  playerOperators?: Map<string, PlayerOperator>;
  modelPath: string;
}): AppModelGeneration {
  const stage = stageFeatures(input.mapData, input.facts);
  const ranker = LinearActionRanker.loadFromJson(input.modelPath);
  const trainedOperators = new Set(Object.keys(ranker.model.operatorPriors || {}));
  const roster = modelRosterFeatures(input.squadScript, input.playerOperators)
    .filter(operator => !trainedOperators.size || trainedOperators.has(operator.operatorId || operator.name || ""));
  const generated = generateBattleScript({
    stageId: input.stageName,
    stageFeatures: stage,
    rosterFeatures: roster,
    rankerModel: ranker.model,
  });
  const actions = generated.actions.map(toScriptAction).filter((action): action is BattleScriptAction => Boolean(action));
  const orderedActions = placeSkillDaemonLast(actions);
  const ownedNames = input.playerOperators
    ? new Set([...input.playerOperators.values()].filter(operator => operator.own).map(operator => operator.name))
    : undefined;
  const referencedNames = orderedActions.flatMap(action => "name" in action && action.name ? [action.name] : []);
  const unavailableNames = ownedNames ? referencedNames.filter(name => !ownedNames.has(name)) : [];
  if (unavailableNames.length) {
    throw new Error(`Model generated operators missing from player library: ${[...new Set(unavailableNames)].join(", ")}`);
  }
  const generatedOperators = selectGeneratedOperators(
    input.squadScript.opers,
    orderedActions,
    input.playerOperators
      ? [...input.playerOperators.values()]
        .filter(operator => operator.own && trainedOperators.has(operator.name))
        .map(operator => operator.name)
      : roster.flatMap(operator => operator.name ? [operator.name] : []),
    ownedNames,
  );

  return {
    script: {
      ...input.squadScript,
      stage_name: input.stageName,
      opers: generatedOperators,
      groups: [],
      actions: [{ type: "SpeedUp" }, ...orderedActions],
      generatedAt: new Date().toISOString(),
      metadata: {
        ...input.squadScript.metadata,
        source: "maafight-model-core",
        candidateScore: generated.score,
        corpusModelVersion: ranker.model.version,
      },
    },
    score: generated.score,
    modelVersion: ranker.model.version,
  };
}
