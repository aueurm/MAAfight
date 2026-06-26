import * as path from "path";
import type { StageIndexEntry } from "../types";

export function inferStageIdFromDataPath(dataPath: string): string {
  return path.basename(dataPath, ".json").replace(/^level_/, "");
}

export function getDisplayStageName(stageId: string, resolved: StageIndexEntry | null): string {
  return resolved?.code || resolved?.name || stageId;
}
