# Current-machine inventory

Codex Bridge loads saved inventory on connection. Effects and SFX have separate
saved indexing switches; click **Cập nhật thư viện** to scan the enabled groups.
There is no automatic scan on connection or every 120 seconds. These switches
never disable applied effects or project audio. This does not change the project. Read `current.json` first;
follow its catalog paths, timestamps, independent effects/SFX states and errors.
Effects loaded by another machine are never included in this package.

`config.json` records `refreshMode: "manual"`, `effects.enabled`, SFX consent and selected roots. Missing consent or
`sfx.enabled: false` disables SFX indexing. Older configurations with explicit
roots keep their existing behavior. Codex AE setup can enable indexing and select
folders later. Only metadata is indexed; audio is never copied or imported.
The **Thư mục…** button beside SFX opens the selected folder list, including folders on
a new drive. Saving locations does not enable or start a scan. Removing a folder
from this list does not delete files. Select the wrong row, click **Bỏ khỏi danh sách**,
then **Lưu**. Saving an empty list turns off SFX indexing; **Hủy** keeps the old config.
A changed folder list invalidates the old
advertised SFX cache until the next manual update.
Search the JSONL catalog with `rg`; do not load the entire catalog into context.

Effects appear only after AE has loaded the plugin. Catalog presence does not
prove licenses, render compatibility or a supported scripting API for a panel.
Inventory refresh is independent of the install-time bundle integrity check.
