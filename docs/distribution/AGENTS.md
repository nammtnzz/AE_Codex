# Installed After Effects tools

Use installed native tools and JSON plans. Start with `ae_search_capabilities`,
inspect the chosen tool with `ae_inspect_capability`, then run it using JSON args.
There are 43 reusable public tools. Do not create task-specific JSX or arbitrary
eval requests. Add a reviewed reusable named function in development when needed.

Codex AE is a tools-and-connection panel with Stop/Reconnect, inventory
status and a bounded job log. The user writes requests directly in Codex; Codex
calls the local `ae_functions` MCP server. Model, effort, skills and conversations
stay in Codex. Do not add an embedded chat, history polling, thumbnail cache,
image-generation UI, media viewer or a second Codex app-server process.
The SFX background helper must not start a chat host. Legacy chat sources remain
development history only and must not be included or started in a release.
Never copy credentials, account history, skill configuration or API keys from
another computer. Preserve the user's global approval/sandbox settings and all
unrelated Codex configuration; installation registers only `ae_functions`.

Before updating an older installation, check for active legacy chat, pending
approval, in-flight request, AE job or uncertain dispatched outcome. Wait until
these are idle/resolved, then shut down only the owned idle legacy runtime through
its supported lifecycle. Never interrupt unrelated Codex processes or replay a
request. Do not uninstall as an update step.

`inspection.capture` defaults to one current frame. A request/plan permits only one
capture step with at most three frames (`times` or `numFrames`, never both).
Reject plans exceeding that limit before any project edit runs.
Do not schedule continuous/automatic captures or render a whole composition for
text-only requests. Check pixels after meaningful edits when visual evidence is
needed; prefer project/property metadata when pixels are unnecessary.

The panel must be connected inside After Effects. Read `.ae-codex/library/current.json`
and `.ae-codex/library/USAGE.md` for current-machine effects/audio inventory.
Inspect effect matchNames in `.ae-codex/plugins/effects-and-parameters.tsv`.
SFX indexing is opt-in; only configured folders may be indexed. An inventory
entry does not prove licensing or authorize applying/importing unrelated media.
Effects and SFX have independent saved indexing switches. Connection loads cached
inventory only; the user's **Cập nhật thư viện** action refreshes enabled groups.
Do not scan automatically on connection or every two minutes. Disabled catalogs
must not be advertised. Switching indexing never changes applied effects/audio.

Do only requested project edits. Never replay a dispatched plan automatically:
earlier steps may already have changed the project. Check immutable started/status
files and the project after errors. Never clear a timeout lock or kill AE blindly.
Keep job data/results/logs under `.ae-codex/`. Do not save, close, overwrite,
render, import or delete project data unless required by the user request.
