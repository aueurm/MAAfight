import * as fs from "fs";
import type { RunOutcome } from "./types";

export interface CallbackParseResult {
  outcome: RunOutcome;
  stars?: number;
  errorType?: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function readCallbackLogFile(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) throw new Error(`Callback log not found: ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid callback JSONL line ${index + 1}: ${message}`);
      }
    });
  }
}

function findStageDrops(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStageDrops(item);
      if (found) return found;
    }
  } else if (isRecord(value)) {
    if (value.what === "StageDrops") return value;
    for (const child of Object.values(value)) {
      const found = findStageDrops(child);
      if (found) return found;
    }
  }
  return undefined;
}

function findNumberField(value: unknown, field: string): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumberField(item, field);
      if (found !== undefined) return found;
    }
  } else if (isRecord(value)) {
    const direct = value[field];
    if (typeof direct === "number" && Number.isFinite(direct)) return direct;
    if (typeof direct === "string" && direct.trim() !== "") {
      const parsed = Number(direct);
      if (Number.isFinite(parsed)) return parsed;
    }
    for (const child of Object.values(value)) {
      const found = findNumberField(child, field);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findErrorText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findErrorText(item);
      if (found) return found;
    }
  } else if (isRecord(value)) {
    for (const key of ["msg", "type", "what", "error", "errorType", "error_type", "status"]) {
      const text = value[key];
      if (typeof text === "string" && /error|failed|failure/i.test(text)) return text;
    }
    for (const child of Object.values(value)) {
      const found = findErrorText(child);
      if (found) return found;
    }
  }
  return undefined;
}

export function parseCallbackMessages(messages: unknown[]): CallbackParseResult {
  const stageDrops = findStageDrops(messages);
  if (stageDrops) {
    const stars = findNumberField(stageDrops, "stars");
    if (stars === 3) {
      return { outcome: "clear", stars, message: "Imported MAA callback StageDrops with 3 stars." };
    }
    if (stars !== undefined && stars < 3) {
      return { outcome: "partial_clear", stars, message: `Imported MAA callback StageDrops with ${stars} stars.` };
    }
  }

  const errorText = findErrorText(messages);
  if (errorText) {
    return {
      outcome: "execution_error",
      errorType: errorText,
      message: "Imported MAA callback error; no clear result was inferred.",
    };
  }

  return {
    outcome: "unknown",
    message: "Imported MAA callback log, but no StageDrops or execution error was found.",
  };
}

export function parseCallbackLogFile(filePath: string): CallbackParseResult {
  return parseCallbackMessages(readCallbackLogFile(filePath));
}
