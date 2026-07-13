import {
  DELAY_BUCKETS,
  DIRECTIONS,
  type BattleAction,
} from "./battleDsl";
import {
  actionKey,
  isBasicallyLegalAction,
  type CandidateEnumerationInput,
  type OperatorFeatures,
  type StageFeatures,
} from "./candidateEnumerator";

export type ActionFeatureVector = Record<string, number>;

export interface ExtractActionFeaturesInput {
  stageFeatures: StageFeatures;
  rosterFeatures: OperatorFeatures[];
  partialActions: BattleAction[];
  candidateAction: BattleAction;
  priorStats?: Record<string, number>;
  feedbackStats?: Record<string, number>;
}

export const FEATURE_KEYS = [
  "map_width",
  "map_height",
  "initial_dp",
  "deploy_limit",
  "enemy_total_hp",
  "enemy_avg_def",
  "enemy_avg_res",
  "flying_enemy_count",
  "boss_count",
  "pressure_window_count",
  "melee_tile_count",
  "ranged_tile_count",
  "blue_box_count",
  "route_count",
  "step_index",
  "deployed_count",
  "occupied_cell_count",
  "used_operator_count",
  "cumulative_delay",
  "has_skill_daemon",
  "rough_dp_estimate",
  "last_deploy_x_norm",
  "last_deploy_y_norm",
  "action_type_deploy",
  "action_type_skill_daemon",
  "action_type_skill_use",
  "action_type_retreat",
  "action_type_end",
  "skill_use_progress",
  "retreat_progress",
  "skill_daemon_progress",
  "end_progress",
  "deploy_used_operator_share",
  "skill_use_active_operator_share",
  "retreat_active_operator_share",
  "skill_daemon_used_operator_share",
  "end_used_operator_share",
  "operator_cost",
  "operator_rarity",
  "operator_power",
  "operator_position_melee",
  "operator_position_ranged",
  "operator_public_usage_prior",
  "cell_x_norm",
  "cell_y_norm",
  "tile_type_melee",
  "tile_type_ranged",
  "tile_type_invalid",
  "direction_up",
  "direction_down",
  "direction_left",
  "direction_right",
  "direction_none",
  "delay_bucket",
  "deploy_delay_bucket",
  "is_duplicate_operator",
  "is_occupied_cell",
  "position_prior",
  "direction_prior",
  "timing_prior",
  "is_legal_deploy_cell",
  "is_tile_type_fit",
  "operator_position_prior",
  "position_direction_prior",
  "delay_prior_distance",
  "is_similar_to_failed_action",
  "is_repeating_recent_action",
  "distance_to_nearest_route",
  "distance_to_blue_box",
  "distance_to_chokepoint",
  "is_public_high_freq_area",
] as const;

function emptyFeatures(): ActionFeatureVector {
  return Object.fromEntries(FEATURE_KEYS.map(key => [key, 0]));
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function field(stage: StageFeatures, key: string, fallback = 0): number {
  const root = obj(stage);
  const map = obj(stage.map);
  return numberValue(root[key] ?? map[key] ?? fallback);
}

function pointKey(action: BattleAction): string | null {
  return Number.isInteger(action.x) && Number.isInteger(action.y) ? `${action.x},${action.y}` : null;
}

function deploymentPoints(stage: StageFeatures): Array<{ x: number; y: number; buildableType?: string }> {
  const direct = stage.deploymentPoints || [];
  const mapPoints = Array.isArray(stage.map?.deploymentPoints) ? stage.map.deploymentPoints : [];
  return [...direct, ...mapPoints].flatMap(point => {
    const raw = obj(point);
    const x = numberValue(raw.x ?? raw.col);
    const y = numberValue(raw.y ?? raw.row);
    return Number.isInteger(x) && Number.isInteger(y)
      ? [{ x, y, ...(typeof raw.buildableType === "string" ? { buildableType: raw.buildableType.toLowerCase() } : {}) }]
      : [];
  });
}

function operatorId(operator: OperatorFeatures): string | undefined {
  const id = operator.operatorId || operator.name;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function operatorFor(roster: OperatorFeatures[], action: BattleAction): OperatorFeatures | undefined {
  return roster.find(operator => operatorId(operator) === action.operatorId);
}

function deploys(actions: BattleAction[]): BattleAction[] {
  return actions.filter(action => action.type === "Deploy");
}

function activeDeploys(actions: BattleAction[]): BattleAction[] {
  const active = new Map<string, BattleAction>();
  for (const action of actions) {
    if (action.type === "Deploy" && action.operatorId) active.set(action.operatorId, action);
    if (action.type === "Retreat" && action.operatorId) active.delete(action.operatorId);
  }
  return [...active.values()];
}

function norm(value: number | undefined, max: number): number {
  return max > 0 && Number.isFinite(Number(value)) ? Number(value) / max : 0;
}

function matchingTile(stage: StageFeatures, action: BattleAction): { x: number; y: number; buildableType?: string } | undefined {
  if (action.type !== "Deploy") return undefined;
  return deploymentPoints(stage).find(point => point.x === action.x && point.y === action.y);
}

function tileTypeFit(tile: { buildableType?: string } | undefined, operator: OperatorFeatures | undefined): number {
  if (!tile) return 0;
  const tileType = tile.buildableType;
  const position = String(operator?.position || "").toLowerCase();
  if (!tileType || tileType === "all" || !position) return 1;
  return tileType === position ? 1 : 0;
}

function manhattanToNearest(stage: StageFeatures, action: BattleAction, key: string): number {
  if (action.type !== "Deploy" || !Number.isInteger(action.x) || !Number.isInteger(action.y)) return 0;
  const points = Array.isArray(stage.map?.[key]) ? stage.map![key] as unknown[] : [];
  const distances = points.flatMap(point => {
    const raw = obj(point);
    const x = numberValue(raw.x ?? raw.col);
    const y = numberValue(raw.y ?? raw.row);
    return Number.isInteger(x) && Number.isInteger(y) ? [Math.abs(action.x! - x) + Math.abs(action.y! - y)] : [];
  });
  return distances.length ? Math.min(...distances) : 0;
}

export function extractActionFeatures(input: ExtractActionFeaturesInput): ActionFeatureVector {
  const features = emptyFeatures();
  const { stageFeatures, rosterFeatures, partialActions, candidateAction } = input;
  const width = field(stageFeatures, "cols", field(stageFeatures, "map_width"));
  const height = field(stageFeatures, "rows", field(stageFeatures, "map_height"));
  const allDeploys = deploys(partialActions);
  const active = activeDeploys(partialActions);
  const occupied = new Set(active.map(pointKey).filter(Boolean));
  const usedOperators = new Set(allDeploys.map(action => action.operatorId).filter(Boolean));
  const lastDeploy = allDeploys.at(-1);
  const operator = operatorFor(rosterFeatures, candidateAction);
  const tile = matchingTile(stageFeatures, candidateAction);
  const prior = input.priorStats || {};
  const feedback = input.feedbackStats || {};

  features.map_width = width;
  features.map_height = height;
  features.initial_dp = field(stageFeatures, "initialCost", field(stageFeatures, "initial_dp"));
  features.deploy_limit = field(stageFeatures, "characterLimit", field(stageFeatures, "deploy_limit"));
  features.enemy_total_hp = field(stageFeatures, "weightedHp", field(stageFeatures, "enemy_total_hp"));
  features.enemy_avg_def = field(stageFeatures, "averageDefense", field(stageFeatures, "enemy_avg_def"));
  features.enemy_avg_res = field(stageFeatures, "averageResistance", field(stageFeatures, "enemy_avg_res"));
  features.flying_enemy_count = field(stageFeatures, "flyingEnemyCount", field(stageFeatures, "flyingRouteCount"));
  features.boss_count = field(stageFeatures, "bossCount", field(stageFeatures, "bossTypeCount"));
  features.pressure_window_count = Array.isArray(stageFeatures.map?.pressureWindows) ? stageFeatures.map!.pressureWindows.length : field(stageFeatures, "pressureWindowCount");
  features.melee_tile_count = field(stageFeatures, "meleePointCount");
  features.ranged_tile_count = field(stageFeatures, "rangedPointCount");
  features.blue_box_count = field(stageFeatures, "uniqueEndCount", field(stageFeatures, "blueBoxCount"));
  features.route_count = field(stageFeatures, "routeCount");

  features.step_index = partialActions.length;
  features.deployed_count = active.length;
  features.occupied_cell_count = occupied.size;
  features.used_operator_count = usedOperators.size;
  features.cumulative_delay = partialActions.reduce((sum, action) => sum + numberValue(action.delay), 0);
  features.has_skill_daemon = partialActions.some(action => action.type === "SkillDaemon") ? 1 : 0;
  features.rough_dp_estimate = Math.max(0, features.initial_dp + partialActions.length - allDeploys.length * 10);
  features.last_deploy_x_norm = norm(lastDeploy?.x, width);
  features.last_deploy_y_norm = norm(lastDeploy?.y, height);

  features.action_type_deploy = candidateAction.type === "Deploy" ? 1 : 0;
  features.action_type_skill_daemon = candidateAction.type === "SkillDaemon" ? 1 : 0;
  features.action_type_skill_use = candidateAction.type === "SkillUse" ? 1 : 0;
  features.action_type_retreat = candidateAction.type === "Retreat" ? 1 : 0;
  features.action_type_end = candidateAction.type === "End" ? 1 : 0;
  const sequenceProgress = partialActions.length / Math.max(1, rosterFeatures.length);
  features.skill_use_progress = features.action_type_skill_use * sequenceProgress;
  features.retreat_progress = features.action_type_retreat * sequenceProgress;
  features.skill_daemon_progress = features.action_type_skill_daemon * sequenceProgress;
  features.end_progress = features.action_type_end * sequenceProgress;
  const rosterSize = Math.max(1, rosterFeatures.length);
  const usedOperatorShare = usedOperators.size / rosterSize;
  const activeOperatorShare = active.length / rosterSize;
  features.deploy_used_operator_share = features.action_type_deploy * usedOperatorShare;
  features.skill_use_active_operator_share = features.action_type_skill_use * activeOperatorShare;
  features.retreat_active_operator_share = features.action_type_retreat * activeOperatorShare;
  features.skill_daemon_used_operator_share = features.action_type_skill_daemon * usedOperatorShare;
  features.end_used_operator_share = features.action_type_end * usedOperatorShare;
  features.operator_cost = numberValue(operator?.cost);
  features.operator_rarity = numberValue(operator?.rarity);
  features.operator_power = numberValue(operator?.power ?? operator?.operatorPower);
  const operatorPosition = String(operator?.position || "").toUpperCase();
  features.operator_position_melee = candidateAction.type === "Deploy" && operatorPosition === "MELEE" ? 1 : 0;
  features.operator_position_ranged = candidateAction.type === "Deploy" && operatorPosition === "RANGED" ? 1 : 0;
  features.operator_public_usage_prior = numberValue(operator?.publicUsagePrior);
  features.cell_x_norm = norm(candidateAction.x, width);
  features.cell_y_norm = norm(candidateAction.y, height);
  features.tile_type_melee = tile?.buildableType === "melee" ? 1 : 0;
  features.tile_type_ranged = tile?.buildableType === "ranged" ? 1 : 0;
  features.tile_type_invalid = candidateAction.type === "Deploy" && !tile ? 1 : 0;
  features.direction_up = candidateAction.direction === "Up" ? 1 : 0;
  features.direction_down = candidateAction.direction === "Down" ? 1 : 0;
  features.direction_left = candidateAction.direction === "Left" ? 1 : 0;
  features.direction_right = candidateAction.direction === "Right" ? 1 : 0;
  features.direction_none = candidateAction.direction === "None" ? 1 : 0;
  features.delay_bucket = numberValue(candidateAction.delay) / DELAY_BUCKETS.at(-1)!;
  features.deploy_delay_bucket = features.action_type_deploy * features.delay_bucket;
  features.is_duplicate_operator = candidateAction.operatorId && usedOperators.has(candidateAction.operatorId) ? 1 : 0;
  features.is_occupied_cell = pointKey(candidateAction) && occupied.has(pointKey(candidateAction)!) ? 1 : 0;
  features.position_prior = numberValue(prior.position_prior);
  features.direction_prior = numberValue(prior.direction_prior);
  features.timing_prior = numberValue(prior.timing_prior);
  features.is_legal_deploy_cell = candidateAction.type === "Deploy" && isBasicallyLegalAction(candidateAction, stageInput(input)) ? 1 : 0;

  features.is_tile_type_fit = candidateAction.type === "Deploy" ? tileTypeFit(tile, operator) : 0;
  features.operator_position_prior = numberValue(prior.operator_position_prior);
  features.position_direction_prior = numberValue(prior.position_direction_prior);
  features.delay_prior_distance = numberValue(prior.delay_prior_distance);
  features.is_similar_to_failed_action = numberValue(feedback.is_similar_to_failed_action);
  features.is_repeating_recent_action = partialActions.at(-1) && actionKey(partialActions.at(-1)!) === actionKey(candidateAction) ? 1 : 0;
  features.distance_to_nearest_route = manhattanToNearest(stageFeatures, candidateAction, "routeCells");
  features.distance_to_blue_box = manhattanToNearest(stageFeatures, candidateAction, "goalCells");
  features.distance_to_chokepoint = manhattanToNearest(stageFeatures, candidateAction, "chokeCells");
  features.is_public_high_freq_area = numberValue(prior.is_public_high_freq_area);
  for (const direction of DIRECTIONS) {
    const key = `direction_${String(direction).toLowerCase()}`;
    if (!(key in features)) features[key] = 0;
  }
  return features;
}

function stageInput(input: ExtractActionFeaturesInput): CandidateEnumerationInput {
  return {
    stageFeatures: input.stageFeatures,
    rosterFeatures: input.rosterFeatures,
    partialActions: input.partialActions,
  };
}
