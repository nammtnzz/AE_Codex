#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Enable','Disable','Status')][string]$Action = 'Status',
    [string]$WorkspaceRoot = ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))),
    [string]$RunRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    [switch]$FixtureRegistry,
    [ValidateRange(1,60)][int]$StopTimeoutSeconds = 20
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\','/')
$libraryRoot = Join-Path $WorkspaceRoot '.ae-codex/library'
$servicePath = Join-Path $libraryRoot 'background-service.json'
$stopPath = Join-Path $libraryRoot 'background-service.stop'
$launcherPath = Join-Path $WorkspaceRoot 'tools/Codex AE Background.exe'
$runCommand = '"' + $launcherPath + '" --serve'
$identityBytes = [Text.Encoding]::UTF8.GetBytes($WorkspaceRoot.ToLowerInvariant())
$runName = 'CodexAE.Background.' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($identityBytes)).Substring(0,20).ToLowerInvariant()
$normalRunPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($RunRegistryPath -ine $normalRunPath) {
    if (-not $FixtureRegistry -or $RunRegistryPath -notmatch '^HKCU:\\Software\\CodexAE\\Tests\\[A-Za-z0-9-]+\\Run$') {
        throw 'A test Run registry path requires -FixtureRegistry and an isolated HKCU:\Software\CodexAE\Tests\<id>\Run key.'
    }
}
function Assert-OrdinaryServicePath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked service paths are not supported: $cursor" }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Read-ServiceState {
    if (-not [IO.File]::Exists($servicePath)) { return $null }
    Assert-OrdinaryServicePath $servicePath
    $stream = $null
    $reader = $null
    try {
        # Heartbeats are atomically replaced. Keep a deletion-shared handle so
        # reading one complete revision does not race a status publication.
        $stream = [IO.File]::Open($servicePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($stream.Length -gt 65536) { throw 'The background service status is too large.' }
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
        $service = $reader.ReadToEnd() | ConvertFrom-Json
    } catch [IO.FileNotFoundException] { return $null }
    finally { if ($null -ne $reader) { $reader.Dispose() } elseif ($null -ne $stream) { $stream.Dispose() } }
    if ($service.schemaVersion -ne 1 -or [IO.Path]::GetFullPath([string]$service.workspaceRoot).TrimEnd('\','/') -ine $WorkspaceRoot) { throw 'Background service status belongs to a different workspace.' }
    return $service
}
function Test-ServiceProcess($Service) {
    if ($null -eq $Service -or $null -eq $Service.PSObject.Properties['processId']) { return $false }
    $serviceProcess = Get-Process -Id ([int]$Service.processId) -ErrorAction SilentlyContinue
    if ($null -eq $serviceProcess) { return $false }
    try { return [IO.Path]::GetFullPath($serviceProcess.Path) -ieq $launcherPath } catch { return $false }
}
function Get-OwnedRunValue {
    if (-not (Test-Path -LiteralPath $RunRegistryPath)) { return $null }
    $item = Get-Item -LiteralPath $RunRegistryPath
    return $item.GetValue($runName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}
foreach ($path in @($WorkspaceRoot,$libraryRoot,$launcherPath,$servicePath,$stopPath)) { Assert-OrdinaryServicePath $path }
$changed = $false
$service = Read-ServiceState
if ($Action -eq 'Enable') {
    $existingValue = Get-OwnedRunValue
    if ($null -ne $existingValue -and [string]$existingValue -cne $runCommand) { throw 'The existing background startup entry is not owned by this runtime; it was preserved.' }
    $initializer = Join-Path $WorkspaceRoot 'tools/Initialize-AeLibrary.ps1'
    Assert-OrdinaryServicePath $initializer
    if (-not [IO.File]::Exists($initializer)) { throw 'The background initializer is missing. Repair Codex AE from its installer.' }
    $initialized = & $initializer -SkipScan -StartBackgroundService | ConvertFrom-Json
    if ($initialized.state -cne 'success') { throw 'The background helper could not be started.' }
    $service = Read-ServiceState
    if ($null -eq $service -or $service.state -cne 'ready' -or -not (Test-ServiceProcess $service)) { throw 'The background helper did not publish a ready status for this workspace.' }
    if ($null -eq $existingValue) {
        # New-Item -Force can replace an existing registry key and its values.
        # Create only a missing key; never recreate the user's shared Run key.
        if (-not (Test-Path -LiteralPath $RunRegistryPath)) { New-Item -Path $RunRegistryPath -Force | Out-Null }
        New-ItemProperty -LiteralPath $RunRegistryPath -Name $runName -PropertyType String -Value $runCommand -Force | Out-Null
        $changed = $true
    }
} elseif ($Action -eq 'Disable') {
    $existingValue = Get-OwnedRunValue
    if ($null -ne $existingValue -and [string]$existingValue -ceq $runCommand) {
        Remove-ItemProperty -LiteralPath $RunRegistryPath -Name $runName
        $changed = $true
    } elseif ($null -ne $existingValue) { throw 'The existing background startup entry is not owned by this runtime; it was preserved.' }
    if (Test-ServiceProcess $service) {
        [IO.Directory]::CreateDirectory($libraryRoot) | Out-Null
        [IO.File]::WriteAllText($stopPath, [DateTime]::UtcNow.ToString('o'), [Text.UTF8Encoding]::new($false))
        $deadline = [DateTime]::UtcNow.AddSeconds($StopTimeoutSeconds)
        do {
            Start-Sleep -Milliseconds 150
            $service = Read-ServiceState
            if ($null -eq $service -or -not (Test-ServiceProcess $service)) { break }
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($null -ne $service -and (Test-ServiceProcess $service)) { throw 'The background helper is finishing an inventory worker. Its stop request was preserved; no process was killed.' }
    }
    # The resident may have crashed while its owned Node child is still alive.
    # The initializer validates PID, creation time, workspace and fixed Node
    # executable before requesting that orphan's graceful shutdown. A live
    # child keeps this operation incomplete so update/uninstall cannot delete
    # its program files. This path never compiles, scans or starts a process.
    $initializer = Join-Path $WorkspaceRoot 'tools/Initialize-AeLibrary.ps1'
    Assert-OrdinaryServicePath $initializer
    if ([IO.File]::Exists($initializer)) {
        $chatDrain = & $initializer -StopBackgroundService | ConvertFrom-Json
        if (-not $chatDrain.backgroundServiceStopped) { throw 'The Codex chat host has not stopped; its files were preserved.' }
    }
}
$registered = (Get-OwnedRunValue) -ceq $runCommand
[ordered]@{
    schema = 'codex-ae-background-lifecycle/v1'; state = 'success'; action = $Action
    workspaceRoot = $WorkspaceRoot; autostartRegistered = [bool]$registered; autostartChanged = $changed
    registryPath = $RunRegistryPath; registryName = $runName; launcherPath = $launcherPath
    serviceState = $(if($service){$service.state}else{'absent'})
    serviceRunning = [bool](Test-ServiceProcess $service)
    nextStep = 'The fixed helper starts at current-user sign-in. AE submits data files only. Disable removes only this runtime startup entry and requests a graceful stop.'
} | ConvertTo-Json -Depth 5
