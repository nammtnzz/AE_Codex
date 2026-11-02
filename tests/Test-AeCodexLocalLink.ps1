#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PayloadRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pwshPath = (Get-Process -Id $PID).Path
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$utf8 = [Text.UTF8Encoding]::new($false)
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('CodexAE-local-link-' + [guid]::NewGuid().ToString('N'))
$fixtureData = Join-Path $fixtureRoot '.ae-codex'
$payload = Join-Path $fixtureData 'payload'
$installRoot = Join-Path $fixtureRoot 'New user đầy đủ/CodexAE'
$codexHome = Join-Path $fixtureData 'Codex desktop home đầy đủ'
$appData = Join-Path $fixtureData 'AppData'
$configPath = Join-Path $codexHome 'config.toml'
$checks = [Collections.Generic.List[string]]::new()
[IO.Directory]::CreateDirectory($fixtureData) | Out-Null
[IO.Directory]::CreateDirectory($codexHome) | Out-Null
Copy-Item -LiteralPath ([IO.Path]::GetFullPath($PayloadRoot)) -Destination $payload -Recurse

# Test the current integration against an independently copied release. Neither
# real Codex settings nor user-profile AE scripts are read or written.
$latestTools = @('Install-AeDistribution.ps1', 'Install-AeFunctionsMcp.ps1', 'AeCodexConfig.js', 'AeBackgroundServiceLifecycle.ps1')
$manifestPath = Join-Path $payload 'distribution.json'
$manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
foreach ($name in $latestTools) {
    $relative = 'tools/' + $name
    Copy-Item -LiteralPath (Join-Path $workspace $relative) -Destination (Join-Path $payload $relative) -Force
    if (-not @($manifest.files | Where-Object path -eq $relative).Count) {
        $manifest.files = @($manifest.files) + [pscustomobject]@{path=$relative;sha256='';bytes=0}
    }
}
function Save-FixtureManifest([string]$PackageId) {
    $manifest.packageId = $PackageId
    foreach ($file in $manifest.files) {
        $path = Join-Path $payload $file.path
        $file.sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        $file.bytes = (Get-Item -LiteralPath $path).Length
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8)
}
function Assert-Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAILED: $Message" }
    $checks.Add($Message)
}
function Invoke-FixtureInstall {
    $request = [ordered]@{
        schema='codex-ae-install-request/v1';InstallRoot=$installRoot;VersionFolder='26.5'
        SfxChoice='Disable';SkipMcpRegistration=$false;AppDataRoot=$appData
    }
    $requestPath = Join-Path $fixtureData ('request-' + [guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 8), $utf8)
    $output = @(& $pwshPath -NoProfile -NonInteractive -File (Join-Path $payload 'tools/Install-AeDistribution.ps1') -RequestPath $requestPath)
    if ($LASTEXITCODE -ne 0) { throw "Fixture installation failed: $($output -join ' ')" }
    return ($output -join "`n" | ConvertFrom-Json)
}

# These fake headers must remain prompt text. Other settings are preserved
# byte-for-byte; fixture values are synthetic and contain no credentials.
$unrelatedConfig = @'
model = "fixture-model"
instructions = """
[mcp_servers.ae_functions]
command = "prompt text only"
"""
[mcp_servers.fixture_other]
command = "fixture-command"
args = ["preserve-me"]
enabled = false
[mcp_servers.fixture_other.env]
FIXTURE_MARKER = "preserved"
'@
[IO.File]::WriteAllText($configPath, $unrelatedConfig, $utf8)

# Probe the exact command/arguments/environment written for Codex, through the
# public MCP transport. All calls below are discovery/status and cannot dispatch
# an AE job. Transport readiness does not assert a live Desktop chat has loaded it.
$probePath = Join-Path $fixtureData 'probe-local-codex.js'
$probe = @'
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const [configPath, runtimeRoot, helperPath, expectedPwsh] = process.argv.slice(2);
const { readInstalledMcpSettings } = require(helperPath);
const settings = readInstalledMcpSettings(fs.readFileSync(configPath, "utf8"));
const samePath = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
assert(samePath(settings.command, process.execPath), "Codex must use machine-local Node.js");
assert.equal(settings.args.length,1);
assert(samePath(settings.args[0],path.join(runtimeRoot,"tools/AeFunctionsMcp.js")),"MCP server must come from this installed runtime");
assert(samePath(settings.cwd, runtimeRoot), "MCP cwd must be the installed runtime");
assert(samePath(settings.env.CODEX_AE_PWSH, expectedPwsh), "MCP must retain the running machine-local PowerShell 7");
const child = spawn(settings.command, settings.args, {cwd:settings.cwd,
    env:{...process.env,...settings.env},windowsHide:true,stdio:["pipe","pipe","pipe"]});
const pending = new Map();
let sequence=0, stderr="";
child.stderr.on("data",chunk=>{stderr+=chunk});
child.on("error",error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear()});
child.on("exit",code=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("MCP exited "+code+": "+stderr))}pending.clear()});
readline.createInterface({input:child.stdout,crlfDelay:Infinity}).on("line",line=>{
    let response;try{response=JSON.parse(line)}catch(error){for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear();return}
    const p=pending.get(response.id);if(!p)return;clearTimeout(p.timer);pending.delete(response.id);
    response.error?p.reject(new Error(response.error.message)):p.resolve(response.result);
});
function send(method,params){return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error("MCP timeout for "+method))},8000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,...(params?{params}:{})})+"\n");
})}
async function call(name,args={}){
    const result=await send("tools/call",{name,arguments:args});assert(!result.isError,JSON.stringify(result));
    return JSON.parse(result.content.find(item=>item.type==="text").text);
}
(async()=>{
    try{
        const initialized=await send("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"isolated-install-fixture",version:"1"}});
        assert.equal(initialized.serverInfo.name,"ae-functions");
        child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
        const listed=await send("tools/list");assert(listed.tools.some(tool=>tool.name==="ae_search_capabilities"));
        const search=await call("ae_search_capabilities",{limit:100});
        assert.equal(search.total,43);assert(search.results.every(entry=>entry.kind==="function"));
        assert.equal(search.installed.scripts,1);
        const status=await call("ae_capability_status");
        assert.equal(status.activeTools,43);assert.equal(status.installation.certificateMatches,true);
        assert.equal(status.connection.fresh,false);assert.equal(status.runtimeVerified,false);
        assert(!fs.existsSync(path.join(runtimeRoot,".ae-codex/functions/requests")),"Read-only MCP probe must not dispatch function requests");
        assert(!fs.existsSync(path.join(runtimeRoot,".ae-codex/bridge/jobs")),"Read-only MCP probe must not create bridge jobs");
        process.stdout.write(JSON.stringify({state:"success",publicTools:search.total,registeredTools:listed.tools.length,
            runtimeRoot,bridgeConnected:false,codexSessionVerified:false,transportVerified:true}));
    }finally{
        child.stdin.end();await new Promise(resolve=>child.exitCode!==null?resolve():child.once("exit",resolve));
    }
})().catch(error=>{process.stderr.write(error.stack+"\n");process.exitCode=1});
'@
[IO.File]::WriteAllText($probePath, $probe, $utf8)
function Invoke-ReadOnlyProbe([string]$RuntimeRoot) {
    $output = @(& $nodePath $probePath $configPath $RuntimeRoot (Join-Path $payload 'tools/AeCodexConfig.js') $pwshPath)
    if ($LASTEXITCODE -ne 0) { throw 'The machine-local Codex configuration did not launch a working read-only MCP transport.' }
    return ($output -join "`n" | ConvertFrom-Json)
}

$savedPath = $env:PATH
$savedCodexHome = $env:CODEX_HOME
try {
    $env:CODEX_HOME = $codexHome
    $env:PATH = [IO.Path]::GetDirectoryName($nodePath) + ';' + [IO.Path]::GetDirectoryName($pwshPath)
    Assert-Check ($null -eq (Get-Command codex -CommandType Application -ErrorAction SilentlyContinue)) 'Fixture has no Codex CLI and uses a separate Codex Desktop user configuration.'
    Save-FixtureManifest 'fixture-local-codex-v1'
    $first = Invoke-FixtureInstall
    Assert-Check ($first.state -eq 'success' -and $first.mcpState -eq 'configured' -and $first.mcpConfigPath -ieq $configPath -and $first.mcpRegistrationMethod -eq 'desktop-config') 'New-machine installation registers tools in that machine-local Codex configuration without a CLI.'
    Assert-Check ($first.codexReloadRequired -and -not $first.codexSessionVerified -and $first.effectsState -eq 'pending-manual-scan') 'Installation distinguishes configured tools from a reloaded Codex session and an explicit Effects scan.'
    $firstText = [IO.File]::ReadAllText($configPath)
    Assert-Check ($firstText.Contains($unrelatedConfig)) 'Registration preserves unrelated Codex settings and apparent MCP headers inside multiline prompt text.'
    $firstProbe = Invoke-ReadOnlyProbe $first.runtimeRoot
    Assert-Check ($firstProbe.state -eq 'success' -and $firstProbe.publicTools -eq 43 -and $firstProbe.transportVerified -and -not $firstProbe.bridgeConnected) 'The exact configured command starts MCP and discovers all 43 reusable tools without opening AE or dispatching a job.'
    $metadata = [IO.File]::ReadAllText((Join-Path $installRoot 'installation.json')) | ConvertFrom-Json
    Assert-Check ($metadata.mcpState -eq 'configured' -and $metadata.mcpConfigPath -ieq $configPath -and $metadata.runtimeRoot -ieq $first.runtimeRoot) 'Installation metadata records the local Codex binding and installed runtime.'
    Save-FixtureManifest 'fixture-local-codex-v2'
    $updated = Invoke-FixtureInstall
    $secondProbe = Invoke-ReadOnlyProbe $updated.runtimeRoot
    Assert-Check ($updated.runtimeRoot -ine $first.runtimeRoot -and (Test-Path -LiteralPath $first.runtimeRoot) -and $secondProbe.transportVerified) 'Updating rebinds Codex to the new installed runtime while retaining the previous version.'
    $updatedText = [IO.File]::ReadAllText($configPath)
    Assert-Check ($updatedText.Contains($unrelatedConfig) -and -not $updatedText.Contains($first.runtimeRoot.Replace('\','/')) -and -not $updatedText.Contains($first.runtimeRoot.Replace('\','\\'))) 'The active Codex entry advances to the updated runtime and preserves unrelated user settings.'
    $repeat = Invoke-FixtureInstall
    Assert-Check ($repeat.state -eq 'success' -and [IO.File]::ReadAllText($configPath) -ceq $updatedText) 'Reinstalling the same version keeps the machine-local Codex binding byte-identical.'
    $reportRoot = Join-Path $workspace '.ae-codex/tests'
    [IO.Directory]::CreateDirectory($reportRoot) | Out-Null
    $report = [ordered]@{state='success';checks=$checks.Count;messages=@($checks);fixtureRoot=$fixtureRoot;realInstallationChanged=$false;realCodexConfigurationChanged=$false;aeJobsDispatched=0}
    [IO.File]::WriteAllText((Join-Path $reportRoot 'codex-local-link.json'), ($report | ConvertTo-Json -Depth 6), $utf8)
    $report | ConvertTo-Json -Depth 6
} finally {
    $env:PATH = $savedPath
    $env:CODEX_HOME = $savedCodexHome
}
