#Requires -Version 7.0
# Retires old runtime versions after a successful install. Only versions/<id> folders that are not the
# active runtime are considered, and only when nothing can still be using them. Each removed version is
# archived to retired-data/<id>.zip first (verified), and only the newest $KeepArchives archives are kept.
# A version that is busy or still referenced is deferred and retried on the next install; no job is replayed.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [int]$KeepArchives = 3,
    [switch]$Fixture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked path refused: $cursor" }
        $parent = [IO.Directory]::GetParent($cursor); if ($null -eq $parent) { break }; $cursor = $parent.FullName
    }
}
function Test-IsChild([string]$Child, [string]$Parent) {
    return [IO.Path]::GetFullPath($Child).StartsWith([IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Get-Mentions([string]$Text, [string]$Folder) {
    if (-not $Text) { return $false }
    $t = $Text.Replace('\\', '\').Replace('/', '\')
    return $t.IndexOf($Folder.Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase) -ge 0
}
function Assert-Idle([string]$Root) {
    foreach ($relative in @('.ae-codex/bridge/submit.lock', '.ae-codex/active.lock')) {
        if (Test-Path -LiteralPath (Join-Path $Root $relative)) { throw "job lock present ($relative)" }
    }
    $inbox = Join-Path $Root '.ae-codex/bridge/inbox'
    if ((Test-Path -LiteralPath $inbox) -and @(Get-ChildItem -LiteralPath $inbox -File | Where-Object { $_.Name -match '\.(job|running)$' }).Count) { throw 'jobs still queued or running' }
    $results = Join-Path $Root '.ae-codex/bridge/results'
    if (Test-Path -LiteralPath $results) {
        foreach ($started in Get-ChildItem -LiteralPath $results -Filter 'started-*.json' -File) {
            if (-not (Test-Path -LiteralPath (Join-Path $results ($started.Name -replace '^started-', 'status-')))) { throw "unfinished job $($started.Name)" }
        }
    }
    $heartbeat = Join-Path $Root '.ae-codex/bridge/heartbeat.json'
    if (Test-Path -LiteralPath $heartbeat) {
        $h = Get-Content -Raw -LiteralPath $heartbeat | ConvertFrom-Json
        $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$h.timestampEpochMs
        if ($h.state -in @('running', 'starting', 'busy', 'executing', 'scanning') -and $age -lt 30000) { throw 'bridge of this version is live in After Effects' }
    }
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
Assert-PlainPath $InstallRoot
$meta = Get-Content -Raw -LiteralPath (Join-Path $InstallRoot 'installation.json') | ConvertFrom-Json
$versions = Join-Path $InstallRoot 'versions'
$active = [IO.Path]::GetFullPath([string]$meta.runtimeRoot).TrimEnd('\', '/')
if ($meta.schema -ne 'codex-ae-installation/v1' -or -not (Test-IsChild $active $versions) -or -not (Test-Path -LiteralPath $active)) { throw 'Active runtime pointer is invalid; nothing removed.' }

$references = @()
foreach ($property in @('panelPath', 'startupPath', 'mcpConfigPath')) {
    if ($meta.PSObject.Properties[$property] -and $meta.$property -and [IO.File]::Exists($meta.$property)) { $references += [IO.File]::ReadAllText($meta.$property) }
}
$processes = @()
if (-not $Fixture) { $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine }) }
$retired = Join-Path $InstallRoot 'retired-data'
$removed = @(); $deferred = @()

foreach ($candidate in @(Get-ChildItem -LiteralPath $versions -Directory)) {
    if ($candidate.FullName -ieq $active -or $candidate.Name -notmatch '^\d+\.\d+\.\d+-[a-f0-9]{12}$') { continue }
    try {
        Assert-PlainPath $candidate.FullName
        if (@(Get-ChildItem -LiteralPath $candidate.FullName -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'contains linked paths' }
        Assert-Idle $candidate.FullName
        foreach ($text in $references) { if (Get-Mentions $text $candidate.FullName) { throw 'AE loader or Codex MCP still points to this version' } }
        foreach ($p in $processes) { if (Get-Mentions $p.CommandLine $candidate.FullName) { throw "in use by $($p.Name) (pid $($p.ProcessId)); reload Codex MCP or restart AE" } }
        if (-not $Fixture) {
            # Stop this version's own helper autostart; entries of other runtimes are left untouched.
            try { & (Join-Path $active 'tools/AeBackgroundServiceLifecycle.ps1') -Action Disable -WorkspaceRoot $candidate.FullName | Out-Null } catch { }
        }
        [IO.Directory]::CreateDirectory($retired) | Out-Null
        $zip = Join-Path $retired ($candidate.Name + '.zip')
        if (Test-Path -LiteralPath $zip) { $zip = Join-Path $retired ($candidate.Name + '-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '.zip') }
        $files = @(Get-ChildItem -LiteralPath $candidate.FullName -Recurse -File -Force)
        if ($files.Count) {
            Compress-Archive -Path (Join-Path $candidate.FullName '*') -DestinationPath $zip -CompressionLevel Optimal
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $archive = [IO.Compression.ZipFile]::OpenRead($zip); $count = @($archive.Entries | Where-Object { $_.Name }).Count; $archive.Dispose()
            if ($count -ne $files.Count) { Remove-Item -LiteralPath $zip -Force; throw "backup incomplete ($count/$($files.Count))" }
        }
        if (-not (Test-IsChild $candidate.FullName $versions)) { throw 'invalid target' }
        Remove-Item -LiteralPath $candidate.FullName -Recurse -Force
        $removed += $candidate.Name
    } catch {
        $deferred += [pscustomobject]@{ version = $candidate.Name; reason = $_.Exception.Message }
    }
}
# Bound retired-data: keep only the newest archives.
if (Test-Path -LiteralPath $retired) {
    @(Get-ChildItem -LiteralPath $retired -Filter '*.zip' -File | Sort-Object LastWriteTimeUtc -Descending) |
        Select-Object -Skip ([Math]::Max(0, $KeepArchives)) | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
}
[pscustomobject]@{ schema = 'codex-ae-version-cleanup/v1'; active = (Split-Path -Leaf $active); removed = $removed; deferred = $deferred; archives = $retired } | ConvertTo-Json -Depth 4
