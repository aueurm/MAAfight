import type { StageIndexEntry } from "../types";
import stageIndexData from "../data/stage_index.json";

interface StageMeta {
  code: string;
  name: string;
  levelId: string;
}

const _byStageId: Record<string, StageMeta> = (stageIndexData as any).byStageId || {};
const _byCode: Record<string, string> = (stageIndexData as any).byCode || {};

export function inferCategory(levelId: string): string {
  if (!levelId) return "other";
  const lower = levelId.toLowerCase();
  if (lower.startsWith("obt/main/") || lower.startsWith("obt-main-")) return "main";
  if (lower.startsWith("obt/hard/") || lower.startsWith("obt-hard-")) return "hard";
  if (lower.startsWith("obt/campaign/") || lower.startsWith("obt-campaign-")) return "campaign";
  if (lower.startsWith("obt/weekly/") || lower.startsWith("obt-weekly-")) return "weekly";
  if (lower.startsWith("obt/crisis/") || lower.startsWith("obt-crisis-")) return "crisis";
  if (lower.startsWith("obt/roguelike/") || lower.startsWith("obt-roguelike-")) return "roguelike";
  if (lower.startsWith("obt/training/") || lower.startsWith("obt-training-")) return "training";
  if (lower.startsWith("obt/memory/") || lower.startsWith("obt-memory-")) return "memory";
  if (lower.startsWith("obt/sandbox/") || lower.startsWith("obt-sandbox-")) return "sandbox";
  if (lower.startsWith("activities/") || lower.startsWith("activities-")) return "activity";
  return "other";
}

function levelIdToPath(levelId: string): string {
  let clean = levelId.replace(/#f#/g, "");
  if (clean.includes("/")) {
    return clean.toLowerCase() + ".json";
  }
  const parts = clean.split("-");
  if (parts.length >= 3) {
    const category = parts[0];
    const activity = parts[1];
    const filename = parts.slice(2).join("-");
    return `${category}/${activity}/${filename}.json`.toLowerCase();
  }
  return clean.toLowerCase() + ".json";
}

function buildEntries(): StageIndexEntry[] {
  const entries: StageIndexEntry[] = [];
  for (const [stageId, meta] of Object.entries(_byStageId)) {
    const cleanStageId = stageId.replace(/#f#/g, "");
    entries.push({
      stageId: cleanStageId,
      filePath: levelIdToPath(meta.levelId || ""),
      category: inferCategory(meta.levelId || ""),
      code: meta.code || undefined,
      name: meta.name || undefined,
      levelId: meta.levelId || undefined,
    });
  }
  return entries;
}

const entries = buildEntries();

export function resolveStage(stageId: string): StageIndexEntry | null {
  const clean = stageId.replace(/#f#/g, "");
  return entries.find(e => e.stageId === clean) || null;
}

export function resolveByCode(code: string): StageIndexEntry | null {
  const stageId = _byCode[code];
  if (!stageId) return null;
  return resolveStage(stageId);
}

export function resolveByFilePath(filePath: string): StageIndexEntry | null {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return entries.find(entry => entry.filePath.replace(/\\/g, "/").toLowerCase() === normalized) || null;
}

export function searchStages(query: string): StageIndexEntry[] {
  const q = query.toLowerCase();
  return entries.filter(
    e =>
      e.stageId.toLowerCase().includes(q) ||
      e.filePath.toLowerCase().includes(q) ||
      (e.code && e.code.toLowerCase().includes(q)) ||
      (e.name && e.name.toLowerCase().includes(q))
  );
}

export function listByCategory(category: string): StageIndexEntry[] {
  return entries.filter(e => e.category === category);
}

export function listStages(): StageIndexEntry[] {
  return entries;
}
