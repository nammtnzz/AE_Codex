"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Reuse the file/timer/ScriptUI fixture without executing its independent suite.
const harness = { require, process, __dirname, console, Buffer };
vm.createContext(harness);
const hostSource = fs.readFileSync(path.join(__dirname, "Test-AeBridgeLibrary.js"), "utf8");
vm.runInContext(hostSource.slice(0, hostSource.indexOf("const tests = [];")) + "\nthis.makeHost = mockHost;", harness);
const latest = fs.readFileSync(path.join(__dirname, "../source/bridge.js"), "utf8").replace(/^#.*$/gm, "");

function fixture(dock = true) {
    const host = harness.makeHost({ keepAutoStart: true });
    host.dollar.global.__codexAeBridgeV1.version = "prior-fixture";
    if (dock) host.dollar.global.__CODEX_AE_PANEL_HOST__ = new host.context.Panel();
    try { vm.runInContext(latest, host.context); }
    finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    host.bridge = host.dollar.global.__codexAeBridgeV1;
    const bridge = host.connect();
    bridge.window.size = { width: 440, height: 310 };
    bridge.reflowUi();
    let calls = 0;
    const run = bridge.functions.run;
    bridge.functions.run = function (request, context) { calls += 1; return run.call(this, request, context); };
    return { host, bridge, get calls() { return calls; } };
}

function openDock(f, panel = new f.host.context.Panel()) {
    f.host.dollar.global.__CODEX_AE_PANEL_HOST__ = panel;
    try { vm.runInContext(latest, f.host.context); }
    finally { delete f.host.dollar.global.__CODEX_AE_PANEL_HOST__; }
}

function enqueue(f, runId) {
    const jobPath = f.bridge.inboxPath + "/job-" + runId + ".job";
    const request = { schema: "codex-ae-functions/v1", steps: [{ function: "system.info", args: {} }] };
    f.host.put(jobPath, "schema=codex-ae-job/v2\nrunId=" + runId + "\nsessionNonce=" + f.bridge.sessionNonce +
        "\nrequest=" + encodeURIComponent(JSON.stringify(request)) + "\n");
    return new f.host.File(jobPath);
}

function disposeNativePanel(bridge) {
    const palette = bridge.window;
    Object.defineProperty(palette, "size", {
        configurable: true, get() { throw new Error("ScriptUI native panel disposed while entering AE Home"); }
    });
    return palette;
}

function heartbeat(f) { return JSON.parse(f.host.textAt(f.bridge.heartbeatPath)); }
function terminal(f, runId) { return JSON.parse(f.host.textAt(f.bridge.resultsPath + "/status-" + runId + ".json")); }
function assertDetached(bridge) {
    for (const key of ["window", "ui", "statusText", "connectionText", "scriptsText", "libraryControls", "progressGroup", "progressText", "progressBar", "logView"])
        assert.equal(bridge[key], null, key + " must release its disposed native reference");
    assert.equal(bridge.ownedUiRoots.length, 0);
}

const tests = [], test = (name, run) => tests.push({ name, run });

test("AE Home native panel disposal cannot starve a queued tool or its heartbeat", () => {
    const f = fixture(), { bridge, host } = f, session = bridge.sessionNonce, generation = bridge.generation, library = bridge.library;
    const runId = "home-tool-0001";
    enqueue(f, runId); disposeNativePanel(bridge); host.advanceTime(2200); host.fireNext();
    assertDetached(bridge);
    assert.equal(f.calls, 1); assert.equal(terminal(f, runId).state, "success");
    for (let i = 0; i < 4; i += 1) { host.advanceTime(2200); host.fireNext(); }
    assert.equal(f.calls, 1, "view recovery must never replay a dispatched tool");
    assert.equal(heartbeat(f).state, "running"); assert.equal(bridge.connectionConnected, true);
    assert.equal(bridge.sessionNonce, session); assert.equal(bridge.generation, generation); assert.equal(bridge.library, library);
    assert.equal(bridge.running, true); assert.equal(bridge.ready, true); assert.equal(host.scheduled.size, 1);
    assert.equal(host.executionCount, 0, "only the read-only installed tool ran");
    assert.equal(host.systemCalls.length, 0); assert.equal(host.launcherCalls.length, 0);
});

test("pending immutable terminal publication survives a disposed view without re-executing its tool", () => {
    const f = fixture(), { bridge, host } = f, runId = "home-report-0001", session = bridge.sessionNonce;
    host.failPublication(4); bridge.processJob(enqueue(f, runId));
    assert.equal(f.calls, 1); assert.ok(bridge.pendingReport);
    const pending = bridge.pendingReport, startedPath = bridge.resultsPath + "/started-" + runId + ".json", started = host.textAt(startedPath);
    disposeNativePanel(bridge); assert.doesNotThrow(() => bridge.reflowUi());
    assertDetached(bridge); assert.equal(bridge.pendingReport, pending); assert.equal(bridge.sessionNonce, session);
    host.fireNext();
    assert.equal(f.calls, 1); assert.equal(bridge.pendingReport, null); assert.equal(terminal(f, runId).state, "success");
    assert.equal(host.textAt(startedPath), started, "the original immutable started record is retained");
    assert.equal(host.scheduled.size, 1);
});

test("opening the dock again reattaches UI to the existing listener and cached library", () => {
    const f = fixture(), { bridge, host } = f, session = bridge.sessionNonce, generation = bridge.generation, library = bridge.library;
    disposeNativePanel(bridge); bridge.reflowUi(); assertDetached(bridge);
    openDock(f);
    assert.equal(host.dollar.global.__codexAeBridgeV1, bridge); assert.ok(bridge.window); assert.ok(bridge.ui);
    assert.equal(bridge.sessionNonce, session); assert.equal(bridge.generation, generation); assert.equal(bridge.library, library);
    assert.equal(bridge.running, true); assert.equal(bridge.ready, true); assert.equal(host.scheduled.size, 1);
    const window = bridge.window, count = host.createdWindows.length;
    for (let i = 0; i < 20; i += 1) openDock(f, window);
    assert.equal(bridge.window, window); assert.equal(host.createdWindows.length, count); assert.equal(host.scheduled.size, 1);
});

test("manual Stop survives Home disposal and panel reattachment without automatic reconnect", () => {
    const f = fixture(), { bridge, host } = f;
    bridge.stop(); const generation = bridge.generation, session = bridge.sessionNonce;
    disposeNativePanel(bridge); bridge.reflowUi(); assertDetached(bridge);
    openDock(f); host.advanceTime(60000);
    assert.equal(host.dollar.global.__codexAeBridgeV1, bridge); assert.ok(bridge.ui);
    assert.equal(bridge.sessionNonce, session); assert.equal(bridge.generation, generation);
    assert.equal(bridge.running, false); assert.equal(bridge.ready, false); assert.equal(host.scheduled.size, 0);
    assert.equal(heartbeat(f).state, "stopped"); assert.equal(f.calls, 0);
});

test("stale resize and close callbacks cannot stop or dereference the surviving controller", () => {
    const f = fixture(false), { bridge, host } = f, window = bridge.window,
        resize = window.onResize, close = window.onClose, generation = bridge.generation;
    disposeNativePanel(bridge); bridge.reflowUi(); assertDetached(bridge);
    assert.equal(window.onResize, null); assert.equal(window.onResizing, null); assert.equal(window.onClose, null);
    openDock(f); const replacement = bridge.window;
    assert.doesNotThrow(() => resize.call(window));
    if (close) assert.doesNotThrow(() => close.call(window));
    assert.equal(bridge.window, replacement, "an old native callback cannot release a replacement view");
    assert.equal(bridge.running, true); assert.equal(bridge.generation, generation);
    assert.equal(host.dollar.global.__codexAeBridgeV1, bridge); assert.equal(host.scheduled.size, 1);
});

test("Home with no project and opening another project preserve the connection without automatic scans", () => {
    const f = fixture(), { bridge, host } = f, session = bridge.sessionNonce, generation = bridge.generation, library = bridge.library;
    let scans = 0;
    library.requestRefresh = function () { scans += 1; throw new Error("project switch must not request a library scan"); };
    const nextProject = host.app.project;
    host.app.project = null; disposeNativePanel(bridge);
    for (let i = 0; i < 3; i += 1) { host.advanceTime(2200); host.fireNext(); }
    assert.equal(heartbeat(f).state, "running");
    host.app.project = Object.assign({}, nextProject, { file: new host.File("C:/fixture/second-project.aep") });
    enqueue(f, "second-project-0001"); host.advanceTime(2200); host.fireNext();
    assert.equal(terminal(f, "second-project-0001").state, "success"); assert.equal(f.calls, 1);
    assert.equal(bridge.sessionNonce, session); assert.equal(bridge.generation, generation); assert.equal(bridge.library, library);
    assert.equal(heartbeat(f).state, "running"); assert.equal(host.scheduled.size, 1); assert.equal(scans, 0);
    assert.equal(host.launcherCalls.length, 0); assert.equal(host.executionCount, 0);
});

test("disposed status controls release the entire view while subsequent tool dispatch continues", () => {
    const f = fixture(), { bridge, host } = f;
    Object.defineProperty(bridge.statusText, "text", {
        configurable: true, get() { throw new Error("native status text disposed"); }, set() { throw new Error("native status text disposed"); }
    });
    assert.doesNotThrow(() => bridge.setUiStatus("Opening another project")); assertDetached(bridge);
    enqueue(f, "disposed-status-0001"); host.fireNext();
    assert.equal(terminal(f, "disposed-status-0001").state, "success"); assert.equal(f.calls, 1); assert.equal(host.scheduled.size, 1);
});

let failed = 0;
for (const { name, run } of tests) {
    try { run(); console.log("PASS " + name); }
    catch (error) { failed += 1; console.error("FAIL " + name + "\n" + error.stack); }
}
console.log((tests.length - failed) + "/" + tests.length + " project-switch connection tests passed");
process.exitCode = failed ? 1 : 0;
