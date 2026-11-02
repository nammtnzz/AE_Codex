[CmdletBinding(DefaultParameterSetName = 'Script')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Script')]
    [string]$Script,

    [Parameter(Mandatory = $true, ParameterSetName = 'Branch')]
    [string]$Branch,

    [Parameter(Mandatory = $true, ParameterSetName = 'Function')]
    [string]$FunctionRequestJson,

    [ValidateRange(5, 900)]
    [int]$TimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-IsPathInside {
    param(
        [Parameter(Mandatory = $true)][string]$ParentPath,
        [Parameter(Mandatory = $true)][string]$ChildPath
    )

    $relative = [System.IO.Path]::GetRelativePath($ParentPath, $ChildPath)
    return -not (
        [System.IO.Path]::IsPathRooted($relative) -or
        $relative -eq '..' -or
        $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::Ordinal)
    )
}

function Read-JsonFileWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(1, 20)][int]$Attempts = 5,
        [ValidateRange(1, 2000)][int]$DelayMilliseconds = 40,
        [switch]$AllowMissing
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            $lastError = "File is not present: $Path"
        } else {
            try {
                $raw = [System.IO.File]::ReadAllText($Path)
                return ($raw | ConvertFrom-Json -ErrorAction Stop)
            } catch [System.UnauthorizedAccessException] {
                throw "Access denied while reading JSON file: $Path"
            } catch {
                $lastError = $_.Exception.Message
            }
        }

        if ($attempt -lt $Attempts) {
            Start-Sleep -Milliseconds ($DelayMilliseconds * $attempt)
        }
    }

    if ($AllowMissing -and -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    throw "Cannot read valid JSON after $Attempts attempts: $Path. Last error: $lastError"
}

function Get-OptionalJsonProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        $Default = $null
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $Default
    }
    return $property.Value
}

function Assert-NoReparsePointWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root)
    $current = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-IsPathInside -ParentPath $rootFull -ChildPath $current)) {
        throw "Path is outside the allowed root: $current"
    }

    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $attributes = [System.IO.File]::GetAttributes($current)
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Aliases, symbolic links, and junctions are not allowed: $current"
            }
        }
        if ($current.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }

        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent -or -not (Test-IsPathInside -ParentPath $rootFull -ChildPath $parent.FullName)) {
            throw "Cannot validate path ancestry inside the allowed root: $Path"
        }
        $current = $parent.FullName
    }
}

function Resolve-CompletedRunningMarkers {
    param(
        [Parameter(Mandatory = $true)][string]$InboxRoot,
        [Parameter(Mandatory = $true)][string]$ResultRoot
    )

    $runningJobs = @(Get-ChildItem -LiteralPath $InboxRoot -Filter '*.running' -File -ErrorAction SilentlyContinue)
    foreach ($runningJob in $runningJobs) {
        if ($runningJob.Name -notmatch '^job-([A-Za-z0-9-]{8,80})\.running$') {
            throw "An unrecognized running marker requires manual inspection: $($runningJob.FullName)"
        }

        $markerRunId = $Matches[1]
        $terminalPath = Join-Path $ResultRoot ("status-$markerRunId.json")
        if (-not (Test-Path -LiteralPath $terminalPath -PathType Leaf)) {
            throw "A previous bridge job may still be active: $($runningJob.FullName)"
        }

        $terminal = Read-JsonFileWithRetry -Path $terminalPath
        $completionKnown = [bool](Get-OptionalJsonProperty -Object $terminal -Name 'completionKnown' -Default $true)
        if ($terminal.schema -notin @('codex-ae-run/v1', 'codex-ae-run/v2') -or
            $terminal.mode -ne 'file-bridge' -or
            $terminal.runId -ne $markerRunId -or
            $terminal.state -notin @('success', 'error') -or
            -not $completionKnown) {
            throw "Running marker has no trustworthy terminal result: $($runningJob.FullName)"
        }

        try {
            Remove-Item -LiteralPath $runningJob.FullName -Force -ErrorAction Stop
        } catch {
            if (Test-Path -LiteralPath $runningJob.FullName -PathType Leaf) {
                throw "Terminal result exists, but the completed running marker could not be cleaned: $($runningJob.FullName). $($_.Exception.Message)"
            }
        }
    }
}

$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$jsxRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot 'jsx'))
try {
    & (Join-Path $PSScriptRoot 'Sync-CodexModelDisplay.ps1') | Out-Null
} catch {
    Write-Warning "Model display could not be refreshed: $($_.Exception.Message)"
}

$isFunctionRequest = $PSCmdlet.ParameterSetName -eq 'Function'
$operationLabel = if ($isFunctionRequest) { 'function plan' } else { 'JSX' }
$scriptTarget = $null
$normalizedFunctionRequest = $null
if ($isFunctionRequest) {
    . (Join-Path $PSScriptRoot 'AeFunctionRequest.ps1')
    $normalizedFunctionRequest = ConvertTo-AeFunctionRequest -Json $FunctionRequestJson -CatalogPath (Join-Path $workspaceRoot '.ae-codex/functions/catalog.json')
    $parsedFunctionRequest = ConvertFrom-Json -InputObject $normalizedFunctionRequest -AsHashtable -Depth 64
    $functionNames = @($parsedFunctionRequest.steps | ForEach-Object { $_.function })
    $scriptPath = 'function:' + ($functionNames -join ',')
    $relativeScriptPath = $scriptPath
    $bundlePath = Join-Path $jsxRoot 'Codex Bridge.jsx'
    Assert-NoReparsePointWithin -Root $workspaceRoot -Path $bundlePath
    if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) { throw "Installed function bundle is missing: $bundlePath" }
} else {
    . (Join-Path $PSScriptRoot 'Resolve-AeScriptTarget.ps1')
    $scriptTarget = Resolve-AeScriptTarget -WorkspaceRoot $workspaceRoot -Script $Script -Branch $Branch
    $scriptPath = $scriptTarget.Path
    $relativeScriptPath = $scriptTarget.RelativePath
    if ([System.IO.Path]::GetExtension($scriptPath) -ne '.jsx') {
        throw 'Only .jsx scripts are accepted.'
    }
    if (-not (Test-IsPathInside -ParentPath $jsxRoot -ChildPath $scriptPath)) {
        throw "For safety, scripts must be inside: $jsxRoot"
    }
    if (-not ([System.IO.Path]::GetFullPath((Split-Path -Parent $scriptPath))).Equals(
            $jsxRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "For safety, scripts must be direct children of: $jsxRoot"
    }
    Assert-NoReparsePointWithin -Root $workspaceRoot -Path $scriptPath
    if ($scriptTarget.Bundled) { Assert-NoReparsePointWithin -Root $workspaceRoot -Path (Join-Path $jsxRoot 'Codex Bridge.jsx') }
}

$bridgeRoot = Join-Path $workspaceRoot '.ae-codex\bridge'
$inboxRoot = Join-Path $bridgeRoot 'inbox'
$resultRoot = Join-Path $bridgeRoot 'results'
$heartbeatPath = Join-Path $bridgeRoot 'heartbeat.json'
$lockPath = Join-Path $bridgeRoot 'submit.lock'
$lockOwnerPath = Join-Path $lockPath 'owner.json'
New-Item -ItemType Directory -Force -Path $inboxRoot, $resultRoot | Out-Null

$directRunnerLock = Join-Path $workspaceRoot '.ae-codex\active.lock'
if (Test-Path -LiteralPath $directRunnerLock -PathType Container) {
    throw "The direct AfterFX runner has an active or unknown run: $directRunnerLock"
}

if (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) {
    throw (
        'Codex AE Bridge is not running. Open After Effects and Window > Codex Bridge; ' +
        'the updated panel connects automatically.'
    )
}

try {
    $heartbeat = Read-JsonFileWithRetry -Path $heartbeatPath
    $heartbeatAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$heartbeat.timestampEpochMs
} catch {
    throw "Cannot read bridge heartbeat: $($_.Exception.Message)"
}

$catalogPath = Join-Path $workspaceRoot '.ae-codex/functions/catalog.json'
$expectedBridgeVersion = $null
if (Test-Path -LiteralPath $catalogPath -PathType Leaf) {
    try {
        $catalog = Read-JsonFileWithRetry -Path $catalogPath
        if ($catalog.schema -eq 'codex-ae-functions-catalog/v1' -and
            -not [string]::IsNullOrWhiteSpace([string]$catalog.bridgeVersion)) {
            $expectedBridgeVersion = [string]$catalog.bridgeVersion
        }
    } catch {
        throw "Cannot read installed AE function catalog: $($_.Exception.Message)"
    }
}

if ($heartbeat.schema -ne 'codex-ae-heartbeat/v1') {
    throw "Unsupported bridge heartbeat schema: $($heartbeat.schema)"
}
$heartbeatWorkspaceRoot = [string](Get-OptionalJsonProperty -Object $heartbeat -Name 'workspaceRoot' -Default '')
if ([string]::IsNullOrWhiteSpace($heartbeatWorkspaceRoot)) {
    throw 'Codex AE Bridge heartbeat has no workspace binding. Close and reopen the installed Codex AE panel; no job was dispatched.'
}
try {
    $heartbeatWorkspaceFull = [System.IO.Path]::GetFullPath($heartbeatWorkspaceRoot)
} catch {
    throw "Codex AE Bridge heartbeat has an invalid workspace binding: $heartbeatWorkspaceRoot"
}
if (-not $heartbeatWorkspaceFull.Equals($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw (
        "Codex AE Bridge workspace does not match the installed runtime (heartbeat=$heartbeatWorkspaceFull, " +
        "expected=$workspaceRoot). Close and reopen the installed Codex AE panel; no job was dispatched."
    )
}
if ($expectedBridgeVersion -and [string]$heartbeat.bridgeVersion -cne $expectedBridgeVersion) {
    throw (
        "Codex AE Bridge version does not match the installed catalog (heartbeat=$($heartbeat.bridgeVersion), " +
        "expected=$expectedBridgeVersion). Close and reopen the updated Codex AE panel; no job was dispatched."
    )
}
if ($isFunctionRequest -and [version]$heartbeat.bridgeVersion -lt [version]'1.8.0') {
    throw 'Named functions require Bridge 1.8.0 or later. Close and reopen the updated Codex Bridge panel. No job was dispatched.'
}
if (-not $isFunctionRequest -and $scriptTarget.Bundled -and [version]$heartbeat.bridgeVersion -lt [version]'1.6.0') {
    throw 'Merged branches require Bridge 1.6.0 or later. Close and reopen the updated Codex Bridge panel to connect automatically. No job was dispatched.'
}

if ($heartbeat.state -ne 'running' -or $heartbeatAgeMs -lt -5000 -or $heartbeatAgeMs -gt 10000) {
    throw (
        "Codex AE Bridge heartbeat is not current (state=$($heartbeat.state), ageMs=$heartbeatAgeMs). " +
        "Version=$($heartbeat.bridgeVersion), startup=$($heartbeat.startupStage) " +
        "($($heartbeat.startupPercent)%); message=$($heartbeat.message). " +
        'In the Codex AE Bridge panel, use Reconnect; reinstall/reopen the panel if it remains stale.'
    )
}

if ([string]::IsNullOrWhiteSpace([string]$heartbeat.sessionNonce) -or
    [string]$heartbeat.sessionNonce -notmatch '^[A-Za-z0-9-]{8,80}$') {
    throw 'Codex AE Bridge heartbeat has an invalid session nonce. Restart the bridge palette.'
}

$sessionNonce = [string]$heartbeat.sessionNonce

Resolve-CompletedRunningMarkers -InboxRoot $inboxRoot -ResultRoot $resultRoot

$runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$statusPath = Join-Path $resultRoot ("status-$runId.json")
$startedPath = Join-Path $resultRoot ("started-$runId.json")
$requestPath = Join-Path $inboxRoot ("job-$runId.job")
$runningPath = Join-Path $inboxRoot ("job-$runId.running")
$temporaryRequestPath = "$requestPath.tmp"

try {
    New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
} catch {
    if (Test-Path -LiteralPath $lockPath -PathType Container) {
        $ownerDescription = 'Owner information is unavailable.'
        if (Test-Path -LiteralPath $lockOwnerPath -PathType Leaf) {
            try {
                $ownerDescription = [System.IO.File]::ReadAllText($lockOwnerPath)
            } catch {
                $ownerDescription = "Owner information could not be read: $($_.Exception.Message)"
            }
        }
        throw "Another bridge submission may still be active. Lock: $lockPath`n$ownerDescription"
    }
    throw "Cannot create bridge submission lock at $lockPath. This is a filesystem/permission error, not a busy lock: $($_.Exception.Message)"
}

$lockOwned = $true
$dispatched = $false
$terminalStateObserved = $false

try {
    [ordered]@{
        schema = 'codex-ae-bridge-lock/v1'
        runId = $runId
        sessionNonce = $sessionNonce
        runnerPid = $PID
        script = $scriptPath
        requestPath = $requestPath
        runningPath = $runningPath
        startedPath = $startedPath
        statusPath = $statusPath
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $lockOwnerPath -Encoding utf8NoBOM

    if ($isFunctionRequest) {
        $request = @(
            'schema=codex-ae-job/v2'
            "runId=$runId"
            "sessionNonce=$sessionNonce"
            ('request=' + [Uri]::EscapeDataString($normalizedFunctionRequest))
        ) -join "`n"
    } else {
        $request = @(
            'schema=codex-ae-job/v1'
            "runId=$runId"
            "sessionNonce=$sessionNonce"
            "script=$relativeScriptPath"
            ''
        ) -join "`n"
    }

    [System.IO.File]::WriteAllText($temporaryRequestPath, $request, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryRequestPath -Destination $requestPath
    $dispatched = $true

    Write-Host "Run ID: $runId"
    Write-Host "Submitted to Codex AE Bridge: $relativeScriptPath"
    Write-Host "Waiting for: $statusPath"

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastState = $null
    $lastPhase = 'queued'

    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $startedPath -PathType Leaf) {
            $lastPhase = 'evaluating-or-reporting'
        } elseif (Test-Path -LiteralPath $runningPath -PathType Leaf) {
            $lastPhase = 'claimed-preflight'
        } elseif (Test-Path -LiteralPath $requestPath -PathType Leaf) {
            $lastPhase = 'queued'
        }

        if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
            $status = Read-JsonFileWithRetry -Path $statusPath
            if ($status.schema -notin @('codex-ae-run/v1', 'codex-ae-run/v2')) {
                throw "Unsupported bridge status schema: $($status.schema)"
            }
            if ($status.runId -ne $runId -or $status.sessionNonce -ne $sessionNonce) {
                throw 'Bridge status identity does not match the submitted job.'
            }
            $lastState = $status.state
            $lastPhase = [string](Get-OptionalJsonProperty -Object $status -Name 'phase' -Default $lastPhase)

            if ($status.state -eq 'success') {
                $terminalStateObserved = $true
                $status | ConvertTo-Json -Depth 64
                return
            }

            if ($status.state -eq 'error') {
                $terminalStateObserved = $true
                $errorCode = [string](Get-OptionalJsonProperty -Object $status -Name 'errorCode' -Default 'JSX_FAILED')
                $completionKnown = [bool](Get-OptionalJsonProperty -Object $status -Name 'completionKnown' -Default $true)
                throw (
                    "After Effects $operationLabel failed (code=$errorCode, phase=$lastPhase, " +
                    "completionKnown=$completionKnown): $($status.message)"
                )
            }

            if ($status.state -eq 'running' -and $status.schema -eq 'codex-ae-run/v1') {
                # Backward compatibility while upgrading a pre-1.3.2 panel.
                $lastPhase = 'evaluating'
                Start-Sleep -Milliseconds 250
                continue
            }

            throw "Unexpected terminal status state '$($status.state)' for run $runId."
        }

        Start-Sleep -Milliseconds 250
    }

    $stateHint = if ($lastState) { " Last state: $lastState." } else { '' }
    $resetCommand = (
        "pwsh -NoProfile -File .\tools\Reset-AeBridgeLock.ps1 " +
        "-RunId $runId -IHaveVerifiedAfterEffectsIsIdle"
    )
    throw (
        "Timed out after $TimeoutSeconds seconds waiting for the AE bridge.$stateHint " +
        "Phase=$lastPhase. The $operationLabel must not be submitted again automatically because it may already " +
        "have changed the project. Submission lock retained: $lockPath. After verifying in After " +
        "Effects that the run is idle, reset only this run with: $resetCommand"
    )
} finally {
    if ($lockOwned -and ((-not $dispatched) -or $terminalStateObserved)) {
        if (Test-Path -LiteralPath $lockOwnerPath -PathType Leaf) {
            Remove-Item -LiteralPath $lockOwnerPath -Force
        }
        if (Test-Path -LiteralPath $lockPath -PathType Container) {
            Remove-Item -LiteralPath $lockPath -Force
        }
    } elseif ($lockOwned) {
        Write-Warning "Bridge completion is unknown. Lock retained at: $lockPath"
    }
}
