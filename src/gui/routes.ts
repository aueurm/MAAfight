import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { execFile, spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
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
import { FeedbackStore, hashOperatorBox, hashScriptJson } from "../feedback/FeedbackStore";
import { resolveStage } from "../loader/levelIndex";
import type { EmulatorStartupStatus } from "../shared/emulatorStartup";
import type { AnalyzeRequest, EnterPracticeRequest, FeedbackRequest, GenerateRequest, OpenOutputDirRequest, SaveOperatorsRequest, ValidateRequest } from "./types";

export interface GuiRouteOptions {
  openDir?: (outputDir: string) => Promise<void>;
  configCwd?: string;
  emulatorStatus?: () => EmulatorStartupStatus;
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

const EMULATOR_STARTUP_WAIT_MS = 195_000;
// StartUp (300 s), navigation (300 s), Copilot (600 s), and connection/exit overhead.
const PRACTICE_HELPER_TIMEOUT_MS = (300 + 300 + 600 + 60) * 1_000;
const PROCESS_TREE_STOP_TIMEOUT_MS = 10_000;

async function waitForEmulatorStartup(getStatus?: () => EmulatorStartupStatus): Promise<void> {
  let status = getStatus?.();
  // A previous failure may already have been resolved by starting MuMu manually.
  if (status?.state !== "starting") return;
  const deadline = Date.now() + EMULATOR_STARTUP_WAIT_MS;
  while (status?.state === "starting") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("等待 MuMu 启动超时（195 秒），请处理模拟器窗口中的提示后重试演习。");
    await new Promise(resolve => setTimeout(resolve, Math.min(500, remaining)));
    status = getStatus?.();
  }
  if (status?.state === "failed") {
    throw new Error(`MuMu 启动未完成：${status.message || "未确认 Android 和 ADB 就绪，请检查模拟器窗口后重试。"}`);
  }
}

function stopPracticeProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: PROCESS_TREE_STOP_TIMEOUT_MS,
    }, error => {
      if (error) {
        child.kill();
        reject(new Error("未能确认演习子进程已全部停止，请先检查进程和游戏画面再重试。"));
      } else resolve();
    });
  });
}

function runEnterPracticeScript(stage: string, maaDir?: string, scriptPath?: string, difficulty?: "Normal" | "Hard"): Promise<unknown> {
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
  if (difficulty) args.push("-Difficulty", difficulty);

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, {
      cwd: path.resolve(__dirname, "..", ".."),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    const timer = setTimeout(() => finish(() => {
      void stopPracticeProcessTree(child).then(
        () => reject(new Error("进入演习超时（21 分钟，含唤醒、导航和战斗），已停止本次演习进程，请检查游戏当前画面后重试。")),
        error => reject(new Error(`进入演习超时（21 分钟，含唤醒、导航和战斗）。${errorMessage(error)}`)),
      );
    }), PRACTICE_HELPER_TIMEOUT_MS);

    function finish(done: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
    }

    child.stdout.on("data", chunk => {
      stdout += stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", chunk => {
      stderr += stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", err => finish(() => reject(err)));
    child.on("close", code => finish(() => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      const jsonLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      let result: { ok?: boolean; error?: string } | undefined;
      try { result = jsonLine ? JSON.parse(jsonLine) : undefined; } catch { /* Report malformed output below. */ }
      if (code !== 0) {
        const diagnostic = result?.error || (stderr || stdout).trim().split(/\r?\n/)[0] || `进程退出码 ${code}`;
        reject(new Error(`进入演习失败：${diagnostic}`));
        return;
      }

      if (!jsonLine) {
        reject(new Error("演习入口没有返回执行结果。"));
        return;
      }
      if (!result || typeof result !== "object") reject(new Error("演习入口返回了无法读取的结果。"));
      else if (result.ok === false) reject(new Error(`进入演习失败：${result.error || "请检查游戏当前画面。"}`));
      else resolve(result);
    }));
  });
}

interface PracticeScriptSnapshot {
  originalPath: string;
  runPath: string;
  json: string;
  contentHash: string;
  scriptHash: string;
  stageName: string;
}

function preparePracticeScript(scriptPath: string, stage: string, cwd: string, expectedHash?: string): PracticeScriptSnapshot {
  const originalPath = path.resolve(scriptPath);
  const json = fs.readFileSync(originalPath, "utf8");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || typeof parsed.stage_name !== "string" || !Array.isArray(parsed.actions)) {
    throw new Error("scriptPath must contain a copilot JSON object with stage_name and actions");
  }
  const requestedStage = resolveStage(stage)?.code || stage;
  if (parsed.stage_name.trim().toUpperCase() !== requestedStage.trim().toUpperCase()) {
    throw new Error(`Script stage ${parsed.stage_name} does not match requested stage ${stage}`);
  }
  // This is already exported MAA JSON: hash it without metadata, without swapping coordinates again.
  const { metadata: _metadata, ...strategy } = parsed;
  const scriptHash = hashScriptJson(JSON.stringify(strategy));
  if (expectedHash && expectedHash !== scriptHash) {
    throw new Error("scriptHash does not match the script file; regenerate or reload the candidate before rehearsal");
  }
  const runDir = path.join(cwd, ".maafight", "copilot-run");
  fs.mkdirSync(runDir, { recursive: true });
  const runPath = path.join(runDir, `${randomUUID()}.json`);
  fs.writeFileSync(runPath, json, { encoding: "utf8", flag: "wx" });
  return { originalPath, runPath, json, contentHash: hashScriptJson(json), scriptHash, stageName: parsed.stage_name.trim() };
}

export function publishThreeStarCandidate(scriptPath: string, expectedJson: string): string | undefined {
  const candidatePath = path.resolve(scriptPath);
  const candidateDir = path.dirname(candidatePath);
  if (path.basename(candidateDir) !== ".candidates") return undefined;
  if (hashScriptJson(fs.readFileSync(candidatePath, "utf8")) !== hashScriptJson(expectedJson)) {
    throw new Error("Candidate changed during rehearsal; publication was refused");
  }
  const candidate = JSON.parse(expectedJson) as {
    doc?: { details?: unknown };
    metadata?: { source?: unknown };
  };
  if (candidate.metadata?.source !== "maafight-deepseek-core") return undefined;
  const outputPath = path.join(path.dirname(candidateDir), path.basename(candidatePath));
  if (candidate.doc) candidate.doc.details = "Three-star rehearsal verified.";
  fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  return outputPath;
}

export async function registerGuiRoutes(app: FastifyInstance, options: GuiRouteOptions = {}): Promise<void> {
  const openDir = options.openDir || openOutputDirectory;
  const configCwd = options.configCwd;

  app.get("/api/emulator-status", async () => ({
    success: true,
    ...(options.emulatorStatus?.() || { state: "skipped" }),
  }));

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
        core: body.core,
      }, {
        cacheDir: runtime.cacheLevelsDir,
        stateDir: cwd,
      });
      saveLastOutputDir(result.outputDir, cwd);
      writeGuiLog("generate_success", {
        stage: body.stage,
        engine: body.core || "rule-core",
        outputPath: result.outputPath,
        warningCount: result.warnings.length + result.validation.warnings.length + result.protocol.warnings.length,
        errorCount: result.validation.errors.length + result.protocol.errors.length,
      });
      return { success: true, errors: [], ...result };
    } catch (err) {
      writeGuiLog("generate_failed", {
        stage: body.stage,
        engine: body.core || "rule-core",
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

      const requestedHash = body.scriptHash?.trim();
      if (requestedHash && !scriptPath) throw new Error("scriptPath is required to verify scriptHash");
      const snapshot = scriptPath ? preparePracticeScript(scriptPath, body.stage.trim(), cwd, requestedHash) : undefined;
      const requestedStage = resolveStage(body.stage.trim());
      const navigationStage = snapshot?.stageName || requestedStage?.code || body.stage.trim();
      const chapter = /^(H?)(\d+)-\d+$/i.exec(navigationStage);
      const difficulty = requestedStage?.stageId.startsWith("tough_") ? "Hard"
        : chapter && Number(chapter[2]) >= 10 ? (chapter[1] ? "Hard" : "Normal") : undefined;
      await waitForEmulatorStartup(options.emulatorStatus);
      const scriptResult = await runEnterPracticeScript(navigationStage, maaProbe?.maaInstallDir || undefined, snapshot?.runPath, difficulty);
      const result = scriptResult && typeof scriptResult === "object" ? scriptResult as Record<string, unknown> : {};
      if (snapshot) {
        if (hashScriptJson(fs.readFileSync(snapshot.runPath, "utf8")) !== snapshot.contentHash) {
          throw new Error("Rehearsal snapshot changed; publication and feedback were refused");
        }
        result.originalScriptPath = snapshot.originalPath;
        result.scriptHash = snapshot.scriptHash;
      }
      if (result.navigationSkipped && result.stageVerified !== true) {
        warnings.push("已从当前关卡详情页进入演习；请确认游戏关卡与所选关卡一致。");
      }
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
      if (testResult === "三星" && snapshot) {
        try {
          const publishedOutputPath = publishThreeStarCandidate(snapshot.originalPath, snapshot.json);
          if (publishedOutputPath) {
            result.publishedOutputPath = publishedOutputPath;
            warnings.push(`DeepSeek candidate published after three-star rehearsal: ${publishedOutputPath}`);
          }
        } catch (err) {
          warnings.push(`三星结果属于运行时固定副本，候选未发布：${errorMessage(err)}`);
        }
      }
      if (snapshot && testResult) {
        try {
          const configured = loadConfiguredOperatorBox(cwd);
          const feedbackRecord = new FeedbackStore(cwd).recordPracticeTestResult({
            scriptHash: snapshot.scriptHash,
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
