import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Tasks = Record<string, Record<string, unknown>>;
type Probe = { ok: boolean; result?: any; error?: string };
const describeOnWindows = process.platform === "win32" ? describe : describe.skip;
const scriptPath = path.resolve(__dirname, "../scripts/maa-navigation.ps1").replace(/'/g, "''");
const temporaryRoots: string[] = [];
const requiredFunctions = ["Get-MaaResourceRoots", "Read-MaaTaskDefinitions", "Get-MaaNavigationRequest", "New-MaaNavigationOverlay", "Test-MaaNavigationStopped", "Test-MaaTargetStageCompleted"];

// Dot-source only pure helpers: never load MaaCore, connect ADB, or touch an installed MAA.
function inspect(call: string, tasks: Tasks = {}, cases: Record<string, unknown>[] = [{}]): Probe[] {
  const command = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    . '${scriptPath}'
    foreach ($name in @('${requiredFunctions.join("', '")}')) {
      if (-not (Get-Command $name -CommandType Function -ErrorAction SilentlyContinue)) { throw "Missing helper: $name" }
    }
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $inputData = $serializer.DeserializeObject($env:MAAFIGHT_NAVIGATION_TEST_INPUT)
    $tasks = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    foreach ($key in $inputData['tasks'].Keys) { $tasks[$key] = $inputData['tasks'][$key] }
    $results = @(foreach ($case in $inputData['cases']) {
      try { @{ ok = $true; result = (${call}) } }
      catch { @{ ok = $false; error = $_.Exception.Message } }
    })
    ConvertTo-Json -InputObject $results -Compress -Depth 30
  `;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
    env: { ...process.env, MAAFIGHT_NAVIGATION_TEST_INPUT: JSON.stringify({ tasks, cases }) },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function successful(probe: Probe): any {
  expect(probe.ok).toBe(true);
  if (!probe.ok) throw new Error(probe.error);
  return probe.result;
}

function fixture(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-navigation-test-"));
  temporaryRoots.push(root);
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value), "utf8");
  }
  return root;
}

function boundaryTasks(): Tasks {
  return {
    FightBegin: { algorithm: "JustReturn", next: ["Fight@StartButton1"], sub: ["Unsafe"], preDelay: 9000, baseTask: "OldFight" },
    StartButton1: { algorithm: "OcrDetect", action: "ClickSelf", text: ["开始行动"], roi: [1010, 625, 260, 61], next: ["StartButton2"], sub: ["Unsafe"], onErrorNext: ["Retry"], exceededNext: ["Retry"], reduceOtherTimes: ["StartButton2"] },
    StartButton2: { action: "ClickSelf", template: "StartButton2.png" },
    ClickedCorrectStage: { algorithm: "OcrDetect", action: "DoNothing", text: [], roi: [845, 72, 220, 50] },
    ClickedCorrectStageOrSwipe: { baseTask: "StartButton1", action: "DoNothing", next: ["ClickedCorrectStage"] },
  };
}

function event(overrides: { message?: number; taskid?: number; taskchain?: string; subtask?: string; task?: string; action?: string; text?: string } = {}, target = false) {
  return {
    message: overrides.message ?? (target ? 20002 : 20001),
    details: {
      taskid: overrides.taskid ?? 7, taskchain: overrides.taskchain ?? (target ? "Custom" : "Fight"), subtask: overrides.subtask ?? "ProcessTask",
      details: { task: overrides.task ?? (target ? "MAAfightVerifyStage" : "FightBegin"), action: overrides.action ?? (target ? "DoNothing" : "Stop"), algorithm: target ? "OcrDetect" : "JustReturn", result: { text: overrides.text ?? "OF-F3" } },
    },
  };
}

afterAll(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("maafight-navigation-test-")) throw new Error("Unexpected test cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describeOnWindows("practice navigation resource loading", () => {
  it("loads base, main cache, client, then client cache in the official GUI order", () => {
    const files: Record<string, unknown> = { "resource/tasks/base.json": {}, "cache/resource/tasks.json": {} };
    for (const client of ["YoStarEN", "YoStarJP", "YoStarKR", "txwy"]) {
      files[`resource/global/${client}/resource/tasks.json`] = {};
      files[`cache/resource/global/${client}/resource/tasks.json`] = {};
    }
    const dir = fixture(files);
    const clients = ["Official", "Bilibili", "YoStarEN", "YoStarJP", "YoStarKR", "txwy"];
    const probes = inspect("@(Get-MaaResourceRoots $case['dir'] $case['client'])", {}, clients.map(client => ({ dir, client })));
    probes.forEach((probe, i) => expect(successful(probe)).toEqual([
      dir, path.join(dir, "cache"), ...(i < 2 ? [] : [path.join(dir, "resource/global", clients[i]), path.join(dir, "cache/resource/global", clients[i])]),
    ]));
  });

  it("skips absent optional resource layers", () => {
    const dir = fixture({ "resource/tasks/base.json": {} });
    expect(successful(inspect("@(Get-MaaResourceRoots $case['dir'] 'YoStarEN')", {}, [{ dir }])[0])).toEqual([dir]);
  });

  it("merges hot updates and client fields while explicit baseTask replaces the old definition", () => {
    const dir = fixture({
      "resource/tasks/base.json": { Probe: { algorithm: "OcrDetect", text: ["base"], action: "ClickSelf", doc: "lower", Doc: "upper" }, Replace: { action: "ClickSelf", text: ["old"] } },
      "cache/resource/tasks.json": { Probe: { text: ["hotfix"] }, Replace: { baseTask: "#none", algorithm: "JustReturn" } },
      "resource/global/YoStarEN/resource/tasks.json": { Probe: { text: ["client"], roi: [1, 2, 3, 4] } },
      "cache/resource/global/YoStarEN/resource/tasks.json": { Probe: { text: ["client-hotfix"] } },
    });
    const [official, english] = inspect("Read-MaaTaskDefinitions (Get-MaaResourceRoots $case['dir'] $case['client'])", {}, [{ dir, client: "Official" }, { dir, client: "YoStarEN" }]).map(successful);
    expect(official.Probe.text).toEqual(["hotfix"]);
    expect(english.Probe).toEqual({ algorithm: "OcrDetect", action: "ClickSelf", text: ["client-hotfix"], roi: [1, 2, 3, 4], doc: "lower", Doc: "upper" });
    expect(english.Replace).toEqual({ baseTask: "#none", algorithm: "JustReturn" });
  });

  it("prefers a tasks directory over the legacy file and preserves case-sensitive task names", () => {
    const dir = fixture({ "resource/tasks/base.json": { Probe: { action: "Stop" }, probe: { action: "DoNothing" } }, "resource/tasks.json": { LegacyOnly: { action: "ClickSelf" } } });
    expect(successful(inspect("Read-MaaTaskDefinitions @($case['dir'])", {}, [{ dir }])[0])).toEqual({ Probe: { action: "Stop" }, probe: { action: "DoNothing" } });
  });

  it("rejects duplicate task definitions within one resource directory", () => {
    const dir = fixture({ "resource/tasks/one.json": { Duplicate: { action: "Stop" } }, "resource/tasks/nested/two.json": { Duplicate: { action: "ClickSelf" } } });
    expect(inspect("Read-MaaTaskDefinitions @($case['dir'])", {}, [{ dir }])[0]).toMatchObject({ ok: false, error: expect.stringMatching(/Duplicate MAA task.*Duplicate/) });
  });
});

describeOnWindows("practice navigation requests", () => {
  const call = "Get-MaaNavigationRequest $tasks $case['stage'] $case['difficulty']";

  it("uses all installed main-story chapters without dedicated Stagecode leaves", () => {
    const tasks = Object.fromEntries(Array.from({ length: 18 }, (_, chapter) => [`Episode${chapter}`, { action: "ClickSelf" }]));
    const stages = Array.from({ length: 18 }, (_, chapter) => `${chapter}-1`);
    const probes = inspect(call, tasks, stages.map(stage => ({ stage })));
    probes.forEach((probe, chapter) => expect(successful(probe)).toMatchObject({ code: stages[chapter], supported: true, nativeName: chapter >= 10 ? `${stages[chapter]}-Normal` : stages[chapter] }));
  });

  it("uses direct main-story, supply, chip and event tasks without a Stagecode convention", () => {
    const stages = ["1-7", "OF-F3", "CE-6", "LS-6", "CA-5", "AP-5", "SK-5", "PR-A-2", "PR-B-1", "PR-C-2", "PR-D-1", "SR-8", "HS-9"];
    const tasks = Object.fromEntries(stages.map(stage => [stage, { algorithm: "JustReturn", sub: ["InstalledNavigation"] }]));
    inspect(call, tasks, stages.map(stage => ({ stage }))).forEach((probe, i) => expect(successful(probe)).toMatchObject({ code: stages[i], nativeName: stages[i], supported: true }));
  });

  it("handles 11-11 Normal/Hard and prefixed main-story navigation deterministically", () => {
    const tasks = Object.fromEntries([2, 8, 10, 11, 15, 17].map(chapter => [`Episode${chapter}`, {}]));
    const cases = [
      { stage: "11-11", expected: "11-11-Normal" }, { stage: "11-11-Normal", expected: "11-11-Normal" },
      { stage: "11-11-Hard", expected: "11-11-Hard" }, { stage: " 11-11 ", difficulty: "Hard", expected: "11-11-Hard" },
      { stage: "H10-1", expected: "H10-1-Hard" }, { stage: "15-1", difficulty: "Normal", expected: "15-1-Normal" },
      { stage: "17-1-Hard", expected: "17-1-Hard" }, ...["S2-1", "R8-1", "M8-1", "JT8-2"].map(stage => ({ stage, expected: stage })),
    ];
    inspect(call, tasks, cases).forEach((probe, i) => expect(successful(probe)).toMatchObject({ supported: true, nativeName: cases[i].expected }));
  });

  it("reports unavailable concrete stages instead of inventing a navigation task", () => {
    inspect(call, { Episode1: {} }, [{ stage: "99-1" }, { stage: "ZZ-99" }]).forEach(probe => expect(successful(probe)).toMatchObject({ supported: false }));
  });

  it("rejects batch selectors, arbitrary task names and task expressions", () => {
    const stages = ["", "SSReopen-SR", "FightBegin", "StartButton1", "Episode11", "1-7@StartButton2", "1-7#next", "(1-7+FightBegin)", "1-7;Stop"];
    const tasks = Object.fromEntries(stages.map(stage => [stage, { action: "ClickSelf" }]));
    inspect(call, tasks, stages.map(stage => ({ stage }))).forEach(probe => expect(probe).toMatchObject({ ok: false, error: expect.stringMatching(/concrete stage code/) }));
  });

  it("rejects conflicting difficulty and suffixes outside supported main-story chapters", () => {
    const cases = [{ stage: "11-11-Hard", difficulty: "Normal" }, { stage: "1-7-Hard" }, { stage: "OF-F3", difficulty: "Normal" }];
    inspect(call, { Episode1: {}, Episode11: {}, "OF-F3": {} }, cases).forEach(probe => expect(probe).toMatchObject({ ok: false, error: expect.stringMatching(/difficulty|suffix/i) }));
  });
});

describeOnWindows("practice navigation overlay", () => {
  const call = "New-MaaNavigationOverlay $tasks 'OF-F3'";

  it("fully replaces FightBegin and cuts every execution branch from battle boundaries", () => {
    const tasks = { ...boundaryTasks(), "Fight@StartButton1": { action: "ClickRect" }, "StageQueue@StartButton2": { action: "ClickSelf" }, BattleStartExercise: { baseTask: "StartButton2" }, UseMedicine: { action: "ClickSelf" }, StoneConfirm: { action: "ClickSelf" } };
    const overlay = successful(inspect(call, tasks)[0]);
    expect(overlay.FightBegin).toEqual({ baseTask: "#none", algorithm: "JustReturn", action: "Stop", next: [], sub: [], onErrorNext: [], exceededNext: [], reduceOtherTimes: [] });
    for (const name of ["StartButton1", "StartButton2", "Fight@StartButton1", "StageQueue@StartButton2", "BattleStartExercise", "UseMedicine", "StoneConfirm"]) {
      expect(overlay[name]).toMatchObject({ action: "Stop", next: [], sub: [], onErrorNext: [], exceededNext: [], reduceOtherTimes: [] });
    }
  });

  it("blocks explicit clicks restored through multiple aliases and namespace overrides", () => {
    const tasks = {
      ...boundaryTasks(), Bridge: { baseTask: "StartButton1" }, DeepBridge: { baseTask: "Bridge" },
      RestoredClick: { baseTask: "DeepBridge", action: "ClickRect" },
      ReadOnlyBridge: { baseTask: "StartButton1", action: "DoNothing" }, RestoredFromReadOnly: { baseTask: "ReadOnlyBridge", action: "ClickSelf" },
      "Route@Bridge": { action: "ClickSelf" }, "Route@RestoredClick": { action: "ClickRect" },
      "X@Alias": { baseTask: "StartButton1" }, "Y@Gate": { baseTask: "X@Alias", action: "ClickRect" },
      TemplateAlias: { template: "StartButton2.png", action: "ClickRect" },
      GenericClick: { action: "ClickSelf" }, InheritedTemplateClick: { baseTask: "GenericClick", template: "StartButton2.png" },
    };
    const overlay = successful(inspect(call, tasks)[0]);
    for (const name of ["RestoredClick", "RestoredFromReadOnly", "Route@Bridge", "Route@RestoredClick", "Y@Gate", "TemplateAlias", "InheritedTemplateClick"]) expect(overlay[name]).toMatchObject({ action: "Stop", next: [], sub: [] });
  });

  it("preserves OCR types, read-only inheritance and ordinary navigation clicks", () => {
    const tasks = { ...boundaryTasks(), ReadOnlyBridge: { baseTask: "StartButton1", action: "DoNothing" }, StageNode: { algorithm: "OcrDetect", action: "ClickSelf", text: ["OF-F3"] } };
    const overlay = successful(inspect(call, tasks)[0]);
    expect(overlay.StartButton1).toMatchObject({ algorithm: "OcrDetect", text: ["开始行动"], roi: [1010, 625, 260, 61] });
    expect(overlay.ClickedCorrectStageOrSwipe).toBeUndefined();
    expect(overlay.ReadOnlyBridge).toBeUndefined();
    expect(overlay.StageNode).toBeUndefined();
    expect(overlay.MAAfightVerifyStage).toMatchObject({ baseTask: "ClickedCorrectStage", algorithm: "OcrDetect", action: "DoNothing", text: ["OF-F3"], fullMatch: true, next: [], sub: [], onErrorNext: [], exceededNext: [] });
  });

  it("refuses to build an overlay when a required native boundary is absent", () => {
    expect(inspect(call, { FightBegin: {}, StartButton1: {}, ClickedCorrectStage: {} })[0]).toMatchObject({ ok: false, error: expect.stringMatching(/boundary resource is missing: StartButton2/) });
  });
});

describeOnWindows("practice navigation callback evidence", () => {
  it("requires a FightBegin Stop start event from the same task id and process chain", () => {
    const variants = [event(), event({ message: 20002 }), event({ taskid: 8 }), event({ taskchain: "Custom" }), event({ subtask: "BattleProcessTask" }), event({ task: "Fight@FightBegin" }), event({ action: "ClickSelf" })];
    const cases = variants.map(value => ({ events: [value] })).concat([{ events: [] }]);
    inspect("Test-MaaNavigationStopped $case['events'] 7", {}, cases).forEach((probe, i) => expect(successful(probe)).toBe(i === 0));
  });

  it("requires completed read-only target OCR with exact code, task id and chain", () => {
    const variants = [event({}, true), event({ message: 20001 }, true), event({ taskid: 8 }, true), event({ taskchain: "Fight" }, true), event({ subtask: "StageNavigationTask" }, true), event({ task: "StageOF-F3" }, true), event({ action: "ClickSelf" }, true), ...["of-f3", "OF-F30", "OF-F3 ", "OF-F3 extra", ""].map(text => event({ text }, true))];
    const cases = variants.map(value => ({ events: [value] })).concat([{ events: [] }]);
    inspect("Test-MaaTargetStageCompleted $case['events'] 7 'MAAfightVerifyStage' 'OF-F3'", {}, cases).forEach((probe, i) => expect(successful(probe)).toBe(i === 0));
  });

  it("cannot assemble positive evidence from callbacks belonging to different executions", () => {
    const events = [event({ taskid: 8 }), event({ taskid: 9 }, true), event({ action: "DoNothing" }), event({ text: "OF-F30" }, true)];
    const results = successful(inspect("@{ stopped = (Test-MaaNavigationStopped $case['events'] 7); target = (Test-MaaTargetStageCompleted $case['events'] 7 'MAAfightVerifyStage' 'OF-F3') }", {}, [{ events }])[0]);
    expect(results).toEqual({ stopped: false, target: false });
  });
});
