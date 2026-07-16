import * as fs from "fs";
import * as path from "path";

export interface JsonLinesResult<T> {
  records: T[];
  warnings: string[];
}

export function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonLines<T>(filePath: string): JsonLinesResult<T> {
  if (!fs.existsSync(filePath)) return { records: [], warnings: [] };
  const records: T[] = [];
  const warnings: string[] = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      warnings.push(`Skipped invalid JSONL line ${index + 1} in ${path.basename(filePath)}.`);
    }
  }
  return { records, warnings };
}
