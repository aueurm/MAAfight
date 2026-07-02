param(
  [string]$MaaDir = "D:\app\MAA",
  [switch]$CheckOnly,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Write-Result {
  param([hashtable]$Result)
  if (-not $Quiet) {
    $Result | ConvertTo-Json -Compress
  }
}

function Get-CurrentConfig {
  param([string]$ConfigPath)
  $raw = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $current = if ($raw.Current) { $raw.Current } else { "Default" }
  return $raw.Configurations.$current
}

$configPath = Join-Path $MaaDir "config\gui.json"
if (-not (Test-Path -LiteralPath $configPath)) {
  Write-Result @{ ok = $false; usable = $false; warning = "MAA gui config not found: $configPath" }
  exit 0
}

$config = Get-CurrentConfig $configPath
$emulatorPath = [string]$config.'Start.EmulatorPath'
$enabled = [string]$config.'Start.OpenEmulatorAfterLaunch' -eq "True"
if (-not $enabled) {
  Write-Result @{ ok = $true; usable = $false; skipped = $true; warning = "MAA emulator auto-start is disabled." }
  exit 0
}
if (-not $emulatorPath.Trim()) {
  Write-Result @{ ok = $false; usable = $false; warning = "MAA Start.EmulatorPath is empty." }
  exit 0
}
if (-not (Test-Path -LiteralPath $emulatorPath)) {
  Write-Result @{ ok = $false; usable = $false; emulatorPath = $emulatorPath; warning = "Emulator shortcut not found." }
  exit 0
}

$launchPath = $emulatorPath
$arguments = ""
$workingDirectory = ""
if ([IO.Path]::GetExtension($emulatorPath).ToLowerInvariant() -eq ".lnk") {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($emulatorPath)
  $launchPath = $shortcut.TargetPath
  $arguments = $shortcut.Arguments
  $workingDirectory = $shortcut.WorkingDirectory
}

if (-not (Test-Path -LiteralPath $launchPath)) {
  Write-Result @{ ok = $false; usable = $false; emulatorPath = $emulatorPath; launchPath = $launchPath; warning = "Emulator target not found." }
  exit 0
}

$processName = [IO.Path]::GetFileNameWithoutExtension($launchPath)
$alreadyRunning = [bool](Get-Process -Name $processName -ErrorAction SilentlyContinue)
if (-not $CheckOnly -and -not $alreadyRunning) {
  $startArgs = @{
    FilePath = $launchPath
  }
  if ($arguments) { $startArgs.ArgumentList = $arguments }
  if ($workingDirectory) { $startArgs.WorkingDirectory = $workingDirectory }
  Start-Process @startArgs
}

Write-Result @{
  ok = $true
  usable = $true
  checkOnly = [bool]$CheckOnly
  started = (-not $CheckOnly -and -not $alreadyRunning)
  alreadyRunning = $alreadyRunning
  emulatorPath = $emulatorPath
  launchPath = $launchPath
  processName = $processName
}
