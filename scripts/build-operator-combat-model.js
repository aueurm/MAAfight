#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "operator-combat-builder-v2.1";
const TABLES = [
  "character_table",
  "skill_table",
  "range_table",
  "uniequip_table",
  "battle_equip_table",
];
const ROLE_BY_PROFESSION = {
  PIONEER: "vanguard",
  WARRIOR: "guard",
  TANK: "tank",
  SNIPER: "sniper",
  CASTER: "caster",
  MEDIC: "medic",
  SUPPORT: "support",
  SPECIAL: "specialist",
};
const EFFECT_KEYS = new Set([
  "atk", "attack_speed", "base_attack_time", "atk_scale", "attack@atk_scale",
  "damage_scale", "times", "attack_times", "max_target", "max_target_count",
  "attack@max_target", "chain.max_target",
  "heal_scale", "def", "max_hp", "magic_resistance", "duration",
  "stun", "stun_duration", "slow_duration", "bind_duration", "sleep",
]);
const IGNORED_KEYS = new Set([
  "id", "token", "prob", "probability", "display", "value", "count", "cnt",
  "cost", "interval", "duration_extend", "max_stack_cnt", "taunt_level",
]);

function parseArgs(argv) {
  const options = { gameData: "", output: "src/data/operatorCombat.v2.json", commit: "" };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--game-data") options.gameData = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else if (argv[index] === "--commit") options.commit = argv[++index];
  }
  if (!options.gameData) throw new Error("--game-data <excel directory> is required");
  if (!/^[a-f0-9]{40}$/i.test(options.commit)) throw new Error("--commit must be a full 40-character commit SHA");
  return options;
}

function number(value, fallback = 0) {
  if (value && typeof value === "object" && "m_value" in value) return Number(value.m_value) || fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function digest(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function sortedObject(entries) {
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function phaseNumber(value) {
  const match = String(value || "").match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function rarityNumber(value) {
  const match = String(value || "").match(/(\d+)$/);
  return match ? Number(match[1]) : number(value);
}

function attributes(data = {}) {
  return {
    hp: number(data.maxHp),
    atk: number(data.atk),
    def: number(data.def),
    res: number(data.magicResistance),
    cost: number(data.cost),
    block: number(data.blockCnt, 1),
    attackInterval: number(data.baseAttackTime, 1),
    attackSpeed: number(data.attackSpeed, 100),
  };
}

function addAttributes(base, bonus) {
  return {
    hp: base.hp + bonus.hp,
    atk: base.atk + bonus.atk,
    def: base.def + bonus.def,
    res: base.res + bonus.res,
    cost: base.cost,
    block: base.block,
    attackInterval: base.attackInterval,
    attackSpeed: base.attackSpeed,
  };
}

function blackboardValues(blackboard) {
  const effects = {};
  const gaps = [];
  for (const item of Array.isArray(blackboard) ? blackboard : []) {
    const key = String(item?.key || "").toLowerCase();
    if (!key) continue;
    if (EFFECT_KEYS.has(key)) effects[key] = number(item.value);
    else if (!IGNORED_KEYS.has(key)) gaps.push(`unsupported:${key}`);
  }
  return { effects: sortedObject(Object.entries(effects)), gaps: [...new Set(gaps)].sort() };
}

function metrics(base, role, effects, spData, duration) {
  const normalInterval = Math.max(0.1, base.attackInterval * 100 / Math.max(1, base.attackSpeed));
  const normalDps = role === "medic" ? 0 : base.atk / normalInterval;
  const normalHps = role === "medic" ? base.atk / normalInterval : 0;
  const atkMultiplier = Math.max(0.1, Math.min(6,
    1 + number(effects.atk) + Math.max(0, number(effects.atk_scale) - 1)
      + Math.max(0, number(effects["attack@atk_scale"]) - 1)
  ));
  const skillAttackSpeed = Math.max(1, base.attackSpeed + number(effects.attack_speed));
  const skillBaseTime = Math.max(0.25, base.attackInterval + number(effects.base_attack_time));
  const skillInterval = Math.max(0.1, skillBaseTime * 100 / skillAttackSpeed);
  const damageScale = number(effects.damage_scale, 1);
  const hits = Math.max(1, Math.min(5, number(effects.times, number(effects.attack_times, 1))));
  const baseThroughput = base.atk / normalInterval;
  const skillPerSecond = Math.min(baseThroughput * 8, base.atk * atkMultiplier * damageScale * hits / skillInterval);
  const burstDps = role === "medic" ? 0 : skillPerSecond;
  const healingHps = role === "medic" || effects.heal_scale !== undefined
    ? skillPerSecond * number(effects.heal_scale, 1)
    : 0;
  const remainingSp = Math.max(0, number(spData.spCost) - number(spData.initSp));
  let rechargeSeconds = null;
  if (spData.spType === "INCREASE_WITH_TIME") rechargeSeconds = remainingSp / Math.max(0.01, number(spData.increment, 1));
  if (spData.spType === "INCREASE_WHEN_ATTACK") rechargeSeconds = remainingSp * normalInterval;
  const cycleDps = rechargeSeconds === null
    ? null
    : (burstDps * Math.max(0, duration) + normalDps * rechargeSeconds) / Math.max(0.1, duration + rechargeSeconds);
  const controlSeconds = Math.max(
    number(effects.stun), number(effects.stun_duration), number(effects.slow_duration),
    number(effects.bind_duration), number(effects.sleep)
  );
  return {
    normalDps: Number(normalDps.toFixed(4)),
    burstDps: Number(burstDps.toFixed(4)),
    cycleDps: cycleDps === null ? null : Number(cycleDps.toFixed(4)),
    healingHps: Number(Math.max(normalHps, healingHps).toFixed(4)),
    physicalEhp: Number((base.hp * 1000 / Math.max(50, 1000 - base.def)).toFixed(4)),
    artsEhp: Number((base.hp / Math.max(0.05, 1 - base.res / 100)).toFixed(4)),
    controlSeconds,
  };
}

function compileSkill(skillRef, skillTable, base, role) {
  const source = skillTable[skillRef.skillId];
  if (!source || !Array.isArray(source.levels) || source.levels.length === 0) {
    return {
      id: skillRef.skillId,
      unlockPhase: phaseNumber(skillRef.unlockCond?.phase),
      levels: [],
      modelCoverageGaps: ["missing_skill_table_entry"],
    };
  }
  const levels = source.levels.map((level, index) => {
    const parsed = blackboardValues(level.blackboard);
    const spData = level.spData || {};
    const duration = Math.max(0, number(level.duration));
    const gaps = [...parsed.gaps];
    if (spData.spType === "INCREASE_WHEN_TAKEN_DAMAGE") gaps.push("defensive_sp_cycle_unknown");
    const maxTargets = Math.max(1, number(parsed.effects.max_target,
      number(parsed.effects.max_target_count,
        number(parsed.effects["attack@max_target"], number(parsed.effects["chain.max_target"], 1)))));
    return {
      rank: index + 1,
      skillType: level.skillType || "UNKNOWN",
      durationType: level.durationType || "UNKNOWN",
      spType: spData.spType || "UNKNOWN",
      spCost: number(spData.spCost),
      initSp: number(spData.initSp),
      duration,
      rangeId: level.rangeId || null,
      maxTargets,
      effects: parsed.effects,
      metrics: metrics(base, role, parsed.effects, spData, duration),
      confidence: gaps.length ? "partial" : "exact",
      modelCoverageGaps: [...new Set(gaps)].sort(),
    };
  });
  return {
    id: skillRef.skillId,
    unlockPhase: phaseNumber(skillRef.unlockCond?.phase),
    levels,
    modelCoverageGaps: [],
  };
}

function compileTalents(character) {
  return (character.talents || []).map((talent, index) => {
    const candidates = (talent.candidates || [])
      .filter(candidate => phaseNumber(candidate.unlockCondition?.phase) <= 2)
      .map(candidate => {
        const parsed = blackboardValues(candidate.blackboard);
        return {
          unlockPhase: phaseNumber(candidate.unlockCondition?.phase),
          requiredPotentialRank: number(candidate.requiredPotentialRank),
          prefabKey: candidate.prefabKey || null,
          rangeId: candidate.rangeId || null,
          effects: parsed.effects,
          confidence: parsed.gaps.length ? "partial" : "exact",
          modelCoverageGaps: parsed.gaps,
        };
      });
    return { index: index + 1, candidates };
  });
}

function compileModules(characterId, equipDict, battleEquipTable) {
  return Object.values(equipDict || {})
    .filter(equip => equip?.charId === characterId && equip.type === "ADVANCED")
    .sort((left, right) => number(left.charEquipOrder) - number(right.charEquipOrder) || left.uniEquipId.localeCompare(right.uniEquipId))
    .map(equip => {
      const battle = battleEquipTable[equip.uniEquipId];
      const levels = (battle?.phases || []).map(phase => {
        const parsed = blackboardValues(phase.attributeBlackboard);
        const complex = (phase.parts || []).length > 0;
        return {
          level: number(phase.equipLevel),
          attributes: parsed.effects,
          confidence: complex || parsed.gaps.length ? "partial" : "exact",
          modelCoverageGaps: [...parsed.gaps, ...(complex ? ["complex_module_parts"] : [])].sort(),
        };
      });
      return { id: equip.uniEquipId, index: number(equip.charEquipOrder), levels };
    });
}

function compileOperator(id, character, tables) {
  const role = ROLE_BY_PROFESSION[character.profession];
  const phase = character.phases?.[2];
  const frames = phase?.attributesKeyFrames || [];
  if (!role || !phase || frames.length === 0) return null;
  const minimum = attributes(frames[0].data);
  const maximum = attributes(frames.at(-1).data);
  const trust = attributes(character.favorKeyFrames?.at(-1)?.data || {});
  const reference = addAttributes(maximum, trust);
  const baseRangeId = phase.rangeId || null;
  const skills = (character.skills || []).map(skill => compileSkill(skill, tables.skill_table, reference, role));
  const baseMetrics = metrics(reference, role, {}, { spType: "UNKNOWN", spCost: 0, initSp: 0 }, 0);
  return {
    id,
    name: character.name,
    role,
    profession: character.profession,
    subProfession: character.subProfessionId || null,
    position: character.position || "UNKNOWN",
    rarity: rarityNumber(character.rarity),
    e2: {
      minLevel: number(frames[0].level, 1),
      maxLevel: number(phase.maxLevel, number(frames.at(-1).level, 1)),
      rangeId: baseRangeId,
      min: minimum,
      max: maximum,
      trust,
      reference,
    },
    damageType: role === "caster" || role === "support" ? "arts" : role === "medic" ? "heal" : "physical",
    baseMetrics,
    skills,
    talents: compileTalents(character),
    modules: compileModules(id, tables.uniequip_table.equipDict, tables.battle_equip_table),
    modelCoverageGaps: character.displayTokenDict ? ["summon_or_token"] : [],
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawTables = {};
  const tables = {};
  const tableHashes = {};
  for (const tableName of TABLES) {
    const filePath = path.resolve(options.gameData, `${tableName}.json`);
    if (!fs.existsSync(filePath)) throw new Error(`${tableName}.json not found: ${filePath}`);
    const raw = fs.readFileSync(filePath, "utf8");
    rawTables[tableName] = raw;
    tables[tableName] = JSON.parse(raw);
    tableHashes[tableName] = digest(raw);
  }

  const operators = {};
  const nameIndex = {};
  for (const [id, character] of Object.entries(tables.character_table).sort(([left], [right]) => left.localeCompare(right))) {
    if (!character?.name || character.profession === "TOKEN") continue;
    const compiled = compileOperator(id, character, tables);
    if (!compiled) continue;
    operators[id] = compiled;
    nameIndex[compiled.name] = id;
  }
  const ranges = sortedObject(Object.entries(tables.range_table).map(([id, range]) => [
    id,
    (range.grids || []).map(grid => [number(grid.row), number(grid.col)]),
  ]));
  const identity = digest(JSON.stringify({ builderVersion: BUILDER_VERSION, commit: options.commit, tableHashes }));
  const model = {
    schemaVersion: 2,
    builderVersion: BUILDER_VERSION,
    modelVersion: `operator-combat-v2-${identity.slice(0, 16)}`,
    source: {
      repository: "Kengxxiao/ArknightsGameData",
      commit: options.commit.toLowerCase(),
      tableHashes: sortedObject(Object.entries(tableHashes)),
      exactOperatorCount: Object.keys(operators).length,
    },
    assumptions: {
      referenceProfile: "e2-max-s10-p1-no-module-max-trust",
      physicalEhpIncomingAttack: 1000,
      skillActivation: "as-soon-as-ready",
      attackRecovery: "every-attack-hits",
    },
    ranges,
    nameIndex: sortedObject(Object.entries(nameIndex)),
    operators: sortedObject(Object.entries(operators)),
  };
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(model)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, modelVersion: model.modelVersion, operatorCount: Object.keys(operators).length })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
