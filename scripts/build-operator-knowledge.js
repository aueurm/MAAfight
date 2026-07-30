#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RULE_VERSION = "description-tags-v1";
const VECTOR_AXES = [
  "frontline", "ranged", "physical", "arts", "healing", "burst",
  "area", "control", "antiAir", "rangeCoverage", "skillRangeChange", "mobility",
];
const TAG_RULES = [
  ["healing", /治疗|回复[^。；，]{0,20}生命|恢复[^。；，]{0,20}生命/],
  ["control", /眩晕|束缚|冻结|睡眠|停顿|击退|拖拽/],
  ["area", /攻击范围内(?:所有|的所有)|多个目标|额外攻击/],
  ["anti-air", /飞行|空中单位/],
  ["frontline", /阻挡数|防御力|护盾|嘲讽/],
  ["burst", /立即|大幅|攻击力|攻击速度/],
];

function parseArgs(argv) {
  const options = { gameData: "", combatModel: "", output: "src/data/operatorKnowledge.generated.v1.json", commit: "" };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--game-data") options.gameData = argv[++index];
    else if (argv[index] === "--combat-model") options.combatModel = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else if (argv[index] === "--commit") options.commit = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.gameData) throw new Error("--game-data <excel directory> is required");
  if (!options.combatModel) throw new Error("--combat-model <operator combat model> is required");
  if (!/^[a-f0-9]{40}$/i.test(options.commit)) throw new Error("--commit must be a full 40-character commit SHA");
  return options;
}

function cleanDescription(value) {
  return String(value || "").replace(/<[^>]+>/g, "").replace(/\{[^}]+\}/g, "").replace(/\s+/g, " ").trim();
}

function tagsForDescription(description) {
  const tags = TAG_RULES.filter(([, pattern]) => pattern.test(description)).map(([tag]) => tag);
  if (/攻击范围\s*(?:扩大|增加|[+＋])/.test(description)) tags.push("range-extension");
  else if (/攻击范围\s*(?:缩小|减少|[-－])/.test(description)) tags.push("range-contraction");
  else if (/攻击范围\s*改变/.test(description)) tags.push("range-change");
  return [...new Set(tags)].sort();
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function rounded(value) {
  return Number(clamp(value).toFixed(4));
}

function maximum(values) {
  return Math.max(0, ...values.map(value => Number(value) || 0));
}

function rangeBehavior(tags, operator, rangeIds) {
  const changes = new Set(tags.filter(tag => tag.startsWith("range-")).map(tag => tag === "range-extension" ? "extends" : tag === "range-contraction" ? "contracts" : "changes"));
  if (changes.size === 0 && rangeIds.some(rangeId => rangeId && rangeId !== operator.e2?.rangeId)) changes.add("changes");
  return changes.size === 1 ? [...changes][0] : changes.size > 1 ? "changes" : "unchanged";
}

function positionEffect(descriptions) {
  if (descriptions.some(description => /距离/.test(description))) return "distance-scaling";
  if (descriptions.some(description => /周围|相邻/.test(description))) return "adjacent";
  if (descriptions.some(description => /攻击范围内/.test(description))) return "range-bound";
  return undefined;
}

function skillDescriptions(character, skillTable) {
  return (character.skills || []).map((skill, index) => {
    const description = cleanDescription(skillTable[skill.skillId]?.levels?.at(-1)?.description);
    return { index: index + 1, description, tags: tagsForDescription(description) };
  });
}

function buildOperatorKnowledge(operator, character, skillTable, ranges) {
  const describedSkills = skillDescriptions(character, skillTable);
  const tags = [...new Set(describedSkills.flatMap(skill => skill.tags))].sort();
  const levels = (operator.skills || []).flatMap(skill => skill.levels || []);
  const allMetrics = [operator.baseMetrics || {}, ...levels.map(level => level.metrics || {})];
  const rangeIds = [operator.e2?.rangeId, ...levels.map(level => level.rangeId)];
  const maxRangeCells = maximum(rangeIds.map(rangeId => ranges[rangeId]?.length || 0));
  const maxTargets = maximum(levels.map(level => level.maxTargets));
  const behavior = rangeBehavior(tags, operator, rangeIds);
  const effect = positionEffect(describedSkills.map(skill => skill.description));
  const capabilities = tags.filter(tag => !tag.startsWith("range-"));
  const vector = [
    Number(operator.position === "MELEE"),
    Number(operator.position === "RANGED"),
    Number(operator.damageType === "physical"),
    Number(operator.damageType === "arts"),
    rounded(maximum(allMetrics.map(metrics => metrics.healingHps)) / 1000),
    rounded(Math.max(0, maximum(allMetrics.map(metrics => metrics.burstDps)) - maximum(allMetrics.map(metrics => metrics.normalDps))) / 3000),
    rounded((maxTargets - 1) / 4),
    rounded(maximum(allMetrics.map(metrics => metrics.controlSeconds)) / 6),
    Number(tags.includes("anti-air")),
    rounded(maxRangeCells / 12),
    Number(behavior !== "unchanged"),
    rounded(1 - (Number(operator.respawnTime) || 70) / 100),
  ];
  const capabilityAxis = { healing: 4, burst: 5, area: 6, control: 7, "anti-air": 8, frontline: 0 };
  for (const capability of capabilities) if (capabilityAxis[capability] !== undefined) vector[capabilityAxis[capability]] = 1;
  const skills = Object.fromEntries(describedSkills.filter(skill => skill.tags.length).map(skill => [skill.index, { tags: skill.tags }]));
  const spatial = {
    ...(tags.includes("area") || maxTargets > 1 ? { attackPattern: "area" } : {}),
    ...(/整个战场|全场|全地图/.test(describedSkills.map(skill => skill.description).join(" ")) ? { coverage: "global" }
      : effect === "adjacent" ? { coverage: "adjacent" } : behavior === "extends" ? { coverage: "extended-range" } : {}),
    ...(behavior !== "unchanged" ? { skillRangeBehavior: behavior } : {}),
    ...(effect ? { positionEffect: effect } : {}),
  };
  return {
    id: operator.id,
    name: operator.name,
    ...(capabilities.length ? { capabilities } : {}),
    ...(Object.keys(spatial).length ? { spatial } : {}),
    ...(Object.keys(skills).length ? { skills } : {}),
    vector: vector.map(rounded),
  };
}

function buildKnowledge({ characterTable, skillTable, combatModel, commit }) {
  if (combatModel?.source?.commit?.toLowerCase() !== commit.toLowerCase()) throw new Error("Combat model commit does not match requested source");
  const operators = Object.values(combatModel.operators || {}).sort((left, right) => left.id.localeCompare(right.id)).map(operator => {
    const character = characterTable[operator.id];
    if (!character) throw new Error(`Character table entry is missing for ${operator.id}`);
    return buildOperatorKnowledge(operator, character, skillTable, combatModel.ranges || {});
  });
  const identity = crypto.createHash("sha256").update(JSON.stringify({ RULE_VERSION, commit: commit.toLowerCase(), combatModel: combatModel.modelVersion, operators })).digest("hex");
  return {
    schemaVersion: 1,
    modelVersion: `operator-knowledge-generated-v1-${identity.slice(0, 16)}`,
    source: {
      repository: "Kengxxiao/ArknightsGameData",
      commit: commit.toLowerCase(),
      ruleVersion: RULE_VERSION,
      operatorCount: operators.length,
    },
    vectorAxes: VECTOR_AXES,
    operators,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const characterTable = JSON.parse(fs.readFileSync(path.resolve(options.gameData, "character_table.json"), "utf8"));
  const skillTable = JSON.parse(fs.readFileSync(path.resolve(options.gameData, "skill_table.json"), "utf8"));
  const combatModel = JSON.parse(fs.readFileSync(path.resolve(options.combatModel), "utf8"));
  const knowledge = buildKnowledge({ characterTable, skillTable, combatModel, commit: options.commit });
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(knowledge)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, modelVersion: knowledge.modelVersion, operatorCount: knowledge.operators.length })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildKnowledge, cleanDescription, tagsForDescription };
