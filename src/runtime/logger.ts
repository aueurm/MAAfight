import * as fs from "fs";
import * as path from "path";
import { ensureRuntimeDirectories, getRuntimePaths } from "./paths";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function cleanFields(fields: LogFields): LogFields {
  const result: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function writeGuiLog(event: string, fields: LogFields = {}): void {
  try {
    const paths = getRuntimePaths();
    ensureRuntimeDirectories(paths);
    const line = JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...cleanFields(fields),
    });
    fs.appendFileSync(path.join(paths.logDir, "gui.log"), `${line}\n`, "utf-8");
  } catch {
    // Logging must never break GUI startup or script generation.
  }
}
