#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testId = [guid]::NewGuid().ToString('N')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) "Codex AE helper $testId/Máy mới & 100% O'Brien"
$tools = Join-Path $fixtureRoot 'tools'
$library = Join-Path $fixtureRoot '.ae-codex/library'
$requests = Join-Path $library 'requests'
$reportRoot = Join-Path $workspace ".ae-codex/tests-background-launcher/$testId"
[void][IO.Directory]::CreateDirectory($tools)
[void][IO.Directory]::CreateDirectory($reportRoot)
foreach ($name in @('Initialize-AeLibrary.ps1', 'AeBackgroundLauncher.cs')) {
    Copy-Item -LiteralPath (Join-Path $workspace "tools/$name") -Destination (Join-Path $tools $name)
}
$pwsh = (Get-Process -Id $PID).Path
$initializer = Join-Path $tools 'Initialize-AeLibrary.ps1'
$checks = [Collections.Generic.List[string]]::new()
function Assert-Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAILED: $Message" }
    $checks.Add($Message)
}
function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
}
function Initialize-Fixture([string[]]$Arguments = @()) {
    $output = @(& $pwsh -NoProfile -File $initializer -SkipScan @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Initializer failed: $($output -join ' ')" }
    return (($output -join "`n") | ConvertFrom-Json -ErrorAction Stop)
}
$initialized = Initialize-Fixture
$runtimePath = Join-Path $library 'runtime.json'
$runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
$exe = $runtime.backgroundLauncherPath
Assert-Check ($initialized.state -eq 'success' -and (Test-Path -LiteralPath $exe -PathType Leaf)) 'Setup compiles the native background executable into the recipient runtime.'
$bytes = [IO.File]::ReadAllBytes($exe)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
Assert-Check ([BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68) -eq 2) 'The executable PE header uses Windows subsystem, never console subsystem.'
$exeWritten = [IO.File]::GetLastWriteTimeUtc($exe)
$certificate = [IO.File]::ReadAllText((Join-Path $library 'background-launcher.json'))
$null = Initialize-Fixture
Assert-Check ([IO.File]::GetLastWriteTimeUtc($exe) -eq $exeWritten -and [IO.File]::ReadAllText((Join-Path $library 'background-launcher.json')) -ceq $certificate) 'Unchanged initialization reuses the verified launcher without recompiling.'
Assert-Check (-not (Test-Path -LiteralPath (Join-Path $library 'sessions'))) 'Initialization does not launch a catalog worker or create an inventory session.'
[void][IO.Directory]::CreateDirectory($requests)
$normalHelper = @'
param([string]$RequestId)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$libraryRoot = Join-Path $workspaceRoot '.ae-codex/library'
$request = [IO.File]::ReadAllText((Join-Path $libraryRoot "requests/sfx-$RequestId.json")) | ConvertFrom-Json
Add-Type 'using System; using System.Runtime.InteropServices; public static class FixtureConsole { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
$probe = @{id=$RequestId;workspace=$workspaceRoot;consoleWindow=[FixtureConsole]::GetConsoleWindow().ToInt64();pid=$PID;priorityClass=[Diagnostics.Process]::GetCurrentProcess().PriorityClass.ToString()}
[IO.File]::WriteAllText((Join-Path $libraryRoot "probe-$RequestId.json"), ($probe | ConvertTo-Json -Compress))
[IO.File]::AppendAllText((Join-Path $libraryRoot "count-$RequestId.log"), "worker`n")
Start-Sleep -Milliseconds 1600
$statusPath = Join-Path $libraryRoot "sessions/$($request.sessionId)/status-sfx-$RequestId.json"
$status = @{schemaVersion=1;kind='disk-sfx';state='success';requestId=$RequestId;sessionId=$request.sessionId;metadataOnly=$true}
[IO.File]::WriteAllText($statusPath, ($status | ConvertTo-Json -Compress))
Write-Output ('x' * 16384)
'@
$helperPath = Join-Path $tools 'Update-AeSfxCatalog.ps1'
[IO.File]::WriteAllText($helperPath, $normalHelper)
function New-Request([string]$Id, [string]$RequestWorkspace = $fixtureRoot, [switch]$DoNotSelect) {
    Write-Json (Join-Path $requests "sfx-$Id.json") @{schemaVersion=1;requestId=$Id;sessionId='fixture-session-1234';workspaceRoot=$RequestWorkspace}
    if (-not $DoNotSelect) { Write-Json (Join-Path $requests 'pending-launch.json') @{schemaVersion=1;requestId=$Id;sessionId='fixture-session-1234'} }
}
function Launch-Fixture {
    # Shell activation matches AE File.execute(), with no command arguments.
    $start = [Diagnostics.ProcessStartInfo]::new($exe)
    $start.UseShellExecute = $true
    $start.WorkingDirectory = $fixtureRoot
    return [Diagnostics.Process]::Start($start)
}
function Wait-Fixture($Process) {
    if (-not $Process.WaitForExit(20000)) { throw 'Fixture launcher did not terminate in 20 seconds.' }
    $Process.WaitForExit()
    if ($Process.ExitCode -ne 0) { throw "Fixture launcher exit code: $($Process.ExitCode)" }
    $Process.Dispose()
}
function Read-Ack([string]$Id) {
    return ([IO.File]::ReadAllText((Join-Path $requests "launch-sfx-$Id.json")) | ConvertFrom-Json)
}
$normalId = 'normal-request-1234'
New-Request 'stale-unlaunched-1234' -DoNotSelect
New-Request $normalId
$first = Launch-Fixture
$second = Launch-Fixture
Wait-Fixture $first
Wait-Fixture $second
$ack = Read-Ack $normalId
$probe = [IO.File]::ReadAllText((Join-Path $library "probe-$normalId.json")) | ConvertFrom-Json
$terminal = [IO.File]::ReadAllText((Join-Path $library "sessions/fixture-session-1234/status-sfx-$normalId.json")) | ConvertFrom-Json
Assert-Check ($ack.state -eq 'launched' -and $ack.processId -gt 0 -and $ack.sessionId -ceq 'fixture-session-1234') 'A launched acknowledgement contains the exact request, session, and worker process identity.'
Assert-Check ($terminal.state -eq 'success' -and $probe.workspace -ceq $fixtureRoot) 'Direct process arguments preserve Unicode, spaces, ampersand, percent, and apostrophes in recipient paths.'
Assert-Check ($probe.consoleWindow -eq 0) 'The PowerShell worker has no console window.'
Assert-Check (-not (Test-Path -LiteralPath (Join-Path $requests 'launch-sfx-stale-unlaunched-1234.json')) -and -not (Test-Path -LiteralPath (Join-Path $library 'count-stale-unlaunched-1234.log'))) 'The explicit pointer dispatches only its selected request and never discovers stale unlaunched history.'
Assert-Check (([IO.File]::ReadAllLines((Join-Path $library "count-$normalId.log"))).Count -eq 1) 'Concurrent native launcher invocations execute an immutable request once.'
$ackText = [IO.File]::ReadAllText((Join-Path $requests "launch-sfx-$normalId.json"))
Wait-Fixture (Launch-Fixture)
Assert-Check (([IO.File]::ReadAllLines((Join-Path $library "count-$normalId.log"))).Count -eq 1 -and [IO.File]::ReadAllText((Join-Path $requests "launch-sfx-$normalId.json")) -ceq $ackText) 'Repeated invocation preserves the original acknowledgement and never replays a completed worker.'

$badId = 'missing-runtime-1234'
New-Request $badId
$goodPowerShell = $runtime.powerShellPath
$runtime.powerShellPath = Join-Path $fixtureRoot 'missing/pwsh.exe'
Write-Json $runtimePath $runtime
Wait-Fixture (Launch-Fixture)
$badAck = Read-Ack $badId
Assert-Check ($badAck.state -eq 'error' -and $badAck.sessionId -ceq 'fixture-session-1234' -and $badAck.error -match 'PowerShell 7') 'A missing worker runtime produces an immediate, readable launch error.'
$badAckText = [IO.File]::ReadAllText((Join-Path $requests "launch-sfx-$badId.json"))
Wait-Fixture (Launch-Fixture)
Assert-Check ([IO.File]::ReadAllText((Join-Path $requests "launch-sfx-$badId.json")) -ceq $badAckText) 'A failed launch acknowledgement is immutable and does not automatically retry.'
$runtime.powerShellPath = $goodPowerShell
Write-Json $runtimePath $runtime

$foreignId = 'foreign-request-1234'
New-Request $foreignId ([IO.Path]::GetTempPath())
Wait-Fixture (Launch-Fixture)
$foreignAck = Read-Ack $foreignId
Assert-Check ($foreignAck.state -eq 'error' -and $foreignAck.error -match 'different workspace' -and -not (Test-Path -LiteralPath (Join-Path $library "probe-$foreignId.json"))) 'A request cannot select a different workspace or dispatch an external script.'

$faultId = 'failed-worker-1234'
New-Request $faultId
[IO.File]::WriteAllText($helperPath, "param([string]`$RequestId)`nWrite-Error 'Synthetic early worker failure: no catalog was scanned.'`nexit 17`n")
Wait-Fixture (Launch-Fixture)
$faultAck = Read-Ack $faultId
$fault = [IO.File]::ReadAllText((Join-Path $library "sessions/fixture-session-1234/status-sfx-$faultId.json")) | ConvertFrom-Json
Assert-Check ($faultAck.state -eq 'launched' -and $fault.state -eq 'error' -and $fault.exitCode -eq 17 -and $fault.errorCode -ceq 'sfx-helper-exit-without-status' -and $fault.error -match 'Synthetic early worker failure') 'A worker that fails before publishing status receives a terminal error with captured stderr.'
$errorLog = [IO.File]::ReadAllText((Join-Path $library 'launcher-errors.log'))
Assert-Check ($errorLog -match 'PowerShell 7' -and $errorLog -match 'Synthetic early worker failure') 'Launch and early worker failures are retained in the bounded local error log.'

# Source or executable changes invalidate setup caching. No AE process is involved.
[IO.File]::AppendAllText((Join-Path $tools 'AeBackgroundLauncher.cs'), "`n// fixture source revision`n")
$null = Initialize-Fixture
$newCertificate = [IO.File]::ReadAllText((Join-Path $library 'background-launcher.json')) | ConvertFrom-Json
Assert-Check ($newCertificate.sourceSha256 -ceq (Get-FileHash -LiteralPath (Join-Path $tools 'AeBackgroundLauncher.cs') -Algorithm SHA256).Hash.ToLowerInvariant() -and [IO.File]::GetLastWriteTimeUtc($exe) -gt $exeWritten) 'A changed launcher source is rebuilt during update and receives a new checksum certificate.'

# Resident mode receives JSON pointers without AE executing any external file.
$runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
Assert-Check ($runtime.backgroundServiceVersion -eq 1 -and $runtime.backgroundLauncherSha256 -ceq (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()) 'The runtime records a resident protocol version and executable identity.'
[IO.File]::WriteAllText($helperPath, $normalHelper)
$servicePath = Join-Path $library 'background-service.json'
$stopPath = Join-Path $library 'background-service.stop'
function Wait-JsonFile([string]$Path) {
    $deadline = [datetime]::UtcNow.AddSeconds(12)
    while ([datetime]::UtcNow -lt $deadline) {
        if ([IO.File]::Exists($Path)) {
            try { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop) } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Fixture JSON was not published: $Path"
}
function Wait-ProcessExit([int]$ProcessId) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return }
    try { if (-not $process.WaitForExit(12000)) { throw "Fixture service $ProcessId did not stop gracefully." } } finally { $process.Dispose() }
}
try {
    $oldLoginId = 'old-login-request-1234'
    New-Request $oldLoginId
    [IO.File]::SetLastWriteTimeUtc((Join-Path $requests 'pending-launch.json'), [datetime]::UtcNow.AddMinutes(-10))
    $started = Initialize-Fixture -Arguments @('-StartBackgroundService')
    $residentPid = [int]$started.backgroundService.processId
    $resident = Get-Process -Id $residentPid -ErrorAction Stop
    try { Assert-Check ($started.backgroundService.state -ceq 'ready' -and $resident.MainWindowHandle -eq 0 -and $started.backgroundService.launcherSha256 -ceq $runtime.backgroundLauncherSha256) 'Explicit setup activation starts the exact resident as a GUI process without a console window.' } finally { $resident.Dispose() }
    Start-Sleep -Milliseconds 1200
    Assert-Check (-not [IO.File]::Exists((Join-Path $requests "launch-sfx-$oldLoginId.json"))) 'A resident started at logon ignores an abandoned pointer from a previous session.'
    $duplicateStart = [Diagnostics.ProcessStartInfo]::new($exe, '--serve')
    $duplicateStart.UseShellExecute = $false
    $duplicateStart.CreateNoWindow = $true
    $duplicate = [Diagnostics.Process]::Start($duplicateStart)
    Wait-Fixture $duplicate
    $singleton = [IO.File]::ReadAllText($servicePath) | ConvertFrom-Json
    Assert-Check ([int]$singleton.processId -eq $residentPid) 'A second --serve invocation exits without replacing the workspace singleton.'

    $residentId = 'resident-request-1234'
    New-Request $residentId
    $residentAck = Wait-JsonFile (Join-Path $requests "launch-sfx-$residentId.json")
    $residentTerminal = Wait-JsonFile (Join-Path $library "sessions/fixture-session-1234/status-sfx-$residentId.json")
    $residentProbe = Wait-JsonFile (Join-Path $library "probe-$residentId.json")
    Assert-Check ($residentAck.state -eq 'launched' -and $residentTerminal.state -eq 'success' -and $residentProbe.consoleWindow -eq 0) 'A new JSON pointer alone launches and completes a hidden worker without starting another executable from AE.'
    Assert-Check ($residentProbe.priorityClass -ceq 'BelowNormal') 'Metadata workers run below normal priority so interactive AE work wins CPU contention.'
    [IO.File]::SetLastWriteTimeUtc((Join-Path $requests 'pending-launch.json'), [datetime]::UtcNow)
    Start-Sleep -Milliseconds 1100
    Assert-Check (([IO.File]::ReadAllLines((Join-Path $library "count-$residentId.log"))).Count -eq 1) 'Pointer notifications do not replay an acknowledged resident request.'

    $churnId = 'churn-request-1234'
    New-Request $churnId -DoNotSelect
    $pointerPath = Join-Path $requests 'pending-launch.json'
    $pointerTemp = Join-Path $requests 'pointer-race.tmp'
    $pointerText = @{schemaVersion=1;requestId=$churnId;sessionId='fixture-session-1234'} | ConvertTo-Json -Compress
    for ($attempt = 0; $attempt -lt 400; $attempt++) {
        [IO.File]::WriteAllText($pointerTemp, $pointerText)
        [IO.File]::Move($pointerTemp, $pointerPath, $true)
        [IO.File]::Delete($pointerPath)
    }
    Write-Json $pointerPath @{schemaVersion=1;requestId=$churnId;sessionId='fixture-session-1234'}
    $churnTerminal = Wait-JsonFile (Join-Path $library "sessions/fixture-session-1234/status-sfx-$churnId.json")
    $aliveAfterChurn = Get-Process -Id $residentPid -ErrorAction Stop
    try { Assert-Check (-not $aliveAfterChurn.HasExited -and $churnTerminal.state -eq 'success' -and ([IO.File]::ReadAllLines((Join-Path $library "count-$churnId.log"))).Count -eq 1) 'Rapid atomic pointer replacement and removal leave the resident alive and dispatch the selected request once.' } finally { $aliveAfterChurn.Dispose() }

    # Force ack publication to fail after Start(). The child must remain owned
    # through Stop and receive its terminal fallback after an early error exit.
    $ackFailureId = 'ack-publication-failure-1234'
    [void][IO.Directory]::CreateDirectory((Join-Path $requests "launch-sfx-$ackFailureId.json"))
    $ackFailureHelper = @'
param([string]$RequestId)
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$libraryRoot = Join-Path $workspaceRoot '.ae-codex/library'
[IO.File]::AppendAllText((Join-Path $libraryRoot "count-$RequestId.log"), "worker`n")
[IO.File]::WriteAllText((Join-Path $libraryRoot "probe-$RequestId.json"), '{"started":true}')
Start-Sleep -Milliseconds 2200
Write-Error 'Synthetic child failed after launch acknowledgement publication failed.'
exit 23
'@
    [IO.File]::WriteAllText($helperPath, $ackFailureHelper)
    New-Request $ackFailureId
    $null = Wait-JsonFile (Join-Path $library "probe-$ackFailureId.json")
    $stoppedAfterAckFailure = Initialize-Fixture -Arguments @('-StopBackgroundService')
    Wait-ProcessExit $residentPid
    $ackFailureStatus = Wait-JsonFile (Join-Path $library "sessions/fixture-session-1234/status-sfx-$ackFailureId.json")
    Assert-Check ($stoppedAfterAckFailure.backgroundServiceStopped -and $ackFailureStatus.state -eq 'error' -and $ackFailureStatus.exitCode -eq 23 -and $ackFailureStatus.errorCode -ceq 'sfx-helper-exit-without-status' -and ([IO.File]::ReadAllLines((Join-Path $library "count-$ackFailureId.log"))).Count -eq 1) 'An acknowledgement publication failure retains the started child through graceful Stop and terminal fallback without replay.'
    [IO.File]::WriteAllText($helperPath, $normalHelper)
    $afterFailureStart = Initialize-Fixture -Arguments @('-StartBackgroundService')
    $residentPid = [int]$afterFailureStart.backgroundService.processId

    $drainId = 'drain-request-1234'
    New-Request $drainId
    $null = Wait-JsonFile (Join-Path $requests "launch-sfx-$drainId.json")
    $stopped = Initialize-Fixture -Arguments @('-StopBackgroundService')
    Wait-ProcessExit $residentPid
    $stoppedManifest = [IO.File]::ReadAllText($servicePath) | ConvertFrom-Json
    $drained = Wait-JsonFile (Join-Path $library "sessions/fixture-session-1234/status-sfx-$drainId.json")
    Assert-Check ($stopped.backgroundServiceStopped -and $stoppedManifest.state -ceq 'stopped' -and $drained.state -ceq 'success') 'Graceful shutdown drains the active worker, publishes stopped state, and never terminates its process.'

    $restart = Initialize-Fixture -Arguments @('-StartBackgroundService')
    $restartPid = [int]$restart.backgroundService.processId
    Assert-Check ($restartPid -ne $residentPid -and $restart.backgroundService.state -ceq 'ready') 'Activation after a completed stop starts a new verified resident.'
    [IO.File]::AppendAllText((Join-Path $tools 'AeBackgroundLauncher.cs'), "`n// fixture live upgrade`n")
    $null = Initialize-Fixture
    Wait-ProcessExit $restartPid
    $runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
    $upgradedCertificate = [IO.File]::ReadAllText((Join-Path $library 'background-launcher.json')) | ConvertFrom-Json
    Assert-Check ($upgradedCertificate.sourceSha256 -ceq (Get-FileHash -LiteralPath (Join-Path $tools 'AeBackgroundLauncher.cs') -Algorithm SHA256).Hash.ToLowerInvariant() -and ([IO.File]::ReadAllText($servicePath) | ConvertFrom-Json).state -ceq 'stopped') 'A source update stops its existing resident gracefully before replacing the locked executable.'
    $restart = Initialize-Fixture -Arguments @('-StartBackgroundService')
    $restartPid = [int]$restart.backgroundService.processId
    $runtime.backgroundLauncherSha256 = '0' * 64
    Write-Json $runtimePath $runtime
    Wait-ProcessExit $restartPid
    Assert-Check (([IO.File]::ReadAllText($servicePath) | ConvertFrom-Json).state -ceq 'stopped') 'A resident exits when runtime activation switches to another executable identity.'
    $runtime.backgroundLauncherSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Json $runtimePath $runtime

    $delayedId = 'delayed-login-request-1234'
    New-Request $delayedId
    [IO.File]::SetLastWriteTimeUtc((Join-Path $requests 'pending-launch.json'), [datetime]::UtcNow.AddSeconds(-30))
    $bridgeRoot = Join-Path $fixtureRoot '.ae-codex/bridge'
    [void][IO.Directory]::CreateDirectory($bridgeRoot)
    $bridgeHeartbeat = Join-Path $bridgeRoot 'heartbeat.json'
    function Write-FixtureHeartbeat([string]$Session, [string]$Request, [long]$Timestamp) {
        Write-Json $bridgeHeartbeat @{schema='codex-ae-heartbeat/v1';state='running';sessionNonce=$Session;timestampEpochMs=$Timestamp;library=@{requestId=$Request;state='scanning'}}
    }
    Write-FixtureHeartbeat 'different-session-1234' $delayedId ([datetimeoffset]::UtcNow.ToUnixTimeMilliseconds())
    $delayedStart = Initialize-Fixture -Arguments @('-StartBackgroundService')
    $delayedPid = [int]$delayedStart.backgroundService.processId
    Start-Sleep -Milliseconds 1200
    Assert-Check (-not [IO.File]::Exists((Join-Path $requests "launch-sfx-$delayedId.json"))) 'A delayed logon pointer is ignored when the live heartbeat belongs to another session.'
    Write-FixtureHeartbeat 'fixture-session-1234' $delayedId ([datetimeoffset]::UtcNow.ToUnixTimeMilliseconds() - 30000)
    Start-Sleep -Milliseconds 1200
    Assert-Check (-not [IO.File]::Exists((Join-Path $requests "launch-sfx-$delayedId.json"))) 'An expired heartbeat cannot revive a delayed logon pointer.'
    Write-FixtureHeartbeat 'fixture-session-1234' 'different-request-1234' ([datetimeoffset]::UtcNow.ToUnixTimeMilliseconds())
    Start-Sleep -Milliseconds 1200
    Assert-Check (-not [IO.File]::Exists((Join-Path $requests "launch-sfx-$delayedId.json"))) 'The heartbeat must select the exact pending request before delayed dispatch.'
    Write-FixtureHeartbeat 'fixture-session-1234' $delayedId ([datetimeoffset]::UtcNow.ToUnixTimeMilliseconds())
    $delayedTerminal = Wait-JsonFile (Join-Path $library "sessions/fixture-session-1234/status-sfx-$delayedId.json")
    Assert-Check ($delayedTerminal.state -eq 'success' -and ([IO.File]::ReadAllLines((Join-Path $library "count-$delayedId.log"))).Count -eq 1) 'A 30-second-old logon pointer dispatches once after a fresh matching live scanning heartbeat arrives.'
    $null = Initialize-Fixture -Arguments @('-StopBackgroundService')
    Wait-ProcessExit $delayedPid

    $lastStart = Initialize-Fixture -Arguments @('-StartBackgroundService')
    $removedPid = [int]$lastStart.backgroundService.processId
    [IO.File]::Delete($runtimePath)
    Wait-ProcessExit $removedPid
    Assert-Check (([IO.File]::ReadAllText($servicePath) | ConvertFrom-Json).state -ceq 'stopped') 'Removing the runtime metadata stops its resident without leaving an orphan helper.'
} finally {
    Write-Json $runtimePath $runtime
    [IO.File]::WriteAllText($stopPath, [datetime]::UtcNow.ToString('o'))
    if ([IO.File]::Exists($servicePath)) {
        $lastService = [IO.File]::ReadAllText($servicePath) | ConvertFrom-Json
        Wait-ProcessExit ([int]$lastService.processId)
    }
}
$result = [pscustomobject]@{state='success';count=$checks.Count;checks=$checks.ToArray();fixtureRoot=$fixtureRoot;realAeModified=$false;realInventoryScanned=$false}
[IO.File]::WriteAllText((Join-Path $reportRoot 'result.json'), ($result | ConvertTo-Json -Depth 6))
$result | ConvertTo-Json -Depth 6
