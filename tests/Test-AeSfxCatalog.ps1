#Requires -Version 7.0
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path $workspace ('.ae-codex\tests-sfx\' + [guid]::NewGuid().ToString('N'))
$fixtureTools = Join-Path $testRoot 'tools'
$audioRoot = Join-Path $testRoot 'audio'
$outsideRoot = Join-Path $testRoot 'outside'
$library = Join-Path $testRoot '.ae-codex\library'
[void][System.IO.Directory]::CreateDirectory($fixtureTools)
[void][System.IO.Directory]::CreateDirectory((Join-Path $audioRoot 'Cartoon'))
[void][System.IO.Directory]::CreateDirectory($outsideRoot)
$fixtureHelper = Join-Path $fixtureTools 'Update-AeSfxCatalog.ps1'
Copy-Item -LiteralPath (Join-Path $workspace 'tools\Update-AeSfxCatalog.ps1') -Destination $fixtureHelper
$pwsh = (Get-Command pwsh).Source
$checks = [System.Collections.Generic.List[string]]::new()

function Assert-Check {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAILED: $Message" }
    $checks.Add($Message)
}

function Invoke-Helper {
    param([string[]]$Arguments = @(), [int]$ExpectedExit = 0)
    $output = @(& $pwsh -NoProfile -File $fixtureHelper @Arguments)
    $actualExit = $LASTEXITCODE
    if ($actualExit -ne $ExpectedExit) { throw "Unexpected helper exit $actualExit. $($output -join ' ')" }
    return (($output -join "`n") | ConvertFrom-Json -ErrorAction Stop)
}

function Get-Summary {
    param($Status)
    return ([System.IO.File]::ReadAllText((Join-Path $testRoot $Status.summaryRelativePath)) | ConvertFrom-Json)
}

function Write-Request {
    param([string]$Id, [string]$Session = 'session-test-001', [string]$RequestWorkspace = $testRoot)
    [void][System.IO.Directory]::CreateDirectory((Join-Path $library 'requests'))
    $request = @{ schemaVersion = 1; requestId = $Id; sessionId = $Session; workspaceRoot = $RequestWorkspace; createdUtc = [datetime]::UtcNow.ToString('o') }
    [System.IO.File]::WriteAllText((Join-Path $library "requests\sfx-$Id.json"), ($request | ConvertTo-Json -Compress))
}

# These are intentionally synthetic byte fixtures, not project media.
$wavePath = Join-Path $audioRoot 'Cartoon\SWSH_QuickSwoosh.wav'
$mp3Path = Join-Path $audioRoot 'drip.MP3'
[System.IO.File]::WriteAllBytes($wavePath, [byte[]](1, 2, 3, 4))
[System.IO.File]::WriteAllBytes($mp3Path, [byte[]](5, 6, 7))
[System.IO.File]::WriteAllText((Join-Path $audioRoot 'ignore.txt'), 'not audio')
[System.IO.File]::WriteAllBytes((Join-Path $audioRoot 'pending-sfx.zip'), [byte[]](1, 2))
[System.IO.File]::WriteAllBytes((Join-Path $outsideRoot 'must-not-scan.wav'), [byte[]](8))

$unconfigured = Invoke-Helper
$unconfiguredSettings = [System.IO.File]::ReadAllText((Join-Path $library 'config.json')) | ConvertFrom-Json
Assert-Check ($unconfigured.enabled -eq $false -and $unconfigured.skipped -and $unconfigured.count -eq 0 -and $unconfigured.rootCount -eq 0) 'An unconfigured new machine publishes an empty disabled inventory without searching default folders.'
Assert-Check ($unconfiguredSettings.sfx.enabled -eq $false -and $unconfiguredSettings.sfx.roots.Count -eq 0) 'New-machine preferences opt out with no personal or drive-specific default roots.'
Assert-Check (-not (Test-Path -LiteralPath (Join-Path $library 'sfx-cache.jsonl'))) 'An opted-out initial refresh does not create or read the incremental audio cache.'

$first = Invoke-Helper -Arguments @('-Roots', $audioRoot)
$firstSummary = Get-Summary $first
Assert-Check ($first.state -eq 'success' -and $first.count -eq 2 -and $first.updatedCount -eq 2) 'First scan catalogs audio metadata only.'
Assert-Check ([System.IO.File]::Exists((Join-Path $library 'config.json'))) 'Standalone invocation bootstraps the configurable library file.'
$records = @([System.IO.File]::ReadAllLines((Join-Path $testRoot $first.catalogRelativePath)) | ForEach-Object { $_ | ConvertFrom-Json })
$wave = $records | Where-Object name -eq 'SWSH_QuickSwoosh.wav'
Assert-Check ($wave.sizeBytes -eq 4 -and $wave.tags -contains 'quick' -and $wave.tags -contains 'swoosh') 'Audio records include size, time, path, and searchable filename/folder tags.'
Assert-Check ($first.metadataOnly -and $firstSummary.metadataOnly) 'Outputs explicitly identify the catalog as metadata only.'
Assert-Check ($first.pendingArchiveCount -eq 1 -and $firstSummary.pendingArchives[0].state -eq 'not-unpacked') 'Archives are surfaced as metadata without unpacking or reading their contents.'

$second = Invoke-Helper
Assert-Check ($second.reusedCount -eq 2 -and $second.updatedCount -eq 0) 'Second scan reuses unchanged metadata records.'
Assert-Check ($second.reusedCatalog -and $second.catalogRelativePath -ceq $first.catalogRelativePath -and
    $second.catalogRequestId -ceq $first.requestId -and $second.catalogSessionId -ceq $first.sessionId) 'Unchanged refreshes reuse the prior immutable catalog across sessions.'
Assert-Check (@(Get-ChildItem -LiteralPath (Join-Path $library 'sessions') -Recurse -File -Filter '*.jsonl').Count -eq 2) 'An unchanged refresh publishes no additional full JSONL snapshot after the initial disabled inventory.'
$latest = [System.IO.File]::ReadAllText((Join-Path $library 'latest-sfx.json')) | ConvertFrom-Json
Assert-Check ($latest.requestId -ceq $second.requestId -and $latest.catalogRelativePath -ceq $first.catalogRelativePath -and
    [System.IO.File]::Exists((Join-Path $testRoot $latest.summaryRelativePath))) 'Atomic latest pointer separates current scan identity from reusable catalog identity.'
$cachePath = Join-Path $library 'sfx-cache.jsonl'
[System.IO.File]::AppendAllText($cachePath, "`r`n   `r`n")
$blankCache = Invoke-Helper
Assert-Check ($blankCache.count -eq 2 -and $blankCache.reusedCount -eq 2 -and $blankCache.updatedCount -eq 0 -and $blankCache.warningCount -eq 0 -and $blankCache.reusedCatalog) 'Batch cache loading tolerates blank JSONL lines and preserves unchanged records.'
$overlapConfigPath = Join-Path $library 'config.json'
$overlapConfig = [System.IO.File]::ReadAllText($overlapConfigPath) | ConvertFrom-Json
$overlapConfig.sfx.roots = @($audioRoot, (Join-Path $audioRoot 'Cartoon'))
[System.IO.File]::WriteAllText($overlapConfigPath, ($overlapConfig | ConvertTo-Json -Depth 5 -Compress))
$overlap = Invoke-Helper
$overlapSummary = Get-Summary $overlap
Assert-Check ($overlap.count -eq 2 -and $overlap.reusedCount -eq 2 -and $overlapSummary.enumeratedDirectoryCount -eq 2 -and $overlapSummary.skippedOverlappingDirectoryCount -eq 1) 'Overlapping watched roots enumerate a directory only once and keep the first configured root attribution.'
$overlapConfig.sfx.roots = @($audioRoot)
[System.IO.File]::WriteAllText($overlapConfigPath, ($overlapConfig | ConvertTo-Json -Depth 5 -Compress))
$addedPath = Join-Path $audioRoot 'new-knife-dodge.ogg'
[System.IO.File]::WriteAllBytes($addedPath, [byte[]](1, 2, 3))
$added = Invoke-Helper
Assert-Check ($added.count -eq 3 -and $added.reusedCount -eq 2 -and $added.updatedCount -eq 1) 'A later refresh discovers newly downloaded audio files.'
Assert-Check (-not $added.reusedCatalog -and $added.catalogRequestId -ceq $added.requestId) 'A discovered file creates a fresh immutable catalog.'
[System.IO.File]::Delete($addedPath)
[System.IO.File]::WriteAllBytes($wavePath, [byte[]](1, 2, 3, 4, 5))
$third = Invoke-Helper
Assert-Check ($third.reusedCount -eq 1 -and $third.updatedCount -eq 1) 'Metadata changes invalidate only the changed file.'
[System.IO.File]::Delete($mp3Path)
$fourth = Invoke-Helper
Assert-Check ($fourth.count -eq 1 -and (Get-Summary $fourth).removedCount -eq 1) 'Deleted files are removed from the refreshed catalog.'

Write-Request -Id 'library-request-001'
$requested = Invoke-Helper -Arguments @('-RequestId', 'library-request-001')
Assert-Check ($requested.sessionId -eq 'session-test-001' -and $requested.requestId -eq 'library-request-001') 'Bridge request status is bound to its session and request.'
$terminalPath = Join-Path $library 'sessions\session-test-001\status-sfx-library-request-001.json'
$terminalBefore = [System.IO.File]::ReadAllText($terminalPath)
$requestedAgain = Invoke-Helper -Arguments @('-RequestId', 'library-request-001')
Assert-Check ($terminalBefore -ceq [System.IO.File]::ReadAllText($terminalPath)) 'Repeated request returns its immutable terminal result.'

$heldLock = [System.IO.File]::Open((Join-Path $library 'sfx-cache.lock'), [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
    Write-Request -Id 'library-lock-held'
    $busy = Invoke-Helper -Arguments @('-RequestId', 'library-lock-held', '-LockTimeoutSeconds', '1') -ExpectedExit 1
    Assert-Check ($busy.error -match 'owns the cache lock') 'An overlapping scan cannot mutate the shared cache.'
} finally {
    $heldLock.Dispose()
}
$released = Invoke-Helper
Assert-Check ($released.state -eq 'success' -and $released.reusedCount -eq 1) 'A released file handle leaves no stale lock that blocks future scans.'

$latestPath = Join-Path $library 'latest-sfx.json'
$tampered = [System.IO.File]::ReadAllText($latestPath) | ConvertFrom-Json
$tampered.catalogRelativePath = '../unsafe.jsonl'
[System.IO.File]::WriteAllText($latestPath, ($tampered | ConvertTo-Json -Depth 5 -Compress))
$pointerRecovered = Invoke-Helper
Assert-Check (-not $pointerRecovered.reusedCatalog -and $pointerRecovered.warningCount -eq 1) 'A latest pointer with a path outside its catalog identity is rejected and rebuilt.'
[System.IO.File]::Delete((Join-Path $testRoot $pointerRecovered.catalogRelativePath))
$missingCatalogRecovered = Invoke-Helper
Assert-Check (-not $missingCatalogRecovered.reusedCatalog -and $missingCatalogRecovered.warningCount -eq 1 -and
    [System.IO.File]::Exists((Join-Path $testRoot $missingCatalogRecovered.catalogRelativePath))) 'A missing reusable snapshot produces a fresh valid catalog and warning.'

$configPath = Join-Path $library 'config.json'
$extensionConfig = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
$originalExtensions = $extensionConfig.sfx.extensions
$extensionConfig.sfx.extensions = @('.wav')
[System.IO.File]::WriteAllText($configPath, ($extensionConfig | ConvertTo-Json -Depth 5 -Compress))
$extensionChange = Invoke-Helper
Assert-Check (-not $extensionChange.reusedCatalog -and $extensionChange.updatedCount -eq 0 -and $extensionChange.count -eq 1) 'A watched-extension change prevents stale snapshot reuse even when file metadata is unchanged.'
$extensionConfig.sfx.extensions = $originalExtensions
[System.IO.File]::WriteAllText($configPath, ($extensionConfig | ConvertTo-Json -Depth 5 -Compress))

$invalidId = Invoke-Helper -Arguments @('-RequestId', '../unsafe') -ExpectedExit 1
Assert-Check ($invalidId.state -eq 'error' -and $invalidId.error -match 'Invalid.*request ID') 'Traversal in request IDs is rejected.'
Write-Request -Id 'library-wrong-workspace' -RequestWorkspace (Join-Path $testRoot 'other')
$invalidWorkspace = Invoke-Helper -Arguments @('-RequestId', 'library-wrong-workspace') -ExpectedExit 1
Assert-Check ($invalidWorkspace.error -match 'different workspace') 'Requests from another workspace are rejected.'
Write-Request -Id 'library-invalid-session' -Session '../unsafe'
$invalidSession = Invoke-Helper -Arguments @('-RequestId', 'library-invalid-session') -ExpectedExit 1
Assert-Check ($invalidSession.error -match 'Invalid.*session ID') 'Traversal in session IDs is rejected.'
$invalidRoot = Invoke-Helper -Arguments @('-Roots', [System.IO.Path]::GetPathRoot($audioRoot)) -ExpectedExit 1
Assert-Check ($invalidRoot.error -match 'drive or share root') 'Whole-drive scanning is rejected.'

$config = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
$config.sfx.roots = @($audioRoot, (Join-Path $testRoot 'missing'))
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5 -Compress))
$missing = Invoke-Helper
$missingSummary = Get-Summary $missing
Assert-Check ($missing.count -eq 1 -and $missing.warningCount -eq 1 -and $missingSummary.roots[1].state -eq 'missing') 'Missing roots are reported without losing the available library.'
Assert-Check (-not $missing.reusedCatalog) 'A watched-root change publishes a new snapshot rather than reusing stale scope.'

[System.IO.File]::WriteAllText((Join-Path $library 'sfx-cache.jsonl'), '{broken cache')
$rebuilt = Invoke-Helper
Assert-Check ($rebuilt.count -eq 1 -and $rebuilt.updatedCount -eq 1 -and $rebuilt.warningCount -eq 2) 'A corrupt incremental cache rebuilds safely and reports a warning.'

$junctionPath = Join-Path $audioRoot 'redirect'
New-Item -ItemType Junction -Path $junctionPath -Target $outsideRoot | Out-Null
$linked = Invoke-Helper
Assert-Check ($linked.count -eq 1 -and (Get-Summary $linked).skippedReparseCount -eq 1) 'Directory junctions are skipped during recursive scanning.'
$rootLinked = Invoke-Helper -Arguments @('-Roots', $junctionPath) -ExpectedExit 1
Assert-Check ($rootLinked.error -match 'reparse points') 'A root that aliases another folder is rejected.'

$config.sfx.extensions = @('.exe')
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5 -Compress))
Write-Request -Id 'library-invalid-config'
$badConfig = Invoke-Helper -Arguments @('-RequestId', 'library-invalid-config') -ExpectedExit 1
Assert-Check ($badConfig.state -eq 'error' -and $badConfig.error -match 'Unsupported audio extension') 'Unsupported extensions publish a session-bound error status.'
$errorPath = Join-Path $library 'sessions\session-test-001\status-sfx-library-invalid-config.json'
Assert-Check ([System.IO.File]::Exists($errorPath)) 'A validated request receives an atomic terminal status on failure.'

$config.sfx.extensions = @('.wav')
$config.sfx.roots = @()
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5 -Compress))
$empty = Invoke-Helper
Assert-Check ($empty.state -eq 'success' -and $empty.count -eq 0 -and $empty.rootCount -eq 0) 'An empty watched-folder list succeeds without scanning any drive.'

$config.sfx | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
$config.sfx.roots = @($junctionPath, [System.IO.Path]::GetPathRoot($audioRoot))
$config.sfx.extensions = @('.invalid')
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5 -Compress))
$cachePath = Join-Path $library 'sfx-cache.jsonl'
[System.IO.File]::WriteAllText($cachePath, '{cache-must-not-be-read-or-erased')
$cacheBefore = [System.IO.File]::ReadAllText($cachePath)
Write-Request -Id 'library-disabled-001'
$disabled = Invoke-Helper -Arguments @('-RequestId', 'library-disabled-001')
Assert-Check ($disabled.state -eq 'success' -and $disabled.enabled -eq $false -and $disabled.skipped -and $disabled.count -eq 0 -and $disabled.warningCount -eq 0) 'A background request respects explicit opt-out even when stored folders and extensions would be unsafe to scan.'
Assert-Check ([System.IO.File]::ReadAllText($cachePath) -ceq $cacheBefore) 'Opting out does not read or erase an existing incremental cache.'
Assert-Check ([System.IO.File]::ReadAllText((Join-Path $testRoot $disabled.catalogRelativePath)) -ceq '') 'A disabled refresh cannot expose a previous catalog through its published inventory.'

$config.sfx.PSObject.Properties.Remove('enabled')
$config.sfx.roots = @($audioRoot)
$config.sfx.extensions = @('.wav')
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5 -Compress))
$backwardCompatible = Invoke-Helper
Assert-Check ($backwardCompatible.enabled -and $backwardCompatible.count -eq 1) 'A previously configured user without an enabled flag keeps their watched-folder behavior.'
[System.IO.File]::WriteAllText($cachePath, 'null')
$nullCache = Invoke-Helper
Assert-Check ($nullCache.count -eq 1 -and $nullCache.updatedCount -eq 1 -and $nullCache.warningCount -eq 1) 'A syntactically valid null cache record is rejected and rebuilt instead of disappearing during array enumeration.'

$result = [pscustomobject]@{ state = 'success'; count = $checks.Count; checks = $checks.ToArray(); fixtureRoot = $testRoot }
[System.IO.File]::WriteAllText((Join-Path $testRoot 'test-result.json'), ($result | ConvertTo-Json -Depth 4))
$result | ConvertTo-Json -Depth 4
