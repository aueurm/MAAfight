#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const root = path.resolve(__dirname, "..");

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] || 0;
}

function summarize(values) {
  return {
    samples: values.length,
    p50Ms: Number(percentile(values, 0.50).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
  };
}

async function main() {
  const operatorArg = process.argv.indexOf("--operators");
  const operatorPath = operatorArg >= 0
    ? path.resolve(process.argv[operatorArg + 1])
    : path.join(root, "test-data", "operators-e2-96.json");
  const { PRTSMapLoader } = require(path.join(root, "dist", "loader", "PRTSMapLoader.js"));
  const { PRTSMapAdapter } = require(path.join(root, "dist", "adapter", "PRTSMapAdapter.js"));
  const { generateCopilotScript, clearSearchCaches } = require(path.join(root, "dist", "engine", "index.js"));
  const { OperatorBox } = require(path.join(root, "dist", "player", "OperatorBox.js"));
  const { generateStage } = require(path.join(root, "dist", "core", "pipeline.js"));
  const cacheDir = path.join(root, "cache", "levels");
  const loader = new PRTSMapLoader(cacheDir);
  const stageId = "a001_01";
  const raw = await loader.load(stageId);
  await loader.loadEnemyDatabase();
  const mapData = new PRTSMapAdapter(loader).adapt(raw, stageId, stageId);
  const playerOperators = new OperatorBox(operatorPath).playerMap;

  for (let index = 0; index < 3; index++) generateCopilotScript(stageId, mapData, { playerOperators });
  const engineDurations = [];
  for (let index = 0; index < 20; index++) {
    clearSearchCaches();
    const started = performance.now();
    generateCopilotScript(stageId, mapData, { playerOperators });
    engineDurations.push(performance.now() - started);
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-runtime-benchmark-"));
  const outputDir = path.join(stateDir, "output");
  for (let index = 0; index < 2; index++) {
    await generateStage({ stage: stageId, operatorFilePath: operatorPath, outputDir, newCandidate: true }, { cacheDir, stateDir });
  }
  const hotPipelineDurations = [];
  for (let index = 0; index < 10; index++) {
    const started = performance.now();
    await generateStage({
      stage: stageId,
      operatorFilePath: operatorPath,
      outputDir,
      fileName: `hot-${index}.json`,
      newCandidate: true,
    }, { cacheDir, stateDir });
    hotPipelineDurations.push(performance.now() - started);
  }
  fs.rmSync(stateDir, { recursive: true, force: true });

  const report = {
    engine: summarize(engineDurations),
    guiHotPipeline: summarize(hotPipelineDurations),
    thresholds: { engineP95Ms: 1200, guiHotP95Ms: 2000 },
  };
  report.passed = report.engine.p95Ms < report.thresholds.engineP95Ms
    && report.guiHotPipeline.p95Ms < report.thresholds.guiHotP95Ms;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
