#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const { PRTSMapLoader } = require("../dist/loader/PRTSMapLoader");
const { PRTSMapAdapter } = require("../dist/adapter/PRTSMapAdapter");
const { resolveStage } = require("../dist/loader/levelIndex");

const execFileAsync = promisify(execFile);
const API_BASE = "https://prts.maa.plus";
const MAP_BASE = "https://map.ark-nights.com";
const DEFAULT_LIMIT = 100;
const PAGE_LIMIT = 50;
const DETAIL_CONCURRENCY = 4;

function parseArgs(argv) {
  const options = {
    limit: DEFAULT_LIMIT,
    outputDir: path.resolve("data", "prts-plus-latest-100"),
    reuseCorpus: false,
    aroundDate: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      options.limit = Number(argv[++i]);
    } else if (arg === "--output") {
      options.outputDir = path.resolve(argv[++i]);
    } else if (arg === "--reuse-corpus") {
      options.reuseCorpus = true;
    } else if (arg === "--around-date") {
      options.aroundDate = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }
  if (
    options.aroundDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(options.aroundDate)
  ) {
    throw new Error("--around-date must use YYYY-MM-DD");
  }
  if (options.reuseCorpus && options.aroundDate) {
    throw new Error("--reuse-corpus and --around-date cannot be used together");
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/analyze-prts-plus.js [options]

Options:
  --limit <n>     Number of latest public operations to analyze (default: 100)
  --output <dir>  Output directory (default: data/prts-plus-latest-100)
  --reuse-corpus  Recompute from the saved local corpus without network requests
  --around-date <YYYY-MM-DD>
                  Select operations whose public upload_time is nearest this date
  -h, --help      Show this help

Outputs:
  corpus/*.json   Full public copilot JSON files for local follow-up analysis
  manifest.json   Corpus index without uploader information
  snapshot.json   Selection metadata for reproducible offline analysis
  features.json   Per-operation derived features without full scripts or uploader data
  stats.json      Aggregate statistics
  summary.md      Human-readable report`);
}

function curlExecutable() {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

async function fetchBuffer(url) {
  const args = [];
  if (process.platform === "win32") args.push("--ssl-no-revoke");
  args.push(
    "-sS",
    "--fail",
    "--retry",
    "2",
    "--connect-timeout",
    "15",
    "--max-time",
    "60",
    url
  );

  const { stdout } = await execFileAsync(curlExecutable(), args, {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function fetchJson(url) {
  const buffer = await fetchBuffer(url);
  return JSON.parse(buffer.toString("utf8"));
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  );
  return results;
}

function parseContent(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") throw new Error("content is not JSON text");
  return JSON.parse(raw);
}

async function fetchLatestOperations(limit) {
  const listEntries = [];
  const seen = new Set();
  let page = 1;

  while (listEntries.length < limit) {
    const remaining = limit - listEntries.length;
    const pageSize = Math.min(PAGE_LIMIT, remaining);
    const url =
      `${API_BASE}/copilot/query?limit=${pageSize}&page=${page}` +
      "&order_by=id&desc=true";
    const response = await fetchJson(url);
    const entries = response?.data?.data;
    if (response?.status_code !== 200 || !Array.isArray(entries)) {
      throw new Error(`Unexpected list response on page ${page}`);
    }
    if (entries.length === 0) break;

    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      listEntries.push({
        id: entry.id,
        uploadTime: entry.upload_time || null,
      });
      if (listEntries.length >= limit) break;
    }
    page++;
  }

  return fetchOperationDetails(listEntries);
}

async function fetchOperationDetails(listEntries) {
  console.error(`Selected ${listEntries.length} operation IDs; loading full details...`);
  return mapConcurrent(listEntries, DETAIL_CONCURRENCY, async (entry, index) => {
    try {
      const response = await fetchJson(`${API_BASE}/copilot/get/${entry.id}`);
      if (response?.status_code !== 200 || !response.data) {
        throw new Error(`status_code=${response?.status_code}`);
      }
      if ((index + 1) % 10 === 0 || index + 1 === listEntries.length) {
        console.error(`Loaded details ${index + 1}/${listEntries.length}`);
      }
      return {
        id: entry.id,
        uploadTime: response.data.upload_time || entry.uploadTime,
        content: parseContent(response.data.content),
        error: null,
      };
    } catch (error) {
      console.error(`Detail ${entry.id} failed: ${error.message}`);
      return {
        id: entry.id,
        uploadTime: entry.uploadTime,
        content: null,
        error: error.message,
      };
    }
  });
}

function parseUploadTime(value) {
  if (typeof value !== "string" || !value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function selectClosestOperations(entries, targetDate, limit) {
  const target = new Date(`${targetDate}T12:00:00`).getTime();
  return [...entries]
    .filter(entry => parseUploadTime(entry.uploadTime) !== null)
    .sort((a, b) => {
      const aDistance = Math.abs(parseUploadTime(a.uploadTime) - target);
      const bDistance = Math.abs(parseUploadTime(b.uploadTime) - target);
      return aDistance - bDistance || b.id - a.id;
    })
    .slice(0, limit)
    .sort(
      (a, b) =>
        parseUploadTime(b.uploadTime) - parseUploadTime(a.uploadTime) || b.id - a.id
    );
}

async function fetchOperationsAroundDate(limit, targetDate) {
  const pageCache = new Map();
  async function getPage(page) {
    if (pageCache.has(page)) return pageCache.get(page);
    const response = await fetchJson(
      `${API_BASE}/copilot/query?limit=${PAGE_LIMIT}&page=${page}` +
        "&order_by=id&desc=true"
    );
    const rows = response?.data?.data;
    if (response?.status_code !== 200 || !Array.isArray(rows)) {
      throw new Error(`Unexpected list response on page ${page}`);
    }
    const result = {
      total: Number(response.data.total) || 0,
      entries: rows.map(entry => ({
        id: entry.id,
        uploadTime: entry.upload_time || null,
      })),
    };
    pageCache.set(page, result);
    return result;
  }

  const firstPage = await getPage(1);
  const totalPages = Math.max(1, Math.ceil(firstPage.total / PAGE_LIMIT));
  const target = new Date(`${targetDate}T12:00:00`).getTime();
  let low = 1;
  let high = totalPages;
  let bestPage = 1;
  let bestDistance = Infinity;

  while (low <= high) {
    const page = Math.floor((low + high) / 2);
    const result = await getPage(page);
    const timestamps = result.entries
      .map(entry => parseUploadTime(entry.uploadTime))
      .filter(value => value !== null)
      .sort((a, b) => a - b);
    if (timestamps.length === 0) break;
    const representative = timestamps[Math.floor(timestamps.length / 2)];
    const distance = Math.abs(representative - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPage = page;
    }

    // IDs generally increase with creation time. Updated old scripts are handled
    // later by selecting the closest upload_time from a wider page window.
    if (representative > target) low = page + 1;
    else high = page - 1;
  }

  const radius = Math.max(6, Math.ceil(limit / PAGE_LIMIT) + 4);
  const pages = [];
  for (
    let page = Math.max(1, bestPage - radius);
    page <= Math.min(totalPages, bestPage + radius);
    page++
  ) {
    pages.push(page);
  }
  await mapConcurrent(pages, 4, page => getPage(page));

  const candidates = [];
  const seen = new Set();
  for (const page of pages) {
    for (const entry of pageCache.get(page).entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      candidates.push(entry);
    }
  }
  const selected = selectClosestOperations(candidates, targetDate, limit);
  if (selected.length < limit) {
    throw new Error(
      `Only ${selected.length} dated operations found near ${targetDate}`
    );
  }

  const selectedTimes = selected.map(entry => parseUploadTime(entry.uploadTime));
  console.error(
    `Located page ${bestPage}/${totalPages}; selected ${selected.length} operations ` +
      `from ${new Date(Math.min(...selectedTimes)).toISOString()} to ` +
      `${new Date(Math.max(...selectedTimes)).toISOString()}`
  );
  return fetchOperationDetails(selected);
}

function loadOperationsFromCorpus(outputDir, limit) {
  const manifestPath = path.join(outputDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Local corpus manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest) || manifest.length < limit) {
    throw new Error(
      `Local corpus has ${Array.isArray(manifest) ? manifest.length : 0} entries; ` +
        `${limit} requested`
    );
  }

  return manifest.slice(0, limit).map(entry => {
    const corpusPath = path.join(outputDir, entry.file);
    return {
      id: entry.id,
      uploadTime: entry.uploadTime || null,
      content: JSON.parse(fs.readFileSync(corpusPath, "utf8")),
      error: null,
    };
  });
}

function loadSnapshotMetadata(outputDir) {
  const snapshotPath = path.join(outputDir, "snapshot.json");
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    return snapshot && typeof snapshot === "object" ? snapshot : null;
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedActionType(type) {
  return typeof type === "string" && type.trim() ? type.trim() : "Unknown";
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    if (key === null || key === undefined || key === "") continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function increment(target, key, amount = 1) {
  if (key === null || key === undefined || key === "") return;
  target[key] = (target[key] || 0) + amount;
}

function sortedEntries(counts, limit) {
  const entries = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))
  );
  return limit ? entries.slice(0, limit) : entries;
}

function uniqueOperatorEntries(content) {
  const result = [];
  for (const oper of asArray(content.opers)) {
    if (oper && typeof oper.name === "string") result.push(oper);
  }
  for (const group of asArray(content.groups)) {
    for (const oper of asArray(group?.opers)) {
      if (oper && typeof oper.name === "string") result.push(oper);
    }
  }
  return result;
}

function extractRequirementFeatures(operatorEntries) {
  const skillChoices = {};
  const skillUsage = {};
  const modules = {};
  let withRequirements = 0;
  let withModule = 0;
  let withModuleLevel = 0;
  let withSkillLevel = 0;

  for (const oper of operatorEntries) {
    const skill = finiteNumber(oper.skill);
    if (skill !== null) increment(skillChoices, String(skill));
    const usage = finiteNumber(oper.skill_usage);
    if (usage !== null) increment(skillUsage, String(usage));

    const requirements =
      oper.requirements && typeof oper.requirements === "object"
        ? oper.requirements
        : null;
    if (!requirements) continue;
    withRequirements++;

    const moduleValue = requirements.module;
    const hasNumericModule =
      Number.isFinite(Number(moduleValue)) && Number(moduleValue) > 0;
    const hasNamedModule =
      typeof moduleValue === "string" &&
      moduleValue.trim() !== "" &&
      moduleValue.trim().toLowerCase() !== "none";
    if (hasNumericModule || hasNamedModule) {
      withModule++;
      increment(modules, String(moduleValue).trim());
    }
    if (finiteNumber(requirements.module_level) !== null) withModuleLevel++;
    if (finiteNumber(requirements.skill_level) !== null) withSkillLevel++;
  }

  return {
    withRequirements,
    withModule,
    withModuleLevel,
    withSkillLevel,
    skillChoices,
    skillUsage,
    modules,
  };
}

function extractOperationFeatures(operation) {
  if (!operation.content) {
    return {
      id: operation.id,
      uploadTime: operation.uploadTime,
      parseError: operation.error || "missing content",
    };
  }

  const content = operation.content;
  const opers = asArray(content.opers);
  const groups = asArray(content.groups);
  const actions = asArray(content.actions);
  const groupCandidates = groups.flatMap(group => asArray(group?.opers));
  const operatorEntries = uniqueOperatorEntries(content);
  const operatorNames = [
    ...new Set(
      operatorEntries
        .map(oper => (typeof oper.name === "string" ? oper.name.trim() : ""))
        .filter(Boolean)
    ),
  ];
  const actionTypes = countBy(actions, action => normalizedActionType(action?.type));
  const deployActions = actions.filter(
    action => normalizedActionType(action?.type).toLowerCase() === "deploy"
  );
  const skillActions = actions.filter(
    action => normalizedActionType(action?.type).toLowerCase() === "skill"
  );
  const retreatActions = actions.filter(
    action => normalizedActionType(action?.type).toLowerCase() === "retreat"
  );
  const directions = countBy(
    deployActions,
    action => (typeof action?.direction === "string" ? action.direction : "Missing")
  );
  const conditions = {
    kills: actions.filter(action => finiteNumber(action?.kills) !== null).length,
    cost: actions.filter(
      action =>
        finiteNumber(action?.cost) !== null || finiteNumber(action?.costs) !== null
    ).length,
    cooling: actions.filter(action => action?.cooling !== undefined).length,
    elapsedTime: actions.filter(
      action =>
        finiteNumber(action?.time_elapsed) !== null ||
        finiteNumber(action?.time) !== null
    ).length,
    preDelay: actions.filter(action => finiteNumber(action?.pre_delay) !== null).length,
    postDelay: actions.filter(action => finiteNumber(action?.post_delay) !== null)
      .length,
  };
  const requirements = extractRequirementFeatures(operatorEntries);

  return {
    id: operation.id,
    uploadTime: operation.uploadTime,
    stageName:
      typeof content.stage_name === "string" ? content.stage_name.trim() : "",
    version: finiteNumber(content.version),
    minimumRequired:
      typeof content.minimum_required === "string"
        ? content.minimum_required
        : null,
    fixedOperCount: opers.length,
    groupCount: groups.length,
    groupCandidateCount: groupCandidates.length,
    uniqueOperatorCount: operatorNames.length,
    operatorNames,
    actionCount: actions.length,
    deployCount: deployActions.length,
    skillCount: skillActions.length,
    retreatCount: retreatActions.length,
    actionTypes,
    directions,
    conditions,
    hasSkillDaemon: actions.some(
      action => normalizedActionType(action?.type).toLowerCase() === "skilldaemon"
    ),
    hasSpeedUp: actions.some(
      action => normalizedActionType(action?.type).toLowerCase() === "speedup"
    ),
    hasActions: actions.length > 0,
    hasDeployActions: deployActions.length > 0,
    requirements,
    deployLocations: deployActions
      .map(action => ({
        x: finiteNumber(action?.location?.[0]),
        y: finiteNumber(action?.location?.[1]),
      }))
      .filter(location => location.x !== null && location.y !== null),
  };
}

function manhattan(a, b) {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

function nearestDistance(point, targets) {
  if (targets.length === 0) return null;
  return Math.min(...targets.map(target => manhattan(point, target)));
}

function average(values) {
  const valid = values.filter(value => Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function median(values) {
  const valid = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2
    ? valid[middle]
    : (valid[middle - 1] + valid[middle]) / 2;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mapZone(row, col, rows, cols) {
  const rowBand = Math.min(2, Math.floor((row / Math.max(rows, 1)) * 3));
  const colBand = Math.min(2, Math.floor((col / Math.max(cols, 1)) * 3));
  return `${rowBand + 1}-${colBand + 1}`;
}

function normalizeRawBuildableType(type) {
  if (type === "MELEE" || type === 1) return "melee";
  if (type === "RANGED" || type === 2) return "ranged";
  if (type === "ALL" || type === 3) return "all";
  return "none";
}

function rawDeploymentPoints(mapData) {
  const rawMap = mapData._raw?.mapData;
  if (!rawMap?.map || !rawMap?.tiles) return mapData.deploymentPoints;

  const points = [];
  for (let row = 0; row < rawMap.map.length; row++) {
    for (let col = 0; col < rawMap.map[row].length; col++) {
      const tile = rawMap.tiles[rawMap.map[row][col]];
      const buildableType = normalizeRawBuildableType(tile?.buildableType);
      if (buildableType !== "none") points.push({ row, col, buildableType });
    }
  }
  return points;
}

function definedValue(value, fallback = null) {
  if (value && typeof value === "object" && "m_defined" in value) {
    return value.m_defined ? value.m_value : fallback;
  }
  return value ?? fallback;
}

function enemyLevelType(mapData, enemyId, enemyLevelTypes) {
  const base = enemyLevelTypes.get(enemyId) || null;
  const ref = mapData._raw?.enemyDbRefs?.find(item => item.id === enemyId);
  return definedValue(ref?.overwrittenData?.levelType, base);
}

function buildMapMetrics(mapData, enemyLevelTypes = new Map()) {
  const rows = mapData.tiles.length;
  const cols = Math.max(0, ...mapData.tiles.map(row => row.length));
  const deploymentPoints = rawDeploymentPoints(mapData);
  const routePoints = mapData.routes.flatMap(route => [
    route.startPosition,
    ...route.checkpoints,
    route.endPosition,
  ]);
  const endPoints = mapData.routes.map(route => route.endPosition);
  const chokepoints = mapData.strategicPoints.filter(
    point => point.type === "chokepoint"
  );
  const detailById = new Map(mapData.enemyDetails.map(enemy => [enemy.id, enemy]));
  let weightedHp = 0;
  let weightedAtk = 0;
  let bossTypeCount = 0;
  let eliteTypeCount = 0;

  for (const spawn of mapData.spawnTimeline) {
    const detail = detailById.get(spawn.enemyId);
    const count = spawn.count || 1;
    weightedHp += (detail?.maxHp || 0) * count;
    weightedAtk += (detail?.atk || 0) * count;
  }
  for (const enemy of mapData.enemyDetails) {
    const levelType = String(
      enemyLevelType(mapData, enemy.id, enemyLevelTypes) || ""
    ).toUpperCase();
    if (levelType === "BOSS") bossTypeCount++;
    if (levelType === "ELITE") eliteTypeCount++;
  }

  return {
    stageId: mapData.stageId,
    rows,
    cols,
    deploymentPointCount: deploymentPoints.length,
    meleePointCount: deploymentPoints.filter(
      point => point.buildableType === "melee"
    ).length,
    rangedPointCount: deploymentPoints.filter(
      point => point.buildableType === "ranged"
    ).length,
    flexiblePointCount: deploymentPoints.filter(
      point => point.buildableType === "all"
    ).length,
    routeCount: mapData.routes.length,
    flyingRouteCount: mapData.routes.filter(route => route.motionMode === "fly").length,
    uniqueStartCount: new Set(
      mapData.routes.map(route => `${route.startPosition.row},${route.startPosition.col}`)
    ).size,
    uniqueEndCount: new Set(
      mapData.routes.map(route => `${route.endPosition.row},${route.endPosition.col}`)
    ).size,
    chokepointCount: chokepoints.length,
    spawnCount: mapData.spawnTimeline.reduce(
      (sum, spawn) => sum + (spawn.count || 1),
      0
    ),
    enemyTypeCount: mapData.enemyDetails.length,
    bossTypeCount,
    eliteTypeCount,
    highThreatTypeCount: mapData.enemyDetails.filter(enemy => enemy.isElite).length,
    weightedHp,
    weightedAtk,
    initialCost: mapData.options.initialCost,
    maxCost: mapData.options.maxCost,
    costIncreaseTime: mapData.options.costIncreaseTime,
    characterLimit: mapData.options.characterLimit,
    _join: {
      deploymentPoints,
      routePoints,
      endPoints,
      chokepoints,
    },
  };
}

async function ensureCachedFile(cachePath, url) {
  if (fs.existsSync(cachePath)) return;
  const buffer = await fetchBuffer(url);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, buffer);
}

function loadEnemyLevelTypes(enemyDbPath) {
  const raw = JSON.parse(fs.readFileSync(enemyDbPath, "utf8"));
  const result = new Map();
  for (const entry of raw.enemies || []) {
    const levelType = definedValue(entry.Value?.[0]?.enemyData?.levelType);
    if (levelType) result.set(entry.Key, levelType);
  }
  return result;
}

async function loadMapMetrics(stageNames) {
  const cacheDir = path.resolve("cache", "levels");
  const enemyDbPath = path.resolve("cache", "enemy_database.json");
  await ensureCachedFile(
    enemyDbPath,
    `${MAP_BASE}/data/levels/enemydata/enemy_database.json`
  );

  const loader = new PRTSMapLoader(cacheDir, MAP_BASE);
  await loader.loadEnemyDatabase();
  const enemyLevelTypes = loadEnemyLevelTypes(enemyDbPath);
  const adapter = new PRTSMapAdapter(loader);
  const results = new Map();

  for (const [index, stageName] of stageNames.entries()) {
    const entry = resolveStage(stageName);
    if (!entry?.filePath) {
      results.set(stageName, { error: "stage_not_found" });
      continue;
    }

    try {
      const cachePath = path.join(cacheDir, entry.filePath);
      await ensureCachedFile(
        cachePath,
        `${MAP_BASE}/data/levels/${entry.filePath.replace(/\\/g, "/")}`
      );
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const mapData = adapter.adapt(raw, entry.stageId, entry.name || entry.code);
      results.set(stageName, {
        entry: {
          stageId: entry.stageId,
          code: entry.code || null,
          name: entry.name || null,
          category: entry.category || null,
        },
        metrics: buildMapMetrics(mapData, enemyLevelTypes),
      });
    } catch (error) {
      results.set(stageName, {
        entry: {
          stageId: entry.stageId,
          code: entry.code || null,
          name: entry.name || null,
          category: entry.category || null,
        },
        error: error.message,
      });
    }

    if ((index + 1) % 10 === 0 || index + 1 === stageNames.length) {
      console.error(`Loaded maps ${index + 1}/${stageNames.length}`);
    }
  }

  return results;
}

function joinOperationWithMap(feature, mapResult) {
  if (!mapResult?.metrics) {
    return {
      mapMatched: false,
      mapError: mapResult?.error || "stage_missing",
    };
  }

  const metrics = mapResult.metrics;
  const join = metrics._join;
  const deploymentPointByKey = new Map(
    join.deploymentPoints.map(point => [`${point.row},${point.col}`, point])
  );
  const zones = {};
  const routeDistances = [];
  const endDistances = [];
  const chokepointDistances = [];
  let matched = 0;
  let outOfBounds = 0;
  let melee = 0;
  let ranged = 0;
  let flexible = 0;
  const uniqueTiles = new Set();

  for (const location of feature.deployLocations || []) {
    // MAA copilot uses [x, y], while MapData uses { row: y, col: x }.
    const point = { row: location.y, col: location.x };
    if (
      point.row < 0 ||
      point.col < 0 ||
      point.row >= metrics.rows ||
      point.col >= metrics.cols
    ) {
      outOfBounds++;
      continue;
    }

    increment(zones, mapZone(point.row, point.col, metrics.rows, metrics.cols));
    uniqueTiles.add(`${point.row},${point.col}`);
    const deploymentPoint = deploymentPointByKey.get(`${point.row},${point.col}`);
    if (deploymentPoint) {
      matched++;
      if (deploymentPoint.buildableType === "melee") melee++;
      if (deploymentPoint.buildableType === "ranged") ranged++;
      if (deploymentPoint.buildableType === "all") flexible++;
    }
    const routeDistance = nearestDistance(point, join.routePoints);
    const endDistance = nearestDistance(point, join.endPoints);
    const chokepointDistance = nearestDistance(point, join.chokepoints);
    if (routeDistance !== null) routeDistances.push(routeDistance);
    if (endDistance !== null) endDistances.push(endDistance);
    if (chokepointDistance !== null) chokepointDistances.push(chokepointDistance);
  }

  const publicMetrics = { ...metrics };
  publicMetrics.deploymentPoints = join.deploymentPoints;
  publicMetrics.routeCells = [...new Map(
    join.routePoints.map(point => [`${point.row},${point.col}`, point])
  ).values()];
  publicMetrics.goalCells = [...new Map(
    join.endPoints.map(point => [`${point.row},${point.col}`, point])
  ).values()];
  publicMetrics.chokeCells = [...new Map(
    join.chokepoints.map(point => [`${point.row},${point.col}`, point])
  ).values()];
  delete publicMetrics._join;
  return {
    mapMatched: true,
    resolvedStage: mapResult.entry,
    map: publicMetrics,
    deploymentMapFeatures: {
      locatedDeployCount: (feature.deployLocations || []).length,
      matchedDeployableCount: matched,
      outOfBoundsCount: outOfBounds,
      baseNonDeployableCount:
        (feature.deployLocations || []).length - matched - outOfBounds,
      uniqueDeployTileCount: uniqueTiles.size,
      meleeDeployCount: melee,
      rangedDeployCount: ranged,
      flexibleDeployCount: flexible,
      normalizedZones: zones,
      averageRouteDistance: round(average(routeDistances)),
      averageBlueBoxDistance: round(average(endDistances)),
      averageChokepointDistance: round(average(chokepointDistances)),
    },
  };
}

function summarizeSubset(features) {
  if (features.length === 0) {
    return {
      operationCount: 0,
      averageFixedOperCount: null,
      averageActionCount: null,
      averageDeployCount: null,
      averageSkillCount: null,
      averageUniqueDeployTileCount: null,
      rangedDeployShare: null,
      flexibleDeployShare: null,
      skillDaemonRate: null,
    };
  }

  const ranged = features.reduce(
    (sum, feature) =>
      sum + (feature.deploymentMapFeatures?.rangedDeployCount || 0),
    0
  );
  const typedDeploys = features.reduce(
    (sum, feature) =>
      sum +
      (feature.deploymentMapFeatures?.rangedDeployCount || 0) +
      (feature.deploymentMapFeatures?.meleeDeployCount || 0),
    0
  );
  const flexible = features.reduce(
    (sum, feature) =>
      sum + (feature.deploymentMapFeatures?.flexibleDeployCount || 0),
    0
  );
  const allMatchedDeploys = typedDeploys + flexible;
  return {
    operationCount: features.length,
    averageFixedOperCount: round(average(features.map(item => item.fixedOperCount))),
    averageActionCount: round(average(features.map(item => item.actionCount))),
    averageDeployCount: round(average(features.map(item => item.deployCount))),
    averageSkillCount: round(average(features.map(item => item.skillCount))),
    averageUniqueDeployTileCount: round(
      average(
        features.map(
          item => item.deploymentMapFeatures?.uniqueDeployTileCount ?? null
        )
      )
    ),
    rangedDeployShare: typedDeploys > 0 ? round(ranged / typedDeploys, 4) : null,
    flexibleDeployShare:
      allMatchedDeploys > 0 ? round(flexible / allMatchedDeploys, 4) : null,
    skillDaemonRate: round(
      features.filter(item => item.hasSkillDaemon).length / features.length,
      4
    ),
  };
}

function aggregateFeatures(
  features,
  requestedLimit,
  fetchedAt,
  inputMode = "network",
  targetDate = null
) {
  const parsed = features.filter(feature => !feature.parseError);
  const executable = parsed.filter(feature => feature.hasActions);
  const deployable = parsed.filter(feature => feature.hasDeployActions);
  const mapped = parsed.filter(feature => feature.mapMatched);
  const mappedDeployable = deployable.filter(feature => feature.mapMatched);
  const actionTypes = {};
  const directions = {};
  const operatorUse = {};
  const skillChoices = {};
  const skillUsage = {};
  const modules = {};
  const normalizedZones = {};
  const topStages = {};
  const mapErrors = {};
  const conditionCounts = {
    kills: 0,
    cost: 0,
    cooling: 0,
    elapsedTime: 0,
    preDelay: 0,
    postDelay: 0,
  };
  let operatorEntryCount = 0;
  let operatorsWithRequirements = 0;
  let operatorsWithModule = 0;
  let operatorsWithModuleLevel = 0;
  let operatorsWithSkillLevel = 0;

  for (const feature of parsed) {
    increment(topStages, feature.stageName || "Unknown");
    for (const [key, value] of Object.entries(feature.actionTypes)) {
      increment(actionTypes, key, value);
    }
    for (const [key, value] of Object.entries(feature.directions)) {
      increment(directions, key, value);
    }
    for (const name of feature.operatorNames) increment(operatorUse, name);
    for (const [key, value] of Object.entries(feature.requirements.skillChoices)) {
      increment(skillChoices, key, value);
    }
    for (const [key, value] of Object.entries(feature.requirements.skillUsage)) {
      increment(skillUsage, key, value);
    }
    for (const [key, value] of Object.entries(feature.requirements.modules)) {
      increment(modules, key, value);
    }
    for (const key of Object.keys(conditionCounts)) {
      conditionCounts[key] += feature.conditions[key];
    }
    for (const [key, value] of Object.entries(
      feature.deploymentMapFeatures?.normalizedZones || {}
    )) {
      increment(normalizedZones, key, value);
    }
    if (!feature.mapMatched) increment(mapErrors, feature.mapError || "unknown");

    operatorEntryCount +=
      feature.fixedOperCount + feature.groupCandidateCount;
    operatorsWithRequirements += feature.requirements.withRequirements;
    operatorsWithModule += feature.requirements.withModule;
    operatorsWithModuleLevel += feature.requirements.withModuleLevel;
    operatorsWithSkillLevel += feature.requirements.withSkillLevel;
  }

  const flying = mappedDeployable.filter(feature => feature.map.flyingRouteCount > 0);
  const nonFlying = mappedDeployable.filter(
    feature => feature.map.flyingRouteCount === 0
  );
  const boss = mappedDeployable.filter(feature => feature.map.bossTypeCount > 0);
  const nonBoss = mappedDeployable.filter(feature => feature.map.bossTypeCount === 0);
  const withChokepoints = mappedDeployable.filter(
    feature => feature.map.chokepointCount > 0
  );
  const withoutChokepoints = mappedDeployable.filter(
    feature => feature.map.chokepointCount === 0
  );

  return {
    generatedAt: fetchedAt,
    source: {
      site: "https://prts.plus/",
      listApi: `${API_BASE}/copilot/query`,
      detailApi: `${API_BASE}/copilot/get/{id}`,
      ordering: targetDate
        ? "nearest public upload_time to target date, then upload_time descending"
        : "id descending",
      inputMode,
      targetDate,
      requestedLimit,
    },
    sample: {
      fetchedCount: features.length,
      parsedCount: parsed.length,
      failedCount: features.length - parsed.length,
      newestId: parsed[0]?.id || null,
      oldestId: parsed[parsed.length - 1]?.id || null,
      newestUploadTime: parsed[0]?.uploadTime || null,
      oldestUploadTime: parsed[parsed.length - 1]?.uploadTime || null,
      uniqueStageCount: new Set(parsed.map(feature => feature.stageName)).size,
    },
    corpus: {
      executableCount: executable.length,
      executableRate: parsed.length ? round(executable.length / parsed.length, 4) : null,
      deployableCount: deployable.length,
      deployableRate: parsed.length ? round(deployable.length / parsed.length, 4) : null,
      averageFixedOperCount: round(average(parsed.map(item => item.fixedOperCount))),
      medianFixedOperCount: round(median(parsed.map(item => item.fixedOperCount))),
      fixedTwelveCount: parsed.filter(item => item.fixedOperCount === 12).length,
      overTwelveCount: parsed.filter(item => item.fixedOperCount > 12).length,
      groupUsageCount: parsed.filter(item => item.groupCount > 0).length,
      averageActionCount: round(average(parsed.map(item => item.actionCount))),
      medianActionCount: round(median(parsed.map(item => item.actionCount))),
      averageDeployCount: round(average(parsed.map(item => item.deployCount))),
      averageSkillCount: round(average(parsed.map(item => item.skillCount))),
      skillDaemonCount: parsed.filter(item => item.hasSkillDaemon).length,
      speedUpCount: parsed.filter(item => item.hasSpeedUp).length,
    },
    actionStatistics: {
      actionTypes: Object.fromEntries(sortedEntries(actionTypes)),
      deployDirections: Object.fromEntries(sortedEntries(directions)),
      conditionUseCounts: conditionCounts,
    },
    operatorStatistics: {
      operatorEntryCount,
      operatorsWithRequirements,
      operatorsWithModule,
      operatorsWithModuleLevel,
      operatorsWithSkillLevel,
      moduleRate:
        operatorEntryCount > 0
          ? round(operatorsWithModule / operatorEntryCount, 4)
          : null,
      topOperators: sortedEntries(operatorUse, 25).map(([name, count]) => ({
        name,
        count,
      })),
      skillChoices: Object.fromEntries(sortedEntries(skillChoices)),
      skillUsage: Object.fromEntries(sortedEntries(skillUsage)),
      modules: Object.fromEntries(sortedEntries(modules, 25)),
    },
    stageStatistics: {
      topStages: sortedEntries(topStages, 20).map(([stageName, count]) => ({
        stageName,
        count,
      })),
    },
    mapCoverage: {
      matchedOperationCount: mapped.length,
      matchedOperationRate: parsed.length ? round(mapped.length / parsed.length, 4) : null,
      matchedDeployableCount: mappedDeployable.length,
      mapErrors: Object.fromEntries(sortedEntries(mapErrors)),
      totalLocatedDeploys: mappedDeployable.reduce(
        (sum, item) =>
          sum + (item.deploymentMapFeatures?.locatedDeployCount || 0),
        0
      ),
      matchedDeployableActions: mappedDeployable.reduce(
        (sum, item) =>
          sum + (item.deploymentMapFeatures?.matchedDeployableCount || 0),
        0
      ),
      flexibleTileActions: mappedDeployable.reduce(
        (sum, item) =>
          sum + (item.deploymentMapFeatures?.flexibleDeployCount || 0),
        0
      ),
      outOfBoundsActions: mappedDeployable.reduce(
        (sum, item) =>
          sum + (item.deploymentMapFeatures?.outOfBoundsCount || 0),
        0
      ),
      baseNonDeployableActions: mappedDeployable.reduce(
        (sum, item) =>
          sum + (item.deploymentMapFeatures?.baseNonDeployableCount || 0),
        0
      ),
      averageRouteDistance: round(
        average(
          mappedDeployable.map(
            item => item.deploymentMapFeatures?.averageRouteDistance ?? null
          )
        )
      ),
      averageBlueBoxDistance: round(
        average(
          mappedDeployable.map(
            item => item.deploymentMapFeatures?.averageBlueBoxDistance ?? null
          )
        )
      ),
      averageChokepointDistance: round(
        average(
          mappedDeployable.map(
            item => item.deploymentMapFeatures?.averageChokepointDistance ?? null
          )
        )
      ),
      normalizedDeployZones: Object.fromEntries(sortedEntries(normalizedZones)),
    },
    mapComparisons: {
      flyingRoutes: {
        withFlyingRoutes: summarizeSubset(flying),
        withoutFlyingRoutes: summarizeSubset(nonFlying),
      },
      bossPresence: {
        withBoss: summarizeSubset(boss),
        withoutBoss: summarizeSubset(nonBoss),
      },
      chokepoints: {
        withChokepoints: summarizeSubset(withChokepoints),
        withoutChokepoints: summarizeSubset(withoutChokepoints),
      },
    },
    caveats: [
      "The sample is the latest ID-descending time slice, not a representative random sample.",
      "PRTS Plus list responses omit actions, so each public detail endpoint was queried.",
      "MAA locations are interpreted as [x, y] and converted to MapData { row: y, col: x }.",
      "Map matching and enemy attributes depend on the local PRTS.Map index and cached data.",
      "Statistics describe published script patterns and do not prove stage clearability.",
    ],
    projectFindings: {
      allTileDeployCount: mappedDeployable.reduce(
        (sum, item) =>
          sum + (item.deploymentMapFeatures?.flexibleDeployCount || 0),
        0
      ),
      baseNonDeployableActionCount: mappedDeployable.reduce(
        (sum, item) =>
          sum + (item.deploymentMapFeatures?.baseNonDeployableCount || 0),
        0
      ),
      bossOperationCount: boss.length,
      notes: [
        "PRTS.Map buildableType ALL is deployable, but the current core adapter normalizes it to none.",
        "The enemy database identifies bosses with levelType BOSS; enemyTags does not contain a boss tag.",
        "Deployments on base NONE tiles may be enabled by stage runes or special mechanics and must not be rejected without dynamic map context.",
        "Public scripts often use small fixed rosters and groups, which should not override MAAfight's personalized fixed-12 export contract.",
      ],
    },
  };
}

function percent(value) {
  return value === null || value === undefined
    ? "-"
    : `${round(value * 100, 1)}%`;
}

function numberOrDash(value) {
  return value === null || value === undefined ? "-" : String(value);
}

function markdownTable(headers, rows) {
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(row => `| ${row.join(" | ")} |`).join("\n");
  return [header, separator, body].filter(Boolean).join("\n");
}

function buildMarkdown(stats) {
  const topActions = Object.entries(stats.actionStatistics.actionTypes).slice(0, 12);
  const topOperators = stats.operatorStatistics.topOperators.slice(0, 15);
  const topStages = stats.stageStatistics.topStages.slice(0, 15);
  const comparisons = stats.mapComparisons;

  const sampleTitle = stats.source.targetDate
    ? `${stats.source.targetDate} 前后作业`
    : "最新作业";
  const selectionDescription = stats.source.targetDate
    ? `按公开 upload_time 距 ${stats.source.targetDate} 的时间差选择最近 ${stats.sample.fetchedCount} 份`
    : `按公开作业 ID 倒序读取最新 ${stats.sample.fetchedCount} 份`;

  return `# PRTS Plus ${sampleTitle}特征统计

生成时间：${stats.generatedAt}

数据范围：${selectionDescription}，ID ${numberOrDash(
    stats.sample.oldestId
  )} - ${numberOrDash(stats.sample.newestId)}。

## 样本概况

- 成功解析：${stats.sample.parsedCount} / ${stats.sample.fetchedCount}
- 涉及关卡：${stats.sample.uniqueStageCount} 个
- 含动作的可执行作业：${stats.corpus.executableCount}（${percent(
    stats.corpus.executableRate
  )}）
- 含部署动作的作业：${stats.corpus.deployableCount}（${percent(
    stats.corpus.deployableRate
  )}）
- 地图匹配：${stats.mapCoverage.matchedOperationCount}（${percent(
    stats.mapCoverage.matchedOperationRate
  )}）

> 注意：这是时间切片，可能被当期活动、肉鸽或视频作业集中影响，不能直接视为全站分布。公开 upload_time 会在作业更新时变化，不等同于首次上传时间。

## 编队与动作

- 固定干员数：平均 ${numberOrDash(
    stats.corpus.averageFixedOperCount
  )}，中位数 ${numberOrDash(stats.corpus.medianFixedOperCount)}
- 恰好 12 名固定干员：${stats.corpus.fixedTwelveCount} 份
- 使用 groups：${stats.corpus.groupUsageCount} 份
- 动作数：平均 ${numberOrDash(
    stats.corpus.averageActionCount
  )}，中位数 ${numberOrDash(stats.corpus.medianActionCount)}
- 部署动作：平均 ${numberOrDash(stats.corpus.averageDeployCount)}
- 技能动作：平均 ${numberOrDash(stats.corpus.averageSkillCount)}
- 使用 SkillDaemon：${stats.corpus.skillDaemonCount} 份

${markdownTable(
  ["动作类型", "次数"],
  topActions.map(([name, count]) => [name, String(count)])
)}

## 干员配置

- 干员 / 候选条目：${stats.operatorStatistics.operatorEntryCount}
- 带 requirements：${stats.operatorStatistics.operatorsWithRequirements}
- 明确指定模组：${stats.operatorStatistics.operatorsWithModule}（占全部条目 ${percent(
    stats.operatorStatistics.moduleRate
  )}）
- 指定模组等级：${stats.operatorStatistics.operatorsWithModuleLevel}
- 指定技能等级：${stats.operatorStatistics.operatorsWithSkillLevel}

${markdownTable(
  ["常见干员", "出现作业数"],
  topOperators.map(item => [item.name, String(item.count)])
)}

## 热门关卡

${markdownTable(
  ["关卡 ID", "作业数"],
  topStages.map(item => [item.stageName, String(item.count)])
)}

## 地图联动

- 可定位部署动作：${stats.mapCoverage.totalLocatedDeploys}
- 命中可部署格：${stats.mapCoverage.matchedDeployableActions}
- 其中 ALL 通用部署格：${stats.mapCoverage.flexibleTileActions}
- 越界部署坐标：${stats.mapCoverage.outOfBoundsActions}
- 静态底图为 NONE 的部署：${stats.mapCoverage.baseNonDeployableActions}
- 部署点到最近敌人路径平均距离：${numberOrDash(
    stats.mapCoverage.averageRouteDistance
  )} 格
- 部署点到蓝门平均距离：${numberOrDash(
    stats.mapCoverage.averageBlueBoxDistance
  )} 格
- 部署点到隘口平均距离：${numberOrDash(
    stats.mapCoverage.averageChokepointDistance
  )} 格

坐标口径：MAA location 按 [x, y] 解释，地图内部转换为 { row: y, col: x }。

${markdownTable(
  [
    "地图条件",
    "样本数",
    "平均部署数",
    "远程格占已定类型格比例",
    "ALL 格比例",
    "SkillDaemon 使用率",
  ],
  [
    [
      "含飞行路线",
      comparisons.flyingRoutes.withFlyingRoutes.operationCount,
      numberOrDash(comparisons.flyingRoutes.withFlyingRoutes.averageDeployCount),
      percent(comparisons.flyingRoutes.withFlyingRoutes.rangedDeployShare),
      percent(comparisons.flyingRoutes.withFlyingRoutes.flexibleDeployShare),
      percent(comparisons.flyingRoutes.withFlyingRoutes.skillDaemonRate),
    ],
    [
      "无飞行路线",
      comparisons.flyingRoutes.withoutFlyingRoutes.operationCount,
      numberOrDash(comparisons.flyingRoutes.withoutFlyingRoutes.averageDeployCount),
      percent(comparisons.flyingRoutes.withoutFlyingRoutes.rangedDeployShare),
      percent(comparisons.flyingRoutes.withoutFlyingRoutes.flexibleDeployShare),
      percent(comparisons.flyingRoutes.withoutFlyingRoutes.skillDaemonRate),
    ],
    [
      "含 Boss",
      comparisons.bossPresence.withBoss.operationCount,
      numberOrDash(comparisons.bossPresence.withBoss.averageDeployCount),
      percent(comparisons.bossPresence.withBoss.rangedDeployShare),
      percent(comparisons.bossPresence.withBoss.flexibleDeployShare),
      percent(comparisons.bossPresence.withBoss.skillDaemonRate),
    ],
    [
      "无 Boss",
      comparisons.bossPresence.withoutBoss.operationCount,
      numberOrDash(comparisons.bossPresence.withoutBoss.averageDeployCount),
      percent(comparisons.bossPresence.withoutBoss.rangedDeployShare),
      percent(comparisons.bossPresence.withoutBoss.flexibleDeployShare),
      percent(comparisons.bossPresence.withoutBoss.skillDaemonRate),
    ],
  ]
)}

## 对 MAAfight 的直接启发

1. 将“是否恰好 12 人”“是否使用 groups”“模组指定率”作为生成器输出契约的持续回归指标。
2. 将真实作业的动作数量、部署数量、技能动作比例用于校准规则生成器，避免只比较 JSON 是否合法。
3. 将部署点到路径、蓝门和隘口的距离分布作为 v2 点位评分基线，但只用于候选排序。
4. 按飞行路线、Boss、隘口等地图条件分桶比较，避免从全局平均值直接推导单一规则。
5. 先积累多个时间切片再固化权重；本次 100 份样本只适合作为探索性基线。

## 发现的现有适配缺口

1. PRTS.Map 的 buildableType 除 MELEE / RANGED 外还有 ALL。本样本有 ${
    stats.projectFindings.allTileDeployCount
  } 次部署落在 ALL 格；当前核心适配器会把这类格子归为 none，可能导致部署点遗漏。
2. 敌人库以 levelType: BOSS 标识 Boss，而不是 enemyTags 中的 boss。本样本有 ${
    stats.projectFindings.bossOperationCount
  } 份地图匹配作业包含 Boss，当前核心判断可能低估 Boss 压力。
3. 公开作业常用少量固定干员和 groups，是为了通用替换；MAAfight 已有玩家干员库，因此不应机械模仿这一分布，也不应放弃 fixed 12 的导出约束。
4. 静态底图为 NONE 的部署共有 ${
    stats.projectFindings.baseNonDeployableActionCount
  } 次。关卡 rune 或特殊机制可能动态开放格子，不能仅凭基础 tile 判定作业非法。

## 本地语料与边界

- 完整公开 copilot JSON 保存在 corpus 目录，供后续离线特征提取和回归分析。
- manifest 只保留作业 ID、上传时间、关卡 ID 和本地文件名，不保存上传者信息。
- 统计特征不构成脚本可通关证明。
- 地图无法匹配时保留作业级特征并记录降级原因。
`;
}

function sanitizeFeatureForOutput(feature) {
  const copy = { ...feature };
  delete copy.deployLocations;
  return copy;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(path.resolve("dist", "loader", "levelIndex.js"))) {
    throw new Error("dist is missing; run npm run build:node first");
  }

  const fetchedAt = new Date().toISOString();
  const savedSnapshot = options.reuseCorpus
    ? loadSnapshotMetadata(options.outputDir)
    : null;
  const effectiveTargetDate = options.aroundDate || savedSnapshot?.targetDate || null;
  const operations = options.reuseCorpus
    ? loadOperationsFromCorpus(options.outputDir, options.limit)
    : options.aroundDate
      ? await fetchOperationsAroundDate(options.limit, options.aroundDate)
      : await fetchLatestOperations(options.limit);
  if (options.reuseCorpus) {
    console.error(`Loaded ${operations.length} operations from the local corpus`);
  }
  const features = operations.map(extractOperationFeatures);
  const stageNames = [
    ...new Set(
      features
        .filter(feature => !feature.parseError && feature.stageName)
        .map(feature => feature.stageName)
    ),
  ];

  console.error(`Resolving ${stageNames.length} unique stage maps...`);
  const mapResults = await loadMapMetrics(stageNames);
  const joinedFeatures = features.map(feature => {
    if (feature.parseError) return feature;
    return {
      ...feature,
      ...joinOperationWithMap(feature, mapResults.get(feature.stageName)),
    };
  });
  const stats = aggregateFeatures(
    joinedFeatures,
    options.limit,
    fetchedAt,
    options.reuseCorpus
      ? "local-corpus"
      : options.aroundDate
        ? "network-around-date"
        : "network-latest",
    effectiveTargetDate
  );

  fs.mkdirSync(options.outputDir, { recursive: true });
  const corpusDir = path.join(options.outputDir, "corpus");
  fs.mkdirSync(corpusDir, { recursive: true });
  const currentManifest = [];
  for (const operation of operations) {
    if (!operation.content) continue;
    const fileName = `${operation.id}.json`;
    fs.writeFileSync(
      path.join(corpusDir, fileName),
      `${JSON.stringify(operation.content, null, 2)}\n`,
      "utf8"
    );
    currentManifest.push({
      id: operation.id,
      uploadTime: operation.uploadTime,
      stageName:
        typeof operation.content.stage_name === "string"
          ? operation.content.stage_name
          : null,
      file: `corpus/${fileName}`,
    });
  }
  const manifestPath = path.join(options.outputDir, "manifest.json");
  let previousManifest = [];
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (Array.isArray(parsed)) previousManifest = parsed;
    } catch {
      previousManifest = [];
    }
  }
  const currentIds = new Set(currentManifest.map(entry => entry.id));
  const manifest = [
    ...currentManifest,
    ...previousManifest.filter(entry => !currentIds.has(entry.id)),
  ];
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(options.outputDir, "snapshot.json"),
    `${JSON.stringify(
      {
        selectedAt: fetchedAt,
        selectionMode: effectiveTargetDate ? "around-date" : "latest",
        targetDate: effectiveTargetDate,
        sampleIds: operations.map(operation => operation.id),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(options.outputDir, "features.json"),
    `${JSON.stringify(joinedFeatures.map(sanitizeFeatureForOutput), null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(options.outputDir, "stats.json"),
    `${JSON.stringify(stats, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(options.outputDir, "summary.md"),
    buildMarkdown(stats),
    "utf8"
  );

  console.error(`Wrote ${options.outputDir}`);
  console.log(JSON.stringify(stats.sample));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  aggregateFeatures,
  buildMapMetrics,
  extractOperationFeatures,
  joinOperationWithMap,
  parseArgs,
  selectClosestOperations,
};
