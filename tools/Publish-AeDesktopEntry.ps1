#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()][string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..'),
    [Alias('Tidy')][switch]$CompactLayout,
    [Alias('Restore')][switch]$RestoreLayout
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd([char[]]'\/')
$utf8 = [Text.UTF8Encoding]::new($false)
if ($CompactLayout -and $RestoreLayout) { throw 'Choose CompactLayout or RestoreLayout, not both.' }
function Assert-Ordinary([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked paths are not supported: $cursor" }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Write-Atomic([string]$Path, [string]$Text) {
    Assert-Ordinary $Path
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    $temporary = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
    try { [IO.File]::WriteAllText($temporary, $Text, $utf8); [IO.File]::Move($temporary, $Path, $true) }
    finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
$hiddenNames = @('source','tools','jsx','tests','docs','assets','outputs','.ae-codex','.codex','.git','README.md','AGENTS.md','.gitignore','.gitattributes')
Assert-Ordinary $WorkspaceRoot
$layoutPath = Join-Path $WorkspaceRoot '.ae-codex/setup/workspace-layout.json'
Assert-Ordinary $layoutPath
if ($RestoreLayout) {
    if (-not [IO.File]::Exists($layoutPath)) { throw 'There is no Codex AE layout record to restore.' }
    $layout = [IO.File]::ReadAllText($layoutPath) | ConvertFrom-Json -ErrorAction Stop
    if ($layout.schema -cne 'codex-ae-workspace-layout/v1' -or $layout.workspaceRoot -ine $WorkspaceRoot) { throw 'The layout record does not belong to this workspace.' }
    if ($layout.state -ceq 'restored') {
        [pscustomobject]@{schemaVersion=1;state='success';restored=0;layoutPath=$layoutPath} | ConvertTo-Json -Compress
        return
    }
    if ($layout.state -cne 'compact') { throw 'The layout record has an unsupported state.' }
    $restored = 0
    foreach ($entry in $layout.entries) {
        if ($entry.name -cnotin $hiddenNames -or $entry.hiddenBefore -isnot [bool]) { throw 'The layout record contains an unsupported entry.' }
        $target = Join-Path $WorkspaceRoot $entry.name
        Assert-Ordinary $target
        if (-not (Test-Path -LiteralPath $target)) { continue }
        $attributes = [IO.File]::GetAttributes($target)
        if (-not $entry.hiddenBefore -and ($attributes -band [IO.FileAttributes]::Hidden)) {
            # Restore only the bit this script owns, preserving newer flags.
            [IO.File]::SetAttributes($target, ($attributes -band (-bnot [IO.FileAttributes]::Hidden)))
            $restored++
        }
    }
    $layout | Add-Member -NotePropertyName state -NotePropertyValue 'restored' -Force
    Write-Atomic $layoutPath ($layout | ConvertTo-Json -Depth 8)
    [pscustomobject]@{schemaVersion=1;state='success';restored=$restored;layoutPath=$layoutPath} | ConvertTo-Json -Compress
    return
}
$latestPath = Join-Path $WorkspaceRoot '.ae-codex/releases/latest.json'
Assert-Ordinary $latestPath
$latest = [IO.File]::ReadAllText($latestPath) | ConvertFrom-Json -ErrorAction Stop
if ($latest.schema -cne 'codex-ae-release-build/v1' -or $latest.state -cne 'success' -or $latest.packageId -cnotmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$') { throw 'The local release pointer is invalid.' }
$packageRoot = Join-Path $WorkspaceRoot ('.ae-codex/releases/CodexAE-' + $latest.packageId)
Assert-Ordinary $packageRoot
$builder = Join-Path $WorkspaceRoot 'tools/Build-AeDistribution.js'
$source = Join-Path $WorkspaceRoot 'tools/AeLauncher.cs'
foreach ($target in @($builder,$source)) { Assert-Ordinary $target }
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$verificationOutput = @(& $node $builder --verify-package $packageRoot 2>&1)
if ($LASTEXITCODE -ne 0) { throw "The sanitized release could not be verified: $($verificationOutput -join ' ')" }
$verification = ($verificationOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
if ($verification.state -cne 'success' -or $verification.packageId -cne $latest.packageId) { throw 'The verified package identity does not match latest.json.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not [IO.File]::Exists($compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
if (-not [IO.File]::Exists($compiler)) { throw '.NET Framework 4 C# compiler is required to publish the root launcher.' }
$launcher = Join-Path $WorkspaceRoot 'Codex AE.exe'
Assert-Ordinary $launcher
$temporaryLauncher = Join-Path $WorkspaceRoot ('.Codex-AE-entry-' + [guid]::NewGuid().ToString('N') + '.exe')
$backup = $null
try {
    $compile = @(& $compiler /nologo /target:winexe /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$temporaryLauncher" $source 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Root launcher compilation failed: $($compile -join ' ')" }
    $check = Start-Process -FilePath $temporaryLauncher -ArgumentList '--check' -WindowStyle Hidden -Wait -PassThru
    try { if ($check.ExitCode -ne 0) { throw "Root launcher validation failed: $($check.ExitCode)" } } finally { $check.Dispose() }
    if ([IO.File]::Exists($launcher) -and (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $temporaryLauncher -Algorithm SHA256).Hash) {
        $backup = Join-Path $WorkspaceRoot ('.ae-codex/setup/entry-backups/Codex-AE-' + [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.exe')
        Assert-Ordinary $backup
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup))
        [IO.File]::Copy($launcher, $backup, $false)
    }
    [IO.File]::Move($temporaryLauncher, $launcher, $true)
} finally { if ([IO.File]::Exists($temporaryLauncher)) { [IO.File]::Delete($temporaryLauncher) } }
Write-Atomic (Join-Path $WorkspaceRoot 'HUONG-DAN.txt') @'
CODEX AE

Mở Codex AE.exe để cài đặt hoặc cập nhật Codex AE trên máy này.
Sau khi cài, mở lại Codex một lần và mở Adobe After Effects.
Trong AE, mở Window > Codex Bridge để kết nối và dùng công cụ.
Gửi yêu cầu trực tiếp trong Codex trên máy này; panel không có chat tích hợp.
Chọn Effects / SFX rồi bấm Cập nhật thư viện khi có plugin hoặc sound mới.
Mở Thư mục… bên cạnh SFX để thêm hoặc đổi thư mục âm thanh trên ổ mới; lưu xong mới bấm cập nhật.
Để bỏ đường dẫn sai: chọn dòng → Bỏ khỏi danh sách → Lưu. Bỏ hết và lưu sẽ tắt SFX; Hủy giữ nguyên.
Hai ô chỉ bật/tắt lập danh mục, không đổi effect hoặc âm thanh trong project.
Panel nạp cache khi kết nối, không tự quét lại mỗi hai phút. Nhật ký có thể thu gọn.
Cài thành công: hiện thông báo tiếng Việt rồi tự đóng sau 3 giây.
Để gỡ một bản đã cài: chọn đúng nơi cài đặt và bấm Gỡ cài đặt.
Bấm Stop trong panel AE và chờ công việc hoàn tất trước khi gỡ.

Để chia sẻ sang máy khác, gửi file CodexAE-*.zip mới nhất trong .ae-codex/releases.
Các thư mục kỹ thuật được giữ nguyên tại chỗ; giao diện gọn chỉ ẩn chúng.
Khôi phục hiển thị: pwsh -NoProfile -File tools/Publish-AeDesktopEntry.ps1 -RestoreLayout
'@
$hidden = 0
if ($CompactLayout) {
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($name in $hiddenNames) {
        $target = Join-Path $WorkspaceRoot $name
        Assert-Ordinary $target
        if (-not (Test-Path -LiteralPath $target)) { continue }
        $attributes = [IO.File]::GetAttributes($target)
        $entries.Add([pscustomobject]@{name=$name;hiddenBefore=[bool]($attributes -band [IO.FileAttributes]::Hidden);attributesBefore=[int]$attributes})
    }
    # Preserve the first still-active baseline across repeat publications.
    if ([IO.File]::Exists($layoutPath)) {
        $prior = [IO.File]::ReadAllText($layoutPath) | ConvertFrom-Json -ErrorAction Stop
        if ($prior.schema -cne 'codex-ae-workspace-layout/v1' -or $prior.workspaceRoot -ine $WorkspaceRoot) { throw 'The existing layout record is invalid.' }
        if ($prior.state -ceq 'compact') {
            foreach ($entry in $entries) {
                $owned = @($prior.entries | Where-Object { $_.name -ceq $entry.name })
                if ($owned.Count -eq 1) { $entry.hiddenBefore = $owned[0].hiddenBefore; $entry.attributesBefore = $owned[0].attributesBefore }
            }
        }
    }
    $layout = [ordered]@{schema='codex-ae-workspace-layout/v1';state='compact';workspaceRoot=$WorkspaceRoot;createdUtc=[datetime]::UtcNow.ToString('o');entries=$entries.ToArray()}
    Write-Atomic $layoutPath ($layout | ConvertTo-Json -Depth 8)
    foreach ($entry in $entries) {
        $target = Join-Path $WorkspaceRoot $entry.name
        $attributes = [IO.File]::GetAttributes($target)
        if (-not ($attributes -band [IO.FileAttributes]::Hidden)) { [IO.File]::SetAttributes($target, ($attributes -bor [IO.FileAttributes]::Hidden)); $hidden++ }
    }
}
[pscustomobject]@{schemaVersion=1;state='success';launcherPath=$launcher;packageId=$latest.packageId;guidePath=(Join-Path $WorkspaceRoot 'HUONG-DAN.txt');compactLayout=[bool]$CompactLayout;hidden=$hidden;layoutPath=$layoutPath;backupPath=$backup} | ConvertTo-Json -Compress
