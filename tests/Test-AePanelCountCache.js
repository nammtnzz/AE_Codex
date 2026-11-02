"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "source", "bridge.js"), "utf8").replace(/^#.*$/gm, "");
const hostSource = fs.readFileSync(path.join(__dirname, "Test-AeBridgeLibrary.js"), "utf8");
const harness = { require, process, __dirname, console, Buffer };
vm.createContext(harness);
vm.runInContext(hostSource.slice(0, hostSource.indexOf("const tests = [];")) + "\nthis.makeHost=mockHost;", harness);

function fixture() {
    const host = harness.makeHost({ keepAutoStart: true });
    host.dollar.global.__codexAeBridgeV1.version = "prior-count-fixture";
    vm.runInContext(source, host.context);
    return { host, bridge: host.dollar.global.__codexAeBridgeV1 };
}

const tests = [], test = (name, run) => tests.push({ name, run });
test("ten thousand idle refreshes enumerate an unchanged public registry only once", () => {
    const { host, bridge } = fixture(), runtime = bridge.functions;
    let enumerations = 0;
    bridge.functions = { list(includeLegacy) {
        assert.equal(includeLegacy, false);
        enumerations++;
        return runtime.list(includeLegacy);
    } };
    bridge.refreshScriptsDisplay();
    assert.match(bridge.scriptsText.text, /43 chức năng dùng lại/);
    let textWrites = 0, text = bridge.scriptsText.text;
    Object.defineProperty(bridge.scriptsText, "text", { get() { return text; }, set(value) { textWrites++; text = value; } });
    for (let i = 0; i < 10000; i++) bridge.refreshScriptsDisplay();
    assert.equal(enumerations, 1);
    assert.equal(textWrites, 0);
    assert.equal(host.executionCount, 0);
});

test("replacement registries invalidate the displayed count including an empty catalog", () => {
    const { bridge } = fixture();
    let first = 0, second = 0;
    bridge.functions = { list() { first++; return new Array(7); } };
    bridge.refreshScriptsDisplay();
    assert.match(bridge.scriptsText.text, /7 chức năng dùng lại/);
    bridge.functions = { list() { second++; return []; } };
    bridge.refreshScriptsDisplay();
    bridge.refreshScriptsDisplay();
    assert.match(bridge.scriptsText.text, /0 chức năng dùng lại/);
    assert.equal(first, 1);
    assert.equal(second, 1);
});

test("a failed replacement clears the stale count without removing the live UI or repeated retries", () => {
    const { bridge } = fixture(), control = bridge.scriptsText;
    bridge.refreshScriptsDisplay();
    assert.match(control.text, /43 chức năng dùng lại/);
    let attempts = 0;
    bridge.functions = { list() { attempts++; throw new Error("registry unavailable"); } };
    for (let i = 0; i < 1000; i++) bridge.refreshScriptsDisplay();
    assert.equal(attempts, 1);
    assert.equal(bridge.scriptsText, control);
    assert.match(control.text, /chưa đọc được danh mục/);
    assert.doesNotMatch(control.text, /43 chức năng/);
    assert.match(control.helpTip, /registry unavailable/);
    bridge.functions = { list() { return new Array(2); } };
    bridge.refreshScriptsDisplay();
    assert.match(control.text, /2 chức năng dùng lại/);
    assert.doesNotMatch(control.helpTip, /registry unavailable/);
});

test("missing and malformed registries report unavailable until replaced", () => {
    const { bridge } = fixture();
    for (const runtime of [null, { list() { return null; } }, { list() { return { length: NaN }; } }]) {
        bridge.functions = runtime;
        assert.doesNotThrow(() => bridge.refreshScriptsDisplay());
        assert.ok(bridge.scriptsText);
        assert.match(bridge.scriptsText.text, /chưa đọc được danh mục/);
    }
    bridge.functions = { list() { return []; } };
    bridge.refreshScriptsDisplay();
    assert.match(bridge.scriptsText.text, /0 chức năng dùng lại/);
});

let failed = 0;
for (const { name, run } of tests) {
    try { run(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); }
}
console.log((tests.length - failed) + "/" + tests.length + " panel count cache tests passed");
process.exitCode = failed ? 1 : 0;
