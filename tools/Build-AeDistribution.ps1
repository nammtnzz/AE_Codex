#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$output = & $node (Join-Path $PSScriptRoot 'Build-AeDistribution.js')
if ($LASTEXITCODE -ne 0) { throw 'Sanitized release build failed.' }
$release = ($output -join "`n") | ConvertFrom-Json
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4 C# compiler is required to build the Windows launcher.' }
$launcher = Join-Path $release.packagePath 'Codex AE.exe'
$compileOutput = & $compiler /nologo /target:winexe /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$launcher" (Join-Path $PSScriptRoot 'AeLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw "Codex AE launcher compilation failed: $($compileOutput -join ' ')" }
$check = Start-Process -FilePath $launcher -ArgumentList '--check' -WindowStyle Hidden -Wait -PassThru
if ($check.ExitCode -ne 0) { throw "Launcher package smoke check failed: $($check.ExitCode)" }
$verificationOutput = & $node (Join-Path $PSScriptRoot 'Build-AeDistribution.js') --verify-package $release.packagePath
if ($LASTEXITCODE -ne 0) { throw 'Release file-set verification failed; ZIP creation was stopped.' }
$verification = ($verificationOutput -join "`n") | ConvertFrom-Json
if ($verification.state -cne 'success' -or $verification.packageId -cne $release.packageId) { throw 'Release identity changed before ZIP creation.' }
$zip = $release.packagePath + '.zip'
Compress-Archive -LiteralPath $release.packagePath -DestinationPath $zip -CompressionLevel Optimal -Force
$release | Add-Member -NotePropertyName zipPath -NotePropertyValue $zip
$release | Add-Member -NotePropertyName zipBytes -NotePropertyValue (Get-Item -LiteralPath $zip).Length
$release | Add-Member -NotePropertyName zipSha256 -NotePropertyValue (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$release | Add-Member -NotePropertyName launcherPath -NotePropertyValue $launcher
$release | Add-Member -NotePropertyName signed -NotePropertyValue $false
$report = Join-Path $workspace '.ae-codex/releases/latest.json'
[IO.File]::WriteAllText($report, ($release | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
$release | ConvertTo-Json -Depth 16
