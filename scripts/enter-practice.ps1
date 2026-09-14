param(
  [string]$Stage = "1-7",
  [string]$MaaDir = "",
  [string]$AdbPath = "",
  [string]$Address = "",
  [string]$ConnectConfig = "",
  [string]$ScriptPath = "",
  [int]$ExecutionTimeoutSec = 600,
  [ValidateSet("", "Normal", "Hard")]
  [string]$Difficulty = "",
  [switch]$NavigateOnly,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
trap {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}

function Resolve-MaaDir {
  param([string]$InputPath)

  $candidates = @()
  if ($InputPath.Trim()) { $candidates += $InputPath.Trim() }
  if ($env:MAAFIGHT_MAA_PATH) { $candidates += $env:MAAFIGHT_MAA_PATH }

  $localConfigPath = Join-Path (Resolve-Path ".").Path ".maafight\config.json"
  if (Test-Path -LiteralPath $localConfigPath) {
    try {
      $localConfig = Get-Content -LiteralPath $localConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
      if ([string]$localConfig.maaPath) { $candidates += [string]$localConfig.maaPath }
    } catch {
    }
  }

  if (Test-Path -LiteralPath "D:\app\MAA") { $candidates += "D:\app\MAA" }

  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    if ((Get-Item -LiteralPath $resolved).PSIsContainer) { return $resolved }
    return Split-Path -Parent $resolved
  }

  throw "MAA path is required. Fill MAA path in GUI, set MAAFIGHT_MAA_PATH, or pass -MaaDir."
}

function Get-MaaGuiConfig {
  param([string]$Dir)

  $newConfigPath = Join-Path $Dir "config\gui.new.json"
  if (Test-Path -LiteralPath $newConfigPath) {
    try {
      $raw = Get-Content -LiteralPath $newConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
      $current = if ($raw.Current) { $raw.Current } else { "Default" }
      $profile = $raw.Configurations.$current
      if (-not $profile) { $profile = $raw.Configurations.Default }
      $settings = $profile.Gui.ConnectSettings
      if ($settings) {
        return @{ "Connect.AdbPath" = [string]$settings.AdbPath; "Connect.Address" = [string]$settings.Address; "Connect.ConnectConfig" = [string]$settings.Config; "Copilot.SelectFormation" = $profile.Copilot.SelectFormation; "Client.Type" = [string]$profile.Gui.RuntimeSettings.ClientType }
      }
    } catch {
    }
  }

  $configPath = Join-Path $Dir "config\gui.json"
  if (-not (Test-Path -LiteralPath $configPath)) { return $null }
  $raw = Get-Content -LiteralPath $configPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $current = if ($raw.Current) { $raw.Current } else { "Default" }
  if ($raw.Configurations.$current) { return $raw.Configurations.$current }
  return $raw.Configurations.Default
}

. (Join-Path $PSScriptRoot "maa-navigation.ps1")

function Test-AsciiPath {
  param([string]$PathValue)

  foreach ($ch in $PathValue.ToCharArray()) {
    if ([int][char]$ch -gt 127) { return $false }
  }
  return $true
}

function Resolve-CopilotFilePath {
  param([string]$InputPath)

  $resolved = (Resolve-Path -LiteralPath $InputPath).Path
  if (Test-AsciiPath $resolved) { return $resolved }

  # ponytail: MaaCore receives this JSON through ANSI P/Invoke here; stage non-ASCII paths in an ASCII cache.
  $safeDir = Join-Path (Join-Path (Resolve-Path ".").Path ".maafight") "copilot-run"
  New-Item -ItemType Directory -Force -Path $safeDir | Out-Null
  $sha = [Security.Cryptography.SHA256]::Create()
  $inputFile = [IO.File]::OpenRead($resolved)
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash($inputFile)).Replace("-", "").ToLowerInvariant()
  } finally {
    $inputFile.Dispose()
    $sha.Dispose()
  }
  $safePath = Join-Path $safeDir "${hash}.json"
  Copy-Item -LiteralPath $resolved -Destination $safePath -Force
  return $safePath
}

$width = 1280
$height = 720
$bytesPerPixel = 3
$screenBytes = $width * $height * $bytesPerPixel

# ponytail: fixed 1280x720 MAA UI calibration; generalize when another resolution is actually needed.
function Get-BlueRatio {
  param([byte[]]$Bgr, [int]$X1, [int]$Y1, [int]$X2, [int]$Y2)

  $blue = 0
  $total = 0
  for ($y = $Y1; $y -lt $Y2; $y++) {
    for ($x = $X1; $x -lt $X2; $x++) {
      $offset = (($y * $width) + $x) * $bytesPerPixel
      $b = $Bgr[$offset]
      $g = $Bgr[$offset + 1]
      $r = $Bgr[$offset + 2]
      $total++
      if ($b -ge 120 -and $g -ge 100 -and $r -le 150 -and ($b - $r) -ge 40) {
        $blue++
      }
    }
  }
  return [double]$blue / [double]$total
}

function Get-WhiteRatio {
  param([byte[]]$Bgr, [int]$X1, [int]$Y1, [int]$X2, [int]$Y2)

  $white = 0
  $total = 0
  for ($y = $Y1; $y -lt $Y2; $y++) {
    for ($x = $X1; $x -lt $X2; $x++) {
      $offset = (($y * $width) + $x) * $bytesPerPixel
      $b = $Bgr[$offset]
      $g = $Bgr[$offset + 1]
      $r = $Bgr[$offset + 2]
      $total++
      if ($r -ge 210 -and $g -ge 210 -and $b -ge 210) {
        $white++
      }
    }
  }
  return [double]$white / [double]$total
}

function Test-ProxyEnabled {
  param([byte[]]$Bgr)
  return (Get-BlueRatio $Bgr 1045 570 1090 615) -ge 0.20 -or (Get-WhiteRatio $Bgr 1050 578 1084 606) -ge 0.20
}

function Test-StageDetail {
  param([byte[]]$Bgr)
  return (Get-BlueRatio $Bgr 1040 630 1245 690) -ge 0.20
}

function Test-PracticeReady {
  param([byte[]]$Bgr)
  return (Get-BlueRatio $Bgr 835 625 1035 690) -ge 0.20 -or (Get-WhiteRatio $Bgr 835 625 1035 690) -ge 0.12
}

function Set-TestBlueRegion {
  param([byte[]]$Bgr, [int]$X1, [int]$Y1, [int]$X2, [int]$Y2)

  for ($y = $Y1; $y -lt $Y2; $y++) {
    for ($x = $X1; $x -lt $X2; $x++) {
      $offset = (($y * $width) + $x) * $bytesPerPixel
      $Bgr[$offset] = 200
      $Bgr[$offset + 1] = 160
      $Bgr[$offset + 2] = 70
    }
  }
}

function Set-TestWhiteRegion {
  param([byte[]]$Bgr, [int]$X1, [int]$Y1, [int]$X2, [int]$Y2)

  for ($y = $Y1; $y -lt $Y2; $y++) {
    for ($x = $X1; $x -lt $X2; $x++) {
      $offset = (($y * $width) + $x) * $bytesPerPixel
      $Bgr[$offset] = 245
      $Bgr[$offset + 1] = 245
      $Bgr[$offset + 2] = 245
    }
  }
}

function Invoke-SelfTest {
  $blank = New-Object byte[] $screenBytes
  if (Test-ProxyEnabled $blank) { throw "blank proxy ROI should be off" }
  if (Test-StageDetail $blank) { throw "blank stage ROI should be off" }
  if (Test-PracticeReady $blank) { throw "blank practice ROI should be off" }

  $sample = New-Object byte[] $screenBytes
  Set-TestBlueRegion $sample 1045 570 1090 615
  Set-TestBlueRegion $sample 1040 630 1245 690
  Set-TestBlueRegion $sample 835 625 1035 690
  if (-not (Test-ProxyEnabled $sample)) { throw "blue proxy ROI should be on" }
  if (-not (Test-StageDetail $sample)) { throw "blue stage ROI should be on" }
  if (-not (Test-PracticeReady $sample)) { throw "blue practice ROI should be ready" }

  $whiteProxy = New-Object byte[] $screenBytes
  Set-TestWhiteRegion $whiteProxy 1050 578 1084 606
  if (-not (Test-ProxyEnabled $whiteProxy)) { throw "white proxy ROI should be on" }

  $whiteProxyOutline = New-Object byte[] $screenBytes
  Set-TestWhiteRegion $whiteProxyOutline 1058 584 1078 586
  Set-TestWhiteRegion $whiteProxyOutline 1058 602 1078 604
  Set-TestWhiteRegion $whiteProxyOutline 1058 584 1060 604
  Set-TestWhiteRegion $whiteProxyOutline 1076 584 1078 604
  if (Test-ProxyEnabled $whiteProxyOutline) { throw "white proxy outline should be off" }

  $whitePractice = New-Object byte[] $screenBytes
  Set-TestWhiteRegion $whitePractice 835 625 1035 690
  if (-not (Test-PracticeReady $whitePractice)) { throw "white practice ROI should be ready" }

  $nonAsciiDir = Join-Path (Join-Path (Resolve-Path ".").Path ".maafight") "selftest-nonascii"
  New-Item -ItemType Directory -Force -Path $nonAsciiDir | Out-Null
  $nonAsciiName = "$([char]0x4f5c)$([char]0x4e1a).json"
  $nonAsciiPath = Join-Path $nonAsciiDir $nonAsciiName
  Set-Content -LiteralPath $nonAsciiPath -Value "{}" -Encoding UTF8
  $safeCopilotPath = Resolve-CopilotFilePath $nonAsciiPath
  if (-not (Test-AsciiPath $safeCopilotPath)) { throw "safe copilot path should be ASCII" }
  if (-not (Test-Path -LiteralPath $safeCopilotPath)) { throw "safe copilot file should exist" }

  $configTestDir = Join-Path (Join-Path (Resolve-Path ".").Path ".maafight") "selftest-config"
  $guiConfigDir = Join-Path $configTestDir "config"
  New-Item -ItemType Directory -Force -Path $guiConfigDir | Out-Null
  Set-Content -LiteralPath (Join-Path $guiConfigDir "gui.new.json") -Encoding UTF8 -Value '{ "Current": "Practice", "Configurations": { "Practice": { "Gui": { "ConnectSettings": { "AdbPath": "C:\\adb.exe", "Address": "127.0.0.1:16384", "Config": "MuMuEmulator12" } }, "Copilot": { "SelectFormation": 2 } } } }'
  $newConfig = Get-MaaGuiConfig $configTestDir
  if ($newConfig.'Connect.AdbPath' -ne "C:\adb.exe" -or $newConfig.'Connect.Address' -ne "127.0.0.1:16384" -or $newConfig.'Connect.ConnectConfig' -ne "MuMuEmulator12") { throw "MAA 6 GUI connection config should load" }
  if ($newConfig.'Copilot.SelectFormation' -ne 2) { throw "MAA 6 selected formation should load" }
  Set-Content -LiteralPath (Join-Path $guiConfigDir "gui.new.json") -Encoding UTF8 -Value '{}'
  Set-Content -LiteralPath (Join-Path $guiConfigDir "gui.json") -Encoding UTF8 -Value '{ "Configurations": { "Default": { "Connect.Address": "emulator-5554", "Copilot.SelectFormation": "3" } } }'
  $legacyConfig = Get-MaaGuiConfig $configTestDir
  if ($legacyConfig.'Connect.Address' -ne "emulator-5554" -or $legacyConfig.'Copilot.SelectFormation' -ne "3") { throw "legacy GUI connection and formation config should load" }

  function Assert-SelfTestThrows {
    param([scriptblock]$Action, [string]$Expected)
    try { & $Action | Out-Null } catch {
      if ($_.Exception.Message -like "*$Expected*") { return }
      throw
    }
    throw "expected failure containing: $Expected"
  }

  $maaConfig = @{ 'Copilot.SelectFormation' = 0 }
  if ((Get-CopilotFormationIndex) -ne 0) { throw "current formation (0) must be preserved" }
  $maaConfig = @{ 'Copilot.SelectFormation' = 5 }
  Assert-SelfTestThrows { Get-CopilotFormationIndex } "integer from 0 to 4"

  $completed = @(@{ message = 10002; details = @{ taskid = 7; taskchain = "Copilot" } })
  if (-not (Get-MaaTaskState $completed 7)) { throw "matching completion callback should complete task" }
  if (Get-MaaTaskState $completed 8) { throw "another task's completion must not complete task" }
  if (Get-MaaTaskState @(@{ message = 3; details = @{ taskid = 7 } }) 7) { throw "AllTasksCompleted alone must not prove task success" }
  $failed = @(@{ message = 10000; details = @{ taskid = 7; taskchain = "Copilot" } }) + $completed
  Assert-SelfTestThrows { Get-MaaTaskState $failed 7 } "failed or stopped"
  Assert-SelfTestThrows { Get-MaaTaskState @(@{ message = 10004; details = @{ taskid = 7 } }) 7 } "failed or stopped"
  $ignoredPrecheck = @(@{ message = 20000; details = @{ taskid = 7; subtask = "ProcessTask"; details = @{ task = "BattleStartPre" } } }) + $completed
  if (-not (Get-MaaTaskState $ignoredPrecheck 7)) { throw "ignored initial precheck may precede a successful Copilot" }

  [MaaCoreEnterPractice]::Callback.Invoke(10000, '{"taskid":7,"taskchain":"Copilot"}', [IntPtr]::Zero)
  Assert-SelfTestThrows { Wait-MaaTask ([IntPtr]::Zero) 7 1 "test" } "failed or stopped"
  $maaEvents.Clear()
  [MaaCoreEnterPractice]::Callback.Invoke(4, '{"async_call_id":9,"what":"Click","details":{"ret":true}}', [IntPtr]::Zero)
  Read-MaaEvents
  if (-not (Get-MaaAsyncResult $maaEvents.ToArray() 9)) { throw "callback delegate should preserve a successful click result" }
  if (Get-MaaAsyncResult $maaEvents.ToArray() 10) { throw "another async call must not prove success" }
  Assert-SelfTestThrows { Get-MaaAsyncResult @(@{ message = 4; details = @{ async_call_id = 9; what = "Screencap"; details = @{ ret = $false } } }) 9 } "Screencap failed"
  Assert-SelfTestThrows { Get-MaaAsyncResult @(@{ message = 4; details = @{ async_call_id = 9; what = "Click"; details = @{} } }) 9 } "Click failed"
  $maaEvents.Clear()

  $templateTestDir = Join-Path (Join-Path (Resolve-Path ".").Path ".maafight") "selftest-practice-template"
  $templateTestPath = Join-Path $templateTestDir "resource\template\Battle\StartButton"
  New-Item -ItemType Directory -Force -Path $templateTestPath | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\__tests__\fixtures\practice-start-button.png") -Destination (Join-Path $templateTestPath "BattleStartExercise.png") -Force
  $practiceTemplate = Read-PracticeTemplate $templateTestDir
  $exerciseFormation = New-Object byte[] $screenBytes
  for ($y = 0; $y -lt $practiceTemplate.height; $y++) {
    [Array]::Copy($practiceTemplate.bgr, $y * $practiceTemplate.width * 3, $exerciseFormation, (($y + 366) * $width + 1038) * 3, $practiceTemplate.width * 3)
  }
  if (-not (Test-PracticeFormation $exerciseFormation)) { throw "real exercise button should verify formation" }
  if (Test-PracticeFormation $blank) { throw "blank screen must not verify exercise formation" }
  if (Test-PracticeFormation $sample) { throw "stage-detail buttons must not verify exercise formation" }
  $normalFormation = $exerciseFormation.Clone()
  for ($p = 0; $p -lt $normalFormation.Length; $p += 3) {
    $blue = $normalFormation[$p]
    $normalFormation[$p] = $normalFormation[$p + 2]
    $normalFormation[$p + 2] = $blue
  }
  if (Test-PracticeFormation $normalFormation) { throw "normal orange formation button must not verify exercise" }
  function Get-ScreenBgr { param([IntPtr]$Handle) return $normalFormation }
  Assert-SelfTestThrows { Invoke-Copilot ([IntPtr]::Zero) "unused.json" } "Exercise formation changed"

  @{ ok = $true; selfTest = $true; callbackChecks = 11; practiceChecks = 5 } | ConvertTo-Json -Compress
}

$code = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class MaaPracticeEvent {
  public int Message;
  public string Json;
}

public static class MaaCoreEnterPractice {
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  public delegate void ApiCallback(int message, [MarshalAs(UnmanagedType.LPUTF8Str)] string details, IntPtr customArg);

  private static readonly ConcurrentQueue<MaaPracticeEvent> Events = new ConcurrentQueue<MaaPracticeEvent>();
  public static readonly ApiCallback Callback = ReceiveCallback;

  private static void ReceiveCallback(int message, string details, IntPtr customArg) {
    Events.Enqueue(new MaaPracticeEvent { Message = message, Json = details });
  }

  public static MaaPracticeEvent[] DrainEvents() {
    var result = new List<MaaPracticeEvent>();
    MaaPracticeEvent item;
    while (Events.TryDequeue(out item)) result.Add(item);
    return result.ToArray();
  }

  // Match the complete official exercise button, including its blue PLAN footer.
  // Sampling every fourth pixel bounds CPU work while retaining both color and lettering.
  public static double PracticeTemplateScore(byte[] bgr, byte[] template, int tw, int th) {
    if (bgr == null || bgr.Length != 1280 * 720 * 3 || tw <= 0 || th <= 0 ||
        tw > 232 || th > 374 || template == null || template.Length != tw * th * 3) return 0;
    double best = 0;
    for (int oy = 318; oy <= 692 - th; oy++) {
      for (int ox = 989; ox <= 1221 - tw; ox++) {
        long error = 0;
        int count = 0;
        for (int y = 0; y < th; y += 4) {
          for (int x = 0; x < tw; x += 4) {
            int p = ((oy + y) * 1280 + ox + x) * 3, t = (y * tw + x) * 3;
            for (int c = 0; c < 3; c++) { error += Math.Abs(bgr[p + c] - template[t + c]); count++; }
          }
        }
        best = Math.Max(best, 1.0 - (double)error / (count * 255));
      }
    }
    return best;
  }

  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool SetDllDirectory(string lpPathName);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern byte AsstSetUserDir([MarshalAs(UnmanagedType.LPUTF8Str)] string path);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern byte AsstLoadResource([MarshalAs(UnmanagedType.LPUTF8Str)] string path);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern IntPtr AsstCreateEx(ApiCallback callback, IntPtr customArg);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern void AsstDestroy(IntPtr handle);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern byte AsstConnect(IntPtr handle, string adb_path, string address, string config);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern byte AsstConnected(IntPtr handle);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern int AsstAppendTask(IntPtr handle, string type, string task_params);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern byte AsstStart(IntPtr handle);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern byte AsstRunning(IntPtr handle);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern byte AsstStop(IntPtr handle);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int AsstAsyncScreencap(IntPtr handle, byte block);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern UInt64 AsstGetImageBgr(IntPtr handle, byte[] buff, UInt64 buff_size);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int AsstAsyncClick(IntPtr handle, int x, int y, byte block);
}
'@

Add-Type -TypeDefinition $code
$maaEvents = New-Object 'System.Collections.Generic.List[object]'

function Read-MaaEvents {
  foreach ($entry in [MaaCoreEnterPractice]::DrainEvents()) {
    $details = $entry.Json | ConvertFrom-Json
    $maaEvents.Add(@{ message = $entry.Message; details = $details })
  }
}

function Get-MaaTaskState {
  param([object[]]$Events, [int]$TaskId)

  $completed = $false
  $lastSubtask = ""
  foreach ($entry in $Events) {
    $details = $entry.details
    if ($entry.message -eq 0 -or $entry.message -eq 1) { throw "MaaCore internal error: $($details.what) $($details.why)" }
    if ($details.taskid -ne $TaskId) { continue }
    if ($entry.message -eq 20000) { $lastSubtask = "$($details.subtask) $($details.details.task)" }
    if ($entry.message -eq 10000 -or $entry.message -eq 10004) {
      throw "MAA task $TaskId failed or stopped (callback $($entry.message)); $lastSubtask $($details.details.error)"
    }
    if ($entry.message -eq 10002) { $completed = $true }
  }
  return $completed
}

function Get-MaaAsyncResult {
  param([object[]]$Events, [int]$CallId)

  foreach ($entry in $Events) {
    if ($entry.message -ne 4 -or $entry.details.async_call_id -ne $CallId) { continue }
    if ($entry.details.details.ret -isnot [bool] -or -not $entry.details.details.ret) { throw "MAA $($entry.details.what) failed (async call $CallId)" }
    return $true
  }
  return $false
}

function Wait-MaaAsyncCall {
  param([int]$CallId)

  if ($CallId -le 0) { throw "MAA asynchronous call was not accepted" }
  $deadline = (Get-Date).AddSeconds(5)
  do {
    Read-MaaEvents
    if (Get-MaaAsyncResult $maaEvents.ToArray() $CallId) { return }
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  throw "MAA asynchronous call $CallId completed without a verified result"
}

function Read-PracticeTemplate {
  param([string]$Dir)

  $paths = @("resource\template\Battle\StartButton\BattleStartExercise.png", "resource\template\BattleStartExercise.png")
  $templatePath = $paths | ForEach-Object { Join-Path $Dir $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $templatePath) { throw "Official BattleStartExercise template is missing; practice cannot be verified" }
  Add-Type -AssemblyName System.Drawing
  $bitmap = New-Object System.Drawing.Bitmap $templatePath
  try {
    $pixels = New-Object byte[] ($bitmap.Width * $bitmap.Height * 3)
    for ($y = 0; $y -lt $bitmap.Height; $y++) {
      for ($x = 0; $x -lt $bitmap.Width; $x++) {
        $color = $bitmap.GetPixel($x, $y)
        $p = ($y * $bitmap.Width + $x) * 3
        $pixels[$p] = $color.B; $pixels[$p + 1] = $color.G; $pixels[$p + 2] = $color.R
      }
    }
    return @{ bgr = $pixels; width = $bitmap.Width; height = $bitmap.Height }
  } finally { $bitmap.Dispose() }
}

function Test-PracticeFormation {
  param([byte[]]$Bgr)

  return [MaaCoreEnterPractice]::PracticeTemplateScore($Bgr, $practiceTemplate.bgr, $practiceTemplate.width, $practiceTemplate.height) -ge 0.92
}

function Wait-PracticeFormation {
  param([IntPtr]$Handle)

  $deadline = (Get-Date).AddSeconds(15)
  do {
    if (Test-PracticeFormation (Get-ScreenBgr $Handle)) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Exercise formation was not verified; Copilot was not started. No normal battle will be queued."
}

function Invoke-Click {
  param([IntPtr]$Handle, [int]$X, [int]$Y)
  $callId = [MaaCoreEnterPractice]::AsstAsyncClick($Handle, $X, $Y, 1)
  Wait-MaaAsyncCall $callId
  return $callId
}

function Get-ScreenBgr {
  param([IntPtr]$Handle)

  $captureId = [MaaCoreEnterPractice]::AsstAsyncScreencap($Handle, 1)
  Wait-MaaAsyncCall $captureId
  $bgr = New-Object byte[] $screenBytes
  $size = [MaaCoreEnterPractice]::AsstGetImageBgr($Handle, $bgr, [UInt64]$bgr.Length)
  if ($size -lt $screenBytes) { throw "AsstGetImageBgr returned $size bytes" }
  return $bgr
}

function Wait-ProxyDisabled {
  param([IntPtr]$Handle)

  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 250
    $bgr = Get-ScreenBgr $Handle
    if (-not (Test-ProxyEnabled $bgr)) { return $bgr }
  }
  throw "proxy command stayed enabled; practice click skipped"
}

function Wait-PracticeReady {
  param([IntPtr]$Handle, [byte[]]$Bgr)

  $current = $Bgr
  for ($i = 0; $i -lt 12; $i++) {
    if (Test-PracticeReady $current) { return $current }
    Start-Sleep -Milliseconds 250
    $current = Get-ScreenBgr $Handle
  }
  throw "practice button not ready; practice click skipped"
}

function Wait-MaaTask {
  param([IntPtr]$Handle, [int]$TaskId, [int]$TimeoutSec, [string]$Name)

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $idleDeadline = $null
  while ($true) {
    Read-MaaEvents
    $completed = Get-MaaTaskState $maaEvents.ToArray() $TaskId
    if ([MaaCoreEnterPractice]::AsstRunning($Handle) -eq 0) {
      if ($completed) { return }
      if (-not $idleDeadline) { $idleDeadline = (Get-Date).AddSeconds(5) }
      if ((Get-Date) -gt $idleDeadline) { throw "$Name stopped without TaskChainCompleted callback" }
    }
    if ((Get-Date) -gt $deadline) {
      [MaaCoreEnterPractice]::AsstStop($Handle) | Out-Null
      throw "$Name timed out after $TimeoutSec seconds"
    }
    Start-Sleep -Milliseconds 500
  }
}

function Invoke-MaaNavigationTask {
  param([IntPtr]$Handle, [string]$Type, [hashtable]$Parameters, [string]$Name, [int]$TimeoutSec = 300)

  $taskId = [MaaCoreEnterPractice]::AsstAppendTask($Handle, $Type, ($Parameters | ConvertTo-Json -Compress))
  if ($taskId -le 0) { throw "MAA did not accept $Name" }
  if ([MaaCoreEnterPractice]::AsstStart($Handle) -eq 0) { throw "MAA did not start $Name" }
  Wait-MaaTask $Handle $taskId $TimeoutSec $Name
  return $taskId
}

function New-ConnectedMaaHandle {
  $handle = [MaaCoreEnterPractice]::AsstCreateEx([MaaCoreEnterPractice]::Callback, [IntPtr]::Zero)
  if ($handle -eq [IntPtr]::Zero) { throw "AsstCreateEx failed" }

  try {
    if ([MaaCoreEnterPractice]::AsstConnect($handle, $AdbPath, $Address, $ConnectConfig) -eq 0) {
      throw "AsstConnect failed"
    }
    if ([MaaCoreEnterPractice]::AsstConnected($handle) -eq 0) {
      throw "AsstConnected failed"
    }
    return $handle
  } catch {
    [MaaCoreEnterPractice]::AsstDestroy($handle)
    throw
  }
}

function Get-CopilotFormationIndex {
  if (-not $maaConfig -or $null -eq $maaConfig.'Copilot.SelectFormation') { return 4 }
  try {
    $value = [int]([string]$maaConfig.'Copilot.SelectFormation')
    if ($value -ge 0 -and $value -le 4) { return $value }
  } catch {
  }
  throw "MAA Copilot.SelectFormation must be an integer from 0 to 4"
}

function Invoke-Copilot {
  param([IntPtr]$Handle, [string]$FilePath)

  # Copilot accepts normal and exercise starts; verify exercise immediately before handing over control.
  if (-not (Test-PracticeFormation (Get-ScreenBgr $Handle))) { throw "Exercise formation changed; Copilot was not started" }
  $taskParams = @{
    filename = (Resolve-Path -LiteralPath $FilePath).Path
    formation = $true
    support_unit_usage = 0
    add_trust = $false
    ignore_requirements = $true
    loop_times = 1
    use_sanity_potion = $false
    formation_index = Get-CopilotFormationIndex
  } | ConvertTo-Json -Compress

  $taskId = [MaaCoreEnterPractice]::AsstAppendTask($Handle, "Copilot", $taskParams)
  if ($taskId -le 0) { throw "AsstAppendTask Copilot failed for $FilePath" }
  if ([MaaCoreEnterPractice]::AsstStart($Handle) -eq 0) { throw "AsstStart Copilot failed" }

  Wait-MaaTask $Handle $taskId $ExecutionTimeoutSec "Copilot execution"

  return $taskId
}

if ($SelfTest) {
  Invoke-SelfTest
  return
}

$MaaDir = Resolve-MaaDir $MaaDir
$maaConfig = Get-MaaGuiConfig $MaaDir
$stageName = $Stage.Trim()
if (-not $AdbPath.Trim() -and $maaConfig) { $AdbPath = [string]$maaConfig.'Connect.AdbPath' }
if (-not $Address.Trim() -and $maaConfig) { $Address = [string]$maaConfig.'Connect.Address' }
if (-not $ConnectConfig.Trim() -and $maaConfig) { $ConnectConfig = [string]$maaConfig.'Connect.ConnectConfig' }
if (-not $ConnectConfig.Trim()) { $ConnectConfig = "General" }
if (-not $stageName) { throw "Stage is required" }
if ($ScriptPath.Trim() -and -not (Test-Path -LiteralPath $ScriptPath.Trim())) { throw "script file not found: $ScriptPath" }
if (-not (Test-Path -LiteralPath (Join-Path $MaaDir "MaaCore.dll"))) { throw "MaaCore.dll not found in $MaaDir" }
if (-not $AdbPath.Trim()) { throw "adb path is required. Configure MAA connection settings or pass -AdbPath." }
if (-not $Address.Trim()) { throw "adb address is required. Configure MAA connection settings or pass -Address." }
if (-not (Test-Path -LiteralPath $AdbPath)) { throw "adb.exe not found: $AdbPath" }
$practiceTemplate = Read-PracticeTemplate $MaaDir
$root = (Resolve-Path ".").Path
$clientType = [string]$maaConfig.'Client.Type'
if ($clientType -notin @('Official', 'Bilibili', 'YoStarEN', 'YoStarJP', 'YoStarKR', 'txwy')) {
  throw 'Configure the game client type in MAA before starting practice'
}
$resourceRoots = @(Get-MaaResourceRoots $MaaDir $clientType)
$navigationTasks = Read-MaaTaskDefinitions $resourceRoots
$navigationRequest = Get-MaaNavigationRequest $navigationTasks $stageName $Difficulty
$stageName = $navigationRequest.code
$navigationResult = $null

if (-not $NavigateOnly) {
  # The guarded resources live only in the child. Never restore them in the Copilot process:
  # MaaCore retains task pointers and lazily generated namespaces across resource reloads.
  $navigationArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
    '-NavigateOnly', '-Stage', $stageName, '-MaaDir', $MaaDir, '-AdbPath', $AdbPath,
    '-Address', $Address, '-ConnectConfig', $ConnectConfig)
  if ($navigationRequest.difficulty) { $navigationArgs += @('-Difficulty', $navigationRequest.difficulty) }
  $navigationOutput = @(& (Join-Path $PSHOME 'powershell.exe') @navigationArgs)
  $navigationExitCode = $LASTEXITCODE
  try { $navigationResult = ($navigationOutput | Where-Object { $_.Trim() } | Select-Object -Last 1) | ConvertFrom-Json }
  catch { throw 'MAA wake-up/navigation returned an invalid result' }
  if ($navigationExitCode -ne 0 -or -not $navigationResult.ok) { throw $navigationResult.error }
  if (-not $navigationResult.stageVerified -or $navigationResult.stage -cne $stageName) {
    throw 'MAA navigation did not verify the requested stage'
  }
}

$userDir = if ($NavigateOnly) { Join-Path $root ('.maafight\maa-navigation\' + [Guid]::NewGuid().ToString('N')) } else { Join-Path $root '.maafight\maa-core' }
New-Item -ItemType Directory -Force -Path $userDir | Out-Null
[System.Environment]::SetEnvironmentVariable("PATH", "$MaaDir;$env:PATH", "Process")
[MaaCoreEnterPractice]::SetDllDirectory($MaaDir) | Out-Null
if ([MaaCoreEnterPractice]::AsstSetUserDir($userDir) -eq 0) { throw "AsstSetUserDir failed" }
foreach ($resourceRoot in $resourceRoots) {
  if ([MaaCoreEnterPractice]::AsstLoadResource($resourceRoot) -eq 0) { throw "AsstLoadResource failed: $resourceRoot" }
}
$overlay = New-MaaNavigationOverlay $navigationTasks $stageName
if (-not $NavigateOnly) {
  # Only add a read-only OCR task here. All native battle resources remain original for Copilot.
  $overlay = @{ MAAfightVerifyStage = $overlay['MAAfightVerifyStage'] }
}
$overlayResource = Join-Path $userDir 'resource'
New-Item -ItemType Directory -Force -Path $overlayResource | Out-Null
[IO.File]::WriteAllText((Join-Path $overlayResource 'tasks.json'), ($overlay | ConvertTo-Json -Depth 100 -Compress), (New-Object Text.UTF8Encoding $false))
if ([MaaCoreEnterPractice]::AsstLoadResource($userDir) -eq 0) { throw 'MAA refused the navigation resource overlay' }

$handle = New-ConnectedMaaHandle
try {
  if ($NavigateOnly) {
    try {
      $startupTaskId = Invoke-MaaNavigationTask $handle 'StartUp' @{ enable = $true; client_type = $clientType; start_game_enabled = $true } 'game wake-up' 300
    } catch { throw "Game wake-up failed; navigation was not started: $($_.Exception.Message)" }
    $navigationTaskId = $null
    if ($navigationRequest.supported) {
      $parameters = @{
        stage = $navigationRequest.nativeName; times = 1; series = -1
        medicine = 0; medicine_expire_days = 0; stone = 0; DrGrandet = $false
        report_to_penguin = $false; report_to_yituliu = $false; client_type = $clientType
      }
      $navigationTaskId = Invoke-MaaNavigationTask $handle 'Fight' $parameters "navigate to $($navigationRequest.nativeName)" 300
      if (-not (Test-MaaNavigationStopped $maaEvents.ToArray() $navigationTaskId)) {
        throw 'MAA navigation did not reach the protected stop boundary'
      }
    }
    try {
      $verificationTaskId = Invoke-MaaNavigationTask $handle 'Custom' @{ task_names = @('MAAfightVerifyStage') } "verify stage $stageName" 30
      if (-not (Test-MaaTargetStageCompleted $maaEvents.ToArray() $verificationTaskId 'MAAfightVerifyStage' $stageName)) {
        throw 'No exact target-stage OCR completion was received'
      }
      if (-not (Test-StageDetail (Get-ScreenBgr $handle))) { throw 'The target stage details are not visible' }
    } catch {
      if (-not $navigationRequest.supported) {
        throw "Current MAA resources have no navigation route for $stageName. Open that stage's details manually and retry. $($_.Exception.Message)"
      }
      throw "MAA did not verify the selected stage $stageName; practice was not started. $($_.Exception.Message)"
    }
    @{
      ok = $true; stage = $stageName; stageVerified = $true; startupVerified = $true
      startupTaskId = $startupTaskId; navigationTaskId = $navigationTaskId; verificationTaskId = $verificationTaskId
      navigationSkipped = (-not $navigationRequest.supported)
      navigationMode = $(if ($navigationRequest.supported) { 'maa-native-navigation' } else { 'verified-manual-stage-detail' })
      difficulty = $navigationRequest.difficulty; navigationLogDir = $userDir
    } | ConvertTo-Json -Compress
    return
  }

  # Recheck the page after the isolated navigation process exits, before any practice click.
  $verificationTaskId = Invoke-MaaNavigationTask $handle 'Custom' @{ task_names = @('MAAfightVerifyStage') } "recheck stage $stageName before practice" 30
  if (-not (Test-MaaTargetStageCompleted $maaEvents.ToArray() $verificationTaskId 'MAAfightVerifyStage' $stageName)) {
    throw 'The selected stage changed after navigation; practice was not started'
  }
  $bgr = Get-ScreenBgr $handle
  if (-not (Test-StageDetail $bgr)) { throw 'Stage details changed after navigation; practice was not started' }
  $closedProxy = $false
  if (Test-ProxyEnabled $bgr) {
    Invoke-Click $handle 1066 592 | Out-Null
    $closedProxy = $true
    $bgr = Wait-ProxyDisabled $handle
  }
  $bgr = Wait-PracticeReady $handle $bgr
  $practiceCallId = Invoke-Click $handle 934 658
  Wait-PracticeFormation $handle
  $copilotTaskId = $null
  $resolvedScriptPath = $null
  $copilotScriptPath = $null
  if ($ScriptPath.Trim()) {
    $resolvedScriptPath = (Resolve-Path -LiteralPath $ScriptPath.Trim()).Path
    $copilotScriptPath = Resolve-CopilotFilePath $resolvedScriptPath
    $copilotTaskId = Invoke-Copilot $handle $copilotScriptPath
  }
  @{
    ok = $true
    stage = $stageName
    maaDir = $MaaDir
    startupTaskId = $navigationResult.startupTaskId
    startupVerified = $navigationResult.startupVerified
    navigationTaskId = $navigationResult.navigationTaskId
    verificationTaskId = $verificationTaskId
    navigationVerificationTaskId = $navigationResult.verificationTaskId
    navigationSkipped = $navigationResult.navigationSkipped
    navigationMode = $navigationResult.navigationMode
    navigationLogDir = $navigationResult.navigationLogDir
    difficulty = $navigationResult.difficulty
    stageVerified = $true
    practiceVerified = $true
    alreadyInPracticeFormation = $false
    taskCompleted = ($null -ne $copilotTaskId)
    closedProxy = $closedProxy
    practiceCallId = $practiceCallId
    copilotTaskId = $copilotTaskId
    scriptPath = $resolvedScriptPath
    copilotScriptPath = $copilotScriptPath
  } | ConvertTo-Json -Compress
} finally {
  [MaaCoreEnterPractice]::AsstStop($handle) | Out-Null
  [MaaCoreEnterPractice]::AsstDestroy($handle)
}
