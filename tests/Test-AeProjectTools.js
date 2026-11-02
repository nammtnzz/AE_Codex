/* Isolated AE host fixtures; no real files, project, media import or render is touched. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readFunctionsRuntime } = require("../tools/AeFunctionsSource.js");
const source = readFunctionsRuntime();
const clean = value => JSON.parse(JSON.stringify(value));
const request = steps => ({ schema: "codex-ae-functions/v1", steps });
const call = (name, args = {}, as) => ({ function: name, args, ...(as ? { as } : {}) });
function host() {
    const state = { begin: 0, end: 0, imported: [], saves: 0, commands: [], renders: 0, removed: 0, finalStatus: 8 };
    let nextId = 1;
    const normalize = value => String(value).replace(/\\/g, "/");
    const key = value => normalize(value).toLowerCase();
    const files = new Set(["c:/media/clip.mp4", "c:/media/frames0001.png", "c:/project/current.aep"]);
    const folders = new Set(["c:/media", "c:/out", "c:/project"]);
    function File(value) {
        if (!(this instanceof File)) { return new File(value); }
        this.fsName = normalize(value); this.fullName = this.fsName; this.name = this.fsName.split("/").at(-1);
        const directory = this.fsName.slice(0, this.fsName.lastIndexOf("/"));
        this.parent = { fsName: directory, get exists() { return folders.has(key(directory)); },
            getFiles: () => [...files].filter(name => name.slice(0, name.lastIndexOf("/")) === key(directory)).map(name => new File(name)) };
    }
    Object.defineProperty(File.prototype, "exists", { get() { return files.has(key(this.fsName)); } });
    class FolderItem { constructor(name) { this.id = nextId++; this.name = name; } }
    class FootageItem {
        constructor(name, file) { this.id = nextId++; this.name = name; this.file = file; this.duration = 10; this.width = 1280; this.height = 720; this.frameRate = 24; this.mainSource = {}; }
    }
    class SolidSource { constructor(color = [1, 1, 1]) { this.color = color; } }
    class Layer {
        constructor(comp, item) { this.id = nextId++; this.containingComp = comp; this.name = item.name; this.source = item; this.enabled = true; this.locked = false; this.startTime = 0; this.inPoint = 0; this.outPoint = comp.duration; this.parent = null; }
        get index() { return this.containingComp.members.indexOf(this) + 1; }
    }
    class CompItem {
        constructor(name, width = 1920, height = 1080, pixelAspect = 1, duration = 10, frameRate = 30) {
            Object.assign(this, { id: nextId++, name, width, height, pixelAspect, duration, frameRate, time: 0, members: [] });
            this.layers = { add: item => { const layer = new Layer(this, item); this.members.unshift(layer); return layer; } };
        }
        get numLayers() { return this.members.length; }
        layer(index) { return this.members[index - 1]; }
    }
    const project = { list: [], file: new File("C:/project/current.aep"), bitsPerChannel: 16, dirty: false, activeItem: null,
        get numItems() { return this.list.length; }, item(index) { return this.list[index - 1]; },
        items: { addComp(...args) { const comp = new CompItem(...args); project.list.push(comp); return comp; } },
        importFile(settings) { state.imported.push(settings); const item = settings.importAs === 2 ? new FolderItem(settings.file.name) : new FootageItem(settings.file.name, settings.file); project.list.push(item); return item; },
        save(destination) { state.saves++; if (state.saveFail) { throw new Error("save failure"); } if (destination) { this.file = destination; } files.add(key(this.file.fsName)); }
    };
    const comp = project.items.addComp("Main"), nested = project.items.addComp("Nested"), folder = new FolderItem("Assets"), footage = new FootageItem("Clip", new File("C:/media/clip.mp4"));
    project.list.push(folder, footage); project.activeItem = comp;
    comp.layers.add(footage); const child = comp.layers.add(nested); comp.members[1].parent = child;
    nested.layers.add(footage);
    const statuses = { WILL_CONTINUE: 1, NEEDS_OUTPUT: 2, UNQUEUED: 3, QUEUED: 4, RENDERING: 5, USER_STOPPED: 6, ERR_STOPPED: 7, DONE: 8 };
    const queue = { entries: [], rendering: false, get numItems() { return this.entries.length; }, item(index) { return this.entries[index - 1]; },
        items: { add(selected) {
            let destination = null;
            const output = { templates: ["Lossless", "PNG Sequence"], applyTemplate(value) { this.applied = value; },
                get file() { return destination; }, set file(value) { destination = state.changeDestination ? new File(value.fsName + ".mov") : value; } };
            // Real RenderQueueItem need not expose an index property.
            const item = { comp: selected, render: true, status: statuses.QUEUED, numOutputModules: 1, templates: ["Best Settings"],
                applyTemplate(value) { this.applied = value; }, outputModule(index) { return index === 1 ? output : null; },
                remove() { if (state.cleanupFail) { throw new Error("cleanup failure"); } queue.entries.splice(queue.entries.indexOf(this), 1); state.removed++; } };
            queue.entries.push(item); return item;
        } },
        render() { state.renders++; for (const item of this.entries) { if (item.render) { item.status = state.finalStatus; } } if (state.renderThrow) { throw new Error("render failure"); } }
    };
    project.renderQueue = queue;
    class ImportOptions { constructor(file) { this.file = file; } canImportAs() { return state.canImport !== false; } }
    const sandbox = { app: { version: "26.5", project, beginUndoGroup() { state.begin++; }, endUndoGroup() { state.end++; }, executeCommand(id) { state.commands.push(id); } },
        File, ImportOptions, ImportAsType: { FOOTAGE: 1, PROJECT: 2 }, CompItem, FootageItem, FolderItem, SolidSource, RQItemStatus: statuses,
        $: { global: {} } };
    vm.createContext(sandbox); vm.runInContext(source, sandbox);
    const api = sandbox.$.global.__codexAeFunctionsV1;
    function run(name, args) { return clean(api.run(request([call(name, args)]))).results[0].value; }
    return { api, run, sandbox, state, project, comp, nested, footage, folder, files, folders, queue, statuses, File, FootageItem, SolidSource };
}
let passed = 0;
function test(name, body) { body(); console.log("ok " + ++passed + " - " + name); }

test("assembled runtime preserves the project fragment literally, including replacement-string tokens", () => {
    assert.ok(source.includes(fs.readFileSync(path.join(__dirname, "../source/functions-project-tools.js"), "utf8")), "Source insertion must preserve literal $& syntax");
});
test("project/media/render catalog schemas expose path strings, booleans and typed item selectors", () => {
    const { api } = host(), catalog = clean(api.list(false));
    const descriptor = name => catalog.find(entry => entry.name === name);
    assert.equal(descriptor("media.import").inputSchema.properties.path.type, "string");
    assert.equal(descriptor("project.save").inputSchema.properties.path.type, "string");
    assert.equal(descriptor("media.import").inputSchema.properties.forceAlphabetical.type, "boolean");
    assert.equal(descriptor("render.queue.add").inputSchema.properties.overwrite.type, "boolean");
    assert.deepEqual(descriptor("render.queue.add").inputSchema.required, ["outputPath"]);
    assert.ok(descriptor("layer.media.add").inputSchema.properties.item.oneOf.some(item => item.properties.id));
    assert.ok(descriptor("project.search").inputSchema.properties.type.enum.includes("solid"));
    for (const name of ["project.save", "project.undo", "render.start"]) { assert.equal(descriptor(name).exclusive, true); }
});
test("project search filters item types, reports bounded results and performs no undo", () => {
    const { run, state } = host();
    assert.equal(run("project.search", { query: "MAIN", type: "composition" }).items[0].name, "Main");
    assert.equal(run("project.search", { query: "", type: "footage" }).totalMatches, 1);
    assert.equal(run("project.search", { query: "", type: "folder" }).items[0].name, "Assets");
    const bounded = run("project.search", { query: "", maxItems: 1 });
    assert.equal(bounded.items.length, 1); assert.equal(bounded.totalMatches, 4); assert.equal(bounded.truncated, true);
    assert.equal(state.begin, 0); assert.equal(state.end, 0);
});
test("project inspection exposes saved and unsaved name/path plus native bit depth without writes", () => {
    const { run, project, state } = host();
    for (const bits of [8, 16, 32]) {
        project.bitsPerChannel = bits;
        const result = run("project.inspect", {});
        assert.equal(result.name, "current.aep"); assert.equal(result.path, "C:/project/current.aep"); assert.equal(result.bitsPerChannel, bits); assert.equal(result.saved, true);
    }
    project.dirty = true; assert.equal(run("project.inspect", {}).saved, false);
    delete project.dirty; assert.equal(run("project.inspect", {}).saved, null);
    project.file = null;
    const unsaved = run("project.inspect", {});
    assert.equal(unsaved.name, "Untitled"); assert.equal(unsaved.path, null); assert.equal(unsaved.bitsPerChannel, 32);
    assert.equal(state.begin, 0); assert.equal(state.saves, 0);
});
test("solid search uses SolidSource, footage remains inclusive, and solids can become media layers", () => {
    const { run, project, FootageItem, SolidSource, state, folder, comp, footage } = host();
    const solid = new FootageItem("Background Solid", null); solid.mainSource = new SolidSource([0.1, 0.2, 0.3]); project.list.push(solid); folder.numItems = 0;
    const solids = run("project.search", { query: "", type: "solid" });
    assert.equal(solids.totalMatches, 1); assert.equal(solids.items[0].id, solid.id); assert.equal(solids.items[0].isSolid, true);
    const footageResult = run("project.search", { query: "", type: "footage" });
    assert.equal(footageResult.totalMatches, 2); assert.equal(footageResult.items.find(item => item.name === "Clip").isSolid, false);
    assert.deepEqual(solids.items[0].color, [0.1, 0.2, 0.3]);
    const searchedClip = run("project.search", { query: "Clip", type: "footage" }).items[0];
    assert.equal(searchedClip.width, 1280); assert.equal(searchedClip.height, 720); assert.equal(searchedClip.frameRate, 24); assert.equal(searchedClip.file, "C:/media/clip.mp4");
    const searchedComp = run("project.search", { query: "Main", type: "composition" }).items[0];
    assert.equal(searchedComp.id, comp.id); assert.equal(searchedComp.width, 1920); assert.equal(searchedComp.numLayers, 2);
    assert.equal(run("project.search", { query: "Assets" }).items[0].numItems, 0);
    const inspectedItems = run("project.inspect", {}).items;
    assert.deepEqual(inspectedItems.find(item => item.id === solid.id).color, [0.1, 0.2, 0.3]);
    assert.equal(inspectedItems.find(item => item.id === folder.id).numItems, 0);
    assert.equal(inspectedItems.find(item => item.id === footage.id).file, "C:/media/clip.mp4");
    assert.equal(state.begin, 0);
    assert.equal(run("layer.media.add", { item: { id: solid.id } }).source.id, solid.id);
});
test("optional project-item metadata getters can fail without hiding the item or mutating anything", () => {
    const { run, footage, state } = host();
    Object.defineProperty(footage, "width", { get() { throw new Error("width unavailable"); } });
    Object.defineProperty(footage, "file", { get() { throw new Error("file unavailable"); } });
    const searched = run("project.search", { query: "Clip" }).items[0];
    assert.equal(searched.id, footage.id); assert.equal(searched.width, undefined); assert.equal(searched.file, undefined);
    const inspected = run("project.inspect", {}).items.find(item => item.id === footage.id);
    assert.equal(inspected.id, footage.id); assert.equal(inspected.width, undefined); assert.equal(inspected.file, undefined);
    assert.equal(state.begin, 0); assert.equal(state.saves, 0);
});
test("hierarchy reports parent/precomp links, visits shared comps once and obeys a total layer bound", () => {
    const { run, state, comp, nested } = host();
    nested.layers.add(comp); // A fixture-only cycle proves traversal terminates.
    const tree = run("comp.hierarchy", {});
    assert.equal(tree.rootCompId, comp.id); assert.equal(tree.compositions.length, 2); assert.equal(tree.layersRead, 4);
    assert.equal(tree.compositions[0].layers[0].source.precomp, true);
    assert.equal(tree.compositions[0].layers[1].parentIndex, 1);
    const bounded = run("comp.hierarchy", { maxLayers: 1 });
    assert.equal(bounded.layersRead, 1); assert.equal(bounded.truncated, true); assert.equal(state.begin, 0);
});
test("import and media-layer tools chain item and layer references in one undo group", () => {
    const { api, state, comp } = host();
    const result = clean(api.run(request([
        call("media.import", { path: "C:/media/clip.mp4", sequence: false }, "clip"),
        call("layer.media.add", { item: { ref: "clip" }, comp: { id: comp.id }, name: "Imported", startTime: 1, inPoint: 1, outPoint: 5 }, "layer")
    ])));
    assert.equal(result.results[0].value.type, "footage"); assert.equal(result.results[1].value.name, "Imported");
    assert.equal(result.results[1].value.inPoint, 1); assert.equal(result.results[1].value.outPoint, 5);
    assert.equal(state.imported[0].sequence, false); assert.equal(state.begin, 1); assert.equal(state.end, 1);
});
test("new composition references can be used as media items without weakening item-to-comp typing", () => {
    const { api, comp, state } = host();
    const result = clean(api.run(request([
        call("comp.create", { name: "New Source" }, "source"),
        call("layer.media.add", { comp: { id: comp.id }, item: { ref: "source" } })
    ])));
    assert.equal(result.results[1].value.source.id, result.results[0].value.id);
    assert.equal(state.begin, 1); assert.equal(state.end, 1);
    assert.throws(() => api.validate(request([
        call("media.import", { path: "C:/media/clip.mp4" }, "footage"),
        call("comp.inspect", { comp: { ref: "footage" } })
    ])), /earlier comp result/);
});
test("import checks file availability and sequence flags without leaking undo groups", () => {
    const { api, run, state } = host();
    assert.throws(() => api.validate(request([call("media.import", { path: "relative.mp4" })])), /absolute/);
    assert.throws(() => api.validate(request([call("media.import", { path: "C:/media/clip.mp4", forceAlphabetical: true })])), /sequence/);
    assert.throws(() => run("media.import", { path: "C:/media/missing.mp4" }), /does not exist/);
    assert.equal(state.imported.length, 0); assert.equal(state.begin, state.end);
    run("media.import", { path: "C:/media/frames0001.png", sequence: true, forceAlphabetical: true });
    assert.equal(state.imported[0].sequence, true); assert.equal(state.imported[0].forceAlphabetical, true);
});
test("project import returns a folder, preserves current project and rejects self-import and sequence flags", () => {
    const { api, run, project, files, state } = host();
    files.add("c:/project/source.aep"); files.add("c:/project/source.aepx");
    assert.equal(run("media.import", { path: "C:/project/source.aep" }).type, "folder");
    assert.equal(run("media.import", { path: "C:/project/source.aepx" }).type, "folder");
    assert.equal(state.imported[0].importAs, 2);
    assert.equal(project.file.fsName, "C:/project/current.aep");
    assert.throws(() => run("media.import", { path: "C:/project/current.aep" }), /itself/);
    assert.throws(() => api.validate(request([call("media.import", { path: "C:/project/source.aep", sequence: true })])), /sequence/);
    state.canImport = false;
    assert.throws(() => run("media.import", { path: "C:/project/source.aep" }), /cannot be imported as a project/);
    assert.equal(state.imported.length, 2); assert.equal(state.begin, state.end);
});

test("media layers reject folders, ambiguous names, self-precomps and partial timing ranges", () => {
    const { api, run, project, folder, comp, nested, footage } = host();
    assert.throws(() => run("layer.media.add", { item: { id: folder.id } }), /Only footage/);
    assert.throws(() => run("layer.media.add", { item: { id: comp.id } }), /itself/);
    const originalNestedLayers = nested.numLayers;
    assert.throws(() => run("layer.media.add", { comp: { id: nested.id }, item: { id: comp.id } }), /indirect composition cycle/);
    assert.equal(nested.numLayers, originalNestedLayers);
    project.list.push({ id: 500, name: footage.name });
    assert.throws(() => run("layer.media.add", { item: { name: footage.name } }), /ambiguous/);
    assert.throws(() => api.validate(request([call("layer.media.add", { item: { id: footage.id }, inPoint: 1 })])), /together/);
    assert.equal(run("layer.media.add", { item: { id: footage.id } }).source.id, footage.id);
});
test("save current or new paths is explicit, refuses unrelated overwrite and skips undo", () => {
    const { run, project, files, state } = host();
    assert.equal(run("project.save", {}).path, "C:/project/current.aep");
    files.add("c:/project/other.aep");
    assert.throws(() => run("project.save", { path: "C:/project/other.aep" }), /overwrite:true/);
    assert.equal(state.saves, 1);
    assert.equal(run("project.save", { path: "C:/project/other.aep", overwrite: true }).saved, true);
    assert.equal(run("project.save", { path: "C:/project/new.aep" }).path, "C:/project/new.aep");
    assert.equal(state.begin, 0); assert.equal(state.end, 0);
    project.file = null; assert.throws(() => run("project.save", {}), /explicit args.path/);
    assert.throws(() => run("project.save", { path: "C:/missing/new.aep" }), /folder/);
    assert.throws(() => run("project.save", { path: "C:/project/wrong.mov" }), /\.aep/);
});
test("undo dispatch is isolated and exclusive tools reject a mixed plan before mutations", () => {
    const { api, run, state } = host();
    assert.equal(run("project.undo", {}).commandId, 16); assert.deepEqual(state.commands, [16]);
    for (const name of ["project.save", "project.undo", "render.start"]) {
        assert.throws(() => api.run(request([call("project.search", { query: "" }), call(name)])), /alone/);
    }
    assert.equal(state.begin, 0);
});
test("render queuing applies exact requested templates and returns actual queue index/path", () => {
    const { run, queue, state } = host();
    const result = run("render.queue.add", { outputPath: "C:/out/new.mov", renderTemplate: "Best Settings", outputTemplate: "Lossless" });
    assert.equal(result.queueIndex, 1); assert.equal(result.outputPath, "C:/out/new.mov");
    assert.equal(result.status, "QUEUED"); assert.equal(queue.entries[0].applied, "Best Settings");
    assert.equal(queue.entries[0].outputModule(1).applied, "Lossless"); assert.equal(state.begin, state.end);
});
test("bad templates or destination changes remove only the new queue item and surface failure", () => {
    const { run, queue, state } = host();
    run("render.queue.add", { outputPath: "C:/out/first.mov" });
    assert.throws(() => run("render.queue.add", { outputPath: "C:/out/bad.mov", outputTemplate: "Missing" }), /not installed/);
    assert.equal(queue.numItems, 1); assert.equal(state.removed, 1);
    state.changeDestination = true;
    assert.throws(() => run("render.queue.add", { outputPath: "C:/out/changed.mov" }), /changed the requested destination/);
    assert.equal(queue.numItems, 1); assert.equal(state.removed, 2); assert.equal(state.begin, state.end);
});
test("render collision checks cover files and numbered image sequences before queuing", () => {
    const { run, files, queue } = host();
    files.add("c:/out/existing.mov"); files.add("c:/out/frame0001.png"); files.add("c:/out/shot.v1.0001.png");
    assert.throws(() => run("render.queue.add", { outputPath: "C:/out/existing.mov" }), /overwrite:true/);
    assert.throws(() => run("render.queue.add", { outputPath: "C:/out/frame[####].png", outputTemplate: "PNG Sequence" }), /overwrite:true/);
    assert.throws(() => run("render.queue.add", { outputPath: "C:/out/shot.v1.[####].png", outputTemplate: "PNG Sequence" }), /overwrite:true/);
    assert.equal(queue.numItems, 0);
    assert.equal(run("render.queue.add", { outputPath: "C:/out/existing.mov", overwrite: true }).overwriteAuthorized, true);
});
test("queued outputs cannot overwrite each other, including concrete frames within a sequence", () => {
    const { run, queue, state } = host();
    run("render.queue.add", { outputPath: "C:/out/new.mov" });
    assert.throws(() => run("render.queue.add", { outputPath: "C:/out/new.mov", overwrite: true }), /conflicts/);
    run("render.queue.add", { outputPath: "C:/out/other.mov" });
    queue.entries[1].outputModule(1).file = queue.entries[0].outputModule(1).file;
    assert.throws(() => run("render.start", {}), /destinations conflict/); assert.equal(state.renders, 0);
    const sequence = host();
    sequence.run("render.queue.add", { outputPath: "C:/out/shot.v1.[####].png" });
    assert.throws(() => sequence.run("render.queue.add", { outputPath: "C:/out/shot.v1.0001.png" }), /conflicts/);
    assert.throws(() => sequence.run("render.queue.add", { outputPath: "C:/out/shot.v1.[#####].png" }), /conflicts/);
    assert.equal(sequence.run("render.queue.add", { outputPath: "C:/out/another.[####].png" }).queueIndex, 2);
});
test("render starts once, validates existing outputs, and reports definitive DONE states without undo", () => {
    const { run, state, files } = host();
    assert.throws(() => run("render.start", {}), /no enabled/);
    run("render.queue.add", { outputPath: "C:/out/new.mov" });
    const undoBefore = state.begin;
    const result = run("render.start", {});
    assert.equal(result.completed, true); assert.equal(result.items[0].status, "DONE");
    assert.equal(result.items[0].queueIndex, 1); assert.equal(state.renders, 1); assert.equal(state.begin, undoBefore);
    const other = host(); other.files.add("c:/out/approved.mov");
    other.run("render.queue.add", { outputPath: "C:/out/approved.mov", overwrite: true });
    assert.equal(other.run("render.start", {}).completed, true);
    files.add("c:/out/new.mov");
});
test("render rejects output races, stopped queues, native render errors and active rendering", () => {
    const { run, queue, files, state, statuses } = host();
    run("render.queue.add", { outputPath: "C:/out/race.mov" }); files.add("c:/out/race.mov");
    assert.throws(() => run("render.start", {}), /without overwrite/); assert.equal(state.renders, 0);
    files.delete("c:/out/race.mov"); state.finalStatus = statuses.USER_STOPPED;
    assert.throws(() => run("render.start", {}), /native final states.*USER_STOPPED/); assert.equal(state.renders, 1);
    queue.entries[0].status = statuses.QUEUED; state.finalStatus = statuses.ERR_STOPPED; state.renderThrow = true;
    assert.throws(() => run("render.start", {}), /render failure.*ERR_STOPPED/); assert.equal(state.renders, 2);
    queue.rendering = true; assert.throws(() => run("render.start", {}), /already rendering/); assert.equal(state.renders, 2);
});
console.log(passed + "/" + passed + " project/media/render fixture tests passed; no real AE actions.");
