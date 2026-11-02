$ErrorActionPreference='Stop'; $fail=0
function Check($ok,$n){ if($ok){"PASS $n"}else{"FAIL $n";$script:fail++} }
$root = Join-Path ([IO.Path]::GetTempPath()) ('aec-clean-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$v = Join-Path $root 'versions'
function MkVer($id,$hb){ $d=Join-Path $v $id; New-Item -ItemType Directory -Force (Join-Path $d '.ae-codex/bridge/inbox'),(Join-Path $d '.ae-codex/bridge/results'),(Join-Path $d 'tools') | Out-Null
  'x' | Set-Content (Join-Path $d 'tools/a.js'); if($hb){ $hb | Set-Content (Join-Path $d '.ae-codex/bridge/heartbeat.json') }; $d }
$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$active = MkVer '2.0.3-aaaaaaaaaaaa' $null
$idle   = MkVer '2.0.0-bbbbbbbbbbbb' ('{"state":"stopped","timestampEpochMs":'+($now-99999)+'}')
$live   = MkVer '2.0.1-cccccccccccc' ('{"state":"running","timestampEpochMs":'+$now+'}')
$queued = MkVer '2.0.2-dddddddddddd' $null; 'job' | Set-Content (Join-Path $queued '.ae-codex/bridge/inbox/job-x.job')
$ref    = MkVer '1.9.0-eeeeeeeeeeee' $null
$panel = Join-Path $root 'panel.jsx'; ('new File("' + $ref.Replace('\','/') + '/jsx/Codex Bridge.jsx")') | Set-Content $panel
New-Item -ItemType Directory -Force (Join-Path $v 'notaversion') | Out-Null
@{schema='codex-ae-installation/v1';runtimeRoot=$active;panelPath=$panel} | ConvertTo-Json | Set-Content (Join-Path $root 'installation.json')
$r = & (Join-Path $PSScriptRoot '../tools/Remove-AeOldVersions.ps1') -InstallRoot $root -Fixture | Out-String | ConvertFrom-Json
Check (@($r.removed) -join ',' -eq '2.0.0-bbbbbbbbbbbb') "only the idle unreferenced version removed: $(@($r.removed) -join ',')"
Check ((Test-Path $active) -and (Test-Path (Join-Path $v 'notaversion'))) 'active and non-version folders kept'
$reasons = @{}; foreach($d in $r.deferred){ $reasons[$d.version]=$d.reason }
Check ($reasons['2.0.1-cccccccccccc'] -match 'live') 'live bridge deferred'
Check ($reasons['2.0.2-dddddddddddd'] -match 'queued') 'queued job deferred'
Check ($reasons['1.9.0-eeeeeeeeeeee'] -match 'points to') 'referenced by loader deferred'
Check (Test-Path (Join-Path $root 'retired-data/2.0.0-bbbbbbbbbbbb.zip')) 'archive written'
foreach($i in 1..4){ $n=Join-Path $root "retired-data/old$i.zip"; 'z'|Set-Content $n; (Get-Item $n).LastWriteTimeUtc=[DateTime]::UtcNow.AddDays(-$i) }
& (Join-Path $PSScriptRoot '../tools/Remove-AeOldVersions.ps1') -InstallRoot $root -Fixture -KeepArchives 3 | Out-Null
Check (@(Get-ChildItem (Join-Path $root 'retired-data') -Filter *.zip).Count -eq 3) 'retired-data bounded to 3 archives'
Remove-Item -Recurse -Force $root
if($fail){exit 1}
