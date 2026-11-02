#Requires -Version 7.0
[CmdletBinding()]
param([string]$PayloadRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $PayloadRoot) {
    $release = [IO.File]::ReadAllText((Join-Path $workspace '.ae-codex/releases/latest.json')) | ConvertFrom-Json
    $PayloadRoot = Join-Path $workspace ('.ae-codex/releases/CodexAE-' + $release.packageId + '/payload')
}
$testId = [guid]::NewGuid().ToString('N')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("Codex AE uninstall $testId/Máy mới & 100% O'Brien")
$data = Join-Path $fixture '.ae-codex'
$payload = Join-Path $data 'payload'
$installRoot = Join-Path $fixture 'CodexAE'
$appData = Join-Path $data 'AppData'
$codexHome = Join-Path $data 'Local Codex'
$reportRoot = Join-Path $workspace ".ae-codex/tests-uninstall/$testId"
$runPath = "HKCU:\Software\CodexAE\Tests\$testId\Run"
$pwsh = (Get-Process -Id $PID).Path
$savedCodexHome = $env:CODEX_HOME
$realConfig = if ([string]::IsNullOrWhiteSpace($savedCodexHome)) { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex/config.toml' } else { Join-Path $savedCodexHome 'config.toml' }
$realConfigHash = if ([IO.File]::Exists($realConfig)) { (Get-FileHash -LiteralPath $realConfig -Algorithm SHA256).Hash } else { $null }
$checks = [Collections.Generic.List[string]]::new()
function Assert-Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw "FAILED: $Message" }; $checks.Add($Message) }
foreach ($directory in @($data,$codexHome,$reportRoot)) { [void][IO.Directory]::CreateDirectory($directory) }
Copy-Item -LiteralPath $PayloadRoot -Destination $payload -Recurse
foreach ($name in @('Install-AeDistribution.ps1','Uninstall-AeDistribution.ps1','AeCodexConfig.js','Initialize-AeLibrary.ps1','AeBackgroundLauncher.cs','AeBackgroundServiceLifecycle.ps1')) { Copy-Item -LiteralPath (Join-Path $workspace "tools/$name") -Destination (Join-Path $payload "tools/$name") -Force }
$manifestPath = Join-Path $payload 'distribution.json'
$baseManifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
if (-not @($baseManifest.files | Where-Object path -CEQ 'tools/Uninstall-AeDistribution.ps1').Count) { $baseManifest.files = @($baseManifest.files) + [pscustomobject]@{path='tools/Uninstall-AeDistribution.ps1';bytes=0;sha256=('0'*64)} }
function Save-Manifest([string]$Id) {
    $baseManifest.packageId = $Id
    foreach ($file in $baseManifest.files) { $target=Join-Path $payload $file.path; $file.bytes=(Get-Item -LiteralPath $target).Length; $file.sha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText($manifestPath,($baseManifest | ConvertTo-Json -Depth 12))
}
$configPath = Join-Path $codexHome 'config.toml'
$unrelated = @'
# unrelated fixture stays byte for byte
model = "fixture-only"
[other]
note = '''line one
[mcp_servers.ae_functions] inside multiline data
line three'''
'@
[IO.File]::WriteAllText($configPath,$unrelated)
function Invoke-InstallFixture([string]$Id) {
    Save-Manifest $Id
    $out = @(& $pwsh -NoProfile -File (Join-Path $payload 'tools/Install-AeDistribution.ps1') -InstallRoot $installRoot -AppDataRoot $appData -VersionFolder '26.5' -SfxChoice Disable -SkipBackgroundService)
    if ($LASTEXITCODE -ne 0) { throw "Fixture installation failed: $($out -join ' ')" }
    return (($out -join [Environment]::NewLine) | ConvertFrom-Json)
}
function Invoke-UninstallFixture([hashtable]$Settings=@{},[int]$ExpectedExit=0,[switch]$ResultAliasesRequest) {
    $session=Join-Path $installRoot ('.ae-codex/setup/uninstall-test-'+[guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($session)
    $request=[ordered]@{schema='codex-ae-uninstall-request/v1';InstallRoot=$installRoot;AppDataRoot=$appData;LogPath=(Join-Path $session 'progress.log');ResultPath=(Join-Path $session 'result.json');RunRegistryPath=$runPath;FixtureRegistry=$true}
    foreach ($key in $Settings.Keys) { $request[$key]=$Settings[$key] }
    $requestPath=Join-Path $session 'request.json'
    if ($ResultAliasesRequest) { $request.ResultPath=$requestPath }
    [IO.File]::WriteAllText($requestPath,($request | ConvertTo-Json -Depth 6))
    foreach ($name in @('stdout.log','stderr.log')) { [IO.File]::WriteAllText((Join-Path $session $name),'MANAGER-STREAM') }
    $out=@(& $pwsh -NoProfile -File (Join-Path $payload 'tools/Uninstall-AeDistribution.ps1') -RequestPath $requestPath)
    if ($LASTEXITCODE -ne $ExpectedExit) { throw "Uninstaller exit $LASTEXITCODE expected $ExpectedExit : $($out -join ' ')" }
    return (($out -join [Environment]::NewLine) | ConvertFrom-Json)
}
function Write-Loader([string]$Root,[string]$Version,[string]$Kind,[switch]$LegacyWindowsPath) {
    $name=if($Kind -eq 'panel'){'AeBridgePanel.js'}else{'AeBridgeStartup.js'}
    $suffix=if($Kind -eq 'panel'){'ScriptUI Panels/Codex Bridge.jsx'}else{'Startup/Codex Bridge Startup.jsx'}
    $target=Join-Path $appData "Adobe/After Effects/$Version/Scripts/$suffix"
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    $template=[IO.File]::ReadAllText((Join-Path $Root "tools/$name"))
    $bundle=Join-Path $Root 'jsx/Codex Bridge.jsx'
    if (-not $LegacyWindowsPath) { $bundle=$bundle.Replace('\','/') }
    [IO.File]::WriteAllText($target,$template.Replace('__CODEX_AE_WORKSPACE_BUNDLE__',(ConvertTo-Json -InputObject $bundle -Compress -EscapeHandling EscapeNonAscii)),[Text.UTF8Encoding]::new($false))
    return $target
}
try {
    $env:CODEX_HOME=$codexHome
    $first=Invoke-InstallFixture 'fixture-uninstall-v1'
    $second=Invoke-InstallFixture 'fixture-uninstall-v2'
    $runtime=$second.runtimeRoot
    $metadataPath=Join-Path $installRoot 'installation.json'
    $metadataOriginal=[IO.File]::ReadAllText($metadataPath)
    $panel=Join-Path $appData 'Adobe/After Effects/26.5/Scripts/ScriptUI Panels/Codex Bridge.jsx'
    $startup=Join-Path $appData 'Adobe/After Effects/26.5/Scripts/Startup/Codex Bridge Startup.jsx'
    $configBefore=[IO.File]::ReadAllText($configPath)
    $program=Join-Path $runtime 'tools/Get-AeFunctions.ps1'
    $heartbeat=Join-Path $runtime '.ae-codex/bridge/heartbeat.json'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($heartbeat))
    [IO.File]::WriteAllText($heartbeat,(@{schema='codex-ae-heartbeat/v1';state='running';timestampEpochMs=[datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json))
    $live=Invoke-UninstallFixture -ExpectedExit 1
    Assert-Check ($live.error -match 'Nhấn Stop' -and [IO.File]::Exists($panel) -and [IO.File]::Exists($program) -and [IO.File]::ReadAllText($configPath) -ceq $configBefore) 'A fresh idle/running AE bridge blocks uninstall before owned loader, MCP or program file changes.'
    [IO.File]::Delete($heartbeat)
    $chatStatePath=Join-Path $runtime '.ae-codex/chat/state.json'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($chatStatePath))
    [IO.File]::WriteAllText($chatStatePath,(@{schema='codex-ae-chat-state/v1';busy=$true;pendingRequests=@()} | ConvertTo-Json))
    $chatBusy=Invoke-UninstallFixture -ExpectedExit 1
    Assert-Check ($chatBusy.error -match 'Chat Codex' -and -not $chatBusy.partialRemoval -and [IO.File]::ReadAllText($metadataPath) -ceq $metadataOriginal) 'An active chat turn blocks uninstall before any installation or account changes.'
    [IO.File]::WriteAllText($chatStatePath,(@{schema='codex-ae-chat-state/v1';busy=$false;pendingRequests=@(@{id='approval-fixture'})} | ConvertTo-Json -Depth 5))
    $chatWaiting=Invoke-UninstallFixture -ExpectedExit 1
    Assert-Check ($chatWaiting.error -match 'Chat Codex' -and -not $chatWaiting.partialRemoval) 'A chat waiting for an approval or answer cannot be uninstalled underneath its request.'
    [IO.File]::WriteAllText($chatStatePath,(@{schema='codex-ae-chat-state/v1';busy=$false;pendingRequests=@();error=@{code='TURN_STATE_UNKNOWN'}} | ConvertTo-Json -Depth 5))
    $chatUnknown=Invoke-UninstallFixture -ExpectedExit 1
    Assert-Check ($chatUnknown.error -match 'chưa xác nhận lượt chạy' -and -not $chatUnknown.partialRemoval -and [IO.File]::ReadAllText($metadataPath) -ceq $metadataOriginal) 'An unconfirmed chat shutdown blocks uninstall even when busy is false and no approval is pending.'
    [IO.File]::WriteAllText($chatStatePath,(@{schema='codex-ae-chat-state/v1';busy=$false;pendingRequests=@()} | ConvertTo-Json))
    $busyLock=Join-Path $runtime '.ae-codex/bridge/submit.lock'
    [void][IO.Directory]::CreateDirectory($busyLock)
    $busy=Invoke-UninstallFixture -ExpectedExit 1
    Assert-Check ($busy.error -match 'công việc AE đang chạy' -and [IO.Directory]::Exists($busyLock) -and [IO.File]::ReadAllText($metadataPath) -ceq $metadataOriginal) 'A bridge submission lock prevents uninstall and is never reset.'
    [IO.Directory]::Delete($busyLock)
    $inbox=Join-Path $runtime '.ae-codex/bridge/inbox'
    [void][IO.Directory]::CreateDirectory($inbox)
    foreach ($extension in @('job','running')) {
        $queued=Join-Path $inbox ('job-queued-fixture.'+$extension)
        [IO.File]::WriteAllText($queued,'{"runId":"queued-fixture"}')
        $pending=Invoke-UninstallFixture -ExpectedExit 1
        Assert-Check ($pending.error -match 'hàng đợi' -and -not $pending.partialRemoval -and [IO.File]::Exists($queued) -and [IO.File]::ReadAllText($metadataPath) -ceq $metadataOriginal) "An orphan .$extension queue marker blocks uninstall without a submit lock or changes to installation state."
        [IO.File]::Delete($queued)
    }
    $started=Join-Path $runtime '.ae-codex/bridge/results/started-unknown.json'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($started))
    [IO.File]::WriteAllText($started,'{"state":"started"}')
    $unknown=Invoke-UninstallFixture -ExpectedExit 1
    Assert-Check ($unknown.error -match 'chưa có kết quả cuối' -and [IO.File]::Exists($started)) 'A started AE job without a terminal result blocks uninstall without replay or deletion.'
    [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($started)) 'status-unknown.json'),'{"state":"success"}')
    $lock=[IO.File]::Open((Join-Path $installRoot '.ae-codex/setup/install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { $locked=Invoke-UninstallFixture -ExpectedExit 1; Assert-Check ($locked.error -match 'khác đang chạy') 'The shared installation lock serializes install and uninstall.' } finally { $lock.Dispose() }
    $metadata=$metadataOriginal | ConvertFrom-Json
    $metadata.runtimeRoot=Join-Path $fixture 'outside-runtime'
    [IO.File]::WriteAllText($metadataPath,($metadata | ConvertTo-Json -Depth 8))
    $outside=Invoke-UninstallFixture -ExpectedExit 1
    Assert-Check ($outside.error -match 'runtime không thuộc' -and [IO.File]::Exists($panel)) 'Metadata cannot redirect deletion outside the exact installed versions root.'
    [IO.File]::WriteAllText($metadataPath,$metadataOriginal)
    $activeManifestPath=Join-Path $runtime 'distribution.json'
    $activeManifestText=[IO.File]::ReadAllText($activeManifestPath)
    $activeManifest=$activeManifestText | ConvertFrom-Json
    $activeManifest.files=@($activeManifest.files)+[pscustomobject]@{path='../outside.txt';bytes=0;sha256=('0'*64)}
    [IO.File]::WriteAllText($activeManifestPath,($activeManifest | ConvertTo-Json -Depth 12))
    $traversal=Invoke-UninstallFixture -ExpectedExit 1
    Assert-Check ($traversal.error -match 'manifest không an toàn' -and [IO.File]::Exists($program)) 'Manifest traversal is rejected before program deletion.'
    [IO.File]::WriteAllText($activeManifestPath,$activeManifestText)
    $junction=Join-Path $fixture 'LinkedInstall'
    $null=New-Item -ItemType Junction -Path $junction -Target $installRoot
    try { $linked=Invoke-UninstallFixture -Settings @{InstallRoot=$junction} -ExpectedExit 1; Assert-Check ($linked.error -match 'đường dẫn liên kết') 'A linked installation root cannot be uninstalled.' } finally { [IO.Directory]::Delete($junction) }

    $userConfig=Join-Path $runtime '.ae-codex/library/config.json'
    $userConfigOriginal=[IO.File]::ReadAllText($userConfig)
    foreach ($protectedPath in @($userConfig,(Join-Path $installRoot '.ae-codex/setup/install.lock'),(Join-Path $installRoot '.ae-codex/setup/uninstall-backups/progress.log'))) {
        $protected=Invoke-UninstallFixture -Settings @{LogPath=$protectedPath} -ExpectedExit 1
        Assert-Check (-not $protected.partialRemoval -and $protected.error -match 'phiên gỡ riêng' -and [IO.File]::ReadAllText($userConfig) -ceq $userConfigOriginal -and [IO.File]::ReadAllText($metadataPath) -ceq $metadataOriginal) "Protected output alias is rejected before writing user state: $protectedPath"
    }
    $requestAlias=Invoke-UninstallFixture -ResultAliasesRequest -ExpectedExit 1
    Assert-Check (-not $requestAlias.partialRemoval -and $requestAlias.error -match 'result.json' -and [IO.File]::ReadAllText($metadataPath) -ceq $metadataOriginal) 'The result cannot alias the uninstall request or overwrite its JSON.'
    foreach ($name in @('progress.log','result.json')) {
        $protectedSession=Join-Path $installRoot ('.ae-codex/setup/uninstall-existing-'+[guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($protectedSession)
        $existingOutput=Join-Path $protectedSession $name
        [IO.File]::WriteAllText($existingOutput,'EXISTING-OUTPUT-MUST-STAY')
        $existing=Invoke-UninstallFixture -Settings @{LogPath=(Join-Path $protectedSession 'progress.log');ResultPath=(Join-Path $protectedSession 'result.json')} -ExpectedExit 1
        Assert-Check (-not $existing.partialRemoval -and $existing.error -match 'đã tồn tại' -and [IO.File]::ReadAllText($existingOutput) -ceq 'EXISTING-OUTPUT-MUST-STAY' -and [IO.File]::ReadAllText($metadataPath) -ceq $metadataOriginal) "An existing $name is rejected without append, overwrite or installation changes."
    }

    $previousPanel=Write-Loader $first.runtimeRoot '26.3' 'panel' -LegacyWindowsPath
    $extraPanel=Write-Loader $runtime '26.4' 'panel'
    $foreignStartup='// another installation or manually edited startup'
    [IO.File]::WriteAllText($startup,$foreignStartup)
    $modified=Join-Path $runtime 'tools/Get-AeCapabilities.js'
    [IO.File]::AppendAllText($modified,[Environment]::NewLine+'// user modification retained')
    $modifiedHash=(Get-FileHash -LiteralPath $modified -Algorithm SHA256).Hash
    $userData=Join-Path $runtime '.ae-codex/library/user-choice.json'
    $userMedia=Join-Path $runtime 'My projects/keep.aep'
    foreach ($target in @($userData,$userMedia)) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)); [IO.File]::WriteAllText($target,'USER-DATA-MUST-STAY') }
    $sfxConfig=Join-Path $runtime '.ae-codex/library/config.json'
    $sfxBefore=[IO.File]::ReadAllText($sfxConfig)
    $lifecycle=Join-Path $workspace 'tools/AeBackgroundServiceLifecycle.ps1'
    $service=& $lifecycle -Action Enable -WorkspaceRoot $runtime -RunRegistryPath $runPath -FixtureRegistry | ConvertFrom-Json
    Assert-Check ($service.serviceRunning -and $service.autostartRegistered) 'The fixture starts a verified resident and isolated startup registration for uninstall coverage.'
    New-ItemProperty -LiteralPath $runPath -Name 'UnrelatedStartup' -PropertyType String -Value 'leave this value' | Out-Null
    $linkedCodex=Join-Path $fixture 'Linked Codex'
    $null=New-Item -ItemType Junction -Path $linkedCodex -Target $codexHome
    $env:CODEX_HOME=$linkedCodex
    try {
        $earlyPartial=Invoke-UninstallFixture -ExpectedExit 1
        $earlyMetadata=[IO.File]::ReadAllText($metadataPath)|ConvertFrom-Json
        $earlyService=& $lifecycle -Action Status -WorkspaceRoot $runtime -RunRegistryPath $runPath -FixtureRegistry | ConvertFrom-Json
        Assert-Check ($earlyPartial.partialRemoval -and $earlyMetadata.state -ceq 'uninstall-incomplete' -and -not $earlyMetadata.installed -and -not $earlyService.serviceRunning -and -not $earlyService.autostartRegistered -and [IO.File]::Exists($panel) -and [IO.File]::Exists($program) -and [IO.File]::ReadAllText($configPath) -ceq $configBefore) 'A failure after background Disable reports partial removal and persists inactive retry metadata before any program or loader deletion.'
        Assert-Check ([IO.File]::Exists((Join-Path $earlyMetadata.recoveryBackupPath 'program/fixture-uninstall-v2/distribution.json')) -and [IO.File]::Exists((Join-Path $earlyMetadata.recoveryBackupPath 'program/fixture-uninstall-v2/tools/AeBridgeStartup.js'))) 'A complete verified recovery point exists before the first external uninstall mutation.'
        $earlyMetadata.state='uninstall-in-progress'
        [IO.File]::WriteAllText($metadataPath,($earlyMetadata|ConvertTo-Json -Depth 8))
    } finally { $env:CODEX_HOME=$codexHome;[IO.Directory]::Delete($linkedCodex) }
    $uninstalled=Invoke-UninstallFixture
    $marker=[IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
    Assert-Check ($uninstalled.state -eq 'success' -and $marker.state -ceq 'uninstalled' -and -not $marker.installed) 'A successful uninstall marks the selected portable installation inactive.'
    Assert-Check ($marker.recoveryBackupPath -ceq $earlyMetadata.recoveryBackupPath) 'An interrupted in-progress uninstall resumes under the shared lock and retains its original complete recovery chain.'
    Assert-Check (-not [IO.File]::Exists($panel) -and -not [IO.File]::Exists($previousPanel) -and -not [IO.File]::Exists($extraPanel)) 'Exact installed URI-style and legacy Windows-path loaders across AE and retained runtime versions are removed.'
    Assert-Check ([IO.File]::ReadAllText($startup) -ceq $foreignStartup -and $uninstalled.warnings.Count -gt 0) 'A modified or foreign loader is preserved with a visible warning.'
    Assert-Check ($uninstalled.programFilesRemoved.Count -gt 60 -and -not [IO.File]::Exists($program) -and -not [IO.File]::Exists((Join-Path $runtime 'tools/Codex AE Background.exe')) -and -not [IO.File]::Exists($activeManifestPath)) 'Verified manifest-owned program files and the certified generated executable are actually removed.'
    Assert-Check ((Get-FileHash -LiteralPath $modified -Algorithm SHA256).Hash -ceq $modifiedHash -and $uninstalled.preservedModifiedProgramFiles -contains $modified) 'A modified program file is retained and listed explicitly.'
    Assert-Check ([IO.File]::ReadAllText($userData) -ceq 'USER-DATA-MUST-STAY' -and [IO.File]::ReadAllText($userMedia) -ceq 'USER-DATA-MUST-STAY' -and [IO.File]::ReadAllText($sfxConfig) -ceq $sfxBefore) 'User settings, project/media data and unlisted runtime content are never deleted.'
    $configAfter=[IO.File]::ReadAllText($configPath)
    Assert-Check ($uninstalled.mcpRemoved -and $configAfter.StartsWith($unrelated,[StringComparison]::Ordinal) -and $configAfter.Substring($unrelated.Length).Trim().Length -eq 0) 'Only the exact local ae_functions MCP entry is removed; unrelated multiline TOML content remains byte-identical.'
    $afterService=& $lifecycle -Action Status -WorkspaceRoot $runtime -RunRegistryPath $runPath -FixtureRegistry | ConvertFrom-Json
    Assert-Check (-not $afterService.serviceRunning -and -not $afterService.autostartRegistered -and (Get-ItemPropertyValue -LiteralPath $runPath -Name 'UnrelatedStartup') -ceq 'leave this value') 'Uninstall drains the owned resident, removes only its startup value, and preserves unrelated startup registrations.'
    Assert-Check ([IO.File]::Exists((Join-Path $uninstalled.backupPath 'program/fixture-uninstall-v2/distribution.json')) -and [IO.File]::Exists((Join-Path $uninstalled.backupPath 'program/fixture-uninstall-v2/tools/Get-AeFunctions.ps1'))) 'Static program files have verified recovery backups before deletion.'
    Assert-Check ([IO.File]::Exists($uninstalled.logPath) -and [IO.File]::ReadAllText($uninstalled.logPath) -match 'Đã gỡ Codex AE') 'Progress and completion are persisted in the requested local log.'
    $again=Invoke-UninstallFixture
    Assert-Check ($again.alreadyUninstalled -and $again.state -eq 'success' -and [IO.File]::ReadAllText($startup) -ceq $foreignStartup) 'Repeated uninstall is idempotent and does not revisit foreign or user data.'

    $foreign=Invoke-InstallFixture 'fixture-foreign-config'
    $foreignConfig=$unrelated+[Environment]::NewLine+@'
[mcp_servers.ae_functions]
command = "C:/other/node.exe"
args = ["C:/other/tools/AeFunctionsMcp.js"]
cwd = "C:/other"
'@
    [IO.File]::WriteAllText($configPath,$foreignConfig)
    $lockedTemplate=Join-Path $foreign.runtimeRoot 'tools/AeBridgeStartup.js'
    $templateLease=[IO.File]::Open($lockedTemplate,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $partial=Invoke-UninstallFixture -ExpectedExit 1
        $partialMetadata=[IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
        Assert-Check ($partial.partialRemoval -and $partial.programFilesRemoved.Count -gt 0 -and $partialMetadata.state -ceq 'uninstall-incomplete' -and [IO.File]::Exists($lockedTemplate)) 'A locked program file produces an explicit partial error with inactive retry metadata instead of false success.'
    } finally { $templateLease.Dispose() }
    $foreignResult=Invoke-UninstallFixture
    Assert-Check (-not $foreignResult.mcpRemoved -and [IO.File]::ReadAllText($configPath) -ceq $foreignConfig -and $foreignResult.warnings.Count -gt 0) 'An MCP entry rebound to another runtime is preserved byte for byte.'
    Assert-Check (-not [IO.File]::Exists((Join-Path $foreign.runtimeRoot 'jsx/Codex Bridge.jsx'))) 'A foreign MCP warning does not prevent removing this installation own static files.'
    Assert-Check ($foreignResult.state -eq 'success' -and -not [IO.File]::Exists($lockedTemplate)) 'Retry uses verified recovery templates and finishes a partially removed installation without replaying AE jobs.'
    Assert-Check ($null -eq $realConfigHash -or (Get-FileHash -LiteralPath $realConfig -Algorithm SHA256).Hash -ceq $realConfigHash) 'The real Codex configuration remains unchanged throughout isolated tests.'
    $result=[pscustomobject]@{state='success';count=$checks.Count;checks=$checks.ToArray();fixtureRoot=$fixture;realInstallationUninstalled=$false;realAeModified=$false}
    [IO.File]::WriteAllText((Join-Path $reportRoot 'result.json'),($result | ConvertTo-Json -Depth 6))
    $result | ConvertTo-Json -Depth 6
} finally {
    $env:CODEX_HOME=$savedCodexHome
    if (Test-Path -LiteralPath $runPath) {
        $key=Get-Item -LiteralPath $runPath
        foreach ($name in $key.GetValueNames()) { Remove-ItemProperty -LiteralPath $runPath -Name $name }
        Remove-Item -LiteralPath $runPath
    }
}
