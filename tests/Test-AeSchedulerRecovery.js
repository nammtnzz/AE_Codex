"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const harness = { require, process, __dirname, console, Buffer };
vm.createContext(harness);
const hostSource = fs.readFileSync(path.join(__dirname, "Test-AeBridgeLibrary.js"), "utf8");
vm.runInContext(hostSource.slice(0, hostSource.indexOf("const tests = [];")) + "\nthis.makeHost = mockHost;", harness);
const latest = fs.readFileSync(path.join(__dirname, "../source/bridge.js"), "utf8").replace(/^#.*$/gm, "");

function fixture() {
    const host = harness.makeHost({ keepAutoStart: true });
    host.dollar.global.__codexAeBridgeV1.version = "prior-scheduler-fixture";
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = new host.context.Panel();
    try { vm.runInContext(latest, host.context); }
    finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    host.bridge = host.dollar.global.__codexAeBridgeV1;
    const bridge = host.connect();
    bridge.window.size = { width: 440, height: 310 };
    let calls = 0;
    const run = bridge.functions.run;
    bridge.functions.run = function (request, context) { calls += 1; return run.call(this, request, context); };
    return { host, bridge, get calls() { return calls; } };
}

function loseTask(f) {
    const taskId = f.bridge.taskId, task = f.host.scheduled.get(taskId);
    assert.ok(task, "fixture must own a scheduled callback");
    f.host.scheduled.delete(taskId);
    f.host.advanceTime(12000);
    return { taskId, code: task.code };
}

function enqueue(f, runId) {
    const jobPath = f.bridge.inboxPath + "/job-" + runId + ".job";
    const request = { schema: "codex-ae-functions/v1", steps: [{ function: "system.info", args: {} }] };
    f.host.put(jobPath, "schema=codex-ae-job/v2\nrunId=" + runId + "\nsessionNonce=" + f.bridge.sessionNonce +
        "\nrequest=" + encodeURIComponent(JSON.stringify(request)) + "\n");
    return new f.host.File(jobPath);
}

const tests = [], test = (name, run) => tests.push({ name, run });

test("native panel activity rearms a lost callback without restarting the session or synchronously running a tool", () => {
    const f = fixture(), { bridge, host } = f, session = bridge.sessionNonce, generation = bridge.generation,
        library = bridge.library, window = bridge.window, ui = bridge.ui;
    const old = loseTask(f); enqueue(f, "scheduler-recovery-0001");
    bridge.window.onActivate();
    assert.equal(f.calls, 0, "UI activation must only schedule work");
    assert.equal(host.scheduled.size, 1); assert.notEqual(bridge.taskId, old.taskId);
    assert.equal(bridge.sessionNonce, session); assert.equal(bridge.generation, generation);
    assert.equal(bridge.library, library); assert.equal(bridge.window, window); assert.equal(bridge.ui, ui);
    host.fireNext();
    const terminal = JSON.parse(host.textAt(bridge.resultsPath + "/status-scheduler-recovery-0001.json"));
    assert.equal(terminal.state, "success"); assert.equal(f.calls, 1);
    assert.equal(JSON.parse(host.textAt(bridge.heartbeatPath)).state, "running");
    assert.equal(host.scheduled.size, 1); assert.equal(host.executionCount, 0);
    assert.equal(host.systemCalls.length, 0); assert.equal(host.launcherCalls.length, 0);
});

test("a delayed callback from the lost task cannot clear or duplicate its replacement", () => {
    const f = fixture(), { bridge, host } = f, old = loseTask(f);
    bridge.showWindow(); const replacement = bridge.taskId, token = bridge.taskToken;
    vm.runInContext(old.code, host.context);
    assert.equal(bridge.taskId, replacement); assert.equal(bridge.taskToken, token);
    assert.equal(host.scheduled.size, 1); assert.equal(f.calls, 0);
    host.fireNext(); assert.equal(host.scheduled.size, 1);
});

test("healthy repeated show, resize and activation events allocate no timers", () => {
    const f = fixture(), { bridge, host } = f, task = bridge.taskId, token = bridge.taskToken,
        cancelled = host.cancelled.length, logs = bridge.logs.length;
    for (let i = 0; i < 1000; i += 1) {
        bridge.showWindow(); bridge.window.onResize(); bridge.window.onActivate();
    }
    assert.equal(bridge.taskId, task); assert.equal(bridge.taskToken, token);
    assert.equal(host.scheduled.size, 1); assert.equal(host.cancelled.length, cancelled);
    assert.equal(bridge.logs.length, logs); assert.equal(f.calls, 0);
});

test("manual Stop remains stopped through stale UI events and panel reopening", () => {
    const f = fixture(), { bridge, host } = f;
    bridge.stop(); host.advanceTime(120000);
    const generation = bridge.generation, token = bridge.taskToken, session = bridge.sessionNonce;
    bridge.showWindow(); bridge.window.onResize(); bridge.window.onActivate();
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = new host.context.Panel();
    try { vm.runInContext(latest, host.context); }
    finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    assert.equal(bridge.running, false); assert.equal(bridge.ready, false);
    assert.equal(bridge.generation, generation); assert.equal(bridge.taskToken, token); assert.equal(bridge.sessionNonce, session);
    assert.equal(host.scheduled.size, 0); assert.equal(f.calls, 0);
    assert.equal(JSON.parse(host.textAt(bridge.heartbeatPath)).state, "stopped");
});

test("active callbacks and unfinished executions cannot be rearmed by reentrant UI events", () => {
    const f = fixture(), { bridge, host } = f, old = loseTask(f), token = bridge.taskToken;
    bridge.scheduledCallbackActive = true; bridge.window.onActivate();
    assert.equal(bridge.taskToken, token); assert.equal(bridge.taskId, old.taskId); assert.equal(host.scheduled.size, 0);
    bridge.scheduledCallbackActive = false; bridge.busy = true; bridge.window.onActivate();
    assert.equal(bridge.taskToken, token); assert.equal(bridge.taskId, old.taskId); assert.equal(host.scheduled.size, 0);
    bridge.busy = false; bridge.window.onActivate(); assert.equal(host.scheduled.size, 1);
});

test("recovery retains the immutable pending result and publishes it without replay", () => {
    const f = fixture(), { bridge, host } = f, runId = "scheduler-pending-0001";
    host.failPublication(4); bridge.processJob(enqueue(f, runId));
    assert.equal(f.calls, 1); assert.ok(bridge.pendingReport); assert.equal(bridge.busy, true);
    const pending = bridge.pendingReport, startedPath = bridge.resultsPath + "/started-" + runId + ".json",
        started = host.textAt(startedPath);
    const old = loseTask(f); bridge.window.onActivate();
    assert.equal(bridge.pendingReport, pending); assert.equal(f.calls, 1); assert.equal(host.scheduled.size, 1);
    vm.runInContext(old.code, host.context); host.fireNext();
    const statusPath = bridge.resultsPath + "/status-" + runId + ".json", terminal = host.textAt(statusPath);
    assert.equal(JSON.parse(terminal).state, "success"); assert.equal(bridge.pendingReport, null);
    assert.equal(host.textAt(startedPath), started); assert.equal(f.calls, 1);
    for (let i = 0; i < 3; i += 1) host.fireNext();
    assert.equal(host.textAt(statusPath), terminal); assert.equal(f.calls, 1);
});

test("completed-job cleanup survives recovery without replacing its immutable terminal result", () => {
    const f = fixture(), { bridge, host } = f, runId = "scheduler-cleanup-0001";
    const remove = host.File.prototype.remove;
    let denyCleanup = true;
    host.File.prototype.remove = function () {
        if (denyCleanup && this.fsName.endsWith("job-" + runId + ".running")) { this.error = "mock cleanup sharing violation"; return false; }
        return remove.call(this);
    };
    bridge.processJob(enqueue(f, runId));
    assert.equal(f.calls, 1); assert.equal(bridge.pendingReport, null); assert.ok(bridge.pendingCleanupFile);
    const statusPath = bridge.resultsPath + "/status-" + runId + ".json", terminal = host.textAt(statusPath),
        cleanup = bridge.pendingCleanupFile;
    loseTask(f); bridge.window.onActivate();
    assert.equal(bridge.pendingCleanupFile, cleanup); assert.equal(host.scheduled.size, 1);
    denyCleanup = false; host.fireNext();
    assert.equal(bridge.pendingCleanupFile, null); assert.equal(bridge.busy, false);
    assert.equal(host.textAt(statusPath), terminal); assert.equal(f.calls, 1);
});

test("scheduler recovery failure remains visible and cannot execute or automatically retry a job", () => {
    const f = fixture(), { bridge, host } = f;
    loseTask(f); enqueue(f, "scheduler-failure-0001");
    host.app.scheduleTask = function () { throw new Error("mock host scheduler unavailable"); };
    assert.doesNotThrow(() => bridge.window.onActivate());
    assert.equal(bridge.running, false); assert.equal(bridge.ready, false); assert.equal(f.calls, 0);
    assert.equal(host.scheduled.size, 0); assert.equal(JSON.parse(host.textAt(bridge.heartbeatPath)).state, "error");
    assert.match(bridge.lastStatus, /scheduler unavailable/);
    const token = bridge.taskToken;
    assert.doesNotThrow(() => bridge.window.onActivate()); assert.equal(bridge.taskToken, token);
    assert.equal(f.calls, 0); assert.equal(host.scheduled.size, 0);
});

test("old-controller callbacks are inert even when generation and token happen to match", () => {
    const f = fixture(), { bridge: old, host } = f;
    const oldCode = host.scheduled.get(old.taskId).code, oldGeneration = old.generation, oldToken = old.taskToken,
        oldSession = old.sessionNonce;
    old.version = "replaced-controller-fixture"; host.advanceTime(1);
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = new host.context.Panel();
    try { vm.runInContext(latest, host.context); }
    finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    const bridge = host.dollar.global.__codexAeBridgeV1;
    assert.notEqual(bridge.sessionNonce, oldSession);
    bridge.generation = oldGeneration; bridge.taskToken = oldToken;
    const task = bridge.taskId, due = bridge.taskDueAt;
    vm.runInContext(oldCode, host.context);
    assert.equal(bridge.taskId, task); assert.equal(bridge.taskDueAt, due);
    assert.equal(host.scheduled.size, 1); assert.equal(bridge.scheduledCallbackActive, false);
    host.dollar.global.__codexAeBridgeV1 = null;
    assert.doesNotThrow(() => vm.runInContext(oldCode, host.context));
});

test("reopening the same live panel recovers a stale schedule and ignores stale view callbacks", () => {
    const f = fixture(), { bridge, host } = f, staleActivate = bridge.window.onActivate;
    loseTask(f);
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = bridge.window;
    try { vm.runInContext(latest, host.context); }
    finally { delete host.dollar.global.__CODEX_AE_PANEL_HOST__; }
    assert.equal(host.dollar.global.__codexAeBridgeV1, bridge); assert.equal(host.scheduled.size, 1);
    const oldWindow = bridge.window;
    Object.defineProperty(oldWindow, "size", { configurable: true, get() { throw new Error("Disposed dock"); } });
    bridge.reflowUi();
    assert.equal(oldWindow.onActivate, null);
    const token = bridge.taskToken;
    assert.doesNotThrow(() => staleActivate()); assert.equal(bridge.taskToken, token);
});

let failed = 0;
for (const { name, run } of tests) {
    try { run(); console.log("PASS " + name); }
    catch (error) { failed += 1; console.error("FAIL " + name + "\n" + error.stack); }
}
console.log((tests.length - failed) + "/" + tests.length + " scheduler recovery tests passed");
process.exitCode = failed ? 1 : 0;
