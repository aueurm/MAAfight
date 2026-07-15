import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { FastifyInstance } from "fastify";
import { listCombatOperators } from "../src/engine/CombatModel";
import { publishThreeStarCandidate } from "../src/gui/routes";
import { createGuiServer } from "../src/gui/server";

jest.setTimeout(60000);

async function makeApp(options: { configCwd?: string } = {}): Promise<FastifyInstance> {
  const configCwd = options.configCwd || fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-config-"));
  return createGuiServer({
    webRoot: path.join(__dirname, "missing-web"),
    openDir: async () => undefined,
    configCwd,
  });
}

function deepSeekOwnedOperators(): Array<Record<string, unknown>> {
  return listCombatOperators()
    .filter(operator => operator.skills[0]?.unlockPhase <= 2)
    .slice(0, 12)
    .map((operator, index) => ({ id: `owned-${index}`, name: operator.name, rarity: 6, own: true, elite: 2, level: 90, potential: 1 }));
}

function deepSeekCandidate(context: any) {
  const selected = new Set<string>();
  const lines = context.roster.slice(0, 12).map((operator: { name: string }) => `operator(${operator.name}, 1, 1)`);
  for (const front of context.stage.blueGateFronts.flatMap((gate: { blockingPoints: Array<{ x: number; y: number; direction: string }> }) => gate.blockingPoints)) {
    const operator = context.roster.find((item: { name: string; position: string }) => !selected.has(item.name) && item.position === "MELEE");
    if (!operator) continue;
    selected.add(operator.name);
    lines.push(`deploy(${operator.name}, ${front.x}, ${front.y}, ${front.direction})`);
  }
  lines.push("skillDaemon()");
  return {
    battleDsl: lines.join("\n"),
  };
}

describe("GUI server routes", () => {
  it("should return health success", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.version).toBe("2.0.0-alpha.0");
  });

  it("should serve built web assets instead of SPA fallback html", async () => {
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-web-root-"));
    const assetsDir = path.join(webRoot, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf-8");
    fs.writeFileSync(path.join(assetsDir, "app.js"), "console.log('asset');", "utf-8");

    const app = await createGuiServer({ webRoot });
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("console.log('asset');");
    expect(res.headers["content-type"]).toContain("javascript");
  });

  it("should expose MAAFIGHT_HOME runtime directories", async () => {
    const oldHome = process.env.MAAFIGHT_HOME;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-home-"));
    process.env.MAAFIGHT_HOME = homeDir;

    const app = await createGuiServer({ webRoot: path.join(__dirname, "missing-web") });
    const res = await app.inject({ method: "GET", url: "/api/config" });
    await app.close();

    if (oldHome === undefined) {
      delete process.env.MAAFIGHT_HOME;
    } else {
      process.env.MAAFIGHT_HOME = oldHome;
    }

    const body = JSON.parse(res.body);
    expect(body.homeDir).toBe(homeDir);
    expect(body.defaultOutputDir).toBe(path.join(homeDir, "output"));
    expect(body.defaultCacheDir).toBe(path.join(homeDir, "cache"));
    expect(body.defaultCacheLevelsDir).toBe(path.join(homeDir, "cache", "levels"));
    expect(body.defaultLogDir).toBe(path.join(homeDir, "logs"));
    expect(body.engine).toBe("v2");
    expect(body.defaultSquadMode).toBeUndefined();
    expect(body.supportedGenerators).toBeUndefined();
    expect(fs.existsSync(path.join(homeDir, "output"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, "cache"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, "logs"))).toBe(true);
  });

  it("should return stage suggestions with series and number", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/stages?q=GT&limit=5" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions[0].series).toBeTruthy();
    expect(body.suggestions[0].number).toBeTruthy();
  });

  it("should not repeat the same stage code in suggestions", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/stages?q=11-&limit=8" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const codes = body.suggestions.map((suggestion: { code?: string; stageId: string }) => suggestion.code || suggestion.stageId);
    expect(codes).toEqual([...new Set(codes)]);
  });

  it("should suggest normal main stage for duplicate main codes", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/stages?q=11-7&limit=5" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.suggestions[0]).toMatchObject({
      code: "11-7",
      stageId: "main_11-06",
      filePath: "obt/main/level_main_11-06.json",
    });
  });

  it("should return success false when generate misses stage", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: {},
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errors).toContain("stage is required");
  });

  it("should create outputDir when generating a script", async () => {
    const configCwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-config-"));
    const app = await makeApp({ configCwd });
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-"));
    const outputDir = path.join(tmpRoot, "nested", "output");
    const fileName = "gui-test.json";

    const res = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: {
        stage: "GT-1",
        pretty: true,
        outputDir,
        fileName,
      },
    });
    const configRes = await app.inject({ method: "GET", url: "/api/config" });
    await app.close();

    const body = JSON.parse(res.body);
    const configBody = JSON.parse(configRes.body);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.outputPath).toBe(path.join(outputDir, fileName));
    expect(fs.existsSync(body.outputPath)).toBe(true);

    const generated = JSON.parse(fs.readFileSync(body.outputPath, "utf-8"));
    expect(generated.version).toBe(3);
    expect(generated.stage_name).toBe("GT-1");
    expect(Array.isArray(generated.opers)).toBe(true);
    expect(Array.isArray(generated.groups)).toBe(true);
    expect(Array.isArray(generated.actions)).toBe(true);
    expect(body.script.groups).toEqual([]);
    expect(body.script.metadata.source).toBe("maafight-v2-skill-model");
    expect(body.script.metadata.candidateScore).toBeGreaterThan(0);
    expect(body.script.metadata.skillCoverage).toBeGreaterThan(0);
    expect(body.analysis.pressureWindows.length).toBeGreaterThan(0);
    expect(body.scriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.modelVersion).toMatch(/^corpus-prior-v1-/);
    expect(generated.opers.every((operator: { requirements?: unknown }) => operator.requirements === undefined)).toBe(true);
    expect(generated.actions.some((action: { type: string }) => action.type === "Wait")).toBe(false);
    expect(configBody.defaultOutputDir).toBe(outputDir);
  });

  it("should generate a DeepSeek candidate without publishing it", async () => {
    const configCwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-deepseek-config-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-deepseek-output-"));
    const app = await makeApp({ configCwd });
    const operators = deepSeekOwnedOperators();
    const oldKey = process.env.DEEPSEEK_API_KEY;
    const oldFetch = global.fetch;
    process.env.DEEPSEEK_API_KEY = "test-key";
    global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const payload = JSON.parse(body.messages[1].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(deepSeekCandidate(payload.context)) } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/generate",
        payload: { stage: "GT-1", core: "deepseek-core", operatorsJson: JSON.stringify(operators), outputDir, fileName: "deepseek.json" },
      });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.requestedCore).toBe("deepseek-core");
      expect(body.validation.valid).toBe(true);
      expect(body.protocol.valid).toBe(true);
      expect(fs.existsSync(body.outputPath)).toBe(true);
      expect(body.outputPath).toBe(path.join(outputDir, ".candidates", "deepseek.json"));
      expect(fs.existsSync(path.join(outputDir, "deepseek.json"))).toBe(false);
      expect(body.script.opers).toHaveLength(12);
      expect(body.publicationStatus).toBe("candidate");
    } finally {
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldKey;
      global.fetch = oldFetch;
      await app.close();
    }
  });

  it("should only promote an internal DeepSeek candidate after a three-star result", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-deepseek-publish-"));
    const candidateDir = path.join(outputDir, ".candidates");
    const candidatePath = path.join(candidateDir, "candidate.json");
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(candidatePath, JSON.stringify({
      doc: { title: "candidate", details: "Internal candidate; not rehearsal-verified." },
      metadata: { source: "maafight-deepseek-core" },
    }), "utf8");

    expect(publishThreeStarCandidate(candidatePath)).toBe(path.join(outputDir, "candidate.json"));
    expect(fs.existsSync(path.join(outputDir, "candidate.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "candidate.json"), "utf8")).doc.details).toBe("Three-star rehearsal verified.");
    expect(publishThreeStarCandidate(path.join(outputDir, "candidate.json"))).toBeUndefined();
  });

  it("should record and summarize battle feedback", async () => {
    const configCwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-feedback-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-feedback-output-"));
    const app = await makeApp({ configCwd });
    const generateRes = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: { stage: "GT-1", outputDir, fileName: "feedback.json" },
    });
    const generated = JSON.parse(generateRes.body);
    const feedbackRes = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { scriptHash: generated.scriptHash, killed: 42, total: 42 },
    });
    const summaryRes = await app.inject({ method: "GET", url: `/api/feedback/summary?stage=${generated.stageId}` });
    await app.close();

    expect(feedbackRes.statusCode).toBe(200);
    expect(JSON.parse(feedbackRes.body).record.ratio).toBe(1);
    expect(JSON.parse(summaryRes.body).summary).toMatchObject({ count: 1, usableCount: 1, fullClearCount: 1 });
  });

  it("should return error for invalid output directory without crashing", async () => {
    const app = await createGuiServer({ webRoot: path.join(__dirname, "missing-web") });
    const missingDir = path.join(os.tmpdir(), "maafight-missing-dir", String(Date.now()));
    const res = await app.inject({
      method: "POST",
      url: "/api/open-output-dir",
      payload: { outputDir: missingDir },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errors[0]).toContain("Output directory does not exist");
  });

  it("should remember the last opened output directory", async () => {
    const configCwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-config-"));
    const opened: string[] = [];
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-open-output-"));
    const app = await createGuiServer({
      webRoot: path.join(__dirname, "missing-web"),
      configCwd,
      openDir: async dir => {
        opened.push(dir);
      },
    });

    const openRes = await app.inject({
      method: "POST",
      url: "/api/open-output-dir",
      payload: { outputDir },
    });
    const configRes = await app.inject({ method: "GET", url: "/api/config" });
    await app.close();

    const openBody = JSON.parse(openRes.body);
    const configBody = JSON.parse(configRes.body);
    expect(openRes.statusCode).toBe(200);
    expect(openBody.success).toBe(true);
    expect(opened).toEqual([outputDir]);
    expect(configBody.defaultOutputDir).toBe(outputDir);
  });

  it("should save pasted operators and expose configured status", async () => {
    const configCwd = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-config-"));
    const app = await createGuiServer({
      webRoot: path.join(__dirname, "missing-web"),
      configCwd,
    });

    const saveRes = await app.inject({
      method: "POST",
      url: "/api/operators/save",
      payload: {
        operatorsJson: JSON.stringify([
          { id: "char_112_siege", name: "推进之王", rarity: 6, own: true, elite: 2, level: 80, potential: 2 },
          { id: "char_unowned", name: "未拥有", rarity: 6, own: false },
        ]),
      },
    });
    const configRes = await app.inject({ method: "GET", url: "/api/config" });
    await app.close();

    const saveBody = JSON.parse(saveRes.body);
    const configBody = JSON.parse(configRes.body);
    expect(saveRes.statusCode).toBe(200);
    expect(saveBody.success).toBe(true);
    expect(saveBody.count).toBe(1);
    expect(fs.existsSync(saveBody.operatorsPath)).toBe(true);
    expect(configBody.version).toBe("2.0.0-alpha.0");
    expect(configBody.defaultOutputDir).toBe(path.join(process.cwd(), "output"));
    expect(configBody.defaultCacheDir).toBe(path.join(process.cwd(), "cache"));
    expect(configBody.defaultCacheLevelsDir).toBe(path.join(process.cwd(), "cache", "levels"));
    expect(configBody.defaultLogDir).toBe(path.join(process.cwd(), "logs"));
    expect(configBody.defaultOperatorsPath).toBe(path.join(configCwd, ".maafight", "operators.json"));
    expect(configBody.configuredOperators.count).toBe(1);
    expect(configBody.configuredOperators.operatorsPath).toBe(saveBody.operatorsPath);
  });
});
