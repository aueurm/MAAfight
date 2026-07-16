jest.mock("../src/core/pipeline", () => ({
  analyzeStage: jest.fn(),
  generateStage: jest.fn(),
  loadStageContext: jest.fn(),
}));

import { generateStage } from "../src/core/pipeline";
import { runCli } from "../src/index";

const mockedGenerateStage = generateStage as jest.MockedFunction<typeof generateStage>;

function generatedResult() {
  return {
    json: "{\"stage_name\":\"GT-1\"}",
    warnings: [],
    stageName: "GT-1",
    analysis: { summary: "test facts" },
    candidateScore: 12.34,
  } as never;
}

describe("generate command pipeline delegation", () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedGenerateStage.mockReset();
    mockedGenerateStage.mockResolvedValue(generatedResult());
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("writes generated JSON to stdout when no output path is requested", async () => {
    await runCli(["generate", "--stage", "GT-1", "--quiet"]);

    expect(mockedGenerateStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "GT-1",
        writeOutput: false,
      }),
      expect.objectContaining({ stateDir: expect.any(String) })
    );
    expect(stdoutSpy).toHaveBeenCalledWith("{\"stage_name\":\"GT-1\"}");
  });

  it("forwards local-data and output options without writing to stdout", async () => {
    await runCli([
      "generate", "--stage", "GT-1", "--data", "local-stage.json", "--no-cache",
      "--output", "result.copilot", "--new-candidate", "--pretty", "--quiet",
    ]);

    expect(mockedGenerateStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "GT-1",
        dataPath: "local-stage.json",
        noCache: true,
        outputPath: "result.copilot",
        writeOutput: true,
        newCandidate: true,
        pretty: true,
      }),
      expect.any(Object)
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
