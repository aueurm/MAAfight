import type { StageIndexEntry } from "../types";
import levelPaths from "./levelPaths.json";
import {
  resolveByCode,
  resolveByFilePath,
  searchStages as stageSearch,
  getAllCodes,
  resolveStage as stageResolve,
} from "./stageIndex";

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
  return (levelPaths as string[]).map(filePath => {
    const stageId = parseStageId(filePath);
    const meta = stageResolve(stageId) || resolveByFilePath(filePath);
    return {
      stageId,
      filePath,
      category: inferCategory(filePath),
      code: meta?.code,
      name: meta?.name,
      levelId: meta?.levelId,
    };
  });
}

const LEVEL_INDEX: StageIndexEntry[] = buildIndex();

export { LEVEL_INDEX };

export function resolveStage(id: string): StageIndexEntry | null {
  const direct = LEVEL_INDEX.find(e => e.stageId === id);

  if (direct) {
    if (direct.code) return direct;
    const enriched = stageResolve(id) || resolveByFilePath(direct.filePath);
    if (enriched) {
      return {
        ...direct,
        code: enriched.code,
        name: enriched.name,
        levelId: enriched.levelId,
      };
    }
    return direct;
  }

  const byCode = resolveByCode(id);
  if (byCode) return byCode;

  const byStageId = stageResolve(id);
  if (byStageId) return byStageId;

  return null;
}

export function searchStages(query: string): StageIndexEntry[] {
  const q = query.toLowerCase();
  const fromLevel = LEVEL_INDEX.filter(
    e => e.stageId.toLowerCase().includes(q) || e.filePath.toLowerCase().includes(q)
  );
  const fromStage = stageSearch(q);

  const seen = new Set<string>();
  const merged: StageIndexEntry[] = [];
  for (const e of [...fromLevel, ...fromStage]) {
    if (!seen.has(e.stageId)) {
      seen.add(e.stageId);
      merged.push(e);
    }
  }
  return merged;
}

export function listByCategory(category: string): StageIndexEntry[] {
  const fromLevel = LEVEL_INDEX.filter(e => e.category === category);
  const fromStage = stageSearch("").filter(e => e.category === category);

  const seen = new Set<string>(fromLevel.map(e => e.stageId));
  const merged = [...fromLevel];
  for (const e of fromStage) {
    if (!seen.has(e.stageId)) {
      seen.add(e.stageId);
      merged.push(e);
    }
  }
  return merged;
}

export function listStages(): StageIndexEntry[] {
  return LEVEL_INDEX;
}
