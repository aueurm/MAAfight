import type { BattleScript } from "../types";

export interface ExportOptions {
  compress?: boolean;
}

export function toCopilotObject(script: BattleScript): Record<string, unknown> {
  const protocolLocation = (location: [number, number]): [number, number] => [location[1], location[0]];
  const cleanOperator = (operator: BattleScript["opers"][number]): Record<string, unknown> => {
    const output: Record<string, unknown> = { name: operator.name };
    if (operator.skill !== undefined) output.skill = operator.skill;
    if (operator.skill_usage !== undefined) output.skill_usage = operator.skill_usage;
    if (operator.skill_times !== undefined) output.skill_times = operator.skill_times;
    if (operator.requirements !== undefined) output.requirements = operator.requirements;
    return output;
  };

  return {
    stage_name: script.stage_name,
    minimum_required: script.minimum_required || "v6.0.0",
    doc: { title: script.doc?.title || "", details: script.doc?.details || "" },
    opers: (script.opers || []).map(cleanOperator),
    groups: (script.groups || []).map(group => ({
      name: group.name,
      opers: (group.opers || []).map(cleanOperator),
    })),
    actions: script.actions.map(action => {
      const output: Record<string, unknown> = { type: action.type };
      if (action.name !== undefined) output.name = action.name;
      if (action.location !== undefined) output.location = protocolLocation(action.location);
      if (action.direction !== undefined) output.direction = action.direction;
      if (action.skill !== undefined) output.skill = action.skill;
      if (action.skill_usage !== undefined) output.skill_usage = action.skill_usage;
      if (action.skill_times !== undefined) output.skill_times = action.skill_times;
      if (action.target !== undefined) output.target = action.target;
      if (action.time !== undefined) output.time = action.time;
      if (action.pre_delay !== undefined) output.pre_delay = action.pre_delay;
      if (action.post_delay !== undefined) output.post_delay = action.post_delay;
      if (action.costs !== undefined) output.costs = action.costs;
      if (action.cost_changes !== undefined) output.cost_changes = action.cost_changes;
      if (action.kills !== undefined) output.kills = action.kills;
      if (action.time_elapsed !== undefined) output.time_elapsed = action.time_elapsed;
      if (action.cooling !== undefined) output.cooling = action.cooling;
      if (action.skip_if_not_ready !== undefined) output.skip_if_not_ready = action.skip_if_not_ready;
      if (action.distance !== undefined) output.distance = action.distance;
      if (action.doc !== undefined) output.doc = action.doc;
      if (action.doc_color !== undefined) output.doc_color = action.doc_color;
      return output;
    }),
    metadata: script.metadata,
    version: script.version || 3,
  };
}

export function exportToCopilotFormat(script: BattleScript, options: ExportOptions = {}): string {
  return JSON.stringify(toCopilotObject(script), null, options.compress ? 0 : 2);
}
