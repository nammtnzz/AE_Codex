/* Offline native-memory API contracts. Never touches AE, its preferences or project. */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const source = require("../tools/AeFunctionsSource.js").readFunctionsRuntime(path.resolve(__dirname, ".."));

function fixture() {
    const state = { bytes: 12 * 1024 ** 3, begin: 0, end: 0, configure: [], purge: [], rendering: false, projectWrites: 0, throwNative: false, throwReadback: false };
    const queue = {};
    Object.defineProperty(queue, "rendering", { configurable: true, get: () => state.rendering });
    const protectedProject = new Proxy({ renderQueue: queue, dirty: true, numItems: 3, name: "Unsaved project" }, {
        set() { state.projectWrites++; throw new Error("Project data must remain unchanged"); },
        deleteProperty() { state.projectWrites++; throw new Error("Project data must remain unchanged"); }
    });
    const undo = ["existing user edit"], snapshots = ["user snapshot"], disk = ["cached frame on disk"];
    const app = { version: "26.5", project: protectedProject,
        beginUndoGroup() { state.begin++; }, endUndoGroup() { state.end++; },
        setMemoryUsageLimits(image, maximum) { state.configure.push([image, maximum]); if (state.throwNative) throw new Error("Native memory limit failure"); },
        purge(target) { state.purge.push(target); assert.equal(target, 101); if (state.throwNative) throw new Error("Native cache release failure"); state.bytes -= 3 * 1024 ** 3; }
    };
    Object.defineProperty(app, "memoryInUse", { configurable: true, get() {
        if (state.throwReadback && (state.configure.length || state.purge.length)) throw new Error("Native memory readback failure");
        return state.bytes;
    } });
    Object.defineProperty(app, "preferences", { get() { throw new Error("Do not inspect or write undocumented memory preferences"); } });
    const sandbox = { app, PurgeTarget: { IMAGE_CACHES: 101, ALL_CACHES: 102, ALL_MEMORY_CACHES: 103, UNDO_CACHES: 104, SNAPSHOT_CACHES: 105 }, $: { global: {} } };
    vm.createContext(sandbox); vm.runInContext(source, sandbox);
    const api = sandbox.$.global.__codexAeFunctionsV1;
    function run(args = {}) { return JSON.parse(JSON.stringify(api.run({ schema: "codex-ae-functions/v1", steps: [{ function: "app.memory", args }] }))).results[0].value; }
    function unchanged() {
        assert.equal(state.begin, 0); assert.equal(state.end, 0); assert.equal(state.projectWrites, 0);
        assert.deepEqual(undo, ["existing user edit"]); assert.deepEqual(snapshots, ["user snapshot"]); assert.deepEqual(disk, ["cached frame on disk"]);
        assert.equal(protectedProject.dirty, true); assert.equal(protectedProject.numItems, 3);
    }
    return { api, app, state, sandbox, run, unchanged };
}

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write("ok " + passed + " - " + name + "\n"); }

test("catalog advertises conditional native schemas and exclusive application scope", () => {
    const f = fixture(), descriptor = JSON.parse(JSON.stringify(f.api.list())).find(item => item.name === "app.memory");
    assert.equal(descriptor.mutates, true); assert.equal(descriptor.exclusive, true); assert.equal(descriptor.internal, false);
    assert.deepEqual(Object.keys(descriptor.inputSchema.properties), Object.keys(descriptor.args));
    assert.deepEqual(descriptor.inputSchema.properties.operation.enum, ["inspect", "configure", "purgeImages"]);
    assert.equal(descriptor.inputSchema.properties.operation.default, "inspect");
    assert.deepEqual(descriptor.inputSchema.required, []); assert.equal(descriptor.inputSchema.additionalProperties, false);
    const branches = descriptor.inputSchema.oneOf;
    assert.equal(branches.length, 3); assert.equal(branches[0].additionalProperties, false);
    assert.deepEqual(Object.keys(branches[0].properties), ["operation"]);
    assert.deepEqual(branches[1].required, ["operation", "imageCachePercentage", "maximumMemoryPercentage"]);
    for (const name of ["imageCachePercentage", "maximumMemoryPercentage"]) {
        assert.equal(branches[1].properties[name].type, "number"); assert.equal(branches[1].properties[name].minimum, 0); assert.equal(branches[1].properties[name].maximum, 100);
    }
    assert.deepEqual(Object.keys(branches[2].properties), ["operation"]); assert.deepEqual(branches[2].required, ["operation"]);
    f.unchanged();
});
test("default and explicit inspection report native byte values without changes or Undo groups", () => {
    const f = fixture();
    for (const args of [{}, { operation: "inspect" }]) {
        const result = f.run(args);
        assert.equal(result.operation, "inspect"); assert.equal(result.beforeBytes, f.state.bytes); assert.equal(result.afterBytes, f.state.bytes);
        assert.equal(result.limitsReadbackAvailable, false); assert.equal(result.projectModified, false); assert.equal(result.preservesUndo, true); assert.equal(result.preservesDiskCache, true);
        assert.equal("requestedLimits" in result, false); assert.equal("releasedBytes" in result, false);
    }
    assert.deepEqual(f.state.configure, []); assert.deepEqual(f.state.purge, []); f.unchanged();
});
test("inspection remains available with no open project or while rendering", () => {
    const f = fixture(); f.state.rendering = true; assert.equal(f.run().operation, "inspect");
    f.app.project = null; assert.equal(f.run().afterBytes, f.state.bytes);
    assert.deepEqual(f.state.configure, []); assert.deepEqual(f.state.purge, []); f.unchanged();
});
test("configuration dispatches both native percentages once and reports only requested limits", () => {
    const f = fixture(), result = f.run({ operation: "configure", imageCachePercentage: 50.5, maximumMemoryPercentage: 75 });
    assert.deepEqual(f.state.configure, [[50.5, 75]]); assert.deepEqual(f.state.purge, []);
    assert.deepEqual(result.requestedLimits, { imageCachePercentage: 50.5, maximumMemoryPercentage: 75 });
    assert.equal(result.limitsReadbackAvailable, false); assert.equal(result.beforeBytes, f.state.bytes); assert.equal(result.afterBytes, f.state.bytes);
    assert.equal("maximumBytes" in result, false); assert.equal("hardLimitBytes" in result, false); f.unchanged();
});
test("percentage boundary values are accepted without silent defaults or clamps", () => {
    const f = fixture(); f.run({ operation: "configure", imageCachePercentage: 0, maximumMemoryPercentage: 100 });
    f.run({ operation: "configure", imageCachePercentage: 100, maximumMemoryPercentage: 0 });
    assert.deepEqual(f.state.configure, [[0, 100], [100, 0]]); f.unchanged();
});
test("image cache release uses only IMAGE_CACHES and preserves project, Undo, snapshots and disk", () => {
    const f = fixture(), before = f.state.bytes, result = f.run({ operation: "purgeImages" });
    assert.deepEqual(f.state.purge, [f.sandbox.PurgeTarget.IMAGE_CACHES]); assert.deepEqual(f.state.configure, []);
    assert.equal(result.purgedTarget, "IMAGE_CACHES"); assert.equal(result.beforeBytes, before); assert.equal(result.afterBytes, f.state.bytes);
    assert.equal(result.releasedBytes, 3 * 1024 ** 3); assert.equal(result.preservesUndo, true); assert.equal(result.preservesDiskCache, true); f.unchanged();
});
test("invalid operations, extra fields and cache-target substitution fail before native changes", () => {
    const f = fixture();
    for (const args of [{ operation: "" }, { operation: null }, { operation: "purgeAll" }, { target: "ALL_CACHES" }, { operation: "purgeImages", target: "UNDO_CACHES" },
        { operation: "inspect", imageCachePercentage: 50 }, { maximumMemoryPercentage: 75 }, { operation: "purgeImages", maximumMemoryPercentage: 75 },
        { operation: "configure", imageCachePercentage: 50, maximumMemoryPercentage: 75, hardLimitBytes: 123 }]) {
        assert.throws(() => f.run(args));
    }
    assert.deepEqual(f.state.configure, []); assert.deepEqual(f.state.purge, []); f.unchanged();
});
test("configure rejects missing, nonfinite, nonnumeric and out-of-range percentages before native changes", () => {
    const f = fixture();
    for (const args of [{ operation: "configure" }, { operation: "configure", imageCachePercentage: 50 }, { operation: "configure", maximumMemoryPercentage: 75 }]) assert.throws(() => f.run(args));
    for (const value of [-1, 100.01, Infinity, -Infinity, NaN, "75", null, false]) {
        assert.throws(() => f.run({ operation: "configure", imageCachePercentage: value, maximumMemoryPercentage: 75 }));
        assert.throws(() => f.run({ operation: "configure", imageCachePercentage: 50, maximumMemoryPercentage: value }));
    }
    assert.deepEqual(f.state.configure, []); assert.deepEqual(f.state.purge, []); f.unchanged();
});
test("changes fail closed during rendering and when render-queue idle status is unavailable", () => {
    for (const rendering of [true, undefined, null, "false"]) {
        const f = fixture(); f.state.rendering = rendering;
        assert.throws(() => f.run({ operation: "configure", imageCachePercentage: 50, maximumMemoryPercentage: 75 }), /render/i);
        assert.throws(() => f.run({ operation: "purgeImages" }), /render/i);
        assert.deepEqual(f.state.configure, []); assert.deepEqual(f.state.purge, []); f.unchanged();
    }
    const f = fixture(); f.app.project = {}; assert.throws(() => f.run({ operation: "purgeImages" }), /render queue/i); f.unchanged();
});
test("required native APIs and enum are verified before any change", () => {
    const configure = fixture(); delete configure.app.setMemoryUsageLimits;
    assert.throws(() => configure.run({ operation: "configure", imageCachePercentage: 50, maximumMemoryPercentage: 75 }), /setMemoryUsageLimits/);
    assert.deepEqual(configure.state.configure, []); configure.unchanged();
    for (const mutation of [f => { delete f.app.purge; }, f => { delete f.sandbox.PurgeTarget; }, f => { delete f.sandbox.PurgeTarget.IMAGE_CACHES; }, f => { f.sandbox.PurgeTarget.IMAGE_CACHES = null; }]) {
        const f = fixture(); mutation(f); assert.throws(() => f.run({ operation: "purgeImages" }), /IMAGE_CACHES/);
        assert.deepEqual(f.state.purge, []); f.unchanged();
    }
});
test("ExtendScript native methods accept its unknown typeof without accepting ordinary non-callables", () => {
    // Node cannot produce ExtendScript's host-only typeof value. Keep that host
    // compatibility explicit while exercising the rejected ordinary values.
    assert.match(source, /function memoryNativeMethod\(type\)\s*\{\s*return type === "function" \|\| type === "unknown";/);
    assert.match(source, /!memoryNativeMethod\(typeof app\.setMemoryUsageLimits\)/);
    assert.match(source, /!memoryNativeMethod\(typeof app\.purge\)/);
    for (const value of [null, {}, 1, "function", true]) {
        const f = fixture(); f.app.purge = value; f.app.setMemoryUsageLimits = value;
        assert.throws(() => f.run({ operation: "purgeImages" }), /IMAGE_CACHES/);
        assert.throws(() => f.run({ operation: "configure", imageCachePercentage: 50, maximumMemoryPercentage: 75 }), /setMemoryUsageLimits/);
        assert.deepEqual(f.state.configure, []); assert.deepEqual(f.state.purge, []); f.unchanged();
    }
});
test("unavailable or invalid native memory measurements prevent both configuration and cache release", () => {
    for (const bytes of [undefined, null, NaN, Infinity, -1, "1200"]) {
        const f = fixture(); f.state.bytes = bytes;
        assert.throws(() => f.run()); assert.throws(() => f.run({ operation: "configure", imageCachePercentage: 50, maximumMemoryPercentage: 75 })); assert.throws(() => f.run({ operation: "purgeImages" }));
        assert.deepEqual(f.state.configure, []); assert.deepEqual(f.state.purge, []); f.unchanged();
    }
    const f = fixture(); delete f.sandbox.app; assert.throws(() => f.run(), /memory information is unavailable/); f.unchanged();
});
test("exclusive validation rejects mixed edit plans before any native call or project action", () => {
    const f = fixture();
    assert.throws(() => f.api.run({ schema: "codex-ae-functions/v1", steps: [{ function: "comp.create", args: { name: "Must not exist" } }, { function: "app.memory", args: { operation: "purgeImages" } }] }), /must be called alone/);
    assert.deepEqual(f.state.configure, []); assert.deepEqual(f.state.purge, []); f.unchanged();
});
test("native failures and failures after dispatch are reported without replay or opening Undo groups", () => {
    for (const operation of ["configure", "purgeImages"]) for (const phase of ["native", "readback"]) {
        const f = fixture(); f.state.throwNative = phase === "native"; f.state.throwReadback = phase === "readback";
        const args = operation === "configure" ? { operation, imageCachePercentage: 50, maximumMemoryPercentage: 75 } : { operation };
        assert.throws(() => f.run(args), error => {
            assert.equal(error.stepIndex, 0); assert.equal(error.completedSteps, 0); assert.equal(error.functionName, "app.memory"); return /Native/.test(error.message);
        });
        assert.equal(operation === "configure" ? f.state.configure.length : f.state.purge.length, 1); f.unchanged();
    }
});
test("render status is checked again immediately before the native change", () => {
    const f = fixture(); let checks = 0;
    Object.defineProperty(f.app.project.renderQueue, "rendering", { configurable: true, get() { checks++; return checks > 2; } });
    assert.throws(() => f.run({ operation: "purgeImages" }), /rendering/); assert.deepEqual(f.state.purge, []); f.unchanged();
});

process.stdout.write("Memory tools: " + passed + " offline checks passed.\n");
