#Requires -Version 7.0
# Retention removes job scratch outside the runtime keep-list, never follows links into other
# projects, keeps the newest release build and keeps anything newer than the age window.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../tools/Invoke-AeRetention.ps1'))
$root = Join-Path ([IO.Path]::GetTempPath()) ('CodexAE-retention-' + [guid]::NewGuid().ToString('N'))
$ws = Join-Path $root 'workspace'; $data = Join-Path $ws '.ae-codex'; $outside = Join-Path $root 'other-project/node_modules'
$checks = [Collections.Generic.List[string]]::new()
function Assert-Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAILED: $Message" }; $checks.Add($Message) }
function Age([string]$Path, [int]$Days) {
    $time = [DateTime]::UtcNow.AddDays(-$Days)
    foreach ($item in @(Get-Item -LiteralPath $Path -Force) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })) { $item.LastWriteTimeUtc = $time }
}
try {
    foreach ($folder in @("$data/old-job/repo", "$data/fresh-job", "$data/library", "$data/bridge", "$data/releases/CodexAE-1.0.0-aaaaaaaaaaaa", "$data/releases/CodexAE-1.0.1-bbbbbbbbbbbb", $outside)) { New-Item -ItemType Directory -Force $folder | Out-Null }
    Set-Content "$outside/keep.txt" 'other project'
    Set-Content "$data/old-job/frame.npy" 'x'; Set-Content "$data/old-scratch.json" '{}'; Set-Content "$data/fresh-job/a.json" '{}'
    Set-Content "$data/library/catalog.json" '{}'; Set-Content "$data/bridge/heartbeat.json" '{}'
    New-Item -ItemType Junction -Path "$data/old-job/repo/node_modules" -Target $outside | Out-Null
    Age "$data/old-job" 30; Age "$data/old-scratch.json" 30; Age "$data/library" 30; Age "$data/bridge" 30
    Age "$data/releases/CodexAE-1.0.0-aaaaaaaaaaaa" 30; Age "$data/releases/CodexAE-1.0.1-bbbbbbbbbbbb" 20
    $preview = & $script -InstallRoot (Join-Path $root 'no-install') -WorkspaceRoots $ws -Days 10 -WhatIf | ConvertFrom-Json
    Assert-Check (Test-Path "$data/old-job") 'WhatIf previews without deleting.'
    $result = & $script -InstallRoot (Join-Path $root 'no-install') -WorkspaceRoots $ws -Days 10 | ConvertFrom-Json
    Assert-Check ($preview.removedCount -eq $result.removedCount) 'Preview and real run agree.'
    Assert-Check (-not (Test-Path "$data/old-job") -and -not (Test-Path "$data/old-scratch.json")) 'Old job scratch (folders, JSON, NPY) outside the keep-list is removed.'
    Assert-Check (Test-Path "$outside/keep.txt") 'A junction inside scratch is unlinked; its target in another project is untouched.'
    Assert-Check (Test-Path "$data/fresh-job/a.json") 'Scratch newer than the age window is kept.'
    Assert-Check ((Test-Path "$data/library/catalog.json") -and (Test-Path "$data/bridge/heartbeat.json")) 'Runtime keep-list folders are never removed as a whole.'
    Assert-Check ((Test-Path "$data/releases/CodexAE-1.0.1-bbbbbbbbbbbb") -and -not (Test-Path "$data/releases/CodexAE-1.0.0-aaaaaaaaaaaa")) 'Only the newest release build is kept.'
    [ordered]@{ schema = 'codex-ae-test/v1'; test = 'Test-AeRetention'; state = 'success'; checks = $checks } | ConvertTo-Json
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
