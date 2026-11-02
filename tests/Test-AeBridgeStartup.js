"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const template = fs.readFileSync(path.join(__dirname, "../tools/AeBridgeStartup.js"), "utf8");
const workspaceRoot = "C:\\workspace tiếng Việt\\quote ' and \"";
const bundlePath = workspaceRoot + "\\jsx\\Codex Bridge.jsx";
assert.equal((template.match(/__CODEX_AE_WORKSPACE_BUNDLE__/g) || []).length, 1);
const source = template.replace("__CODEX_AE_WORKSPACE_BUNDLE__", JSON.stringify(bundlePath)).replace(/^#.*$/gm, "");
new vm.Script(source);
function run(options = {}) {
    const flag = "__CODEX_AE_AUTOSTART_ONLY__", global = options.global || {};
    const events = [];
    const context = {
        File: function (filename) {
            if (options.fileError) { throw new Error("file constructor failed"); }
            assert.equal(filename, bundlePath);
            this.exists = options.exists !== false;
            this.fsName = filename;
            this.alias = options.alias || false;
            this.parent = { alias: options.parentAlias || false, parent: { fsName: workspaceRoot } };
        },
        $: {
            global,
            evalFile(file) {
                events.push(["eval", file.fsName, global[flag]]);
                assert.equal(global.__CODEX_AE_WORKSPACE_ROOT__, workspaceRoot);
                if (options.evalError) { throw new Error("test evaluation failure"); }
            },
            writeln(message) { events.push(["log", message]); if (options.logError) { throw new Error("log failed"); } }
        }
    };
    vm.runInNewContext(source, context);
    return {global, events};
}
let result = run();
assert.equal(result.events.length, 1);
assert.deepEqual(result.events[0], ["eval", bundlePath, true]);
assert.equal(Object.hasOwn(result.global, "__CODEX_AE_AUTOSTART_ONLY__"), false);
assert.equal(Object.hasOwn(result.global, "__CODEX_AE_WORKSPACE_ROOT__"), false);
for (const prior of [false, true, undefined, {keep: "original"}]) {
    const global = {__CODEX_AE_AUTOSTART_ONLY__: prior, __CODEX_AE_WORKSPACE_ROOT__: prior};
    result = run({global});
    assert.equal(Object.hasOwn(global, "__CODEX_AE_AUTOSTART_ONLY__"), true);
    assert.equal(global.__CODEX_AE_AUTOSTART_ONLY__, prior);
    assert.equal(Object.hasOwn(global, "__CODEX_AE_WORKSPACE_ROOT__"), true);
    assert.equal(global.__CODEX_AE_WORKSPACE_ROOT__, prior);
}
console.log("PASS startup uses an escaped workspace File and restores both prior flag value and presence");
for (const options of [{exists: false}, {alias: true}, {parentAlias: true}, {fileError: true}, {evalError: true}, {evalError: true, logError: true}]) {
    result = run(options);
    assert.equal(Object.hasOwn(result.global, "__CODEX_AE_AUTOSTART_ONLY__"), false);
    assert.equal(Object.hasOwn(result.global, "__CODEX_AE_WORKSPACE_ROOT__"), false);
    assert.equal(result.events.filter(event => event[0] === "log").length, 1);
}
assert.equal(run({exists: false, evalError: true}).events.filter(event => event[0] === "log").length, 1);
assert.equal(/\balert\s*\(|\bWindow\s*\(|app\./.test(source), false);
console.log("PASS unreadable probe, File, evaluation and logging failures remain non-modal and clean up the startup flag");
