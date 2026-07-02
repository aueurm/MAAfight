param(
  [string]$Stage = "1-7",
  [string]$MaaDir = "",
  [string]$AdbPath = "",
  [string]$Address = "",
  [string]$ConnectConfig = "",
  [string]$ClientType = "Official",
  [int]$StartupTimeoutSec = 180,
  [int]$NavigationTimeoutSec = 120,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

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

  $configPath = Join-Path $Dir "config\gui.json"
  if (-not (Test-Path -LiteralPath $configPath)) { return $null }
  $raw = Get-Content -LiteralPath $configPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $current = if ($raw.Current) { $raw.Current } else { "Default" }
  return $raw.Configurations.$current
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

  $whitePractice = New-Object byte[] $screenBytes
  Set-TestWhiteRegion $whitePractice 835 625 1035 690
  if (-not (Test-PracticeReady $whitePractice)) { throw "white practice ROI should be ready" }

  @{ ok = $true; selfTest = $true } | ConvertTo-Json -Compress
}

if ($SelfTest) {
  Invoke-SelfTest
  return
}

$MaaDir = Resolve-MaaDir $MaaDir
$maaConfig = Get-MaaGuiConfig $MaaDir
if (-not $AdbPath.Trim() -and $maaConfig) { $AdbPath = [string]$maaConfig.'Connect.AdbPath' }
if (-not $Address.Trim() -and $maaConfig) { $Address = [string]$maaConfig.'Connect.Address' }
if (-not $ConnectConfig.Trim() -and $maaConfig) { $ConnectConfig = [string]$maaConfig.'Connect.ConnectConfig' }
if (-not $ConnectConfig.Trim()) { $ConnectConfig = "General" }

if (-not $Stage.Trim()) { throw "Stage is required" }
if (-not (Test-Path -LiteralPath (Join-Path $MaaDir "MaaCore.dll"))) { throw "MaaCore.dll not found in $MaaDir" }
if (-not $AdbPath.Trim()) { throw "adb path is required. Configure MAA connection settings or pass -AdbPath." }
if (-not $Address.Trim()) { throw "adb address is required. Configure MAA connection settings or pass -Address." }
if (-not (Test-Path -LiteralPath $AdbPath)) { throw "adb.exe not found: $AdbPath" }

$root = (Resolve-Path ".").Path
$userDir = Join-Path $root ".maafight\maa-core"
New-Item -ItemType Directory -Force -Path $userDir | Out-Null

[System.Environment]::SetEnvironmentVariable("PATH", "$MaaDir;$env:PATH", "Process")

$code = @'
using System;
using System.Runtime.InteropServices;

public static class MaaCoreEnterPractice {
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool SetDllDirectory(string lpPathName);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern byte AsstSetUserDir(string path);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern byte AsstLoadResource(string path);

  [DllImport("MaaCore.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern IntPtr AsstCreate();

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
[MaaCoreEnterPractice]::SetDllDirectory($MaaDir) | Out-Null

if ([MaaCoreEnterPractice]::AsstSetUserDir($userDir) -eq 0) { throw "AsstSetUserDir failed" }
if ([MaaCoreEnterPractice]::AsstLoadResource($MaaDir) -eq 0) { throw "AsstLoadResource failed" }

function Invoke-Click {
  param([IntPtr]$Handle, [int]$X, [int]$Y)
  $callId = [MaaCoreEnterPractice]::AsstAsyncClick($Handle, $X, $Y, 1)
  if ($callId -le 0) { throw "AsstAsyncClick failed at $X,$Y" }
  return $callId
}

function Get-ScreenBgr {
  param([IntPtr]$Handle)

  [MaaCoreEnterPractice]::AsstAsyncScreencap($Handle, 1) | Out-Null
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
  param([IntPtr]$Handle, [int]$TimeoutSec, [string]$Name)

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ([MaaCoreEnterPractice]::AsstRunning($Handle) -ne 0) {
    if ((Get-Date) -gt $deadline) {
      [MaaCoreEnterPractice]::AsstStop($Handle) | Out-Null
      throw "$Name timed out after $TimeoutSec seconds"
    }
    Start-Sleep -Milliseconds 500
  }
}

function New-ConnectedMaaHandle {
  $handle = [MaaCoreEnterPractice]::AsstCreate()
  if ($handle -eq [IntPtr]::Zero) { throw "AsstCreate failed" }

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

function Invoke-Startup {
  param([IntPtr]$Handle)

  $startupParams = @{
    client_type = $ClientType
    start_game_enabled = $true
  } | ConvertTo-Json -Compress
  $startupTaskId = [MaaCoreEnterPractice]::AsstAppendTask($Handle, "StartUp", $startupParams)
  if ($startupTaskId -le 0) { throw "AsstAppendTask StartUp failed" }
  if ([MaaCoreEnterPractice]::AsstStart($Handle) -eq 0) { throw "AsstStart StartUp failed" }

  Wait-MaaTask $Handle $StartupTimeoutSec "StartUp wakeup"

  return $startupTaskId
}

function Invoke-FightNavigation {
  param([IntPtr]$Handle, [string]$StageName)

  $taskParams = @{
    stage = $StageName
    times = 0
    medicine = 0
    expiring_medicine = 0
    stone = 0
    series = 1
    report_to_penguin = $false
    report_to_yituliu = $false
  } | ConvertTo-Json -Compress

  $taskId = [MaaCoreEnterPractice]::AsstAppendTask($Handle, "Fight", $taskParams)
  if ($taskId -le 0) { throw "AsstAppendTask Fight failed for $StageName" }
  if ([MaaCoreEnterPractice]::AsstStart($Handle) -eq 0) { throw "AsstStart Fight failed" }

  Wait-MaaTask $Handle $NavigationTimeoutSec "Fight navigation"

  return $taskId
}

$startupHandle = New-ConnectedMaaHandle
try {
  $startupTaskId = Invoke-Startup $startupHandle
} finally {
  [MaaCoreEnterPractice]::AsstDestroy($startupHandle)
}

$handle = New-ConnectedMaaHandle
try {
  $navigationTaskId = Invoke-FightNavigation $handle $Stage.Trim()

  $bgr = Get-ScreenBgr $handle
  if (-not (Test-StageDetail $bgr)) { throw "stage detail screen not detected; practice click skipped" }

  $closedProxy = $false
  if (Test-ProxyEnabled $bgr) {
    Invoke-Click $handle 1066 592 | Out-Null
    $closedProxy = $true
    $bgr = Wait-ProxyDisabled $handle
  }

  $bgr = Wait-PracticeReady $handle $bgr
  $practiceCallId = Invoke-Click $handle 934 658
  @{
    ok = $true
    stage = $Stage.Trim()
    startupTaskId = $startupTaskId
    navigationTaskId = $navigationTaskId
    closedProxy = $closedProxy
    practiceCallId = $practiceCallId
  } | ConvertTo-Json -Compress
} finally {
  [MaaCoreEnterPractice]::AsstDestroy($handle)
}
