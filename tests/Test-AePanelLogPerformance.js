"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const harness = { require, process, __dirname, console, Buffer };
vm.createContext(harness);
const hostSource = fs.readFileSync(path.join(__dirname, "Test-AeBridgeLibrary.js"), "utf8");
vm.runInContext(hostSource.slice(0, hostSource.indexOf("const tests = [];")) + "\nthis.makeHost=mockHost;", harness);
const source = fs.readFileSync(path.join(__dirname, "../source/bridge.js"), "utf8");
function fixture(text = source) {
    const host = harness.makeHost({ keepAutoStart: true });
    host.dollar.global.__codexAeBridgeV1.version = "prior-log-fixture";
    vm.runInContext(text.replace(/^#.*$/gm, ""), host.context);
    const bridge = host.dollar.global.__codexAeBridgeV1;
    bridge.window.size = { width: 440, height: 430 }; bridge.reflowUi(true);
    const counts = { bodyWrites: 0, bodyCharacters: 0, repaints: 0 };
    let body = bridge.logView.text;
    Object.defineProperty(bridge.logView, "text", { configurable: true, get() { return body; }, set(value) {
        counts.bodyWrites++; counts.bodyCharacters += value.length; body = value;
    } });
    bridge.window.update = function () { counts.repaints++; };
    return { host, bridge, counts };
}
function showLog(f, expanded, height = 430) {
    f.bridge.ui.logExpanded = expanded; f.bridge.window.size = { width: 440, height }; f.bridge.reflowUi(true);
}
function append(f, count, runId = "log-load") {
    for (let i = 0; i < count; i++) f.bridge.log(i === count - 1 ? "error" : "info", "Event " + i, runId);
}
const tests = [], test = (name, run) => tests.push({ name, run });
test("five hundred collapsed events keep bounded history and errors without rebuilding or repainting the hidden body", () => {
    const f = fixture(); append(f, 500);
    assert.deepEqual(f.counts, { bodyWrites: 0, bodyCharacters: 0, repaints: 0 });
    assert.equal(f.bridge.logs.length, 200); assert.equal(f.bridge.logs[0].message, "Event 300");
    assert.equal(f.bridge.logView.text, ""); assert.match(f.bridge.logSummary.text, /Lỗi: Event 499/);
    const records = f.host.textAt(f.bridge.bridgeRoot + "/logs/events.log").trim().split("\n").map(JSON.parse);
    assert.equal(records.filter(row => row.runId === "log-load").length, 500);
    assert.equal(f.host.executionCount, 0); assert.equal(f.host.scheduled.size, 1);
});
test("opening the log renders the latest two hundred events once and unchanged refreshes do no native work", () => {
    const f = fixture(); append(f, 500); showLog(f, true);
    assert.equal(f.counts.bodyWrites, 1); assert.equal(f.counts.repaints, 1);
    assert.equal(f.bridge.logView.text.split("\n").length, 200);
    assert.match(f.bridge.logView.text, /Event 300\n/); assert.match(f.bridge.logView.text, /Event 499$/);
    assert.doesNotMatch(f.bridge.logView.text, /Event 299\n/);
    for (let i = 0; i < 1000; i++) f.bridge.refreshLog();
    assert.equal(f.counts.bodyWrites, 1); assert.equal(f.counts.repaints, 1);
});
test("a collapsed or too-small log releases native text and shows new history when enough space returns", () => {
    const f = fixture(); append(f, 10); showLog(f, true); showLog(f, false);
    assert.equal(f.bridge.logView.text, ""); const writes = f.counts.bodyWrites, paints = f.counts.repaints;
    append(f, 100, "hidden-more"); showLog(f, true, 220);
    assert.equal(f.bridge.logView.text, ""); assert.equal(f.counts.bodyWrites, writes); assert.equal(f.counts.repaints, paints);
    showLog(f, true, 430); assert.match(f.bridge.logView.text, /hidden-more.*Event 99$/);
    assert.equal(f.counts.bodyWrites, writes + 1); assert.equal(f.host.scheduled.size, 1);
});
test("clearing collapsed history never changes the persistent log and cannot reveal stale lines", () => {
    const f = fixture(); append(f, 20); showLog(f, true); showLog(f, false);
    const logPath = f.bridge.bridgeRoot + "/logs/events.log", persisted = f.host.textAt(logPath), writes = f.counts.bodyWrites;
    f.bridge.clearLog(); assert.equal(f.bridge.logs.length, 0); assert.equal(f.host.textAt(logPath), persisted);
    assert.equal(f.bridge.logSummary.text, "Sẵn sàng"); showLog(f, true);
    assert.equal(f.bridge.logView.text, ""); assert.equal(f.counts.bodyWrites, writes);
    f.bridge.log("warning", "Fresh warning"); assert.match(f.bridge.logView.text, /Fresh warning$/); assert.doesNotMatch(f.bridge.logView.text, /Event 19/);
});
test("disposed visible controls release the view without losing memory or disk history", () => {
    const f = fixture(); showLog(f, true);
    Object.defineProperty(f.bridge.logView, "text", { configurable: true, get() { throw Error("native log disposed"); } });
    assert.doesNotThrow(() => f.bridge.log("error", "Retained failure", "disposed-log"));
    assert.equal(f.bridge.logView, null); assert.equal(f.bridge.ui, null);
    assert.equal(f.bridge.logs[f.bridge.logs.length - 1].message, "Retained failure");
    assert.match(f.host.textAt(f.bridge.bridgeRoot + "/logs/events.log"), /Retained failure/);
    assert.equal(f.host.scheduled.size, 1); assert.equal(f.host.executionCount, 0);
});
let failed = 0;
for (const { name, run } of tests) { try { run(); console.log("PASS " + name); } catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); } }
console.log((tests.length - failed) + "/" + tests.length + " panel log performance tests passed");
if (process.argv.includes("--benchmark")) {
    const old = fixture(fs.readFileSync(path.join(__dirname, "../.ae-codex/tests/bridge-1.18.5-pre-opt.js"), "utf8")), current = fixture();
    append(old, 500); append(current, 500);
    console.log(JSON.stringify({ events: 500, collapsed: true, before: old.counts, after: current.counts }));
}
process.exitCode = failed ? 1 : 0;
