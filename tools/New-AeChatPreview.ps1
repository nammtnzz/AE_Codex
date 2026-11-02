param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-OrdinaryPath([string]$Candidate) {
    if (-not [IO.Path]::IsPathRooted($Candidate) -or $Candidate.StartsWith('\\') -or $Candidate.Substring(2).Contains(':')) { throw 'MEDIA_INVALID' }
    $cursor = [IO.Path]::GetFullPath($Candidate)
    while ($cursor) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'MEDIA_INVALID' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

$stream = $null; $image = $null; $bitmap = $null; $graphics = $null
try {
    if (-not $IsWindows) { throw 'MEDIA_PLATFORM' }
    $RequestPath = [IO.Path]::GetFullPath($RequestPath)
    Assert-OrdinaryPath $RequestPath
    $directory = [IO.Path]::GetDirectoryName($RequestPath)
    $work = [IO.Path]::GetDirectoryName($directory)
    $previews = [IO.Path]::GetDirectoryName($work)
    $chat = [IO.Path]::GetDirectoryName($previews)
    $runtime = [IO.Path]::GetDirectoryName($chat)
    if ([IO.Path]::GetFileName($RequestPath) -cne 'request.json' -or [IO.Path]::GetFileName($directory) -cnotmatch '^[a-f0-9]{32}$' -or [IO.Path]::GetFileName($work) -cne '.work' -or [IO.Path]::GetFileName($previews) -cne 'previews' -or [IO.Path]::GetFileName($chat) -cne 'chat' -or [IO.Path]::GetFileName($runtime) -cne '.ae-codex') { throw 'MEDIA_INVALID' }
    if ((Get-Item -LiteralPath $RequestPath).Length -gt 32768) { throw 'MEDIA_INVALID' }
    $request = [IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
    if ($request.schema -cne 'codex-ae-chat-preview/v1') { throw 'MEDIA_INVALID' }
    $source = [IO.Path]::GetFullPath([string]$request.sourcePath)
    $output = [IO.Path]::GetFullPath([string]$request.outputPath)
    if ([IO.Path]::GetDirectoryName($source) -cne $directory -or [IO.Path]::GetFileName($source) -cnotmatch '^source\.(png|jpe?g|gif|webp)$' -or $output -cne [IO.Path]::Combine($directory,'preview.png') -or [IO.File]::Exists($output)) { throw 'MEDIA_INVALID' }
    Assert-OrdinaryPath $source
    Assert-OrdinaryPath $output
    if ((Get-Item -LiteralPath $source).Length -gt 52428800) { throw 'MEDIA_INVALID' }
    Add-Type -AssemblyName System.Drawing
    $stream = [IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $image = [Drawing.Image]::FromStream($stream,$false,$true)
    if ($image.Width -lt 1 -or $image.Height -lt 1 -or $image.Width -gt 16384 -or $image.Height -gt 16384 -or ([long]$image.Width * $image.Height) -gt 40000000) { throw 'MEDIA_DIMENSIONS' }
    try {
        $orientation = $image.GetPropertyItem(274).Value[0]
        $rotate = @{ 2 = 4; 3 = 2; 4 = 6; 5 = 5; 6 = 1; 7 = 7; 8 = 3 }
        if ($rotate.ContainsKey([int]$orientation)) { $image.RotateFlip([Drawing.RotateFlipType]$rotate[[int]$orientation]) }
    } catch { }
    $ratio = [Math]::Min(1.0,640.0 / [Math]::Max($image.Width,$image.Height))
    $width = [Math]::Max(1,[int][Math]::Round($image.Width * $ratio))
    $height = [Math]::Max(1,[int][Math]::Round($image.Height * $ratio))
    $bitmap = [Drawing.Bitmap]::new($width,$height,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($image,0,0,$width,$height)
    $bitmap.Save($output,[Drawing.Imaging.ImageFormat]::Png)
    if ((Get-Item -LiteralPath $output).Length -gt 2097152) { throw 'MEDIA_PREVIEW_SIZE' }
    [Console]::Out.Write('{"state":"success"}')
} catch {
    [Console]::Error.Write('MEDIA_PREVIEW_HELPER')
    exit 1
} finally {
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($image) { $image.Dispose() }
    if ($stream) { $stream.Dispose() }
}
