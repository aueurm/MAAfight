# Pure resource and callback helpers. MaaCore is loaded only by enter-practice.ps1.
function Get-MaaResourceRoots {
  param([string]$Dir, [string]$ClientType)
  $roots = @($Dir)
  if (Test-Path -LiteralPath (Join-Path $Dir 'cache\resource')) { $roots += Join-Path $Dir 'cache' }
  if ($ClientType -in @('YoStarEN', 'YoStarJP', 'YoStarKR', 'txwy')) {
    foreach ($relative in @("resource\global\$ClientType", "cache\resource\global\$ClientType")) {
      $candidate = Join-Path $Dir $relative
      if (Test-Path -LiteralPath (Join-Path $candidate 'resource')) { $roots += $candidate }
    }
  }
  return $roots
}

function Read-MaaTaskDefinitions {
  param([string[]]$Roots)
  Add-Type -AssemblyName System.Web.Extensions
  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $serializer.MaxJsonLength = 67108864
  $tasks = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  foreach ($root in $Roots) {
    $taskDir = Join-Path $root 'resource\tasks'
    $legacy = Join-Path $root 'resource\tasks.json'
    $files = if (Test-Path -LiteralPath $taskDir) {
      @(Get-ChildItem -LiteralPath $taskDir -Filter '*.json' -File -Recurse | Sort-Object FullName)
    } elseif (Test-Path -LiteralPath $legacy) { @(Get-Item -LiteralPath $legacy) } else { @() }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($file in $files) {
      $definitions = $serializer.DeserializeObject([IO.File]::ReadAllText($file.FullName))
      foreach ($name in $definitions.Keys) {
        if (-not $seen.Add($name)) { throw "Duplicate MAA task in resource root: $name" }
        $definition = $definitions[$name]
        # Match TaskData: explicit baseTask replaces a definition; other patches merge fields.
        if ($tasks.ContainsKey($name) -and -not $definition.ContainsKey('baseTask')) {
          foreach ($field in $definition.Keys) { $tasks[$name][$field] = $definition[$field] }
        } else { $tasks[$name] = $definition }
      }
    }
  }
  return $tasks
}

function Get-MaaNavigationRequest {
  param([System.Collections.Generic.Dictionary[string,object]]$Tasks, [string]$StageName, [string]$Difficulty)
  $code = $StageName.Trim().ToUpperInvariant()
  if ($code -match '^(.*)-(NORMAL|HARD)$') {
    $code = $Matches[1]
    $suffix = (Get-Culture).TextInfo.ToTitleCase($Matches[2].ToLowerInvariant())
    if ($Difficulty -and $Difficulty -ne $suffix) { throw 'Conflicting navigation difficulty' }
    $Difficulty = $suffix
  }
  # Fight accepts arbitrary task names and batch SSReopen selectors. Neither is a single stage.
  if ($code -notmatch '^[A-Z0-9]+(?:-[A-Z0-9]+)*-[A-Z]*[0-9]+$') {
    throw "A concrete stage code is required for practice navigation: $StageName"
  }
  $nativeName = $code
  $supported = $Tasks.ContainsKey($code)
  if ($code -match '^([A-Z]{0,3})([0-9]{1,2})-([0-9]{1,2})$' -and $Tasks.ContainsKey("Episode$($Matches[2])")) {
    $chapter = [int]$Matches[2]
    $prefix = $Matches[1]
    $supported = $true
    if ($chapter -ge 10) {
      if (-not $Difficulty) { $Difficulty = if ($prefix -eq 'H') { 'Hard' } else { 'Normal' } }
      $nativeName = "$code-$Difficulty"
    } elseif ($Difficulty) { throw 'MAA does not support a Normal/Hard suffix before chapter 10' }
  } elseif ($Difficulty) { throw 'Normal/Hard navigation difficulty requires a supported main-story chapter' }
  return @{ code = $code; nativeName = $nativeName; supported = $supported; difficulty = $Difficulty }
}

function New-MaaNavigationOverlay {
  param([System.Collections.Generic.Dictionary[string,object]]$Tasks, [string]$StageName)
  foreach ($required in @('FightBegin', 'StartButton1', 'StartButton2', 'ClickedCorrectStage')) {
    if (-not $Tasks.ContainsKey($required)) { throw "MAA navigation boundary resource is missing: $required" }
  }
  $blocked = '^(?:FightBegin|LastOrCurBattleBegin|StartButton[12].*|BattleStart.*|UseMedicine.*|ExpiringMedicine.*|MedicineConfirm.*|MedicineNotConfirmed|UseStone.*|StoneConfirm.*|ReplenishToMax.*|UsePrts(?:-.*)?|NotUsePrts|AnnihilationConfirm)$'
  $overlay = @{}
  $guarded = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $family = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($name in $Tasks.Keys) {
    if (@($name.Split('@') | Where-Object { $_ -match $blocked }).Count -gt 0) { [void]$guarded.Add($name); [void]$family.Add($name) }
  }
  # Explicit aliases can override their parent's Stop action. Guard those aliases too,
  # while keeping read-only OCR descendants such as ClickedCorrectStageOrSwipe intact.
  do {
    $changed = $false
    foreach ($name in $Tasks.Keys) {
      if ($family.Contains($name)) { continue }
      $task = $Tasks[$name]
      $base = [string]$task['baseTask']
      if (-not $base -and $name.Contains('@')) { $base = $name.Substring($name.IndexOf('@') + 1) }
      $dangerousBase = $base -and ($family.Contains($base) -or @($base.Split('@') | Where-Object { $_ -match $blocked -or $family.Contains($_) }).Count -gt 0)
      $dangerousTemplate = (@($task['template']) -join ' ') -match 'StartButton[12]|BattleStart|MedicineConfirm|UseMedicine|StoneConfirm|ReplenishToMax'
      if ($dangerousBase -or $dangerousTemplate) {
        $changed = $family.Add($name) -or $changed
        if (($task['action'] -and $task['action'] -notin @('DoNothing', 'Stop')) -or ($dangerousTemplate -and -not $task['action'])) { [void]$guarded.Add($name) }
      }
    }
  } while ($changed)
  foreach ($name in $guarded) {
    $task = @{}
    foreach ($field in $Tasks[$name].Keys) { $task[$field] = $Tasks[$name][$field] }
    # Preserve recognition/inheritance: changing StartButton1's OCR type breaks native navigation.
    $task['action'] = 'Stop'
    $task['preDelay'] = 0
    $task['postDelay'] = 0
    foreach ($field in @('next', 'sub', 'onErrorNext', 'exceededNext', 'reduceOtherTimes')) { $task[$field] = @() }
    $overlay[$name] = $task
  }
  # Ordinary Fight: startup -> native navigation -> this inert final ProcessTask.
  # SSReopen batch tasks have a different C++ path and are rejected by Get-MaaNavigationRequest.
  $overlay['FightBegin'] = @{
    baseTask = '#none'; algorithm = 'JustReturn'; action = 'Stop'
    next = @(); sub = @(); onErrorNext = @(); exceededNext = @(); reduceOtherTimes = @()
  }
  $overlay['MAAfightVerifyStage'] = @{
    baseTask = 'ClickedCorrectStage'; algorithm = 'OcrDetect'; action = 'DoNothing'
    text = @($StageName); fullMatch = $true
    next = @(); sub = @(); onErrorNext = @(); exceededNext = @(); reduceOtherTimes = @()
  }
  return $overlay
}

function Test-MaaNavigationStopped {
  param([object[]]$Events, [int]$TaskId)
  foreach ($entry in $Events) {
    $details = $entry.details
    # Stop emits SubTaskStart, not SubTaskCompleted; Wait-MaaTask also requires chain completion.
    if ($entry.message -eq 20001 -and $details.taskid -eq $TaskId -and $details.taskchain -eq 'Fight' -and
      $details.subtask -eq 'ProcessTask' -and $details.details.task -eq 'FightBegin' -and $details.details.action -eq 'Stop') { return $true }
  }
  return $false
}

function Test-MaaTargetStageCompleted {
  param([object[]]$Events, [int]$TaskId, [string]$TargetTask, [string]$StageName)
  foreach ($entry in $Events) {
    $details = $entry.details
    if ($entry.message -eq 20002 -and $details.taskid -eq $TaskId -and $details.taskchain -eq 'Custom' -and $details.subtask -eq 'ProcessTask' -and
      $details.details.task -eq $TargetTask -and $details.details.action -eq 'DoNothing' -and $details.details.result.text -ceq $StageName) { return $true }
  }
  return $false
}
