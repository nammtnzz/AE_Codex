#Requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture = Join-Path $workspace ('.ae-codex/tests/setup-dependencies-' + [guid]::NewGuid().ToString('N'))
$checks = New-Object 'Collections.Generic.List[string]'
$utf8 = New-Object Text.UTF8Encoding($false)
function Assert-Check([bool]$Condition,[string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $checks.Add($Message)
}
$definitions = @{}
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $workspace 'tools/Manage-AeInstallation.ps1'),[ref]$tokens,[ref]$errors)
Assert-Check ($errors.Count -eq 0) 'The manager parses without launching its UI or installer.'
foreach ($name in @('Get-SetupPowerShellCandidates','Test-SetupPowerShell7','Find-SetupDependency')) {
    $definition = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
    if ($null -eq $definition) { throw ('Missing dependency helper: ' + $name) }
    $definitions[$name] = $definition.Extent.Text
    . ([scriptblock]::Create($definition.Extent.Text))
}
Assert-Check ($definitions['Get-SetupPowerShellCandidates'] -notmatch 'Get-ChildItem|Start-Process|Invoke-Expression') 'Dependency discovery uses fixed locations without recursive scans or child processes.'
[void][IO.Directory]::CreateDirectory($fixture)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
$versions = @{}
foreach ($major in @(6,7)) {
    $directory = Join-Path $fixture ('v' + $major)
    [void][IO.Directory]::CreateDirectory($directory)
    $source = Join-Path $directory 'fixture.cs'
    $output = Join-Path $directory 'pwsh.exe'
    $marker = (Join-Path $fixture 'unexpected-execution.txt').Replace('\','\\').Replace('"','\"')
    $code = 'using System.Reflection; [assembly: AssemblyFileVersion("' + $major + '.0.0.0")] [assembly: AssemblyInformationalVersion("' + $major + '.0.0")] class Fixture { static void Main() { System.IO.File.WriteAllText("' + $marker + '","must not run"); } }'
    [IO.File]::WriteAllText($source,$code,$utf8)
    $compiled = @(& $compiler /nologo /target:winexe /optimize+ "/out:$output" $source 2>&1)
    if ($LASTEXITCODE -ne 0) { throw ('Fixture compilation failed: ' + ($compiled -join ' ')) }
    $versions[$major] = $output
}
$invalid = Join-Path $fixture 'invalid.exe'
[IO.File]::WriteAllText($invalid,'not an executable',$utf8)
Assert-Check (-not (Test-SetupPowerShell7 $versions[6])) 'PowerShell versions below 7 are rejected by file metadata.'
Assert-Check (Test-SetupPowerShell7 $versions[7]) 'A version 7 executable is accepted without starting it.'
Assert-Check (-not (Test-SetupPowerShell7 $invalid) -and -not (Test-SetupPowerShell7 (Join-Path $fixture 'missing.exe'))) 'Malformed and missing executables are unavailable rather than false positives.'

$script:dependencyCommands = @{}
function Get-Command {
    param([string]$Name,[switch]$All,$CommandType,$ErrorAction)
    if ($script:dependencyCommands.ContainsKey($Name)) { return $script:dependencyCommands[$Name] }
}
$script:dependencyCommands.pwsh = @([pscustomobject]@{Source=$versions[6]},[pscustomobject]@{Source=$versions[7]},[pscustomobject]@{Source=$versions[7]})
$userRoot = Join-Path $fixture 'User đầy đủ'
$localRoot = Join-Path $userRoot 'AppData/Local'
$programRoot = Join-Path $fixture 'Program Files'
$candidates = @(Get-SetupPowerShellCandidates -ProgramRoots @($programRoot,$programRoot) -LocalRoot $localRoot -UserRoot $userRoot)
Assert-Check ($candidates[0] -ceq $versions[6] -and $candidates[1] -ceq $versions[7]) 'PATH candidates retain order while repeated paths are deduplicated.'
Assert-Check (@($candidates | Where-Object { $_ -ceq (Join-Path $programRoot 'PowerShell/7/pwsh.exe') }).Count -eq 1) 'Repeated system roots are checked once.'
Assert-Check ($candidates -contains (Join-Path $localRoot 'Programs/PowerShell/7/pwsh.exe') -and $candidates -contains (Join-Path $userRoot 'scoop/apps/pwsh/current/pwsh.exe')) 'Common per-user PowerShell locations are included.'
$codexRelative = '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'
Assert-Check ($candidates -contains (Join-Path $userRoot $codexRelative)) 'Codex bundled PowerShell is resolved relative to this user, without a source-machine path.'
$script:dependencyCandidates = @($versions[6],$invalid,$versions[7])
function Get-SetupPowerShellCandidates { return $script:dependencyCandidates }
Assert-Check ((Find-SetupDependency 'pwsh') -ceq $versions[7]) 'Discovery skips unsupported or invalid PATH entries and finds a later supported version.'
$script:dependencyCandidates = @($versions[6],$invalid)
Assert-Check ($null -eq (Find-SetupDependency 'pwsh')) 'Only unsupported or malformed candidates yield a missing dependency.'
$script:dependencyCommands.node = @([pscustomobject]@{Source='D:/fixture/node.exe'})
Assert-Check ((Find-SetupDependency 'node') -ceq 'D:/fixture/node.exe') 'Node and other application discovery retain their existing PATH behavior.'
$script:dependencyCommands = @{}
. ([scriptblock]::Create($definitions['Get-SetupPowerShellCandidates']))
$codexPath = Join-Path $userRoot $codexRelative
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($codexPath))
Copy-Item -LiteralPath $versions[7] -Destination $codexPath
$script:dependencyCandidates = @(Get-SetupPowerShellCandidates -ProgramRoots @() -LocalRoot '' -UserRoot $userRoot)
function Get-SetupPowerShellCandidates { return $script:dependencyCandidates }
Assert-Check ((Find-SetupDependency 'pwsh') -ceq $codexPath) 'An Explorer-like environment with no PATH PowerShell discovers this user''s Codex runtime.'
Assert-Check (-not (Test-Path -LiteralPath (Join-Path $fixture 'unexpected-execution.txt'))) 'No candidate executable was started during any discovery check.'
[pscustomobject]@{state='success';checks=$checks.Count;messages=@($checks);fixtureRoot=$fixture;realInstallationChanged=$false} | ConvertTo-Json -Depth 4
