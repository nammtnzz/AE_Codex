#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureRoot = Join-Path $workspaceRoot ('.ae-codex/tests/functions-install-' + [guid]::NewGuid().ToString('N'))
$fixtureConfig = Join-Path $fixtureRoot 'config.toml'
$fixtureTools = Join-Path $fixtureRoot 'tools'
$utf8 = [Text.UTF8Encoding]::new($false)
$passed = 0
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Invoke-TimeoutFixture([string]$ConfigText) {
    [IO.File]::WriteAllText($fixtureConfig, $ConfigText, $utf8)
    & (Join-Path $workspaceRoot 'tools/Install-AeFunctionsMcp.ps1') -SkipRegistration -ConfigPath $fixtureConfig | ConvertFrom-Json -Depth 32
}
try {
    New-Item -ItemType Directory -Force -Path $fixtureRoot, $fixtureTools, (Join-Path $fixtureRoot '.ae-codex') | Out-Null
    $config = @'
title = "fixture"
prompt = """
[mcp_servers.ae_functions]
tool_timeout_sec = 999
"""
[mcp_servers.other]
command = "other-fixture"
tool_timeout_sec = 3
[mcp_servers.ae_functions]
command = "ae-fixture"
startup_timeout_sec = 1 # old
tool_timeout_sec = 2
[mcp_servers.ae_functions.env]
CODEX_AE_PWSH = "pwsh-fixture"
TOKEN = "fixture-only"
'@
    $result = Invoke-TimeoutFixture $config
    $expected = $config.Replace('startup_timeout_sec = 1 # old', 'startup_timeout_sec = 10').Replace("tool_timeout_sec = 2`n", "tool_timeout_sec = 210`n")
    Assert-True ($result.state -eq 'success' -and -not $result.registered) 'Fixture mode must not register globally.'
    Assert-True ([IO.File]::ReadAllText($fixtureConfig) -ceq $expected) 'Only owned timeout settings should change; multiline prompt and other servers must remain byte-identical.'
    $passed += 1

    $again = & (Join-Path $workspaceRoot 'tools/Install-AeFunctionsMcp.ps1') -SkipRegistration -ConfigPath $fixtureConfig | ConvertFrom-Json
    Assert-True (-not $again.timeoutsUpdated) 'Timeout update must be idempotent.'
    Assert-True (@(Get-ChildItem -LiteralPath $fixtureRoot -Filter '*.tmp').Count -eq 0) 'No temporary full configuration copies should remain.'
    $passed += 1

    $literal = @'
prompt = '''
[mcp_servers.ae_functions]
tool_timeout_sec = 888
'''
[mcp_servers."ae_functions"]
command = "fixture"
[mcp_servers.ae_functions.env]
VALUE = "preserved"
'@
    Invoke-TimeoutFixture $literal | Out-Null
    $literalResult = [IO.File]::ReadAllText($fixtureConfig)
    Assert-True ($literalResult.Contains("tool_timeout_sec = 888`n'''")) 'Literal multiline prompt must be preserved.'
    Assert-True ($literalResult.Contains("[mcp_servers.`"ae_functions`"]`nstartup_timeout_sec = 10`ntool_timeout_sec = 210`n")) 'Missing owned timeouts must insert in the server table, before env.'
    $passed += 1

    Invoke-TimeoutFixture '[mcp_servers.ae_functions]' | Out-Null
    Assert-True ([IO.File]::ReadAllText($fixtureConfig) -ceq "[mcp_servers.ae_functions]`nstartup_timeout_sec = 10`ntool_timeout_sec = 210`n") 'Header without trailing newline must be handled.'
    $passed += 1

    foreach ($bad in @('[mcp_servers.other]', "[mcp_servers.ae_functions]`n[mcp_servers.ae_functions]", "[mcp_servers.ae_functions]`nstartup_timeout_sec = 1`nstartup_timeout_sec = 2")) {
        [IO.File]::WriteAllText($fixtureConfig, $bad, $utf8)
        $rejected = $false
        try { & (Join-Path $workspaceRoot 'tools/Install-AeFunctionsMcp.ps1') -SkipRegistration -ConfigPath $fixtureConfig | Out-Null } catch { $rejected = $true }
        Assert-True $rejected 'Ambiguous or missing owned tables must be rejected.'
        Assert-True ([IO.File]::ReadAllText($fixtureConfig) -ceq $bad) 'Failed timeout update must preserve fixture config.'
    }
    $rejected = $false
    try { & (Join-Path $workspaceRoot 'tools/Install-AeFunctionsMcp.ps1') -ConfigPath $fixtureConfig | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'A custom fixture config must never trigger actual global registration.'
    $passed += 1

    # Setup can discover PowerShell 7 by its standard installation path even
    # when it is absent from PATH; registration must retain that running host.
    [IO.File]::WriteAllText($fixtureConfig, '[mcp_servers.ae_functions]', $utf8)
    $runningPwsh = (Get-Process -Id $PID).Path
    $nodeDirectory = Split-Path -Parent (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $originalPath = $env:PATH
    try {
        $env:PATH = $nodeDirectory
        Assert-True ($null -eq (Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue)) 'PATH isolation fixture still exposes pwsh.'
        $withoutPwshPath = & $runningPwsh -NoProfile -File (Join-Path $workspaceRoot 'tools/Install-AeFunctionsMcp.ps1') -SkipRegistration -ConfigPath $fixtureConfig | ConvertFrom-Json
        Assert-True ($LASTEXITCODE -eq 0 -and $withoutPwshPath.state -eq 'success' -and $withoutPwshPath.powershellPath -ieq $runningPwsh) 'MCP registration helper requires pwsh on PATH despite running in PowerShell 7.'
    } finally { $env:PATH = $originalPath }
    $passed += 1

    # Exercise unified setup order using local stubs; no AE user files or Codex config are touched.
    Copy-Item -LiteralPath (Join-Path $workspaceRoot 'tools/Install-AeFunctions.ps1') -Destination (Join-Path $fixtureTools 'Install-AeFunctions.ps1')
    [IO.File]::WriteAllText((Join-Path $fixtureTools 'Build-AeScriptBundle.js'), @'
const fs=require("node:fs"),path=require("node:path");
fs.appendFileSync(path.join(__dirname,"../.ae-codex/order.log"),"build\n");
console.log(JSON.stringify({state:"success",fixture:true}));
'@, $utf8)
    [IO.File]::WriteAllText((Join-Path $fixtureTools 'Update-AeBridgeUserPanel.ps1'), @'
param([string]$VersionFolder)
Add-Content -LiteralPath (Join-Path $PSScriptRoot '../.ae-codex/order.log') -Value 'panel'
@{state='success';versionFolder=$VersionFolder} | ConvertTo-Json
'@, $utf8)
    [IO.File]::WriteAllText((Join-Path $fixtureTools 'Install-AeFunctionsMcp.ps1'), @'
Add-Content -LiteralPath (Join-Path $PSScriptRoot '../.ae-codex/order.log') -Value 'mcp'
@{state='success';fixture=$true} | ConvertTo-Json
'@, $utf8)
    $installed = & (Join-Path $fixtureTools 'Install-AeFunctions.ps1') -VersionFolder '26.5' -SkipBackgroundService | ConvertFrom-Json -Depth 32
    $orderPath = Join-Path $fixtureRoot '.ae-codex/order.log'
    Assert-True (($installed.state -eq 'success') -and ($installed.schema -eq 'codex-ae-functions-install/v1')) 'Unified installer must return one structured JSON result.'
    Assert-True (([IO.File]::ReadAllText($orderPath).Replace("`r", '')) -ceq "build`npanel`nmcp`n") 'Unified setup order must be build, verified panel, then MCP.'
    $passed += 1

    [IO.File]::WriteAllText((Join-Path $fixtureTools 'Build-AeScriptBundle.js'), 'process.exit(2);', $utf8)
    Remove-Item -LiteralPath $orderPath -Force
    $rejected = $false
    try { & (Join-Path $fixtureTools 'Install-AeFunctions.ps1') | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'Failed build must stop installation.'
    Assert-True (-not (Test-Path -LiteralPath $orderPath)) 'Failed build must not invoke panel or MCP installers.'
    $passed += 1
    Write-Output "AE functions installation tests passed: $passed groups (fixtures only; global config unchanged)."
} finally {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $allowed = [IO.Path]::GetFullPath((Join-Path $workspaceRoot '.ae-codex/tests')) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
