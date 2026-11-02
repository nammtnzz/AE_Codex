#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testId = [guid]::NewGuid().ToString('N')
$fixture = Join-Path ([IO.Path]::GetTempPath()) "Codex AE entry $testId/Máy mới & 100% O'Brien"
$tools = Join-Path $fixture 'tools'
$releases = Join-Path $fixture '.ae-codex/releases'
$reportRoot = Join-Path $workspace ".ae-codex/tests-desktop-entry/$testId"
foreach ($directory in @($tools,$releases,$reportRoot)) { [void][IO.Directory]::CreateDirectory($directory) }
$checks = [Collections.Generic.List[string]]::new()
function Assert-Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw "FAILED: $Message" }; $checks.Add($Message) }
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $workspace 'tools') -File -Filter '*.js') { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $tools $file.Name) }
foreach ($name in @('Publish-AeDesktopEntry.ps1','AeLauncher.cs')) { Copy-Item -LiteralPath (Join-Path $workspace "tools/$name") -Destination (Join-Path $tools $name) }
$latest = [IO.File]::ReadAllText((Join-Path $workspace '.ae-codex/releases/latest.json')) | ConvertFrom-Json
$package = Join-Path $releases ('CodexAE-' + $latest.packageId)
Copy-Item -LiteralPath (Join-Path $workspace ('.ae-codex/releases/CodexAE-' + $latest.packageId)) -Destination $package -Recurse
$latest.packagePath = 'Z:/foreign/machine/ignored'
$latest.payloadPath = 'Z:/foreign/machine/ignored/payload'
$latest.launcherPath = 'Z:/foreign/machine/ignored/Codex AE.exe'
$latestPath = Join-Path $releases 'latest.json'
[IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json -Depth 8))
foreach ($name in @('source','jsx','tests','docs','assets','outputs','.codex')) { [void][IO.Directory]::CreateDirectory((Join-Path $fixture $name)); [IO.File]::WriteAllText((Join-Path $fixture "$name/kept.txt"), 'canonical path stays') }
foreach ($name in @('README.md','AGENTS.md','.gitignore','.gitattributes')) { [IO.File]::WriteAllText((Join-Path $fixture $name), 'fixture source remains') }
$existingHidden = Join-Path $fixture 'docs'
[IO.File]::SetAttributes($existingHidden, ([IO.File]::GetAttributes($existingHidden) -bor [IO.FileAttributes]::Hidden))
$sourceHashes = @{}
foreach ($name in @('source/kept.txt','jsx/kept.txt','assets/kept.txt','outputs/kept.txt','AGENTS.md','tools/AeLauncher.cs')) { $sourceHashes[$name] = (Get-FileHash -LiteralPath (Join-Path $fixture $name) -Algorithm SHA256).Hash }
$pwsh = (Get-Process -Id $PID).Path
$publisher = Join-Path $tools 'Publish-AeDesktopEntry.ps1'
function Publish-Fixture([string[]]$Arguments=@(),[int]$Exit=0) {
    $output = @(& $pwsh -NoProfile -File $publisher @Arguments 2>&1)
    if ($LASTEXITCODE -ne $Exit) { throw "Publisher exit $LASTEXITCODE expected $Exit : $($output -join ' ')" }
    if ($Exit -ne 0) { return ($output -join "`n") }
    return (($output -join "`n") | ConvertFrom-Json -ErrorAction Stop)
}
function Check-Launcher([string]$Path,[bool]$Success) {
    $process = Start-Process -FilePath $Path -ArgumentList '--check' -WindowStyle Hidden -PassThru -Wait
    try { Assert-Check (($process.ExitCode -eq 0) -eq $Success) "Launcher --check result matches expected $Success for the selected local package." } finally { $process.Dispose() }
}
$published = Publish-Fixture
$launcher = Join-Path $fixture 'Codex AE.exe'
Assert-Check ($published.state -eq 'success' -and [IO.File]::Exists($launcher) -and [IO.File]::Exists((Join-Path $fixture 'HUONG-DAN.txt'))) 'Publishing exposes a root native installer and a concise local guide.'
Assert-Check (-not ([IO.File]::GetAttributes((Join-Path $fixture 'source')) -band [IO.FileAttributes]::Hidden)) 'Default publishing does not change folder visibility.'
Check-Launcher $launcher $true
Assert-Check ($published.packageId -ceq $latest.packageId) 'Root mode derives the local sanitized release and ignores foreign absolute paths in latest.json.'

$compact = Publish-Fixture -Arguments @('-CompactLayout')
$layoutPath = Join-Path $fixture '.ae-codex/setup/workspace-layout.json'
$layout = [IO.File]::ReadAllText($layoutPath) | ConvertFrom-Json
Assert-Check ($compact.compactLayout -and $layout.state -ceq 'compact' -and $layout.entries.Count -ge 12) 'Compacting records the baseline before hiding technical entries.'
Assert-Check (([IO.File]::GetAttributes((Join-Path $fixture 'source')) -band [IO.FileAttributes]::Hidden) -and -not ([IO.File]::GetAttributes($launcher) -band [IO.FileAttributes]::Hidden)) 'Compact mode keeps the installer visible while preserving canonical folders in place.'
$null = Publish-Fixture -Arguments @('-CompactLayout')
$layoutAgain = [IO.File]::ReadAllText($layoutPath) | ConvertFrom-Json
Assert-Check (-not (@($layoutAgain.entries | Where-Object name -CEQ 'source')[0].hiddenBefore) -and (@($layoutAgain.entries | Where-Object name -CEQ 'docs')[0].hiddenBefore)) 'Repeated compact publications preserve the original visibility baseline.'
[IO.File]::SetAttributes((Join-Path $fixture 'source'), ([IO.File]::GetAttributes((Join-Path $fixture 'source')) -bor [IO.FileAttributes]::ReadOnly))
$restored = Publish-Fixture -Arguments @('-RestoreLayout')
Assert-Check ($restored.restored -gt 0 -and -not ([IO.File]::GetAttributes((Join-Path $fixture 'source')) -band [IO.FileAttributes]::Hidden) -and ([IO.File]::GetAttributes((Join-Path $fixture 'source')) -band [IO.FileAttributes]::ReadOnly)) 'Restore clears only the owned Hidden bit and preserves newer attributes.'
Assert-Check ([bool]([IO.File]::GetAttributes($existingHidden) -band [IO.FileAttributes]::Hidden)) 'Restore preserves entries that were already hidden before compact mode.'
[IO.File]::SetAttributes((Join-Path $fixture 'source'), ([IO.File]::GetAttributes((Join-Path $fixture 'source')) -bor [IO.FileAttributes]::Hidden))
$restoredAgain = Publish-Fixture -Arguments @('-Restore')
Assert-Check ($restoredAgain.restored -eq 0 -and [bool]([IO.File]::GetAttributes((Join-Path $fixture 'source')) -band [IO.FileAttributes]::Hidden)) 'Repeated Restore does not undo later visibility changes made by the user.'
foreach ($name in $sourceHashes.Keys) { Assert-Check ((Get-FileHash -LiteralPath (Join-Path $fixture $name) -Algorithm SHA256).Hash -ceq $sourceHashes[$name]) "Canonical content remains unchanged: $name" }

$validPointer = [IO.File]::ReadAllText($latestPath)
$latest.packageId = '../../outside'
[IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json -Depth 8))
Check-Launcher $launcher $false
$failure = Publish-Fixture -Exit 1
Assert-Check ($failure -match 'release pointer is invalid') 'Publishing rejects traversal identities before writing the entry point.'
[IO.File]::WriteAllText($latestPath, '{broken')
Check-Launcher $launcher $false
[IO.File]::WriteAllText($latestPath, $validPointer)
$manager = Join-Path $package 'payload/tools/Manage-AeInstallation.ps1'
$managerBytes = [IO.File]::ReadAllBytes($manager)
[IO.File]::AppendAllText($manager, "`n# modified fixture`n")
Check-Launcher $launcher $false
[IO.File]::WriteAllBytes($manager, $managerBytes)
$manifestPath = Join-Path $package 'payload/distribution.json'
$manifestText = [IO.File]::ReadAllText($manifestPath)
$manifest = $manifestText | ConvertFrom-Json
$manifest.packageId = '9.9.9-ffffffffffff'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 15))
Check-Launcher $launcher $false
[IO.File]::WriteAllText($manifestPath, $manifestText)

$nextId = '9.9.9-eeeeeeeeeeee'
$nextPackage = Join-Path $releases ('CodexAE-' + $nextId)
Copy-Item -LiteralPath $package -Destination $nextPackage -Recurse
$nextManifestPath = Join-Path $nextPackage 'payload/distribution.json'
$nextManifest = [IO.File]::ReadAllText($nextManifestPath) | ConvertFrom-Json
$nextManifest.packageId = $nextId
[IO.File]::WriteAllText($nextManifestPath, ($nextManifest | ConvertTo-Json -Depth 15))
$nextPointer = $validPointer | ConvertFrom-Json
$nextPointer.packageId = $nextId
[IO.File]::WriteAllText($latestPath, ($nextPointer | ConvertTo-Json -Depth 8))
[IO.File]::AppendAllText($manager, "`n# previous package now changed`n")
Check-Launcher $launcher $true
[IO.File]::WriteAllBytes($manager, $managerBytes)
Assert-Check ([IO.File]::ReadAllText($nextManifestPath).Contains($nextId)) 'The unchanged root launcher follows the latest constrained local release on subsequent builds.'
[IO.File]::WriteAllText($latestPath, $validPointer)

$linkedId = '9.9.8-dddddddddddd'
$linkedPackage = Join-Path $releases ('CodexAE-' + $linkedId)
$null = New-Item -ItemType Junction -Path $linkedPackage -Target $package
try {
    $linkedPointer = $validPointer | ConvertFrom-Json
    $linkedPointer.packageId = $linkedId
    [IO.File]::WriteAllText($latestPath, ($linkedPointer | ConvertTo-Json -Depth 8))
    Check-Launcher $launcher $false
} finally {
    # Delete only the known junction itself, never recurse into its target.
    [IO.Directory]::Delete($linkedPackage)
    [IO.File]::WriteAllText($latestPath, $validPointer)
}

$standalone = Join-Path $fixture 'Extracted release'
[void][IO.Directory]::CreateDirectory($standalone)
Copy-Item -LiteralPath (Join-Path $package 'payload') -Destination (Join-Path $standalone 'payload') -Recurse
Copy-Item -LiteralPath $launcher -Destination (Join-Path $standalone 'Codex AE.exe')
Check-Launcher (Join-Path $standalone 'Codex AE.exe') $true
Assert-Check (-not [IO.Directory]::Exists((Join-Path $fixture 'payload'))) 'Root publication reuses the sanitized release without duplicating its payload.'
$backups = @(Get-ChildItem -LiteralPath (Join-Path $fixture '.ae-codex/setup/entry-backups') -File -Filter '*.exe')
Assert-Check ($backups.Count -gt 0) 'Replacing an existing root launcher retains the prior executable under local setup backups.'
$result = [pscustomobject]@{state='success';count=$checks.Count;checks=$checks.ToArray();fixtureRoot=$fixture;realWorkspacePublished=$false}
[IO.File]::WriteAllText((Join-Path $reportRoot 'result.json'), ($result | ConvertTo-Json -Depth 6))
$result | ConvertTo-Json -Depth 6
