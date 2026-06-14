import * as fs from "fs";
import * as path from "path";

export interface RuntimePaths {
  homeDir: string;
  outputDir: string;
  cacheDir: string;
  cacheLevelsDir: string;
  logDir: string;
  webRoot: string;
}

function resolveEnvPath(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? path.resolve(value) : null;
}

function defaultWebRoot(): string {
  if (process.env.MAAFIGHT_WEB_ROOT?.trim()) {
    return path.resolve(process.env.MAAFIGHT_WEB_ROOT);
  }

  if (process.env.MAAFIGHT_HOME?.trim()) {
    return path.resolve(__dirname, "..", "..", "web-dist");
  }

  return path.resolve(__dirname, "..", "..", "web", "dist");
}

export function getRuntimePaths(): RuntimePaths {
  const homeDir = resolveEnvPath("MAAFIGHT_HOME") || process.cwd();
  const cacheDir = resolveEnvPath("MAAFIGHT_CACHE_DIR") || path.join(homeDir, "cache");

  return {
    homeDir,
    outputDir: resolveEnvPath("MAAFIGHT_OUTPUT_DIR") || path.join(homeDir, "output"),
    cacheDir,
    cacheLevelsDir: path.join(cacheDir, "levels"),
    logDir: resolveEnvPath("MAAFIGHT_LOG_DIR") || path.join(homeDir, "logs"),
    webRoot: defaultWebRoot(),
  };
}

export function ensureRuntimeDirectories(paths = getRuntimePaths()): void {
  for (const dir of [paths.outputDir, paths.cacheDir, paths.cacheLevelsDir, paths.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
