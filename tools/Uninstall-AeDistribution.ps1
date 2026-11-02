#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AE_Codex'),
    [string]$AppDataRoot = ([Environment]::GetFolderPath('ApplicationData')),
    [string]$LogPath,
    [string]$ResultPath,
    [string]$RequestPath,
    [string]$RunRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    [switch]$FixtureRegistry
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$payloadRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$setupLock = $null
$warnings = [Collections.Generic.List[string]]::new()
$preserved = [Collections.Generic.List[string]]::new()
$removedLoaders = [Collections.Generic.List[string]]::new()
$runtimeRoots = [Collections.Generic.List[string]]::new()
$programCandidates = [Collections.Generic.List[object]]::new()
$removedProgramFiles = [Collections.Generic.List[string]]::new()
$preservedModified = [Collections.Generic.List[string]]::new()
$recoveryRoot = $null
$metadata = $null
$metadataPath = $null
$mutationStarted = $false
$mcpRemoved = $false
$backgroundState = 'absent'
$outputsValidated = $false

function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) { throw "Không hỗ trợ đường dẫn liên kết khi gỡ cài đặt: $cursor" }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Test-IsChild([string]$Child,[string]$Parent) {
    return [IO.Path]::GetFullPath($Child).StartsWith([IO.Path]::GetFullPath($Parent).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
}
function Write-Atomic([string]$Path,[string]$Text,[switch]$NoOverwrite) {
    Assert-PlainPath $Path
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    $temporary = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
    try { [IO.File]::WriteAllText($temporary,$Text,$utf8); [IO.File]::Move($temporary,$Path,(-not $NoOverwrite)) }
    finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
function Write-ProgressLog([string]$Message) {
    $line = [datetime]::Now.ToString('HH:mm:ss') + ' ' + $Message
    [Console]::Error.WriteLine($line)
    if ($outputsValidated -and $LogPath) { [IO.File]::AppendAllText($LogPath,$line + [Environment]::NewLine,$utf8) }
}
function Assert-Idle([string]$Root) {
    $chatStatePath = Join-Path $Root '.ae-codex/chat/state.json'
    Assert-PlainPath $chatStatePath
    if ([IO.File]::Exists($chatStatePath)) {
        $chatState = [IO.File]::ReadAllText($chatStatePath) | ConvertFrom-Json -ErrorAction Stop
        if ($chatState.schema -cne 'codex-ae-chat-state/v1') { throw 'Không xác minh được trạng thái chat Codex. Dừng chat và kiểm tra trước khi gỡ.' }
        if ($null -ne $chatState.PSObject.Properties['error'] -and $null -ne $chatState.error -and
            $null -ne $chatState.error.PSObject.Properties['code'] -and $chatState.error.code -ceq 'TURN_STATE_UNKNOWN') {
            throw 'Chat Codex chưa xác nhận lượt chạy đã kết thúc. Kiểm tra cuộc chat trong Codex trước khi gỡ cài đặt; không tự chạy lại.'
        }
        if ($chatState.busy -or @($chatState.pendingRequests).Count -gt 0) { throw 'Chat Codex còn đang làm việc hoặc chờ trả lời. Dừng hoặc hoàn tất chat trước khi gỡ cài đặt.' }
    }
    foreach ($relative in @('.ae-codex/bridge/submit.lock','.ae-codex/active.lock')) {
        $target = Join-Path $Root $relative
        Assert-PlainPath $target
        if (Test-Path -LiteralPath $target) { throw "Có thể còn công việc AE đang chạy. Hoàn tất công việc trước khi gỡ; khóa được giữ nguyên: $target" }
    }
    $results = Join-Path $Root '.ae-codex/bridge/results'
    Assert-PlainPath $results
    if ([IO.Directory]::Exists($results)) {
        foreach ($started in Get-ChildItem -LiteralPath $results -Filter 'started-*.json' -File) {
            Assert-PlainPath $started.FullName
            $terminal = Join-Path $results ($started.Name -replace '^started-','status-')
            Assert-PlainPath $terminal
            if (-not [IO.File]::Exists($terminal)) { throw "Một công việc AE chưa có kết quả cuối. Kiểm tra công việc trước khi gỡ; không chạy lại hoặc xóa khóa: $($started.Name)" }
        }
    }
    $inbox = Join-Path $Root '.ae-codex/bridge/inbox'
    Assert-PlainPath $inbox
    if ([IO.Directory]::Exists($inbox)) {
        foreach ($queued in Get-ChildItem -LiteralPath $inbox -File) {
            if ($queued.Extension -in @('.job','.running','.json')) {
                Assert-PlainPath $queued.FullName
                throw 'Còn yêu cầu AE trong hàng đợi hoặc đang xử lý. Hoàn tất hoặc xử lý yêu cầu trước khi gỡ cài đặt.'
            }
        }
    }
    $heartbeat = Join-Path $Root '.ae-codex/bridge/heartbeat.json'
    Assert-PlainPath $heartbeat
    if ([IO.File]::Exists($heartbeat)) {
        $value = [IO.File]::ReadAllText($heartbeat) | ConvertFrom-Json -ErrorAction Stop
        if ($null -ne $value.PSObject.Properties['state'] -and $value.state -in @('running','starting','scanning','executing','busy')) {
            if ($null -eq $value.PSObject.Properties['timestampEpochMs']) { throw 'Không xác minh được bridge đã dừng. Nhấn Stop trong panel Codex AE hoặc đóng AE trước khi gỡ.' }
            $age = [datetimeoffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$value.timestampEpochMs
            if ($age -lt 15000) { throw 'Bridge AE vẫn đang hoạt động. Nhấn Stop trong panel Codex AE hoặc đóng AE rồi chờ 15 giây trước khi gỡ.' }
        }
    }
}
function Get-VerifiedTemplate([string]$Root,$Manifest,[string]$Name) {
    $relative = 'tools/' + $Name
    $entries = @($Manifest.files | Where-Object { $_.path -ceq $relative })
    if ($entries.Count -ne 1 -or [string]$entries[0].sha256 -cnotmatch '^[0-9a-f]{64}$') { throw "Thiếu dấu kiểm tra của loader: $relative" }
    $target = Join-Path $Root $relative
    Assert-PlainPath $target
    if (-not [IO.File]::Exists($target) -and $recoveryRoot) {
        $target = Join-Path $recoveryRoot ('program/' + [IO.Path]::GetFileName($Root) + '/' + $relative)
        Assert-PlainPath $target
    }
    if (-not [IO.File]::Exists($target) -or (Get-Item -LiteralPath $target).Length -ne [long]$entries[0].bytes -or
        (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $entries[0].sha256) { throw "Loader trong bản cài đã thay đổi; cần sửa bộ cài trước khi gỡ: $relative" }
    $template = [IO.File]::ReadAllText($target,$utf8)
    if ([regex]::Matches($template,'__CODEX_AE_WORKSPACE_BUNDLE__').Count -ne 1) { throw "Loader không đúng mẫu: $relative" }
    $bundle = Join-Path $Root 'jsx/Codex Bridge.jsx'
    Assert-PlainPath $bundle
    # Current installers emit URI-style separators; older loaders used Windows
    # separators. Accept only these two exact renderings of the verified template.
    foreach ($loaderPath in @($bundle.Replace('\','/'),$bundle)) {
        $template.Replace('__CODEX_AE_WORKSPACE_BUNDLE__',(ConvertTo-Json -InputObject $loaderPath -Compress -EscapeHandling EscapeNonAscii))
    }
}
function Get-OwnedProgramPath([string]$Root,[string]$Relative) {
    if (-not $Relative -or $Relative.Contains('\') -or $Relative -match '(^|/)\.{1,2}(/|$)' -or $Relative -match '[:\x00-\x1f]' -or [IO.Path]::IsPathRooted($Relative)) { throw "Đường dẫn manifest không an toàn: $Relative" }
    $target=[IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not (Test-IsChild $target $Root)) { throw 'Manifest trỏ ra ngoài runtime đã cài.' }
    Assert-PlainPath $target
    return $target
}
function Add-ProgramCandidates([string]$Root,$Manifest,[string]$ManifestPath) {
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $Manifest.files) {
        $relative=[string]$file.path
        $target=Get-OwnedProgramPath $Root $relative
        if (-not $seen.Add($relative) -or [string]$file.sha256 -cnotmatch '^[0-9a-f]{64}$' -or [long]$file.bytes -lt 0) { throw 'Manifest có mục trùng hoặc dấu kiểm tra không hợp lệ.' }
        # Configs, media, job results, catalogs and other user data can never be
        # promoted into deletable program files by a modified manifest.
        $static=$relative -cmatch '^(?:AGENTS\.md|jsx/Codex Bridge\.jsx|source/[A-Za-z0-9._ -]+\.(?:js|json)|tools/[A-Za-z0-9._ -]+\.(?:js|ps1|cs)|\.ae-codex/functions/(?:catalog|capabilities)\.json|\.ae-codex/(?:library|plugins)/USAGE\.md)$'
        if (-not $static) { $preserved.Add($target);$warnings.Add('Đã giữ mục ngoài phạm vi tệp chương trình: ' + $target);continue }
        if (-not [IO.File]::Exists($target)) { continue }
        if ((Get-Item -LiteralPath $target).Length -ne [long]$file.bytes -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $file.sha256) {
            $preservedModified.Add($target);$warnings.Add('Đã giữ tệp chương trình được sửa: ' + $target);continue
        }
        $programCandidates.Add([pscustomobject]@{root=$Root;relative=$relative;path=$target;sha256=[string]$file.sha256;order=$(if($relative -in @('tools/AeBridgePanel.js','tools/AeBridgeStartup.js')){2}else{1})})
    }
    if ([IO.File]::Exists((Join-Path $Root 'distribution.json'))) {
        $programCandidates.Add([pscustomobject]@{root=$Root;relative='distribution.json';path=(Join-Path $Root 'distribution.json');sha256=(Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash;order=3})
    }
    $certificatePath=Join-Path $Root '.ae-codex/library/background-launcher.json'
    $launcher=Join-Path $Root 'tools/Codex AE Background.exe'
    foreach($target in @($certificatePath,$launcher)){Assert-PlainPath $target}
    if([IO.File]::Exists($launcher)){
        if([IO.File]::Exists($certificatePath)){
            $certificate=[IO.File]::ReadAllText($certificatePath)|ConvertFrom-Json
            if($certificate.schemaVersion -eq 1 -and [string]$certificate.launcherSha256 -cmatch '^[0-9a-f]{64}$' -and (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -ieq $certificate.launcherSha256){
                $programCandidates.Add([pscustomobject]@{root=$Root;relative='tools/Codex AE Background.exe';path=$launcher;sha256=[string]$certificate.launcherSha256;order=1})
            }else{$preservedModified.Add($launcher);$warnings.Add('Đã giữ native helper không còn khớp dấu kiểm tra: '+$launcher)}
        }else{$preservedModified.Add($launcher);$warnings.Add('Đã giữ native helper không có chứng nhận cài đặt: '+$launcher)}
    }
}
function Publish-Result($Value) {
    $json = $Value | ConvertTo-Json -Depth 8
    if ($outputsValidated -and $ResultPath) { Write-Atomic $ResultPath $json -NoOverwrite }
    $json
}

try {
    if ($RequestPath) {
        $requestFull = [IO.Path]::GetFullPath($RequestPath)
        Assert-PlainPath $requestFull
        $request = [IO.File]::ReadAllText($requestFull) | ConvertFrom-Json -ErrorAction Stop
        if ($request.schema -cne 'codex-ae-uninstall-request/v1') { throw 'Không hỗ trợ định dạng yêu cầu gỡ cài đặt.' }
        foreach ($key in $request.PSObject.Properties.Name) {
            if ($key -notin @('schema','InstallRoot','AppDataRoot','LogPath','ResultPath','RunRegistryPath','FixtureRegistry')) { throw "Thuộc tính gỡ cài đặt không được hỗ trợ: $key" }
        }
        foreach ($key in @('InstallRoot','AppDataRoot','LogPath','ResultPath','RunRegistryPath')) {
            if ($null -ne $request.PSObject.Properties[$key]) { Set-Variable -Name $key -Value $request.$key }
        }
        if ($null -ne $request.PSObject.Properties['FixtureRegistry']) {
            if ($request.FixtureRegistry -isnot [bool]) { throw 'FixtureRegistry phải là boolean.' }
            $FixtureRegistry = $request.FixtureRegistry
        }
    }
    foreach ($value in @($InstallRoot,$AppDataRoot)) { if ([string]::IsNullOrWhiteSpace($value) -or -not [IO.Path]::IsPathFullyQualified($value)) { throw 'Thư mục cài đặt và AppData phải là đường dẫn tuyệt đối.' } }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\','/')
    $AppDataRoot = [IO.Path]::GetFullPath($AppDataRoot).TrimEnd('\','/')
    if ($InstallRoot -ieq [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\','/') -or $InstallRoot -ieq $payloadRoot -or (Test-IsChild $payloadRoot $InstallRoot) -or (Test-IsChild $InstallRoot $payloadRoot)) { throw 'Không gỡ thư mục source hoặc gói cài đặt. Chọn đúng thư mục đã cài riêng.' }
    $cursor = $InstallRoot
    while ($cursor) {
        if (Test-Path -LiteralPath (Join-Path $cursor '.git')) { throw 'Không gỡ một thư mục thuộc source checkout.' }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    foreach ($target in @($InstallRoot,$AppDataRoot)) { Assert-PlainPath $target }
    $setupRoot = Join-Path $InstallRoot '.ae-codex/setup'
    if (-not $LogPath) { $LogPath = Join-Path $setupRoot ('uninstall-' + [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '/progress.log') }
    if (-not [IO.Path]::IsPathFullyQualified($LogPath)) { throw 'Log gỡ cài đặt phải là đường dẫn tuyệt đối.' }
    $LogPath = [IO.Path]::GetFullPath($LogPath)
    $outputRoot = [IO.Path]::GetDirectoryName($LogPath)
    $sessionName = [IO.Path]::GetFileName($outputRoot)
    if ([IO.Path]::GetDirectoryName($outputRoot) -ine [IO.Path]::GetFullPath($setupRoot) -or
        $sessionName -cnotmatch '^(?:manager-uninstall|uninstall)-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$' -or
        $sessionName -ieq 'uninstall-backups' -or [IO.Path]::GetFileName($LogPath) -cne 'progress.log') {
        throw 'Log gỡ cài đặt phải là progress.log trong một phiên gỡ riêng dưới .ae-codex/setup.'
    }
    Assert-PlainPath $LogPath
    if (Test-Path -LiteralPath $LogPath) { throw 'Log của phiên gỡ đã tồn tại; không ghi đè dữ liệu. Tạo một phiên gỡ mới.' }
    if ($ResultPath) {
        if (-not [IO.Path]::IsPathFullyQualified($ResultPath)) { throw 'Kết quả gỡ cài đặt phải là đường dẫn tuyệt đối.' }
        $ResultPath = [IO.Path]::GetFullPath($ResultPath)
        if ([IO.Path]::GetDirectoryName($ResultPath) -ine $outputRoot -or [IO.Path]::GetFileName($ResultPath) -cne 'result.json') { throw 'Kết quả gỡ cài đặt phải là result.json trong cùng phiên gỡ với log.' }
        Assert-PlainPath $ResultPath
        if (Test-Path -LiteralPath $ResultPath) { throw 'Kết quả của phiên gỡ đã tồn tại; không ghi đè dữ liệu. Tạo một phiên gỡ mới.' }
    }
    [void][IO.Directory]::CreateDirectory($outputRoot)
    $newLog = [IO.File]::Open($LogPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    $newLog.Dispose()
    $outputsValidated = $true
    $metadataPath = Join-Path $InstallRoot 'installation.json'
    Assert-PlainPath $metadataPath
    $lockPath = Join-Path $setupRoot 'install.lock'
    Assert-PlainPath $lockPath
    [void][IO.Directory]::CreateDirectory($setupRoot)
    try { $setupLock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch { throw 'Một phiên cài đặt hoặc gỡ cài đặt khác đang chạy. Chờ hoàn tất rồi thử lại.' }
    if (-not [IO.File]::Exists($metadataPath)) {
        Write-ProgressLog 'Không tìm thấy bản cài đang hoạt động; không thay đổi AE hoặc Codex.'
        Publish-Result ([ordered]@{schema='codex-ae-uninstall-result/v1';state='success';installRoot=$InstallRoot;alreadyUninstalled=$true;retainedRuntimeData=$true;retainedProgramFiles=$false;retentionMode='user-data-and-program-backup';programFilesRemoved=@();preservedModifiedProgramFiles=@();removedLoaders=@();mcpRemoved=$false;backgroundServiceState='absent';warnings=@();preserved=@();logPath=$LogPath})
        return
    }
    $metadataText = [IO.File]::ReadAllText($metadataPath)
    $metadata = $metadataText | ConvertFrom-Json -ErrorAction Stop
    if ($metadata.schema -cne 'codex-ae-installation/v1' -or [string]$metadata.packageId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$') { throw 'Thông tin bản cài không hợp lệ; không có tệp nào bị gỡ.' }
    $versionsRoot = Join-Path $InstallRoot 'versions'
    $activeRoot = Join-Path $versionsRoot $metadata.packageId
    if ([IO.Path]::GetFullPath([string]$metadata.runtimeRoot).TrimEnd('\','/') -ine $activeRoot) { throw 'Đường dẫn runtime không thuộc phiên bản đã cài; không gỡ dữ liệu bên ngoài.' }
    Assert-PlainPath $activeRoot
    if ($null -ne $metadata.PSObject.Properties['recoveryBackupPath'] -and $metadata.recoveryBackupPath) {
        $recoveryRoot=[IO.Path]::GetFullPath([string]$metadata.recoveryBackupPath)
        if(-not(Test-IsChild $recoveryRoot (Join-Path $setupRoot 'uninstall-backups'))){throw 'Đường dẫn bản sao phục hồi không thuộc bản cài.'}
        Assert-PlainPath $recoveryRoot
    }
    if ($null -ne $metadata.PSObject.Properties['state'] -and $metadata.state -ceq 'uninstalled') {
        Write-ProgressLog 'Bản cài này đã được gỡ. Các cấu hình và dữ liệu được giữ nguyên.'
        Publish-Result ([ordered]@{schema='codex-ae-uninstall-result/v1';state='success';installRoot=$InstallRoot;runtimeRoot=$activeRoot;alreadyUninstalled=$true;retainedRuntimeData=$true;retainedProgramFiles=$false;retentionMode='user-data-and-program-backup';programFilesRemoved=@();preservedModifiedProgramFiles=@();removedLoaders=@();mcpRemoved=$false;backgroundServiceState='stopped';warnings=@();preserved=@();logPath=$LogPath})
        return
    }
    if ([string]$metadata.versionFolder -notmatch '^\d+\.\d+$') { throw 'Thông tin phiên bản AE không hợp lệ.' }
    $expectedScripts = Join-Path $AppDataRoot "Adobe/After Effects/$($metadata.versionFolder)/Scripts"
    $expectedPanel = Join-Path $expectedScripts 'ScriptUI Panels/Codex Bridge.jsx'
    $expectedStartup = Join-Path $expectedScripts 'Startup/Codex Bridge Startup.jsx'
    if ([IO.Path]::GetFullPath([string]$metadata.panelPath) -ine $expectedPanel -or [IO.Path]::GetFullPath([string]$metadata.startupPath) -ine $expectedStartup) { throw 'Đường dẫn loader không thuộc AppData/AE đã chọn; không gỡ tệp bên ngoài.' }
    Write-ProgressLog 'Đang kiểm tra bản cài và các công việc AE trước khi gỡ.'
    $loaderTexts = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    Assert-PlainPath $versionsRoot
    foreach ($directory in @(Get-ChildItem -LiteralPath $versionsRoot -Directory)) {
        if ($directory.Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$') { continue }
        Assert-PlainPath $directory.FullName
        $manifestPath = Join-Path $directory.FullName 'distribution.json'
        Assert-PlainPath $manifestPath
        if(-not[IO.File]::Exists($manifestPath) -and $recoveryRoot){$manifestPath=Join-Path $recoveryRoot ('program/'+$directory.Name+'/distribution.json');Assert-PlainPath $manifestPath}
        if (-not [IO.File]::Exists($manifestPath)) {
            if ($directory.FullName -ieq $activeRoot) { throw 'Thiếu manifest của bản cài đang hoạt động.' }
            continue
        }
        $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json -ErrorAction Stop
        if ($manifest.schema -cne 'codex-ae-distribution/v1' -or $manifest.packageId -cne $directory.Name) {
            if ($directory.FullName -ieq $activeRoot) { throw 'Manifest runtime không khớp bản cài.' }
            $preserved.Add($directory.FullName)
            continue
        }
        Assert-Idle $directory.FullName
        $loaderTexts.Add($directory.FullName,[pscustomobject]@{panel=(Get-VerifiedTemplate $directory.FullName $manifest 'AeBridgePanel.js');startup=(Get-VerifiedTemplate $directory.FullName $manifest 'AeBridgeStartup.js')})
        Add-ProgramCandidates $directory.FullName $manifest $manifestPath
        $runtimeRoots.Add($directory.FullName)
    }
    if (-not $loaderTexts.ContainsKey($activeRoot)) { throw 'Không xác minh được runtime đang hoạt động.' }
    $loaderCandidates = [Collections.Generic.List[object]]::new()
    $aeSettings = Join-Path $AppDataRoot 'Adobe/After Effects'
    Assert-PlainPath $aeSettings
    if ([IO.Directory]::Exists($aeSettings)) {
        foreach ($version in Get-ChildItem -LiteralPath $aeSettings -Directory) {
            if ($version.Name -notmatch '^\d+\.\d+$') { continue }
            foreach ($entry in @(@('panel','Scripts/ScriptUI Panels/Codex Bridge.jsx'),@('startup','Scripts/Startup/Codex Bridge Startup.jsx'))) {
                $target = Join-Path $version.FullName $entry[1]
                Assert-PlainPath $target
                if (-not [IO.File]::Exists($target)) { continue }
                $text = [IO.File]::ReadAllText($target,$utf8)
                $owned = $false
                foreach ($templates in $loaderTexts.Values) { if ($templates.($entry[0]) -ccontains $text) { $owned=$true;break } }
                if ($owned) { $loaderCandidates.Add([pscustomobject]@{path=$target;bytes=[IO.File]::ReadAllBytes($target);sha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash}) }
                else { $preserved.Add($target);$warnings.Add("Đã giữ loader được sửa hoặc thuộc bản cài khác: $target") }
            }
        }
    }
    $backgroundHelper = Join-Path $PSScriptRoot 'AeBackgroundServiceLifecycle.ps1'
    Assert-PlainPath $backgroundHelper
    if (-not [IO.File]::Exists($backgroundHelper)) { throw 'Thiếu công cụ dừng nền an toàn. Dùng bộ cài Codex AE đầy đủ để gỡ.' }
    $realAppData = [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData')).TrimEnd('\','/')
    $lifecycleArguments = @{}
    if ($FixtureRegistry) { $lifecycleArguments = @{FixtureRegistry=$true;RunRegistryPath=$RunRegistryPath} }
    elseif ($RunRegistryPath -ine 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') { throw 'Đường dẫn registry thử nghiệm cần FixtureRegistry.' }
    $backupRoot = Join-Path $setupRoot ('uninstall-backups/' + [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    Assert-PlainPath $backupRoot
    [void][IO.Directory]::CreateDirectory($backupRoot)
    [IO.File]::WriteAllText((Join-Path $backupRoot 'installation.json'),$metadataText,$utf8)
    Write-ProgressLog 'Đang sao lưu từng tệp chương trình đã xác minh; không xóa dữ liệu người dùng.'
    $readyProgramFiles=[Collections.Generic.List[object]]::new()
    foreach($candidate in @($programCandidates|Sort-Object order,path)){
        Assert-PlainPath $candidate.path
        if(-not[IO.File]::Exists($candidate.path)){continue}
        if((Get-FileHash -LiteralPath $candidate.path -Algorithm SHA256).Hash -ine $candidate.sha256){$preservedModified.Add($candidate.path);$warnings.Add('Tệp thay đổi trong lúc gỡ, đã giữ: '+$candidate.path);continue}
        $backup=Join-Path $backupRoot ('program/'+[IO.Path]::GetFileName($candidate.root)+'/'+$candidate.relative)
        Assert-PlainPath $backup
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup))
        [IO.File]::Copy($candidate.path,$backup,$false)
        if((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ine $candidate.sha256){throw 'Bản sao phục hồi không khớp; không xóa tệp chương trình.'}
        $readyProgramFiles.Add($candidate)
    }
    # Persist a complete recovery point before registry, service, MCP or loader
    # changes. Even a failure during the first external call is a partial removal.
    $mutationStarted=$true
    foreach ($entry in @{state='uninstall-in-progress';installed=$false;recoveryBackupPath=$backupRoot}.GetEnumerator()) { $metadata | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force }
    # A retry may need previously removed templates/manifests. Keep its original
    # complete recovery chain when starting from an older partial backup.
    if($recoveryRoot){$metadata.recoveryBackupPath=$recoveryRoot}
    Write-Atomic $metadataPath ($metadata | ConvertTo-Json -Depth 8)
    if ($AppDataRoot -ieq $realAppData -or $FixtureRegistry) {
        Write-ProgressLog 'Đang tắt tự khởi động và chờ công cụ nền hoàn tất; không buộc dừng AE.'
        foreach ($runtime in $runtimeRoots) {
            try {
                $disabled = & $backgroundHelper -Action Disable -WorkspaceRoot $runtime @lifecycleArguments | ConvertFrom-Json
                if ($disabled.state -cne 'success' -or $disabled.serviceRunning) { throw 'Công cụ nền chưa dừng.' }
                $backgroundState = 'stopped'
            } catch {
                if ($_.Exception.Message -match 'not owned by this runtime') { $warnings.Add('Đã giữ mục khởi động nền không thuộc bản cài này.');continue }
                throw
            }
        }
    } else { $backgroundState='skipped-fixture' }
    $codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' } else { $env:CODEX_HOME }
    $configPath = [IO.Path]::GetFullPath((Join-Path $codexHome 'config.toml'))
    Assert-PlainPath $configPath
    if ([IO.File]::Exists($configPath)) {
        if ($null -ne $metadata.PSObject.Properties['mcpConfigPath'] -and $metadata.mcpConfigPath -and [IO.Path]::GetFullPath([string]$metadata.mcpConfigPath) -ine $configPath) {
            $warnings.Add('Cấu hình Codex hiện tại khác tài khoản lúc cài; không sửa cấu hình của tài khoản khác.')
        } else {
            $configHelper = Join-Path $PSScriptRoot 'AeCodexConfig.js'
            Assert-PlainPath $configHelper
            $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -eq $node -or -not [IO.File]::Exists($configHelper)) { throw 'Cần Node.js và công cụ cấu hình Codex trong bộ cài để gỡ liên kết an toàn.' }
            Write-ProgressLog 'Đang gỡ duy nhất liên kết tool của bản cài này khỏi Codex.'
            $foreignMcpWarning = $null
            foreach ($runtime in $runtimeRoots) {
                $output = @(& $node.Source $configHelper --remove $configPath $runtime 2>&1)
                if ($LASTEXITCODE -ne 0) { throw "Không sửa được cấu hình Codex an toàn: $($output -join ' ')" }
                $removed = ($output -join "`n") | ConvertFrom-Json -ErrorAction Stop
                if ($removed.changed) { $mcpRemoved=$true;break }
                if ($null -ne $removed.PSObject.Properties['warning'] -and $removed.warning) { $foreignMcpWarning=[string]$removed.warning }
            }
            if (-not $mcpRemoved -and $foreignMcpWarning) { $warnings.Add('Đã giữ liên kết Codex thuộc runtime khác: ' + $foreignMcpWarning) }
        }
    }
    Write-ProgressLog 'Đang gỡ các loader AE đã xác minh; giữ nguyên source, dự án, media và cấu hình.'
    $index=0
    foreach ($candidate in $loaderCandidates) {
        Assert-PlainPath $candidate.path
        if (-not [IO.File]::Exists($candidate.path)) { continue }
        if ((Get-FileHash -LiteralPath $candidate.path -Algorithm SHA256).Hash -cne $candidate.sha256) { $warnings.Add('Loader thay đổi trong lúc gỡ, đã giữ nguyên: ' + $candidate.path);$preserved.Add($candidate.path);continue }
        [IO.File]::WriteAllBytes((Join-Path $backupRoot (('loader-{0:D3}-' -f $index) + [IO.Path]::GetFileName($candidate.path))),$candidate.bytes)
        [IO.File]::Delete($candidate.path)
        $removedLoaders.Add($candidate.path)
        $index++
    }
    Write-ProgressLog 'Bản sao phục hồi đã kiểm tra xong. Đang gỡ các tệp chương trình thuộc bản cài.'
    foreach($candidate in $readyProgramFiles){
        Assert-PlainPath $candidate.path
        if(-not[IO.File]::Exists($candidate.path)){continue}
        if((Get-FileHash -LiteralPath $candidate.path -Algorithm SHA256).Hash -ine $candidate.sha256){$preservedModified.Add($candidate.path);$warnings.Add('Tệp thay đổi sau khi sao lưu, đã giữ: '+$candidate.path);continue}
        [IO.File]::Delete($candidate.path)
        $removedProgramFiles.Add($candidate.path)
    }
    foreach ($entry in @{state='uninstalled';installed=$false;uninstalledAt=[datetime]::UtcNow.ToString('o');mcpState='uninstalled';backgroundServiceState=$backgroundState;backgroundAutostartRegistered=$false}.GetEnumerator()) { $metadata | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force }
    Write-Atomic $metadataPath ($metadata | ConvertTo-Json -Depth 8)
    foreach ($warning in $warnings) { Write-ProgressLog ('LƯU Ý: ' + $warning) }
    Write-ProgressLog 'Đã gỡ Codex AE. Dữ liệu, log và bản sao lưu được giữ nguyên.'
    Publish-Result ([ordered]@{schema='codex-ae-uninstall-result/v1';state='success';installRoot=$InstallRoot;runtimeRoot=$activeRoot;installationPath=$metadataPath;alreadyUninstalled=$false;retainedRuntimeData=$true;retainedProgramFiles=$false;retentionMode='user-data-and-program-backup';programFilesRemoved=$removedProgramFiles.ToArray();preservedModifiedProgramFiles=$preservedModified.ToArray();removedLoaders=$removedLoaders.ToArray();mcpRemoved=$mcpRemoved;backgroundServiceState=$backgroundState;warnings=$warnings.ToArray();preserved=$preserved.ToArray();backupPath=$backupRoot;logPath=$LogPath;nextStep='Tải lại MCP hoặc mở lại Codex để hoàn tất. Tệp chương trình đã được gỡ; cấu hình, dữ liệu và bản sao phục hồi nằm trong .ae-codex. Không có dự án hoặc media nào bị xóa.'})
} catch {
    $message=$_.Exception.Message
    if($mutationStarted -and $metadata -and $metadataPath){
        try{$metadata|Add-Member -NotePropertyName state -NotePropertyValue 'uninstall-incomplete' -Force;Write-Atomic $metadataPath ($metadata|ConvertTo-Json -Depth 8)}catch{}
    }
    try { Write-ProgressLog ('LỖI: ' + $message) } catch { }
    Publish-Result ([ordered]@{schema='codex-ae-uninstall-result/v1';state='error';error=$message;installRoot=$InstallRoot;warnings=$warnings.ToArray();removedLoaders=$removedLoaders.ToArray();programFilesRemoved=$removedProgramFiles.ToArray();partialRemoval=$mutationStarted;mcpRemoved=$mcpRemoved;retainedRuntimeData=$true;logPath=$LogPath})
    exit 1
} finally { if ($null -ne $setupLock) { $setupLock.Dispose() } }
