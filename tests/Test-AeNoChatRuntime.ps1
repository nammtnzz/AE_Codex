#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testId = [guid]::NewGuid().ToString('N')
$fixture = Join-Path ([IO.Path]::GetTempPath()) "CodexAE-nochat-$testId/Máy mới & 100% O'Brien"
$tools = Join-Path $fixture 'tools'
$library = Join-Path $fixture '.ae-codex/library'
$chat = Join-Path $fixture '.ae-codex/chat'
$bridge = Join-Path $fixture '.ae-codex/bridge'
$reportRoot = Join-Path $workspace ".ae-codex/tests/nochat-runtime-$testId"
$utf8 = [Text.UTF8Encoding]::new($false)
$pwsh = (Get-Process -Id $PID).Path
$initializer = Join-Path $tools 'Initialize-AeLibrary.ps1'
$checks = [Collections.Generic.List[string]]::new()
$legacy = $null
function Assert-Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAILED: $Message" }; $checks.Add($Message) }
function Write-Json([string]$Path, $Value) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 10 -Compress), $utf8)
}
function Invoke-Initialize([string[]]$Arguments = @(), [int]$ExpectedExit = 0) {
    $output = @(& $pwsh -NoProfile -File $initializer -SkipScan @Arguments 2>&1)
    if ($LASTEXITCODE -ne $ExpectedExit) { throw "Initializer exit $LASTEXITCODE, expected ${ExpectedExit}: $($output -join ' ')" }
    if ($ExpectedExit -eq 0) { return (($output -join "`n") | ConvertFrom-Json) }
    return ($output -join "`n")
}
function Wait-Json([string]$Path) {
    $deadline = [datetime]::UtcNow.AddSeconds(12)
    while ([datetime]::UtcNow -lt $deadline) {
        if ([IO.File]::Exists($Path)) { try { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop) } catch { } }
        Start-Sleep -Milliseconds 100
    }
    throw "Fixture did not publish $Path"
}
function Write-ChatRequest([string]$Id, [datetimeoffset]$Submitted) {
    $timestamp = $Submitted.ToUnixTimeMilliseconds()
    Write-Json (Join-Path $chat "requests/$Id.json") @{schema='codex-ae-chat-request/v1';id=$Id;sessionNonce='fixture-session-1234';createdAtEpochMs=$timestamp;action='connect';payload=@{}}
    Write-Json (Join-Path $chat 'pending.json') @{schema='codex-ae-chat-pending/v1';requestId=$Id;sessionNonce='fixture-session-1234';timestampEpochMs=$timestamp;workspaceRoot=$fixture}
    [IO.File]::SetLastWriteTimeUtc((Join-Path $chat 'pending.json'), $Submitted.UtcDateTime)
    Write-Json (Join-Path $bridge 'heartbeat.json') @{schema='codex-ae-heartbeat/v1';state='running';sessionNonce='fixture-session-1234';timestampEpochMs=[datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()}
}
try {
    foreach ($folder in @($tools,$library,$chat,$bridge,$reportRoot)) { [IO.Directory]::CreateDirectory($folder) | Out-Null }
    foreach ($name in @('Initialize-AeLibrary.ps1','AeBackgroundLauncher.cs')) { Copy-Item -LiteralPath (Join-Path $workspace "tools/$name") -Destination (Join-Path $tools $name) }
    # Archived chat helpers deliberately exist in the development fixture. Their
    # presence cannot re-enable certification or any dispatch path.
    [IO.File]::WriteAllText((Join-Path $tools 'AeCodexChatHost.js'), 'require("fs").writeFileSync(require("path").join(__dirname,"unexpected-chat.txt"),"started");', $utf8)
    [IO.File]::WriteAllText((Join-Path $tools 'AeCodexChatMedia.js'), 'throw new Error("Chat is removed");', $utf8)
    [IO.File]::WriteAllText((Join-Path $tools 'New-AeChatPreview.ps1'), 'throw "Chat is removed"', $utf8)
    $sfxHelper = @'
param([string]$RequestId)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$library = Join-Path $root '.ae-codex/library'
$request = [IO.File]::ReadAllText((Join-Path $library "requests/sfx-$RequestId.json")) | ConvertFrom-Json
[IO.File]::AppendAllText((Join-Path $library 'fixture-sfx-count.log'), "worker`n")
$status = Join-Path $library "sessions/$($request.sessionId)/status-sfx-$RequestId.json"
[IO.File]::WriteAllText($status, (@{schemaVersion=1;kind='disk-sfx';state='success';requestId=$RequestId;sessionId=$request.sessionId;metadataOnly=$true} | ConvertTo-Json -Compress))
'@
    [IO.File]::WriteAllText((Join-Path $tools 'Update-AeSfxCatalog.ps1'), $sfxHelper, $utf8)
    $initialized = Invoke-Initialize
    $runtimePath = Join-Path $library 'runtime.json'
    $runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
    $forbidden = @($runtime.PSObject.Properties.Name | Where-Object { $_ -match '^(node|chat)' })
    Assert-Check ($initialized.state -eq 'success' -and $forbidden.Count -eq 0) 'Initialization certifies only the SFX resident, without discovering Node or certifying archived chat/media/preview helpers.'
    $runtimeBefore = [IO.File]::ReadAllText($runtimePath)
    $statePath = Join-Path $chat 'state.json'
    Write-Json $statePath @{schema='codex-ae-chat-state/v1';busy=$true;pendingRequests=@()}
    $busy = Invoke-Initialize -ExpectedExit 1
    Assert-Check ($busy -match 'legacy Codex chat is still active' -and [IO.File]::ReadAllText($runtimePath) -ceq $runtimeBefore) 'Active legacy chat blocks certification before runtime changes.'
    Write-Json $statePath @{schema='codex-ae-chat-state/v1';busy=$false;pendingRequests=@(@{id='approval'})}
    $approval = Invoke-Initialize -ExpectedExit 1
    Assert-Check ($approval -match 'legacy Codex chat is still active' -and [IO.File]::ReadAllText($runtimePath) -ceq $runtimeBefore) 'A pending legacy approval blocks certification and remains unanswered.'
    Write-Json $statePath @{schema='codex-ae-chat-state/v1';busy=$false;pendingRequests=@();error=@{code='TURN_STATE_UNKNOWN'}}
    $unknown = Invoke-Initialize -ExpectedExit 1
    Assert-Check ($unknown -match 'result is unconfirmed' -and [IO.File]::ReadAllText($runtimePath) -ceq $runtimeBefore) 'An unknown legacy outcome blocks certification without replay or deletion.'
    Write-Json $statePath @{schema='codex-ae-chat-state/v1';busy=$false;pendingRequests=@()}
    Write-ChatRequest 'stale-chat-request-1234' ([datetimeoffset]::UtcNow.AddMinutes(-10))
    $stalePending = [IO.File]::ReadAllText((Join-Path $chat 'pending.json'))
    $started = Invoke-Initialize -Arguments @('-StartBackgroundService')
    Start-Sleep -Milliseconds 1200
    Assert-Check (-not [IO.File]::Exists((Join-Path $tools 'unexpected-chat.txt')) -and -not [IO.File]::Exists((Join-Path $chat 'launch.json')) -and [IO.File]::ReadAllText((Join-Path $chat 'pending.json')) -ceq $stalePending) 'A stale chat pointer is ignored and preserved after resident startup, even with a matching live bridge.'
    Write-ChatRequest 'fresh-chat-request-1234' ([datetimeoffset]::UtcNow)
    $freshPending = [IO.File]::ReadAllText((Join-Path $chat 'pending.json'))
    $requests = Join-Path $library 'requests'
    Write-Json (Join-Path $requests 'sfx-nochat-sfx-1234.json') @{schemaVersion=1;requestId='nochat-sfx-1234';sessionId='fixture-session-1234';workspaceRoot=$fixture}
    Write-Json (Join-Path $requests 'pending-launch.json') @{schemaVersion=1;requestId='nochat-sfx-1234';sessionId='fixture-session-1234'}
    $terminal = Wait-Json (Join-Path $library 'sessions/fixture-session-1234/status-sfx-nochat-sfx-1234.json')
    Start-Sleep -Milliseconds 1200
    Assert-Check ($terminal.state -eq 'success' -and ([IO.File]::ReadAllLines((Join-Path $library 'fixture-sfx-count.log'))).Count -eq 1) 'The same resident still dispatches a named SFX request exactly once.'
    Assert-Check (-not [IO.File]::Exists((Join-Path $tools 'unexpected-chat.txt')) -and -not [IO.File]::Exists((Join-Path $chat 'launch-fresh-chat-request-1234.json')) -and -not [IO.File]::Exists((Join-Path $chat 'launch-fresh-chat-request-1234.claim.json')) -and [IO.File]::ReadAllText((Join-Path $chat 'pending.json')) -ceq $freshPending) 'Fresh chat requests cannot start a host, create claims/acknowledgements, or alter queued messages while SFX works.'
    $launcherSource = [IO.File]::ReadAllText((Join-Path $tools 'AeBackgroundLauncher.cs'))
    Assert-Check ($launcherSource -notmatch 'DispatchChat|FreshChatBridge|ChatStopSupersedes|AeCodexChatHost\.js|New-AeChatPreview\.ps1|lastChatPointer') 'The resident has no chat launch, watcher, preview or dispatch implementation.'
    # A synthetic legacy host exits only after its exact graceful stop marker.
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $legacyScript = Join-Path $tools 'LegacyChatFixture.js'
    [IO.File]::WriteAllText($legacyScript, 'const fs=require("fs"),path=require("path"),dir=path.join(__dirname,"../.ae-codex/chat");setInterval(()=>{if(fs.existsSync(path.join(dir,"stop"))){fs.writeFileSync(path.join(dir,"fixture-legacy-stopped.json"),JSON.stringify({stopped:true}));process.exit(0);}},50);', $utf8)
    $legacyStart = [Diagnostics.ProcessStartInfo]::new($node)
    $legacyStart.ArgumentList.Add($legacyScript)
    $legacyStart.UseShellExecute = $false
    $legacyStart.CreateNoWindow = $true
    $legacyStart.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $legacy = [Diagnostics.Process]::Start($legacyStart)
    Write-Json (Join-Path $chat 'launch.json') @{schema='codex-ae-chat-launch/v1';pid=$legacy.Id;workspaceRoot=$fixture;processStartEpochMs=([datetimeoffset]$legacy.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();timestampEpochMs=[datetimeoffset]::UtcNow.ToUnixTimeMilliseconds();nodePath=$node}
    $stopped = Invoke-Initialize -Arguments @('-StopBackgroundService')
    Assert-Check ($stopped.backgroundServiceStopped -and $legacy.WaitForExit(5000) -and (Wait-Json (Join-Path $chat 'fixture-legacy-stopped.json')).stopped) 'Stop still recognizes the exact legacy host from its launch identity and drains it gracefully without dedicated Node certification.'
    $stopMarker = [IO.File]::ReadAllText((Join-Path $chat 'stop')) | ConvertFrom-Json
    Assert-Check ($stopMarker.schema -ceq 'codex-ae-chat-stop/v1' -and $stopMarker.service) 'Legacy shutdown uses its existing stop protocol and never kills or restarts a host.'
    $result = [ordered]@{state='success';count=$checks.Count;checks=$checks.ToArray();fixtureRoot=$fixture;realInstallationChanged=$false;realAeModified=$false;realInventoryScanned=$false}
    [IO.File]::WriteAllText((Join-Path $reportRoot 'result.json'), ($result | ConvertTo-Json -Depth 8), $utf8)
    $result | ConvertTo-Json -Depth 8
} finally {
    if ([IO.File]::Exists($initializer)) { try { Invoke-Initialize -Arguments @('-StopBackgroundService') | Out-Null } catch {} }
    if ($null -ne $legacy) {
        if (-not $legacy.HasExited) {
            Write-Json (Join-Path $chat 'stop') @{schema='codex-ae-chat-stop/v1';service=$true;createdAtEpochMs=[datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()}
            $null = $legacy.WaitForExit(5000)
        }
        $legacy.Dispose()
    }
}
