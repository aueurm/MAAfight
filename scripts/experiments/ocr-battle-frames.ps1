# Offline experiment: Windows PowerShell 5.1 + installed Windows.Media.Ocr only.
# Crops are created in memory. No screenshots, image output, game interaction or network.
param(
    [Parameter(Mandatory=$true)][string]$InputDirectory,
    [Parameter(Mandatory=$true)][string]$OutputJson,
    [int]$Limit = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await-Operation($Operation, [type]$ResultType) {
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}
$languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
$language = [Windows.Globalization.Language]::new('en-US')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) { throw 'Installed en-US OCR is unavailable; no installation attempted.' }
function Read-Crop($Bitmap, [int[]]$Roi, [int]$Scale, [string]$Mode = 'raw') {
    $rect = New-Object System.Drawing.Rectangle($Roi[0],$Roi[1],$Roi[2],$Roi[3])
    $crop = $Bitmap.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $padding = 0
    $repeated = $Mode.StartsWith('repeat-')
    if ($Mode -ne 'raw') {
        $padding = 24
        $minX=$crop.Width; $maxX=-1; $minY=$crop.Height; $maxY=-1
        for ($y=0; $y -lt $crop.Height; $y++) {
            for ($x=0; $x -lt $crop.Width; $x++) {
                $pixel = $crop.GetPixel($x,$y)
                $foreground = if ($Mode.EndsWith('red')) { $pixel.R -gt 100 -and $pixel.R -gt $pixel.G*1.35 } else { $pixel.R -gt 160 -and $pixel.G -gt 160 -and $pixel.B -gt 160 }
                if ($foreground) { $minX=[math]::Min($minX,$x); $maxX=[math]::Max($maxX,$x); $minY=[math]::Min($minY,$y); $maxY=[math]::Max($maxY,$y) }
                $color = if ($foreground) { [System.Drawing.Color]::Black } else { [System.Drawing.Color]::White }
                $crop.SetPixel($x,$y,$color)
            }
        }
    }
    if ($repeated -and $maxX -ge $minX) {
        # Repeat the same isolated glyph four times to test Windows OCR's single-character omission.
        $digitRect = New-Object System.Drawing.Rectangle($minX,$minY,($maxX-$minX+1),($maxY-$minY+1))
        $digit = $crop.Clone($digitRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $crop.Dispose()
        $crop = New-Object System.Drawing.Bitmap((($digit.Width+4)*4),$digit.Height)
        $repeatGraphics = [System.Drawing.Graphics]::FromImage($crop)
        $repeatGraphics.Clear([System.Drawing.Color]::White)
        for ($copy=0; $copy -lt 4; $copy++) { $repeatGraphics.DrawImageUnscaled($digit,$copy*($digit.Width+4),0) }
        $repeatGraphics.Dispose(); $digit.Dispose()
    }
    $scaled = New-Object System.Drawing.Bitmap(($crop.Width*$Scale+$padding*2),($crop.Height*$Scale+$padding*2))
    $graphics = [System.Drawing.Graphics]::FromImage($scaled)
    if ($padding -gt 0) { $graphics.Clear([System.Drawing.Color]::White) }
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($crop, $padding, $padding, $crop.Width*$Scale, $crop.Height*$Scale)
    $memory = New-Object System.IO.MemoryStream
    $scaled.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
    $writer.WriteBytes($memory.ToArray())
    $null = Await-Operation ($writer.StoreAsync()) ([uint32])
    $null = $writer.DetachStream()
    $writer.Dispose()
    $stream.Seek(0)
    $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-Operation ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object {
        @{ text=$_.Text; words=@($_.Words | ForEach-Object {
            @{ text=$_.Text; x=[math]::Round(($_.BoundingRect.X-$padding)/$Scale+$Roi[0],2); y=[math]::Round(($_.BoundingRect.Y-$padding)/$Scale+$Roi[1],2);
               width=[math]::Round($_.BoundingRect.Width/$Scale,2); height=[math]::Round($_.BoundingRect.Height/$Scale,2) }
        }) }
    })
    $text = $result.Text
    if ($repeated) { $lines = @() } # Repeated-glyph coordinates are artificial, not original frame positions.
    $software.Dispose(); $stream.Dispose(); $memory.Dispose(); $graphics.Dispose(); $scaled.Dispose(); $crop.Dispose()
    @{ text=$text; lines=$lines; roi=$Roi; scale=$Scale; mode=$Mode; confidence=$null }
}
$files = @(Get-ChildItem -LiteralPath $InputDirectory -Filter '*.bmp' -File | Sort-Object Name)
if ($Limit -gt 0) { $files = @($files | Select-Object -First $Limit) }
$frames = @()
foreach ($file in $files) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($file.FullName)
    try {
        if ($bitmap.Width -ne 1280 -or $bitmap.Height -ne 720) { throw 'Only the observed 1280x720 layout is configured.' }
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        $top = Read-Crop $bitmap @(400,0,650,90) 3
        $dp = Read-Crop $bitmap @(1199,494,80,44) 4
        $dpBinary = Read-Crop $bitmap @(1199,494,80,44) 4 'white'
        $dpRepeated = Read-Crop $bitmap @(1199,494,80,44) 4 'repeat-white'
        $hp = Read-Crop $bitmap @(721,14,100,35) 4
        $hpBinary = Read-Crop $bitmap @(721,14,100,35) 4 'red'
        $hpRepeated = Read-Crop $bitmap @(721,14,100,35) 4 'repeat-red'
        $timer.Stop()
        $frames += @{ file=$file.Name; width=$bitmap.Width; height=$bitmap.Height; topBar=$top; dp=$dp; dpBinary=$dpBinary; dpRepeated=$dpRepeated; hp=$hp; hpBinary=$hpBinary; hpRepeated=$hpRepeated; elapsedMs=$timer.ElapsedMilliseconds }
        Write-Output ($file.Name + ' TOP=' + $top.text + ' HP=' + $hp.text + '/' + $hpBinary.text + '/' + $hpRepeated.text + ' DP=' + $dp.text + '/' + $dpBinary.text + '/' + $dpRepeated.text)
    } finally { $bitmap.Dispose() }
}
$report = @{ engine='Windows.Media.Ocr'; language='en-US'; installedLanguages=$languages; confidenceAvailable=$false;
    sourceDirectory=(Resolve-Path -LiteralPath $InputDirectory).Path; screenshotCount=0; frames=$frames;
    limitations=@('OCR engine does not expose numeric confidence.', 'Text is unverified; crop, icon, motion and glyph confusion can cause errors.', 'Fixed ROI assumes 1280x720; top bar includes multiple counters.', 'No game control, online requests or image uploads performed.') }
$json = $report | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($OutputJson, $json, (New-Object System.Text.UTF8Encoding $false))
