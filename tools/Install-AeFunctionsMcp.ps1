#Requires -Version 7.0
[CmdletBinding()]
param(
    # Fixture/repair mode updates only an existing owned table, without invoking Codex.
    [switch]$SkipRegistration,
    # Explicitly permit a fixture/custom config path for desktop registration.
    [switch]$RegisterDesktop,
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $PSScriptRoot 'AeFunctionsMcp.js'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "AE MCP server is missing: $serverPath" }
if ($SkipRegistration -and $RegisterDesktop) { throw '-SkipRegistration and -RegisterDesktop cannot be combined.' }
if ($ConfigPath -and -not ($SkipRegistration -or $RegisterDesktop)) { throw '-ConfigPath requires -SkipRegistration or -RegisterDesktop; normal registration uses the active Codex user configuration.' }
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$pwshPath = (Get-Process -Id $PID).Path
if ([IO.Path]::GetFileName($pwshPath) -ine 'pwsh.exe') {
    $pwshPath = (Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
if (-not $ConfigPath) {
    $codexUserDirectory = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
    } else { $env:CODEX_HOME }
    $ConfigPath = Join-Path $codexUserDirectory 'config.toml'
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
if (-not $SkipRegistration) {
    # The desktop app, CLI and IDE share this current user's config.toml. Register
    # only our owned table directly; a new desktop-only machine needs no CLI.
    $configHelperPath = Join-Path $PSScriptRoot 'AeCodexConfig.js'
    if (-not (Test-Path -LiteralPath $configHelperPath -PathType Leaf)) { throw "Codex configuration helper is missing: $configHelperPath" }
    $normalizedNodePath = $nodePath.Replace('\', '/')
    $normalizedServerPath = $serverPath.Replace('\', '/')
    $normalizedPwshPath = $pwshPath.Replace('\', '/')
    $normalizedWorkspaceRoot = $workspaceRoot.Replace('\', '/')
    $registrationOutput = & $nodePath $configHelperPath $ConfigPath $normalizedNodePath $normalizedServerPath $normalizedPwshPath $normalizedWorkspaceRoot
    if ($LASTEXITCODE -ne 0) { throw 'Codex desktop MCP registration was not completed. Existing unrelated settings and account data were not changed.' }
    $registration = $registrationOutput | ConvertFrom-Json
    [ordered]@{
        schema = 'codex-ae-mcp-install/v1'; state = 'success'; server = 'ae_functions'
        registered = $true; registrationMethod = 'desktop-config'; runtimeVerified = $false
        enabled = $registration.enabled; changed = $registration.changed; backupPath = $registration.backupPath
        timeoutsUpdated = $registration.changed; configPath = $ConfigPath
        command = $normalizedNodePath; serverPath = $normalizedServerPath; powershellPath = $normalizedPwshPath
        workspaceRoot = $normalizedWorkspaceRoot; startupTimeoutSeconds = 10; toolTimeoutSeconds = 210
        nextStep = if ($registration.enabled) { 'Reload Codex MCP connections or open a new Codex session to load ae_functions. Existing account and project trust settings were preserved.' } else { 'The existing disabled AE MCP preference was preserved. Enable ae_functions in Codex settings, then reload its MCP connections.' }
    } | ConvertTo-Json -Depth 8
    return
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Codex configuration not found: $ConfigPath" }
$original = [IO.File]::ReadAllText($ConfigPath)
$newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }

# Track TOML multiline strings so a header or assignment inside a prompt is never edited.
$records = [Collections.Generic.List[object]]::new()
$multiline = ''
foreach ($match in [regex]::Matches($original, '[^\r\n]*(?:\r\n|\n|\r|$)')) {
    if (-not $match.Length) { continue }
    $line = $match.Value
    $outside = -not $multiline
    $content = $line.TrimEnd("`r", "`n")
    $header = $outside -and $content -match '^\s*\[.+\]\s*(?:#.*)?$'
    $owned = $header -and $content -match '^\s*\[\s*mcp_servers\s*\.\s*(?:ae_functions|"ae_functions"|''ae_functions'')\s*\]\s*(?:#.*)?$'
    $records.Add([pscustomobject]@{ Text = $line; Outside = $outside; Header = $header; Owned = $owned })
    $index = 0
    while ($index -lt $content.Length) {
        if ($multiline) {
            if ($multiline -eq '"""' -and $content[$index] -eq '\') { $index += 2; continue }
            if ($index + 3 -le $content.Length -and $content.Substring($index, 3) -eq $multiline) { $multiline = ''; $index += 3; continue }
            $index += 1; continue
        }
        $character = $content[$index]
        if ($character -eq '#') { break }
        if ($character -eq '"' -or $character -eq "'") {
            $quote = [string]$character
            if ($index + 3 -le $content.Length -and $content.Substring($index, 3) -eq ($quote * 3)) {
                $multiline = $quote * 3; $index += 3; continue
            }
            $index += 1
            while ($index -lt $content.Length) {
                if ($quote -eq '"' -and $content[$index] -eq '\') { $index += 2; continue }
                if ([string]$content[$index] -eq $quote) { $index += 1; break }
                $index += 1
            }
            continue
        }
        $index += 1
    }
}
if ($multiline) { throw 'Cannot safely edit Codex configuration: an unterminated multiline TOML string was found.' }
$ownedIndices = @()
for ($index = 0; $index -lt $records.Count; $index += 1) { if ($records[$index].Owned) { $ownedIndices += $index } }
if ($ownedIndices.Count -ne 1) { throw 'Expected exactly one [mcp_servers.ae_functions] table after registration; configuration was not rewritten.' }
$tableStart = $ownedIndices[0]
$tableEnd = $records.Count
for ($index = $tableStart + 1; $index -lt $records.Count; $index += 1) {
    if ($records[$index].Header) { $tableEnd = $index; break }
}
$found = @{}
for ($index = $tableStart + 1; $index -lt $tableEnd; $index += 1) {
    if ($records[$index].Outside -and $records[$index].Text -match '^\s*(startup_timeout_sec|tool_timeout_sec)\s*=') {
        $key = $Matches[1]
        if ($found.ContainsKey($key)) { throw "Duplicate owned timeout setting: $key" }
        $found[$key] = $true
        $value = if ($key -eq 'startup_timeout_sec') { 10 } else { 210 }
        $records[$index].Text = "$key = $value$newline"
    }
}
$insert = ''
foreach ($key in @('startup_timeout_sec', 'tool_timeout_sec')) {
    if (-not $found.ContainsKey($key)) {
        $value = if ($key -eq 'startup_timeout_sec') { 10 } else { 210 }
        $insert += "$key = $value$newline"
    }
}
if ($insert) {
    if (-not $records[$tableStart].Text.EndsWith("`n")) { $records[$tableStart].Text += $newline }
    $records[$tableStart].Text += $insert
}
$updated = ($records | ForEach-Object { $_.Text }) -join ''
$changed = $updated -cne $original
if ($changed) {
    $temporaryPath = $ConfigPath + '.ae-functions-' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        # The only temporary full-config copy stays adjacent to the user's config, never in workspace logs.
        [IO.File]::WriteAllText($temporaryPath, $updated, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::ReadAllText($ConfigPath) -cne $original) { throw 'Codex configuration changed concurrently; timeout changes were not published. Run this installer again.' }
        [IO.File]::Move($temporaryPath, $ConfigPath, $true)
    } finally { if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force } }
}
[ordered]@{
    schema = 'codex-ae-mcp-install/v1'; state = 'success'; server = 'ae_functions'
    registered = -not $SkipRegistration; timeoutsUpdated = $changed; configPath = $ConfigPath
    command = $nodePath; serverPath = $serverPath; powershellPath = $pwshPath
    startupTimeoutSeconds = 10; toolTimeoutSeconds = 210
    nextStep = 'Open a new Codex chat or reload the MCP connections to load ae_functions. Project trust settings were not changed.'
} | ConvertTo-Json -Depth 8
