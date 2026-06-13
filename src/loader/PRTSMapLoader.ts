import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import type { PRTSLevelData } from "../types";
import { resolveStage } from "./levelIndex";

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
      };
    }>;
  }>;
}

export class PRTSMapLoader {
  private enemyDb: Map<string, EnemyDatabaseEntry> | null = null;
  private cacheDir: string;
  private baseUrl: string;

  constructor(cacheDir?: string, baseUrl?: string) {
    this.cacheDir = cacheDir || path.join(__dirname, "..", "..", "cache", "levels");
    this.baseUrl = baseUrl || "https://map.ark-nights.com";
  }

  async load(stageId: string, options?: { noCache?: boolean }): Promise<PRTSLevelData> {
    const entry = resolveStage(stageId);
    if (!entry) {
      throw new Error(
        `Stage "${stageId}" not found in level index.\n` +
        `Try: maafight list --search "${stageId}" to find matching stages`
      );
    }

    const cachePath = path.join(this.cacheDir, entry.filePath);

    if (!options?.noCache && fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, "utf-8")) as PRTSLevelData;
    }

    const url = `${this.baseUrl}/data/levels/${entry.filePath}`;
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
    const cachePath = path.join(this.cacheDir, "..", "enemy_database.json");
    const url = `${this.baseUrl}/data/levels/enemydata/enemy_database.json`;

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
      const firstLevel = entry.Value[0];
      if (!firstLevel) continue;

      const ed = firstLevel.enemyData;
      const attrs = ed.attributes;
      this.enemyDb.set(key, {
        name: ed.name.m_defined ? ed.name.m_value : key,
        description: ed.description.m_defined ? ed.description.m_value : "",
        prefabKey: ed.prefabKey.m_defined ? ed.prefabKey.m_value : key,
        attributes: {
          maxHp: attrs.maxHp?.m_defined ? attrs.maxHp.m_value : 0,
          atk: attrs.atk?.m_defined ? attrs.atk.m_value : 0,
          def: attrs.def?.m_defined ? attrs.def.m_value : 0,
          magicResistance: attrs.magicResistance?.m_defined ? attrs.magicResistance.m_value : 0,
          moveSpeed: attrs.moveSpeed?.m_defined ? attrs.moveSpeed.m_value : 1,
          attackSpeed: attrs.attackSpeed?.m_defined ? attrs.attackSpeed.m_value : 100,
          massLevel: attrs.massLevel?.m_defined ? attrs.massLevel.m_value : 1,
        },
        enemyTags: ed.enemyTags?.m_defined ? ed.enemyTags.m_value : [],
      });
    }
  }

  getEnemyInfo(enemyId: string): EnemyDatabaseEntry | null {
    return this.enemyDb?.get(enemyId) || null;
  }

  getEnemyDatabase(): Map<string, EnemyDatabaseEntry> | null {
    return this.enemyDb;
  }

  ensureEnemyDbLoaded(): boolean {
    return this.enemyDb !== null;
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
