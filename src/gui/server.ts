import * as fs from "fs";
import * as path from "path";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { registerGuiRoutes, type GuiRouteOptions } from "./routes";
import { writeGuiLog } from "../runtime/logger";
import { ensureRuntimeDirectories, getRuntimePaths } from "../runtime/paths";
import { packageVersion } from "../runtime/packageInfo";

export interface GuiServerOptions extends GuiRouteOptions {
  host?: string;
  startPort?: number;
  maxPortAttempts?: number;
  webRoot?: string;
}

export interface StartedGuiServer {
  app: FastifyInstance;
  port: number;
  url: string;
}

function defaultWebRoot(): string {
  return getRuntimePaths().webRoot;
}

function isPortInUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "EADDRINUSE";
}

export async function createGuiServer(options: GuiServerOptions = {}): Promise<FastifyInstance> {
  ensureRuntimeDirectories();
  const app = fastify({ logger: false });
  await registerGuiRoutes(app, options);

  const webRoot = options.webRoot || defaultWebRoot();
  const indexPath = path.join(webRoot, "index.html");
  if (fs.existsSync(indexPath)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((_request, reply) => {
      reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"));
    });
  } else {
    app.get("/", async (_request, reply) => {
      reply.type("text/html").send(
        "<!doctype html><html><body><h1>MAAfight GUI</h1><p>Web assets are missing. Run npm run build:web first.</p></body></html>"
      );
    });
  }

  return app;
}

export async function startGuiServer(options: GuiServerOptions = {}): Promise<StartedGuiServer> {
  const host = options.host || "127.0.0.1";
  const startPort = options.startPort || 14514;
  const maxPortAttempts = options.maxPortAttempts || 10;
  let lastError: unknown;

  for (let offset = 0; offset < maxPortAttempts; offset++) {
    const port = startPort + offset;
    const app = await createGuiServer(options);
    try {
      await app.listen({ host, port });
      const runtime = getRuntimePaths();
      writeGuiLog("gui_started", {
        version: packageVersion(),
        port,
        url: `http://localhost:${port}`,
        homeDir: runtime.homeDir,
        outputDir: runtime.outputDir,
        cacheDir: runtime.cacheDir,
        logDir: runtime.logDir,
      });
      return { app, port, url: `http://localhost:${port}` };
    } catch (err) {
      lastError = err;
      await app.close().catch(() => undefined);
      if (!isPortInUse(err)) throw err;
    }
  }

  throw new Error(`No available GUI port from ${startPort} to ${startPort + maxPortAttempts - 1}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
