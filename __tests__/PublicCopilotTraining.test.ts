import fs from "fs";
import os from "os";
import path from "path";

const trainer = require("../scripts/train-public-copilot");

function writeSource(root: string): string {
  const source = path.join(root, "source");
  const corpus = path.join(source, "corpus");
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, "10.json"), JSON.stringify({
    stage_name: "TEST-1",
    opers: [{ name: "能天使", skill: 3 }, { name: "塞雷娅", skill: 1 }],
    groups: [],
    actions: [
      { type: "SpeedUp" },
      { type: "Deploy", name: "能天使", location: [1, 2], direction: "Right" },
      { type: "Deploy", name: "塞雷娅", location: [2, 2], direction: "Left" },
      { type: "SkillDaemon" },
    ],
  }), "utf8");
  fs.writeFileSync(path.join(source, "features.json"), JSON.stringify([{
    id: 10,
    stageName: "TEST-1",
    map: {
      bossTypeCount: 0,
      flyingRouteCount: 1,
      uniqueStartCount: 1,
      weightedHp: 10000,
      rows: 5,
      cols: 6,
    },
  }]), "utf8");
  return source;
}

function writeCompleteWindow(root: string, name: string): string {
  const source = path.join(root, name);
  const corpus = path.join(source, "corpus");
  fs.mkdirSync(corpus, { recursive: true });
  const features = [];
  for (let id = 1; id <= 500; id++) {
    fs.writeFileSync(path.join(corpus, `${id}.json`), JSON.stringify({
      stage_name: "TEST-1",
      opers: [],
      groups: [],
      actions: [],
    }), "utf8");
    features.push({ id, stageName: "TEST-1" });
  }
  fs.writeFileSync(path.join(source, "features.json"), JSON.stringify(features), "utf8");
  return source;
}

describe("public copilot training", () => {
  it("builds aggregate priors without storing full action sequences", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-public-prior-"));
    try {
      const operations = trainer.loadOperations([writeSource(tmp)]);
      const prior = trainer.buildPublicPrior(operations);

      expect(prior.source).toMatchObject({
        operationCount: 1,
        uniqueStageCount: 1,
        fullSequenceStored: false,
      });
      expect(prior.stages["TEST-1"].deployHeatmap).toEqual({ "2,1": 1, "2,2": 1 });
      expect(prior.stages["TEST-1"].directionRates).toEqual({ Left: 0.5, Right: 0.5 });
      expect(JSON.stringify(prior)).not.toContain("\"location\"");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses completed conservative windows when a later download fails", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-public-prior-"));
    const stderr = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      writeCompleteWindow(tmp, "latest");
      writeCompleteWindow(tmp, "2026-03-01");

      const dirs = trainer.runAnalyzer(
        { preset: "conservative", dataDir: tmp },
        () => { throw new Error("network down"); }
      );

      expect(dirs.map((dir: string) => path.basename(dir))).toEqual(["latest", "2026-03-01"]);
      expect(trainer.sourceOperationCount(dirs[0])).toBe(500);
    } finally {
      stderr.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
