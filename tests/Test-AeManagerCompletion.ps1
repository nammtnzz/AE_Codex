#Requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path $workspace ('.ae-codex/tests/manager-completion-'+[guid]::NewGuid().ToString('N'))
$managerPath=Join-Path $workspace 'tools/Manage-AeInstallation.ps1'
$utf8=[Text.UTF8Encoding]::new($false)
$checks=New-Object 'Collections.Generic.List[string]'
function Assert-Check([bool]$Condition,[string]$Message){if(-not $Condition){throw ('FAILED: '+$Message)};$checks.Add($Message)}
function Write-FixtureJson([string]$Path,$Value){[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))|Out-Null;[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 10),$utf8)}
try{
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($managerPath,[ref]$tokens,[ref]$errors)
    Assert-Check ($errors.Count-eq 0) 'Manager parses in the launcher host without running UI or installer code.'
    foreach($name in @('Get-ManagerStateText','ConvertTo-ManagerMessage','Get-ManagerProperty','Read-ManagerJson','Read-ManagerProgressLog','Test-ManagerOwnedInstallation','Get-ManagerCompletion','Get-ManagerUninstallCompletion','Get-ManagerCountdownState','Get-ManagerUninstallAction','Write-ManagerCompletionReport','Invoke-ManagerAutoCloseTick','Refresh-InstalledStatus')){
        $definition=$ast.Find({param($node)$node-is [Management.Automation.Language.FunctionDefinitionAst]-and $node.Name-ceq $name},$true)
        if($null-eq $definition){throw ('Missing manager helper: '+$name)}
        . ([scriptblock]::Create($definition.Extent.Text))
    }
    $installRoot=Join-Path $fixture 'Máy mới/CodexAE'
    $runtimeRoot=Join-Path $installRoot 'versions/fixture-v1'
    $outputRoot=Join-Path $installRoot '.ae-codex/setup/manager-fixture'
    $metadataPath=Join-Path $installRoot 'installation.json'
    $resultPath=Join-Path $outputRoot 'result.json'
    $panelPath=Join-Path $fixture 'AppData/ScriptUI Panels/Codex Bridge.jsx'
    $startupPath=Join-Path $fixture 'AppData/Startup/Codex Bridge Startup.jsx'
    $bundlePath=Join-Path $runtimeRoot 'jsx/Codex Bridge.jsx'
    foreach($path in @($bundlePath,$panelPath,$startupPath)){[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null;[IO.File]::WriteAllText($path,'// inert fixture; never evaluated',$utf8)}
    [IO.Directory]::CreateDirectory($outputRoot)|Out-Null
    $logPath=Join-Path $outputRoot 'progress.log'
    $writer=[IO.File]::Open($logPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{
        $logText='Đang xử lý trên máy mới.'
        $logBytes=$utf8.GetBytes($logText);$writer.Write($logBytes,0,$logBytes.Length);$writer.Flush()
        Assert-Check ((Read-ManagerProgressLog $logPath)-ceq $logText) 'Live progress remains readable while the backend retains a shared write handle.'
    }finally{$writer.Dispose()}
    $writer=[IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{Assert-Check ($null-eq (Read-ManagerProgressLog $logPath)) 'Transient log sharing conflicts defer only the log read without reporting false installation failures.'}finally{$writer.Dispose()}
    $session=[pscustomobject]@{operation='install';outputRoot=$outputRoot;installRoot=$installRoot;packageId='fixture-v1';version='1.0.5';versionFolder='26.5';toolCount=42;startedUtc=[DateTime]::UtcNow.AddSeconds(-1)}
    function Reset-InstallFixture {
        $script:fixtureMetadata=[pscustomobject]@{schema='codex-ae-installation/v1';packageId='fixture-v1';version='1.0.5';versionFolder='26.5';runtimeRoot=$runtimeRoot;panelPath=$panelPath;startupPath=$startupPath;installedAt=[DateTime]::UtcNow.ToString('o');mcpState='configured';backgroundServiceState='ready';backgroundAutostartRegistered=$true}
        $script:fixtureResult=[pscustomobject]@{schema='codex-ae-install-result/v1';state='success';installationPath=$metadataPath;runtimeRoot=$runtimeRoot;version='1.0.5';versionFolder='26.5';toolCount=42;mcpState='configured';backgroundServiceState='ready';backgroundAutostartRegistered=$true;warnings=@()}
        Write-FixtureJson $metadataPath $script:fixtureMetadata
        Write-FixtureJson $resultPath $script:fixtureResult
    }
    Reset-InstallFixture
    $valid=Get-ManagerCompletion 0 $resultPath $session
    Assert-Check ($valid.confirmed-and $valid.autoClose-and $valid.message-ceq 'Bạn đã cài đặt thành công!') 'Exit zero with fresh matching runtime, metadata and loaders confirms installation success.'
    $serializedSession=$session|ConvertTo-Json|ConvertFrom-Json
    Assert-Check ((Get-ManagerCompletion 0 $resultPath $serializedSession).confirmed) 'A serialized UTC session timestamp is normalized before comparing UTC installation files.'
    $reportPath=Write-ManagerCompletionReport $valid $session
    $report=[IO.File]::ReadAllText($reportPath)|ConvertFrom-Json
    Assert-Check ($report.state-eq 'success'-and $report.confirmed-and $report.autoClose-and $report.operation-eq 'install') 'A concrete completion report is saved before the UI may show success and schedule closing.'
    $now=[DateTime]::UtcNow;$closeAt=$now.AddSeconds(3)
    $before=Get-ManagerCountdownState $true $false $closeAt $now
    $after=Get-ManagerCountdownState $true $false $closeAt $now.AddSeconds(3)
    Assert-Check ($before.secondsLeft-eq 3-and -not $before.shouldClose-and $after.shouldClose) 'A confirmed success remains visible for three seconds before automatic closing.'
    $running=Get-ManagerCountdownState $true $true $now.AddSeconds(-1) $now
    $cancelled=Get-ManagerCountdownState $false $false $now.AddSeconds(-1) $now
    Assert-Check ($running.cancelManualClose-and -not $running.shouldClose-and -not $cancelled.shouldClose) 'An active backend blocks closing; cancellation or unconfirmed completion never arms automatic closing.'
    $liveStatus=[pscustomobject]@{Text=''}
    $form=[pscustomobject]@{Closed=$false}
    $form|Add-Member -MemberType ScriptMethod -Name Close -Value {$this.Closed=$true}
    $script:completionConfirmed=$true;$script:successCloseAt=[DateTime]::UtcNow.AddSeconds(-1);$script:setupProcess=[pscustomobject]@{fixtureBackendRunning=$true}
    Invoke-ManagerAutoCloseTick
    Assert-Check (-not $form.Closed) 'The actual countdown callback cannot close the manager while a backend reference is active.'
    $script:setupProcess=$null;Invoke-ManagerAutoCloseTick
    Assert-Check $form.Closed 'The actual countdown callback closes the manager after confirmed success and backend completion.'
    $form.Closed=$false;$script:completionConfirmed=$false;Invoke-ManagerAutoCloseTick
    Assert-Check (-not $form.Closed) 'A cancelled or unconfirmed completion prevents the actual close callback.'
    foreach($exitCode in @(1,17)){
        $failed=Get-ManagerCompletion $exitCode $resultPath $session
        Assert-Check (-not $failed.confirmed-and -not $failed.autoClose) ('A stale success JSON cannot override backend exit code '+$exitCode+'.')
    }
    [IO.File]::Delete($resultPath)
    Assert-Check (-not (Get-ManagerCompletion 0 $resultPath $session).autoClose) 'A missing terminal result keeps the window open.'
    Reset-InstallFixture
    [IO.File]::WriteAllText($resultPath,'{ malformed JSON',$utf8)
    Assert-Check (-not (Get-ManagerCompletion 0 $resultPath $session).autoClose) 'A malformed terminal result keeps the window open.'
    Reset-InstallFixture
    [IO.File]::SetLastWriteTimeUtc($resultPath,$session.startedUtc.AddMinutes(-1))
    Assert-Check (-not (Get-ManagerCompletion 0 $resultPath $session).autoClose) 'An older result file cannot complete the current session.'
    Reset-InstallFixture
    $script:fixtureMetadata.installedAt=$session.startedUtc.AddMinutes(-1).ToString('o');Write-FixtureJson $metadataPath $script:fixtureMetadata
    Assert-Check (-not (Get-ManagerCompletion 0 $resultPath $session).autoClose) 'Metadata from a previous installation cannot confirm the current run.'
    Reset-InstallFixture
    $foreignPath=Join-Path $fixture 'foreign-result.json';Write-FixtureJson $foreignPath $script:fixtureResult
    Assert-Check (-not (Get-ManagerCompletion 0 $foreignPath $session).autoClose) 'A result outside the current unique manager session is rejected.'
    Reset-InstallFixture
    $script:fixtureMetadata.packageId='another-version';Write-FixtureJson $metadataPath $script:fixtureMetadata
    Assert-Check (-not (Get-ManagerCompletion 0 $resultPath $session).autoClose) 'A mismatched installed package cannot trigger the success banner.'
    Reset-InstallFixture
    [IO.File]::Delete($bundlePath)
    Assert-Check (-not (Get-ManagerCompletion 0 $resultPath $session).autoClose) 'Missing installed runtime content prevents a success claim.'
    [IO.File]::WriteAllText($bundlePath,'// inert fixture',$utf8)
    foreach($setting in @('warnings','mcpState','backgroundServiceState','backgroundAutostartRegistered')){
        Reset-InstallFixture
        switch($setting){warnings{$script:fixtureResult.warnings=@('Synthetic warning')}mcpState{$script:fixtureResult.mcpState='pending'}backgroundServiceState{$script:fixtureResult.backgroundServiceState='pending'}backgroundAutostartRegistered{$script:fixtureResult.backgroundAutostartRegistered=$false}}
        Write-FixtureJson $resultPath $script:fixtureResult
        $partial=Get-ManagerCompletion 0 $resultPath $session
        Assert-Check ($partial.state-eq 'attention'-and -not $partial.autoClose) ('Partial installation ('+$setting+') leaves its warning and log visible.')
    }
    Reset-InstallFixture
    $script:fixtureResult.state='cancelled';$script:fixtureResult|Add-Member -NotePropertyName error -NotePropertyValue 'Đã hủy phiên cài đặt.';Write-FixtureJson $resultPath $script:fixtureResult
    Assert-Check (-not (Get-ManagerCompletion 0 $resultPath $session).autoClose) 'A cancelled backend result never reports successful installation or closes automatically.'
    Reset-InstallFixture
    Assert-Check ((Test-ManagerOwnedInstallation $script:fixtureMetadata $installRoot)-and -not (Test-ManagerOwnedInstallation $script:fixtureMetadata (Join-Path $fixture 'OtherInstall'))) 'The uninstall action is available only for metadata bound to the selected installation root.'
    Assert-Check ((Get-ManagerUninstallAction $false $true $false)-eq 'confirm'-and (Get-ManagerUninstallAction $true $true $false)-eq 'start'-and (Get-ManagerUninstallAction $true $true $true)-eq 'none'-and (Get-ManagerUninstallAction $false $false $false)-eq 'none') 'Uninstall requires a second confirmation click and cannot start during an existing operation or for an unowned root.'
    Assert-Check ((Get-ManagerUninstallAction $false $true $false)-ne 'start') 'Cancelling inline uninstall confirmation returns to the first click without invoking any backend.'
    $uninstallSession=[pscustomobject]@{operation='uninstall';outputRoot=$outputRoot;installRoot=$installRoot;runtimeRoot=$runtimeRoot;packageId='fixture-v1';startedUtc=$session.startedUtc}
    $script:fixtureMetadata|Add-Member -NotePropertyName state -NotePropertyValue 'uninstalled'
    $script:fixtureMetadata|Add-Member -NotePropertyName installed -NotePropertyValue $false
    $script:fixtureMetadata|Add-Member -NotePropertyName uninstalledAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o'))
    Write-FixtureJson $metadataPath $script:fixtureMetadata
    $uninstalled=[pscustomobject]@{schema='codex-ae-uninstall-result/v1';state='success';installRoot=$installRoot;runtimeRoot=$runtimeRoot;warnings=@();retainedRuntimeData=$true}
    Write-FixtureJson $resultPath $uninstalled
    $uninstallSuccess=Get-ManagerUninstallCompletion 0 $resultPath $uninstallSession
    Assert-Check ($uninstallSuccess.confirmed-and $uninstallSuccess.autoClose-and $uninstallSuccess.message-ceq 'Bạn đã gỡ cài đặt thành công!'-and -not (Test-ManagerOwnedInstallation $script:fixtureMetadata $installRoot)) 'Fresh successful uninstall metadata produces its own success banner and disables further uninstall.'
    $serializedUninstallSession=$uninstallSession|ConvertTo-Json|ConvertFrom-Json
    Assert-Check ((Get-ManagerUninstallCompletion 0 $resultPath $serializedUninstallSession).confirmed) 'A serialized UTC session timestamp also validates fresh uninstall results.'
    $script:fixtureMetadata.state='uninstall-incomplete'
    Assert-Check (Test-ManagerOwnedInstallation $script:fixtureMetadata $installRoot) 'An incomplete uninstall remains owned and available for a safe explicit retry.'
    $installPathBox=[pscustomobject]@{Text=$installRoot}
    $installedStatus=[pscustomobject]@{Text=''}
    $uninstallButton=[pscustomobject]@{Enabled=$false}
    foreach($unfinishedState in @('uninstall-incomplete','uninstall-in-progress')){
        $script:fixtureMetadata.state=$unfinishedState;Write-FixtureJson $metadataPath $script:fixtureMetadata
        Refresh-InstalledStatus
        Assert-Check ($script:ownedInstallation-and $uninstallButton.Enabled-and $installedStatus.Text-ceq 'Gỡ cài đặt chưa hoàn tất tại thư mục này') ('The actual status refresh exposes explicit recovery instead of claiming success for '+$unfinishedState+'.')
        Assert-Check (-not (Get-ManagerUninstallCompletion 0 $resultPath $uninstallSession).autoClose) ('A success result cannot close the manager while metadata remains '+$unfinishedState+'.')
    }
    $script:fixtureMetadata.state='uninstalled'
    $script:fixtureMetadata.uninstalledAt=$session.startedUtc.AddMinutes(-1).ToString('o');Write-FixtureJson $metadataPath $script:fixtureMetadata
    Assert-Check (-not (Get-ManagerUninstallCompletion 0 $resultPath $uninstallSession).autoClose) 'An earlier uninstall marker cannot complete a new uninstall session.'
    $script:fixtureMetadata.uninstalledAt=[DateTime]::UtcNow.ToString('o');Write-FixtureJson $metadataPath $script:fixtureMetadata
    $uninstalled.warnings=@('Synthetic retained owned configuration warning');Write-FixtureJson $resultPath $uninstalled
    Assert-Check (-not (Get-ManagerUninstallCompletion 0 $resultPath $uninstallSession).autoClose) 'Uninstall warnings remain visible instead of closing the window.'
    $localized=ConvertTo-ManagerMessage "10:10:01 Installed runtime 1.0.5. Prior versions remain available.`r`n10:10:02 NOTICE: AE installed; Codex registration is pending: fixture-only error`r`n10:10:03 ERROR: Sound folder does not exist: D:\Fixture SFX"
    Assert-Check ($localized.Contains('Đã cài phiên bản 1.0.5')-and $localized.Contains('chưa liên kết được Codex')-and $localized.Contains('fixture-only error')-and $localized.Contains('D:\Fixture SFX')) 'Known streamed status/error text is Vietnamese while technical exception evidence and paths are preserved.'
    $managerBytes=[IO.File]::ReadAllBytes($managerPath)
    Assert-Check ($managerBytes.Length-gt 3-and $managerBytes[0]-eq 239-and $managerBytes[1]-eq 187-and $managerBytes[2]-eq 191) 'The UI source carries UTF-8 BOM so Windows PowerShell 5.1 preserves Vietnamese diacritics.'
    [ordered]@{state='success';checks=$checks.Count;messages=$checks.ToArray();installerDispatched=$false;uninstallerDispatched=$false;realConfigModified=$false;realAeModified=$false}|ConvertTo-Json -Depth 5
}finally{
    $resolved=[IO.Path]::GetFullPath($fixture)
    $allowed=[IO.Path]::GetFullPath((Join-Path $workspace '.ae-codex/tests'))+[IO.Path]::DirectorySeparatorChar
    if(-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected fixture cleanup path.'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
