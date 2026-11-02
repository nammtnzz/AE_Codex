"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, ".."), source = fs.readFileSync(path.join(root, "source/bridge.js"), "utf8").replace(/^#.*$/gm, "");
const harness = { require, process, __dirname, console, Buffer };
vm.createContext(harness);
const hostSource = fs.readFileSync(path.join(__dirname, "Test-AeBridgeLibrary.js"), "utf8");
vm.runInContext(hostSource.slice(0, hostSource.indexOf("const tests = [];")) + "\nthis.makeHost = mockHost;", harness);

function flatten(node) {
    const rows = [];
    for (const child of node.children || []) { rows.push(child, ...flatten(child)); }
    return rows;
}
function fixture() {
    const host = harness.makeHost({ keepAutoStart: true }), dock = new host.context.Panel();
    let defaultLayoutCalls = 0;
    const nativeLayout = {
        layout() { defaultLayoutCalls++; for (const node of flatten(dock)) { node.bounds = [0, 0, 0, 0]; } },
        resize() { this.layout(); }
    };
    dock.size = { width: 440, height: 310 }; dock.layout = nativeLayout;
    host.dollar.global.__CODEX_AE_PANEL_HOST__ = dock;
    host.dollar.global.__codexAeBridgeV1.version = "prior-layout-fixture";
    vm.runInContext(source, host.context);
    const bridge = host.dollar.global.__codexAeBridgeV1, controls = flatten(dock);
    return { host, dock, bridge, controls, nativeLayout, get defaultLayoutCalls() { return defaultLayoutCalls; },
        button(text) { return controls.find(node => node.type === "button" && node.text === text); } };
}
function boundsSnapshot(nodes) { return nodes.map(node => Array.from(node.bounds)); }
function observeBoundsWrites(nodes) {
    let writes = 0;
    for (const node of nodes) {
        let bounds = node.bounds;
        Object.defineProperty(node, "bounds", { configurable: true, get() { return bounds; }, set(value) { writes++; bounds = value; } });
    }
    return () => writes;
}
const tests = [], test = (name, run) => tests.push({ name, run });

test("a new floating palette has usable bounds before any host resize callback", () => {
    const host = harness.makeHost({ keepAutoStart: true });
    host.dollar.global.__codexAeBridgeV1.version = "prior-floating-layout-fixture";
    vm.runInContext(source, host.context);
    const bridge = host.dollar.global.__codexAeBridgeV1, controls = flatten(bridge.window);
    assert.ok(bridge.window instanceof host.context.Window);
    assert.deepEqual(Array.from(bridge.window.size), [440, 310]);
    for (const label of ["Công cụ", "Kho script", "Kết nối lại", "Dừng"]) {
        const bounds = controls.find(node => node.type === "button" && node.text === label).bounds;
        assert.ok(bounds.every(Number.isFinite));
        assert.ok(bounds[2] > bounds[0] && bounds[3] > bounds[1]);
    }
    assert.equal(host.executionCount, 0);
});

test("same-size host layout and resize repair bounds instead of invoking automatic layout", () => {
    const f = fixture(), expected = boundsSnapshot(f.controls), signature = f.bridge.ui.layoutSignature;
    assert.notEqual(f.dock.layout, f.nativeLayout);
    for (const callback of ["layout", "resize"]) {
        for (const node of f.controls) { node.bounds = [0, 0, 0, 0]; }
        assert.equal(f.bridge.ui.layoutSignature, signature, "the repair must not depend on a changed size signature");
        f.dock.layout[callback](true);
        assert.deepEqual(boundsSnapshot(f.controls), expected, callback + " restores root and nested control bounds");
    }
    assert.equal(f.defaultLayoutCalls, 0, "the previous auto-layout manager cannot overwrite tool bounds");
    assert.equal(f.host.executionCount, 0);
});

test("host layout callbacks keep actions accessible through dock size log and progress changes", () => {
    const f = fixture(), controls = f.controls.slice(), windowCount = f.host.createdWindows.length, tasks = f.host.scheduled.size;
    for (let pass = 0; pass < 3; pass++) {
        for (const [w, h] of [[340, 220], [1280, 800], [440, 310], [800, 430]]) {
            for (const expanded of [false, true]) for (const progress of [false, true]) {
                f.dock.size = pass % 2 ? [w, h] : { width: w, height: h };
                f.bridge.ui.logExpanded = expanded; f.bridge.progressGroup.visible = progress;
                f.dock.layout[pass % 2 ? "resize" : "layout"]();
                for (const node of f.bridge.ownedUiRoots) {
                    if (node.visible === false) { continue; }
                    const [left, top, right, bottom] = node.bounds;
                    assert.ok([left, top, right, bottom].every(Number.isFinite));
                    assert.ok(left >= 0 && top >= 0 && right <= w && bottom <= h && right >= left && bottom >= top);
                }
                const row = f.button("Công cụ").parent, options = f.button("Cập nhật").parent;
                assert.ok(options.bounds[1] >= 63 && options.bounds[3] + 6 <= row.bounds[1]);
                for (const text of ["Công cụ", "Kho script", "Kết nối lại", "Dừng"]) {
                    const b = f.button(text).bounds;
                    assert.ok(b[0] >= 0 && b[2] <= w - 18 && b[2] > b[0] && b[3] - b[1] === 30, text);
                }
                for (const node of options.children) {
                    const b = node.bounds;
                    assert.ok(b[0] >= 0 && b[2] <= w - 18 && b[2] > b[0] && b[3] - b[1] === 24);
                }
            }
        }
    }
    assert.deepEqual(flatten(f.dock), controls);
    assert.equal(f.host.createdWindows.length, windowCount); assert.equal(f.host.scheduled.size, tasks);
    assert.equal(f.defaultLayoutCalls, 0); assert.equal(f.host.executionCount, 0);
});

test("unchanged host callbacks and idle reflow make no native bounds writes or extra controls tasks", () => {
    const f = fixture(), writes = observeBoundsWrites(f.controls), manager = f.dock.layout,
        windowCount = f.host.createdWindows.length, tasks = f.host.scheduled.size;
    for (let i = 0; i < 1000; i++) {
        f.dock.layout.layout(true); f.dock.layout.resize(); f.bridge.ui.reflow(false);
    }
    assert.equal(writes(), 0); assert.equal(f.dock.layout, manager); assert.deepEqual(flatten(f.dock), f.controls);
    assert.equal(f.host.createdWindows.length, windowCount); assert.equal(f.host.scheduled.size, tasks);
    assert.equal(f.defaultLayoutCalls, 0); assert.equal(f.host.executionCount, 0);
});

test("replacing an owned dock restores its original layout and releases its controls", () => {
    const f = fixture(), next = new f.host.context.Panel(); next.size = { width: 440, height: 310 };
    f.host.dollar.global.__CODEX_AE_PANEL_HOST__ = next;
    vm.runInContext(source, f.host.context);
    assert.equal(f.dock.layout, f.nativeLayout); assert.equal(f.dock.children.length, 0);
    assert.equal(f.dock.onResize, null); assert.equal(f.dock.onResizing, null);
    assert.equal(f.host.dollar.global.__codexAeBridgeV1.window, next);
    assert.equal(flatten(next).length, f.controls.length); assert.equal(f.host.scheduled.size, 1);
    assert.equal(f.host.executionCount, 0);
});

test("releasing an old dock preserves a replacement layout manager owned by another caller", () => {
    const f = fixture(), foreign = { layout() {}, resize() {} }, next = new f.host.context.Panel();
    f.dock.layout = foreign; next.size = { width: 440, height: 310 };
    f.host.dollar.global.__CODEX_AE_PANEL_HOST__ = next;
    vm.runInContext(source, f.host.context);
    assert.equal(f.dock.layout, foreign); assert.equal(f.dock.children.length, 0);
    assert.equal(f.host.scheduled.size, 1); assert.equal(f.host.executionCount, 0);
});

let failed = 0;
for (const { name, run } of tests) {
    try { run(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); }
}
console.log((tests.length - failed) + "/" + tests.length + " panel layout tests passed");
process.exitCode = failed ? 1 : 0;
