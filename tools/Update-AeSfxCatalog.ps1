#Requires -Version 7.0
<#
Creates a metadata-only catalog of configured local audio folders. This helper
does not read audio contents, import media, or modify After Effects projects.
#>
[CmdletBinding()]
param(
    [string]$RequestId,
    [string[]]$Roots,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$libraryRoot = Join-Path $workspaceRoot '.ae-codex\library'
$allowedExtensions = @('.wav', '.mp3', '.aiff', '.aif', '.ogg', '.flac', '.m4a', '.aac')
$utf8 = [System.Text.UTF8Encoding]::new($false)
$warningItems = [System.Collections.Generic.List[string]]::new()
$warningTotal = 0
$lockStream = $null
$statusPath = $null
$sessionId = $null
$request = $null

function Assert-SafeAncestry {
    param([Parameter(Mandatory)][string]$Path)
    $cursor = [System.IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $attributes = [System.IO.File]::GetAttributes($cursor)
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Symbolic links and reparse points are not permitted: $cursor"
            }
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Get-JsonProperty {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Read-Json {
    param([string]$Path)
    Assert-SafeAncestry -Path $Path
    return ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop)
}

function Write-AtomicText {
    param([string]$Path, [string]$Text, [switch]$Immutable)
    Assert-SafeAncestry -Path $Path
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporary, $Text, $utf8)
        [System.IO.File]::Move($temporary, $Path, -not $Immutable.IsPresent)
    } finally {
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
}

function Write-AtomicJson {
    param([string]$Path, $Object, [switch]$Immutable)
    Write-AtomicText -Path $Path -Text ($Object | ConvertTo-Json -Depth 12 -Compress) -Immutable:$Immutable
}

function Add-CatalogWarning {
    param([string]$Message)
    $script:warningTotal += 1
    if ($warningItems.Count -lt 20) {
        if ($Message.Length -gt 240) { $Message = $Message.Substring(0, 240) }
        $warningItems.Add($Message)
    }
}

function Resolve-CatalogRoots {
    param($ConfiguredRoots)
    $inputRoots = @()
    if ($null -ne $ConfiguredRoots) { $inputRoots = @($ConfiguredRoots) }
    if ($inputRoots.Count -gt 32) { throw 'Configure at most 32 SFX folders.' }
    $resolved = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($configuredRoot in $inputRoots) {
        if ($configuredRoot -isnot [string] -or [string]::IsNullOrWhiteSpace($configuredRoot) -or
            $configuredRoot.Length -gt 512 -or $configuredRoot -match '[\x00-\x1f]') {
            throw 'Every SFX root must be a nonempty absolute folder path of at most 512 characters.'
        }
        if (-not [System.IO.Path]::IsPathFullyQualified($configuredRoot)) {
            throw "SFX roots must be absolute paths: $configuredRoot"
        }
        $full = [System.IO.Path]::GetFullPath($configuredRoot).TrimEnd([char[]]'\/')
        $volumeRoot = [System.IO.Path]::GetPathRoot($configuredRoot).TrimEnd([char[]]'\/')
        if ($full.Equals($volumeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Select a specific SFX folder; scanning a drive or share root is not allowed: $configuredRoot"
        }
        Assert-SafeAncestry -Path $full
        if ($seen.Add($full)) { $resolved.Add($full) }
    }
    return ,$resolved.ToArray()
}

function Get-SearchTags {
    param([string]$RelativePath)
    $expanded = [regex]::Replace($RelativePath, '([a-z])([A-Z])', '$1 $2').ToLowerInvariant()
    $tokens = [regex]::Split($expanded, '[^\p{L}\p{N}]+')
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $tags = [System.Collections.Generic.List[string]]::new()
    foreach ($token in $tokens) {
        if ($token.Length -gt 0 -and $seen.Add($token)) { $tags.Add($token) }
    }
    return ,$tags.ToArray()
}

function Get-SettingsFingerprint {
    param([string[]]$ScanRoots, [string[]]$Extensions)
    $settings = [ordered]@{ roots = @($ScanRoots); extensions = @($Extensions | Sort-Object) }
    $bytes = $utf8.GetBytes(($settings | ConvertTo-Json -Depth 4 -Compress))
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally { $sha256.Dispose() }
}

function Get-ReusableCatalog {
    param([string]$LatestPath, [string]$SettingsFingerprint, [int]$Count)
    if (-not [System.IO.File]::Exists($LatestPath)) { return $null }
    try {
        $latest = Read-Json -Path $LatestPath
        $catalogRequestId = Get-JsonProperty $latest 'catalogRequestId'
        $catalogSessionId = Get-JsonProperty $latest 'catalogSessionId'
        if ((Get-JsonProperty $latest 'schemaVersion') -ne 1 -or
            (Get-JsonProperty $latest 'kind') -ne 'disk-sfx' -or
            (Get-JsonProperty $latest 'state') -ne 'success' -or
            $catalogRequestId -isnot [string] -or $catalogRequestId -notmatch '^[A-Za-z0-9-]{8,80}$' -or
            $catalogSessionId -isnot [string] -or $catalogSessionId -notmatch '^[A-Za-z0-9-]{8,80}$') {
            throw 'Latest SFX pointer has an invalid schema or catalog identity.'
        }
        $expectedRelative = ".ae-codex/library/sessions/$catalogSessionId/sfx-$catalogRequestId.jsonl"
        if ((Get-JsonProperty $latest 'catalogRelativePath') -cne $expectedRelative) {
            throw 'Latest SFX catalog path does not match its catalog identity.'
        }
        $existingCatalog = Join-Path $workspaceRoot $expectedRelative
        Assert-SafeAncestry -Path $existingCatalog
        if (-not [System.IO.File]::Exists($existingCatalog)) { throw 'Latest SFX catalog file is missing.' }
        if ((Get-JsonProperty $latest 'settingsFingerprint') -cne $SettingsFingerprint -or
            (Get-JsonProperty $latest 'count') -ne $Count) { return $null }
        return $latest
    } catch {
        Add-CatalogWarning "Latest SFX catalog cannot be reused; publishing a fresh catalog: $($_.Exception.Message)"
        return $null
    }
}

try {
    Assert-SafeAncestry -Path $libraryRoot
    [void][System.IO.Directory]::CreateDirectory($libraryRoot)
    if ([string]::IsNullOrEmpty($RequestId)) {
        $RequestId = 'manual-' + [guid]::NewGuid().ToString('N')
        $sessionId = 'standalone-' + [guid]::NewGuid().ToString('N')
    } else {
        if ($RequestId -notmatch '^[A-Za-z0-9-]{8,80}$') { throw 'Invalid SFX catalog request ID.' }
        if ($PSBoundParameters.ContainsKey('Roots')) { throw '-Roots can only be used for a standalone catalog update.' }
        $requestPath = Join-Path $libraryRoot "requests\sfx-$RequestId.json"
        $request = Read-Json -Path $requestPath
        if ((Get-JsonProperty $request 'schemaVersion') -ne 1 -or
            (Get-JsonProperty $request 'requestId') -cne $RequestId) {
            throw 'The SFX catalog request schema or request ID does not match.'
        }
        $sessionId = Get-JsonProperty $request 'sessionId'
        if ($sessionId -isnot [string] -or $sessionId -notmatch '^[A-Za-z0-9-]{8,80}$') {
            throw 'Invalid SFX catalog session ID.'
        }
        $requestWorkspace = Get-JsonProperty $request 'workspaceRoot'
        if ($requestWorkspace -isnot [string] -or -not [System.IO.Path]::IsPathFullyQualified($requestWorkspace) -or
            -not [System.IO.Path]::GetFullPath($requestWorkspace).Equals($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The SFX catalog request belongs to a different workspace.'
        }
    }
    $sessionRoot = Join-Path $libraryRoot "sessions\$sessionId"
    Assert-SafeAncestry -Path $sessionRoot
    [void][System.IO.Directory]::CreateDirectory($sessionRoot)
    $statusPath = Join-Path $sessionRoot "status-sfx-$RequestId.json"
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
        $existing = Read-Json -Path $statusPath
        if ($existing.requestId -cne $RequestId -or $existing.sessionId -cne $sessionId) { throw 'Existing terminal SFX status identity is invalid.' }
        $existing | ConvertTo-Json -Depth 12 -Compress
        if ($existing.state -ne 'success') { exit 1 }
        exit 0
    }

    # One metadata scanner owns the shared incremental cache at a time. The lock
    # is an exclusive file handle, so a crashed helper cannot leave a stale lock.
    $lockPath = Join-Path $libraryRoot 'sfx-cache.lock'
    Assert-SafeAncestry -Path $lockPath
    $lockDeadline = [datetime]::UtcNow.AddSeconds($LockTimeoutSeconds)
    do {
        try {
            $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch [System.IO.IOException] {
            if ([datetime]::UtcNow -ge $lockDeadline) { throw 'Another SFX catalog scan still owns the cache lock.' }
            Start-Sleep -Milliseconds 200
        }
    } while ($null -eq $lockStream)
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
        $existing = Read-Json -Path $statusPath
        if ($existing.requestId -cne $RequestId -or $existing.sessionId -cne $sessionId) { throw 'Existing terminal SFX status identity is invalid.' }
        $existing | ConvertTo-Json -Depth 12 -Compress
        if ($existing.state -ne 'success') { exit 1 }
        exit 0
    }

    $startedUtc = [datetime]::UtcNow
    $configPath = Join-Path $libraryRoot 'config.json'
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $config = Read-Json -Path $configPath
        if ((Get-JsonProperty $config 'schemaVersion') -ne 1) { throw 'Unsupported library config schemaVersion; expected 1.' }
    } else {
        $config = [pscustomobject]@{
            schemaVersion = 1
            sfx = [pscustomobject]@{ enabled = $false; roots = @(); extensions = $allowedExtensions }
        }
        Write-AtomicJson -Path $configPath -Object $config
    }
    $sfxConfig = Get-JsonProperty $config 'sfx'
    if ($null -eq $sfxConfig) { throw 'Library config is missing its sfx section.' }
    if ($PSBoundParameters.ContainsKey('Roots')) {
        $validatedRoots = Resolve-CatalogRoots -ConfiguredRoots $Roots
        $sfxConfig | Add-Member -NotePropertyName roots -NotePropertyValue $validatedRoots -Force
        # Supplying folders explicitly is the standalone opt-in route. Bridge
        # requests never accept folders and cannot change this preference.
        $sfxConfig | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
        Write-AtomicJson -Path $configPath -Object $config
    }
    # A pre-existing configuration without this flag retains its watched-folder
    # behavior. Fresh installations opt out until folders are selected.
    $sfxEnabled = Get-JsonProperty $sfxConfig 'enabled' $true
    if ($sfxEnabled -isnot [bool]) { throw 'Library sfx.enabled must be a boolean.' }
    $scanRoots = @()
    $extensions = $allowedExtensions
    if ($sfxEnabled) {
        $scanRoots = Resolve-CatalogRoots -ConfiguredRoots (Get-JsonProperty $sfxConfig 'roots' @())
        $extensions = @(Get-JsonProperty $sfxConfig 'extensions' $allowedExtensions)
    }
    $extensionSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($extension in $extensions) {
        if ($extension -isnot [string] -or $allowedExtensions -notcontains $extension.ToLowerInvariant()) {
            throw "Unsupported audio extension in config: $extension"
        }
        [void]$extensionSet.Add($extension.ToLowerInvariant())
    }

    $cachePath = Join-Path $libraryRoot 'sfx-cache.jsonl'
    $cached = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::OrdinalIgnoreCase)
    if ($sfxEnabled -and (Test-Path -LiteralPath $cachePath -PathType Leaf)) {
        try {
            Assert-SafeAncestry -Path $cachePath
            # Parse the JSONL in one native JSON pass. Invoking a PowerShell
            # command and property helper for each of thousands of unchanged
            # records consumed most of the idle refresh time.
            $cacheLines = [System.Collections.Generic.List[string]]::new()
            foreach ($line in [System.IO.File]::ReadLines($cachePath)) {
                if (-not [string]::IsNullOrWhiteSpace($line)) { $cacheLines.Add($line) }
            }
            if ($cacheLines.Count -gt 0) {
                $cacheRecords = ConvertFrom-Json -InputObject ('[' + [string]::Join(',', $cacheLines) + ']') -AsHashtable -NoEnumerate -ErrorAction Stop
                foreach ($entry in $cacheRecords) {
                    if ($entry -isnot [System.Collections.IDictionary] -or $entry['schemaVersion'] -ne 1 -or $entry['path'] -isnot [string]) {
                        throw 'Cache record has an unsupported schema.'
                    }
                    # Preserve exact UTC comparison on all supported PS 7
                    # versions, including those that parse ISO strings as dates.
                    if ($entry['modifiedUtc'] -is [datetime]) { $entry['modifiedUtc'] = $entry['modifiedUtc'].ToUniversalTime().ToString('o') }
                    $cached[$entry['path']] = $entry
                }
                $cacheRecords = $null
            }
            $cacheLines = $null
        } catch {
            $cached.Clear()
            Add-CatalogWarning "Incremental cache could not be read; rebuilding metadata: $($_.Exception.Message)"
        }
    }

    $entries = [System.Collections.Generic.List[object]]::new()
    $seenPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $rootReports = [System.Collections.Generic.List[object]]::new()
    $reusedCount = 0
    $updatedCount = 0
    $skippedReparseCount = 0
    $skippedDirectoryCount = 0
    $enumeratedDirectories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $skippedOverlappingDirectoryCount = 0
    $pendingArchives = [System.Collections.Generic.List[object]]::new()
    $archivePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $pendingArchiveCount = 0
    foreach ($root in $scanRoots) {
        $rootCount = 0
        if (-not [System.IO.Directory]::Exists($root)) {
            Add-CatalogWarning "SFX folder is missing or inaccessible: $root"
            $rootReports.Add([pscustomobject]@{ path = $root; state = 'missing'; count = 0 })
            continue
        }
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($root)
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            if ($enumeratedDirectories.Contains($directory)) {
                $skippedOverlappingDirectoryCount += 1
                continue
            }
            try {
                # Repeat at scan time in case a folder changed after validation.
                Assert-SafeAncestry -Path $directory
                $children = [System.IO.DirectoryInfo]::new($directory).GetFileSystemInfos()
                [void]$enumeratedDirectories.Add($directory)
            } catch {
                $skippedDirectoryCount += 1
                Add-CatalogWarning "Could not enumerate SFX folder: $directory. $($_.Exception.Message)"
                continue
            }
            foreach ($child in $children) {
                if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    $skippedReparseCount += 1
                    continue
                }
                if (($child.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                    $pending.Push($child.FullName)
                    continue
                }
                $extension = $child.Extension.ToLowerInvariant()
                if ($extension -in @('.zip', '.7z', '.rar') -and $archivePaths.Add($child.FullName)) {
                    $pendingArchiveCount += 1
                    if ($pendingArchives.Count -lt 8) {
                        $archivePath = $child.FullName
                        $pathTruncated = $archivePath.Length -gt 512
                        if ($pathTruncated) { $archivePath = $archivePath.Substring(0, 512) }
                        $pendingArchives.Add([pscustomobject]@{
                            path = $archivePath
                            pathTruncated = $pathTruncated
                            name = $child.Name.Substring(0, [math]::Min(128, $child.Name.Length))
                            sizeBytes = $child.Length
                            modifiedUtc = $child.LastWriteTimeUtc.ToString('o')
                            state = 'not-unpacked'
                        })
                    }
                }
                if (-not $extensionSet.Contains($extension) -or -not $seenPaths.Add($child.FullName)) { continue }
                try {
                    $relative = [System.IO.Path]::GetRelativePath($root, $child.FullName).Replace('\', '/')
                    $modifiedUtc = $child.LastWriteTimeUtc.ToString('o')
                    $previous = $null
                    $unchanged = $cached.TryGetValue($child.FullName, [ref]$previous) -and
                        $previous['sizeBytes'] -eq $child.Length -and
                        $previous['modifiedUtc'] -ceq $modifiedUtc -and
                        $previous['root'] -ceq $root -and
                        $previous['relativePath'] -ceq $relative -and
                        $null -ne $previous['tags']
                    if ($unchanged) {
                        $entry = $previous
                        $reusedCount += 1
                    } else {
                        $entry = [pscustomobject][ordered]@{
                            schemaVersion = 1
                            path = $child.FullName
                            name = $child.Name
                            extension = $extension
                            root = $root
                            relativePath = $relative
                            sizeBytes = $child.Length
                            modifiedUtc = $modifiedUtc
                            tags = Get-SearchTags -RelativePath ([System.IO.Path]::ChangeExtension($relative, $null))
                        }
                        $updatedCount += 1
                    }
                    $entries.Add($entry)
                    $rootCount += 1
                } catch {
                    Add-CatalogWarning "Could not read audio file metadata: $($child.FullName). $($_.Exception.Message)"
                }
            }
        }
        $rootReports.Add([pscustomobject]@{ path = $root; state = 'scanned'; count = $rootCount })
    }

    $removedCount = @($cached.Keys | Where-Object { -not $seenPaths.Contains($_) }).Count
    $latestPath = Join-Path $libraryRoot 'latest-sfx.json'
    $settingsFingerprint = Get-SettingsFingerprint -ScanRoots $scanRoots -Extensions @($extensionSet)
    $reusableCatalog = $null
    if ($updatedCount -eq 0 -and $removedCount -eq 0) {
        $reusableCatalog = Get-ReusableCatalog -LatestPath $latestPath -SettingsFingerprint $settingsFingerprint -Count $entries.Count
    }
    $reusedCatalog = $null -ne $reusableCatalog
    $catalogRequestId = $RequestId
    $catalogSessionId = $sessionId
    $catalogPath = Join-Path $sessionRoot "sfx-$RequestId.jsonl"
    $summaryPath = Join-Path $sessionRoot "summary-sfx-$RequestId.json"
    if ($reusedCatalog) {
        $catalogRequestId = $reusableCatalog.catalogRequestId
        $catalogSessionId = $reusableCatalog.catalogSessionId
        $catalogPath = Join-Path $workspaceRoot $reusableCatalog.catalogRelativePath
    } else {
        $textBuilder = [System.Text.StringBuilder]::new()
        foreach ($entry in ($entries | Sort-Object path)) {
            [void]$textBuilder.AppendLine(($entry | ConvertTo-Json -Depth 6 -Compress))
        }
        $catalogText = $textBuilder.ToString()
        Write-AtomicText -Path $catalogPath -Text $catalogText -Immutable
        # Opting out publishes an empty inventory without enumerating folders,
        # reading the incremental cache, or erasing an existing user's cache.
        if ($sfxEnabled) { Write-AtomicText -Path $cachePath -Text $catalogText }
    }
    $summary = [pscustomobject][ordered]@{
        schemaVersion = 1
        kind = 'disk-sfx'
        requestId = $RequestId
        sessionId = $sessionId
        state = 'success'
        enabled = $sfxEnabled
        skipped = -not $sfxEnabled
        startedUtc = $startedUtc.ToString('o')
        completedUtc = [datetime]::UtcNow.ToString('o')
        durationMs = [math]::Round(([datetime]::UtcNow - $startedUtc).TotalMilliseconds)
        count = $entries.Count
        reusedCount = $reusedCount
        updatedCount = $updatedCount
        removedCount = $removedCount
        reusedCatalog = $reusedCatalog
        catalogRequestId = $catalogRequestId
        catalogSessionId = $catalogSessionId
        skippedReparseCount = $skippedReparseCount
        skippedDirectoryCount = $skippedDirectoryCount
        enumeratedDirectoryCount = $enumeratedDirectories.Count
        skippedOverlappingDirectoryCount = $skippedOverlappingDirectoryCount
        pendingArchiveCount = $pendingArchiveCount
        pendingArchives = $pendingArchives.ToArray()
        pendingArchivesOmittedCount = $pendingArchiveCount - $pendingArchives.Count
        roots = $rootReports.ToArray()
        extensions = @($extensionSet | Sort-Object)
        warningCount = $warningTotal
        warnings = $warningItems.ToArray()
        warningsOmittedCount = $warningTotal - $warningItems.Count
        metadataOnly = $true
    }
    # AE reads this compact file instead of loading a potentially large JSONL
    # catalog. Keep even unusually long Unicode paths below the bridge limit.
    do {
        $summaryJson = $summary | ConvertTo-Json -Depth 12 -Compress
        if ($utf8.GetByteCount($summaryJson) -le 60000) { break }
        if ($summary.pendingArchives.Count -gt 0) {
            $summary.pendingArchives = @($summary.pendingArchives | Select-Object -SkipLast 1)
            $summary.pendingArchivesOmittedCount += 1
        } elseif ($summary.warnings.Count -gt 0) {
            $summary.warnings = @($summary.warnings | Select-Object -SkipLast 1)
            $summary.warningsOmittedCount += 1
        } else { throw 'SFX root summary exceeds the 60 KB bridge metadata limit.' }
    } while ($true)
    Write-AtomicText -Path $summaryPath -Text $summaryJson -Immutable
    $status = [pscustomobject][ordered]@{
        schemaVersion = 1
        kind = 'disk-sfx'
        state = 'success'
        enabled = $sfxEnabled
        skipped = -not $sfxEnabled
        requestId = $RequestId
        sessionId = $sessionId
        completedUtc = $summary.completedUtc
        reusedCatalog = $reusedCatalog
        catalogRequestId = $catalogRequestId
        catalogSessionId = $catalogSessionId
        catalogRelativePath = [System.IO.Path]::GetRelativePath($workspaceRoot, $catalogPath).Replace('\', '/')
        summaryRelativePath = [System.IO.Path]::GetRelativePath($workspaceRoot, $summaryPath).Replace('\', '/')
        count = $entries.Count
        reusedCount = $reusedCount
        updatedCount = $updatedCount
        rootCount = $rootReports.Count
        pendingArchiveCount = $pendingArchiveCount
        warningCount = $warningTotal
        warnings = $warningItems.ToArray()
        warningsOmittedCount = $warningTotal - $warningItems.Count
        errors = @()
        metadataOnly = $true
    }
    $latestPointer = [pscustomobject][ordered]@{
        schemaVersion = 1
        kind = 'disk-sfx'
        state = 'success'
        enabled = $sfxEnabled
        skipped = -not $sfxEnabled
        requestId = $RequestId
        sessionId = $sessionId
        completedUtc = $summary.completedUtc
        catalogRequestId = $catalogRequestId
        catalogSessionId = $catalogSessionId
        catalogRelativePath = $status.catalogRelativePath
        summaryRelativePath = $status.summaryRelativePath
        count = $entries.Count
        rootCount = $rootReports.Count
        pendingArchiveCount = $pendingArchiveCount
        settingsFingerprint = $settingsFingerprint
        metadataOnly = $true
    }
    Write-AtomicJson -Path $latestPath -Object $latestPointer
    Write-AtomicJson -Path $statusPath -Object $status -Immutable
    $status | ConvertTo-Json -Depth 12 -Compress
} catch {
    $errorMessage = $_.Exception.Message
    if ($errorMessage.Length -gt 1000) { $errorMessage = $errorMessage.Substring(0, 1000) }
    $failure = [pscustomobject][ordered]@{
        schemaVersion = 1
        kind = 'disk-sfx'
        state = 'error'
        requestId = $RequestId
        sessionId = $sessionId
        completedUtc = [datetime]::UtcNow.ToString('o')
        warningCount = $warningTotal
        warnings = $warningItems.ToArray()
        errors = @($errorMessage)
        error = $errorMessage
        metadataOnly = $true
    }
    if ($null -ne $statusPath -and -not [System.IO.File]::Exists($statusPath)) {
        try { Write-AtomicJson -Path $statusPath -Object $failure -Immutable } catch { }
    }
    $failure | ConvertTo-Json -Depth 12 -Compress
    exit 1
} finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
}
