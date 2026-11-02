#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureRoot = Join-Path $workspace ('.ae-codex/tests-library-setup/' + [guid]::NewGuid().ToString('N') + '/Máy mới portable')
$fixtureTools = Join-Path $fixtureRoot 'tools'
$library = Join-Path $fixtureRoot '.ae-codex/library'
[void][IO.Directory]::CreateDirectory($fixtureTools)
foreach ($name in @('Initialize-AeLibrary.ps1', 'AeBackgroundLauncher.cs', 'Update-AeSfxCatalog.ps1')) {
    Copy-Item -LiteralPath (Join-Path $workspace "tools/$name") -Destination (Join-Path $fixtureTools $name)
}
$initializer = Join-Path $fixtureTools 'Initialize-AeLibrary.ps1'
$pwshPath = (Get-Process -Id $PID).Path
$checks = [Collections.Generic.List[string]]::new()
function Assert-Check {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAILED: $Message" }
    $checks.Add($Message)
}
function Initialize-Fixture {
    param([string[]]$Arguments = @(), [int]$ExpectedExit = 0)
    $output = @(& $pwshPath -NoProfile -File $initializer @Arguments 2>&1)
    if ($LASTEXITCODE -ne $ExpectedExit) { throw "Unexpected initializer exit $LASTEXITCODE. $($output -join ' ')" }
    if ($ExpectedExit -ne 0) { return ($output -join "`n") }
    return (($output -join "`n") | ConvertFrom-Json -ErrorAction Stop)
}
$initial = Initialize-Fixture -Arguments @('-SkipScan')
$configPath = Join-Path $library 'config.json'
$config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
$runtime = [IO.File]::ReadAllText((Join-Path $library 'runtime.json')) | ConvertFrom-Json
Assert-Check ($initial.state -eq 'success' -and $initial.scanSkipped -and $initial.sfxEnabled -eq $false) 'A new installation initializes its runtime without an audio scan or implicit consent.'
Assert-Check ($config.sfx.enabled -eq $false -and $config.sfx.roots.Count -eq 0) 'New settings contain no developer folders or home-directory defaults.'
Assert-Check ($config.refreshMode -ceq 'manual' -and $config.effects.enabled -and $initial.refreshMode -ceq 'manual' -and $initial.effectsEnabled) 'New installations enable Effects for manual use and disable all recurring library refresh.'
Assert-Check ($runtime.powerShellPath -ceq $pwshPath) 'PowerShell is discovered from this machine independently of indexing.'
Assert-Check ((Test-Path -LiteralPath $runtime.backgroundLauncherPath -PathType Leaf) -and $runtime.backgroundLauncherPath -ceq (Join-Path $fixtureTools 'Codex AE Background.exe')) 'Installation compiles and records the local hidden helper without running it.'
Assert-Check (-not (Test-Path -LiteralPath (Join-Path $library 'sessions'))) 'SkipScan creates no catalog session.'

$audioRoot = Join-Path $fixtureRoot 'My sounds'
[void][IO.Directory]::CreateDirectory($audioRoot)
[IO.File]::WriteAllBytes((Join-Path $audioRoot 'fixture.wav'), [byte[]](1, 2, 3))
$enabled = Initialize-Fixture -Arguments @('-SfxChoice', 'Enable', '-Roots', $audioRoot, '-SkipScan')
$config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
Assert-Check ($enabled.sfxEnabled -and $config.sfx.enabled -and $config.sfx.roots.Count -eq 1 -and $config.sfx.roots[0] -ceq $audioRoot) 'Explicit consent stores only the selected SFX folder, including spaces and Unicode in a portable workspace.'
Assert-Check (-not (Test-Path -LiteralPath (Join-Path $library 'sessions'))) 'Installation can store consent while leaving the first scan to the live bridge.'
$configText = [IO.File]::ReadAllText($configPath)
$preserved = Initialize-Fixture -Arguments @('-SkipScan')
Assert-Check ($preserved.sfxEnabled -and [IO.File]::ReadAllText($configPath) -ceq $configText) 'Updating the runtime preserves the existing enabled settings byte for byte.'
$scanned = Initialize-Fixture
Assert-Check ($scanned.state -eq 'success' -and $scanned.enabled -and $scanned.count -eq 1) 'An enabled initialization indexes the chosen folder when a scan is requested.'

$disabled = Initialize-Fixture -Arguments @('-SfxChoice', 'Disable', '-SkipScan')
$config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
Assert-Check ($disabled.sfxEnabled -eq $false -and $config.sfx.enabled -eq $false -and $config.sfx.roots[0] -ceq $audioRoot) 'Opting out stores the decision and preserves folder preferences for a later explicit opt-in.'
$skipped = Initialize-Fixture
Assert-Check ($skipped.state -eq 'success' -and $skipped.skipped -and $skipped.count -eq 0) 'Routine initialization keeps an opted-out machine disabled.'
$config.sfx.PSObject.Properties.Remove('enabled')
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8))
$legacyText = [IO.File]::ReadAllText($configPath)
$legacy = Initialize-Fixture -Arguments @('-SkipScan')
Assert-Check ($legacy.sfxEnabled -and [IO.File]::ReadAllText($configPath) -ceq $legacyText) 'An older configured installation without an enabled flag remains enabled without rewriting preferences.'

$badDrive = Initialize-Fixture -Arguments @('-SfxChoice', 'Enable', '-Roots', [IO.Path]::GetPathRoot($audioRoot), '-SkipScan') -ExpectedExit 1
Assert-Check ($badDrive -match 'drive or share root' -and [IO.File]::ReadAllText($configPath) -ceq $legacyText) 'Rejected whole-drive indexing does not change an existing preference.'
$badChoice = Initialize-Fixture -Arguments @('-Roots', $audioRoot, '-SkipScan') -ExpectedExit 1
Assert-Check ($badChoice -match 'requires.*Enable') 'Folder changes require an explicit Enable choice.'
$emptyEnable = Initialize-Fixture -Arguments @('-SfxChoice', 'Enable', '-Roots', '', '-SkipScan') -ExpectedExit 1
Assert-Check ($emptyEnable -match 'nonempty absolute') 'An empty folder selection cannot silently enable a broad search.'

# Runtime updates preserve old interval fields, explicit Effects/SFX choices,
# roots and unrelated settings. The effective mode remains manual regardless.
$oldConfiguration = [pscustomobject]@{
    schemaVersion = 1
    refreshMode = 'automatic'
    refreshIntervalSeconds = 120
    effects = [pscustomobject]@{enabled=$false;customMarker='keep-effects'}
    sfx = [pscustomobject]@{enabled=$true;roots=@($audioRoot);extensions=@('.wav');customMarker='keep-sfx'}
    unrelated = [pscustomobject]@{fixture='preserve'}
}
[IO.File]::WriteAllText($configPath, ($oldConfiguration | ConvertTo-Json -Depth 8))
$oldText = [IO.File]::ReadAllText($configPath)
$old = Initialize-Fixture -Arguments @('-SkipScan')
Assert-Check ($old.refreshMode -ceq 'manual' -and -not $old.effectsEnabled -and $old.sfxEnabled -and [IO.File]::ReadAllText($configPath) -ceq $oldText) 'Preserve keeps legacy interval/mode, disabled Effects, enabled SFX, roots and unrelated fields byte-identical while reporting manual operation.'
$explicitDisable = Initialize-Fixture -Arguments @('-SfxChoice','Disable','-SkipScan')
$changed = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
Assert-Check (-not $explicitDisable.sfxEnabled -and -not $changed.effects.enabled -and $changed.effects.customMarker -ceq 'keep-effects' -and $changed.sfx.roots[0] -ceq $audioRoot -and $changed.sfx.customMarker -ceq 'keep-sfx' -and $changed.unrelated.fixture -ceq 'preserve' -and $changed.refreshIntervalSeconds -eq 120) 'An explicit SFX change preserves Effects choices, roots and unrelated legacy preferences.'
foreach ($invalidEnabled in @('false', 0, $null)) {
    $invalid = [pscustomobject]@{schemaVersion=1;effects=[pscustomobject]@{enabled=$invalidEnabled};sfx=[pscustomobject]@{enabled=$false;roots=@()}}
    [IO.File]::WriteAllText($configPath, ($invalid | ConvertTo-Json -Depth 8))
    $invalidText = [IO.File]::ReadAllText($configPath)
    $runtimeBeforeInvalid = [IO.File]::ReadAllText((Join-Path $library 'runtime.json'))
    $badEffects = Initialize-Fixture -Arguments @('-SfxChoice','Enable','-Roots',$audioRoot,'-SkipScan') -ExpectedExit 1
    Assert-Check ($badEffects -match 'effects.enabled must be a boolean' -and [IO.File]::ReadAllText($configPath) -ceq $invalidText -and [IO.File]::ReadAllText((Join-Path $library 'runtime.json')) -ceq $runtimeBeforeInvalid) 'Invalid Effects enabled values are rejected before preferences or runtime certificates change.'
}
foreach ($invalidEffects in @('false', @(), $null)) {
    $invalid = [pscustomobject]@{schemaVersion=1;effects=$invalidEffects;sfx=[pscustomobject]@{enabled=$false;roots=@()}}
    [IO.File]::WriteAllText($configPath, ($invalid | ConvertTo-Json -Depth 8))
    $invalidText = [IO.File]::ReadAllText($configPath)
    $badEffectsObject = Initialize-Fixture -Arguments @('-SkipScan') -ExpectedExit 1
    Assert-Check ($badEffectsObject -match 'effects must be an object' -and [IO.File]::ReadAllText($configPath) -ceq $invalidText) 'A malformed Effects section fails without rewriting the original configuration.'
}
$minimalConfig = '{"schemaVersion":1,"effects":{},"unrelated":"keep-minimal"}'
[IO.File]::WriteAllText($configPath, $minimalConfig)
$minimal = Initialize-Fixture -Arguments @('-SkipScan')
Assert-Check ($minimal.effectsEnabled -and -not $minimal.sfxEnabled -and $minimal.refreshMode -ceq 'manual' -and [IO.File]::ReadAllText($configPath) -ceq $minimalConfig) 'Missing Effects enabled defaults to true and a missing SFX section defaults off without rewriting a pre-existing configuration.'
$sessionFilesBefore = @(Get-ChildItem -LiteralPath (Join-Path $library 'sessions') -Recurse -File).Count
$minimalNoScan = Initialize-Fixture
$sessionFilesAfter = @(Get-ChildItem -LiteralPath (Join-Path $library 'sessions') -Recurse -File).Count
Assert-Check ($minimalNoScan.scanSkipped -and $minimalNoScan.skipped -and $minimalNoScan.count -eq 0 -and $sessionFilesAfter -eq $sessionFilesBefore -and [IO.File]::ReadAllText($configPath) -ceq $minimalConfig) 'An off or missing SFX section skips the scanner entirely, including ordinary initialization without SkipScan.'
$missingEffectsConfig = '{"schemaVersion":1,"sfx":{"enabled":false,"roots":[]}}'
[IO.File]::WriteAllText($configPath, $missingEffectsConfig)
$missingEffects = Initialize-Fixture -Arguments @('-SkipScan')
Assert-Check ($missingEffects.effectsEnabled -and -not $missingEffects.sfxEnabled -and [IO.File]::ReadAllText($configPath) -ceq $missingEffectsConfig) 'An older configuration with no Effects section retains the default-on choice without migration.'
$result = [pscustomobject]@{ state = 'success'; count = $checks.Count; checks = $checks.ToArray(); fixtureRoot = $fixtureRoot }
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'test-result.json'), ($result | ConvertTo-Json -Depth 5))
$result | ConvertTo-Json -Depth 5
