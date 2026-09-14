#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "operator-combat-builder-v2.5";
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

function durationMeaning(level) {
  if (level.durationType === "AMMO") return { semantics: "ammo", evidence: "durationType:AMMO" };
  if (number(level.duration) > 0) return { semantics: "finite", evidence: "positive_raw_duration" };
  const sourceDescription = String(level.description || "");
  const description = sourceDescription.replace(/<[^>]*>/g, "").replace(/\\n|\s/g, "");
  // GameData uses both zero and negative durations for one-shot and indefinite skills.
  // Only explicit source text establishes an indefinite active state; conditional expiry stays unknown.
  if (/<@ba\.rem>(?:技能)?持续时间无限(?:<\/\>|[，,；;])/.test(sourceDescription)
    && !/技能(?:立即)?结束|库存不足/.test(description)) {
    return { semantics: "indefinite", evidence: "description:持续时间无限" };
  }
  const selfAttribute = "(?:攻击力|防御力|生命上限|攻击速度|法术抗性)[+−-]\\{(?:atk|def|max_hp|attack_speed|magic_resistance)(?::[^}]+)?\\}";
  if (level.skillType === "PASSIVE" && new RegExp(`^(?:自身)?${selfAttribute}(?:[，,、；;]${selfAttribute})*[。.]?$`).test(description)) {
    return { semantics: "indefinite", evidence: `description:self_attributes:${description}` };
  }
  return { semantics: "unknown", evidence: "nonpositive_duration_without_verified_continuous_effect" };
}

function healingModel(base, role, effects, spData, rawDuration, durationSemantics, description = "", trait = "") {
  const source = description.replace(/<[^>]*>/g, "").replace(/\\n/g, "\n");
  const damageDependent = /攻击敌人时.*治疗.*伤害/.test(trait.replace(/<[^>]*>/g, ""));
  const normalInterval = Math.max(0.1, base.attackInterval * 100 / Math.max(1, base.attackSpeed));
  const normalHps = role === "medic" && !damageDependent ? base.atk / normalInterval : 0;
  const result = {
    normalHps, skillHps: normalHps || 0, healingHps: normalHps,
    healPerTrigger: null, conditionalHpsUpperBound: null,
    healingMode: normalHps > 0 ? "continuous" : "none",
    healingEvidence: normalHps > 0 ? "medic_normal_healing_per_target" : "no_verified_ally_healing",
  };
  const gaps = damageDependent ? ["damage_dependent_healing_unmodeled"] : [];
  const healScale = number(effects.heal_scale);
  if (effects.heal_scale !== undefined) {
    // heal_scale also appears in self-heals, HoTs, lifesteal and enemy healing reduction.
    // Only an explicit one-shot ATK-based heal establishes an amount per trigger.
    const attackBased = /攻击力(?:的)?\{heal_scale(?::[^}]+)?\}/.test(source);
    const directHeal = /恢复|回复|治疗/.test(source) && attackBased;
    const singleTrigger = /^(?:下一?次(?:攻击|治疗)|立即|立刻)/.test(source)
      || rawDuration === 0 && /^治疗/.test(source);
    const complex = /每秒|持续恢复|造成伤害|自身|最大生命|每次部署只能|触发.*结束|子弹|仅治疗|只在/.test(source);
    if (directHeal && singleTrigger && !complex && healScale > 0 && !damageDependent) {
      const amount = base.atk * Math.max(0, 1 + number(effects.atk)) * healScale;
      const increment = number(spData.increment, 1);
      const recharge = spData.spType === "INCREASE_WITH_TIME" && number(spData.spCost) > 0 && increment > 0
        ? number(spData.spCost) / increment : null;
      Object.assign(result, {
        skillHps: null, healPerTrigger: amount,
        conditionalHpsUpperBound: recharge === null ? null : amount / recharge,
        healingMode: "triggered", healingEvidence: "description:single_atk_based_heal",
      });
      gaps.push("conditional_healing_trigger_unmodeled");
      if (recharge === null) gaps.push("healing_sp_cycle_unknown");
    } else {
      Object.assign(result, { skillHps: null, healingMode: "unknown", healingEvidence: "unverified_heal_scale_semantics" });
      gaps.push("healing_semantics_unknown");
    }
  } else if (normalHps > 0 && description) {
    if ((durationSemantics === "finite" || durationSemantics === "indefinite")
      && !/停止(?:攻击|治疗)|不再.*治疗|仅治疗|只治疗/.test(source)) {
      const interval = Math.max(0.1, Math.max(0.25, base.attackInterval + number(effects.base_attack_time))
        * 100 / Math.max(1, base.attackSpeed + number(effects.attack_speed)));
      result.skillHps = base.atk * Math.max(0, 1 + number(effects.atk)) / interval;
      const increment = number(spData.increment, 1);
      const recharge = spData.spType === "INCREASE_WITH_TIME" && increment > 0
        ? Math.max(0, number(spData.spCost)) / increment : null;
      if (durationSemantics === "indefinite") result.healingHps = result.skillHps;
      else if (recharge !== null) result.healingHps = (normalHps * recharge + result.skillHps * rawDuration) / (recharge + rawDuration);
      else gaps.push("healing_sp_cycle_unknown");
      result.healingEvidence = "medic_continuous_healing_with_attribute_modifiers";
    } else {
      result.skillHps = null;
      result.healingMode = "unknown";
      gaps.push("healing_skill_window_unknown");
    }
  }
  if (damageDependent) {
    result.skillHps = null;
    result.healingMode = "unknown";
    result.healingEvidence = "trait:damage_dependent_healing";
  }
  for (const key of ["normalHps", "skillHps", "healingHps", "healPerTrigger", "conditionalHpsUpperBound"]) {
    if (result[key] !== null) result[key] = Number(result[key].toFixed(4));
  }
  return { metrics: result, gaps };
}

function metrics(base, role, effects, spData, rawDuration, durationSemantics = "unknown", skillType = "UNKNOWN", healing, normalAttackSuppressed = false) {
  const normalInterval = Math.max(0.1, base.attackInterval * 100 / Math.max(1, base.attackSpeed));
  const normalDps = role === "medic" ? 0 : base.atk / normalInterval;
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
  // Initial SP only shortens the first activation; later cycles recharge the full cost.
  const rechargeSp = Math.max(0, number(spData.spCost));
  let rechargeSeconds = null;
  const increment = number(spData.increment, 1);
  if (spData.spType === "INCREASE_WITH_TIME" && increment > 0) rechargeSeconds = rechargeSp / increment;
  const cycleDps = durationSemantics === "indefinite" && (skillType === "PASSIVE" || rechargeSeconds !== null)
    ? burstDps : durationSemantics !== "finite" || rechargeSeconds === null
      ? null : (burstDps * rawDuration + (normalAttackSuppressed ? 0 : normalDps) * rechargeSeconds) / (rawDuration + rechargeSeconds);
  const controlSeconds = Math.max(
    number(effects.stun), number(effects.stun_duration), number(effects.slow_duration),
    number(effects.bind_duration), number(effects.sleep)
  );
  return {
    normalDps: Number(normalDps.toFixed(4)),
    burstDps: Number(burstDps.toFixed(4)),
    cycleDps: cycleDps === null ? null : Number(cycleDps.toFixed(4)),
    ...healing.metrics,
    physicalEhp: Number((base.hp * 1000 / Math.max(50, 1000 - base.def)).toFixed(4)),
    artsEhp: Number((base.hp / Math.max(0.05, 1 - base.res / 100)).toFixed(4)),
    controlSeconds,
  };
}

function compileSkill(skillRef, skillTable, base, role, trait) {
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
    const rawDuration = number(level.duration);
    const duration = Math.max(0, rawDuration);
    const durationInfo = durationMeaning(level);
    const gaps = [...parsed.gaps];
    const description = String(level.description || "").replace(/<[^>]*>/g, "").replace(/\\n/g, "\n");
    const normalAttackSuppression = description.match(/技能未(?:开启|发动)时(?:无法|不能)(?:进行)?(?:普通攻击|普攻)/);
    const selfRemoval = description.match(/技能结束(?:时|后)[，,\s]*(?:自身)?(?:会)?(?:立即|自动|强制)?(?:视为被击倒|被击倒|撤退|退出战场)/);
    if (selfRemoval) gaps.push("self_removal_unmodeled");
    const sustainedEffects = { ...parsed.effects };
    if (/技能结束时[^。；;\n]*\{atk_scale(?::[^}]+)?\}/.test(description)) {
      delete sustainedEffects.atk_scale;
      gaps.push("event_damage_unmodeled");
    }
    if (/(?:^|[，；;。\n])\s*(?:自身)?(?:逐渐|持续)流失生命|自身[^。；;\n]*每秒[^。；;\n]*(?:失去|流失|损失)[^。；;\n]*生命/.test(description)) {
      gaps.push("self_hp_drain_unmodeled");
    }
    const healing = healingModel(base, role, parsed.effects, spData, rawDuration, durationInfo.semantics,
      String(level.description || ""), trait);
    gaps.push(...healing.gaps);
    // A stop-attack phrase can mean skill-time suppression, after-skill stun, counterattacks or a replacement effect.
    // Preserve that uncertainty rather than parsing every phrase as a zero-damage active state.
    if (String(level.description || "").includes("停止攻击")) gaps.push("attack_suppression_timing_or_replacement_unmodeled");
    if (!normalAttackSuppression && /(?:无法|不能)(?:进行)?(?:普通攻击|普攻)/.test(description)) {
      gaps.push("attack_suppression_timing_or_replacement_unmodeled");
    }
    if (spData.spType === "INCREASE_WHEN_TAKEN_DAMAGE") gaps.push("defensive_sp_cycle_unknown");
    if (spData.spType === "INCREASE_WHEN_ATTACK") gaps.push("attack_sp_cycle_target_dependent");
    if (durationInfo.semantics === "ammo") gaps.push("ammo_skill_duration_unknown");
    else if (durationInfo.semantics === "unknown") gaps.push(level.skillType === "PASSIVE"
      ? "passive_duration_semantics_unknown" : "skill_duration_semantics_unknown");
    const maxTargets = Math.max(1, number(parsed.effects.max_target,
      number(parsed.effects.max_target_count,
        number(parsed.effects["attack@max_target"], number(parsed.effects["chain.max_target"], 1)))));
    return {
      rank: index + 1,
      skillType: level.skillType || "UNKNOWN",
      durationType: level.durationType || "UNKNOWN",
      durationSemantics: durationInfo.semantics,
      durationEvidence: durationInfo.evidence,
      normalAttackSuppressed: Boolean(normalAttackSuppression),
      normalAttackEvidence: normalAttackSuppression ? `description:${normalAttackSuppression[0]}` : null,
      selfRemovalEvidence: selfRemoval ? `description:${selfRemoval[0]}` : null,
      spType: spData.spType || "UNKNOWN",
      spCost: number(spData.spCost),
      initSp: number(spData.initSp),
      spIncrement: number(spData.increment, 1),
      duration,
      rawDuration,
      rangeId: level.rangeId || null,
      maxTargets,
      effects: parsed.effects,
      metrics: metrics(base, role, sustainedEffects, spData, rawDuration, durationInfo.semantics, level.skillType, healing,
        Boolean(normalAttackSuppression)),
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

function potentialRespawnTimeModifiers(character) {
  return (character.potentialRanks || []).map(rank => (rank?.buff?.attributes?.attributeModifiers || [])
    .filter(modifier => modifier?.attributeType === "RESPAWN_TIME" && modifier?.formulaItem === "ADDITION")
    .reduce((total, modifier) => total + number(modifier.value), 0));
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
  const skills = (character.skills || []).map(skill => compileSkill(skill, tables.skill_table, reference, role, character.description));
  const baseSp = { spType: "UNKNOWN", spCost: 0, initSp: 0 };
  const baseHealing = healingModel(reference, role, {}, baseSp, 0, "unknown", "", character.description);
  const baseMetrics = metrics(reference, role, {}, baseSp, 0, "unknown", "UNKNOWN", baseHealing);
  return {
    id,
    name: character.name,
    role,
    profession: character.profession,
    subProfession: character.subProfessionId || null,
    position: character.position || "UNKNOWN",
    rarity: rarityNumber(character.rarity),
    respawnTime: Math.max(0, number(frames.at(-1)?.data?.respawnTime)),
    potentialRespawnTimeModifiers: potentialRespawnTimeModifiers(character),
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
    modelCoverageGaps: [...baseHealing.gaps, ...(character.displayTokenDict ? ["summon_or_token"] : [])],
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
      attackRecovery: "unmodeled-target-dependent",
      healing: "per-target continuous rates; conditional natural-SP upper bounds exclude HP thresholds, charges, target availability and overheal",
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
