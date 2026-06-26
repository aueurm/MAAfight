#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "dist", "index.js");
const resultDir = path.join(root, "benchmark-results");
const scriptDir = path.join(resultDir, "scripts");
const reportDir = path.join(resultDir, "reports");
const defaultStageFile = path.join(root, "benchmark", "stages", "basic.json");
const defaultOperatorFile = path.join(root, "test-data", "operators-e2-96.json");

const DEFAULT_STAGES = [
  { id: "a001_01", cache: "activities/a001/level_a001_01.json", type: "activity-basic", purpose: "baseline activity map" },
  { id: "main_00-01", cache: "obt/main/level_main_00-01.json", type: "main-early", purpose: "early mainline stability" },
  { id: "main_03-08", cache: "obt/main/level_main_03-08.json", type: "main-mid", purpose: "mid mainline generalization" },
  { id: "hard_05-01", cache: "obt/hard/level_hard_05-01.json", type: "hard", purpose: "hard-mode pressure" },
  { id: "weekly_armor_1", cache: "obt/weekly/level_weekly_armor_1.json", type: "weekly", purpose: "resource stage armor route" },
  { id: "weekly_fly_1", cache: "obt/weekly/level_weekly_fly_1.json", type: "weekly", purpose: "resource stage anti-air route" },
  { id: "camp_01", cache: "obt/campaign/level_camp_01.json", type: "campaign", purpose: "campaign route variation" },
  { id: "crisis_v2_01-01", cache: "obt/crisis/v2/level_crisis_v2_01-01.json", type: "crisis", purpose: "high-risk special mode boundary" },
  { id: "act42side_10", cache: "activities/act42side/level_act42side_10.json", type: "boss", purpose: "boss detection and risk reporting" },
  { id: "a001_ex01", cache: "activities/a001/level_a001_ex01.json", type: "activity-ex", purpose: "activity EX support boundary" },
];

function parseArgs(argv) {
  const args = {
    build: true,
    strict: false,
    operators: defaultOperatorFile,
    stages: defaultStageFile,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-build") args.build = false;
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--operators") args.operators = path.resolve(root, argv[++i]);
    else if (arg === "--no-operators") args.operators = undefined;
    else if (arg === "--stages") args.stages = path.resolve(root, argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`MAAfight benchmark

Usage:
  npm run benchmark
  node scripts/benchmark.js [--skip-build] [--strict] [--operators <path>] [--stages <path>]

Options:
  --skip-build       Do not run npm run build before benchmark
  --strict           Treat missing cached benchmark stages as failures
  --operators <path> MAA operator export JSON used for personalized generation
  --no-operators     Skip personalized generation check
  --stages <path>    Benchmark stage set JSON (default: benchmark/stages/basic.json)

By default, benchmark uses test-data/operators-e2-96.json for deterministic
personalized generation and diversity regression coverage.
`);
}

function runSegment(label, command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    timeout: options.timeoutMs || 120000,
    env: { ...process.env, ...(options.env || {}) },
  });
  const durationMs = Math.round(performance.now() - started);

  return {
    label,
    command: [command, ...args].join(" "),
    ok: result.status === 0,
    status: result.status,
    durationMs,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runCli(label, args, options) {
  return runSegment(label, process.execPath, [cli, ...args], options);
}

function assertResult(results, result, predicate, failureMessage) {
  const ok = result.ok && predicate(result);
  results.push({
    ...result,
    ok,
    failureMessage: ok ? undefined : failureMessage,
  });
  return ok;
}

function parseJsonOutput(result) {
  try {
    return JSON.parse(result.stdout || fs.readFileSync(result.outputFile, "utf-8"));
  } catch {
    return null;
  }
}

function loadBenchmarkStages(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return DEFAULT_STAGES;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.stages)) return parsed.stages;
  throw new Error(`Invalid benchmark stage file: ${filePath}`);
}

function parseExplainOutput(text) {
  const scoreMatch = text.match(/^Candidate score:\s*([0-9.]+)/m);
  const factsMatch = text.match(/^Facts:\s*(.+)$/m);
  return {
    candidateScore: scoreMatch ? Number(scoreMatch[1]) : 0,
    facts: factsMatch ? factsMatch[1] : "",
  };
}

function parseValidateOutput(text) {
  const scoreMatch = text.match(/^Score:\s*(\d+)\/100/m);
  const protocolScoreMatch = text.match(/^Protocol Score:\s*(\d+)\/100/m);
  return {
    script_valid: !/^Errors:/m.test(text) && !/^Protocol Errors:/m.test(text),
    validationScore: scoreMatch ? Number(scoreMatch[1]) : 0,
    protocolScore: protocolScoreMatch ? Number(protocolScoreMatch[1]) : 0,
    protocolWarningCount: /^Protocol Warnings:/m.test(text)
      ? (text.match(/^  \[[A-Z0-9_]+\]/gm) || []).length
      : 0,
  };
}

function collectDeployableTilesUsed(script) {
  const used = new Set();
  for (const action of script?.actions || []) {
    if (action.type === "Deploy" && Array.isArray(action.location)) {
      used.add(action.location.join(","));
    }
  }
  return used.size;
}

function writeQualityReport(stage, generate, validate, analyze) {
  const script = parseJsonOutput(generate);
  const analysis = parseJsonOutput(analyze);
  const explain = parseExplainOutput(generate.stderr || "");
  const validation = parseValidateOutput(validate.stdout || "");
  const report = {
    stage: stage.id,
    stage_name: script?.stage_name || "",
    type: stage.type || "unknown",
    purpose: stage.purpose || "",
    generated: Boolean(generate.ok && script?.stage_name),
    script_valid: validation.script_valid,
    deployable_tiles_used: collectDeployableTilesUsed(script),
    enemy_data_used: typeof analysis?.totalHp === "number",
    boss_detected: (analysis?.bossCount || 0) > 0,
    enemyCount: analysis?.enemyCount || 0,
    pressureWindowCount: analysis?.pressureWindows?.length || 0,
    candidateScore: explain.candidateScore,
    facts: explain.facts,
    protocol_warning_count: validation.protocolWarningCount,
    validationScore: validation.validationScore,
    protocolScore: validation.protocolScore,
    actionCount: Array.isArray(script?.actions) ? script.actions.length : 0,
    deployCount: Array.isArray(script?.actions) ? script.actions.filter(a => a.type === "Deploy").length : 0,
    operatorNames: collectOperatorNames(script).sort(),
    squadSignature: collectOperatorNames(script).sort().join("|"),
    durationMs: {
      generate: generate.durationMs,
      validate: validate.durationMs,
      analyze: analyze.durationMs,
    },
  };

  fs.writeFileSync(path.join(reportDir, `${stage.id}.json`), JSON.stringify(report, null, 2), "utf-8");
  return report;
}

function collectOperatorNames(script) {
  const names = new Set();
  for (const op of script?.opers || []) {
    if (op?.name) names.add(op.name);
  }
  for (const group of script?.groups || []) {
    for (const op of group?.opers || []) {
      if (op?.name) names.add(op.name);
    }
  }
  return [...names];
}

function createBenchmarkOperatorExport(script) {
  const names = collectOperatorNames(script);
  if (names.length === 0) return null;

  const operators = names.map((name, index) => ({
    id: `benchmark_${index}`,
    name,
    rarity: 6,
    own: true,
    elite: 2,
    level: Math.max(1, 90 - index),
    potential: 1 + (index % 6),
  }));
  const filePath = path.join(resultDir, "player-operators.json");
  fs.writeFileSync(filePath, JSON.stringify(operators, null, 2), "utf-8");
  return filePath;
}

function cacheExists(stage) {
  return fs.existsSync(path.join(root, "cache", "levels", stage.cache));
}

function localLevelPath(stage) {
  return path.join(root, "cache", "levels", stage.cache);
}

function summarize(results) {
  const completed = results.filter(r => r.status !== "skipped");
  const failed = completed.filter(r => !r.ok);
  const durations = completed.map(r => r.durationMs).filter(n => typeof n === "number");
  const slowest = [...completed].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))[0];

  return {
    total: completed.length,
    passed: completed.length - failed.length,
    failed: failed.length,
    skipped: results.filter(r => r.status === "skipped").length,
    averageMs: durations.length
      ? Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length)
      : 0,
    slowest: slowest ? { label: slowest.label, durationMs: slowest.durationMs } : null,
  };
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summarizeQuality(qualityReports) {
  const generated = qualityReports.filter(r => r.generated).length;
  const valid = qualityReports.filter(r => r.script_valid).length;
  const uniqueOperators = new Set(qualityReports.flatMap(report => report.operatorNames || []));
  const uniqueSquads = new Set(qualityReports.map(report => report.squadSignature).filter(Boolean));
  const coldGenerateMs = qualityReports.map(report => report.durationMs?.generate).filter(Number.isFinite);
  return {
    stages: qualityReports.length,
    generated,
    valid,
    highConfidence: qualityReports.filter(r => r.planner_confidence >= 0.8).length,
    mediumConfidence: qualityReports.filter(r => r.planner_confidence >= 0.5 && r.planner_confidence < 0.8).length,
    lowConfidence: qualityReports.filter(r => r.planner_confidence > 0 && r.planner_confidence < 0.5).length,
    unsupported: qualityReports.filter(r => r.supportLevel === "unsupported").length,
    experimental: qualityReports.filter(r => r.supportLevel === "experimental").length,
    protocolWarnings: qualityReports.reduce((sum, r) => sum + (r.protocol_warning_count || 0), 0),
    uniqueOperators: uniqueOperators.size,
    uniqueSquads: uniqueSquads.size,
    diversityPassed: uniqueOperators.size >= 40 && uniqueSquads.size >= 8,
    coldCliP50Ms: percentile(coldGenerateMs, 0.50),
    coldCliP95Ms: percentile(coldGenerateMs, 0.95),
  };
}

function writeReports(results, qualityReports = []) {
  const summary = summarize(results);
  const quality = summarizeQuality(qualityReports);
  const json = {
    generatedAt: new Date().toISOString(),
    summary,
    quality,
    results: results.map(r => ({
      label: r.label,
      ok: r.ok,
      status: r.status,
      durationMs: r.durationMs,
      failureMessage: r.failureMessage,
      command: r.command,
    })),
  };

  fs.writeFileSync(path.join(resultDir, "results.json"), JSON.stringify(json, null, 2), "utf-8");

  const lines = [
    "# MAAfight Benchmark Summary",
    "",
    `Generated: ${json.generatedAt}`,
    "",
    `- Passed: ${summary.passed}/${summary.total}`,
    `- Failed: ${summary.failed}`,
    `- Skipped: ${summary.skipped}`,
    `- Average command time: ${summary.averageMs} ms`,
    summary.slowest ? `- Slowest: ${summary.slowest.label} (${summary.slowest.durationMs} ms)` : "- Slowest: n/a",
    "",
    "## Quality",
    "",
    `- Stages: ${quality.stages}`,
    `- Generated: ${quality.generated}`,
    `- Valid: ${quality.valid}`,
    `- High confidence: ${quality.highConfidence}`,
    `- Medium confidence: ${quality.mediumConfidence}`,
    `- Low confidence: ${quality.lowConfidence}`,
    `- Experimental: ${quality.experimental}`,
    `- Unsupported: ${quality.unsupported}`,
    `- Protocol warnings: ${quality.protocolWarnings}`,
    `- Unique operators: ${quality.uniqueOperators}/40`,
    `- Unique squads: ${quality.uniqueSquads}/8`,
    `- Diversity gate: ${quality.diversityPassed ? "PASS" : "FAIL"}`,
    `- Cold CLI P50/P95: ${quality.coldCliP50Ms}/${quality.coldCliP95Ms} ms`,
    "",
    "| Check | Status | Time | Note |",
    "| --- | --- | ---: | --- |",
    ...results.map(r => {
      const status = r.status === "skipped" ? "SKIP" : r.ok ? "PASS" : "FAIL";
      return `| ${r.label} | ${status} | ${r.durationMs ?? "-"} ms | ${r.failureMessage || ""} |`;
    }),
    "",
  ];

  fs.writeFileSync(path.join(resultDir, "summary.md"), lines.join("\n"), "utf-8");
}

function ensureOutputDirs() {
  fs.rmSync(resultDir, { recursive: true, force: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
}

function runBenchmark(options) {
  ensureOutputDirs();
  const results = [];
  const qualityReports = [];
  const benchmarkStages = loadBenchmarkStages(options.stages);
  const benchmarkOperatorFile = options.operators && fs.existsSync(options.operators) ? options.operators : null;

  if (options.build) {
    const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
    const build = runSegment("build", process.execPath, [tsc]);
    results.push(build.ok ? build : { ...build, failureMessage: "npm run build failed" });
    if (!build.ok) return { results, qualityReports };
  }

  const listWeekly = runCli("list: weekly category", ["list", "--category", "weekly", "--limit", "5"]);
  assertResult(
    results,
    listWeekly,
    r => r.stdout.includes("weekly_"),
    "Expected weekly stage rows in list output"
  );

  const listSearch = runCli("list: search a001", ["list", "--search", "a001", "--limit", "5"]);
  assertResult(
    results,
    listSearch,
    r => r.stdout.includes("a001_01"),
    "Expected a001_01 in search output"
  );

  const unknownStage = runCli("error: unknown stage", ["generate", "--stage", "__missing_stage__", "--quiet"]);
  results.push({
    ...unknownStage,
    ok: unknownStage.status !== 0 && /not found|Error/i.test(unknownStage.stderr),
    failureMessage: unknownStage.status !== 0 ? undefined : "Unknown stage should fail",
  });

  const baseStage = DEFAULT_STAGES[0];
  const baseLevel = localLevelPath(baseStage);
  if (fs.existsSync(baseLevel)) {
    const localOutput = path.join(scriptDir, "local-a001_01.json");
    const generateLocal = runCli("generate: local data", [
      "generate",
      "--data", baseLevel,
      "--stage", baseStage.id,
      "--output", localOutput,
      "--pretty",
      "--quiet",
    ]);
    generateLocal.outputFile = localOutput;
    const localScript = parseJsonOutput(generateLocal);
    assertResult(
      results,
      generateLocal,
      () => Boolean(localScript?.stage_name && localScript?.actions?.length && Array.isArray(localScript?.groups)),
      "Generated local script should contain stage_name, actions, and groups array"
    );

    const validateLocal = runCli("validate: generated local script", ["validate", "--file", localOutput]);
    assertResult(
      results,
      validateLocal,
      r => /Score:\s*\d+\/100/.test(r.stdout) && !r.stdout.includes("Errors:"),
      "Generated script should validate without errors"
    );

    const analyzeLocal = runCli("analyze: local data", [
      "analyze",
      "--data", baseLevel,
      "--stage", baseStage.id,
      "--pretty",
      "--quiet",
    ]);
    assertResult(
      results,
      analyzeLocal,
      r => {
        const parsed = parseJsonOutput(r);
        return Boolean(typeof parsed?.enemyCount === "number" && Array.isArray(parsed?.pressureWindows) && parsed?.difficulty);
      },
      "Analyze output should include v2 stage facts and pressure windows"
    );

    const infoLocal = runCli("info: local data", ["info", "--data", baseLevel, "--stage", baseStage.id, "--quiet"]);
    assertResult(
      results,
      infoLocal,
      r => r.stdout.includes("Stage:") && r.stdout.includes("Map Size:") && r.stdout.includes("Enemy Types:"),
      "Info output should include stage, map size, and enemy type count"
    );

    let operatorFile = options.operators;
    if (options.operators === "benchmark") {
      operatorFile = localScript ? createBenchmarkOperatorExport(localScript) : null;
    }

    if (operatorFile && fs.existsSync(operatorFile)) {
      const operatorOutput = path.join(scriptDir, "operators-a001_01.json");
      const generateWithOperators = runCli("generate: with player operators", [
        "generate",
        "--data", baseLevel,
        "--stage", baseStage.id,
        "--operators", operatorFile,
        "--requirements", "player",
        "--output", operatorOutput,
        "--pretty",
        "--quiet",
      ]);
      generateWithOperators.outputFile = operatorOutput;
      assertResult(
        results,
        generateWithOperators,
        () => {
          const parsed = parseJsonOutput(generateWithOperators);
          const opersHasRequirements = (parsed?.opers || []).some(op => Boolean(op.requirements));
          return opersHasRequirements;
        },
        "Operator-personalized generation should include requirements"
      );
    } else if (options.operators) {
      results.push({
        label: "generate: with player operators",
        ok: !options.strict,
        status: "skipped",
        durationMs: 0,
        failureMessage: options.operators === "benchmark"
          ? "Could not create benchmark operator export from baseline script"
          : `Operator export file missing: ${options.operators}`,
      });
    }
  } else {
    results.push({
      label: "local data capability",
      ok: !options.strict,
      status: "skipped",
      durationMs: 0,
      failureMessage: `Cached base level missing: ${baseLevel}`,
    });
  }

  for (const stage of benchmarkStages) {
    if (!cacheExists(stage)) {
      results.push({
        label: `stage pipeline: ${stage.id}`,
        ok: !options.strict,
        status: "skipped",
        durationMs: 0,
        failureMessage: `Cache missing: ${stage.cache}`,
      });
      continue;
    }

    const output = path.join(scriptDir, `${stage.id}.json`);
    const generate = runCli(`stage generate: ${stage.id}`, [
      "generate",
      "--stage", stage.id,
      ...(benchmarkOperatorFile ? ["--operators", benchmarkOperatorFile] : []),
      "--output", output,
      "--explain",
      "--quiet",
    ]);
    generate.outputFile = output;
    const generatedOk = assertResult(
      results,
      generate,
      () => {
        const parsed = parseJsonOutput(generate);
        return Boolean(parsed?.stage_name) && Array.isArray(parsed.actions) && parsed.actions.length > 0;
      },
      "Stage generation should produce a non-empty copilot script"
    );
    if (!generatedOk) continue;

    const validate = runCli(`stage validate: ${stage.id}`, ["validate", "--file", output]);
    assertResult(
      results,
      validate,
      r => /Score:\s*\d+\/100/.test(r.stdout) && !r.stdout.includes("Errors:"),
      "Generated stage script should validate without errors"
    );

    const analyze = runCli(`stage analyze: ${stage.id}`, ["analyze", "--stage", stage.id, "--pretty", "--quiet"]);
    assertResult(
      results,
      analyze,
      r => {
        const parsed = parseJsonOutput(r);
        return Boolean(typeof parsed?.enemyCount === "number" && Array.isArray(parsed?.pressureWindows) && parsed?.summary);
      },
      "Stage analysis should produce v2 stage facts"
    );

    qualityReports.push(writeQualityReport(stage, generate, validate, analyze));
  }

  const quality = summarizeQuality(qualityReports);
  results.push({
    label: "diversity: 10-stage E2 fixture",
    command: "benchmark diversity aggregation",
    ok: qualityReports.length === benchmarkStages.length && quality.diversityPassed,
    status: qualityReports.length === benchmarkStages.length && quality.diversityPassed ? 0 : 1,
    durationMs: 0,
    failureMessage: quality.diversityPassed
      ? undefined
      : `Expected >=40 operators and >=8 squads, got ${quality.uniqueOperators} operators and ${quality.uniqueSquads} squads`,
  });

  if (fs.existsSync(path.join(root, "dist", "engine", "index.js")) && benchmarkOperatorFile) {
    const runtime = runSegment("runtime: engine and GUI hot P95", process.execPath, [
      path.join(root, "scripts", "benchmark-runtime.js"),
      "--operators", benchmarkOperatorFile,
    ], { timeoutMs: 120000 });
    let runtimeReport = null;
    try {
      runtimeReport = JSON.parse(runtime.stdout);
    } catch {
      runtimeReport = null;
    }
    const runtimePassed = runtime.ok && Boolean(runtimeReport?.passed);
    results.push({
      ...runtime,
      ok: runtimePassed,
      failureMessage: runtimePassed
        ? undefined
        : runtimeReport
          ? `Engine P95 ${runtimeReport.engine.p95Ms} ms; GUI hot P95 ${runtimeReport.guiHotPipeline.p95Ms} ms`
          : "Runtime benchmark did not return a valid report",
    });
  }

  return { results, qualityReports };
}

const options = parseArgs(process.argv.slice(2));
const { results, qualityReports } = runBenchmark(options);
writeReports(results, qualityReports);

const summary = summarize(results);
console.log(`Benchmark: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
console.log(`Average command time: ${summary.averageMs} ms`);
if (summary.slowest) console.log(`Slowest: ${summary.slowest.label} (${summary.slowest.durationMs} ms)`);
console.log(`Reports: ${path.relative(root, resultDir)}/results.json, ${path.relative(root, resultDir)}/summary.md`);

if (summary.failed > 0) {
  for (const failed of results.filter(r => r.status !== "skipped" && !r.ok)) {
    console.error(`FAIL ${failed.label}: ${failed.failureMessage || failed.stderr || failed.stdout}`);
  }
  process.exit(1);
}
