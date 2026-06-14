import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { FastifyInstance } from "fastify";
import { createGuiServer } from "../src/gui/server";

async function makeApp(): Promise<FastifyInstance> {
  return createGuiServer({
    webRoot: path.join(__dirname, "missing-web"),
    openDir: async () => undefined,
  });
}

describe("GUI server routes", () => {
  it("should return health success", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.version).toBe("1.0.0-alpha");
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
    const app = await makeApp();
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
    await app.close();

    const body = JSON.parse(res.body);
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
    expect(body.script.metadata.battlePlan).toBeDefined();
    expect(body.script.metadata.recommendedTasks.length).toBeGreaterThan(0);
    expect(body.script.metadata.operatorSelectionTrace.length).toBeGreaterThan(0);
  });

  it("should generate group-based scripts when squadMode is groups", async () => {
    const app = await makeApp();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-gui-groups-"));
    const outputDir = path.join(tmpRoot, "output");

    const res = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: {
        stage: "GT-1",
        pretty: true,
        outputDir,
        fileName: "groups.json",
        squadMode: "groups",
      },
    });
    await app.close();

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.script.opers).toEqual([]);
    expect(body.script.groups.length).toBeGreaterThan(0);

    const groupNames = new Set(body.script.groups.map((g: { name: string }) => g.name));
    const deployNames = body.script.actions
      .filter((a: { type: string }) => a.type === "Deploy")
      .map((a: { name: string }) => a.name);
    expect(deployNames.length).toBeGreaterThan(0);
    expect(deployNames.every((name: string) => groupNames.has(name))).toBe(true);
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
    expect(configBody.version).toBe("1.0.0-alpha");
    expect(configBody.defaultOutputDir).toBe(path.join(process.cwd(), "output"));
    expect(configBody.defaultCacheDir).toBe(path.join(process.cwd(), "cache"));
    expect(configBody.defaultCacheLevelsDir).toBe(path.join(process.cwd(), "cache", "levels"));
    expect(configBody.defaultLogDir).toBe(path.join(process.cwd(), "logs"));
    expect(configBody.defaultOperatorsPath).toBe(path.join(configCwd, ".maafight", "operators.json"));
    expect(configBody.configuredOperators.count).toBe(1);
    expect(configBody.configuredOperators.operatorsPath).toBe(saveBody.operatorsPath);
  });
});
