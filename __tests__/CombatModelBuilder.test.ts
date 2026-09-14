import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const COMMIT = "b327f67a1d73fe9a2501f4e159603a30da75911f";

function writeFixture(root: string): void {
  fs.writeFileSync(path.join(root, "character_table.json"), JSON.stringify({
    char_test: {
      name: "测试干员",
      profession: "WARRIOR",
      subProfessionId: "fighter",
      position: "MELEE",
      rarity: "TIER_6",
      phases: [{}, {}, {
        maxLevel: 90,
        rangeId: "test-range",
        attributesKeyFrames: [
          { level: 1, data: { maxHp: 1000, atk: 300, def: 200, magicResistance: 0, cost: 18, baseAttackTime: 1.2, attackSpeed: 100, blockCnt: 2, respawnTime: 18 } },
          { level: 90, data: { maxHp: 2400, atk: 700, def: 450, magicResistance: 10, cost: 20, baseAttackTime: 1.2, attackSpeed: 100, blockCnt: 2, respawnTime: 18 } },
        ],
      }],
      favorKeyFrames: [{ level: 50, data: { maxHp: 100, atk: 50, def: 20, magicResistance: 0 } }],
      skills: [{ skillId: "sk_test", unlockCond: { phase: "PHASE_2", level: 1 } }],
      talents: [{ candidates: [{
        unlockCondition: { phase: "PHASE_2", level: 1 },
        requiredPotentialRank: 0,
        prefabKey: "simple-talent",
        blackboard: [{ key: "atk", value: 0.1 }],
      }] }],
      potentialRanks: [{}, {}, {
        buff: { attributes: { attributeModifiers: [
          { attributeType: "RESPAWN_TIME", formulaItem: "ADDITION", value: -2 },
        ] } },
      }],
    },
  }), "utf8");
  fs.writeFileSync(path.join(root, "skill_table.json"), JSON.stringify({
    sk_test: {
      skillId: "sk_test",
      levels: Array.from({ length: 10 }, (_, index) => ({
        rangeId: index === 9 ? "skill-range" : null,
        skillType: "MANUAL",
        durationType: "DURATION",
        spData: { spType: "INCREASE_WITH_TIME", spCost: 30, initSp: 10, increment: 1 },
        duration: 20,
        blackboard: [
          { key: "atk", value: 0.5 },
          { key: "attack_speed", value: 50 },
          { key: "max_target", value: 2 },
          { key: "mystery_effect", value: 9 },
        ],
      })),
    },
  }), "utf8");
  fs.writeFileSync(path.join(root, "range_table.json"), JSON.stringify({
    "test-range": { id: "test-range", direction: 1, grids: [{ row: 0, col: 0 }, { row: 0, col: 1 }] },
    "skill-range": { id: "skill-range", direction: 1, grids: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }] },
  }), "utf8");
  fs.writeFileSync(path.join(root, "uniequip_table.json"), JSON.stringify({
    equipDict: {
      uniequip_test: { uniEquipId: "uniequip_test", uniEquipName: "测试模组", charId: "char_test", type: "ADVANCED", charEquipOrder: 1 },
    },
  }), "utf8");
  fs.writeFileSync(path.join(root, "battle_equip_table.json"), JSON.stringify({
    uniequip_test: {
      phases: [{ equipLevel: 1, parts: [], attributeBlackboard: [{ key: "atk", value: 30 }] }],
    },
  }), "utf8");
}

function runBuilder(root: string, output: string, commit = COMMIT) {
  return spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "scripts", "build-operator-combat-model.js"),
    "--game-data", root,
    "--output", output,
    "--commit", commit,
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
}

describe("operator combat model builder", () => {
  it("builds a deterministic five-table v2 model", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-model-"));
    const first = path.join(root, "first.json");
    const second = path.join(root, "second.json");
    writeFixture(root);

    expect(runBuilder(root, first).status).toBe(0);
    expect(runBuilder(root, second).status).toBe(0);
    expect(fs.readFileSync(first, "utf8")).toBe(fs.readFileSync(second, "utf8"));

    const model = JSON.parse(fs.readFileSync(first, "utf8"));
    expect(model.schemaVersion).toBe(2);
    expect(model.builderVersion).toBe("operator-combat-builder-v2.5");
    expect(model.source.commit).toBe(COMMIT);
    expect(Object.keys(model.source.tableHashes).sort()).toEqual([
      "battle_equip_table", "character_table", "range_table", "skill_table", "uniequip_table",
    ]);
    expect(model.nameIndex["测试干员"]).toBe("char_test");
    expect(model.operators.char_test).toMatchObject({
      id: "char_test",
      name: "测试干员",
      role: "guard",
      position: "MELEE",
      respawnTime: 18,
      potentialRespawnTimeModifiers: [0, 0, -2],
      e2: { minLevel: 1, maxLevel: 90, rangeId: "test-range" },
    });
    expect(model.operators.char_test.skills[0].levels[9]).toMatchObject({
      rank: 10,
      spType: "INCREASE_WITH_TIME",
      spCost: 30,
      initSp: 10,
      duration: 20,
      rawDuration: 20,
      durationType: "DURATION",
      durationSemantics: "finite",
      durationEvidence: "positive_raw_duration",
      spIncrement: 1,
      rangeId: "skill-range",
      maxTargets: 2,
      confidence: "partial",
    });
    expect(model.operators.char_test.skills[0].levels[9].modelCoverageGaps).toContain("unsupported:mystery_effect");
    expect(model.operators.char_test.modules[0]).toMatchObject({ id: "uniequip_test", index: 1 });
    expect(model.ranges["skill-range"]).toEqual([[0, 0], [0, 1], [0, 2]]);
    // 625 normal DPS, 1406.25 skill DPS: 20 active seconds + all 30 SP recharge.
    expect(model.operators.char_test.skills[0].levels[9].metrics.cycleDps).toBe(937.5);
  });

  it("keeps indefinite, ammo and instant durations distinct without inventing cycles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-durations-"));
    writeFixture(root);
    const file = path.join(root, "skill_table.json");
    const skills = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(skills.sk_test.levels[0], { duration: -1, durationType: "NONE", description: "攻击力+{atk:0%}<@ba.rem>持续时间无限</>" });
    Object.assign(skills.sk_test.levels[1], { duration: -1, durationType: "AMMO" });
    Object.assign(skills.sk_test.levels[2], { duration: 0, durationType: "NONE" });
    skills.sk_test.levels[3].spData.spType = "INCREASE_WHEN_ATTACK";
    Object.assign(skills.sk_test.levels[4], { duration: -1, durationType: "NONE", description: "下一次攻击造成伤害" });
    Object.assign(skills.sk_test.levels[5], { duration: 0, durationType: "NONE", description: "<@ba.rem>持续时间无限</>" });
    Object.assign(skills.sk_test.levels[6], { duration: 0, durationType: "NONE", skillType: "PASSIVE", description: "攻击力<@ba.vup>+{atk:0%}</>，防御力<@ba.vup>+{def:0%}</>" });
    Object.assign(skills.sk_test.levels[7], { duration: 0, durationType: "NONE", skillType: "PASSIVE", description: "部署后立即造成伤害" });
    Object.assign(skills.sk_test.levels[8], { duration: -1, durationType: "NONE", description: "触发3次后技能立即结束。<@ba.rem>持续时间无限</>" });
    fs.writeFileSync(file, JSON.stringify(skills));
    const output = path.join(root, "model.json");
    expect(runBuilder(root, output).status).toBe(0);
    const levels = JSON.parse(fs.readFileSync(output, "utf8")).operators.char_test.skills[0].levels;
    expect(levels[0].rawDuration).toBe(-1);
    expect(levels[0].metrics.cycleDps).toBe(levels[0].metrics.burstDps);
    expect(levels[1]).toMatchObject({ rawDuration: -1, durationType: "AMMO", metrics: { cycleDps: null } });
    expect(levels[2].metrics.cycleDps).toBeNull();
    expect(levels[3].metrics.cycleDps).toBeNull();
    expect(levels[3].modelCoverageGaps).toContain("attack_sp_cycle_target_dependent");
    for (const index of [4, 7, 8]) expect(levels[index]).toMatchObject({ durationSemantics: "unknown", metrics: { cycleDps: null } });
    for (const index of [0, 5, 6]) {
      expect(levels[index].durationSemantics).toBe("indefinite");
      expect(levels[index].metrics.cycleDps).toBe(levels[index].metrics.burstDps);
    }
  });

  it("rejects a non-full commit sha", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-model-"));
    writeFixture(root);
    const result = runBuilder(root, path.join(root, "output.json"), "unknown");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full 40-character commit SHA");
  });

  it("limits explicit one-shot ally healing by full SP recharge without inventing continuous HPS", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-healing-"));
    writeFixture(root);
    const file = path.join(root, "skill_table.json");
    const skills = JSON.parse(fs.readFileSync(file, "utf8"));
    const description = "下一次攻击会为周围血量不足一半的一名友方单位恢复相当于攻击力<@ba.vup>{heal_scale:0%}</>的生命\\n<@ba.rem>可充能{ct}次</>";
    for (const level of skills.sk_test.levels) Object.assign(level, {
      description, skillType: "AUTO", duration: 0, durationType: "NONE",
      spData: { spType: "INCREASE_WITH_TIME", spCost: 4, initSp: 4, increment: 1 },
      blackboard: [{ key: "heal_scale", value: 1.8 }, { key: "ct", value: 3 }],
    });
    skills.sk_test.levels[1].blackboard.push({ key: "attack_speed", value: 200 });
    skills.sk_test.levels[2].spData.spType = "INCREASE_WHEN_ATTACK";
    skills.sk_test.levels[3].description = "每秒持续恢复相当于攻击力{heal_scale:0%}的生命";
    skills.sk_test.levels[4].description = "立即恢复最大生命的{heal_scale:0%}";
    skills.sk_test.levels[5].description = "下次攻击造成相当于攻击力{atk_scale:0%}的物理伤害，且恢复周围一名友方单位相当于攻击力{heal_scale:0%}的生命";
    skills.sk_test.levels[5].blackboard.push({ key: "atk_scale", value: 2.6 });
    fs.writeFileSync(file, JSON.stringify(skills));
    const output = path.join(root, "model.json");
    expect(runBuilder(root, output).status).toBe(0);
    const levels = JSON.parse(fs.readFileSync(output, "utf8")).operators.char_test.skills[0].levels;
    for (const index of [0, 1, 5]) expect(levels[index].metrics).toMatchObject({
      normalHps: 0, skillHps: null, healingHps: 0, healingMode: "triggered",
      healPerTrigger: 1350, conditionalHpsUpperBound: 337.5,
    });
    expect(levels[0].modelCoverageGaps).toContain("conditional_healing_trigger_unmodeled");
    expect(levels[2].metrics).toMatchObject({ healPerTrigger: 1350, conditionalHpsUpperBound: null, healingHps: 0 });
    expect(levels[2].modelCoverageGaps).toContain("healing_sp_cycle_unknown");
    for (const index of [3, 4]) {
      expect(levels[index].metrics).toMatchObject({ healingMode: "unknown", healingHps: 0, healPerTrigger: null });
      expect(levels[index].modelCoverageGaps).toContain("healing_semantics_unknown");
    }
  });

  it("separates ordinary medical healing from finite and indefinite skill windows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-medical-windows-"));
    writeFixture(root);
    const charactersFile = path.join(root, "character_table.json");
    const characters = JSON.parse(fs.readFileSync(charactersFile, "utf8"));
    Object.assign(characters.char_test, { profession: "MEDIC", subProfessionId: "physician", description: "恢复友方单位生命" });
    fs.writeFileSync(charactersFile, JSON.stringify(characters));
    const file = path.join(root, "skill_table.json");
    const skills = JSON.parse(fs.readFileSync(file, "utf8"));
    skills.sk_test.levels[0].description = "攻击力+{atk:0%}，攻击速度+{attack_speed}";
    Object.assign(skills.sk_test.levels[1], { duration: -1, description: "攻击力+{atk:0%}，攻击速度+{attack_speed}<@ba.rem>持续时间无限</>" });
    fs.writeFileSync(file, JSON.stringify(skills));
    const output = path.join(root, "model.json");
    expect(runBuilder(root, output).status).toBe(0);
    const operator = JSON.parse(fs.readFileSync(output, "utf8")).operators.char_test;
    expect(operator.baseMetrics).toMatchObject({ normalHps: 625, healingHps: 625 });
    expect(operator.skills[0].levels[0].metrics).toMatchObject({
      normalHps: 625, skillHps: 1406.25, healingHps: 937.5, healingMode: "continuous",
    });
    expect(operator.skills[0].levels[1].metrics).toMatchObject({ normalHps: 625, skillHps: 1406.25, healingHps: 1406.25 });
    characters.char_test.description = "攻击造成法术伤害，攻击敌人时为攻击范围内一名友方干员治疗相当于50%伤害的生命值";
    fs.writeFileSync(charactersFile, JSON.stringify(characters));
    expect(runBuilder(root, output).status).toBe(0);
    const conditional = JSON.parse(fs.readFileSync(output, "utf8")).operators.char_test;
    expect(conditional.baseMetrics).toMatchObject({ normalHps: 0, healingHps: 0, healingMode: "unknown" });
    expect(conditional.modelCoverageGaps).toContain("damage_dependent_healing_unmodeled");
  });

  it("keeps skill-end damage out of sustained DPS and flags explicit self HP drain", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-event-damage-"));
    writeFixture(root);
    const file = path.join(root, "skill_table.json");
    const skills = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(skills.sk_test.levels[0], {
      description: "攻击速度<@ba.vup>+{attack_speed}</>，同时攻击{max_target}个敌人；范围内所有敌人的冻结延长至技能结束，且技能结束时对所有冻结的敌人造成<@ba.vup>{atk_scale:0%}</>的法术伤害并结束冻结",
      blackboard: [{ key: "attack_speed", value: 130 }, { key: "atk_scale", value: 6 }, { key: "max_target", value: 2 }],
    });
    Object.assign(skills.sk_test.levels[1], {
      duration: -1, description: "立即恢复所有生命；攻击力+{atk:0%}，生命上限+{max_hp}，逐渐流失生命（{duration}秒后到达最大生命{hp_ratio:0%}/秒）；<@ba.rem>持续时间无限</>",
    });
    skills.sk_test.levels[2].description = "使范围内敌人持续流失生命";
    fs.writeFileSync(file, JSON.stringify(skills));
    const output = path.join(root, "model.json");
    expect(runBuilder(root, output).status).toBe(0);
    const levels = JSON.parse(fs.readFileSync(output, "utf8")).operators.char_test.skills[0].levels;
    expect(levels[0].metrics.burstDps).toBe(1437.5);
    expect(levels[0].effects.atk_scale).toBe(6);
    expect(levels[0].modelCoverageGaps).toContain("event_damage_unmodeled");
    expect(levels[1].durationSemantics).toBe("indefinite");
    expect(levels[1].modelCoverageGaps).toContain("self_hp_drain_unmodeled");
    expect(levels[2].modelCoverageGaps).not.toContain("self_hp_drain_unmodeled");
  });

  it("records explicit skill-only attacks and excludes the inactive phase from cycle damage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-skill-only-attacks-"));
    writeFixture(root);
    const file = path.join(root, "skill_table.json");
    const skills = JSON.parse(fs.readFileSync(file, "utf8"));
    skills.sk_test.levels[0].description = "攻击力+{atk:0%}，攻击速度+{attack_speed}\\n<@ba.rem>技能未开启时无法普通攻击</>";
    skills.sk_test.levels[1].description = "技能结束后无法普通攻击";
    fs.writeFileSync(file, JSON.stringify(skills));
    const output = path.join(root, "model.json");
    expect(runBuilder(root, output).status).toBe(0);
    const levels = JSON.parse(fs.readFileSync(output, "utf8")).operators.char_test.skills[0].levels;
    expect(levels[0]).toMatchObject({
      normalAttackSuppressed: true, normalAttackEvidence: "description:技能未开启时无法普通攻击",
      // Retain nominal DPS for physical-defense normalization; only active seconds contribute to the cycle.
      metrics: { normalDps: 625, burstDps: 1406.25, cycleDps: 562.5 },
    });
    expect(levels[1]).toMatchObject({ normalAttackSuppressed: false, normalAttackEvidence: null, metrics: { cycleDps: 937.5 } });
    expect(levels[1].modelCoverageGaps).toContain("attack_suppression_timing_or_replacement_unmodeled");
  });

  it("flags explicit skill-end self-removal without confusing enemy defeat or self HP loss", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-self-removal-"));
    writeFixture(root);
    const file = path.join(root, "skill_table.json");
    const skills = JSON.parse(fs.readFileSync(file, "utf8"));
    skills.sk_test.levels[0].description = "攻击力+{atk:0%}，攻击速度+{attack_speed}，技能持续期间内干员的生命值不会低于1\\n<@ba.rem>技能结束后视为被击倒</>";
    skills.sk_test.levels[1].description = "开启时立即与范围内生命上限比例最低的其他我方干员交换生命上限比例，自身攻击力+{atk:0%}";
    skills.sk_test.levels[2].description = "攻击生命比例高于或等于自身的敌人时额外造成一次物理伤害，否则自身流失生命";
    skills.sk_test.levels[3].description = "技能结束后自动撤退";
    skills.sk_test.levels[4].description = "技能结束后使敌人被击倒";
    fs.writeFileSync(file, JSON.stringify(skills));
    const output = path.join(root, "model.json");
    expect(runBuilder(root, output).status).toBe(0);
    const levels = JSON.parse(fs.readFileSync(output, "utf8")).operators.char_test.skills[0].levels;
    expect(levels[0].selfRemovalEvidence).toBe("description:技能结束后视为被击倒");
    for (const index of [0, 3]) expect(levels[index].modelCoverageGaps).toContain("self_removal_unmodeled");
    for (const index of [1, 2, 4]) expect(levels[index].modelCoverageGaps).not.toContain("self_removal_unmodeled");
  });

  it("fails when any required source table is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-combat-model-"));
    writeFixture(root);
    fs.rmSync(path.join(root, "skill_table.json"));
    const result = runBuilder(root, path.join(root, "output.json"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("skill_table.json not found");
  });
});
