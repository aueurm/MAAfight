import type { StageIndexEntry } from "../types";
import levelPaths from "./levelPaths.json";

function parseStageId(filePath: string): string {
  const match = filePath.match(/level_(.+)\.json$/);
  return match ? match[1] : filePath;
}

function inferCategory(filePath: string): string {
  if (filePath.startsWith("obt/main/")) return "main";
  if (filePath.startsWith("obt/hard/")) return "hard";
  if (filePath.startsWith("obt/campaign/")) return "campaign";
  if (filePath.startsWith("obt/weekly/")) return "weekly";
  if (filePath.startsWith("obt/crisis/")) return "crisis";
  if (filePath.startsWith("obt/roguelike/")) return "roguelike";
  if (filePath.startsWith("obt/training/")) return "training";
  if (filePath.startsWith("activities/")) return "activity";
  return "other";
}

function buildIndex(): StageIndexEntry[] {
  return (levelPaths as string[]).map(filePath => ({
    stageId: parseStageId(filePath),
    filePath,
    category: inferCategory(filePath),
  }));
}

const LEVEL_INDEX: StageIndexEntry[] = buildIndex();

export { LEVEL_INDEX };

export function resolveStage(stageId: string): StageIndexEntry | null {
  return LEVEL_INDEX.find(e => e.stageId === stageId) || null;
}

export function searchStages(query: string): StageIndexEntry[] {
  const q = query.toLowerCase();
  return LEVEL_INDEX.filter(
    e => e.stageId.toLowerCase().includes(q) || e.filePath.toLowerCase().includes(q)
  );
}

export function listByCategory(category: string): StageIndexEntry[] {
  return LEVEL_INDEX.filter(e => e.category === category);
}

export function listStages(): StageIndexEntry[] {
  return LEVEL_INDEX;
}
