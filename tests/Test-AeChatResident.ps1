#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testId = [guid]::NewGuid().ToString('N')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) "Codex AE chat resident $testId/Máy mới & 100% O'Brien"
$tools = Join-Path $fixtureRoot 'tools'
$library = Join-Path $fixtureRoot '.ae-codex/library'
$chat = Join-Path $fixtureRoot '.ae-codex/chat'
$bridge = Join-Path $fixtureRoot '.ae-codex/bridge'
$reportRoot = Join-Path $workspace ".ae-codex/tests-chat-resident/$testId"
foreach ($path in @($tools,$chat,$bridge,$reportRoot,(Join-Path $chat 'requests'))) { [void][IO.Directory]::CreateDirectory($path) }
foreach ($name in @('Initialize-AeLibrary.ps1','AeBackgroundLauncher.cs','AeBackgroundServiceLifecycle.ps1')) {
    Copy-Item -LiteralPath (Join-Path $workspace "tools/$name") -Destination (Join-Path $tools $name)
}
$hostSource = @'
'use strict';
const fs = require('node:fs'); const path = require('node:path');
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
const root = process.argv[process.argv.indexOf('--workspace') + 1];
const chat = path.join(root,'.ae-codex','chat');
const created = Date.now();
const stop = path.join(chat,'stop'); const hb = path.join(chat,'host.json');
fs.appendFileSync(path.join(chat,'count.log'), `${process.pid}\n`);
fs.writeFileSync(path.join(chat,`probe-${process.pid}.json`), JSON.stringify({argv:process.argv,root,pid:process.pid}));
function heartbeat(state) { const p=hb+'.tmp'; fs.writeFileSync(p,JSON.stringify({schema:'codex-ae-chat-host/v1',state,pid:process.pid,workspaceRoot:root,processStartEpochMs:created,timestampEpochMs:Date.now()})); fs.renameSync(p,hb); }
heartbeat('ready');
// More than a pipe buffer: both readers must drain without logging content.
process.stdout.write('synthetic-private-chat-content'.repeat(40000));
process.stderr.write('synthetic-private-chat-content'.repeat(40000));
const timer=setInterval(()=> { heartbeat('ready'); try { const s=JSON.parse(fs.readFileSync(stop,'utf8')); if(s.schema==='codex-ae-chat-stop/v1' && s.createdAtEpochMs>=created) {clearInterval(timer);heartbeat('stopped');setTimeout(()=>process.exit(0),100);} }catch{} },100);
'@
[IO.File]::WriteAllText((Join-Path $tools 'AeCodexChatHost.js'),$hostSource,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $tools 'AeCodexChatMedia.js'),"'use strict'; // synthetic viewer dependency",[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $tools 'New-AeChatPreview.ps1'),"# synthetic preview dependency",[Text.UTF8Encoding]::new($false))
$pwsh = (Get-Process -Id $PID).Path
$initializer = Join-Path $tools 'Initialize-AeLibrary.ps1'
$runtimePath = Join-Path $library 'runtime.json'
$checks = [Collections.Generic.List[string]]::new()
$residentPid = 0
function Assert-Check([bool]$Condition,[string]$Message) { if(-not $Condition){throw "FAILED: $Message"};$checks.Add($Message) }
function Write-Json([string]$Path,$Value) { [IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false)) }
function Read-Json([string]$Path) {
    # Match the resident's reader: the synthetic host replaces its heartbeat
    # atomically every 100 ms, so the test must not lock out that rename.
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8)
    try { $reader.ReadToEnd()|ConvertFrom-Json -ErrorAction Stop }
    finally { $reader.Dispose() }
}
function Initialize-Fixture([string[]]$Arguments=@()) {
    $output=@(& $pwsh -NoProfile -File $initializer -SkipScan @Arguments 2>&1)
    if($LASTEXITCODE -ne 0){throw "Initializer failed: $($output -join ' ')"}
    return (($output -join "`n")|ConvertFrom-Json -ErrorAction Stop)
}
function Write-Heartbeat([string]$Session='fixture-chat-session-1234') {
    Write-Json (Join-Path $bridge 'heartbeat.json') @{schema='codex-ae-heartbeat/v1';state='running';sessionNonce=$Session;timestampEpochMs=[datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()}
}
function Write-Request([string]$Id,[string]$Action='connect',[long]$Timestamp=([datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()),[string]$RequestWorkspace=$fixtureRoot,[switch]$NoHeartbeat) {
    Write-Json (Join-Path $chat "requests/$Id.json") @{schema='codex-ae-chat-request/v1';id=$Id;sessionNonce='fixture-chat-session-1234';action=$Action;args=@{};createdAtEpochMs=$Timestamp}
    Write-Json (Join-Path $chat 'pending.json') @{schema='codex-ae-chat-pending/v1';requestId=$Id;sessionNonce='fixture-chat-session-1234';workspaceRoot=$RequestWorkspace;timestampEpochMs=$Timestamp}
    if(-not $NoHeartbeat){Write-Heartbeat}
}
function Wait-File([string]$Path,[scriptblock]$Predicate={param($Value)$true}) {
    $deadline=[datetime]::UtcNow.AddSeconds(15)
    while([datetime]::UtcNow -lt $deadline){if([IO.File]::Exists($Path)){try{$value=Read-Json $Path;if(& $Predicate $value){return $value}}catch{}};Start-Sleep -Milliseconds 100}
    throw "Fixture state not published: $Path"
}
function Wait-Exit([int]$ProcessId) {
    $running=Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if($running){try{if(-not $running.WaitForExit(15000)){throw "Fixture process $ProcessId did not stop."}}finally{$running.Dispose()}}
}
function Count-Hosts { if([IO.File]::Exists((Join-Path $chat 'count.log'))){return ([IO.File]::ReadAllLines((Join-Path $chat 'count.log'))).Count};return 0 }
function Start-Fixture {
    $started=Initialize-Fixture -Arguments @('-StartBackgroundService')
    $script:residentPid=[int]$started.backgroundService.processId
    return $started
}
try {
    $started=Start-Fixture
    $runtime=Read-Json $runtimePath
    Assert-Check ($runtime.nodePath -ieq (Get-Command node.exe -CommandType Application|Select-Object -First 1).Source -and $runtime.nodeSha256 -ceq (Get-FileHash -LiteralPath $runtime.nodePath -Algorithm SHA256).Hash.ToLowerInvariant()) 'Setup records the real installed Node executable and its SHA-256.'
    Assert-Check ($runtime.chatHostPath -ceq (Join-Path $tools 'AeCodexChatHost.js') -and $runtime.chatHostSha256 -ceq (Get-FileHash -LiteralPath $runtime.chatHostPath -Algorithm SHA256).Hash.ToLowerInvariant()) 'Setup certifies only the fixed standalone chat host entrypoint.'
    Assert-Check ($runtime.chatMediaPath -ceq (Join-Path $tools 'AeCodexChatMedia.js') -and $runtime.chatMediaSha256 -ceq (Get-FileHash -LiteralPath $runtime.chatMediaPath -Algorithm SHA256).Hash.ToLowerInvariant()) 'Setup certifies the fixed media dependency with its own SHA-256.'
    Assert-Check ($runtime.chatPreviewPath -ceq (Join-Path $tools 'New-AeChatPreview.ps1') -and $runtime.chatPreviewSha256 -ceq (Get-FileHash -LiteralPath $runtime.chatPreviewPath -Algorithm SHA256).Hash.ToLowerInvariant()) 'Setup certifies the fixed image preview helper with its own SHA-256.'
    Start-Sleep -Milliseconds 1100
    Assert-Check ((Count-Hosts) -eq 0) 'Starting the resident does not start Codex or a chat host without an explicit request.'

    Write-Request 'expired-chat-request-1234' -Timestamp ([datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()-61000)
    $expired=Wait-File (Join-Path $chat 'launch-expired-chat-request-1234.json')
    Assert-Check ($expired.state -ceq 'error' -and (Count-Hosts)-eq 0) 'An expired chat pointer is rejected without launching a process.'
    Write-Request 'foreign-chat-request-1234' -RequestWorkspace $workspace
    $foreign=Wait-File (Join-Path $chat 'launch-foreign-chat-request-1234.json')
    Assert-Check ($foreign.state -ceq 'error' -and (Count-Hosts)-eq 0) 'A pointer from another workspace cannot choose a launch root.'
    Write-Request 'mismatch-chat-request-1234' -NoHeartbeat
    $bad=Read-Json (Join-Path $chat 'requests/mismatch-chat-request-1234.json');$bad.sessionNonce='foreign-session-1234';Write-Json (Join-Path $chat 'requests/mismatch-chat-request-1234.json') $bad
    $mismatch=Wait-File (Join-Path $chat 'launch-mismatch-chat-request-1234.json')
    Assert-Check ($mismatch.state -ceq 'error' -and (Count-Hosts)-eq 0) 'The immutable request must match its pointer session and identity.'

    Write-Heartbeat 'different-session-1234'
    Write-Request 'fresh-chat-request-1234' -NoHeartbeat
    Start-Sleep -Milliseconds 1100
    Assert-Check ((Count-Hosts)-eq 0) 'A fresh request waits for the matching live AE session.'
    Write-Heartbeat
    $launched=Wait-File (Join-Path $chat 'launch-fresh-chat-request-1234.json')
    $probe=Wait-File (Join-Path $chat "probe-$($launched.pid).json")
    $chatHeartbeat=Wait-File (Join-Path $chat 'host.json') {param($Value)$Value.state -ceq 'ready'}
    Assert-Check ($launched.state -ceq 'launched' -and $probe.root -ceq $fixtureRoot -and $probe.argv[-1] -ceq '--serve' -and (Count-Hosts)-eq 1) 'A matching fresh pointer starts the fixed host once with Unicode-safe direct process arguments.'
    $nodeProcess=Get-Process -Id ([int]$launched.pid) -ErrorAction Stop
    try { Assert-Check ($nodeProcess.MainWindowHandle -eq 0) 'The on-demand Node host has no application window.' } finally{$nodeProcess.Dispose()}
    [IO.File]::SetLastWriteTimeUtc((Join-Path $chat 'pending.json'),[datetime]::UtcNow)
    Start-Sleep -Milliseconds 1200
    Assert-Check ((Count-Hosts)-eq 1) 'Repeated pending notifications never create a second host.'
    $log=if([IO.File]::Exists((Join-Path $library 'launcher-errors.log'))){[IO.File]::ReadAllText((Join-Path $library 'launcher-errors.log'))}else{''}
    Assert-Check ($log -notmatch 'synthetic-private-chat-content') 'Large chat stdout and stderr are drained and never copied into launcher logs.'

    $stopTime=[datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-Json (Join-Path $chat 'stop') @{schema='codex-ae-chat-stop/v1';sessionNonce='fixture-chat-session-1234';createdAtEpochMs=$stopTime}
    Wait-Exit ([int]$launched.pid)
    [IO.File]::SetLastWriteTimeUtc((Join-Path $chat 'pending.json'),[datetime]::UtcNow)
    Start-Sleep -Milliseconds 1200
    Assert-Check ((Count-Hosts)-eq 1) 'Stop supersedes the older pointer and cannot revive a previous send or connection.'
    Write-Request 'reconnect-chat-request-1234'
    $again=Wait-File (Join-Path $chat 'launch-reconnect-chat-request-1234.json')
    $null=Wait-File (Join-Path $chat "probe-$($again.pid).json")
    Assert-Check ((Count-Hosts)-eq 2 -and $again.pid -ne $launched.pid) 'A newer explicit connection starts a new host after Stop.'

    # Deliberately terminate only this synthetic resident to exercise orphan
    # recovery. The fake Node host never connects to Codex, AE, or any network.
    Stop-Process -Id $residentPid -Force
    Wait-Exit $residentPid
    $lifecycle=Join-Path $tools 'AeBackgroundServiceLifecycle.ps1'
    $registry="HKCU:\Software\CodexAE\Tests\$testId\Run"
    $drainedOutput=@(& $pwsh -NoProfile -File $lifecycle -Action Disable -WorkspaceRoot $fixtureRoot -FixtureRegistry -RunRegistryPath $registry 2>&1)
    if($LASTEXITCODE -ne 0){throw "Fixture lifecycle failed: $($drainedOutput -join ' ')"}
    $drained=($drainedOutput -join "`n")|ConvertFrom-Json
    Wait-Exit ([int]$again.pid)
    Assert-Check ($drained.state -ceq 'success' -and -not $drained.serviceRunning -and (Read-Json (Join-Path $chat 'stop')).service) 'Disable drains an owned orphan chat host when its resident has already exited.'
    Assert-Check (-not(Test-Path -LiteralPath $registry)) 'Orphan recovery does not create or modify a current-user startup registry key.'

    Write-Request 'pre-restart-send-request-1234' -Action 'send'
    Start-Sleep -Milliseconds 100
    $null=Start-Fixture
    Start-Sleep -Milliseconds 1200
    Assert-Check ((Count-Hosts)-eq 2 -and -not[IO.File]::Exists((Join-Path $chat 'launch-pre-restart-send-request-1234.json'))) 'A resident restart never dispatches an abandoned send pointer from before activation.'
    $runtime=Read-Json $runtimePath;$runtime.chatHostSha256='0'*64;Write-Json $runtimePath $runtime
    Write-Request 'tampered-chat-request-1234'
    $tampered=Wait-File (Join-Path $chat 'launch-tampered-chat-request-1234.json')
    Assert-Check ($tampered.state -ceq 'error' -and (Count-Hosts)-eq 2) 'A changed host checksum blocks launch and publishes a generic bounded error.'
    $runtime.chatHostSha256=(Get-FileHash -LiteralPath (Join-Path $tools 'AeCodexChatHost.js') -Algorithm SHA256).Hash.ToLowerInvariant();Write-Json $runtimePath $runtime
    $runtime.chatMediaSha256='0'*64;Write-Json $runtimePath $runtime
    Write-Request 'tampered-viewer-request-1234'
    $tamperedViewer=Wait-File (Join-Path $chat 'launch-tampered-viewer-request-1234.json')
    Assert-Check ($tamperedViewer.state -ceq 'error' -and (Count-Hosts)-eq 2) 'A changed media dependency checksum blocks host launch without replay.'
    $runtime.chatMediaSha256=(Get-FileHash -LiteralPath (Join-Path $tools 'AeCodexChatMedia.js') -Algorithm SHA256).Hash.ToLowerInvariant();Write-Json $runtimePath $runtime
    $runtime.chatPreviewSha256='0'*64;Write-Json $runtimePath $runtime
    Write-Request 'tampered-preview-request-1234'
    $tamperedPreview=Wait-File (Join-Path $chat 'launch-tampered-preview-request-1234.json')
    Assert-Check ($tamperedPreview.state -ceq 'error' -and (Count-Hosts)-eq 2) 'A changed preview helper checksum blocks host launch without replay.'
    $runtime.chatPreviewSha256=(Get-FileHash -LiteralPath (Join-Path $tools 'New-AeChatPreview.ps1') -Algorithm SHA256).Hash.ToLowerInvariant();Write-Json $runtimePath $runtime
    Write-Request 'shutdown-chat-request-1234'
    $last=Wait-File (Join-Path $chat 'launch-shutdown-chat-request-1234.json')
    $null=Wait-File (Join-Path $chat "probe-$($last.pid).json")
    Stop-Process -Id $residentPid -Force
    Wait-Exit $residentPid
    [IO.File]::Delete((Join-Path $chat 'launch.json'))
    $null=Start-Fixture
    Start-Sleep -Milliseconds 1200
    Assert-Check ((Count-Hosts)-eq 3 -and (Get-Process -Id ([int]$last.pid) -ErrorAction SilentlyContinue)) 'A restarted resident adopts its live host through fresh heartbeat identity without starting a duplicate.'
    $stopped=Initialize-Fixture -Arguments @('-StopBackgroundService')
    Wait-Exit $residentPid;Wait-Exit ([int]$last.pid)
    Assert-Check ($stopped.backgroundServiceStopped -and (Read-Json (Join-Path $library 'background-service.json')).state -ceq 'stopped') 'Graceful service Stop waits for its chat child before reporting stopped.'
} finally {
    if([IO.File]::Exists($runtimePath)){
        try{$null=Initialize-Fixture -Arguments @('-StopBackgroundService')}catch{}
    }
}
$result=[pscustomobject]@{state='success';count=$checks.Count;checks=$checks.ToArray();fixtureRoot=$fixtureRoot;realAeModified=$false;realCodexChatStarted=$false;networkUsed=$false}
[IO.File]::WriteAllText((Join-Path $reportRoot 'result.json'),($result|ConvertTo-Json -Depth 6))
$result|ConvertTo-Json -Depth 6
