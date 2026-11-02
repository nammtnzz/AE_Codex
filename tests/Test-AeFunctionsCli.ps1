[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $workspaceRoot 'tools/AeFunctionRequest.ps1')
$testRoot = Join-Path $workspaceRoot ('.ae-codex/tests/functions-cli-' + [guid]::NewGuid().ToString('N'))
$fixtureTools = Join-Path $testRoot 'tools'
$fixtureFunctions = Join-Path $testRoot '.ae-codex/functions'
$fixtureBridge = Join-Path $testRoot '.ae-codex/bridge'
$catalogPath = Join-Path $fixtureFunctions 'catalog.json'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$passed = 0

function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}
function Assert-Rejected([string]$Json, [string]$Label) {
    $rejected = $false
    try { ConvertTo-AeFunctionRequest -Json $Json -CatalogPath $catalogPath | Out-Null }
    catch { $rejected = $true }
    Assert-True $rejected "Request should be rejected: $Label"
}
function Set-FixtureHeartbeat([string]$Version = '1.8.0') {
    [ordered]@{
        schema = 'codex-ae-heartbeat/v1'; bridgeVersion = $Version; state = 'running'
        workspaceRoot = $testRoot
        timestampEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sessionNonce = 'fixture-session-0001'
        startupStage = 'ready'; startupPercent = 100; message = 'fixture'
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $fixtureBridge 'heartbeat.json') -Encoding utf8NoBOM
}
function Start-FixtureReceiver([string]$State = 'success') {
    Start-Job -ArgumentList $fixtureBridge, $State -ScriptBlock {
        param($BridgeRoot, $TerminalState)
        $ErrorActionPreference = 'Stop'
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $deadline) {
            $jobs = @(Get-ChildItem -LiteralPath (Join-Path $BridgeRoot 'inbox') -Filter '*.job' -File)
            if ($jobs.Count -gt 0) {
                $job = $jobs[0]
                $wire = [System.IO.File]::ReadAllText($job.FullName)
                [System.IO.File]::WriteAllText((Join-Path $BridgeRoot 'last-wire.txt'), $wire)
                $fields = @{}
                foreach ($line in ($wire -split "`n")) {
                    if (-not $line) { continue }
                    $pair = $line -split '=', 2
                    $fields[$pair[0]] = $pair[1]
                }
                $runningPath = [System.IO.Path]::ChangeExtension($job.FullName, '.running')
                Move-Item -LiteralPath $job.FullName -Destination $runningPath
                $status = [ordered]@{
                    schema = 'codex-ae-run/v2'; mode = 'file-bridge'; runId = $fields.runId
                    sessionNonce = $fields.sessionNonce; state = $TerminalState; phase = 'complete'
                    completionKnown = $true; message = 'fixture result'; errorCode = 'FUNCTION_FAILED'
                    result = @{ steps = @(@{ data = @{ unicode = 'Tiếng Việt'; nested = @{ one = @{ two = @{ value = 42 } } } } }) }
                }
                $statusPath = Join-Path $BridgeRoot ('results/status-' + $fields.runId + '.json')
                [System.IO.File]::WriteAllText($statusPath, ($status | ConvertTo-Json -Depth 32), [System.Text.UTF8Encoding]::new($false))
                Remove-Item -LiteralPath $runningPath -Force
                return $fields.runId
            }
            Start-Sleep -Milliseconds 25
        }
        throw 'Fixture did not receive a request.'
    }
}
function Invoke-Fixture([string[]]$Parameters) {
    $output = & pwsh -NoProfile -File (Join-Path $fixtureTools 'Invoke-AeFunction.ps1') @Parameters -AsToolOutput
    return @{ ExitCode = $LASTEXITCODE; Data = (($output -join "`n") | ConvertFrom-Json -AsHashtable -Depth 64) }
}

try {
    New-Item -ItemType Directory -Force -Path $fixtureTools, $fixtureFunctions, (Join-Path $testRoot 'jsx'), (Join-Path $fixtureBridge 'inbox'), (Join-Path $fixtureBridge 'results') | Out-Null
    foreach ($file in @('Submit-AeJsx.ps1', 'AeFunctionRequest.ps1', 'Invoke-AeFunction.ps1', 'Get-AeFunctions.ps1', 'Resolve-AeScriptTarget.ps1')) {
        Copy-Item -LiteralPath (Join-Path $workspaceRoot "tools/$file") -Destination (Join-Path $fixtureTools $file)
    }
    # Fixtures never load or submit to the user's interactive AE bridge.
    [System.IO.File]::WriteAllText((Join-Path $fixtureTools 'Sync-CodexModelDisplay.ps1'), '# fixture no-op', $utf8)
    [System.IO.File]::WriteAllText((Join-Path $testRoot 'jsx/Codex Bridge.jsx'), '// fixture bundle', $utf8)
    [ordered]@{
        schema = 'codex-ae-functions-catalog/v1'; bridgeVersion = '1.8.0'
        functions = @(
            @{ name = 'project.inspect'; description = 'Read the project'; mutates = $false }
            @{ name = 'layer.set'; description = 'Set a layer'; mutates = $true }
            @{ name = 'script.run'; description = 'Run an installed branch'; mutates = $true }
        )
        legacyBranches = @(@{ name = 'hello.jsx'; function = 'script.run'; args = @{ branch = 'hello.jsx' }; description = 'Legacy hello' })
    } | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $catalogPath -Encoding utf8NoBOM

    $normalized = ConvertTo-AeFunctionRequest -Json '{"schema":"codex-ae-functions/v1","steps":[{"function":"script.run","args":{"branch":"HELLO"},"as":"first"}]}' -CatalogPath $catalogPath | ConvertFrom-Json -AsHashtable
    Assert-True ($normalized.steps[0].args.branch -ceq 'hello.jsx') 'Legacy branch case/suffix must normalize to catalog name.'
    $passed += 1
    foreach ($invalid in @(
        '{}',
        '{"schema":"codex-ae-functions/v1","steps":[]}',
        '{"schema":"codex-ae-functions/v1","steps":[{"function":"unknown.call","args":{}}]}',
        '{"schema":"codex-ae-functions/v1","steps":[{"function":"project.inspect","args":[]}]}',
        '{"schema":"codex-ae-functions/v1","steps":[{"function":"project.inspect","args":{},"code":"alert(1)"}]}',
        '{"schema":"codex-ae-functions/v1","steps":[{"function":"script.run","args":{"branch":"../hello"}}]}',
        '{"schema":"codex-ae-functions/v1","steps":[{"function":"script.run","args":{"branch":"missing"}}]}',
        '{"schema":"codex-ae-functions/v1","steps":[{"function":"project.inspect","args":{},"as":"a"},{"function":"project.inspect","args":{},"as":"a"}]}'
    )) { Assert-Rejected $invalid 'invalid shape or name'; $passed += 1 }
    $tooMany = @{ schema = 'codex-ae-functions/v1'; steps = @(1..101 | ForEach-Object { @{ function = 'project.inspect'; args = @{} } }) } | ConvertTo-Json -Depth 8 -Compress
    Assert-Rejected $tooMany 'more than 100 steps'; $passed += 1
    Assert-Rejected ('{"schema":"codex-ae-functions/v1","steps":[{"function":"project.inspect","args":{"text":"' + ('é' * 66000) + '"}}]}') 'UTF-8 size'; $passed += 1

    $listing = & (Join-Path $fixtureTools 'Get-AeFunctions.ps1') -Type ReadOnly | ConvertFrom-Json -AsHashtable
    Assert-True ($listing.count -eq 1 -and $listing.functions[0].name -eq 'project.inspect') 'Read-only catalog filter failed.'
    $legacy = & (Join-Path $fixtureTools 'Get-AeFunctions.ps1') -LegacyOnly -Search HELLO | ConvertFrom-Json -AsHashtable
    Assert-True ($legacy.count -eq 1 -and $legacy.functions[0].function -eq 'script.run') 'Legacy catalog filter failed.'
    $passed += 1

    Set-FixtureHeartbeat
    $receiver = Start-FixtureReceiver
    $result = Invoke-Fixture @('-Function', 'project.inspect', '-ArgumentsJson', '{"text":"Tiếng Việt & = 100%"}', '-TimeoutSeconds', '10')
    $receiver | Wait-Job -Timeout 15 | Receive-Job -ErrorAction Stop | Out-Null
    Remove-Job -Job $receiver
    Assert-True ($result.ExitCode -eq 0 -and $result.Data.state -eq 'success') 'Function wrapper should return machine JSON.'
    Assert-True ($result.Data.result.steps[0].data.nested.one.two.value -eq 42) 'Nested function results must not truncate.'
    $wire = [System.IO.File]::ReadAllText((Join-Path $fixtureBridge 'last-wire.txt'))
    $lines = $wire -split "`n"
    Assert-True ($lines.Count -eq 4 -and $lines[0] -eq 'schema=codex-ae-job/v2') 'V2 must contain exactly four wire lines.'
    $decoded = [Uri]::UnescapeDataString($lines[3].Substring(8)) | ConvertFrom-Json -AsHashtable
    Assert-True ($decoded.steps[0].args.text -ceq 'Tiếng Việt & = 100%') 'URI JSON payload must round-trip Unicode and delimiters.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixtureBridge 'submit.lock'))) 'Known terminal success must release lock.'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $testRoot 'jsx') -File).Count -eq 1) 'Function call must not create a JSX file.'
    $passed += 1

    Set-FixtureHeartbeat
    $receiver = Start-FixtureReceiver
    $legacyResult = & (Join-Path $fixtureTools 'Submit-AeJsx.ps1') -Script (Join-Path $testRoot 'jsx/Codex Bridge.jsx') -TimeoutSeconds 10 6>$null | ConvertFrom-Json -AsHashtable -Depth 64
    $receiver | Wait-Job -Timeout 15 | Receive-Job -ErrorAction Stop | Out-Null
    Remove-Job -Job $receiver
    Assert-True ($legacyResult.state -eq 'success') 'Legacy -Script must still use the same bridge lifecycle.'
    Assert-True ([System.IO.File]::ReadAllText((Join-Path $fixtureBridge 'last-wire.txt')).StartsWith('schema=codex-ae-job/v1')) 'Legacy scripts must retain v1 wire format.'
    $passed += 1

    Set-FixtureHeartbeat '1.7.0'
    $oldVersion = Invoke-Fixture @('-Function', 'project.inspect')
    Assert-True ($oldVersion.ExitCode -ne 0 -and $oldVersion.Data.message -match '1.8.0') 'Old bridge must reject function jobs before dispatch.'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $fixtureBridge 'inbox') -Filter '*.job').Count -eq 0) 'Version rejection must not dispatch.'
    $passed += 1

    Set-FixtureHeartbeat
    $foreignHeartbeatPath = Join-Path $fixtureBridge 'heartbeat.json'
    $foreignHeartbeat = Get-Content -Raw -LiteralPath $foreignHeartbeatPath | ConvertFrom-Json
    $foreignHeartbeat.workspaceRoot = 'D:\other-install'
    $foreignHeartbeat | ConvertTo-Json -Compress | Set-Content -LiteralPath $foreignHeartbeatPath -Encoding utf8NoBOM
    $foreignWorkspace = Invoke-Fixture @('-Function', 'project.inspect')
    Assert-True ($foreignWorkspace.ExitCode -ne 0 -and $foreignWorkspace.Data.message -match 'workspace') 'A heartbeat from another workspace must be rejected before dispatch.'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $fixtureBridge 'inbox') -Filter '*.job').Count -eq 0) 'Workspace mismatch must not dispatch.'
    $passed += 1

    Set-FixtureHeartbeat
    $receiver = Start-FixtureReceiver 'error'
    $plan = Join-Path $testRoot '.ae-codex/plan.json'
    [System.IO.File]::WriteAllText($plan, '{"schema":"codex-ae-functions/v1","steps":[{"function":"project.inspect","args":{},"as":"first"}]}', $utf8)
    $failed = Invoke-Fixture @('-Plan', $plan, '-TimeoutSeconds', '10')
    $receiver | Wait-Job -Timeout 15 | Receive-Job -ErrorAction Stop | Out-Null
    Remove-Job -Job $receiver
    Assert-True ($failed.ExitCode -ne 0 -and $failed.Data.message -match 'FUNCTION_FAILED') 'Known AE function errors must reach tool output.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixtureBridge 'submit.lock'))) 'Known terminal error must release lock.'
    $passed += 1

    Set-FixtureHeartbeat
    $timedOut = Invoke-Fixture @('-PlanJson', '{"schema":"codex-ae-functions/v1","steps":[{"function":"project.inspect","args":{}}]}', '-TimeoutSeconds', '5')
    Assert-True ($timedOut.ExitCode -ne 0 -and $timedOut.Data.message -match 'must not be submitted again') 'Unknown completion must forbid automatic retry.'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixtureBridge 'submit.lock')) 'Unknown completion must retain lock.'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $fixtureBridge 'inbox') -Filter '*.job').Count -eq 1) 'Timeout must leave the single original dispatch.'
    $passed += 1
    Write-Output "AE function CLI tests passed: $passed groups (isolated filesystem receiver; no AE jobs)."
} finally {
    foreach ($job in @(Get-Job | Where-Object { $_.Command -match 'Fixture did not receive a request' })) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
    $resolved = [System.IO.Path]::GetFullPath($testRoot)
    $allowed = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.ae-codex/tests')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($allowed, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Unexpected fixture cleanup target: $resolved" }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
