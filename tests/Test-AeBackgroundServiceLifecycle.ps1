#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testId = [guid]::NewGuid().ToString('N')
$fixture = Join-Path ([IO.Path]::GetTempPath()) "CodexAE-lifecycle-$testId/Máy mới & 100% O'Brien"
$tools = Join-Path $fixture 'tools'
$registryRoot = "HKCU:\Software\CodexAE\Tests\$testId"
$registryPath = Join-Path $registryRoot 'Run'
$reportRoot = Join-Path $workspace ".ae-codex/tests-background-lifecycle/$testId"
$checks = [Collections.Generic.List[string]]::new()
$script = Join-Path $tools 'AeBackgroundServiceLifecycle.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
function Assert-Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAILED: $Message" }; $checks.Add($Message) }
function Invoke-Lifecycle([string]$Action) {
    return (& $script -Action $Action -RunRegistryPath $registryPath -FixtureRegistry | ConvertFrom-Json)
}
try {
    [IO.Directory]::CreateDirectory($tools) | Out-Null
    [IO.Directory]::CreateDirectory($reportRoot) | Out-Null
    foreach ($name in @('AeBackgroundServiceLifecycle.ps1','Initialize-AeLibrary.ps1','AeBackgroundLauncher.cs')) {
        Copy-Item -LiteralPath (Join-Path $workspace "tools/$name") -Destination (Join-Path $tools $name)
    }
    [IO.File]::WriteAllText((Join-Path $tools 'Update-AeSfxCatalog.ps1'), 'throw "No lifecycle fixture may start a sound scanner."', $utf8)
    New-Item -Path $registryPath -Force | Out-Null
    New-ItemProperty -LiteralPath $registryPath -Name 'Unrelated fixture' -Value 'preserve & 100%' -PropertyType String | Out-Null
    $enabled = Invoke-Lifecycle 'Enable'
    Assert-Check ($enabled.state -eq 'success' -and $enabled.autostartRegistered -and $enabled.serviceRunning -and $enabled.serviceState -eq 'ready') 'Explicit setup activation starts the fixed resident helper and registers only its fixture startup entry.'
    $value = (Get-Item -LiteralPath $registryPath).GetValue($enabled.registryName)
    Assert-Check ($value -ceq ('"' + (Join-Path $tools 'Codex AE Background.exe') + '" --serve')) 'Startup executes only the fixed GUI helper with --serve; Unicode, spaces and shell metacharacters are literal paths.'
    Assert-Check ((Get-Item -LiteralPath $registryPath).GetValue('Unrelated fixture') -ceq 'preserve & 100%') 'Activation preserves unrelated current-user startup entries.'
    $servicePath = Join-Path $fixture '.ae-codex/library/background-service.json'
    $before = [IO.File]::ReadAllText($servicePath) | ConvertFrom-Json
    $again = Invoke-Lifecycle 'Enable'
    $after = [IO.File]::ReadAllText($servicePath) | ConvertFrom-Json
    Assert-Check (-not $again.autostartChanged -and $before.processId -eq $after.processId) 'Repeated setup reuses the ready helper and owned startup registration.'
    $status = Invoke-Lifecycle 'Status'
    Assert-Check ($status.serviceRunning -and -not $status.autostartChanged) 'Status reports the current helper without changing startup registration.'
    Assert-Check (-not (Test-Path -LiteralPath (Join-Path $fixture '.ae-codex/library/sessions'))) 'A resident helper never scans sound without a fresh AE request.'
    $rejected = $false
    try { & $script -Action Status -RunRegistryPath $registryPath | Out-Null } catch { $rejected = $true }
    Assert-Check $rejected 'A custom registry location requires explicit fixture mode.'
    Set-ItemProperty -LiteralPath $registryPath -Name $enabled.registryName -Value 'unowned fixture command'
    $rejected = $false
    try { Invoke-Lifecycle 'Disable' | Out-Null } catch { $rejected = $true }
    Assert-Check ($rejected -and (Get-Item -LiteralPath $registryPath).GetValue($enabled.registryName) -ceq 'unowned fixture command') 'Cleanup refuses an entry whose command is no longer owned by this runtime.'
    Set-ItemProperty -LiteralPath $registryPath -Name $enabled.registryName -Value $value
    $disabled = Invoke-Lifecycle 'Disable'
    Assert-Check (-not $disabled.autostartRegistered -and -not $disabled.serviceRunning -and $disabled.autostartChanged) 'Cleanup removes its exact startup entry and stops the idle helper gracefully without killing a process.'
    Assert-Check ((Get-Item -LiteralPath $registryPath).GetValue('Unrelated fixture') -ceq 'preserve & 100%') 'Cleanup preserves all unrelated startup entries.'
    $disabledAgain = Invoke-Lifecycle 'Disable'
    Assert-Check (-not $disabledAgain.autostartChanged -and -not $disabledAgain.serviceRunning) 'Repeated cleanup is idempotent.'
    $result = [ordered]@{state='success';count=$checks.Count;checks=$checks.ToArray();actualRunRegistryModified=$false;realAeModified=$false;realInventoryScanned=$false}
    [IO.File]::WriteAllText((Join-Path $reportRoot 'result.json'), ($result | ConvertTo-Json -Depth 5), $utf8)
    $result | ConvertTo-Json -Depth 5
} finally {
    if ([IO.File]::Exists($script)) {
        try { Invoke-Lifecycle 'Disable' | Out-Null } catch {}
        try { & (Join-Path $tools 'Initialize-AeLibrary.ps1') -StopBackgroundService | Out-Null } catch {}
    }
    if ($registryRoot -notmatch '^HKCU:\\Software\\CodexAE\\Tests\\[a-f0-9]{32}$') { throw 'Unexpected fixture registry cleanup path.' }
    if (Test-Path -LiteralPath $registryRoot) { Remove-Item -LiteralPath $registryRoot -Recurse -Force }
    $resolved = [IO.Path]::GetFullPath($fixture)
    $allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar + "CodexAE-lifecycle-$testId" + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture filesystem cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
