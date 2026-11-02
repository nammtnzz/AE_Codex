#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PayloadRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pwsh=(Get-Process -Id $PID).Path
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('CodexAE-fixture-'+[guid]::NewGuid().ToString('N'))
$fixtureData=Join-Path $fixtureRoot '.ae-codex'
$payload=Join-Path $fixtureData 'payload'
$installRoot=Join-Path $fixtureRoot 'New user đầy đủ/CodexAE'
$appData=Join-Path $fixtureData 'AppData'
$checks=[Collections.Generic.List[string]]::new()
[IO.Directory]::CreateDirectory($fixtureData)|Out-Null
Copy-Item -LiteralPath ([IO.Path]::GetFullPath($PayloadRoot)) -Destination $payload -Recurse
# Exercise current installer and onboarding code, even while the release builder is being updated.
foreach($name in @('Install-AeDistribution.ps1','Manage-AeInstallation.ps1','Install-AeFunctionsMcp.ps1','AeCodexConfig.js','Initialize-AeLibrary.ps1','AeBackgroundLauncher.cs','AeBackgroundServiceLifecycle.ps1','Update-AeSfxCatalog.ps1')){
    Copy-Item -LiteralPath (Join-Path $workspace "tools/$name") -Destination (Join-Path $payload "tools/$name") -Force
}
$manifestPath=Join-Path $payload 'distribution.json'
$baseManifest=[IO.File]::ReadAllText($manifestPath)|ConvertFrom-Json
function Save-Manifest([string]$PackageId){
    $baseManifest.packageId=$PackageId
    foreach($file in $baseManifest.files){
        $path=Join-Path $payload $file.path
        $file.sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        $file.bytes=(Get-Item -LiteralPath $path).Length
    }
    [IO.File]::WriteAllText($manifestPath,($baseManifest|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
function Assert-Check([bool]$Condition,[string]$Message){if(-not $Condition){throw "FAILED: $Message"};$checks.Add($Message)}
function Invoke-Install([hashtable]$Settings=@{},[int]$ExpectedExit=0){
    $request=[ordered]@{schema='codex-ae-install-request/v1';InstallRoot=$installRoot;VersionFolder='26.5';SfxChoice='Disable';SkipMcpRegistration=$true;AppDataRoot=$appData}
    foreach($key in $Settings.Keys){$request[$key]=$Settings[$key]}
    $requestPath=Join-Path $fixtureData ('request-'+[guid]::NewGuid().ToString('N')+'.json')
    [IO.File]::WriteAllText($requestPath,($request|ConvertTo-Json -Depth 8))
    $output=@(& $pwsh -NoProfile -File (Join-Path $payload 'tools/Install-AeDistribution.ps1') -RequestPath $requestPath)
    if($LASTEXITCODE-ne $ExpectedExit){throw "Installer exit $LASTEXITCODE, expected $ExpectedExit. $($output-join ' ')"}
    return ($output-join "`n"|ConvertFrom-Json)
}
Save-Manifest 'fixture-v1'
$savedPath=$env:PATH
try{
    $env:PATH=''
    $missingNode=Invoke-Install -ExpectedExit 1
    Assert-Check ($missingNode.error-match 'Node.js 20 or newer'-and -not(Test-Path -LiteralPath $installRoot)) 'Missing Node.js is reported before any installation changes.'
}finally{$env:PATH=$savedPath}
$fakeNodeRoot=Join-Path $fixtureData 'old-node'
[IO.Directory]::CreateDirectory($fakeNodeRoot)|Out-Null
[IO.File]::WriteAllText((Join-Path $fakeNodeRoot 'node.cmd'),"@echo off`r`necho 18.0.0`r`n")
try{
    $env:PATH=$fakeNodeRoot
    $oldNode=Invoke-Install -ExpectedExit 1
    Assert-Check ($oldNode.error-match 'Node.js 20 or newer'-and -not(Test-Path -LiteralPath $installRoot)) 'Unsupported Node.js versions produce an actionable error before installation.'
}finally{$env:PATH=$savedPath}
$savedProgramFiles=$env:ProgramFiles
$savedProgramW6432=$env:ProgramW6432
try{
    $env:ProgramFiles=Join-Path $fixtureData 'No installed apps'
    $env:ProgramW6432=$env:ProgramFiles
    $noAe=Invoke-Install -Settings @{VersionFolder=''} -ExpectedExit 1
    Assert-Check ($noAe.error-match 'After Effects was not detected'-and -not(Test-Path -LiteralPath $installRoot)) 'An undetected AE host is reported without guessing a version or creating an installation.'
}finally{$env:ProgramFiles=$savedProgramFiles;$env:ProgramW6432=$savedProgramW6432}
$bundle=Join-Path $payload 'jsx/Codex Bridge.jsx'
$originalBundle=[IO.File]::ReadAllBytes($bundle)
[IO.File]::AppendAllText($bundle,'corrupt')
$bad=Invoke-Install -ExpectedExit 1
Assert-Check ($bad.state-eq 'error'-and $bad.error-match 'verification failed'-and -not(Test-Path -LiteralPath $installRoot)) 'A changed payload fails checksum validation before creating the install folder.'
[IO.File]::WriteAllBytes($bundle,$originalBundle)
$outsideFile=[pscustomobject]@{path='../outside.txt';sha256=('0'*64);bytes=0}
$baseManifest.files=@($baseManifest.files)+$outsideFile
[IO.File]::WriteAllText($manifestPath,($baseManifest|ConvertTo-Json -Depth 10))
$badPath=Invoke-Install -ExpectedExit 1
Assert-Check ($badPath.error-match 'Unsafe package path'-and -not(Test-Path -LiteralPath $installRoot)) 'Package traversal paths are rejected before installation.'
$baseManifest.files=@($baseManifest.files|Where-Object path -ne '../outside.txt')
Save-Manifest 'fixture-v1'
$sourceDestination=Join-Path $workspace '.ae-codex/tests/should-not-install'
$sourceReject=Invoke-Install -Settings @{InstallRoot=$sourceDestination} -ExpectedExit 1
Assert-Check ($sourceReject.error-match 'source checkout'-and -not(Test-Path -LiteralPath $sourceDestination)) 'Installation into any source-checkout descendant is rejected.'
$first=Invoke-Install
Assert-Check ($first.state-eq 'success'-and $first.mcpState-eq 'skipped'-and $first.effectsState-eq 'pending-manual-scan') 'A fresh install succeeds in a different Unicode root and reports that effects wait for an explicit scan.'
$runtime=$first.runtimeRoot
$chatStatePath=Join-Path $runtime '.ae-codex/chat/state.json'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($chatStatePath))|Out-Null
[IO.File]::WriteAllText($chatStatePath,(@{schema='codex-ae-chat-state/v1';busy=$true;pendingRequests=@()}|ConvertTo-Json))
$chatBusy=Invoke-Install -Settings @{SfxChoice='Preserve'} -ExpectedExit 1
Assert-Check ($chatBusy.error-match 'Codex chat is still working'-and $first.runtimeRoot-ceq (([IO.File]::ReadAllText((Join-Path $installRoot 'installation.json'))|ConvertFrom-Json).runtimeRoot)) 'An active Codex chat blocks runtime updates without switching or replaying the conversation.'
$metadataBeforeUnknown=[IO.File]::ReadAllText((Join-Path $installRoot 'installation.json'))
[IO.File]::WriteAllText($chatStatePath,(@{schema='codex-ae-chat-state/v1';busy=$false;pendingRequests=@();error=@{code='TURN_STATE_UNKNOWN'}}|ConvertTo-Json -Depth 5))
$chatUnknown=Invoke-Install -Settings @{SfxChoice='Preserve'} -ExpectedExit 1
Assert-Check ($chatUnknown.error-match 'chat result is unconfirmed'-and [IO.File]::ReadAllText((Join-Path $installRoot 'installation.json'))-ceq $metadataBeforeUnknown) 'An unconfirmed chat shutdown blocks runtime updates even when busy is false and no approval is pending.'
[IO.File]::WriteAllText($chatStatePath,(@{schema='codex-ae-chat-state/v1';busy=$false;pendingRequests=@()}|ConvertTo-Json))
$configPath=Join-Path $runtime '.ae-codex/library/config.json'
$config=[IO.File]::ReadAllText($configPath)|ConvertFrom-Json
Assert-Check (-not $config.sfx.enabled-and @($config.sfx.roots).Count-eq 0-and -not(Test-Path -LiteralPath (Join-Path $runtime '.ae-codex/library/sessions'))) 'Skipping sound indexing creates no catalog or scan session and has no machine-specific roots.'
Assert-Check ($config.refreshMode-ceq 'manual'-and $config.effects.enabled) 'New installations enable Effects for manual use and never configure automatic library refresh.'
$panelPath=Join-Path $appData 'Adobe/After Effects/26.5/Scripts/ScriptUI Panels/Codex Bridge.jsx'
$startupPath=Join-Path $appData 'Adobe/After Effects/26.5/Scripts/Startup/Codex Bridge Startup.jsx'
$panelText=[IO.File]::ReadAllText($panelPath)
$expectedBundleLiteral = ConvertTo-Json -InputObject (([IO.Path]::GetFullPath((Join-Path $runtime 'jsx/Codex Bridge.jsx'))).Replace('\', '/')) -Compress -EscapeHandling EscapeNonAscii
Assert-Check ($panelText.Contains($expectedBundleLiteral)-and (Test-Path -LiteralPath $startupPath)) 'Fresh install writes thin panel/startup loaders that point to this installed runtime.'
$certificatePath=Join-Path $runtime '.ae-codex/bundle/installed-validation.json'
$certificate=[IO.File]::ReadAllBytes($certificatePath)
$configBefore=[IO.File]::ReadAllText($configPath)
$again=Invoke-Install -Settings @{SfxChoice='Preserve'}
Assert-Check ($again.state-eq 'success'-and $configBefore-ceq [IO.File]::ReadAllText($configPath)-and [Convert]::ToBase64String($certificate)-ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($certificatePath))) 'Reinstall preserves preferences and reuses an unchanged installation certificate.'
$soundRoot=Join-Path $fixtureData 'Sound Library'
[IO.Directory]::CreateDirectory($soundRoot)|Out-Null
[IO.File]::WriteAllBytes((Join-Path $soundRoot 'fixture.wav'),[byte[]](1,2,3))
$enabled=Invoke-Install -Settings @{SfxChoice='Enable';SoundRoots=@($soundRoot)}
$enabledConfig=[IO.File]::ReadAllText($configPath)
$latestSfx=[IO.File]::ReadAllText((Join-Path $runtime '.ae-codex/library/latest-sfx.json'))|ConvertFrom-Json
Assert-Check ($enabled.soundIndexing-and $latestSfx.count-eq 1-and $enabledConfig.Contains('Sound Library')) 'Sound opt-in indexes only the explicitly selected synthetic-audio folder.'
$stateSentinel=Join-Path $runtime '.ae-codex/bridge/results/status-fixture.json'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($stateSentinel))|Out-Null
[IO.File]::WriteAllText($stateSentinel,'{"state":"success"}')
$oldCatalog=Join-Path $runtime '.ae-codex/library/current.json'
[IO.File]::WriteAllText($oldCatalog,'{"schema":"fixture-only"}')
Save-Manifest 'fixture-v2'
$update=Invoke-Install -Settings @{SfxChoice='Preserve'}
$nextRuntime=$update.runtimeRoot
Assert-Check ($update.state-eq 'success'-and $enabledConfig-ceq [IO.File]::ReadAllText((Join-Path $nextRuntime '.ae-codex/library/config.json'))-and (Test-Path -LiteralPath $runtime)) 'Updating to a new immutable runtime preserves sound consent/config and retains the prior version.'
Assert-Check (-not(Test-Path -LiteralPath (Join-Path $nextRuntime '.ae-codex/bridge/results'))-and -not(Test-Path -LiteralPath (Join-Path $nextRuntime '.ae-codex/library/current.json'))-and -not(Test-Path -LiteralPath (Join-Path $nextRuntime '.ae-codex/library/latest-sfx.json'))) 'Updates do not copy old jobs, inventory pointers, audio catalogs, or connection state.'
$busyLock=Join-Path $nextRuntime '.ae-codex/bridge/submit.lock'
[IO.Directory]::CreateDirectory($busyLock)|Out-Null
Save-Manifest 'fixture-v3'
$busy=Invoke-Install -Settings @{SfxChoice='Preserve'} -ExpectedExit 1
Assert-Check ($busy.error-match 'job may still be active'-and (Test-Path -LiteralPath $busyLock)-and -not(Test-Path -LiteralPath (Join-Path $installRoot 'versions/fixture-v3'))) 'Updates stop before changes when an existing submission lock is present, and retain that lock.'
[IO.Directory]::Delete($busyLock)
$startedPath=Join-Path $nextRuntime '.ae-codex/bridge/results/started-incomplete.json'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($startedPath))|Out-Null
[IO.File]::WriteAllText($startedPath,'{"state":"started"}')
$unknown=Invoke-Install -Settings @{SfxChoice='Preserve'} -ExpectedExit 1
Assert-Check ($unknown.error-match 'no terminal result'-and (Test-Path -LiteralPath $startedPath)) 'A started job without terminal publication blocks updates without replaying or deleting it.'
[IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($startedPath)) 'status-incomplete.json'),'{"state":"success"}')
$metadataPath=Join-Path $installRoot 'installation.json'
$metadataBefore=[IO.File]::ReadAllText($metadataPath)
$panelBefore=[IO.File]::ReadAllText($panelPath)
$startupBefore=[IO.File]::ReadAllText($startupPath)
$templatePath=Join-Path $payload 'tools/AeBridgePanel.js'
$originalTemplate=[IO.File]::ReadAllText($templatePath)
[IO.File]::WriteAllText($templatePath,'invalid loader template')
Save-Manifest 'fixture-bad-template'
$rollbackResult=Invoke-Install -Settings @{SfxChoice='Disable'} -ExpectedExit 1
Assert-Check ($rollbackResult.error-match 'Invalid loader template'-and $metadataBefore-ceq [IO.File]::ReadAllText($metadataPath)-and $panelBefore-ceq [IO.File]::ReadAllText($panelPath)-and $startupBefore-ceq [IO.File]::ReadAllText($startupPath)) 'A post-validation setup failure preserves the previous loaders and installation selection.'
[IO.File]::WriteAllText($templatePath,$originalTemplate)
Save-Manifest 'fixture-partial-publication'
[IO.File]::Delete($startupPath)
[IO.Directory]::CreateDirectory($startupPath)|Out-Null
try{
    $partial=Invoke-Install -Settings @{SfxChoice='Preserve'} -ExpectedExit 1
    Assert-Check ($partial.state-eq 'error'-and $metadataBefore-ceq [IO.File]::ReadAllText($metadataPath)-and $panelBefore-ceq [IO.File]::ReadAllText($panelPath)) 'A failure after publishing the new panel rolls that panel back and retains the previous installation metadata.'
}finally{[IO.Directory]::Delete($startupPath);[IO.File]::WriteAllText($startupPath,$startupBefore)}
Save-Manifest 'fixture-v4'
$disable=Invoke-Install -Settings @{SfxChoice='Disable'}
$disabledConfig=[IO.File]::ReadAllText((Join-Path $disable.runtimeRoot '.ae-codex/library/config.json'))|ConvertFrom-Json
Assert-Check (-not $disable.soundIndexing-and -not $disabledConfig.sfx.enabled-and -not(Test-Path -LiteralPath (Join-Path $disable.runtimeRoot '.ae-codex/library/sessions'))) 'Choosing Skip on an update disables further sound indexing without scanning migrated folders.'
Save-Manifest 'fixture-desktop-codex'
$previousCodexHome=$env:CODEX_HOME
try{
    $env:CODEX_HOME=Join-Path $fixtureData 'Codex on this new computer'
    [IO.Directory]::CreateDirectory($env:CODEX_HOME)|Out-Null
    $fixtureCodexConfig=Join-Path $env:CODEX_HOME 'config.toml'
    $unrelated="model = 'existing-local-model'`n[mcp_servers.other]`ncommand = 'untouched-server'`n"
    [IO.File]::WriteAllText($fixtureCodexConfig,$unrelated)
    $nodeDirectory=[IO.Path]::GetDirectoryName((Get-Command node -CommandType Application|Select-Object -First 1).Source)
    $env:PATH=$nodeDirectory+';'+[IO.Path]::GetDirectoryName($pwsh)
    $desktopCodex=Invoke-Install -Settings @{SfxChoice='Preserve';SkipMcpRegistration=$false}
    Assert-Check ($desktopCodex.state-eq 'success'-and $desktopCodex.mcpState-eq 'configured'-and $desktopCodex.mcpConfigPath-eq $fixtureCodexConfig-and $desktopCodex.codexReloadRequired-and -not $desktopCodex.codexSessionVerified) 'Without Codex CLI, setup registers tools in this computer''s isolated Codex Desktop config and reports reload required.'
    $localConfig=[IO.File]::ReadAllText($fixtureCodexConfig)
    Assert-Check ($localConfig.StartsWith($unrelated)-and $localConfig.Contains('AeFunctionsMcp.js')-and $localConfig.Contains($desktopCodex.runtimeRoot.Replace('\','/'))) 'Local Codex registration preserves unrelated settings and references this installed runtime.'
}finally{$env:PATH=$savedPath;$env:CODEX_HOME=$previousCodexHome}
$reportRoot=Join-Path $workspace '.ae-codex/tests'
[IO.Directory]::CreateDirectory($reportRoot)|Out-Null
$report=[ordered]@{state='success';checks=$checks.Count;messages=@($checks);fixtureRoot=$fixtureRoot;realInstallationChanged=$false}
[IO.File]::WriteAllText((Join-Path $reportRoot 'distribution-installer.json'),($report|ConvertTo-Json -Depth 5))
$report|ConvertTo-Json -Depth 5
