import * as path from "path";
import { spawn } from "child_process";
import type { FastifyInstance } from "fastify";
import {
  analyzeStage,
  generateStage,
  searchStageSuggestions,
  validateScriptJson,
} from "../core/pipeline";
import { openOutputDirectory } from "./openBrowser";
import {
  getDefaultOperatorsPath,
  loadConfiguredMaaPath,
  loadConfiguredOperatorBox,
  loadLastOutputDir,
  saveMaaPath,
  saveLastOutputDir,
  saveOperatorConfig,
} from "../player/PlayerConfig";
import { probeMaaEnvironment } from "../runner/probe";
import { observeMaaScreen } from "../runner/screenObserver";
import { writeGuiLog } from "../runtime/logger";
import { getRuntimePaths } from "../runtime/paths";
import { packageVersion } from "../runtime/packageInfo";
import { normalizePracticeTestResult } from "../shared/practiceResult";
import { FeedbackStore, hashOperatorBox } from "../feedback/FeedbackStore";
import type { AnalyzeRequest, EnterPracticeRequest, FeedbackRequest, GenerateRequest, OpenOutputDirRequest, SaveOperatorsRequest, ValidateRequest } from "./types";

export interface GuiRouteOptions {
  openDir?: (outputDir: string) => Promise<void>;
  configCwd?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(err: unknown, warnings: string[] = []): { success: false; warnings: string[]; errors: string[] } {
  return { success: false, warnings, errors: [errorMessage(err)] };
}

function enterPracticeScriptPath(): string {
  return path.resolve(__dirname, "..", "..", "scripts", "enter-practice.ps1");
}

function runEnterPracticeScript(stage: string, maaDir?: string, scriptPath?: string): Promise<unknown> {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    enterPracticeScriptPath(),
    "-Stage",
    stage,
  ];
  if (maaDir) args.push("-MaaDir", maaDir);
  if (scriptPath) args.push("-ScriptPath", scriptPath);

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, {
      cwd: path.resolve(__dirname, "..", ".."),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("enter practice timed out after 900 seconds")));
    }, 900_000);

    function finish(done: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
    }

    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", err => finish(() => reject(err)));
    child.on("close", code => finish(() => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `enter practice exited with code ${code}`).trim()));
        return;
      }

      const jsonLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!jsonLine) {
        reject(new Error("enter practice returned empty output"));
        return;
      }
      try {
        resolve(JSON.parse(jsonLine));
      } catch (err) {
        reject(new Error(`enter practice returned invalid JSON: ${errorMessage(err)}`));
      }
    }));
  });
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
    const savedMaaPath = loadConfiguredMaaPath(cwd);
    const maaProbe = probeMaaEnvironment({ maaPath: savedMaaPath || undefined });
    return {
      success: true,
      version: packageVersion(),
      homeDir: runtime.homeDir,
      defaultOutputDir: lastOutputDir || runtime.outputDir,
      defaultCacheDir: runtime.cacheDir,
      defaultCacheLevelsDir: runtime.cacheLevelsDir,
      defaultLogDir: runtime.logDir,
      defaultOperatorsPath: getDefaultOperatorsPath(cwd),
      savedMaaPath,
      detectedMaaPath: maaProbe.maaInstallDir || maaProbe.maaPath,
      engine: "v2",
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
        pretty: body.pretty,
        outputDir,
        fileName: body.fileName,
        newCandidate: body.newCandidate,
        requirementsMode: body.requirementsMode,
      }, {
        cacheDir: runtime.cacheLevelsDir,
        stateDir: cwd,
      });
      saveLastOutputDir(result.outputDir, cwd);
      writeGuiLog("generate_success", {
        stage: body.stage,
        engine: "v2",
        outputPath: result.outputPath,
        warningCount: result.warnings.length + result.validation.warnings.length + result.protocol.warnings.length,
        errorCount: result.validation.errors.length + result.protocol.errors.length,
      });
      return { success: true, errors: [], ...result };
    } catch (err) {
      writeGuiLog("generate_failed", {
        stage: body.stage,
        engine: "v2",
        errorCount: 1,
        error: errorMessage(err),
      });
      reply.code(400);
      return fail(err);
    }
  });

  app.post<{ Body: EnterPracticeRequest }>("/api/enter-practice", async (request, reply) => {
    const body = request.body || {};
    try {
      if (!body.stage?.trim()) {
        reply.code(400);
        return { success: false, warnings: [], errors: ["stage is required"] };
      }

      const cwd = configCwd || getRuntimePaths().homeDir;
      const inputMaaPath = body.maaPath?.trim();
      if (inputMaaPath) saveMaaPath(inputMaaPath, cwd);
      const configuredMaaPath = inputMaaPath || loadConfiguredMaaPath(cwd) || undefined;
      const maaProbe = configuredMaaPath ? probeMaaEnvironment({ maaPath: configuredMaaPath }) : null;
      if (configuredMaaPath && !maaProbe?.maaInstallDir) {
        reply.code(400);
        return { success: false, warnings: maaProbe?.warnings || [], errors: ["未找到 MAA，请填写 MAA 目录、MAA.exe 或 MaaCore.dll 路径"] };
      }

      const warnings: string[] = [];
      const scriptPath = body.scriptPath?.trim();
      if (scriptPath && !path.isAbsolute(scriptPath)) {
        reply.code(400);
        return { success: false, warnings, errors: ["scriptPath must be absolute"] };
      }

      const scriptResult = await runEnterPracticeScript(body.stage.trim(), maaProbe?.maaInstallDir || undefined, scriptPath || undefined);
      const result = scriptResult && typeof scriptResult === "object" ? scriptResult as Record<string, unknown> : {};
      if (result.copilotTaskId) {
        const observedMaaPath = typeof result.maaDir === "string" ? result.maaDir : maaProbe?.maaInstallDir || undefined;
        const observed = observeMaaScreen({
          maaPath: observedMaaPath,
          debugDir: path.join(cwd, ".maafight", "screen-observer", `gui-${Date.now()}`),
        });
        result.outcome = observed.outcome;
        result.stars = observed.stars;
        result.debugScreenshotPath = observed.debugScreenshotPath;
        warnings.push(...observed.warnings);
      }
      const testResult = normalizePracticeTestResult(result);
      if (testResult) result.testResult = testResult;
      if (body.scriptHash?.trim() && testResult) {
        try {
          const configured = loadConfiguredOperatorBox(cwd);
          const feedbackRecord = new FeedbackStore(cwd).recordPracticeTestResult({
            scriptHash: body.scriptHash.trim(),
            testResult,
            currentOperatorBoxHash: hashOperatorBox(configured?.box.playerMap),
          });
          if (feedbackRecord) {
            result.feedbackRecord = {
              ratio: feedbackRecord.ratio,
              usableForLearning: feedbackRecord.usableForLearning,
              operatorBoxChanged: feedbackRecord.operatorBoxChanged,
            };
          }
        } catch (err) {
          warnings.push(`测试结果未写入训练材料：${errorMessage(err)}`);
        }
      }
      writeGuiLog("enter_practice_success", {
        stage: body.stage.trim(),
        maaPath: maaProbe?.maaInstallDir,
      });
      return { success: true, warnings, errors: [], result };
    } catch (err) {
      writeGuiLog("enter_practice_failed", {
        stage: body.stage,
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

  app.post<{ Body: FeedbackRequest }>("/api/feedback", async (request, reply) => {
    try {
      const body = request.body || {};
      if (!body.scriptHash?.trim()) {
        reply.code(400);
        return { success: false, warnings: [], errors: ["scriptHash is required"] };
      }
      const cwd = configCwd || getRuntimePaths().homeDir;
      const configured = loadConfiguredOperatorBox(cwd);
      const record = new FeedbackStore(cwd).recordFeedback({
        scriptHash: body.scriptHash,
        killed: body.killed as number,
        total: body.total,
        notes: body.notes,
        currentOperatorBoxHash: hashOperatorBox(configured?.box.playerMap),
      });
      return { success: true, warnings: [], errors: [], record };
    } catch (err) {
      reply.code(400);
      return fail(err);
    }
  });

  app.get<{ Querystring: { stage?: string } }>("/api/feedback/summary", async request => {
    const cwd = configCwd || getRuntimePaths().homeDir;
    return {
      success: true,
      warnings: [],
      errors: [],
      summary: new FeedbackStore(cwd).summary(request.query.stage),
    };
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
