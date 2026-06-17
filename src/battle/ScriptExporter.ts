import type { BattleScript } from "../types";

export interface ExportOptions {
  compress?: boolean;
}

export function exportToCopilotFormat(script: BattleScript, options: ExportOptions = {}): string {
  const cleaned = {
    stage_name: script.stage_name,
    minimum_required: script.minimum_required || "v4.0.0",
    doc: { title: script.doc?.title || "", details: script.doc?.details || "" },
    opers: (script.opers || []).map(op => {
      const out: Record<string, unknown> = { name: op.name };
      if (op.skill !== undefined) out.skill = op.skill;
      if (op.skill_usage !== undefined) out.skill_usage = op.skill_usage;
      if (op.skill_times !== undefined) out.skill_times = op.skill_times;
      if (op.requirements !== undefined) out.requirements = op.requirements;
      return out;
    }),
    groups: (script.groups || []).map(g => ({
      name: g.name,
      opers: (g.opers || []).map(op => {
        const out: Record<string, unknown> = { name: op.name };
        if (op.skill !== undefined) out.skill = op.skill;
        if (op.skill_usage !== undefined) out.skill_usage = op.skill_usage;
        if (op.skill_times !== undefined) out.skill_times = op.skill_times;
        if (op.requirements !== undefined) out.requirements = op.requirements;
        return out;
      }),
    })),
    actions: script.actions.map(a => {
      const out: Record<string, unknown> = { type: a.type };
      if (a.name !== undefined) out.name = a.name;
      if (a.location !== undefined) out.location = a.location;
      if (a.direction !== undefined) out.direction = a.direction;
      if (a.skill !== undefined) out.skill = a.skill;
      if (a.skill_usage !== undefined) out.skill_usage = a.skill_usage;
      if (a.skill_times !== undefined) out.skill_times = a.skill_times;
      if (a.target !== undefined) out.target = a.target;
      if (a.time !== undefined) out.time = a.time;
      return out;
    }),
    version: script.version || 3,
  };

  return JSON.stringify(cleaned, null, options.compress ? 0 : 2);
}
