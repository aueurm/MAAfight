const analyzer = require("../scripts/analyze-prts-plus");

describe("PRTS Plus corpus analyzer", () => {
  test("selects operations nearest a target date", () => {
    const selected = analyzer.selectClosestOperations(
      [
        { id: 1, uploadTime: "2025-06-01T00:00:00" },
        { id: 2, uploadTime: "2025-06-17T00:00:00" },
        { id: 3, uploadTime: "2025-06-19T00:00:00" },
        { id: 4, uploadTime: "2025-07-01T00:00:00" },
      ],
      "2025-06-18",
      2
    );

    expect(selected.map((entry: { id: number }) => entry.id)).toEqual([3, 2]);
  });

  test("counts numeric module selectors and ignores disabled modules", () => {
    const feature = analyzer.extractOperationFeatures({
      id: 1,
      uploadTime: null,
      content: {
        stage_name: "main_01-07",
        opers: [
          { name: "A", requirements: { module: 2 } },
          { name: "B", requirements: { module: -1 } },
        ],
        groups: [],
        actions: [],
      },
    });

    expect(feature.requirements.withModule).toBe(1);
    expect(feature.requirements.modules).toEqual({ "2": 1 });
  });

  test("treats ALL tiles as deployable and reads boss level types", () => {
    const mapData = {
      stageId: "test",
      tiles: [[{ row: 0, col: 0 }]],
      deploymentPoints: [],
      routes: [],
      strategicPoints: [],
      enemyDetails: [
        {
          id: "enemy_boss",
          maxHp: 100,
          atk: 10,
          isElite: true,
        },
      ],
      spawnTimeline: [
        {
          enemyId: "enemy_boss",
          count: 1,
        },
      ],
      options: {},
      _raw: {
        mapData: {
          map: [[0]],
          tiles: [{ buildableType: "ALL" }],
        },
        enemyDbRefs: [{ id: "enemy_boss", overwrittenData: null }],
      },
    };

    const metrics = analyzer.buildMapMetrics(
      mapData,
      new Map([["enemy_boss", "BOSS"]])
    );
    const joined = analyzer.joinOperationWithMap(
      { deployLocations: [{ x: 0, y: 0 }] },
      { entry: { stageId: "test" }, metrics }
    );

    expect(metrics.deploymentPointCount).toBe(1);
    expect(metrics.flexiblePointCount).toBe(1);
    expect(metrics.bossTypeCount).toBe(1);
    expect(joined.deploymentMapFeatures.matchedDeployableCount).toBe(1);
    expect(joined.deploymentMapFeatures.flexibleDeployCount).toBe(1);
  });
});
