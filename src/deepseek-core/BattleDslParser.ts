import { DELAY_BUCKETS, type BattleAction, type DelayBucket, type Direction } from "../copilot/battleDsl";

type Operator = { name: string; skill: number; skillUsage: number };

export type ParsedDeepSeekCandidate = { operators: Operator[]; actions: BattleAction[] };
export type BattleDslParseResult = { valid: boolean; errors: string[]; candidate?: ParsedDeepSeekCandidate };

const CONDITIONS = new Set(["kills", "costs", "costChanges", "cooling", "timeElapsed"]);
const ACTION_OPTIONS = new Set(["delay", ...CONDITIONS]);

function error(line: number, message: string): string {
  return `line ${line}: ${message}`;
}

function integer(value: string, line: number, key: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function argumentsAt(source: string, line: number, errors: string[]): { positional: string[]; named: Map<string, number> } | null {
  const errorCount = errors.length;
  const parts = source ? source.split(",").map(part => part.trim()) : [];
  const positional: string[] = [];
  const named = new Map<string, number>();
  for (const part of parts) {
    if (!part) {
      errors.push(error(line, "empty argument"));
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(part);
    if (!match) {
      positional.push(part);
      continue;
    }
    const [, key, rawValue] = match;
    if (!ACTION_OPTIONS.has(key)) errors.push(error(line, `unknown argument ${key}`));
    else if (named.has(key)) errors.push(error(line, `duplicate argument ${key}`));
    else {
      const value = integer(rawValue, line, key);
      if (value === null) errors.push(error(line, `${key} must be an integer`));
      else named.set(key, value);
    }
  }
  return errors.length > errorCount ? null : { positional, named };
}

function conditions(named: Map<string, number>): Pick<BattleAction, "kills" | "costs" | "costChanges" | "cooling" | "timeElapsed"> {
  return Object.fromEntries([...named].filter(([key]) => CONDITIONS.has(key))) as Pick<BattleAction, "kills" | "costs" | "costChanges" | "cooling" | "timeElapsed">;
}

function validateOptions(named: Map<string, number>, line: number, errors: string[]): void {
  const delay = named.get("delay");
  if (delay !== undefined && !DELAY_BUCKETS.includes(delay as DelayBucket)) errors.push(error(line, "delay must be a supported delay bucket"));
  for (const key of ["kills", "costs", "cooling"] as const) {
    if ((named.get(key) ?? 0) < 0) errors.push(error(line, `${key} must be non-negative`));
  }
  if (named.has("timeElapsed") && named.get("timeElapsed")! <= 0) errors.push(error(line, "timeElapsed must be positive"));
}

export function parseDeepSeekBattleDsl(source: unknown): BattleDslParseResult {
  if (typeof source !== "string" || !source.trim()) return { valid: false, errors: ["line 1: battleDsl must be a non-empty string"] };
  const operators: Operator[] = [];
  const actions: BattleAction[] = [{ type: "SpeedUp", delay: 0 }];
  const errors: string[] = [];

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = index + 1;
    const text = rawLine.trim();
    if (!text) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)\((.*)\)$/.exec(text);
    if (!match) {
      errors.push(error(line, "expected function call"));
      continue;
    }
    const [, fn, rawArguments] = match;
    const parsed = argumentsAt(rawArguments, line, errors);
    if (!parsed) continue;
    const { positional, named } = parsed;
    const errorCount = errors.length;
    validateOptions(named, line, errors);
    if (errors.length > errorCount) continue;
    const delay = (named.get("delay") ?? 0) as DelayBucket;
    if (fn === "operator") {
      if (named.size || positional.length !== 3) errors.push(error(line, "operator expects name, skill, skillUsage"));
      else {
        const [name, skillText, skillUsageText] = positional;
        const skill = integer(skillText, line, "skill");
        const skillUsage = integer(skillUsageText, line, "skillUsage");
        if (!name || skill === null || skillUsage === null) errors.push(error(line, "operator has invalid arguments"));
        else operators.push({ name, skill, skillUsage });
      }
    } else if (fn === "deploy") {
      if (positional.length !== 4) errors.push(error(line, "deploy expects name, x, y, direction"));
      else {
        const [operatorId, xText, yText, direction] = positional;
        const x = integer(xText, line, "x");
        const y = integer(yText, line, "y");
        if (!operatorId || x === null || y === null || !direction) errors.push(error(line, "deploy has invalid arguments"));
        else actions.push({ type: "Deploy", operatorId, x, y, direction: direction as Direction, delay });
      }
    } else if (fn === "skill" || fn === "retreat") {
      if (positional.length !== 1) errors.push(error(line, `${fn} expects one operator name`));
      else if (!positional[0]) errors.push(error(line, `${fn} requires an operator name`));
      else actions.push({ type: fn === "skill" ? "SkillUse" : "Retreat", operatorId: positional[0], delay, ...conditions(named) });
    } else if (fn === "skillDaemon") {
      if (positional.length || named.size) errors.push(error(line, "skillDaemon takes no arguments"));
      else actions.push({ type: "SkillDaemon", delay: 0 });
    } else errors.push(error(line, `unknown function ${fn}`));
  }

  if (operators.length !== 12) errors.push(error(1, `expected exactly 12 operators, got ${operators.length}`));
  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [], candidate: { operators, actions: [...actions, { type: "End", delay: 0 }] } };
}
