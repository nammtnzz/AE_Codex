#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture = Join-Path $workspace ('.ae-codex/tests-installation/' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)
foreach ($directory in @('tools', 'source', '.ae-codex')) {
    New-Item -ItemType Directory -Path (Join-Path $fixture $directory) -Force | Out-Null
}
Copy-Item -LiteralPath (Join-Path $workspace 'tools/Build-AeScriptBundle.js') -Destination (Join-Path $fixture 'tools/Build-AeScriptBundle-real.js')
Copy-Item -LiteralPath (Join-Path $workspace 'tools/AeScriptSource.js') -Destination (Join-Path $fixture 'tools/AeScriptSource.js')
Copy-Item -LiteralPath (Join-Path $workspace 'tools/AeScriptCapabilities.js') -Destination (Join-Path $fixture 'tools/AeScriptCapabilities.js')
Copy-Item -LiteralPath (Join-Path $workspace 'tools/AeCapabilities.js') -Destination (Join-Path $fixture 'tools/AeCapabilities.js')
Copy-Item -LiteralPath (Join-Path $workspace 'tools/AeFunctionsSource.js') -Destination (Join-Path $fixture 'tools/AeFunctionsSource.js')
[IO.File]::WriteAllText((Join-Path $fixture 'source/bridge.js'), 'var fixtureBridge = true;', $utf8)
[IO.File]::WriteAllText((Join-Path $fixture 'source/bundle-runtime.js'), 'var fixtureRuntime = true;', $utf8)
Copy-Item -LiteralPath (Join-Path $workspace 'source/functions-runtime.js') -Destination (Join-Path $fixture 'source/functions-runtime.js')
foreach ($moduleName in @('functions-layer-tools.js','functions-project-tools.js','functions-inspection-tools.js')) {
    Copy-Item -LiteralPath (Join-Path $workspace "source/$moduleName") -Destination (Join-Path $fixture "source/$moduleName")
}
[IO.File]::WriteAllText((Join-Path $fixture 'source/scripts.json'), '{"schema":"codex-ae-scripts/v1","branches":{"hello.jsx":"(function () { return 11; }());"}}', $utf8)
[IO.File]::WriteAllText((Join-Path $fixture 'source/script-inventory.json'), '{"names":["hello.jsx"]}', $utf8)
$buildOutput = & node (Join-Path $fixture 'tools/Build-AeScriptBundle-real.js')
if ($LASTEXITCODE -ne 0) { throw "Fixture build failed: $buildOutput" }
$wrapper = @'
const fs = require('node:fs'), path = require('node:path'), child = require('node:child_process');
fs.appendFileSync(path.join(__dirname, '../.ae-codex/verifier-count.log'), 'verify\n');
const result = child.spawnSync(process.execPath, [path.join(__dirname, 'Build-AeScriptBundle-real.js'), ...process.argv.slice(2)], {stdio: 'inherit'});
process.exit(result.status === null ? 1 : result.status);
'@
[IO.File]::WriteAllText((Join-Path $fixture 'tools/Build-AeScriptBundle.js'), $wrapper, $utf8)
$helperPath = Join-Path $workspace 'tools/Validate-AeBridgeInstallation.ps1'
$bundlePath = Join-Path $fixture 'jsx/Codex Bridge.jsx'
$certificatePath = Join-Path $fixture '.ae-codex/bundle/installed-validation.json'
$tsvPath = Join-Path $fixture '.ae-codex/bundle/installed-validation.tsv'
$countPath = Join-Path $fixture '.ae-codex/verifier-count.log'
function Get-VerificationCount { return @([IO.File]::ReadAllLines($countPath)).Length }
function Assert-True { param([bool]$Value, [string]$Message) if (-not $Value) { throw $Message } }

$first = & $helperPath -WorkspaceRoot $fixture | ConvertFrom-Json
Assert-True ($first.state -ceq 'success' -and -not $first.cached -and $first.branches -eq 1 -and $first.modules -eq 1) 'First installation did not verify its complete bundle.'
Assert-True ((Get-VerificationCount) -eq 1) 'First installation did not execute exactly one verification.'
$tsv = [IO.File]::ReadAllText($tsvPath, $utf8)
Assert-True ($tsv -cmatch '^codex-ae-install/v1\t[0-9a-f]{64}\t[1-9]\d*\t1\t1\t[0-9a-f]{64}\n$') 'Runtime certificate format is invalid.'
Assert-True ([IO.File]::ReadAllBytes($tsvPath)[0] -eq [byte][char]'c') 'Runtime certificate contains a BOM.'
$second = & $helperPath -WorkspaceRoot $fixture | ConvertFrom-Json
Assert-True ($second.cached -and (Get-VerificationCount) -eq 1) 'Unchanged installation repeated the full verification.'
$forced = & $helperPath -WorkspaceRoot $fixture -Force | ConvertFrom-Json
Assert-True (-not $forced.cached -and (Get-VerificationCount) -eq 2) 'Forced installation validation did not execute verification.'
'PASS first-install validation, exact SHA256 certificate, strict TSV, cached reopen and explicit Force'

$originalBundle = [IO.File]::ReadAllText($bundlePath, $utf8)
$priorCertificate = [IO.File]::ReadAllText($certificatePath, $utf8)
$corrupt = $originalBundle.Replace('return 11', 'return 12')
Assert-True ($corrupt -cne $originalBundle -and $corrupt.Length -eq $originalBundle.Length) 'Corruption fixture did not preserve the byte count.'
[IO.File]::WriteAllText($bundlePath, $corrupt, $utf8)
$rejected = $false
try { & $helperPath -WorkspaceRoot $fixture | Out-Null } catch { $rejected = $true }
Assert-True ($rejected -and (Get-VerificationCount) -eq 3) 'Changed SHA256 bypassed validation or corrupt payload was accepted.'
Assert-True ([IO.File]::ReadAllText($certificatePath, $utf8) -ceq $priorCertificate -and [IO.File]::ReadAllText($tsvPath, $utf8) -ceq $tsv) 'Failed validation replaced the last good certificate.'
[IO.File]::WriteAllText($bundlePath, $originalBundle, $utf8)
$restored = & $helperPath -WorkspaceRoot $fixture | ConvertFrom-Json
Assert-True ($restored.cached -and (Get-VerificationCount) -eq 3) 'Restored exact bundle did not reuse its certificate.'
'PASS equal-byte payload corruption is rejected and preserves the last successful certificate'

[IO.File]::WriteAllText($tsvPath, ($tsv.TrimEnd("`n") + "`textra`n"), $utf8)
$repaired = & $helperPath -WorkspaceRoot $fixture | ConvertFrom-Json
Assert-True (-not $repaired.cached -and (Get-VerificationCount) -eq 4 -and [IO.File]::ReadAllText($tsvPath, $utf8) -ceq $tsv) 'Malformed runtime certificate was reused or not repaired.'
[IO.File]::WriteAllText($certificatePath, '{"state":"success"}', $utf8)
$repairedJson = & $helperPath -WorkspaceRoot $fixture | ConvertFrom-Json
Assert-True (-not $repairedJson.cached -and (Get-VerificationCount) -eq 5) 'Incomplete JSON certificate was accepted.'
'PASS malformed certificates trigger verification and atomic repair without touching an AE installation'

# Load only the updater's pure loader helpers; never execute its real AppData installation body.
$parseTokens = $null
$parseErrors = $null
$updaterAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $workspace 'tools/Update-AeBridgeUserPanel.ps1'), [ref]$parseTokens, [ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) 'Updater has a PowerShell syntax error.'
foreach ($helperName in @('Assert-AeBridgeUserScriptsPath', 'Install-AeBridgeStartupLoader', 'Install-AeBridgePanelLoader')) {
    $definition = $updaterAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $helperName }, $true)
    Assert-True ($null -ne $definition) "Updater helper is missing: $helperName"
    . ([scriptblock]::Create($definition.Extent.Text))
}
$fixtureScripts = Join-Path $fixture 'user/Adobe/After Effects/26.5/Scripts'
$loaderBackups = Join-Path $fixture '.ae-codex/startup-backups'
$loaderTemplate = Join-Path $workspace 'tools/AeBridgeStartup.js'
$escapedBundle = Join-Path $fixture 'jsx/tiếng Việt ''quoted'' $bundle.jsx'
$loader = Install-AeBridgeStartupLoader -ScriptsRoot $fixtureScripts -BundlePath $escapedBundle -TemplatePath $loaderTemplate -BackupRoot $loaderBackups
Assert-True ($loader.updated -and $null -eq $loader.backupPath -and (Test-Path -LiteralPath $loader.path -PathType Leaf)) 'First user Startup loader installation failed.'
$loaderText = [IO.File]::ReadAllText($loader.path, $utf8)
$expectedLiteral = ConvertTo-Json -InputObject (([IO.Path]::GetFullPath($escapedBundle)).Replace('\', '/')) -Compress -EscapeHandling EscapeNonAscii
Assert-True ($loaderText.Contains("resolveBundle($expectedLiteral)") -and -not $loaderText.Contains('__CODEX_AE_WORKSPACE_BUNDLE__')) 'Startup loader did not safely encode its workspace path.'
Assert-True ((Get-FileHash -LiteralPath $loader.path -Algorithm SHA256).Hash -ceq $loader.sha256) 'Installed Startup loader hash does not match.'
$unchangedLoader = Install-AeBridgeStartupLoader -ScriptsRoot $fixtureScripts -BundlePath $escapedBundle -TemplatePath $loaderTemplate -BackupRoot $loaderBackups
Assert-True (-not $unchangedLoader.updated -and $null -eq $unchangedLoader.backupPath) 'Unchanged Startup loader was needlessly replaced.'
$oldLoaderText = '/* prior startup loader */'
[IO.File]::WriteAllText($loader.path, $oldLoaderText, $utf8)
$replacedLoader = Install-AeBridgeStartupLoader -ScriptsRoot $fixtureScripts -BundlePath $escapedBundle -TemplatePath $loaderTemplate -BackupRoot $loaderBackups
Assert-True ($replacedLoader.updated -and [IO.File]::ReadAllText($replacedLoader.backupPath, $utf8) -ceq $oldLoaderText) 'Existing Startup loader was replaced without a valid backup.'
$escapedPathRejected = $false
try { Assert-AeBridgeUserScriptsPath -TargetPath (Join-Path $fixtureScripts '../escaped.jsx') -ScriptsRoot $fixtureScripts } catch { $escapedPathRejected = $true }
Assert-True $escapedPathRejected 'Startup path outside its user Scripts root was accepted.'
'PASS thin user Startup loader path escaping, hash, unchanged reuse, backup and root boundaries'

$panelTemplate = Join-Path $workspace 'tools/AeBridgePanel.js'
$panelLoader = Install-AeBridgePanelLoader -ScriptsRoot $fixtureScripts -BundlePath $escapedBundle -TemplatePath $panelTemplate -BackupRoot $loaderBackups
Assert-True ($panelLoader.updated -and $null -eq $panelLoader.backupPath -and (Test-Path -LiteralPath $panelLoader.path -PathType Leaf)) 'First user panel loader installation failed.'
$panelLoaderText = [IO.File]::ReadAllText($panelLoader.path, $utf8)
Assert-True ($panelLoaderText.Contains("resolveBundle($expectedLiteral)") -and -not $panelLoaderText.Contains('__CODEX_AE_WORKSPACE_BUNDLE__')) 'Panel loader did not safely encode its workspace path.'
Assert-True ((Get-FileHash -LiteralPath $panelLoader.path -Algorithm SHA256).Hash -ceq $panelLoader.sha256) 'Installed panel loader hash does not match.'
$unchangedPanelLoader = Install-AeBridgePanelLoader -ScriptsRoot $fixtureScripts -BundlePath $escapedBundle -TemplatePath $panelTemplate -BackupRoot $loaderBackups
Assert-True (-not $unchangedPanelLoader.updated -and $null -eq $unchangedPanelLoader.backupPath) 'Unchanged panel loader was needlessly replaced.'
[IO.File]::WriteAllText($panelLoader.path, '/* prior full user panel */', $utf8)
$migratedPanelLoader = Install-AeBridgePanelLoader -ScriptsRoot $fixtureScripts -BundlePath $escapedBundle -TemplatePath $panelTemplate -BackupRoot $loaderBackups
Assert-True ($migratedPanelLoader.updated -and [IO.File]::ReadAllText($migratedPanelLoader.backupPath, $utf8) -ceq '/* prior full user panel */') 'Migrated full user panel was not backed up.'
'PASS thin user panel loader escaped path, fresh install, unchanged reuse and full-panel migration backup'

# Execute a fixture copy whose AppData expression points only inside this test's
# .ae-codex directory. A failed bundle must never replace the prior user panel.
$fakeAppData = Join-Path $fixture '.ae-codex/mock-appdata'
$fakePanelRoot = Join-Path $fakeAppData 'Adobe/After Effects/26.5/Scripts/ScriptUI Panels'
$fakePanelPath = Join-Path $fakePanelRoot 'Codex Bridge.jsx'
$updaterText = [IO.File]::ReadAllText((Join-Path $workspace 'tools/Update-AeBridgeUserPanel.ps1'), $utf8)
$appDataExpression = "([Environment]::GetFolderPath('ApplicationData'))"
Assert-True ([regex]::Matches($updaterText, [regex]::Escape($appDataExpression)).Count -eq 1) 'Updater AppData fixture substitution is ambiguous.'
$fixtureUpdater = Join-Path $fixture 'tools/Update-AeBridgeUserPanel.ps1'
[IO.File]::WriteAllText($fixtureUpdater, $updaterText.Replace($appDataExpression, ("('" + $fakeAppData.Replace("'", "''") + "')")), $utf8)
Copy-Item -LiteralPath $helperPath -Destination (Join-Path $fixture 'tools/Validate-AeBridgeInstallation.ps1')
Copy-Item -LiteralPath $loaderTemplate -Destination (Join-Path $fixture 'tools/AeBridgeStartup.js')
Copy-Item -LiteralPath $panelTemplate -Destination (Join-Path $fixture 'tools/AeBridgePanel.js')
$fixtureUpdate = & pwsh -NoProfile -File $fixtureUpdater -VersionFolder 26.5 | ConvertFrom-Json
Assert-True ($LASTEXITCODE -eq 0 -and $fixtureUpdate.updated -and $fixtureUpdate.validation.state -ceq 'success' -and $null -eq $fixtureUpdate.backupPath) 'Fresh fixture panel installation failed.'
$validInstalledHash = (Get-FileHash -LiteralPath $fakePanelPath -Algorithm SHA256).Hash
Assert-True ($validInstalledHash -ceq $fixtureUpdate.sha256 -and $validInstalledHash -cne $fixtureUpdate.bundleSha256 -and $fixtureUpdate.bundleSha256 -ceq (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash -and (Test-Path -LiteralPath $fixtureUpdate.startupLoader.path -PathType Leaf)) 'Validated thin panel or Startup loader was not installed in the fixture.'
Assert-True ([IO.File]::ReadAllText($fakePanelPath, $utf8).Contains('__CODEX_AE_PANEL_HOST__') -and [IO.File]::ReadAllBytes($fakePanelPath).Length -lt [IO.File]::ReadAllBytes($bundlePath).Length) 'Installed panel contains the full bundle instead of the portable thin loader.'
$panelWriteTime = [IO.File]::GetLastWriteTimeUtc($fakePanelPath)
$unchangedFixture = & pwsh -NoProfile -File $fixtureUpdater -VersionFolder 26.5 | ConvertFrom-Json
Assert-True ($LASTEXITCODE -eq 0 -and -not $unchangedFixture.updated -and $null -eq $unchangedFixture.backupPath -and $null -eq $unchangedFixture.startupLoader.backupPath -and [IO.File]::GetLastWriteTimeUtc($fakePanelPath) -eq $panelWriteTime) 'Unchanged installation replaced loaders or created redundant backups.'
[IO.File]::WriteAllText($fakePanelPath, '/* prior user panel */', $utf8)
$fixtureMigration = & pwsh -NoProfile -File $fixtureUpdater -VersionFolder 26.5 | ConvertFrom-Json
Assert-True ($LASTEXITCODE -eq 0 -and $fixtureMigration.updated -and [IO.File]::ReadAllText($fixtureMigration.backupPath, $utf8) -ceq '/* prior user panel */' -and (Get-FileHash -LiteralPath $fakePanelPath -Algorithm SHA256).Hash -ceq $validInstalledHash) 'Fixture full-panel migration failed or lost its backup.'
'PASS full updater fresh install, separate loader/bundle hashes, unchanged idempotency and prior-panel backup'
$validStartupHash = (Get-FileHash -LiteralPath $fixtureUpdate.startupLoader.path -Algorithm SHA256).Hash
$backupCount = @(Get-ChildItem -LiteralPath (Join-Path $fixture '.ae-codex/bridge/backups') -File).Count
[IO.File]::WriteAllText($bundlePath, $corrupt, $utf8)
$failureOutput = @(& pwsh -NoProfile -File $fixtureUpdater -VersionFolder 26.5 2>&1)
$failedExitCode = $LASTEXITCODE
[IO.File]::WriteAllText((Join-Path $fixture '.ae-codex/updater-validation-failure.log'), (($failureOutput | ForEach-Object { [string]$_ }) -join "`n"), $utf8)
Assert-True ($failedExitCode -ne 0 -and (Get-FileHash -LiteralPath $fakePanelPath -Algorithm SHA256).Hash -ceq $validInstalledHash) 'A failed bundle verification replaced the prior installed panel.'
Assert-True ((Get-FileHash -LiteralPath $fixtureUpdate.startupLoader.path -Algorithm SHA256).Hash -ceq $validStartupHash -and @(Get-ChildItem -LiteralPath (Join-Path $fixture '.ae-codex/bridge/backups') -File).Count -eq $backupCount) 'Failed bundle verification changed Startup or created a redundant backup.'
Assert-True (@(Get-ChildItem -LiteralPath $fakePanelRoot -Filter '*.tmp-*').Count -eq 0) 'Failed validation leaked a staged panel file.'
[IO.File]::WriteAllText($bundlePath, $originalBundle, $utf8)
'PASS updater validates staged source before replacement and preserves installed panel on verification failure'
"Installation validation tests passed. Fixture: $fixture"
