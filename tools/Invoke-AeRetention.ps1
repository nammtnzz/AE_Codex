#Requires -Version 7.0
# Daily retention so disk use stays bounded. Removes, only when older than -Days:
#   - superseded runtime versions and their retired-data archives (via Remove-AeOldVersions.ps1)
#   - generated output under each workspace's .ae-codex: inspection runs, renders, setup backups,
#     finished bridge results, rotated logs and superseded release builds (newest always kept)
#   - built release ZIPs at a workspace root, always keeping the newest one
# Catalogs, library, bundle, functions, plugins, python dependencies and active locks are never touched.
# -Register installs a daily current-user scheduled task; -Unregister removes it.
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AE_Codex'),
    [string[]]$WorkspaceRoots = @(),
    [int]$Days = 10,
    [switch]$WhatIf,
    [switch]$Register,
    [switch]$Unregister
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'Codex AE Retention'

if ($Register -or $Unregister) {
    if ($Unregister) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        [ordered]@{ schema = 'codex-ae-retention-task/v1'; state = 'removed'; task = $taskName } | ConvertTo-Json
        return
    }
    # Run a stable copy outside versions/<id> so the task survives upgrades and version cleanup.
    $stableScript = Join-Path $InstallRoot 'Invoke-AeRetention.ps1'
    if ([IO.Path]::GetFullPath($PSCommandPath) -ine [IO.Path]::GetFullPath($stableScript)) { Copy-Item -LiteralPath $PSCommandPath -Destination $stableScript -Force }
    if (-not $WorkspaceRoots.Count) {
        # Re-registration by an upgrade keeps workspaces the user added earlier.
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing -and $existing.Actions[0].Arguments -match '-WorkspaceRoots\s+(.+?)(?:\s+-\w+|$)') {
            $WorkspaceRoots = @([regex]::Matches($Matches[1], '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
        }
    }
    $pwsh = (Get-Process -Id $PID).Path
    $arguments = @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', "`"$stableScript`"", '-InstallRoot', "`"$InstallRoot`"", '-Days', $Days)
    if ($WorkspaceRoots.Count) { $arguments += @('-WorkspaceRoots', (($WorkspaceRoots | ForEach-Object { "`"$([IO.Path]::GetFullPath($_))`"" }) -join ',')) }
    # conhost --headless never creates a console window; -WindowStyle Hidden alone still flashes one.
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') -Argument ("--headless `"$pwsh`" " + ($arguments -join ' '))
    $trigger = @((New-ScheduledTaskTrigger -Daily -At '12:30'), (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"))
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Removes Codex AE versions and generated data older than $Days days." -Force | Out-Null
    [ordered]@{ schema = 'codex-ae-retention-task/v1'; state = 'registered'; task = $taskName; days = $Days; script = $stableScript; workspaces = $WorkspaceRoots } | ConvertTo-Json
    return
}

function Test-IsChild([string]$Child, [string]$Parent) {
    return [IO.Path]::GetFullPath($Child).StartsWith([IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Test-Linked([string]$Path) { return [bool]([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) }

$cutoff = [DateTime]::UtcNow.AddDays(-$Days)
$removed = [Collections.Generic.List[object]]::new()
$warnings = [Collections.Generic.List[string]]::new()
$freedBytes = [long]0
$versionResult = $null

function Remove-Old([System.IO.FileSystemInfo]$Item, [string]$Within) {
    if (-not (Test-IsChild $Item.FullName $Within) -or (Test-Linked $Item.FullName)) { return }
    # A folder is old only when nothing inside it changed recently.
    $newest = $Item.LastWriteTimeUtc
    $bytes = [long]0
    if ($Item -is [IO.DirectoryInfo]) {
        foreach ($entry in Get-ChildItem -LiteralPath $Item.FullName -Recurse -Force -ErrorAction SilentlyContinue) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
            if ($entry.LastWriteTimeUtc -gt $newest) { $newest = $entry.LastWriteTimeUtc }
            if ($entry -is [IO.FileInfo]) { $bytes += $entry.Length }
        }
    } else { $bytes = $Item.Length }
    if ($newest -ge $cutoff) { return }
    try {
        if (-not $WhatIf) { Remove-Item -LiteralPath $Item.FullName -Recurse -Force }
        $script:freedBytes += $bytes
        $removed.Add([IO.Path]::GetRelativePath($Within, $Item.FullName))
    } catch { $warnings.Add("$($Item.FullName): $($_.Exception.Message)") }
}

$roots = [Collections.Generic.List[string]]::new()
foreach ($root in $WorkspaceRoots) { if ($root) { $roots.Add([IO.Path]::GetFullPath($root).TrimEnd('\', '/')) } }
$metadataPath = Join-Path $InstallRoot 'installation.json'
if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
    $meta = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
    if ($meta.runtimeRoot) { $roots.Add([IO.Path]::GetFullPath([string]$meta.runtimeRoot).TrimEnd('\', '/')) }
    $cleanup = Join-Path $meta.runtimeRoot 'tools/Remove-AeOldVersions.ps1'
    if (-not (Test-Path -LiteralPath $cleanup)) { $cleanup = Join-Path $PSScriptRoot 'Remove-AeOldVersions.ps1' }
    if ($WhatIf) { $warnings.Add('WhatIf: version cleanup not evaluated.') }
    elseif (-not (Get-Command $cleanup).Parameters.ContainsKey('MinAgeDays')) { $warnings.Add('Active runtime predates 10-day version cleanup; install the latest package to enable it.') }
    else {
        try { $versionResult = & $cleanup -InstallRoot $InstallRoot -MinAgeDays $Days | ConvertFrom-Json }
        catch { $warnings.Add('Version cleanup: ' + $_.Exception.Message) }
    }
}

foreach ($root in ($roots | Select-Object -Unique)) {
    $data = Join-Path $root '.ae-codex'
    if (-not (Test-Path -LiteralPath $data -PathType Container) -or (Test-Linked $data)) { continue }
    if (Test-Path -LiteralPath (Join-Path $data 'bridge/submit.lock')) { $warnings.Add("$root busy; skipped this run."); continue }
    foreach ($relative in @('inspection', 'renders', 'setup/backups')) {
        $folder = Join-Path $data $relative
        if (Test-Path -LiteralPath $folder -PathType Container) {
            foreach ($item in Get-ChildItem -LiteralPath $folder -Force) { Remove-Old $item $data }
        }
    }
    $results = Join-Path $data 'bridge/results'
    if (Test-Path -LiteralPath $results -PathType Container) {
        # Only finished jobs: keep a started-* record until its status-* exists.
        foreach ($item in Get-ChildItem -LiteralPath $results -File -Force) {
            if ($item.Name -like 'started-*' -and -not (Test-Path -LiteralPath (Join-Path $results ($item.Name -replace '^started-', 'status-')))) { continue }
            Remove-Old $item $data
        }
    }
    $logs = Join-Path $data 'bridge/logs'
    if (Test-Path -LiteralPath $logs -PathType Container) {
        foreach ($item in Get-ChildItem -LiteralPath $logs -File -Force | Where-Object Name -ne 'events.log') { Remove-Old $item $data }
    }
    $releases = Join-Path $data 'releases'
    if (Test-Path -LiteralPath $releases -PathType Container) {
        # Keep the newest build (folder + ZIP) that latest.json and the share guide point to.
        $builds = @(Get-ChildItem -LiteralPath $releases -Force | Where-Object Name -like 'CodexAE-*' | Sort-Object LastWriteTimeUtc -Descending)
        $newest = if ($builds.Count) { [IO.Path]::GetFileNameWithoutExtension($builds[0].Name) -replace '\.zip$', '' } else { '' }
        foreach ($item in $builds) { if (($item.Name -replace '\.zip$', '') -ne $newest) { Remove-Old $item $data } }
    }
    $zips = @(Get-ChildItem -LiteralPath $root -Filter 'CodexAE-*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    foreach ($zip in ($zips | Select-Object -Skip 1)) { Remove-Old $zip $root }
}

$report = [ordered]@{
    schema = 'codex-ae-retention/v1'; ranAt = [DateTime]::UtcNow.ToString('o'); days = $Days; whatIf = [bool]$WhatIf
    freedMB = [Math]::Round($freedBytes / 1MB, 1); removedCount = $removed.Count; removed = @($removed | Select-Object -First 200)
    versions = $versionResult; warnings = @($warnings)
}
if (Test-Path -LiteralPath $InstallRoot -PathType Container) {
    [IO.File]::WriteAllText((Join-Path $InstallRoot 'retention-last.json'), ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}
$report | ConvertTo-Json -Depth 6
