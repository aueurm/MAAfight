#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const options = { gameData: "", output: "src/data/operatorCombat.v1.json", commit: "unknown" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--game-data") options.gameData = argv[++i];
    else if (argv[i] === "--output") options.output = argv[++i];
    else if (argv[i] === "--commit") options.commit = argv[++i];
  }
  if (!options.gameData) throw new Error("--game-data <excel directory> is required");
  return options;
}

function defined(value, fallback = 0) {
  if (value && typeof value === "object" && "m_value" in value) return Number(value.m_value) || fallback;
  return Number(value) || fallback;
}

function keyFrameStats(character) {
  const phases = Array.isArray(character.phases) ? character.phases : [];
  return phases.map((phase, elite) => {
    const frames = phase.attributesKeyFrames || [];
    const first = frames[0]?.data || {};
    const last = frames[frames.length - 1]?.data || {};
    return {
      elite,
      minLevel: frames[0]?.level || 1,
      maxLevel: phase.maxLevel || frames[frames.length - 1]?.level || 1,
      min: {
        hp: defined(first.maxHp),
        atk: defined(first.atk),
        def: defined(first.def),
        res: defined(first.magicResistance),
      },
      hp: defined(last.maxHp),
      atk: defined(last.atk),
      def: defined(last.def),
      res: defined(last.magicResistance),
      attackInterval: defined(last.baseAttackTime, 1),
      block: defined(last.blockCnt, 1),
    };
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const characterPath = path.resolve(options.gameData, "character_table.json");
  if (!fs.existsSync(characterPath)) throw new Error(`character_table.json not found: ${characterPath}`);
  const table = JSON.parse(fs.readFileSync(characterPath, "utf8"));
  const operators = {};
  for (const [id, character] of Object.entries(table)) {
    if (!character || character.profession === "TOKEN" || !character.name) continue;
    operators[character.name] = {
      id,
      profession: character.profession,
      rarity: Number(character.rarity || 0),
      phases: keyFrameStats(character),
      rangeIds: (character.phases || []).map(phase => phase.rangeId).filter(Boolean),
      coverageGaps: ["trust", "potential", "module", "complex_skill", "talent"],
    };
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(characterPath)).digest("hex").slice(0, 16);
  const fallback = JSON.parse(fs.readFileSync(path.resolve("src/data/operatorCombat.v1.json"), "utf8"));
  const model = {
    ...fallback,
    modelVersion: `operator-combat-v1-${digest}`,
    source: { kind: "game-data-snapshot", commit: options.commit, characterTableHash: digest, exactOperatorCount: Object.keys(operators).length },
    operators,
  };
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(model, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, modelVersion: model.modelVersion, operatorCount: Object.keys(operators).length })}\n`);
}

if (require.main === module) main();
