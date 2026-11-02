#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AE_Codex'),
    [ValidatePattern('^(\d+\.\d+)?$')][string]$VersionFolder,
    [ValidateSet('Enable','Disable','Preserve')][string]$SfxChoice = 'Preserve',
    [string[]]$SoundRoots = @(),
    [switch]$SkipMcpRegistration,
    [switch]$SkipBackgroundService,
    [string]$AppDataRoot = ([Environment]::GetFolderPath('ApplicationData')),
    [string]$LogPath,
    [string]$ResultPath,
    [string]$RequestPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$payloadRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installLock = $null
$stagingRoot = $null
$rollback = [Collections.Generic.List[object]]::new()
$committed = $false

function Write-SetupProgress([string]$Message) {
    $line = '{0} {1}' -f [DateTime]::Now.ToString('HH:mm:ss'), $Message
    [Console]::Error.WriteLine($line)
    if ($LogPath) { [IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $utf8) }
}
function Write-AtomicText([string]$Path, [string]$Text) {
    $parent = [IO.Path]::GetDirectoryName($Path)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
    try { [IO.File]::WriteAllText($temporary, $Text, $utf8); [IO.File]::Move($temporary, $Path, $true) }
    finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Linked paths are not supported during installation: $cursor"
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Test-IsChild([string]$Child, [string]$Parent) {
    return [IO.Path]::GetFullPath($Child).StartsWith([IO.Path]::GetFullPath($Parent).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Get-ManifestFile([string]$Root, [string]$RelativePath) {
    if (-not $RelativePath -or $RelativePath.Contains('\') -or $RelativePath -match '(^|/)\.{1,2}(/|$)' -or
        $RelativePath -match '[:\x00-\x1f]' -or [IO.Path]::IsPathRooted($RelativePath)) { throw "Unsafe package path: $RelativePath" }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    if (-not (Test-IsChild $full $Root)) { throw "Package path escaped its root: $RelativePath" }
    Assert-PlainPath $full
    return $full
}
function Confirm-Payload([object]$Manifest, [string]$Root) {
    $seen = @{}
    foreach ($file in $Manifest.files) {
        if ($seen.ContainsKey([string]$file.path)) { throw "Duplicate package path: $($file.path)" }
        $seen[[string]$file.path] = $true
        if ([string]$file.sha256 -cnotmatch '^[0-9a-f]{64}$' -or [long]$file.bytes -lt 0) { throw 'Invalid package checksum or byte count.' }
        $path = Get-ManifestFile $Root ([string]$file.path)
        if (-not [IO.File]::Exists($path)) { throw "Package file is missing: $($file.path)" }
        if ((Get-Item -LiteralPath $path).Length -ne [long]$file.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine [string]$file.sha256) {
            throw "Package verification failed: $($file.path). Extract a fresh copy of the package."
        }
    }
    foreach ($required in @('jsx/Codex Bridge.jsx','tools/AeBridgePanel.js','tools/AeBridgeStartup.js','tools/Validate-AeBridgeInstallation.ps1','tools/Build-AeScriptBundle.js','tools/AeFunctionsMcp.js','tools/Install-AeFunctionsMcp.ps1','tools/AeCodexConfig.js','tools/Initialize-AeLibrary.ps1','tools/AeBackgroundLauncher.cs','tools/AeBackgroundServiceLifecycle.ps1','.ae-codex/functions/catalog.json','.ae-codex/functions/capabilities.json','source/scripts.json','source/script-inventory.json')) {
        if (-not $seen.ContainsKey($required)) { throw "Package manifest is incomplete: $required" }
    }
}
function Get-AeVersionFolders {
    $versions = @{}
    $settings = Join-Path $AppDataRoot 'Adobe/After Effects'
    if (Test-Path -LiteralPath $settings -PathType Container) {
        foreach ($directory in Get-ChildItem -LiteralPath $settings -Directory) { if ($directory.Name -match '^\d+\.\d+$') { $versions[$directory.Name] = $true } }
    }
    foreach ($programRoot in @($env:ProgramW6432, $env:ProgramFiles) | Where-Object { $_ } | Select-Object -Unique) {
        $adobeRoot = Join-Path $programRoot 'Adobe'
        if (-not (Test-Path -LiteralPath $adobeRoot -PathType Container)) { continue }
        foreach ($directory in Get-ChildItem -LiteralPath $adobeRoot -Directory -Filter '*After Effects*') {
            $executable = Join-Path $directory.FullName 'Support Files/AfterFX.exe'
            if (Test-Path -LiteralPath $executable -PathType Leaf) {
                $versionText = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable).ProductVersion
                if ($versionText -match '^(\d+\.\d+)') { $versions[$Matches[1]] = $true }
            }
        }
    }
    return @($versions.Keys | Sort-Object { [version]$_ } -Descending)
}
function Assert-BridgeIdle([string]$Root) {
    if (-not $Root -or -not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    $chatStatePath = Join-Path $Root '.ae-codex/chat/state.json'
    Assert-PlainPath $chatStatePath
    if ([IO.File]::Exists($chatStatePath)) {
        $chatState = [IO.File]::ReadAllText($chatStatePath) | ConvertFrom-Json -ErrorAction Stop
        if ($chatState.schema -cne 'codex-ae-chat-state/v1') { throw 'Cannot verify Codex chat state before updating. Stop chat and reconnect before retrying.' }
        if ($null -ne $chatState.PSObject.Properties['error'] -and $null -ne $chatState.error -and
            $null -ne $chatState.error.PSObject.Properties['code'] -and $chatState.error.code -ceq 'TURN_STATE_UNKNOWN') {
            throw 'The Codex chat result is unconfirmed. Inspect the conversation in Codex before updating; no request was replayed.'
        }
        if ($chatState.busy -or @($chatState.pendingRequests).Count -gt 0) { throw 'Codex chat is still working or waiting for your reply. Stop or finish it before updating.' }
    }
    foreach ($relative in @('.ae-codex/bridge/submit.lock','.ae-codex/active.lock')) {
        if (Test-Path -LiteralPath (Join-Path $Root $relative)) { throw "An AE job may still be active in $Root. Complete or resolve that job before updating; its lock was preserved." }
    }
    $results = Join-Path $Root '.ae-codex/bridge/results'
    if (Test-Path -LiteralPath $results -PathType Container) {
        foreach ($started in Get-ChildItem -LiteralPath $results -Filter 'started-*.json' -File) {
            $terminal = Join-Path $results ($started.Name -replace '^started-', 'status-')
            if (-not (Test-Path -LiteralPath $terminal -PathType Leaf)) { throw "An AE job has no terminal result: $($started.Name). Verify completion before updating; no job was replayed." }
        }
    }
}
function Save-RollbackFile([string]$Path) {
    $rollback.Add([pscustomobject]@{ path=$Path; existed=[IO.File]::Exists($Path); bytes=$(if ([IO.File]::Exists($Path)) { [IO.File]::ReadAllBytes($Path) } else { $null }) })
}
function Get-LoaderText([string]$TemplatePath, [string]$BundlePath) {
    $template = [IO.File]::ReadAllText($TemplatePath, $utf8)
    if ([regex]::Matches($template, '__CODEX_AE_WORKSPACE_BUNDLE__').Count -ne 1) { throw "Invalid loader template: $TemplatePath" }
    # ExtendScript's File.exists is reliable with URI-style separators on Windows.
    # Keep the loader portable while retaining the canonical Windows path in metadata.
    $jsxPath = ([IO.Path]::GetFullPath($BundlePath)).Replace('\', '/')
    return $template.Replace('__CODEX_AE_WORKSPACE_BUNDLE__', (ConvertTo-Json -InputObject $jsxPath -Compress -EscapeHandling EscapeNonAscii))
}

try {
    if ($RequestPath) {
        $request = [IO.File]::ReadAllText([IO.Path]::GetFullPath($RequestPath)) | ConvertFrom-Json
        if ($request.schema -cne 'codex-ae-install-request/v1') { throw 'Unsupported setup request.' }
        foreach ($property in $request.PSObject.Properties.Name) {
            if ($property -notin @('schema','InstallRoot','VersionFolder','SfxChoice','SoundRoots','SkipMcpRegistration','SkipBackgroundService','AppDataRoot','LogPath','ResultPath')) { throw "Unknown setup request setting: $property" }
        }
        foreach ($property in @('InstallRoot','VersionFolder','SfxChoice','SoundRoots','AppDataRoot','LogPath','ResultPath')) {
            if ($null -ne $request.PSObject.Properties[$property]) { Set-Variable -Name $property -Value $request.$property }
        }
        if ($null -ne $request.PSObject.Properties['SkipMcpRegistration']) { $SkipMcpRegistration = [bool]$request.SkipMcpRegistration }
        if ($null -ne $request.PSObject.Properties['SkipBackgroundService']) { $SkipBackgroundService = [bool]$request.SkipBackgroundService }
    }
    if ($SfxChoice -notin @('Enable','Disable','Preserve')) { throw 'Choose Enable, Disable, or Preserve for sound indexing.' }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\','/')
    $AppDataRoot = [IO.Path]::GetFullPath($AppDataRoot)
    if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\','/') -or (Test-IsChild $InstallRoot $payloadRoot) -or (Test-IsChild $payloadRoot $InstallRoot) -or $InstallRoot -ieq $payloadRoot) { throw 'Choose an installation folder separate from the extracted package and source.' }
    $sourceAncestor = $InstallRoot
    while ($sourceAncestor) {
        if (Test-Path -LiteralPath (Join-Path $sourceAncestor '.git')) { throw 'The installation folder is inside a source checkout. Choose a separate folder.' }
        $sourceParent = [IO.Directory]::GetParent($sourceAncestor)
        if ($null -eq $sourceParent) { break }
        $sourceAncestor = $sourceParent.FullName
    }
    Assert-PlainPath $InstallRoot
    Assert-PlainPath $AppDataRoot
    $manifestPath = Join-Path $payloadRoot 'distribution.json'
    Assert-PlainPath $manifestPath
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.schema -cne 'codex-ae-distribution/v1' -or [string]$manifest.packageId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$' -or @($manifest.files).Count -lt 1) { throw 'Invalid distribution manifest.' }
    Confirm-Payload $manifest $payloadRoot
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) { throw 'Node.js 20 or newer is required. Install Node.js LTS, reopen setup, then retry.' }
    $nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'20.0') { throw 'Node.js 20 or newer is required. Install Node.js LTS, reopen setup, then retry.' }
    $pwshPath = (Get-Process -Id $PID).Path
    if ([IO.Path]::GetFileName($pwshPath) -ine 'pwsh.exe') { throw 'Run installation with PowerShell 7 (pwsh.exe).' }
    if (-not $VersionFolder) {
        $detected = @(Get-AeVersionFolders)
        if (-not $detected.Count) { throw 'After Effects was not detected. Install/open AE once, or select its numeric version (for example 26.5) in setup.' }
        $VersionFolder = $detected[0]
    }
    if ($VersionFolder -notmatch '^\d+\.\d+$') { throw 'After Effects version must use its numeric preference version, for example 26.5.' }
    $normalizedSoundRoots = @()
    if ($SfxChoice -eq 'Enable') {
        foreach ($soundRoot in @($SoundRoots)) {
            if ([string]::IsNullOrWhiteSpace($soundRoot)) { continue }
            $folder = [IO.Path]::GetFullPath($soundRoot)
            if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw "Sound folder does not exist: $folder" }
            Assert-PlainPath $folder
            $normalizedSoundRoots += $folder
        }
        $normalizedSoundRoots = @($normalizedSoundRoots | Select-Object -Unique)
        if (-not $normalizedSoundRoots.Count) { throw 'Choose at least one sound folder, or choose Skip.' }
    }
    $metadataPath = Join-Path $InstallRoot 'installation.json'
    $previous = $null
    if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
        $previous = [IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
        if ($previous.schema -cne 'codex-ae-installation/v1' -or -not (Test-IsChild $previous.runtimeRoot (Join-Path $InstallRoot 'versions'))) { throw 'Existing installation metadata is invalid; choose a separate installation folder.' }
        Assert-PlainPath $previous.runtimeRoot
        Assert-BridgeIdle $previous.runtimeRoot
    }
    $versionsRoot = Join-Path $InstallRoot 'versions'
    $runtimeRoot = Join-Path $versionsRoot $manifest.packageId
    Assert-PlainPath $runtimeRoot
    Assert-BridgeIdle $runtimeRoot
    $scriptsRoot = Join-Path $AppDataRoot "Adobe/After Effects/$VersionFolder/Scripts"
    $panelPath = Join-Path $scriptsRoot 'ScriptUI Panels/Codex Bridge.jsx'
    $startupPath = Join-Path $scriptsRoot 'Startup/Codex Bridge Startup.jsx'
    Assert-PlainPath $panelPath
    Assert-PlainPath $startupPath
    [IO.Directory]::CreateDirectory((Join-Path $InstallRoot '.ae-codex/setup')) | Out-Null
    if (-not $LogPath) { $LogPath = Join-Path $InstallRoot ".ae-codex/setup/install-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')).log" }
    $LogPath = [IO.Path]::GetFullPath($LogPath)
    Assert-PlainPath $LogPath
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($LogPath)) | Out-Null
    $lockPath = Join-Path $InstallRoot '.ae-codex/setup/install.lock'
    try { $installLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another setup process is active. Wait for it to finish before retrying.' }
    Write-SetupProgress 'Package checksums verified. Preparing the separate user installation.'
    [IO.Directory]::CreateDirectory($versionsRoot) | Out-Null
    if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
        Confirm-Payload $manifest $runtimeRoot
        Write-SetupProgress 'This runtime version is already installed; preserving its working data.'
    } else {
        $stagingRoot = Join-Path $versionsRoot ('.stage-' + [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
        foreach ($file in $manifest.files) {
            $source = Get-ManifestFile $payloadRoot ([string]$file.path)
            $destination = Get-ManifestFile $stagingRoot ([string]$file.path)
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.File]::Copy($source, $destination, $false)
        }
        [IO.File]::Copy($manifestPath, (Join-Path $stagingRoot 'distribution.json'), $false)
        Confirm-Payload $manifest $stagingRoot
        [IO.Directory]::Move($stagingRoot, $runtimeRoot)
        $stagingRoot = $null
        Write-SetupProgress ('Installed runtime {0}. Prior versions remain available.' -f $manifest.version)
    }
    $libraryRoot = Join-Path $runtimeRoot '.ae-codex/library'
    [IO.Directory]::CreateDirectory($libraryRoot) | Out-Null
    $configPath = Join-Path $libraryRoot 'config.json'
    $onboardingPath = Join-Path $libraryRoot 'onboarding.json'
    $runtimePath = Join-Path $libraryRoot 'runtime.json'
    foreach ($filePath in @($configPath,$onboardingPath,$runtimePath,$panelPath,$startupPath,$metadataPath)) { Save-RollbackFile $filePath }
    if ($previous -and $previous.runtimeRoot -ine $runtimeRoot) {
        foreach ($name in @('config.json','onboarding.json')) {
            $oldPath = Join-Path $previous.runtimeRoot ".ae-codex/library/$name"
            $newPath = Join-Path $libraryRoot $name
            if (-not [IO.File]::Exists($newPath) -and [IO.File]::Exists($oldPath)) { Assert-PlainPath $oldPath; [IO.File]::Copy($oldPath, $newPath, $false) }
        }
    }
    $initializerArguments = @{SfxChoice=$SfxChoice;SkipScan=$true}
    if ($SfxChoice -eq 'Enable') { $initializerArguments.Roots = $normalizedSoundRoots }
    $initializedLibrary = & (Join-Path $runtimeRoot 'tools/Initialize-AeLibrary.ps1') @initializerArguments | ConvertFrom-Json
    if ($initializedLibrary.state -cne 'success') { throw 'Library preferences initialization failed.' }
    if ($SfxChoice -ne 'Preserve' -or -not [IO.File]::Exists($onboardingPath)) {
        Write-AtomicText $onboardingPath (([ordered]@{schemaVersion=1;soundIndexing=$(if($initializedLibrary.sfxEnabled){'enabled'}else{'declined'});choiceAt=[DateTime]::UtcNow.ToString('o')}) | ConvertTo-Json)
    }
    Write-SetupProgress 'Checking the installed bundle once; no AE project scripts are executed.'
    $validation = & (Join-Path $runtimeRoot 'tools/Validate-AeBridgeInstallation.ps1') -WorkspaceRoot $runtimeRoot | ConvertFrom-Json
    if ($validation.state -cne 'success') { throw 'Installed bundle validation failed.' }
    $bundlePath = Join-Path $runtimeRoot 'jsx/Codex Bridge.jsx'
    $panelText = Get-LoaderText (Join-Path $runtimeRoot 'tools/AeBridgePanel.js') $bundlePath
    $startupText = Get-LoaderText (Join-Path $runtimeRoot 'tools/AeBridgeStartup.js') $bundlePath
    $backupRoot = Join-Path $InstallRoot ('.ae-codex/setup/backups/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    foreach ($existingPath in @($panelPath,$startupPath)) {
        if ([IO.File]::Exists($existingPath)) { [IO.Directory]::CreateDirectory($backupRoot) | Out-Null; [IO.File]::Copy($existingPath, (Join-Path $backupRoot ([IO.Path]::GetFileName($existingPath))), $false) }
    }
    Write-AtomicText $panelPath $panelText
    Write-AtomicText $startupPath $startupText
    Write-SetupProgress ('AE {0}: panel and automatic startup loader installed in the user profile.' -f $VersionFolder)
    $mcpState = 'pending'
    $mcpConfigPath = $null
    $mcpRegistrationMethod = $null
    $warnings = [Collections.Generic.List[string]]::new()
    if ($SkipMcpRegistration) { $mcpState = 'skipped' }
    else {
        try {
            Write-SetupProgress 'Linking tools to this Windows user''s Codex configuration. Codex CLI is not required.'
            $registration = & (Join-Path $runtimeRoot 'tools/Install-AeFunctionsMcp.ps1') | ConvertFrom-Json
            if ($registration.state -cne 'success' -or -not $registration.registered) { throw 'Codex configuration was not registered.' }
            $mcpState = 'configured'
            $mcpConfigPath = $registration.configPath
            $mcpRegistrationMethod = $registration.registrationMethod
            Write-SetupProgress ('Codex target: ' + $mcpConfigPath)
            if ($null -ne $registration.PSObject.Properties['enabled'] -and -not $registration.enabled) {
                $mcpState = 'disabled'
                $warnings.Add('The existing Codex setting disables ae_functions. Its choice was preserved; enable this server in Codex MCP settings when you want to use it.')
            } else {
                Write-SetupProgress 'Tools configured for Codex on this computer. Reload MCP or restart Codex once after setup.'
            }
        } catch { $warnings.Add('AE installed; Codex registration is pending: ' + $_.Exception.Message) }
    }
    $metadata = [ordered]@{schema='codex-ae-installation/v1';packageId=$manifest.packageId;version=$manifest.version;runtimeRoot=$runtimeRoot;versionFolder=$VersionFolder;panelPath=$panelPath;startupPath=$startupPath;installedAt=[DateTime]::UtcNow.ToString('o');mcpState=$mcpState;mcpConfigPath=$mcpConfigPath;mcpRegistrationMethod=$mcpRegistrationMethod;codexReloadRequired=($mcpState -eq 'configured');soundIndexing=[bool]$initializedLibrary.sfxEnabled;previousRuntimeRoot=$(if($previous){$previous.runtimeRoot}else{$null})}
    Write-AtomicText $metadataPath ($metadata | ConvertTo-Json -Depth 5)
    $committed = $true
    $backgroundState = 'skipped'
    $backgroundAutostartRegistered = $false
    $realAppDataRoot = [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData')).TrimEnd('\','/')
    # Fixture installs with redirected AE settings must never start a resident
    # process or edit this user's actual sign-in registry settings.
    if (-not $SkipBackgroundService -and $AppDataRoot.TrimEnd('\','/') -ieq $realAppDataRoot) {
        try {
            Write-SetupProgress 'Starting the fixed background helper and registering current-user sign-in startup.'
            $background = & (Join-Path $runtimeRoot 'tools/AeBackgroundServiceLifecycle.ps1') -Action Enable | ConvertFrom-Json
            $backgroundState = $background.serviceState
            $backgroundAutostartRegistered = [bool]$background.autostartRegistered
            if ($previous -and $previous.runtimeRoot -ine $runtimeRoot) {
                try {
                    $retired = & (Join-Path $runtimeRoot 'tools/AeBackgroundServiceLifecycle.ps1') -Action Disable -WorkspaceRoot $previous.runtimeRoot | ConvertFrom-Json
                    Write-SetupProgress 'The prior runtime background startup entry was removed; its files were retained.'
                } catch { $warnings.Add('The new background helper is ready; prior runtime cleanup is pending: ' + $_.Exception.Message) }
            }
        } catch { $backgroundState = 'pending'; $warnings.Add('Background sound updates need repair: ' + $_.Exception.Message) }
    } elseif (-not $SkipBackgroundService) { $backgroundState = 'skipped-fixture' }
    $metadata.backgroundServiceState = $backgroundState
    $metadata.backgroundAutostartRegistered = $backgroundAutostartRegistered
    Write-AtomicText $metadataPath ($metadata | ConvertTo-Json -Depth 5)
    Write-SetupProgress 'Use the Effects and SFX scan buttons in the AE panel when you want to update their catalogs.'
    if ($SfxChoice -eq 'Enable') {
        Write-SetupProgress 'Indexing sound metadata in the selected folders. No audio files are copied or imported.'
        try {
            $soundOutput = & (Join-Path $runtimeRoot 'tools/Update-AeSfxCatalog.ps1') -Roots $normalizedSoundRoots | ConvertFrom-Json
            if ($soundOutput.state -cne 'success') {
                $soundError = if ($null -ne $soundOutput.PSObject.Properties['error']) { [string]$soundOutput.error } else { 'The sound scanner did not return success.' }
                throw $soundError
            }
            Write-SetupProgress ('Sound metadata indexing completed: {0} audio files.' -f $soundOutput.count)
        } catch { $warnings.Add('Installation completed; sound indexing reported: ' + $_.Exception.Message) }
    } else { Write-SetupProgress 'Sound folder preference preserved or skipped.' }
    # Retire old runtime versions now that the new one is active. Never fatal: busy or still-referenced
    # versions are deferred to the next install; each removed version is archived to retired-data first.
    $versionCleanup = $null
    try {
        $cleanupScript = Join-Path $runtimeRoot 'tools/Remove-AeOldVersions.ps1'
        if (Test-Path -LiteralPath $cleanupScript) {
            $cleanupArgs = @{InstallRoot=$InstallRoot}
            if ($AppDataRoot.TrimEnd('\','/') -ine $realAppDataRoot) { $cleanupArgs.Fixture = $true }
            $versionCleanup = (& $cleanupScript @cleanupArgs | Out-String) | ConvertFrom-Json
            if (@($versionCleanup.removed).Count) { Write-SetupProgress ('Removed old versions (archived in retired-data): ' + (@($versionCleanup.removed) -join ', ')) }
            foreach ($item in @($versionCleanup.deferred)) { $warnings.Add('Old version ' + $item.version + ' kept for now: ' + $item.reason) }
        }
    } catch { $warnings.Add('Old version cleanup skipped: ' + $_.Exception.Message) }
    foreach ($warning in $warnings) { Write-SetupProgress ('NOTICE: ' + $warning) }
    $result = [ordered]@{schema='codex-ae-install-result/v1';state='success';versionCleanup=$versionCleanup;runtimeRoot=$runtimeRoot;installationPath=$metadataPath;version=$manifest.version;versionFolder=$VersionFolder;toolCount=$manifest.toolCount;mcpState=$mcpState;mcpConfigPath=$mcpConfigPath;mcpRegistrationMethod=$mcpRegistrationMethod;codexReloadRequired=($mcpState -eq 'configured');codexSessionVerified=$false;effectsState='pending-manual-scan';backgroundServiceState=$backgroundState;backgroundAutostartRegistered=$backgroundAutostartRegistered;soundIndexing=[bool]$initializedLibrary.sfxEnabled;warnings=@($warnings);logPath=$LogPath;nextStep='Reload MCP or restart Codex once to load ae_functions on this computer. Open Window > Codex Bridge in AE and click the Effects or SFX scan button when you want a fresh catalog. If requested by AE, enable Allow Scripts to Write Files and Access Network.'}
    Write-SetupProgress 'Installation completed.'
    if ($ResultPath) { Write-AtomicText ([IO.Path]::GetFullPath($ResultPath)) ($result | ConvertTo-Json -Depth 5) }
    $result | ConvertTo-Json -Depth 5
} catch {
    $failure = $_.Exception.Message
    if (-not $committed) {
        for ($index=$rollback.Count-1; $index -ge 0; $index--) {
            $entry = $rollback[$index]
            try {
                if ($entry.existed) { [IO.File]::WriteAllBytes($entry.path, $entry.bytes) }
                elseif ([IO.File]::Exists($entry.path)) { [IO.File]::Delete($entry.path) }
            } catch { $failure += " Rollback needs attention: $($entry.path)." }
        }
    }
    try { Write-SetupProgress ('ERROR: ' + $failure) } catch { [Console]::Error.WriteLine($failure) }
    $result = [ordered]@{schema='codex-ae-install-result/v1';state='error';error=$failure;logPath=$LogPath}
    if ($ResultPath) { try { Write-AtomicText ([IO.Path]::GetFullPath($ResultPath)) ($result | ConvertTo-Json -Depth 4) } catch {} }
    $result | ConvertTo-Json -Depth 4
    exit 1
} finally {
    if ($null -ne $installLock) { $installLock.Dispose() }
    if ($stagingRoot -and (Test-IsChild $stagingRoot (Join-Path $InstallRoot 'versions')) -and [IO.Path]::GetFileName($stagingRoot).StartsWith('.stage-')) {
        Assert-PlainPath $stagingRoot
        if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
    }
}
