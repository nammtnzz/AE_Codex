"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8").replace(/^#.*$/gm, "");
function normalize(value) { return String(value).replace(/\\/g, "/").replace(/\/$/, ""); }
function Folder(value) {
    this.fsName = normalize(value); this.alias = false;
    this.name = this.fsName.slice(this.fsName.lastIndexOf("/") + 1);
}
Object.defineProperty(Folder.prototype, "parent", { get() { return new Folder(this.fsName.slice(0, this.fsName.lastIndexOf("/"))); } });
function File(value) { this.fsName = normalize(value); this.alias = false; this.exists = true; }
Object.defineProperty(File.prototype, "parent", { get() { return new Folder(this.fsName.slice(0, this.fsName.lastIndexOf("/"))); } });
const runtime = read("source/bundle-runtime.js"), bridge = read("source/bridge.js");
assert.equal(/C:\/Users\/nguye/.test(runtime + bridge), false);
// Exercise each resolver in its own closure as used by the combined bundle.
for (const source of [runtime, bridge]) {
    const declaration = source.match(/    function workspaceRoot\(\) \{[\s\S]+?\n    \}/)[0];
    for (const workspace of ["D:/Apps/Codex AE", "E:/Cài đặt/Người dùng mới/插件"]) {
        const global = {}, $ = {global, fileName: workspace + "/jsx/Codex Bridge.jsx"};
        const context = vm.createContext({$, File, Folder});
        vm.runInContext(declaration, context);
        assert.equal(vm.runInContext("workspaceRoot()", context), workspace);
        $.fileName = "C:/Users/New/AppData/Roaming/Adobe/ScriptUI Panels/Codex Bridge.jsx";
        global.__CODEX_AE_WORKSPACE_ROOT__ = workspace.replace(/\//g, "\\");
        assert.equal(vm.runInContext("workspaceRoot()", context), workspace);
        delete global.__CODEX_AE_WORKSPACE_ROOT__;
        assert.throws(() => vm.runInContext("workspaceRoot()", context), /installed loader/);
    }
}
console.log("PASS both runtimes resolve renamed/Unicode workspaces and reject an unconfigured copied panel");

const template = read("tools/AeBridgePanel.js");
assert.equal((template.match(/__CODEX_AE_WORKSPACE_BUNDLE__/g) || []).length, 1);
const workspace = "E:/Cài đặt/quote ' \" and $&", bundle = workspace + "/jsx/Codex Bridge.jsx";
const loader = template.replace("__CODEX_AE_WORKSPACE_BUNDLE__", () => JSON.stringify(bundle));
const keys = ["__CODEX_AE_WORKSPACE_ROOT__", "__CODEX_AE_PANEL_HOST__", "__CODEX_AE_AUTOSTART_ONLY__"];
for (const failed of [false, true]) {
    for (const prior of [null, false, undefined, {preserved: true}]) {
        const global = {}, events = [];
        if (prior !== null) { for (const key of keys) { global[key] = prior; } }
        function Panel() { this.layout = {layout() { events.push("layout"); }}; }
        Panel.prototype.add = function (kind, bounds, message) { events.push(message); };
        const host = new Panel();
        const context = vm.createContext({File, Folder, Panel});
        // Execute with this bound to a real panel, as AE does for ScriptUI Panels.
        const dollar = {
            global,
            evalFile(file) {
                assert.equal(file.fsName, bundle);
                assert.equal(global.__CODEX_AE_WORKSPACE_ROOT__, workspace);
                assert.equal(global.__CODEX_AE_PANEL_HOST__, host);
                assert.equal(global.__CODEX_AE_AUTOSTART_ONLY__, false);
                events.push("eval");
                if (failed) { throw new Error("test load failure"); }
            },
            writeln(message) { events.push(message); }
        };
        context.$ = dollar;
        context.panelHost = host;
        vm.runInContext("(function () {" + loader + "}).call(panelHost);", context);
        assert.equal(events.includes("eval"), true);
        assert.equal(events.some(event => String(event).includes("test load failure")), failed);
        for (const key of keys) {
            assert.equal(Object.hasOwn(global, key), prior !== null);
            if (prior !== null) { assert.equal(global[key], prior); }
        }
    }
}
console.log("PASS installed panel preserves docking, scoped globals and readable failures without a modal dialog");

// Loading a second installation must never silently reuse another root's listener.
for (const testCase of [{sameWorkspace: true, oldVersion: false}, {sameWorkspace: false, oldVersion: false}, {sameWorkspace: true, oldVersion: true}]) {
    const {sameWorkspace, oldVersion} = testCase;
    const reuse = sameWorkspace && !oldVersion;
    let stopped = 0, scheduled = 0;
    const prior = {
        version: oldVersion ? "1.9.0" : bridge.match(/BRIDGE_VERSION\s*=\s*"([^"]+)"/)[1], workspaceRoot: sameWorkspace ? workspace.toUpperCase() : "D:/Another installation",
        running: false, stop() { stopped += 1; }
    };
    const global = {
        __CODEX_AE_WORKSPACE_ROOT__: workspace,
        __CODEX_AE_AUTOSTART_ONLY__: true,
        __codexAeBridgeV1: prior
    };
    vm.runInNewContext(bridge, {
        $: {global, fileName: "C:/Installed/Startup/loader.jsx"}, File, Folder,
        Panel: function Panel() {},
        app: {scheduleTask() { scheduled += 1; return 1; }}
    });
    assert.equal(global.__codexAeBridgeV1 === prior, reuse);
    assert.equal(stopped, reuse ? 0 : 1);
    assert.equal(scheduled, reuse ? 0 : 1);
    if (!reuse) { assert.equal(global.__codexAeBridgeV1.workspaceRoot, workspace); }
}
console.log("PASS same-root startup respects Stop; different installations and new bridge versions replace the old listener");
