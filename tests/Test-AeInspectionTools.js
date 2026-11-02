/* Inspection/effect integration tests use a fake AE and memory-only filesystem. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const base = fs.readFileSync(path.join(__dirname, "../source/functions-runtime.js"), "utf8");
const fragment = fs.readFileSync(path.join(__dirname, "../source/functions-inspection-tools.js"), "utf8");
const source = base.replace("/* CODEX_AE_EXTRA_FUNCTIONS */", fragment);
const clean = value => JSON.parse(JSON.stringify(value));
const call = (name, args = {}) => ({ function: name, args });
const request = steps => ({ schema: "codex-ae-functions/v1", steps });
function host() {
    const state = { begin: 0, end: 0, captures: [], projectWrites: 0, filesystemWrites: 0 };
    const files = new Map(), folders = new Set(["C:/workspace"]), aliases = new Set();
    const normalize = value => String(value).replace(/\\/g, "/").replace(/\/$/, "");
    class File {
        constructor(name) { this.fsName = normalize(name); this.error = "fake file error"; this.position = 0; }
        get name() { return this.fsName.split("/").pop(); }
        get exists() { return files.has(this.fsName); }
        get alias() { return aliases.has(this.fsName); }
        get length() { return this.exists ? files.get(this.fsName).length : 0; }
        open(mode) { this.position = 0; this.mode = mode; if (mode === "w") { files.set(this.fsName, ""); state.filesystemWrites++; return true; } return this.exists; }
        read(count) { const text = files.get(this.fsName) || "", selected = text.slice(this.position, this.position + count); this.position += selected.length; return selected; }
        write(text) { files.set(this.fsName, String(text)); state.filesystemWrites++; return true; }
        close() { return true; }
        rename(name) { const next = this.fsName.slice(0, this.fsName.lastIndexOf("/") + 1) + name; if (files.has(next)) { return false; } files.set(next, files.get(this.fsName)); files.delete(this.fsName); this.fsName = next; state.filesystemWrites++; return true; }
    }
    class Folder {
        constructor(name) { this.fsName = normalize(name); this.error = "fake folder error"; }
        get exists() { return folders.has(this.fsName); }
        get alias() { return aliases.has(this.fsName); }
        create() { folders.add(this.fsName); state.filesystemWrites++; return true; }
    }
    class Group {
        constructor(name, matchName = name, children = []) { this.name = name; this.matchName = matchName; this.children = children; this.enabled = true; }
        get numProperties() { return this.children.length; }
        property(index) { return typeof index === "number" ? this.children[index - 1] : this.children.find(child => child.name === index || child.matchName === index); }
        link() { this.children.forEach((child, index) => { child.propertyIndex = index + 1; child.remove = () => { this.children.splice(this.children.indexOf(child), 1); state.projectWrites++; }; }); return this; }
    }
    const value = { name: "Amount", matchName: "ADBE Blur-0001", value: 12, numKeys: 0, canSetExpression: true, expression: "value", expressionEnabled: true, expressionError: "" };
    const blur = new Group("Softness", "ADBE Gaussian Blur 2", [value]);
    const tint = new Group("Tint", "ADBE Tint", [{ name: "Color", matchName: "ADBE Tint-0001", value: [1, 0, 0], numKeys: 1 }]);
    const effects = new Group("Effects", "ADBE Effect Parade", [blur, tint]).link();
    const layer = { index: 1, name: "Subject", locked: false, property: name => name === "ADBE Effect Parade" ? effects : null };
    class CompItem {
        constructor() { this.id = 7; this.name = "Main"; this.width = 1920; this.height = 1080; this.duration = 10; this.frameRate = 30; this.frameDuration = 1 / 30; this.time = 2; this.numLayers = 1; }
        layer(index) { return index === 1 ? layer : null; }
        saveFrameToPng(time, file) {
            state.captures.push({ time, path: file.fsName });
            const bytes = Buffer.alloc(40); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12); bytes.writeUInt32BE(this.width, 16); bytes.writeUInt32BE(this.height, 20); bytes[24] = 8; bytes[25] = 6;
            files.set(file.fsName, bytes.toString("latin1")); state.filesystemWrites++;
        }
    }
    const comp = new CompItem(); layer.containingComp = comp;
    const project = { activeItem: comp, numItems: 1, item: index => index === 1 ? comp : null };
    const sandbox = { app: { version: "26.5", project, effects: [
        { displayName: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2", category: "Blur & Sharpen", version: "1" },
        { displayName: "Tint", matchName: "ADBE Tint", category: "Color Correction", version: "2" },
        { displayName: "Custom Blur", matchName: "Example Blur", category: "Blur & Sharpen", version: "3" }
    ], beginUndoGroup: () => state.begin++, endUndoGroup: () => state.end++ }, CompItem, File, Folder, $: { global: {} } };
    vm.createContext(sandbox); vm.runInContext(source, sandbox);
    const api = sandbox.$.global.__codexAeFunctionsV1;
    const context = { schema: "codex-ae-context/v1", runId: "capture-test-01", workspaceRoot: "C:/workspace" };
    const run = (name, args = {}, suppliedContext = context) => clean(api.run(request([call(name, args)]), suppliedContext)).results[0].value;
    return { state, files, folders, aliases, layer, comp, effects, sandbox, api, context, run };
}
let passed = 0;
function test(name, body) { body(); passed++; console.log("PASS " + name); }

test("Fragment uses ES3 syntax and all four tools register without AE or filesystem access", () => {
    assert.doesNotMatch(fragment, /\b(?:let|const|class)\b|=>/);
    const h = host(), names = clean(h.api.list(false)).map(item => item.name);
    for (const name of ["effects.list", "effect.inspect", "effect.remove", "inspection.capture"]) { assert.ok(names.includes(name)); }
    assert.equal(h.state.filesystemWrites, 0); assert.equal(h.state.projectWrites, 0); assert.equal(h.state.begin, 0);
});
test("Effects list reads registered metadata with search/category/limit and never creates layers", () => {
    const h = host(); h.sandbox.app.project = null;
    const result = h.run("effects.list", { search: "blur", category: "blur & sharpen", maxItems: 1 });
    assert.equal(result.registeredCount, 3); assert.equal(result.matchedCount, 2); assert.equal(result.effects.length, 1); assert.equal(result.truncated, true); assert.equal(result.runtimeLicenseVerified, false);
    assert.equal(h.state.projectWrites, 0); assert.equal(h.state.begin, 0);
});
test("Effect inspect returns bounded exact paths and values without undo or mutation", () => {
    const h = host(), result = h.run("effect.inspect", { layer: { index: 1 }, maxProperties: 4 });
    assert.equal(result.effects.length, 2); assert.equal(result.returnedNodes, 4); assert.equal(result.effects[0].properties[0].value, 12);
    assert.deepEqual(result.effects[0].properties[0].path, ["ADBE Effect Parade", 1, 1]);
    assert.deepEqual(result.effects[1].properties[0].value, [1, 0, 0]); assert.equal(h.state.begin, 0); assert.equal(h.state.projectWrites, 0);
    const limited = h.run("effect.inspect", { layer: { index: 1 }, maxProperties: 1 });
    assert.equal(limited.returnedNodes, 1); assert.equal(limited.truncated, true);
});
test("Effect inspect safely bounds huge and unsupported property values", () => {
    const h = host(), properties = h.effects.property(1).children;
    properties[0].value = "x".repeat(8000);
    const result = h.run("effect.inspect", { layer: { index: 1 } });
    assert.equal(result.effects[0].properties[0].value.text.length, 2048); assert.equal(result.effects[0].properties[0].value.truncated, true);
    properties[0].value = { execute: () => { throw Error("must not execute"); } };
    assert.deepEqual(h.run("effect.inspect", { layer: { index: 1 } }).effects[0].properties[0].value, { unsupported: true });
});
test("Effect remove is exact, rejects ambiguity/locked layers and closes undo on failures", () => {
    const h = host(); h.effects.children[1].name = "Softness";
    assert.throws(() => h.run("effect.remove", { layer: { index: 1 }, effect: { name: "Softness" } }), /ambiguous/);
    assert.equal(h.state.projectWrites, 0);
    h.layer.locked = true;
    assert.throws(() => h.run("effect.remove", { layer: { index: 1 }, effect: { index: 1 } }), /locked/);
    h.layer.locked = false;
    assert.throws(() => h.run("effect.remove", { layer: { index: 1 }, effect: { index: 1, name: "Softness" } }), /exactly one/);
    const result = h.run("effect.remove", { layer: { index: 1 }, effect: { index: 2 } });
    assert.equal(result.removed, true); assert.equal(h.state.projectWrites, 1); assert.equal(h.effects.numProperties, 1); assert.equal(h.state.begin, h.state.end);
});
test("Single capture preserves frame/manifest compatibility and never changes viewer time/project data", () => {
    const h = host(), beforeTime = h.comp.time, result = h.run("inspection.capture");
    assert.equal(result.schema, "codex-ae-inspection/v1"); assert.equal(result.frameRelativePath, ".ae-codex/inspection/capture-test-01/frame.png");
    assert.equal(result.visualVerified, false); assert.equal(result.visualReviewState, "pending"); assert.equal(result.frameWidth, 1920); assert.equal(result.frameHeight, 1080);
    assert.equal(result.pngSignatureValid, true); assert.equal(result.frames.length, 1);
    assert.deepEqual(JSON.parse(h.files.get("C:/workspace/" + result.manifestRelativePath)), result);
    assert.equal(h.comp.time, beforeTime); assert.equal(h.state.projectWrites, 0); assert.equal(h.state.begin, 0);
});
test("Sampled frames include valid last frame and never the exclusive composition end", () => {
    const h = host(), result = h.run("inspection.capture", { numFrames: 3 });
    assert.equal(result.frames.length, 3); assert.equal(h.state.captures[0].time, 0);
    assert.equal(h.state.captures.at(-1).time, h.comp.duration - h.comp.frameDuration);
    assert.ok(h.state.captures.every(capture => capture.time >= 0 && capture.time < h.comp.duration));
    assert.ok(result.frames[1].frameRelativePath.endsWith("frame-002.png"));
});
test("Default viewer time is clamped to the last valid frame; explicit invalid times fail before writes", () => {
    const h = host(); h.comp.time = h.comp.duration;
    h.run("inspection.capture"); assert.equal(h.state.captures[0].time, h.comp.duration - h.comp.frameDuration);
    const other = host();
    assert.throws(() => other.run("inspection.capture", { times: [10] }), /args.times/);
    assert.equal(other.state.filesystemWrites, 0); assert.equal(other.state.captures.length, 0);
});
test("Explicit times and tool input bounds validate before any capture", () => {
    const h = host();
    for (const args of [{ times: [], numFrames: 1 }, { times: [] }, { times: Array(4).fill(0) }, { times: [NaN] }, { numFrames: 4 }, { numFrames: 1.5 }, { outputPath: "C:/elsewhere/frame.png" }]) {
        assert.throws(() => h.run("inspection.capture", args));
    }
    assert.equal(h.state.filesystemWrites, 0);
    const result = h.run("inspection.capture", { times: [0, 2] }); assert.deepEqual(result.frames.map(frame => frame.timeSeconds), [0, 2]);
});

test("Capture catalog advertises the three-frame bound and default remains one viewer frame", () => {
    const h = host(), descriptor = clean(h.api.list(false)).find(item => item.name === "inspection.capture");
    assert.equal(descriptor.inputSchema.properties.numFrames.maximum, 3);
    assert.equal(descriptor.inputSchema.properties.times.maxItems, 3);
    assert.match(descriptor.description, /one capture call per request/);
    const result = h.run("inspection.capture");
    assert.equal(result.frames.length, 1); assert.equal(h.state.captures.length, 1);
    assert.equal(h.state.captures[0].time, h.comp.time);
});

test("Repeated captures in a plan are rejected before edits, output writes or rendering", () => {
    const h = host();
    const steps = [call("effect.remove", { layer: { index: 1 }, effect: { index: 1 } }), call("inspection.capture"), call("inspection.capture")];
    assert.throws(() => h.api.run(request(steps), h.context), /Only one inspection.capture call/);
    assert.equal(h.state.captures.length, 0); assert.equal(h.state.filesystemWrites, 0);
    assert.equal(h.state.projectWrites, 0); assert.equal(h.state.begin, 0);
    assert.equal(h.effects.numProperties, 2);
});
test("Capture requires trusted context and refuses traversal, aliases, old run folders and overwrites", () => {
    const h = host();
    assert.throws(() => h.run("inspection.capture", {}, null), /context/);
    for (const bad of [{ ...h.context, runId: "../outside" }, { ...h.context, workspaceRoot: "C:/workspace/../elsewhere" }, { ...h.context, workspaceRoot: "relative" }]) {
        assert.throws(() => h.run("inspection.capture", {}, bad));
    }
    h.aliases.add("C:/workspace/.ae-codex");
    assert.throws(() => h.run("inspection.capture"), /aliases/); h.aliases.clear();
    h.run("inspection.capture"); const before = h.state.captures.length;
    assert.throws(() => h.run("inspection.capture"), /already exists/); assert.equal(h.state.captures.length, before);
    assert.ok([...h.files.keys()].every(name => name.startsWith("C:/workspace/.ae-codex/inspection/capture-test-01/")));
});
test("PNG corruption and host export failures surface once without retrying project evaluation", () => {
    const h = host(); h.comp.saveFrameToPng = (time, file) => { h.state.captures.push({ time }); h.files.set(file.fsName, "x".repeat(40)); };
    assert.throws(() => h.run("inspection.capture"), /invalid signature/); assert.equal(h.state.captures.length, 1);
    const other = host(); other.comp.saveFrameToPng = () => { other.state.captures.push({}); throw Error("encoder failed"); };
    assert.throws(() => other.run("inspection.capture"), /encoder failed/); assert.equal(other.state.captures.length, 1);
});
test("Technical-review dimension limits are checked before exporting frames", () => {
    const h = host(); h.comp.width = 20000;
    assert.throws(() => h.run("inspection.capture"), /dimensions/); assert.equal(h.state.captures.length, 0); assert.equal(h.state.filesystemWrites, 0);
});
console.log(passed + "/" + passed + " inspection tool tests passed");
