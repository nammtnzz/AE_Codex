#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+$')][string]$VersionFolder = '26.5',
    [switch]$SkipBackgroundService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$buildOutput = & $nodePath (Join-Path $PSScriptRoot 'Build-AeScriptBundle.js')
if ($LASTEXITCODE -ne 0) { throw 'AE bundle build failed; panel and MCP installation were not started.' }
$build = ($buildOutput -join "`n") | ConvertFrom-Json -Depth 64
$panel = & (Join-Path $PSScriptRoot 'Update-AeBridgeUserPanel.ps1') -VersionFolder $VersionFolder | ConvertFrom-Json -Depth 64
$mcp = & (Join-Path $PSScriptRoot 'Install-AeFunctionsMcp.ps1') | ConvertFrom-Json -Depth 64
$background = $null
$backgroundWarning = $null
if (-not $SkipBackgroundService) {
    try { $background = & (Join-Path $PSScriptRoot 'AeBackgroundServiceLifecycle.ps1') -Action Enable | ConvertFrom-Json -Depth 16 }
    catch { $backgroundWarning = 'Panel and Codex tools installed; the background sound helper needs repair: ' + $_.Exception.Message }
}
[ordered]@{
    schema = 'codex-ae-functions-install/v1'; state = 'success'; workspaceRoot = $workspaceRoot
    build = $build; panel = $panel; mcp = $mcp; backgroundService = $background; backgroundWarning = $backgroundWarning
    nextStep = 'Reopen the Codex Bridge panel in AE and open a new Codex chat or reload MCP connections. The bridge connects automatically.'
} | ConvertTo-Json -Depth 64
