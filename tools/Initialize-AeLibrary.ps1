#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Enable', 'Disable', 'Preserve')][string]$SfxChoice = 'Preserve',
    [string[]]$Roots,
    [switch]$SkipScan,
    [switch]$StartBackgroundService,
    [switch]$StopBackgroundService
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$libraryRoot = Join-Path $workspaceRoot '.ae-codex/library'
$powerShellPath = (Get-Process -Id $PID).Path
if ([IO.Path]::GetFileName($powerShellPath) -ne 'pwsh.exe') {
    throw 'Run this initializer with PowerShell 7 (pwsh).'
}
function Write-AtomicLibraryJson {
    param([string]$Path, $Value)
    $temporary = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $Path, $true)
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}
function Assert-OrdinaryPath {
    param([string]$Path)
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and
            (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "Symbolic links and reparse points are not permitted: $cursor"
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Test-BackgroundServiceStopped {
    $lockPath = Join-Path $libraryRoot 'background-service.lock'
    Assert-OrdinaryPath $lockPath
    if (-not [IO.File]::Exists($lockPath)) { return $true }
    try {
        $lease = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $lease.Dispose()
        return $true
    } catch [IO.IOException] { return $false }
}
function Test-ChatHostStopped {
    $chatRoot = Join-Path $workspaceRoot '.ae-codex/chat'
    $runtimePath = Join-Path $libraryRoot 'runtime.json'
    foreach ($path in @($chatRoot, $runtimePath)) { Assert-OrdinaryPath $path }
    if (-not [IO.Directory]::Exists($chatRoot)) { return $true }
    $recordedNodePath = $null
    if ([IO.File]::Exists($runtimePath)) {
        $recordedRuntime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json -ErrorAction Stop
        if ($null -ne $recordedRuntime.PSObject.Properties['nodePath']) { $recordedNodePath = [string]$recordedRuntime.nodePath }
    }
    foreach ($name in @('launch.json','host.json')) {
        $identityPath = Join-Path $chatRoot $name
        Assert-OrdinaryPath $identityPath
        if (-not [IO.File]::Exists($identityPath)) { continue }
        try {
            $identity = [IO.File]::ReadAllText($identityPath) | ConvertFrom-Json -ErrorAction Stop
            $schema = $(if ($name -eq 'launch.json') { 'codex-ae-chat-launch/v1' } else { 'codex-ae-chat-host/v1' })
            if ($identity.schema -cne $schema -or [IO.Path]::GetFullPath([string]$identity.workspaceRoot).TrimEnd('\','/') -ine $workspaceRoot.TrimEnd('\','/')) { continue }
            # Old launch records retain an exact executable identity after setup
            # removes dedicated chat runtime fields. This path only stops it.
            $legacyNodePath = $recordedNodePath
            if ($name -eq 'launch.json' -and $null -ne $identity.PSObject.Properties['nodePath']) { $legacyNodePath = [string]$identity.nodePath }
            if (-not $legacyNodePath -or -not [IO.Path]::IsPathFullyQualified($legacyNodePath) -or [IO.Path]::GetFileName($legacyNodePath) -ine 'node.exe') { continue }
            Assert-OrdinaryPath $legacyNodePath
            $chatProcess = Get-Process -Id ([int]$identity.pid) -ErrorAction SilentlyContinue
            if ($null -eq $chatProcess) { continue }
            try {
                $startedMs = ([datetimeoffset]$chatProcess.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
                $recordedStart = [long]$identity.processStartEpochMs
                $creationMatches = [math]::Abs($startedMs - $recordedStart) -le 20
                if ($name -eq 'host.json') {
                    $age = [datetimeoffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$identity.timestampEpochMs
                    $creationMatches = $recordedStart -ge $startedMs -and ($recordedStart - $startedMs) -le 60000 -and $age -ge 0 -and $age -le 15000
                }
                if ($chatProcess.Path -ieq $legacyNodePath -and $creationMatches) { return $false }
            } finally { $chatProcess.Dispose() }
        } catch [System.ArgumentException] { }
    }
    return $true
}
function Assert-LegacyChatIdle {
    $statePath = Join-Path $workspaceRoot '.ae-codex/chat/state.json'
    Assert-OrdinaryPath $statePath
    if (-not [IO.File]::Exists($statePath)) { return }
    $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json -ErrorAction Stop
    if ($state.schema -cne 'codex-ae-chat-state/v1') { throw 'Cannot verify the legacy Codex chat state before updating.' }
    if ($null -ne $state.PSObject.Properties['error'] -and $null -ne $state.error -and
        $null -ne $state.error.PSObject.Properties['code'] -and $state.error.code -ceq 'TURN_STATE_UNKNOWN') {
        throw 'The legacy Codex chat result is unconfirmed. Inspect it in Codex before updating; no request was replayed.'
    }
    if ($state.busy -or @($state.pendingRequests).Count -gt 0) { throw 'The legacy Codex chat is still active. Finish or stop it before updating.' }
}
function Stop-BackgroundLibraryService {
    $chatRoot = Join-Path $workspaceRoot '.ae-codex/chat'
    if (-not (Test-ChatHostStopped)) {
        $chatStopPath = Join-Path $chatRoot 'stop'
        Assert-OrdinaryPath $chatStopPath
        Write-AtomicLibraryJson $chatStopPath ([ordered]@{schema='codex-ae-chat-stop/v1';service=$true;createdAtEpochMs=[datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()})
    }
    if ((Test-BackgroundServiceStopped) -and (Test-ChatHostStopped)) { return }
    $stopPath = Join-Path $libraryRoot 'background-service.stop'
    Assert-OrdinaryPath $stopPath
    [IO.File]::WriteAllText($stopPath, [datetime]::UtcNow.ToString('o'), [Text.UTF8Encoding]::new($false))
    $deadline = [datetime]::UtcNow.AddSeconds(15)
    while (-not ((Test-BackgroundServiceStopped) -and (Test-ChatHostStopped))) {
        if ([datetime]::UtcNow -ge $deadline) { throw 'The AE background helper is finishing an active catalog scan or Codex chat. Wait for it to finish before updating; no process was terminated.' }
        Start-Sleep -Milliseconds 100
    }
}
function Start-BackgroundLibraryService {
    param([string]$Launcher, [string]$LauncherSha256)
    $servicePath = Join-Path $libraryRoot 'background-service.json'
    Assert-OrdinaryPath $servicePath
    $process = Start-Process -FilePath $Launcher -ArgumentList '--serve' -WindowStyle Hidden -PassThru
    try {
        $deadline = [datetime]::UtcNow.AddSeconds(10)
        while ([datetime]::UtcNow -lt $deadline) {
            if ([IO.File]::Exists($servicePath)) {
                try {
                    $service = [IO.File]::ReadAllText($servicePath) | ConvertFrom-Json -ErrorAction Stop
                    $age = [datetimeoffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$service.timestampEpochMs
                    if ($service.schemaVersion -eq 1 -and $service.state -ceq 'ready' -and
                        $service.workspaceRoot -ceq $workspaceRoot -and $service.launcherSha256 -ceq $LauncherSha256 -and
                        [int]$service.processId -gt 0 -and $age -ge 0 -and $age -lt 15000) {
                        $running = Get-Process -Id ([int]$service.processId) -ErrorAction Stop
                        try { if ($running.Path -ieq $Launcher) { return $service } } finally { $running.Dispose() }
                    }
                } catch { }
            }
            if ($process.HasExited -and $process.ExitCode -ne 0) { throw 'The AE background helper could not start. See .ae-codex/library/launcher-errors.log.' }
            Start-Sleep -Milliseconds 100
        }
        throw 'The AE background helper did not publish a ready status. See .ae-codex/library/launcher-errors.log and repair Codex AE.'
    } finally { $process.Dispose() }
}
function Initialize-BackgroundLauncher {
    # Native Windows-subsystem launcher: compile during setup/update only.
    # Setup/logon starts the resident; AE only writes named JSON requests.
    $source = Join-Path $PSScriptRoot 'AeBackgroundLauncher.cs'
    $launcher = Join-Path $PSScriptRoot 'Codex AE Background.exe'
    $certificatePath = Join-Path $libraryRoot 'background-launcher.json'
    foreach ($path in @($source, $launcher, $certificatePath)) { Assert-OrdinaryPath $path }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'The background launcher source is missing. Repair Codex AE from its installer.' }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ((Test-Path -LiteralPath $launcher -PathType Leaf) -and (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
        try {
            $certificate = [IO.File]::ReadAllText($certificatePath) | ConvertFrom-Json -ErrorAction Stop
            if ($certificate.schemaVersion -eq 1 -and $certificate.sourceSha256 -ceq $sourceHash -and
                $certificate.launcherSha256 -ceq (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant()) {
                return $launcher
            }
        } catch { }
    }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw '.NET Framework 4 C# compiler is required to install the hidden AE background helper.' }
    Stop-BackgroundLibraryService
    $temporaryLauncher = Join-Path $PSScriptRoot ('.Codex-AE-Background-' + [guid]::NewGuid().ToString('N') + '.exe')
    try {
        $compileOutput = @(& $compiler /nologo /target:winexe /optimize+ /reference:System.Web.Extensions.dll "/out:$temporaryLauncher" $source 2>&1)
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryLauncher -PathType Leaf)) {
            throw "Could not build the hidden AE background helper: $($compileOutput -join ' ')"
        }
        [IO.File]::Move($temporaryLauncher, $launcher, $true)
    } finally { if (Test-Path -LiteralPath $temporaryLauncher) { Remove-Item -LiteralPath $temporaryLauncher } }
    Write-AtomicLibraryJson $certificatePath ([ordered]@{
        schemaVersion = 1
        sourceSha256 = $sourceHash
        launcherSha256 = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant()
        subsystem = 'windows'
        builtUtc = [datetime]::UtcNow.ToString('o')
    })
    return $launcher
}
Assert-OrdinaryPath $libraryRoot
if ($StopBackgroundService -and $StartBackgroundService) { throw 'Choose StartBackgroundService or StopBackgroundService, not both.' }
if ($StopBackgroundService) {
    Stop-BackgroundLibraryService
    [pscustomobject]@{schemaVersion=1;state='success';backgroundServiceStopped=$true} | ConvertTo-Json -Compress
    return
}
Assert-LegacyChatIdle
New-Item -ItemType Directory -Force -Path $libraryRoot | Out-Null
$configPath = Join-Path $libraryRoot 'config.json'
Assert-OrdinaryPath $configPath
$configExists = Test-Path -LiteralPath $configPath -PathType Leaf
if ($configExists) {
    $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json -ErrorAction Stop
    if ($config.schemaVersion -ne 1) { throw 'Unsupported library config; expected schemaVersion 1.' }
} else {
    $config = [pscustomobject]@{
        schemaVersion = 1
        refreshMode = 'manual'
        effects = [pscustomobject]@{ enabled = $true }
        sfx = [pscustomobject]@{
            enabled = $false
            roots = @()
            extensions = @('.wav', '.mp3', '.aiff', '.aif', '.ogg', '.flac', '.m4a', '.aac')
        }
    }
}
$effectsEnabled = $true
if ($null -ne $config.PSObject.Properties['effects']) {
    if ($null -eq $config.effects -or $config.effects -isnot [pscustomobject]) { throw 'Library effects must be an object.' }
    if ($null -ne $config.effects.PSObject.Properties['enabled']) { $effectsEnabled = $config.effects.enabled }
    if ($effectsEnabled -isnot [bool]) { throw 'Library effects.enabled must be a boolean.' }
}
if ($null -eq $config.PSObject.Properties['sfx']) {
    # Missing SFX settings are disabled in memory. Preserve never rewrites an
    # existing user's document just to add new defaults or change refresh mode.
    $config | Add-Member -NotePropertyName sfx -NotePropertyValue ([pscustomobject]@{
        enabled = $false
        roots = @()
        extensions = @('.wav', '.mp3', '.aiff', '.aif', '.ogg', '.flac', '.m4a', '.aac')
    })
}
if ($null -eq $config.sfx -or $config.sfx -isnot [pscustomobject]) { throw 'Library sfx must be an object.' }
if ($PSBoundParameters.ContainsKey('Roots') -and $SfxChoice -ne 'Enable') {
    throw '-Roots requires -SfxChoice Enable.'
}
if ($SfxChoice -eq 'Enable') {
    $selectedRoots = @()
    if ($PSBoundParameters.ContainsKey('Roots')) { $selectedRoots = @($Roots) }
    elseif ($null -ne $config.sfx.PSObject.Properties['roots']) { $selectedRoots = @($config.sfx.roots) }
    if ($selectedRoots.Count -eq 0 -or $selectedRoots.Count -gt 32) { throw 'Select between 1 and 32 specific SFX folders to enable indexing.' }
    $validatedRoots = [Collections.Generic.List[string]]::new()
    $seenRoots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($selectedRoot in $selectedRoots) {
        if ($selectedRoot -isnot [string] -or [string]::IsNullOrWhiteSpace($selectedRoot) -or
            $selectedRoot.Length -gt 512 -or $selectedRoot -match '[\x00-\x1f]' -or -not [IO.Path]::IsPathFullyQualified($selectedRoot)) {
            throw 'Every SFX root must be a nonempty absolute folder path of at most 512 characters.'
        }
        $full = [IO.Path]::GetFullPath($selectedRoot).TrimEnd([char[]]'\/')
        if ($full.Equals([IO.Path]::GetPathRoot($selectedRoot).TrimEnd([char[]]'\/'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Select a specific SFX folder; scanning a drive or share root is not allowed.'
        }
        Assert-OrdinaryPath $full
        if ($seenRoots.Add($full)) { $validatedRoots.Add($full) }
    }
    $config.sfx | Add-Member -NotePropertyName roots -NotePropertyValue $validatedRoots.ToArray() -Force
    $config.sfx | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
} elseif ($SfxChoice -eq 'Disable') {
    $config.sfx | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
}
$sfxEnabled = $true
if ($null -ne $config.sfx.PSObject.Properties['enabled']) { $sfxEnabled = $config.sfx.enabled }
if ($sfxEnabled -isnot [bool]) { throw 'Library sfx.enabled must be a boolean.' }
# Updating runtime discovery must not rewrite a pre-existing user's preferences
# unless setup explicitly selected Enable or Disable.
if (-not $configExists -or $SfxChoice -ne 'Preserve') { Write-AtomicLibraryJson $configPath $config }
$backgroundLauncherPath = Initialize-BackgroundLauncher
$backgroundLauncherSha256 = (Get-FileHash -LiteralPath $backgroundLauncherPath -Algorithm SHA256).Hash.ToLowerInvariant()
$runtime = [ordered]@{
    schemaVersion=1
    powerShellPath=$powerShellPath
    backgroundLauncherPath=$backgroundLauncherPath
    backgroundLauncherSha256=$backgroundLauncherSha256
    backgroundServiceVersion=1
}
$runtimePath = Join-Path $libraryRoot 'runtime.json'
Assert-OrdinaryPath $runtimePath
Write-AtomicLibraryJson $runtimePath $runtime
$backgroundService = $null
if ($StartBackgroundService) { $backgroundService = Start-BackgroundLibraryService $backgroundLauncherPath $backgroundLauncherSha256 }
if ($SkipScan -or -not $sfxEnabled) {
    [pscustomobject]@{
        schemaVersion = 1
        state = 'success'
        sfxChoice = $SfxChoice
        sfxEnabled = $sfxEnabled
        effectsEnabled = $effectsEnabled
        refreshMode = 'manual'
        scanSkipped = $true
        enabled = $sfxEnabled
        skipped = -not $sfxEnabled
        count = 0
        configRelativePath = '.ae-codex/library/config.json'
        runtimeRelativePath = '.ae-codex/library/runtime.json'
        backgroundService = $backgroundService
    } | ConvertTo-Json -Compress
    return
}
& (Join-Path $PSScriptRoot 'Update-AeSfxCatalog.ps1')
