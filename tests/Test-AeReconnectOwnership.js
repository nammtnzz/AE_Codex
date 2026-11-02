"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const harness = { require, process, __dirname, console, Buffer };
vm.createContext(harness);
const hostSource = fs.readFileSync(path.join(__dirname, "Test-AeBridgeLibrary.js"), "utf8");
vm.runInContext(hostSource.slice(0, hostSource.indexOf("const tests = [];")) + "\nthis.makeHost=mockHost;", harness);
const latest = fs.readFileSync(path.join(__dirname, "../source/bridge.js"), "utf8").replace(/^#.*$/gm, "");
function nodes(node) { return (node.children || []).flatMap(child => [child, ...nodes(child)]); }
function fixture(connected = true) {
    const host = harness.makeHost({ keepAutoStart: true });
    host.dollar.global.__codexAeBridgeV1.version = "prior-ownership-fixture";
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = new host.context.Panel();
    try { vm.runInContext(latest, host.context); } finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    const bridge = host.dollar.global.__codexAeBridgeV1; host.bridge = bridge;
    if (connected) host.connect();
    bridge.window.size = { width: 440, height: 310 }; bridge.reflowUi();
    return { host, bridge, reconnect: nodes(bridge.window).find(node => node.text === "Kết nối lại").onClick };
}
function drainStartup(f) { for (let i = 0; f.bridge.running && !f.bridge.ready && i < 30; i++) f.host.fireNext(); }
function loseTask(f) {
    const task = f.host.scheduled.get(f.bridge.taskId); assert.ok(task);
    f.host.scheduled.delete(f.bridge.taskId); f.host.advanceTime(12000); return task;
}
function enqueue(f, id) {
    const path = f.bridge.inboxPath + "/job-" + id + ".job";
    f.host.put(path, "schema=codex-ae-job/v2\nrunId=" + id + "\nsessionNonce=" + f.bridge.sessionNonce +
        "\nrequest=" + encodeURIComponent(JSON.stringify({ schema: "codex-ae-functions/v1", steps: [{ function: "system.info", args: {} }] })) + "\n");
    return new f.host.File(path);
}
const tests = [], test = (name, run) => tests.push({ name, run });
test("Reconnect restores a missing global binding and publishes a fresh heartbeat instead of silently draining its task", () => {
    const f = fixture(), { host, bridge } = f, session = bridge.sessionNonce;
    loseTask(f); host.dollar.global.__codexAeBridgeV1 = null;
    f.reconnect();
    assert.equal(host.dollar.global.__codexAeBridgeV1, bridge); assert.equal(host.scheduled.size, 1);
    assert.equal(bridge.connectionConnected, false); assert.equal(bridge.ready, false);
    drainStartup(f);
    assert.equal(bridge.ready, true); assert.equal(bridge.connectionConnected, true);
    const heartbeat = JSON.parse(host.textAt(bridge.heartbeatPath));
    assert.equal(heartbeat.state, "running"); assert.equal(heartbeat.sessionNonce, session);
    assert.ok(bridge.logs.some(entry => /Restored missing bridge binding/.test(entry.message)));
    assert.ok(bridge.logs.some(entry => /reason=Reconnect button/.test(entry.message)));
    assert.equal(host.scheduled.size, 1); assert.equal(host.executionCount, 0);
});
test("stale native panel activity recovers its missing binding while keeping the session and generation", () => {
    const f = fixture(), { host, bridge } = f, session = bridge.sessionNonce, generation = bridge.generation;
    loseTask(f); delete host.dollar.global.__codexAeBridgeV1;
    bridge.window.onActivate();
    assert.equal(host.dollar.global.__codexAeBridgeV1, bridge); assert.equal(host.scheduled.size, 1);
    assert.equal(bridge.sessionNonce, session); assert.equal(bridge.generation, generation);
    assert.equal(bridge.connectionConnected, false); assert.match(bridge.lastStatus, /chờ heartbeat mới/);
    host.fireNext(); assert.equal(bridge.connectionConnected, true);
    assert.match(bridge.lastStatus, /Ready for Codex jobs/);
});
test("an overdue startup callback resumes its existing stage without auto scanning or restarting the session", () => {
    const f = fixture(false), { host, bridge } = f, session = bridge.sessionNonce, generation = bridge.generation;
    host.fireNext(); const step = bridge.startupStep; loseTask(f);
    bridge.window.onActivate();
    assert.equal(bridge.startupStep, step); assert.equal(bridge.sessionNonce, session); assert.equal(bridge.generation, generation);
    assert.equal(bridge.connectionConnected, false); assert.equal(host.scheduled.size, 1);
    drainStartup(f); assert.equal(bridge.ready, true); assert.equal(host.sfxRequests.length, 0);
});
test("a reconnect refuses another live controller and cannot overwrite its heartbeat or callback ownership", () => {
    for (const workspace of ["C:/Users/nguye/AE_Codex", "D:/other-install"] ) {
        const f = fixture(), { host, bridge } = f;
        loseTask(f); const before = host.textAt(bridge.heartbeatPath), generation = bridge.generation, token = bridge.taskToken;
        const other = { running: true, ready: true, workspaceRoot: workspace, sessionNonce: "new-controller-session", runScheduled() { throw Error("must not call the other controller"); } };
        host.dollar.global.__codexAeBridgeV1 = other;
        assert.equal(bridge.start("Reconnect button"), false); bridge.window.onActivate();
        assert.equal(host.dollar.global.__codexAeBridgeV1, other); assert.equal(host.textAt(bridge.heartbeatPath), before);
        assert.equal(bridge.generation, generation); assert.equal(bridge.taskToken, token); assert.equal(host.scheduled.size, 0);
        assert.equal(bridge.connectionConnected, false); assert.match(bridge.lastStatus, /phiên hiện tại/);
    }
});
test("a captured old Reconnect callback cannot alter a replacement dock on the same controller", () => {
    const f = fixture(), { host, bridge } = f, oldClick = f.reconnect;
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = new host.context.Panel();
    try { vm.runInContext(latest, host.context); } finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    const generation = bridge.generation, token = bridge.taskToken, task = bridge.taskId;
    oldClick(); assert.equal(bridge.generation, generation); assert.equal(bridge.taskToken, token); assert.equal(bridge.taskId, task);
    assert.equal(host.scheduled.size, 1);
});
test("manual Stop stays stopped when a missing binding and old UI activity occur", () => {
    const f = fixture(), { host, bridge } = f;
    bridge.stop(); delete host.dollar.global.__codexAeBridgeV1; host.advanceTime(120000);
    bridge.window.onActivate(); bridge.showWindow();
    assert.equal(host.dollar.global.__codexAeBridgeV1, undefined); assert.equal(host.scheduled.size, 0);
    assert.equal(bridge.running, false); assert.equal(JSON.parse(host.textAt(bridge.heartbeatPath)).state, "stopped");
});
test("fresh heartbeats keep green while stale activity becomes unavailable until a new heartbeat is actually published", () => {
    const f = fixture(), { host, bridge } = f, originalWrite = bridge.writeAtomic;
    assert.equal(bridge.connectionConnected, true); loseTask(f);
    bridge.writeAtomic = function () { throw Error("heartbeat publication blocked"); };
    bridge.window.onActivate(); assert.equal(bridge.connectionConnected, false); host.fireNext();
    assert.equal(bridge.connectionConnected, false); assert.match(bridge.lastStatus, /heartbeat publication blocked/);
    bridge.writeAtomic = originalWrite; host.fireNext();
    assert.equal(bridge.connectionConnected, true); assert.equal(host.scheduled.size, 1);
});
test("a heartbeat replaced by another session cannot leave the panel green", () => {
    const f = fixture(), { host, bridge } = f;
    host.advanceTime(2500);
    const stale = JSON.parse(host.textAt(bridge.heartbeatPath));
    stale.sessionNonce = "foreign-session-0001";
    stale.timestampEpochMs = Date.now();
    host.put(bridge.heartbeatPath, JSON.stringify(stale));
    bridge.window.onActivate();
    assert.equal(bridge.connectionConnected, false);
    assert.match(bridge.lastStatus, /Mất nhịp|heartbeat|kết nối/i);
});
test("Reconnect is refused during real execution and cannot clear or replace an active job", () => {
    const f = fixture(), { bridge, host } = f, generation = bridge.generation, task = bridge.taskId;
    bridge.busy = true; assert.equal(bridge.start("Reconnect button"), false);
    bridge.scheduledCallbackActive = true; bridge.busy = false; assert.equal(bridge.start("Reconnect button"), false);
    assert.equal(bridge.generation, generation); assert.equal(bridge.taskId, task); assert.equal(host.scheduled.size, 1);
});
test("missing-binding recovery preserves the exact pending terminal outcome without evaluating the tool again", () => {
    const f = fixture(), { bridge, host } = f, runId = "ownership-pending-0001";
    let calls = 0; const run = bridge.functions.run;
    bridge.functions.run = function (request, context) { calls++; return run.call(this, request, context); };
    host.failPublication(4); bridge.processJob(enqueue(f, runId));
    assert.equal(calls, 1); const pending = bridge.pendingReport, started = host.textAt(bridge.resultsPath + "/started-" + runId + ".json");
    loseTask(f); host.dollar.global.__codexAeBridgeV1 = null; bridge.window.onActivate();
    assert.equal(bridge.pendingReport, pending); host.fireNext();
    assert.equal(calls, 1); assert.equal(bridge.pendingReport, null);
    assert.equal(JSON.parse(host.textAt(bridge.resultsPath + "/status-" + runId + ".json")).state, "success");
    assert.equal(host.textAt(bridge.resultsPath + "/started-" + runId + ".json"), started);
});
test("loading a live panel rewires lost native handlers with fresh functions while preserving controls and one timer", () => {
    const f = fixture(), { host, bridge } = f, palette = bridge.window, controls = nodes(palette), oldClick = f.reconnect,
        oldActivate = palette.onActivate, oldLayout = bridge.ui.layoutManager.layout;
    let tools = 0; bridge.showFunctions = function () { tools++; };
    for (const record of bridge.ui.actions) record.control.onClick = null;
    palette.onActivate = palette.onResize = palette.onResizing = null;
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = palette;
    try { vm.runInContext(latest, host.context); } finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    assert.equal(bridge.window, palette); assert.deepEqual(nodes(palette), controls); assert.equal(host.scheduled.size, 1);
    const nextReconnect = nodes(palette).find(node => node.text === "Kết nối lại").onClick;
    assert.equal(typeof nextReconnect, "function"); assert.notEqual(nextReconnect, oldClick); assert.notEqual(palette.onActivate, oldActivate);
    assert.notEqual(bridge.ui.layoutManager.layout, oldLayout);
    nodes(palette).find(node => node.text === "Công cụ").onClick(); assert.equal(tools, 1);
    const generation = bridge.generation, token = bridge.taskToken;
    oldClick(); oldActivate(); oldLayout();
    assert.equal(bridge.generation, generation); assert.equal(bridge.taskToken, token); assert.equal(host.scheduled.size, 1);
    nextReconnect(); assert.equal(bridge.generation, generation + 1); drainStartup(f); assert.equal(bridge.ready, true);
});
test("a dock owner anchor restores missing loader binding without duplicating controls or overriding manual Stop", () => {
    for (const stopped of [false, true]) {
        const f = fixture(), { host, bridge } = f, palette = bridge.window, controlCount = nodes(palette).length;
        if (stopped) bridge.stop(); else loseTask(f);
        host.dollar.global.__codexAeBridgeV1 = null;
        host.dollar.global.__CODEX_AE_PANEL_HOST__ = palette;
        try { vm.runInContext(latest, host.context); } finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
        assert.equal(host.dollar.global.__codexAeBridgeV1, bridge); assert.equal(palette.__codexAeBridgeOwnerV1, bridge);
        assert.equal(nodes(palette).length, controlCount); assert.equal(bridge.running, !stopped); assert.equal(host.scheduled.size, stopped ? 0 : 1);
    }
});
test("a missing-binding anchor from an older idle version is replaced once while preserving manual Stop", () => {
    for (const stopped of [false, true]) {
        const f = fixture(), { host, bridge: old } = f, palette = old.window, count = nodes(palette).length;
        if (stopped) old.stop(); old.version = "1.18.6"; host.advanceTime(1);
        host.dollar.global.__codexAeBridgeV1 = null; host.dollar.global.__CODEX_AE_PANEL_HOST__ = palette;
        try { vm.runInContext(latest, host.context); } finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
        const replacement = host.dollar.global.__codexAeBridgeV1;
        assert.notEqual(replacement, old); assert.equal(replacement.version, "2.0.4"); assert.equal(old.running, false); assert.equal(old.ui, null);
        assert.equal(nodes(palette).length, count); assert.equal(palette.__codexAeBridgeOwnerV1, replacement);
        assert.equal(replacement.running, !stopped); assert.equal(host.scheduled.size, stopped ? 0 : 1);
        if (stopped) assert.equal(JSON.parse(host.textAt(replacement.heartbeatPath)).state, "stopped");
    }
});
test("a conflicting workspace anchor refuses loading without stopping it duplicating controls or overwriting heartbeat", () => {
    const f = fixture(), { host, bridge } = f, palette = bridge.window, count = nodes(palette).length,
        heartbeat = host.textAt(bridge.heartbeatPath), task = bridge.taskId;
    bridge.workspaceRoot = "D:/other-workspace"; host.dollar.global.__codexAeBridgeV1 = null;
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = palette;
    try { vm.runInContext(latest, host.context); } finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    assert.equal(host.dollar.global.__codexAeBridgeV1, null); assert.equal(palette.__codexAeBridgeOwnerV1, bridge);
    assert.equal(nodes(palette).length, count); assert.equal(bridge.running, true); assert.equal(bridge.taskId, task);
    assert.equal(host.scheduled.size, 1); assert.equal(host.textAt(bridge.heartbeatPath), heartbeat);
    assert.match(bridge.lastStatus, /cầu nối khác/);
});
test("an older anchored controller with active or unsettled outcomes refuses replacement without changing its records", () => {
    for (const field of ["busy", "pendingReport", "pendingCleanupFile", "scheduledCallbackActive", "connectionActionActive"]) {
        const f = fixture(), { host, bridge } = f, palette = bridge.window, count = nodes(palette).length,
            heartbeat = host.textAt(bridge.heartbeatPath), task = bridge.taskId;
        const pending = field === "pendingReport" || field === "pendingCleanupFile" ? { exact: "immutable-pending-record" } : true;
        bridge[field] = pending; bridge.version = "1.18.6"; host.dollar.global.__codexAeBridgeV1 = null;
        host.dollar.global.__CODEX_AE_PANEL_HOST__ = palette;
        try { vm.runInContext(latest, host.context); } finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
        assert.equal(host.dollar.global.__codexAeBridgeV1, null); assert.equal(bridge[field], pending);
        assert.equal(nodes(palette).length, count); assert.equal(bridge.taskId, task); assert.equal(host.scheduled.size, 1);
        assert.equal(host.textAt(bridge.heartbeatPath), heartbeat); assert.match(bridge.lastStatus, /chưa xác nhận/);
    }
});
let failed = 0;
for (const { name, run } of tests) { try { run(); console.log("PASS " + name); } catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); } }
console.log((tests.length - failed) + "/" + tests.length + " reconnect ownership tests passed");
process.exitCode = failed ? 1 : 0;
