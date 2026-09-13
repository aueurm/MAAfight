param(
  [string]$MaaDir = "",
  [switch]$CheckOnly,
  [switch]$Quiet,
  [ValidateRange(1, 1800)]
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

function Write-Result {
  param([hashtable]$Result)
  if (-not $Quiet) {
    $Result | ConvertTo-Json -Compress
  }
}

function Get-StartConfig {
  param([string]$Dir)

  $newConfigPath = Join-Path $Dir "config\gui.new.json"
  if (Test-Path -LiteralPath $newConfigPath) {
    try {
      $raw = Get-Content -LiteralPath $newConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
      $current = if ($raw.Current) { $raw.Current } else { "Default" }
      $profile = $raw.Configurations.$current
      if (-not $profile) { $profile = $raw.Configurations.Default }
      $settings = $profile.Gui.StartUpSettings
      if ($settings) {
        $waitSeconds = if ($null -ne $settings.EmulatorWaitSeconds) { [int]$settings.EmulatorWaitSeconds } else { 60 }
        return @{ emulatorPath = [string]$settings.EmulatorPath; enabled = [bool]$settings.StartEmulator; arguments = [string]$settings.EmulatorAddCommand; waitSeconds = $waitSeconds; adbPath = [string]$profile.Gui.ConnectSettings.AdbPath; address = [string]$profile.Gui.ConnectSettings.Address }
      }
    } catch {
    }
  }

  $configPath = Join-Path $Dir "config\gui.json"
  if (-not (Test-Path -LiteralPath $configPath)) { return $null }
  $raw = Get-Content -LiteralPath $configPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $current = if ($raw.Current) { $raw.Current } else { "Default" }
  $config = $raw.Configurations.$current
  if (-not $config) { $config = $raw.Configurations.Default }
  $waitSeconds = if ($null -ne $config.'Start.EmulatorWaitSeconds') { [int]$config.'Start.EmulatorWaitSeconds' } else { 60 }
  return @{ emulatorPath = [string]$config.'Start.EmulatorPath'; enabled = [string]$config.'Start.OpenEmulatorAfterLaunch' -eq "True"; arguments = [string]$config.'Start.EmulatorAddCommand'; waitSeconds = $waitSeconds; adbPath = [string]$config.'Connect.AdbPath'; address = [string]$config.'Connect.Address' }
}

function Invoke-AdbCommand {
  param([string]$AdbPath, [string]$Arguments, [DateTime]$Deadline)

  $timeoutMs = [Math]::Min(5000, [Math]::Floor(($Deadline - [DateTime]::UtcNow).TotalMilliseconds))
  if ($timeoutMs -le 0) { return $null }
  $check = New-Object System.Diagnostics.Process
  try {
    $check.StartInfo.FileName = $AdbPath
    $check.StartInfo.Arguments = $Arguments
    $check.StartInfo.UseShellExecute = $false
    $check.StartInfo.CreateNoWindow = $true
    $check.StartInfo.RedirectStandardOutput = $true
    $check.StartInfo.RedirectStandardError = $true
    if (-not $check.Start()) { return $null }
    $output = $check.StandardOutput.ReadToEndAsync()
    $errorOutput = $check.StandardError.ReadToEndAsync()
    if (-not $check.WaitForExit([int]$timeoutMs)) {
      $check.Kill()
      return $null
    }
    if ($check.ExitCode -ne 0 -or -not $output.Wait(1000)) { return $null }
    return $output.Result.Trim()
  } catch {
    return $null
  } finally {
    $check.Dispose()
  }
}

function Get-AdbStatus {
  param([string]$AdbPath, [string]$Address, [DateTime]$Deadline)

  $status = @{ adbReady = $false; bootCompleted = $false }
  if (-not $Address.Trim() -or $Address -match '[\s"\\]' -or -not $AdbPath.Trim() -or -not (Test-Path -LiteralPath $AdbPath)) { return $status }
  $state = Invoke-AdbCommand $AdbPath "-s `"$Address`" get-state" $Deadline
  if ($state -ne "device" -and $Address -match '^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9_.-]+):[0-9]+$') {
    # Connecting a configured TCP endpoint does not restart or replace the ADB server.
    Invoke-AdbCommand $AdbPath "connect `"$Address`"" $Deadline | Out-Null
    $state = Invoke-AdbCommand $AdbPath "-s `"$Address`" get-state" $Deadline
  }
  $status.adbReady = $state -eq "device"
  if ($status.adbReady) {
    $status.bootCompleted = (Invoke-AdbCommand $AdbPath "-s `"$Address`" shell getprop sys.boot_completed" $Deadline) -eq "1"
  }
  return $status
}

function Get-DesktopShellApplication {
  try {
    $windows = (New-Object -ComObject Shell.Application).Windows()
    $desktopHwnd = 0
    # SWC_DESKTOP / SWFO_NEEDDISPATCH select Explorer's desktop even with no folder windows.
    $desktop = $windows.FindWindowSW(0, 0, 8, [ref]$desktopHwnd, 1)
    if ($desktop) { return $desktop.Document.Application }
  } catch { return $null }
  return $null
}

function Start-Emulator {
  param([string]$LaunchPath, [string]$Arguments, [string]$WorkingDirectory)

  $name = [IO.Path]::GetFileNameWithoutExtension($LaunchPath)
  if ($name -match '^(MuMuNxDevice|MuMuNxMain|MuMuPlayer|MuMuManager)$') {
    # MuMu's ZeroMQ poller can abort when inheriting a tool/terminal launch context.
    # Use the existing Explorer process, not a new Shell.Application's ShellExecute.
    $desktopApplication = Get-DesktopShellApplication
    if (-not $desktopApplication) { throw "MuMu requires an available interactive Windows Explorer desktop to start." }
    $desktopApplication.ShellExecute($LaunchPath, $Arguments, $WorkingDirectory, "open", 1)
    return "explorer"
  }
  $startArgs = @{ FilePath = $LaunchPath; WindowStyle = "Normal" }
  if ($Arguments) { $startArgs.ArgumentList = $Arguments }
  if ($WorkingDirectory) { $startArgs.WorkingDirectory = $WorkingDirectory }
  Start-Process @startArgs
  return "process"
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

  return $null
}

function Invoke-Startup {
  $startedAt = [DateTime]::UtcNow
  $deadline = $startedAt.AddSeconds($TimeoutSeconds)
  $result = @{ ok = $false; usable = $false; adbReady = $false; bootCompleted = $false; started = $false; alreadyRunning = $false; checkOnly = [bool]$CheckOnly; timeoutSeconds = $TimeoutSeconds }
  try {
    $dir = Resolve-MaaDir $MaaDir
    if (-not $dir) { $result.skipped = $true; $result.warning = "MAA path is not configured."; return $result }
    $config = Get-StartConfig $dir
    if (-not $config) { $result.skipped = $true; $result.warning = "MAA gui config not found."; return $result }
    $result.waitSeconds = [Math]::Max(0, [int]$config.waitSeconds)
    $status = Get-AdbStatus ([string]$config.adbPath) ([string]$config.address) $deadline
    $result.adbReady = $status.adbReady
    $result.bootCompleted = $status.bootCompleted
    $result.alreadyRunning = $status.adbReady
    if ($status.bootCompleted) { $result.ok = $true; $result.usable = $true; return $result }
    if ($CheckOnly) { $result.warning = "The configured ADB device is not ready or Android has not completed boot."; return $result }

    if (-not $status.adbReady) {
      if (-not $config.enabled) { $result.ok = $true; $result.skipped = $true; $result.warning = "MAA emulator auto-start is disabled."; return $result }
      $result.emulatorPath = [string]$config.emulatorPath
      if (-not $result.emulatorPath.Trim()) { throw "MAA Start.EmulatorPath is empty." }
      if (-not (Test-Path -LiteralPath $result.emulatorPath)) { throw "Emulator shortcut not found: $($result.emulatorPath)" }
      $launchPath = $result.emulatorPath
      $arguments = [string]$config.arguments
      $workingDirectory = ""
      if ([IO.Path]::GetExtension($launchPath).ToLowerInvariant() -eq ".lnk") {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($launchPath)
        $launchPath = $shortcut.TargetPath
        $arguments = $shortcut.Arguments
        $workingDirectory = $shortcut.WorkingDirectory
      }
      $result.launchPath = $launchPath
      $result.arguments = $arguments
      if (-not (Test-Path -LiteralPath $launchPath)) { throw "Emulator target not found: $launchPath" }
      $result.processName = [IO.Path]::GetFileNameWithoutExtension($launchPath)
      $result.alreadyRunning = [bool](Get-Process -Name $result.processName -ErrorAction SilentlyContinue)
      if (-not $result.alreadyRunning) {
        # MuMu is interactive: keep its startup/confirmation window visible. ADB probes remain hidden.
        $result.launchMethod = Start-Emulator $launchPath $arguments $workingDirectory
        $result.started = $true
      }
    }

    # MAA's fixed wait (including zero) is not a readiness signal. Bound all probes by this deadline.
    while ([DateTime]::UtcNow -lt $deadline) {
      $status = Get-AdbStatus ([string]$config.adbPath) ([string]$config.address) $deadline
      $result.adbReady = $status.adbReady
      $result.bootCompleted = $status.bootCompleted
      if ($status.bootCompleted) { $result.ok = $true; $result.usable = $true; return $result }
      $remainingMs = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
      if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(1000, $remainingMs)) }
    }
    $result.warning = if ($result.adbReady) { "Android did not complete boot within $TimeoutSeconds seconds." } else { "MuMu did not provide the configured ADB device within $TimeoutSeconds seconds. Check its startup window." }
    return $result
  } catch {
    $result.warning = $_.Exception.Message
    return $result
  } finally {
    $result.elapsedSeconds = [Math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 1)
  }
}

$result = Invoke-Startup
Write-Result $result
if (-not $result.ok -and -not $result.skipped) { exit 1 }
exit 0
