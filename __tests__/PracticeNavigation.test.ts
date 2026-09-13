import { spawnSync } from "child_process";
import * as path from "path";

const describeOnWindows = process.platform === "win32" ? describe : describe.skip;
const scriptPath = path.resolve(__dirname, "../scripts/enter-practice.ps1").replace(/'/g, "''");

function inspect(functionCall: string, definitions: Record<string, unknown>) {
  const command = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}', [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw $parseErrors[0] }
    foreach ($definition in $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
      if ($definition.Name -in @('Assert-SafeStageNavigation', 'Get-SafeTerminalTasks', 'Test-MaaTargetStageCompleted')) {
        . ([scriptblock]::Create($definition.Extent.Text))
      }
    }
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $inputTasks = $serializer.DeserializeObject($env:MAAFIGHT_NAVIGATION_TEST_INPUT)
    $tasks = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    foreach ($key in $inputTasks.Keys) { $tasks[$key] = $inputTasks[$key] }
    try { @{ ok = $true; result = (${functionCall}) } | ConvertTo-Json -Compress -Depth 10 }
    catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }
  `;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 15_000, windowsHide: true,
    env: { ...process.env, MAAFIGHT_NAVIGATION_TEST_INPUT: JSON.stringify(definitions) },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim()) as { ok: boolean; result?: unknown; error?: string };
}

function safeTasks(): Record<string, any> {
  return {
    "1-7": { algorithm: "JustReturn", next: ["Episode1"] },
    Episode1: { algorithm: "MatchTemplate", action: "ClickSelf", next: ["Stage1-7"] },
    "Stage1-7": { algorithm: "OcrDetect", action: "ClickSelf", text: ["1-7"] },
  };
}

describeOnWindows("practice navigation safety boundary", () => {
  it("accepts a stage-specific path that stops after clicking the selected stage", () => {
    expect(inspect("Assert-SafeStageNavigation $tasks '1-7'", safeTasks())).toEqual({ ok: true, result: "Stage1-7" });
  });

  it.each(["next", "sub", "onErrorNext", "exceededNext"])("rejects a normal battle hidden behind %s", edge => {
    const tasks = safeTasks();
    tasks.Episode1[edge] = ["StartButton2"];
    expect(inspect("Assert-SafeStageNavigation $tasks '1-7'", tasks).ok).toBe(false);
  });

  it("rejects a target that continues after entering the stage detail", () => {
    const tasks = safeTasks();
    tasks["Stage1-7"].next = ["Stop"];
    tasks.Stop = { action: "Stop" };
    expect(inspect("Assert-SafeStageNavigation $tasks '1-7'", tasks).ok).toBe(false);
  });

  it("inspects explicit namespace overrides instead of trusting the base task", () => {
    const tasks = safeTasks();
    tasks["1-7"].next = ["Episode1@Stage1-7"];
    tasks["Episode1@Stage1-7"] = { next: ["StartButton2"] };
    expect(inspect("Assert-SafeStageNavigation $tasks '1-7'", tasks).ok).toBe(false);
  });

  it("refuses unknown stages instead of guessing a navigation task", () => {
    expect(inspect("Assert-SafeStageNavigation $tasks 'UNKNOWN'", safeTasks()).ok).toBe(false);
  });

  it("uses theme button candidates without running the theme-changing entry fallback", () => {
    const tasks = {
      "Terminal-Entry": { next: ["TerminalDefault"], onErrorNext: ["SwitchTheme"] },
      TerminalDefault: { action: "ClickSelf", next: ["#self", "Stop"] },
      Stop: { algorithm: "JustReturn", action: "Stop" },
      Return: { algorithm: "MatchTemplate", action: "ClickSelf", template: "Return.png" },
    };
    expect(inspect("@(Get-SafeTerminalTasks $tasks)", tasks)).toEqual({ ok: true, result: ["TerminalDefault"] });
  });

  it("rejects an unsafe continuation inherited by a terminal theme", () => {
    const tasks = {
      "Terminal-Entry": { next: ["TerminalDefault"] },
      TerminalDefault: { baseTask: "TerminalCommon" },
      TerminalCommon: { action: "ClickSelf", onErrorNext: ["StartButton2"] },
      Stop: { algorithm: "JustReturn", action: "Stop" },
      Return: { algorithm: "MatchTemplate", action: "ClickSelf", template: "Return.png" },
    };
    expect(inspect("Get-SafeTerminalTasks $tasks", tasks).ok).toBe(false);
  });

  it("rejects a Stop task redefined to continue to a normal battle", () => {
    const tasks = {
      "Terminal-Entry": { next: ["TerminalDefault"] },
      TerminalDefault: { action: "ClickSelf", next: ["Stop"] },
      Stop: { algorithm: "JustReturn", action: "Stop", next: ["StartButton2"] },
      Return: { algorithm: "MatchTemplate", action: "ClickSelf", template: "Return.png" },
    };
    expect(inspect("Get-SafeTerminalTasks $tasks", tasks).ok).toBe(false);
  });

  it("rejects a Return button with a hidden normal-start continuation", () => {
    const tasks = {
      "Terminal-Entry": { next: ["TerminalDefault"] },
      TerminalDefault: { action: "ClickSelf", next: ["Stop"] },
      Stop: { algorithm: "JustReturn", action: "Stop" },
      Return: { algorithm: "MatchTemplate", action: "ClickSelf", onErrorNext: ["StartButton2"] },
    };
    expect(inspect("Get-SafeTerminalTasks $tasks", tasks).ok).toBe(false);
  });

  it.each([
    [7, "1-7", true],
    [8, "1-7", false],
    [7, "1-8", false],
  ])("requires the same task id and recognized stage in the completion callback (%s, %s)", (taskId, text, expected) => {
    const events = [{ message: 20002, details: { taskid: taskId, taskchain: "Custom", subtask: "ProcessTask", details: { task: "Stage1-7", action: "ClickSelf", result: { text } } } }];
    expect(inspect("Test-MaaTargetStageCompleted $tasks['events'] 7 'Stage1-7' '1-7'", { events }).result).toBe(expected);
  });

  it("does not accept a matching stage callback from another task chain", () => {
    const events = [{ message: 20002, details: { taskid: 7, taskchain: "Copilot", subtask: "ProcessTask", details: { task: "Stage1-7", action: "ClickSelf", result: { text: "1-7" } } } }];
    expect(inspect("Test-MaaTargetStageCompleted $tasks['events'] 7 'Stage1-7' '1-7'", { events }).result).toBe(false);
  });
});
