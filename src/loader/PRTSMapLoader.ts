import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { PRTSLevelData } from "../types";
import { resolveStage } from "./levelIndex";
import { unavailableStageReason } from "./stageMetadata";
import stageIndexData from "../data/stage_index.json";

const GAME_DATA_SOURCE = (stageIndexData as any).source as { repository: string; commit: string };
export const DEFAULT_LEVEL_DATA_URL = `https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/${GAME_DATA_SOURCE.commit}/zh_CN/gamedata`;

export interface EnemyDatabaseEntry {
  name: string;
  description: string;
  prefabKey: string;
  attributes: {
    maxHp: number;
    atk: number;
    def: number;
    magicResistance: number;
    moveSpeed: number;
    attackSpeed: number;
    massLevel: number;
    [key: string]: number;
  };
  enemyTags: string[];
  levelType?: string;
}

interface EnemyDbFile {
  enemies: Array<{
    Key: string;
    Value: Array<{
      level: number;
      enemyData: {
        name: { m_defined: boolean; m_value: string };
        description: { m_defined: boolean; m_value: string };
        prefabKey: { m_defined: boolean; m_value: string };
        attributes: Record<string, { m_defined: boolean; m_value: number }>;
        enemyTags?: { m_defined: boolean; m_value: string[] } | null;
        levelType?: { m_defined: boolean; m_value: string } | null;
      };
    }>;
  }>;
}

export class PRTSMapLoader {
  private enemyDb: Map<string, Map<number, EnemyDatabaseEntry>> | null = null;
  private cacheDir: string;
  private baseUrl: string;
  private pinnedSource: boolean;
  private snapshotCache: boolean;

  constructor(cacheDir?: string, baseUrl?: string) {
    this.cacheDir = cacheDir || path.join(__dirname, "..", "..", "cache", "levels");
    this.baseUrl = (baseUrl || DEFAULT_LEVEL_DATA_URL).replace(/\/$/, "");
    this.pinnedSource = this.baseUrl === DEFAULT_LEVEL_DATA_URL;
    const marker = path.join(this.cacheDir, ".maafight-source.json");
    this.snapshotCache = false;
    if (this.pinnedSource && fs.existsSync(marker)) {
      const source = JSON.parse(fs.readFileSync(marker, "utf8"));
      this.snapshotCache = source.commit === GAME_DATA_SOURCE.commit && source.repository === GAME_DATA_SOURCE.repository;
    }
  }

  async load(stageId: string, options?: { noCache?: boolean }): Promise<PRTSLevelData> {
    const entry = resolveStage(stageId);
    if (!entry) {
      const unavailableReason = unavailableStageReason(stageId);
      if (unavailableReason) throw new Error(unavailableReason);
      throw new Error(
        `Stage "${stageId}" not found in level index.\n` +
        `Try: maafight list --search "${stageId}" to find matching stages`
      );
    }

    const cachePath = this.cachedPath(entry.filePath);

    if (!options?.noCache && fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, "utf-8")) as PRTSLevelData;
    }

    const url = this.levelUrl(entry.filePath);
    const data = await this.httpGet(url);
    const parsed = JSON.parse(data) as PRTSLevelData;

    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cachePath, data, "utf-8");

    return parsed;
  }

  async loadEnemyDatabase(options?: { noCache?: boolean }): Promise<void> {
    const cachePath = this.cachedPath("enemydata/enemy_database.json", true);
    const url = this.levelUrl("enemydata/enemy_database.json");

    let raw: string;
    if (!options?.noCache && fs.existsSync(cachePath)) {
      raw = fs.readFileSync(cachePath, "utf-8");
    } else {
      raw = await this.httpGet(url);
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath, raw, "utf-8");
    }

    const db: EnemyDbFile = JSON.parse(raw);
    this.enemyDb = new Map();

    for (const entry of db.enemies) {
      const key = entry.Key;
      const base = entry.Value.find(value => value.level === 0)?.enemyData;
      if (!base) throw new Error(`Enemy ${key} has no level 0 database entry`);
      const variants = new Map<number, EnemyDatabaseEntry>();
      for (const variant of entry.Value) {
        const ed = variant.enemyData;
        const value = <T>(field: { m_defined: boolean; m_value: T } | null | undefined,
          inherited: { m_defined: boolean; m_value: T } | null | undefined, fallback: T): T =>
          field?.m_defined ? field.m_value : inherited?.m_defined ? inherited.m_value : fallback;
        const attribute = (name: string, fallback = 0): number => value(ed.attributes[name], base.attributes[name], fallback);
        variants.set(variant.level, {
          name: value(ed.name, base.name, key),
          description: value(ed.description, base.description, ""),
          prefabKey: value(ed.prefabKey, base.prefabKey, key),
          attributes: {
            maxHp: attribute("maxHp"), atk: attribute("atk"), def: attribute("def"),
            magicResistance: attribute("magicResistance"), moveSpeed: attribute("moveSpeed", 1),
            attackSpeed: attribute("attackSpeed", 100), massLevel: attribute("massLevel", 1),
          },
          enemyTags: value(ed.enemyTags, base.enemyTags, []),
          levelType: value(ed.levelType, base.levelType, undefined),
        });
      }
      this.enemyDb.set(key, variants);
    }
  }

  getEnemyInfo(enemyId: string, level = 0): EnemyDatabaseEntry | null {
    const variants = this.enemyDb?.get(enemyId);
    if (variants && !variants.has(level)) throw new Error(`Enemy ${enemyId} level ${level} is missing from GameData`);
    return variants?.get(level) || null;
  }

  private levelUrl(filePath: string): string {
    return `${this.baseUrl}/${this.pinnedSource ? "levels" : "data/levels"}/${filePath}`;
  }

  private cachedPath(filePath: string, enemyDatabase = false): string {
    if (!this.pinnedSource) {
      const sourceKey = createHash("sha256").update(this.baseUrl).digest("hex");
      return path.join(this.cacheDir, ".sources", sourceKey, filePath);
    }
    if (!this.snapshotCache) return path.join(this.cacheDir, ".revisions", GAME_DATA_SOURCE.commit, filePath);
    return enemyDatabase ? path.join(this.cacheDir, "..", "enemy_database.json") : path.join(this.cacheDir, filePath);
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https.get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.httpGet(redirectUrl).then(resolve).catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      }).on("error", reject);
    });
  }
}
