import * as fs from "fs";
import * as path from "path";
import type { FastifyInstance } from "fastify";
import {
  analyzeStage,
  DEFAULT_SQUAD_MODE,
  generateStage,
  searchStageSuggestions,
  SUPPORTED_SQUAD_MODES,
  validateScriptJson,
} from "../core/pipeline";
import { openOutputDirectory } from "./openBrowser";
import {
  getDefaultOperatorsPath,
  loadConfiguredOperatorBox,
  loadLastOutputDir,
  saveLastOutputDir,
  saveOperatorConfig,
} from "../player/PlayerConfig";
import { writeGuiLog } from "../runtime/logger";
import { getRuntimePaths } from "../runtime/paths";
import type { AnalyzeRequest, GenerateRequest, OpenOutputDirRequest, SaveOperatorsRequest, ValidateRequest } from "./types";

export interface GuiRouteOptions {
  openDir?: (outputDir: string) => Promise<void>;
  configCwd?: string;
}

function packageVersion(): string {
  const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
  if (!fs.existsSync(pkgPath)) return "unknown";
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
  return pkg.version || "unknown";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(err: unknown, warnings: string[] = []): { success: false; warnings: string[]; errors: string[] } {
  return { success: false, warnings, errors: [errorMessage(err)] };
}

export async function registerGuiRoutes(app: FastifyInstance, options: GuiRouteOptions = {}): Promise<void> {
  const openDir = options.openDir || openOutputDirectory;
  const configCwd = options.configCwd;

  app.get("/api/health", async () => ({
    success: true,
    version: packageVersion(),
  }));

  app.get("/api/config", async () => {
    const runtime = getRuntimePaths();
    const cwd = configCwd || runtime.homeDir;
    const configured = loadConfiguredOperatorBox(cwd);
    const lastOutputDir = loadLastOutputDir(cwd);
    return {
      success: true,
      version: packageVersion(),
      homeDir: runtime.homeDir,
      defaultOutputDir: lastOutputDir || runtime.outputDir,
      defaultCacheDir: runtime.cacheDir,
      defaultCacheLevelsDir: runtime.cacheLevelsDir,
      defaultLogDir: runtime.logDir,
      defaultOperatorsPath: getDefaultOperatorsPath(cwd),
      defaultSquadMode: DEFAULT_SQUAD_MODE,
      supportedSquadModes: SUPPORTED_SQUAD_MODES,
      configuredOperators: configured ? {
        operatorsPath: configured.operatorsPath,
        count: configured.box.size,
      } : null,
    };
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/stages", async request => {
    const query = request.query.q || "";
    const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : undefined;
    return {
      success: true,
      warnings: [],
      errors: [],
      suggestions: searchStageSuggestions(query, limit),
    };
  });

  app.post<{ Body: AnalyzeRequest }>("/api/analyze", async (request, reply) => {
    try {
      const body = request.body || {};
      if (!body.stage?.trim()) {
        reply.code(400);
        return { success: false, warnings: [], errors: ["stage is required"] };
      }
      const result = await analyzeStage({
        stage: body.stage,
        operatorsJson: body.operatorsJson,
        operatorFilePath: body.operatorFilePath,
      }, {
        cacheDir: getRuntimePaths().cacheLevelsDir,
      });
      return { success: true, errors: [], ...result };
    } catch (err) {
      reply.code(400);
      return fail(err);
    }
  });

  app.post<{ Body: GenerateRequest }>("/api/generate", async (request, reply) => {
    const body = request.body || {};
    try {
      if (!body.stage?.trim()) {
        reply.code(400);
        return { success: false, warnings: [], errors: ["stage is required"] };
      }
      const runtime = getRuntimePaths();
      const cwd = configCwd || runtime.homeDir;
      const outputDir = body.outputDir || loadLastOutputDir(cwd) || runtime.outputDir;
      const result = await generateStage({
        stage: body.stage,
        operatorsJson: body.operatorsJson,
        operatorFilePath: body.operatorFilePath,
        squadMode: body.squadMode || DEFAULT_SQUAD_MODE,
        pretty: body.pretty,
        outputDir,
        fileName: body.fileName,
      }, {
        cacheDir: runtime.cacheLevelsDir,
      });
      saveLastOutputDir(result.outputDir, cwd);
      writeGuiLog("generate_success", {
        stage: body.stage,
        squadMode: body.squadMode || DEFAULT_SQUAD_MODE,
        outputPath: result.outputPath,
        warningCount: result.warnings.length + result.validation.warnings.length + result.protocol.warnings.length,
        errorCount: result.validation.errors.length + result.protocol.errors.length,
      });
      return { success: true, errors: [], ...result };
    } catch (err) {
      writeGuiLog("generate_failed", {
        stage: body.stage,
        squadMode: body.squadMode || DEFAULT_SQUAD_MODE,
        errorCount: 1,
        error: errorMessage(err),
      });
      reply.code(400);
      return fail(err);
    }
  });

  app.post<{ Body: ValidateRequest }>("/api/validate", async (request, reply) => {
    try {
      const body = request.body || {};
      if (!body.scriptJson?.trim()) {
        reply.code(400);
        return { success: false, warnings: [], errors: ["scriptJson is required"] };
      }
      const result = validateScriptJson({ scriptJson: body.scriptJson });
      return { success: true, errors: [], ...result };
    } catch (err) {
      reply.code(400);
      return fail(err);
    }
  });

  app.post<{ Body: OpenOutputDirRequest }>("/api/open-output-dir", async (request, reply) => {
    try {
      const body = request.body || {};
      if (!body.outputDir?.trim()) {
        reply.code(400);
        return { success: false, warnings: [], errors: ["outputDir is required"] };
      }
      const outputDir = path.resolve(body.outputDir);
      await openDir(outputDir);
      saveLastOutputDir(outputDir, configCwd || getRuntimePaths().homeDir);
      return { success: true, warnings: [], errors: [], outputDir };
    } catch (err) {
      reply.code(400);
      return fail(err);
    }
  });

  app.post<{ Body: SaveOperatorsRequest }>("/api/operators/save", async (request, reply) => {
    try {
      const body = request.body || {};
      if (!body.operatorsJson?.trim()) {
        reply.code(400);
        return { success: false, warnings: [], errors: ["operatorsJson is required"] };
      }
      const saved = saveOperatorConfig(body.operatorsJson, configCwd || getRuntimePaths().homeDir);
      return {
        success: true,
        warnings: [],
        errors: [],
        operatorsPath: saved.operatorsPath,
        configPath: saved.configPath,
        count: saved.box.size,
      };
    } catch (err) {
      reply.code(400);
      return fail(err);
    }
  });
}
