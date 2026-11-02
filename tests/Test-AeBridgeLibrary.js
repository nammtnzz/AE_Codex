/* Node regression harness: mocked AE, ScriptUI, scheduling, and file storage. */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workspace = path.resolve(__dirname, "..");
const aeWorkspace = "C:/Users/nguye/AE_Codex";
const bridgePath = aeWorkspace + "/jsx/Codex Bridge.jsx";
const realSourceCache = new Map();
const stagedLibrarySource = process.argv.includes("--staged-library") ? fs.readFileSync(path.join(workspace, "jsx", "Codex Library.jsx"), "utf8") : null;

function immutableRealSource(local) {
    if (!local) { return null; }
    const cacheKey = local.toLowerCase();
    if (realSourceCache.has(cacheKey)) { return realSourceCache.get(cacheKey); }
    if (!fs.existsSync(local)) { return null; }
    const stat = fs.statSync(local);
    if (!stat.isFile()) { return null; }
    const bytes = fs.readFileSync(local), text = bytes.toString("utf8");
    const entry = { text, binary: bytes.toString("latin1"), byteLength: bytes.length, modified: stat.mtimeMs };
    realSourceCache.set(cacheKey, entry);
    return entry;
}

function mockHost(options = {}) {
    const files = new Map();
    const folders = new Set(["c:/", "c:/users", "c:/users/nguye", aeWorkspace.toLowerCase(), (aeWorkspace + "/jsx").toLowerCase()]);
    const scheduled = new Map();
    const cancelled = [];
    const writes = [];
    const systemCalls = [];
    const launcherCalls = [];
    const sfxRequests = [];
    const createdWindows = [];
    let nextTaskId = 1;
    let executionCount = 0;
    let publicationFailures = 0;
    let now = 1700000000000;
    let context;

    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }

    function normalize(input) {
        return String(input).replace(/\\/g, "/").replace(/\/$/, "");
    }
    function key(input) { return normalize(input).toLowerCase(); }
    function sourcePath(input) {
        const normalized = normalize(input);
        if (normalized.toLowerCase().startsWith((aeWorkspace + "/jsx/").toLowerCase())) {
            return path.join(workspace, "jsx", normalized.slice((aeWorkspace + "/jsx/").length));
        }
        return null;
    }
    function isRealSource(input) {
        return !!immutableRealSource(sourcePath(input));
    }
    function textAt(input) {
        const entry = files.get(key(input)) || immutableRealSource(sourcePath(input));
        return entry ? entry.text : "";
    }
    function put(input, text) {
        const normalized = normalize(input), contents = String(text), bytes = Buffer.from(contents, "utf8");
        files.set(key(normalized), { path: normalized, text: contents, binary: bytes.toString("latin1"), byteLength: bytes.length, modified: now });
    }

    function File(input) {
        if (!(this instanceof File)) { return new File(input); }
        this.fsName = normalize(input);
        this.fullName = this.fsName;
        this.absoluteURI = this.fsName;
        this.encoding = "UTF-8";
        this.alias = false;
        this.error = "";
        this.opened = false;
        this.cursor = 0;
        this.buffer = "";
    }
    Object.defineProperties(File.prototype, {
        name: { get() { return this.fsName.slice(this.fsName.lastIndexOf("/") + 1); } },
        parent: { get() { return new Folder(this.fsName.slice(0, this.fsName.lastIndexOf("/"))); } },
        exists: { get() { return files.has(key(this.fsName)) || isRealSource(this.fsName); } },
        length: { get() {
            const entry = files.get(key(this.fsName)) || immutableRealSource(sourcePath(this.fsName));
            return entry ? entry.byteLength : 0;
        } },
        modified: { get() {
            const entry = files.get(key(this.fsName)) || immutableRealSource(sourcePath(this.fsName));
            return new Date(entry ? entry.modified : 0);
        } },
        eof: { get() { return this.cursor >= this.buffer.length; } }
    });
    File.prototype.open = function (mode) {
        if (mode === "r" && !this.exists) { this.error = "mock missing file"; return false; }
        this.mode = mode;
        this.opened = true;
        this.cursor = 0;
        const entry = mode === "r" || mode === "a" ? files.get(key(this.fsName)) || immutableRealSource(sourcePath(this.fsName)) : null;
        this.buffer = entry ? (this.encoding === "BINARY" ? entry.binary : entry.text) : "";
        if (mode === "a") { this.cursor = this.buffer.length; }
        return true;
    };
    File.prototype.read = function (length) {
        const result = this.buffer.slice(this.cursor, length === undefined ? undefined : this.cursor + length);
        this.cursor += result.length; return result;
    };
    File.prototype.seek = function (offset, mode) {
        this.cursor = (mode === 1 ? this.cursor : mode === 2 ? this.buffer.length : 0) + offset;
        return this.cursor >= 0 && this.cursor <= this.buffer.length;
    };
    File.prototype.readln = function () {
        const end = this.buffer.indexOf("\n", this.cursor);
        const result = this.buffer.slice(this.cursor, end === -1 ? undefined : end).replace(/\r$/, "");
        this.cursor = end === -1 ? this.buffer.length : end + 1;
        return result;
    };
    File.prototype.write = function (text) { this.buffer += String(text); return true; };
    File.prototype.writeln = function (text) { this.buffer += String(text) + "\n"; return true; };
    File.prototype.close = function () {
        if (this.opened && this.mode !== "r") {
            put(this.fsName, this.buffer);
            writes.push(this.fsName);
        }
        this.opened = false;
        return true;
    };
    File.prototype.remove = function () { return files.delete(key(this.fsName)); };
    File.prototype.rename = function (name) {
        const destination = this.parent.fsName + "/" + name;
        if (/^status-.*\.json$/.test(name) && publicationFailures > 0) {
            publicationFailures -= 1;
            this.error = "mock status rename failure";
            return false;
        }
        if (!files.has(key(this.fsName)) || files.has(key(destination))) {
            this.error = "mock missing source or occupied destination";
            return false;
        }
        const entry = files.get(key(this.fsName));
        files.delete(key(this.fsName));
        put(destination, entry.text);
        this.fsName = destination;
        this.fullName = destination;
        this.absoluteURI = destination;
        if (/\/requests\/pending-launch\.json$/i.test(destination)) { receiveSfxRequest(); }
        return true;
    };
    File.prototype.execute = function () {
        launcherCalls.push(this.fsName);
        throw new Error("AE must never execute a file or open an execution-warning dialog");
    };
    function receiveSfxRequest() {
        const pointer = JSON.parse(textAt(aeWorkspace + "/.ae-codex/library/requests/pending-launch.json"));
        const request = JSON.parse(textAt(aeWorkspace + "/.ae-codex/library/requests/sfx-" + pointer.requestId + ".json"));
        assert.equal(pointer.sessionId, request.sessionId);
        sfxRequests.push(request);
        if (options.launchAck !== false) {
            const acknowledgement = Object.assign({schemaVersion: 1, requestId: request.requestId, sessionId: request.sessionId, state: "launched", processId: 1234}, typeof options.launchAck === "object" ? options.launchAck : {});
            const contents = typeof options.launchAck === "string" ? options.launchAck : JSON.stringify(acknowledgement);
            put(aeWorkspace + "/.ae-codex/library/requests/launch-sfx-" + request.requestId + ".json", contents);
        }
    }
    File.prototype.toString = function () { return this.fsName; };

    function Folder(input) {
        if (!(this instanceof Folder)) { return new Folder(input); }
        this.fsName = normalize(input);
        this.fullName = this.fsName;
        this.absoluteURI = this.fsName;
        this.alias = false;
        this.error = "";
    }
    Object.defineProperties(Folder.prototype, {
        name: { get() { return this.fsName.slice(this.fsName.lastIndexOf("/") + 1); } },
        parent: { get() { return new Folder(this.fsName.slice(0, this.fsName.lastIndexOf("/"))); } },
        exists: { get() { return folders.has(key(this.fsName)); } }
    });
    Folder.prototype.create = function () { folders.add(key(this.fsName)); return true; };
    Folder.prototype.getFiles = function (filter) {
        const prefix = key(this.fsName) + "/";
        const children = [];
        for (const entry of files.values()) {
            const relative = key(entry.path).slice(prefix.length);
            if (key(entry.path).startsWith(prefix) && relative && !relative.includes("/")) { children.push(new File(entry.path)); }
        }
        for (const entry of folders) {
            const relative = entry.slice(prefix.length);
            if (entry.startsWith(prefix) && relative && !relative.includes("/")) { children.push(new Folder(entry)); }
        }
        return typeof filter === "function" ? children.filter(filter) : children;
    };
    Folder.prototype.toString = function () { return this.fsName; };
    Folder.current = new Folder(aeWorkspace);
    Folder.userData = new Folder("C:/Users/nguye/AppData/Roaming");
    Folder.myDocuments = new Folder("C:/Users/nguye/Documents");
    Folder.appData = new Folder("C:/ProgramData");

    function control(type, title) {
        return {
            type, text: title || "", value: 0, children: [], visible: true,
            layout: { layout() {}, resize() {} },
            graphics: { PenType: { SOLID_COLOR: 1 }, newPen() { return {}; } },
            add(kind, bounds, value, creationProperties) {
                const child = control(kind, value);
                child.parent = this;
                child.creationProperties = creationProperties || {};
                this.children.push(child);
                return child;
            },
            remove(child) { const index = this.children.indexOf(child); if (index >= 0) { this.children.splice(index, 1); } },
            show() {}, update() {}, center() {}
        };
    }
    function Window(kind, title) {
        Object.assign(this, control(kind, title));
        this.close = function () { if (this.onClose && this.onClose() === false) { return false; } this.closed = true; this.visible = false; return true; };
        createdWindows.push(this);
    }
    function Panel() { Object.assign(this, control("panel")); }
    function CompItem() {}
    function FootageItem() {}
    function denyMutation() { throw new Error("Project mutation is forbidden during library inventory"); }

    const app = {
        version: "26.5-test", path: new Folder("C:/Program Files/Adobe/Adobe After Effects 2026/Support Files"),
        effects: [
            { displayName: "Mock Glow", matchName: "Mock Glow", category: "Test", version: "1.0" },
            { displayName: "Trailing matchName", matchName: "Enhance AI ", category: "Test", version: "1.0" }
        ],
        project: options.project === undefined ? {
            numItems: 0, file: null, activeItem: null, item() { return null; },
            items: { addComp: denyMutation, addFolder: denyMutation },
            importFile: denyMutation, save: denyMutation, close: denyMutation
        } : options.project,
        preferences: { getPrefAsLong() { return 1; } },
        beginUndoGroup: denyMutation, endUndoGroup: denyMutation,
        scheduleTask(code, delay, repeat) {
            assert.equal(repeat, false, "bridge callbacks must remain one-shot");
            const id = nextTaskId++;
            scheduled.set(id, { code, delay });
            return id;
        },
        cancelTask(id) { cancelled.push(id); scheduled.delete(id); }
    };
    const dollar = {
        global: {}, fileName: bridgePath, os: "Windows", sleep() {},
        evalFile(file) {
            const normalized = normalize(file.fsName || file);
            if (/\/jsx\/test-job\.jsx$/i.test(normalized)) {
                executionCount += 1;
                return options.executeJob ? options.executeJob(dollar.global.__CODEX_AE_RUN_CONTEXT__) : "mock job completed";
            }
            const prior = dollar.fileName;
            dollar.fileName = normalized;
            try {
                return vm.runInContext(textAt(normalized).replace(/^#.*$/gm, ""), context, { filename: normalized });
            } finally { dollar.fileName = prior; }
        }
    };
    context = vm.createContext({
        app, $: dollar, File, Folder, Window, Panel, CompItem, FootageItem,
        PropertyType: { PROPERTY: 1, INDEXED_GROUP: 2, NAMED_GROUP: 3 },
        PropertyValueType: { NO_VALUE: 0, CUSTOM_VALUE: 1, OneD: 2 },
        ScriptUI: { newFont() { return {}; } }, Date: ClockDate,
        system: {
            callSystem(command) {
                systemCalls.push(command);
                throw new Error("Background inventory must never launch a console shell");
            }
        }, alert() {}, console
    });
    if (options.startupOnly) { dollar.global.__CODEX_AE_AUTOSTART_ONLY__ = true; }
    try { vm.runInContext(textAt(bridgePath).replace(/^#.*$/gm, ""), context, { filename: bridgePath }); }
    finally { delete dollar.global.__CODEX_AE_AUTOSTART_ONLY__; }
    // Most inventory/decoder tests own connection setup explicitly. The opening
    // behavior is exercised separately without disabling production autostart.
    if (!options.keepAutoStart) { dollar.global.__codexAeBridgeV1.stop(); }
    if (stagedLibrarySource) {
        const bundle = dollar.global.__codexAeBundleV1, run = bundle.run;
        bundle.run = function (name) {
            if (name === "Codex Library.jsx") { return vm.runInContext(stagedLibrarySource.replace(/^#.*$/gm, ""), context, {filename: "staged Codex Library.jsx"}); }
            return run.call(this, name);
        };
    }

    function fireNext() {
        const first = scheduled.entries().next().value;
        if (!first) { throw new Error("No scheduled bridge callback"); }
        const [id, task] = first;
        scheduled.delete(id);
        now += task.delay;
        vm.runInContext(task.code, context);
        return task;
    }
    function connect() {
        const bridge = dollar.global.__codexAeBridgeV1;
        bridge.start();
        for (let i = 0; !bridge.ready && bridge.running && i < 300; i++) { fireNext(); }
        assert.equal(bridge.ready, true, bridge.lastStatus);
        return bridge;
    }
    function job(runId = "test-run-0001", nonce) {
        const bridge = dollar.global.__codexAeBridgeV1;
        const jobPath = bridge.inboxPath + "/job-" + runId + ".job";
        put(aeWorkspace + "/jsx/test-job.jsx", "/* mock */");
        put(jobPath, "schema=codex-ae-job/v1\nrunId=" + runId + "\nsessionNonce=" + (nonce || bridge.sessionNonce) + "\nscript=jsx/test-job.jsx\n");
        return new File(jobPath);
    }
    return {
        context, app, dollar, files, folders, writes, systemCalls, launcherCalls, sfxRequests, createdWindows, scheduled, cancelled, File, Folder, CompItem, FootageItem, put, textAt,
        connect, fireNext, job,
        bridge: dollar.global.__codexAeBridgeV1,
        advanceTime(milliseconds) { now += milliseconds; },
        get executionCount() { return executionCount; },
        failPublication(count) { publicationFailures = count; }
    };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

function enableSfxLauncher(host) {
    host.put(aeWorkspace + "/.ae-codex/library/config.json", JSON.stringify({ schemaVersion: 1, sfx: { enabled: true, roots: ["D:/SFX"] } }));
    host.put(aeWorkspace + "/.ae-codex/library/runtime.json", JSON.stringify({ schemaVersion: 1, backgroundServiceVersion: 1, powerShellPath: "C:/Program Files/PowerShell/7/pwsh.exe", backgroundLauncherPath: aeWorkspace + "/tools/Codex AE Background.exe" }));
    host.put("C:/Program Files/PowerShell/7/pwsh.exe", "mock executable");
    host.put(aeWorkspace + "/tools/Codex AE Background.exe", "mock GUI executable");
}

function directLibrary(host, launchSfx = false, scan = true) {
    host.bridge.running = true;
    host.bridge.generation += 1;
    if (launchSfx) { enableSfxLauncher(host); }
    if (stagedLibrarySource) { vm.runInContext(stagedLibrarySource.replace(/^#.*$/gm, ""), host.context, {filename: "staged Codex Library.jsx"}); }
    else { host.dollar.global.__codexAeBundleV1.run("Codex Library.jsx"); }
    const library = host.dollar.global.__codexAeLibraryFactoryV1(host.bridge);
    library.begin(host.bridge.generation);
    // Legacy scan/transport fixtures explicitly request their work. New manual
    // scheduling tests use scan=false and advance only through library.tick().
    if (scan && !library.configurationError) { assert.equal(library.requestRefresh(), true); library.refresh(); }
    return library;
}

function successfulSfxStatus(host, library, overrides = {}) {
    const prefix = ".ae-codex/library/sessions/" + host.bridge.sessionNonce + "/";
    return Object.assign({
        schemaVersion: 1, kind: "disk-sfx", requestId: library.requestId, sessionId: host.bridge.sessionNonce,
        state: "success", count: 12,
        catalogRelativePath: prefix + "sfx-" + library.requestId + ".jsonl",
        summaryRelativePath: prefix + "summary-sfx-" + library.requestId + ".json",
        warnings: []
    }, overrides);
}

function putSfxStatus(host, library, status) {
    host.put(library.folder + "/status-sfx-" + library.requestId + ".json", typeof status === "string" ? status : JSON.stringify(status));
    host.advanceTime(1500);
}

function damageBundleByte(original, position) {
    const bytes = Buffer.from(original, "utf8");
    assert.ok(position >= 0 && position < bytes.length, "damage must target a real payload byte");
    assert.ok(bytes[position] < 128, "payload records must use ASCII URI encoding");
    bytes[position] = bytes[position] === 88 ? 89 : 88;
    return bytes.toString("utf8");
}

function moduleUsers(bundle) {
    const users = new Map();
    for (const name of bundle.names) {
        const ids = new Set(bundle.recipe(name).split("|").map(slice => slice.split(":")[0]));
        for (const id of ids) {
            if (!users.has(id)) { users.set(id, []); }
            users.get(id).push(name);
        }
    }
    return users;
}

function decodeInjectedModule(host, record) {
    const { checksum } = require("../tools/Build-AeScriptBundle.js");
    const bundle = host.bridge.bundle, id = Object.keys(bundle.modules)[0], entry = bundle.modules[id];
    const position = bundle.payloadOffset + entry.offset, originalRead = host.File.prototype.read;
    const original = { length: entry.length, checksum: entry.checksum,
        moduleCache: bundle.moduleCache, cacheOrder: bundle.cacheOrder, cacheSize: bundle.cacheSize };
    entry.length = record.length;
    entry.checksum = checksum(record);
    bundle.moduleCache = {}; bundle.cacheOrder = []; bundle.cacheSize = 0;
    host.File.prototype.read = function (length) {
        if (this.fsName === bridgePath && this.cursor === position && length === record.length) {
            this.cursor += record.length;
            return record;
        }
        return originalRead.call(this, length);
    };
    try { return bundle.moduleSource(id); }
    finally {
        host.File.prototype.read = originalRead;
        entry.length = original.length; entry.checksum = original.checksum;
        bundle.moduleCache = original.moduleCache; bundle.cacheOrder = original.cacheOrder; bundle.cacheSize = original.cacheSize;
    }
}

test("opening panel automatically connects without a Start click", () => {
    const host = mockHost({ keepAutoStart: true });
    const bridge = host.bridge;
    assert.equal(bridge.running, true);
    assert.equal(host.scheduled.size, 1, "opening schedules one connection task");
    for (let i = 0; !bridge.ready && bridge.running && i < 300; i++) { host.fireNext(); }
    assert.equal(bridge.ready, true, bridge.lastStatus);
    assert.equal(bridge.connectionConnected, true);
    assert.equal(host.scheduled.size, 1, "one timer must own the connected listener");
    assert.ok(bridge.logs.length > 0, "connection progress must appear in the panel log");
    assert.equal(host.executionCount, 0);
});

test("Stop cancels autoconnect and stays stopped until explicitly reconnected", () => {
    const host = mockHost({ keepAutoStart: true });
    const bridge = host.bridge, delivered = host.scheduled.values().next().value.code;
    bridge.stop();
    host.advanceTime(300000);
    vm.runInContext(delivered, host.context);
    assert.equal(bridge.running, false);
    assert.equal(bridge.ready, false);
    assert.equal(host.scheduled.size, 0, "a stopped panel cannot reconnect itself");
    assert.equal(JSON.parse(host.textAt(bridge.heartbeatPath)).state, "stopped");
});

test("reopening and repeated reconnects keep only one listener timer", () => {
    const host = mockHost({ keepAutoStart: true });
    for (let attempt = 0; attempt < 3; attempt++) {
        host.dollar.evalFile(new host.File(bridgePath));
        assert.equal(host.bridge.running, true);
        assert.equal(host.scheduled.size, 1, "reopening must replace the previous task");
        host.bridge.start();
        assert.equal(host.scheduled.size, 1, "reconnect must replace the previous task");
    }
    const bridge = host.bridge;
    for (let i = 0; !bridge.ready && bridge.running && i < 300; i++) { host.fireNext(); }
    assert.equal(bridge.ready, true, bridge.lastStatus);
    assert.equal(host.scheduled.size, 1);
});
test("fifty repeated tools-only loaders preserve one palette listener and manual Stop", () => {
    const host=mockHost({keepAutoStart:true}),latest=fs.readFileSync(path.join(workspace,"source/bridge.js"),"utf8").replace(/^#.*$/gm,"");
    vm.runInContext(latest,host.context);
    const bridge=host.dollar.global.__codexAeBridgeV1,window=bridge.window,ui=bridge.ui,
        windows=host.createdWindows.length,generation=bridge.generation,task=bridge.taskId,writes=host.writes.length;
    for(let i=0;i<50;i++)vm.runInContext(latest,host.context);
    assert.equal(host.createdWindows.length,windows);assert.equal(bridge.window,window);assert.equal(bridge.ui,ui);
    assert.equal(bridge.generation,generation);assert.equal(bridge.taskId,task);assert.equal(host.scheduled.size,1);
    assert.equal(host.writes.length,writes);assert.equal(bridge.chat,undefined);
    bridge.stop();const stopped=bridge.generation;
    for(let i=0;i<50;i++)vm.runInContext(latest,host.context);
    assert.equal(bridge.running,false);assert.equal(bridge.generation,stopped);assert.equal(host.scheduled.size,0);assert.equal(host.createdWindows.length,windows);
});
test("tools-only dock replacement removes only owned controls without closing an AE Panel", () => {
    const host=mockHost({keepAutoStart:true}),latest=fs.readFileSync(path.join(workspace,"source/bridge.js"),"utf8").replace(/^#.*$/gm,"");
    const first=new host.context.Panel();first.close=()=>{throw Error("AE owns this Panel");};
    host.dollar.global.__CODEX_AE_PANEL_HOST__=first;vm.runInContext(latest,host.context);
    const bridge=host.dollar.global.__codexAeBridgeV1,owned=Array.from(bridge.ownedUiRoots),foreign=first.add("group",undefined,"Other owner"),count=first.children.length;
    for(let i=0;i<50;i++)vm.runInContext(latest,host.context);
    assert.equal(first.children.length,count);
    const second=new host.context.Panel();second.close=()=>{throw Error("AE owns this Panel");};
    host.dollar.global.__CODEX_AE_PANEL_HOST__=second;
    try{vm.runInContext(latest,host.context);}finally{delete host.dollar.global.__CODEX_AE_PANEL_HOST__;}
    assert.equal(bridge.window,second);assert.deepEqual(first.children,[foreign]);assert.ok(owned.every(root=>!first.children.includes(root)));
    assert.equal(host.scheduled.size,1);assert.equal(bridge.chat,undefined);
});
test("upgrading an idle legacy chat controller stops it once releases resources and never copies or replays chat state", () => {
    const host=mockHost(),old=host.bridge,originalStop=old.stop;let stops=0,listeners=0;
    const legacy={ui:{nativeListeners:[{control:{removeEventListener(){listeners++;}},type:"click",handler(){}}]},
        state:{activeThreadId:"private-old-thread"},pending:{id:"never-replay",action:"send"},previewCache:{old:{image:{}}},transcriptCommands:[{image:{}}]};
    old.chat=legacy;old.version="old-chat-version";
    old.stop=function(){stops++;legacy.stopped=true;originalStop.call(old);};
    const writes=host.writes.length,latest=fs.readFileSync(path.join(workspace,"source/bridge.js"),"utf8").replace(/^#.*$/gm,"");
    vm.runInContext(latest,host.context);
    const bridge=host.dollar.global.__codexAeBridgeV1;
    assert.notEqual(bridge,old);assert.equal(stops,1);assert.equal(listeners,1);assert.equal(legacy.stopped,true);
    assert.equal(legacy.ui,null);assert.equal(legacy.state,null);assert.equal(legacy.pending,null);assert.equal(Object.keys(legacy.previewCache).length,0);
    assert.equal(legacy.transcriptCommands.length,0);assert.equal(old.chat,null);assert.equal(bridge.chat,undefined);
    assert.equal(host.writes.slice(writes).some(entry=>/\/chat\//i.test(entry.path||entry.file||"")),false);assert.equal(host.scheduled.size,1);
});

test("connection failures are recorded in the panel log", () => {
    const host = mockHost({ keepAutoStart: true });
    host.folders.delete(aeWorkspace.toLowerCase());
    host.fireNext();
    assert.equal(host.bridge.running, false);
    assert.equal(host.bridge.ready, false);
    assert.equal(host.scheduled.size, 0);
    assert.ok(host.bridge.logs.some(entry => entry.level === "error" && /workspace/i.test(entry.message)));
    assert.match(host.bridge.logSummary.text, /workspace/i);
});

test("startup loader connects quietly once and respects a manually stopped session", () => {
    const host = mockHost({ keepAutoStart: true, startupOnly: true }), bridge = host.bridge;
    assert.equal(host.createdWindows.length, 0, "startup loader cannot create a floating panel");
    assert.equal(bridge.running, true);
    assert.equal(host.scheduled.size, 1);
    for (let i = 0; !bridge.ready && bridge.running && i < 300; i++) { host.fireNext(); }
    assert.equal(bridge.ready, true, bridge.lastStatus);
    function runLoader() {
        host.dollar.global.__CODEX_AE_AUTOSTART_ONLY__ = true;
        try { host.dollar.evalFile(new host.File(bridgePath)); }
        finally { delete host.dollar.global.__CODEX_AE_AUTOSTART_ONLY__; }
    }
    const currentTask = bridge.taskId;
    runLoader(); runLoader();
    assert.equal(host.scheduled.size, 1);
    assert.equal(bridge.taskId, currentTask, "repeated startup loader leaves the live listener alone");
    assert.equal(host.createdWindows.length, 0);
    bridge.stop();
    runLoader();
    assert.equal(bridge.running, false, "startup loader must preserve the user's Stop choice");
    assert.equal(host.scheduled.size, 0);
    host.dollar.evalFile(new host.File(bridgePath));
    assert.equal(bridge.running, true, "opening the panel intentionally reconnects");
    assert.equal(host.scheduled.size, 1);
    assert.equal(host.createdWindows.length, 1);
});

test("Stop and Start invalidate already-delivered callbacks", () => {
    const host = mockHost();
    host.bridge.start();
    const oldGeneration = host.bridge.generation;
    const oldTask = host.scheduled.values().next().value.code;
    host.bridge.stop();
    host.bridge.start();
    const currentTask = host.bridge.taskId;
    const writesBefore = host.writes.length;
    vm.runInContext(oldTask, host.context);
    assert.equal(host.bridge.taskId, currentTask, "old callbacks cannot clear new task ownership");
    assert.equal(host.writes.length, writesBefore, "old callbacks cannot publish inventory or heartbeat");
    assert.ok(host.bridge.generation > oldGeneration);
    host.bridge.stop();
    assert.equal(host.scheduled.size, 0);
});

test("JSX evaluation executes once when terminal publication retries", () => {
    const host = mockHost();
    const bridge = host.connect();
    host.failPublication(4);
    bridge.processJob(host.job());
    assert.equal(host.executionCount, 1);
    assert.ok(bridge.pendingReport);
    assert.equal(bridge.busy, true);
    assert.ok(bridge.logs.some(entry => entry.runId === "test-run-0001" &&
        /publish|report|retry/i.test(entry.message)), "publication failure must be visible in the work log");
    bridge.stop();
    host.connect();
    bridge.publishPendingReport();
    assert.equal(host.executionCount, 1, "restart must not evaluate a completed job again");
    assert.equal(bridge.pendingReport, null);
    const started = JSON.parse(host.textAt(bridge.resultsPath + "/started-test-run-0001.json"));
    const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-test-run-0001.json"));
    assert.equal(started.state, "running");
    assert.equal(status.state, "success");
    assert.equal(status.completionKnown, true);
});

test("work log shows script progress, messages and successful completion", () => {
    const host = mockHost({ executeJob(runContext) {
        assert.equal(typeof runContext.progress, "function");
        assert.equal(typeof runContext.log, "function");
        runContext.progress(35, "Preparing requested layers");
        runContext.log("Layer setup finished", "info");
        return "mock progress result";
    } });
    const bridge = host.connect(), runId = "progress-run-0001";
    bridge.window.size = { width: 440, height: 430 }; bridge.ui.logExpanded = true; bridge.reflowUi(true);
    bridge.processJob(host.job(runId));
    const entries = bridge.logs.filter(entry => entry.runId === runId);
    assert.ok(entries.some(entry => /Preparing requested layers/.test(entry.message)));
    assert.ok(entries.some(entry => /Layer setup finished/.test(entry.message)));
    assert.ok(entries.some(entry => /success|completed/i.test(entry.message)), "successful completion needs a log entry");
    assert.ok(entries.every(entry => entry.time && entry.level && typeof entry.message === "string"));
    assert.ok(bridge.logView.text.includes("Preparing requested layers"), "panel must render work progress");
    assert.equal(host.dollar.global.__CODEX_AE_RUN_CONTEXT__, undefined, "run hooks cannot leak into the next script");
    const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-" + runId + ".json"));
    assert.equal(status.state, "success");
    assert.equal(status.result, "mock progress result");
});

test("script errors remain visible in the work log and terminal status", () => {
    const host = mockHost({ executeJob() { throw new Error("mock requested edit failed"); } });
    const bridge = host.connect(), runId = "error-run-0001";
    bridge.window.size = { width: 440, height: 430 }; bridge.ui.logExpanded = true; bridge.reflowUi(true);
    bridge.processJob(host.job(runId));
    assert.equal(host.executionCount, 1);
    assert.ok(bridge.logs.some(entry => entry.runId === runId && entry.level === "error" &&
        /mock requested edit failed/.test(entry.message)));
    assert.ok(bridge.logView.text.includes("mock requested edit failed"));
    assert.equal(host.dollar.global.__CODEX_AE_RUN_CONTEXT__, undefined);
    const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-" + runId + ".json"));
    assert.equal(status.state, "error");
    assert.equal(status.errorCode, "JSX_EXECUTION_FAILED");
    assert.match(status.message, /mock requested edit failed/);
});

test("panel log is readonly and bounded during long sessions", () => {
    const host = mockHost(), bridge = host.bridge;
    bridge.window.size = { width: 440, height: 430 }; bridge.ui.logExpanded = true; bridge.reflowUi(true);
    assert.equal(bridge.logView.type, "edittext");
    assert.equal(bridge.logView.creationProperties.readonly, true);
    assert.equal(bridge.logView.creationProperties.multiline, true);
    for (let index = 0; index < 260; index++) { bridge.appendLog("info", "bounded-message-" + index, "bounded-run-0001"); }
    assert.equal(bridge.logs.length, 200);
    assert.equal(bridge.logs[0].message, "bounded-message-60");
    assert.equal(bridge.logs[199].message, "bounded-message-259");
    assert.equal(bridge.logView.text.includes("bounded-message-0\n"), false);
    assert.ok(bridge.logView.text.includes("bounded-message-259"));
});

test("disk log appends complete JSON lines while preserving earlier events", () => {
    const host = mockHost(), bridge = host.bridge;
    const logPath = bridge.bridgeRoot + "/logs/events.log";
    const original = host.textAt(logPath);
    const message = 'Tiếng Việt "quoted"\nsecond line';
    bridge.appendLog("info", message, "persist-run-0001", 40);
    bridge.appendLog("warning", "Following event", "persist-run-0001");
    const contents = host.textAt(logPath);
    assert.ok(contents.startsWith(original), "append mode must preserve all earlier persisted events");
    const entries = contents.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries.at(-2).message, message);
    assert.equal(entries.at(-2).runId, "persist-run-0001");
    assert.equal(entries.at(-2).percent, 40);
    assert.equal(entries.at(-1).message, "Following event");
    assert.equal(entries.at(-1).level, "warning");
    assert.equal(bridge.logWriteError, "");
});

test("disk log rotates at its size limit and retains the previous log", () => {
    const host = mockHost(), bridge = host.bridge;
    const logPath = bridge.bridgeRoot + "/logs/events.log", previousPath = bridge.bridgeRoot + "/logs/previous.log";
    const fullLog = "retained previous session\n".padEnd(262144, "x");
    host.put(logPath, fullLog);
    host.put(previousPath, "older rotation");
    bridge.appendLog("info", "First event after rotation", "rotate-run-0001");
    assert.equal(host.textAt(previousPath), fullLog, "rotation must retain the old active log exactly");
    const rows = host.textAt(logPath).trim().split("\n");
    assert.equal(rows.length, 1, "the current log starts fresh after rotation");
    assert.equal(JSON.parse(rows[0]).message, "First event after rotation");
    bridge.appendLog("info", "Second event after rotation", "rotate-run-0001");
    assert.equal(host.textAt(previousPath), fullLog);
    assert.equal(host.textAt(logPath).trim().split("\n").length, 2);
});

test("disk logging exceptions cannot change job execution or result publication", () => {
    for (const failure of ["open", "write"]) {
        const host = mockHost(), bridge = host.connect(), runId = "log-" + failure + "-run-0001";
        const normalOpen = host.File.prototype.open, normalWrite = host.File.prototype.write;
        host.File.prototype.open = function (mode) {
            if (failure === "open" && /\/logs\/events\.log$/.test(this.fsName)) { throw new Error("mock log open failure"); }
            return normalOpen.call(this, mode);
        };
        host.File.prototype.write = function (contents) {
            if (failure === "write" && /\/logs\/events\.log$/.test(this.fsName)) { throw new Error("mock log write failure"); }
            return normalWrite.call(this, contents);
        };
        host.failPublication(4);
        bridge.processJob(host.job(runId));
        assert.equal(host.executionCount, 1);
        assert.ok(bridge.pendingReport, "result publication still follows its normal retry path");
        bridge.publishPendingReport();
        assert.equal(bridge.pendingReport, null);
        assert.equal(host.executionCount, 1, "logging errors cannot cause script reevaluation");
        const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-" + runId + ".json"));
        assert.equal(status.state, "success");
        assert.match(bridge.logWriteError, /mock log (?:open|write) failure/);
        assert.ok(bridge.logs.some(entry => entry.runId === runId && /completed|success/i.test(entry.message)),
            "memory log remains usable when disk logging fails");
    }
});

test("disposed log controls cannot interrupt a job or lose its result", () => {
    const host = mockHost(), bridge = host.connect(), runId = "disposed-log-run-0001";
    bridge.window.size = { width: 440, height: 430 }; bridge.ui.logExpanded = true; bridge.reflowUi(true);
    Object.defineProperty(bridge.logView, "text", {
        configurable: true, get() { throw new Error("mock disposed log control"); },
        set() { throw new Error("mock disposed log control"); }
    });
    bridge.processJob(host.job(runId));
    assert.equal(host.executionCount, 1);
    assert.equal(bridge.logView, null, "a disposed control must be detached from later log updates");
    assert.equal(bridge.pendingReport, null);
    const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-" + runId + ".json"));
    assert.equal(status.state, "success");
    assert.ok(bridge.logs.some(entry => entry.runId === runId && /completed|success/i.test(entry.message)));
    const persisted = host.textAt(bridge.bridgeRoot + "/logs/events.log").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(persisted.some(entry => entry.runId === runId));
});

test("immutable started and terminal status files are never overwritten", () => {
    const host = mockHost();
    const bridge = host.connect();
    bridge.processJob(host.job());
    const startedPath = bridge.resultsPath + "/started-test-run-0001.json";
    const statusPath = bridge.resultsPath + "/status-test-run-0001.json";
    const originalStarted = host.textAt(startedPath);
    const originalStatus = host.textAt(statusPath);
    assert.throws(() => bridge.writeStarted("test-run-0001", "replacement", 0), /immutable/i);
    assert.throws(() => bridge.writeStatus({ runId: "test-run-0001", state: "error" }), /immutable/i);
    assert.equal(host.textAt(startedPath), originalStarted);
    assert.equal(host.textAt(statusPath), originalStatus);
});

test("failed started preflight cannot evaluate project JSX", () => {
    const host = mockHost();
    const bridge = host.connect();
    const normalRename = host.File.prototype.rename;
    host.File.prototype.rename = function (name) {
        if (name === "started-preflight-run-0001.json") { this.error = "mock preflight publication failure"; return false; }
        return normalRename.call(this, name);
    };
    bridge.processJob(host.job("preflight-run-0001"));
    assert.equal(host.executionCount, 0);
    const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-preflight-run-0001.json"));
    assert.equal(status.errorCode, "START_STATUS_FAILED");
    assert.equal(status.completionKnown, true);
    assert.equal(status.retryable, true);
});

test("jobs belonging to another AE instance remain unclaimed", () => {
    const host = mockHost();
    const bridge = host.connect();
    const foreign = host.job("foreign-run-0001", "foreign-session-0001");
    bridge.processJob(foreign);
    assert.equal(foreign.exists, true);
    assert.equal(host.executionCount, 0);
    assert.equal(bridge.busy, false);
});

function seedLibraryCaches(host) {
    const sessionId = "cached-session-0001", requestId = "cached-request-0001";
    const prefix = ".ae-codex/library/sessions/" + sessionId + "/";
    const effects = { schema: "codex-ae-library/v1", state: "ready", sessionId, requestId,
        effectsCount: 924, appliedSchemaCount: 4, projectAudioCount: 24,
        effectsRelativePath: prefix + "effects-" + requestId + ".tsv",
        projectAudioRelativePath: prefix + "project-audio-" + requestId + ".json", timestampEpochMs: 1600000000000 };
    const sfx = { schemaVersion: 1, kind: "disk-sfx", sessionId, requestId, count: 14657,
        catalogRelativePath: prefix + "sfx-" + requestId + ".jsonl", completedUtc: "2020-09-13T12:26:40.000Z" };
    host.put(aeWorkspace + "/.ae-codex/library/current.json", JSON.stringify(effects));
    host.put(aeWorkspace + "/" + effects.effectsRelativePath, "AE_PLUGIN_CATALOG_V1\n");
    host.put(aeWorkspace + "/" + effects.projectAudioRelativePath, '{"items":[]}');
    host.put(aeWorkspace + "/.ae-codex/library/latest-sfx.json", JSON.stringify(sfx));
    host.put(aeWorkspace + "/" + sfx.catalogRelativePath, '{"path":"D:/SFX/Boing.wav"}\n');
    return { effects, sfx };
}

test("inventory regex literals escape slash character classes for the ExtendScript lexer", () => {
    const host = mockHost();
    const source = stagedLibrarySource || host.dollar.global.__codexAeBundleV1.source("Codex Library.jsx");
    // V8/Acorn accept an unescaped slash in a regular-expression character
    // class. AE's legacy ExtendScript lexer can terminate that literal early.
    // Keep this native-parser compatibility check in addition to ES3 parsing.
    assert.equal(source.includes("[^/]"), false);
    assert.ok(source.includes("[^\\/]"), "UNC matcher must escape the slash inside each negated class");
});

test("cache-only connect never traverses AE or scans after any idle interval", () => {
    const host = mockHost(); enableSfxLauncher(host);
    host.put(aeWorkspace + "/.ae-codex/library/config.json", JSON.stringify({schemaVersion: 1, refreshIntervalSeconds: 30, sfx: {enabled: true, roots: ["D:/SFX"]}}));
    Object.defineProperty(host.app, "effects", {get() { throw new Error("automatic effect traversal forbidden"); }});
    Object.defineProperty(host.app, "project", {get() { throw new Error("automatic project traversal forbidden"); }});
    const library = directLibrary(host, false, false);
    for (const delay of [120001, 3600001, 86400001]) { host.advanceTime(delay); library.tick(); }
    assert.equal(library.state.state, "ready");
    assert.equal(library.state.effectsState, "not-indexed");
    assert.equal(library.state.sfxState, "not-indexed");
    assert.equal(host.sfxRequests.length, 0);
    assert.equal(library.requestId, undefined);
    assert.match(library.describe(), /Chưa có dữ liệu/);
    assert.equal(library.heartbeat().manualRefresh, true);
});

test("manual requests are coalesced and only start after the bridge is idle", () => {
    const host = mockHost(); const library = directLibrary(host, true, false);
    assert.equal(library.requestRefresh(), true);
    assert.equal(library.requestRefresh(), false);
    assert.equal(host.sfxRequests.length, 0);
    host.bridge.busy = true; library.tick();
    assert.equal(library.refreshPending, true);
    assert.equal(host.sfxRequests.length, 0);
    host.bridge.busy = false; library.tick();
    assert.equal(host.sfxRequests.length, 1);
    assert.equal(library.refreshPending, false);
    assert.equal(library.requestRefresh(), false, "a running scan is not queued twice");
    putSfxStatus(host, library, successfulSfxStatus(host, library)); library.tick();
    host.advanceTime(3600000); library.tick();
    assert.equal(host.sfxRequests.length, 1);
});

test("library switches persist on this machine without scanning or changing roots", () => {
    const host = mockHost();
    const original = {schemaVersion: 1, refreshIntervalSeconds: 120, custom: {keep: "yes"}, sfx: {roots: ["D:/My SFX"], extensions: ["wav"], custom: 17}};
    host.put(aeWorkspace + "/.ae-codex/library/config.json", JSON.stringify(original));
    const library = directLibrary(host, false, false);
    assert.equal(library.getPreferences().sfxEnabled, true, "legacy explicit roots retain opt-in");
    library.setEnabled("effects", false); library.setEnabled("sfx", false); library.setEnabled("sfx", true);
    assert.equal(host.sfxRequests.length, 0);
    assert.equal(library.requestId, undefined);
    const saved = JSON.parse(host.textAt(library.root + "/config.json"));
    assert.deepEqual(saved.sfx.roots, original.sfx.roots);
    assert.deepEqual(saved.sfx.extensions, original.sfx.extensions);
    assert.deepEqual(saved.custom, original.custom);
    assert.equal(saved.sfx.custom, 17);
    assert.equal(saved.effects.enabled, false);
    assert.equal(saved.sfx.enabled, true);
    assert.equal(saved.refreshMode, "manual");
    library.stop(); const reconnected = directLibrary(host, false, false);
    assert.equal(reconnected.getPreferences().effectsEnabled, false);
    assert.equal(reconnected.getPreferences().sfxEnabled, true);
    assert.equal(host.sfxRequests.length, 0);
});

test("disabled groups never read effects project layers or launch SFX", () => {
    const host = mockHost();
    host.put(aeWorkspace + "/.ae-codex/library/config.json", JSON.stringify({schemaVersion: 1, effects: {enabled: false}, sfx: {enabled: false, roots: ["D:/SFX"]}}));
    const library = directLibrary(host, false, false);
    let reads = 0;
    Object.defineProperty(host.app, "effects", {get() { reads++; throw new Error("disabled effect traversal"); }});
    Object.defineProperty(host.app, "project", {get() { reads++; throw new Error("disabled project traversal"); }});
    assert.equal(library.requestRefresh(), false, "nothing enabled means no manual scan is queued"); library.tick();
    assert.equal(reads, 0);
    assert.equal(library.state.state, "ready");
    assert.equal(library.state.effectsState, "disabled");
    assert.equal(library.state.sfxState, "disabled");
    assert.equal(host.sfxRequests.length, 0);
    assert.equal(library.state.effectsRelativePath, undefined);
    assert.equal(library.state.projectAudioRelativePath, undefined);
    assert.equal(library.state.sfxRelativePath, undefined);
});

test("legacy snapshots reconnect without reading catalog bodies or inventing scan dates", () => {
    const host = mockHost(); enableSfxLauncher(host);
    const cached = seedLibraryCaches(host), read = host.File.prototype.read;
    host.File.prototype.read = function (...args) {
        assert.ok(!/\.(?:tsv|jsonl)$/i.test(this.name), "cache load must use metadata only");
        return read.apply(this, args);
    };
    const library = directLibrary(host, false, false);
    assert.equal(host.sfxRequests.length, 0);
    assert.equal(library.state.effectsCount, 924);
    assert.equal(library.state.projectAudioCount, 24);
    assert.equal(library.state.sfxCount, 14657);
    assert.equal(library.state.effectsTimestampEpochMs, cached.effects.timestampEpochMs);
    assert.equal(library.state.sfxCompletedUtc, cached.sfx.completedUtc);
    assert.equal(library.state.sfxTimestampEpochMs, null, "unknown historical epoch must remain unknown");
    assert.equal(library.state.effectsCatalogCached, true);
    assert.equal(library.state.sfxCatalogCached, true);
    assert.ok(new host.File(library.root + "/latest-effects.json").exists, "validated old manifest migrated before replacement");
    library.stop(); const next = directLibrary(host, false, false);
    assert.equal(next.state.effectsCount, 924);
    assert.equal(next.state.effectsTimestampEpochMs, cached.effects.timestampEpochMs);
    assert.equal(host.sfxRequests.length, 0);
});

test("disabling catalogs hides all paths but retains files for later enable and reconnect", () => {
    const host = mockHost(); enableSfxLauncher(host); const cached = seedLibraryCaches(host);
    const library = directLibrary(host, false, false);
    library.setEnabled("effects", false); library.setEnabled("sfx", false);
    assert.equal(library.state.effectsRelativePath, undefined);
    assert.equal(library.state.projectAudioRelativePath, undefined);
    assert.equal(library.state.sfxRelativePath, undefined);
    assert.equal(library.state.effectsCount, 0); assert.equal(library.state.sfxCount, 0);
    assert.ok(new host.File(aeWorkspace + "/" + cached.effects.effectsRelativePath).exists);
    assert.ok(new host.File(aeWorkspace + "/" + cached.sfx.catalogRelativePath).exists);
    library.stop(); const next = directLibrary(host, false, false);
    assert.equal(next.state.effectsCount, 0); assert.equal(next.state.sfxCount, 0);
    next.setEnabled("effects", true); next.setEnabled("sfx", true);
    assert.equal(next.state.effectsCount, 924); assert.equal(next.state.sfxCount, 14657);
    assert.equal(next.state.effectsRelativePath, cached.effects.effectsRelativePath);
    assert.equal(host.sfxRequests.length, 0);
});

test("malformed configurations cannot be overwritten by switches or initiate scans", () => {
    for (const malformed of ['{"schemaVersion":1,"sfx":{"enabled":"false"}}', '{"schemaVersion":1,"effects":[]}', '{"schemaVersion":1};app.project.save()']) {
        const host = mockHost(), configPath = aeWorkspace + "/.ae-codex/library/config.json";
        host.put(configPath, malformed);
        const library = directLibrary(host, false, false);
        assert.equal(library.state.state, "error");
        assert.throws(() => library.setEnabled("sfx", true), /configuration|JSON|boolean/);
        assert.throws(() => library.requestRefresh(), /Library config/);
        assert.equal(host.textAt(configPath), malformed);
        assert.equal(host.sfxRequests.length, 0);
    }
});

test("failed settings publication restores the previous file and live preference", () => {
    const host = mockHost(), configPath = aeWorkspace + "/.ae-codex/library/config.json";
    const original = '{"schemaVersion":1,"sfx":{"enabled":false,"roots":["D:/SFX"]}}';
    host.put(configPath, original); const library = directLibrary(host, false, false);
    const rename = host.File.prototype.rename;
    host.File.prototype.rename = function (name) {
        if (/^settings-\d+-\d+\.json$/.test(this.name) && name === "config.json") { this.error = "mock denied"; return false; }
        return rename.call(this, name);
    };
    assert.throws(() => library.setEnabled("sfx", true), /Cannot save library configuration/);
    assert.equal(host.textAt(configPath), original);
    assert.equal(library.getPreferences().sfxEnabled, false);
    assert.equal(host.sfxRequests.length, 0);
});

test("cache and status publication failures cannot roll back an already saved switch", () => {
    const host = mockHost(); seedLibraryCaches(host);
    const library = directLibrary(host, false, false);
    new host.File(library.root + "/latest-effects.json").remove();
    const writeAtomic = host.bridge.writeAtomic;
    host.bridge.writeAtomic = function (target, text) {
        if (/\/(?:latest-effects|current)\.json$/.test(target)) { throw new Error("mock descriptor publication denied"); }
        return writeAtomic.call(this, target, text);
    };
    const saved = library.setEnabled("effects", false);
    assert.equal(saved.effectsEnabled, false);
    assert.equal(library.getPreferences().effectsEnabled, false);
    assert.equal(JSON.parse(host.textAt(library.root + "/config.json")).effects.enabled, false);
    assert.equal(library.state.effectsRelativePath, undefined);
    assert.match(host.textAt(host.bridge.bridgeRoot + "/logs/events.log"), /cached descriptor could not be saved/);
    assert.match(host.textAt(host.bridge.bridgeRoot + "/logs/events.log"), /settings saved; status publication failed/);
});

test("Stop cancels a queued manual request and a switch rejects late disabled SFX results", () => {
    const host = mockHost(), library = directLibrary(host, true, false);
    library.requestRefresh(); library.stop(); library.tick();
    assert.equal(library.refreshPending, false);
    assert.equal(host.sfxRequests.length, 0);
    assert.equal(library.requestRefresh(), false);
    const next = directLibrary(host, false, false);
    next.requestRefresh(); next.tick(); assert.equal(host.sfxRequests.length, 1);
    const requestId = next.requestId;
    next.setEnabled("sfx", false);
    assert.equal(new host.File(next.root + "/requests/pending-launch.json").exists, false);
    putSfxStatus(host, next, successfulSfxStatus(host, next, {count: 999})); next.tick();
    assert.equal(next.requestId, requestId);
    assert.equal(next.state.sfxCount, 0);
    assert.equal(next.state.sfxRelativePath, undefined);
    assert.equal(next.state.sfxState, "disabled");
    assert.equal(host.sfxRequests.length, 1);
});

test("manual refresh preserves the last usable paths until the new scan finishes", () => {
    const host = mockHost(); const cached = seedLibraryCaches(host);
    const comp = new host.CompItem(); Object.assign(comp, {numLayers: 30, layer() { return {property() { return null; }}; }});
    host.app.project.numItems = 1; host.app.project.item = () => comp;
    const library = directLibrary(host, false, false);
    library.requestRefresh(); library.tick();
    assert.equal(library.state.state, "scanning");
    assert.equal(library.state.effectsRelativePath, cached.effects.effectsRelativePath);
    assert.equal(library.state.effectsCount, 924);
    assert.equal(library.state.appliedSchemaCount, 4);
    for (let n = 0; library.state.state === "scanning" && n < 20; n++) library.tick();
    assert.equal(library.state.effectsCount, 2);
    assert.equal(library.state.appliedSchemaCount, 0, "new counts must not accumulate the previous cache count");
    assert.notEqual(library.state.effectsRelativePath, cached.effects.effectsRelativePath);
});

test("terminal inventory errors are visible once and never restart a scan", () => {
    const host = mockHost(), library = directLibrary(host, false, false);
    library.scanChunk = () => { throw new Error("mock incremental inventory failure"); };
    assert.equal(library.requestRefresh(), true); library.tick();
    const current = JSON.parse(host.textAt(library.root + "/current.json"));
    assert.equal(current.state, "error");
    assert.ok(current.errors.some(error => /mock incremental inventory failure/.test(error)));
    assert.match(library.describe(), /cập nhật lỗi/);
    const firstLog = host.textAt(host.bridge.bridgeRoot + "/logs/events.log");
    assert.equal(firstLog.split("mock incremental inventory failure").length - 1, 1);
    host.advanceTime(86400000); library.tick(); library.tick();
    assert.equal(host.textAt(host.bridge.bridgeRoot + "/logs/events.log"), firstLog);
    assert.equal(library.refreshPending, false);
});

test("failed effect registry scans retain the last usable catalog and scan timestamp", () => {
    const host = mockHost(), cached = seedLibraryCaches(host);
    const library = directLibrary(host, false, false);
    Object.defineProperty(host.app, "effects", {get() { throw new Error("mock registry failure"); }});
    assert.equal(library.requestRefresh(), true); library.tick();
    assert.equal(library.state.state, "partial");
    assert.equal(library.state.effectsState, "error");
    assert.equal(library.state.effectsRelativePath, cached.effects.effectsRelativePath);
    assert.equal(library.state.effectsTimestampEpochMs, cached.effects.timestampEpochMs);
    assert.equal(library.state.effectsCount, 924);
    assert.match(library.describe(), /chưa đầy đủ/);
    assert.equal(library.project, null);
});

test("SFX folder selection preserves existing machine settings and never enables or scans", () => {
    const host = mockHost(), configPath = aeWorkspace + "/.ae-codex/library/config.json";
    const original = {schemaVersion: 1, effects: {enabled: false}, custom: {preserve: true}, sfx: {enabled: false, roots: ["E:/AudioSFX", "C:/Users/nguye/Downloads"], extensions: ["wav", "mp3"], extra: 9}};
    host.put(configPath, JSON.stringify(original));
    const library = directLibrary(host, false, false);
    assert.deepEqual(Array.from(library.getSfxRoots()), original.sfx.roots);
    const selected = library.setSfxRoots(["E:\\AudioSFX\\", "C:/Users/nguye/Downloads", "F:/New SFX"]);
    assert.deepEqual(Array.from(selected), ["E:/AudioSFX", "C:/Users/nguye/Downloads", "F:/New SFX"]);
    const saved = JSON.parse(host.textAt(configPath));
    assert.deepEqual(saved.sfx.extensions, original.sfx.extensions);
    assert.equal(saved.sfx.enabled, false); assert.equal(saved.effects.enabled, false);
    assert.equal(saved.sfx.extra, 9); assert.deepEqual(saved.custom, original.custom);
    assert.equal(saved.refreshMode, "manual"); assert.equal(saved.sfx.requireRootsMatch, true);
    assert.equal(library.getPreferences().sfxEnabled, false);
    assert.equal(host.sfxRequests.length, 0); assert.equal(library.requestId, undefined);
    library.stop(); const next = directLibrary(host, false, false);
    assert.deepEqual(Array.from(next.getSfxRoots()), Array.from(selected));
    assert.equal(host.sfxRequests.length, 0);
});

test("SFX folder selection on a new machine defaults off until explicitly enabled", () => {
    const host = mockHost(), library = directLibrary(host, false, false);
    assert.deepEqual(Array.from(library.getSfxRoots()), []);
    library.setSfxRoots(["F:/SFX"]);
    const config = JSON.parse(host.textAt(library.root + "/config.json"));
    assert.equal(config.sfx.enabled, false);
    assert.equal(library.getPreferences().sfxEnabled, false);
    assert.equal(host.sfxRequests.length, 0);
});

test("clearing every SFX folder saves an explicit opt-out and preserves Effects updates", () => {
    const host = mockHost(); enableSfxLauncher(host); const cached = seedLibraryCaches(host);
    const configPath = aeWorkspace + "/.ae-codex/library/config.json";
    const original = {schemaVersion: 1, effects: {enabled: true, custom: 7}, custom: {keep: true}, sfx: {enabled: true, roots: ["D:/SFX"], extensions: ["wav"], custom: "keep"}};
    host.put(configPath, JSON.stringify(original));
    const library = directLibrary(host, false, false);
    assert.equal(library.state.sfxCount, 14657);
    assert.deepEqual(Array.from(library.setSfxRoots([])), []);
    const saved = JSON.parse(host.textAt(configPath));
    assert.deepEqual(saved.sfx.roots, []); assert.equal(saved.sfx.enabled, false);
    assert.deepEqual(saved.sfx.extensions, original.sfx.extensions); assert.equal(saved.sfx.custom, "keep");
    assert.deepEqual(saved.effects, original.effects); assert.deepEqual(saved.custom, original.custom);
    assert.equal(saved.refreshMode, "manual");
    assert.equal(library.getPreferences().sfxEnabled, false);
    assert.equal(library.getPreferences().effectsEnabled, true);
    assert.equal(library.state.sfxState, "disabled"); assert.equal(library.state.sfxCount, 0);
    assert.equal(library.state.sfxRelativePath, undefined); assert.equal(library.state.sfxSummaryRelativePath, undefined);
    assert.ok(new host.File(aeWorkspace + "/" + cached.sfx.catalogRelativePath).exists);
    assert.equal(host.sfxRequests.length, 0);
    library.stop(); const next = directLibrary(host, false, false);
    assert.deepEqual(Array.from(next.getSfxRoots()), []);
    assert.equal(next.state.sfxEnabled, false); assert.equal(next.state.sfxCount, 0);
    assert.equal(next.state.sfxRelativePath, undefined);
    assert.equal(next.state.effectsCount, 924);
    assert.equal(next.requestRefresh(), true); next.tick();
    assert.equal(next.state.effectsCount, 2); assert.equal(next.state.effectsState, "ready");
    assert.equal(next.state.sfxState, "disabled"); assert.equal(host.sfxRequests.length, 0);
});

test("empty SFX folders persist an opt-out on new and legacy ambiguous configurations", () => {
    const configurations = [null, {schemaVersion: 1}, {schemaVersion: 1, sfx: {enabled: false}},
        {schemaVersion: 1, sfx: {roots: []}}, {schemaVersion: 1, sfx: {enabled: true, roots: []}}];
    for (const configuration of configurations) {
        const host = mockHost(), configPath = aeWorkspace + "/.ae-codex/library/config.json";
        if (configuration) host.put(configPath, JSON.stringify(configuration));
        const library = directLibrary(host, false, false);
        library.setSfxRoots([]);
        const saved = JSON.parse(host.textAt(configPath));
        assert.deepEqual(saved.sfx.roots, []); assert.equal(saved.sfx.enabled, false);
        assert.equal(library.getPreferences().sfxEnabled, false);
        assert.equal(host.sfxRequests.length, 0);
    }
});

test("an already explicit empty disabled SFX list is a no-op", () => {
    const host = mockHost(), configPath = aeWorkspace + "/.ae-codex/library/config.json";
    const original = '{"schemaVersion":1,"effects":{"enabled":false},"sfx":{"enabled":false,"roots":[],"extensions":["wav"]}}';
    host.put(configPath, original); const library = directLibrary(host, false, false), writes = host.writes.length;
    assert.deepEqual(Array.from(library.setSfxRoots([])), []);
    assert.equal(host.writes.length, writes); assert.equal(host.textAt(configPath), original);
    assert.equal(library.getPreferences().effectsEnabled, false);
    assert.equal(library.requestRefresh(), false);
    assert.equal(host.sfxRequests.length, 0);
});

test("failed clearing of SFX folders restores both enabled preference and cached catalog", () => {
    const host = mockHost(); enableSfxLauncher(host); seedLibraryCaches(host);
    const library = directLibrary(host, false, false), original = host.textAt(library.root + "/config.json"), oldPath = library.state.sfxRelativePath;
    const rename = host.File.prototype.rename;
    host.File.prototype.rename = function (name) {
        if (/^settings-\d+-\d+\.json$/.test(this.name) && name === "config.json") { this.error = "mock denied"; return false; }
        return rename.call(this, name);
    };
    assert.throws(() => library.setSfxRoots([]), /Cannot save library configuration/);
    assert.equal(host.textAt(library.root + "/config.json"), original);
    assert.deepEqual(Array.from(library.getSfxRoots()), ["D:/SFX"]);
    assert.equal(library.getPreferences().sfxEnabled, true);
    assert.equal(library.state.sfxRelativePath, oldPath); assert.equal(library.state.sfxCount, 14657);
    assert.equal(host.sfxRequests.length, 0);
});

test("SFX folder validation rejects drive share relative duplicate unsafe and oversized lists", () => {
    const host = mockHost(), library = directLibrary(host, false, false);
    const invalid = [["C:/"], ["//server/share"], ["../SFX"], ["C:relative"], ["C:/one/../two"], ["C:/folder/CON"], ["C:/folder/trailing."], ["C:/folder/with?wildcard"], ["C:/bad\nfolder"], ["C:/SFX", "c:\\sfx\\"], Array.from({length: 33}, (_, n) => "D:/SFX" + n)];
    for (const roots of invalid) {
        assert.throws(() => library.setSfxRoots(roots), /SFX|Duplicate|Select/);
        assert.equal(new host.File(library.root + "/config.json").exists, false);
    }
    assert.deepEqual(Array.from(library.setSfxRoots(["//server/share/SFX"])), ["//server/share/SFX"]);
    assert.equal(host.sfxRequests.length, 0);
});

test("unchanged normalized SFX folders preserve their cache without writes or scans", () => {
    const host = mockHost(); enableSfxLauncher(host); seedLibraryCaches(host);
    const library = directLibrary(host, false, false), before = host.writes.length;
    const previousPath = library.state.sfxRelativePath;
    library.setSfxRoots(["d:\\SFX\\"]);
    assert.equal(host.writes.length, before);
    assert.equal(library.state.sfxRelativePath, previousPath);
    assert.equal(library.state.sfxCount, 14657);
    assert.equal(host.sfxRequests.length, 0);
});

test("changed SFX folders invalidate old catalog across reconnect including late old worker results", () => {
    const host = mockHost(); enableSfxLauncher(host); const cached = seedLibraryCaches(host);
    const library = directLibrary(host, false, false);
    library.setSfxRoots(["F:/New SFX"]);
    assert.equal(library.state.sfxRelativePath, undefined); assert.equal(library.state.sfxCount, 0);
    assert.ok(new host.File(aeWorkspace + "/" + cached.sfx.catalogRelativePath).exists);
    // A pre-change worker may publish later. Its compact summary proves it used
    // the old folder, so a timestamp alone must never make that catalog valid.
    const summaryRelativePath = ".ae-codex/library/sessions/" + cached.sfx.sessionId + "/summary-sfx-" + cached.sfx.requestId + ".json";
    cached.sfx.summaryRelativePath = summaryRelativePath;
    host.put(aeWorkspace + "/.ae-codex/library/latest-sfx.json", JSON.stringify(cached.sfx));
    const summary = {schemaVersion: 1, kind: "disk-sfx", state: "success", sessionId: cached.sfx.sessionId, requestId: cached.sfx.requestId, roots: [{path: "D:/SFX", state: "scanned"}]};
    host.put(aeWorkspace + "/" + summaryRelativePath, JSON.stringify(summary));
    library.stop(); const next = directLibrary(host, false, false);
    assert.equal(next.state.sfxCount, 0); assert.equal(next.state.sfxRelativePath, undefined);
    assert.equal(next.state.sfxState, "not-indexed");
    assert.equal(host.sfxRequests.length, 0);
    // A subsequent real scan of the selected folder may reuse its validated
    // immutable catalog. No body is loaded into AE to establish that identity.
    summary.roots = [{path: "f:\\new sfx", state: "scanned"}];
    host.put(aeWorkspace + "/" + summaryRelativePath, JSON.stringify(summary));
    next.stop(); const matching = directLibrary(host, false, false);
    assert.equal(matching.state.sfxCount, 14657);
    assert.equal(matching.state.sfxRelativePath, cached.sfx.catalogRelativePath);
    assert.equal(host.sfxRequests.length, 0);
});

test("SFX cache roots require a correctly bound compact summary before reuse", () => {
    for (const change of ["foreignSession", "pathEscape", "malformed", "oversized"]) {
        const host = mockHost(); enableSfxLauncher(host); const cached = seedLibraryCaches(host);
        const library = directLibrary(host, false, false); library.setSfxRoots(["F:/SFX"]);
        const summaryRelativePath = ".ae-codex/library/sessions/" + cached.sfx.sessionId + "/summary-sfx-" + cached.sfx.requestId + ".json";
        cached.sfx.summaryRelativePath = change === "pathEscape" ? "../outside.json" : summaryRelativePath;
        host.put(aeWorkspace + "/.ae-codex/library/latest-sfx.json", JSON.stringify(cached.sfx));
        const summary = {schemaVersion: 1, kind: "disk-sfx", state: "success", sessionId: change === "foreignSession" ? "foreign-session-0001" : cached.sfx.sessionId, requestId: cached.sfx.requestId, roots: [{path: "F:/SFX"}]};
        host.put(aeWorkspace + "/" + summaryRelativePath, change === "malformed" ? '{"roots":[]};app.project.save()' : change === "oversized" ? " ".repeat(262145) : JSON.stringify(summary));
        library.stop(); const next = directLibrary(host, false, false);
        assert.equal(next.state.sfxRelativePath, undefined, change);
        assert.equal(next.state.sfxCount, 0, change);
        assert.equal(host.sfxRequests.length, 0);
    }
});

test("failed SFX folder publication preserves configuration and usable catalog", () => {
    const host = mockHost(); enableSfxLauncher(host); seedLibraryCaches(host);
    const library = directLibrary(host, false, false), original = host.textAt(library.root + "/config.json"), oldPath = library.state.sfxRelativePath;
    const rename = host.File.prototype.rename;
    host.File.prototype.rename = function (name) {
        if (/^settings-\d+-\d+\.json$/.test(this.name) && name === "config.json") { return false; }
        return rename.call(this, name);
    };
    assert.throws(() => library.setSfxRoots(["F:/SFX"]), /Cannot save library configuration/);
    assert.equal(host.textAt(library.root + "/config.json"), original);
    assert.equal(library.state.sfxRelativePath, oldPath);
    assert.equal(library.state.sfxCount, 14657);
    assert.equal(host.sfxRequests.length, 0);
});

test("registered effects can be read when no project is open", () => {
    const host = mockHost({ project: null });
    host.connect();
    assert.equal(host.app.project, null);
    assert.equal(host.executionCount, 0);
});

test("library scans registered effects with no project and preserves exact matchNames", () => {
    const host = mockHost({ project: null });
    const library = directLibrary(host);
    library.tick();
    const manifest = JSON.parse(host.textAt(library.root + "/current.json"));
    assert.equal(manifest.effectsState, "ready");
    assert.equal(manifest.effectsCount, 2);
    assert.equal(manifest.projectAudioCount, 0);
    const tsv = host.textAt(aeWorkspace + "/" + manifest.effectsRelativePath);
    assert.ok(tsv.includes("\tEnhance AI \t"), "trailing spaces are part of the effect matchName");
    const audio = JSON.parse(host.textAt(aeWorkspace + "/" + manifest.projectAudioRelativePath));
    assert.deepEqual(audio.items, []);
    assert.equal(host.executionCount, 0);
});

test("new machines and opted-out folders never launch SFX and still refresh effects", () => {
    for (const config of [null, { schemaVersion: 1, sfx: { enabled: false, roots: ["D:/private-audio"] } }]) {
        const host = mockHost({ project: null });
        if (config) { host.put(aeWorkspace + "/.ae-codex/library/config.json", JSON.stringify(config)); }
        const priorSession = "cached-session-0001", priorRequest = "cached-request-0001";
        const catalogPath = ".ae-codex/library/sessions/" + priorSession + "/sfx-" + priorRequest + ".jsonl";
        host.put(aeWorkspace + "/" + catalogPath, '{"path":"D:/private-audio/hidden.wav"}\n');
        host.put(aeWorkspace + "/.ae-codex/library/latest-sfx.json", JSON.stringify({ schemaVersion: 1, kind: "disk-sfx", sessionId: priorSession,
            requestId: priorRequest, count: 7, catalogRelativePath: catalogPath }));
        const library = directLibrary(host);
        library.tick();
        assert.equal(host.sfxRequests.length, 0);
        assert.equal(library.state.state, "ready");
        assert.equal(library.state.sfxEnabled, false);
        assert.equal(library.state.sfxState, "disabled");
        assert.equal(library.state.sfxCount, 0);
        assert.equal(library.state.sfxRelativePath, undefined);
        assert.equal(library.state.effectsState, "ready");
        assert.equal(library.state.effectsCount, 2);
        host.advanceTime(120000);
        library.tick();
        library.tick();
        assert.equal(host.sfxRequests.length, 0, "idle refresh must respect the opt-out");
        assert.equal(library.state.effectsState, "ready");
    }
});

test("configured users without an enabled flag keep their SFX discovery", () => {
    const host = mockHost();
    enableSfxLauncher(host);
    host.put(aeWorkspace + "/.ae-codex/library/config.json", JSON.stringify({ schemaVersion: 1, sfx: { roots: ["D:/SFX"] } }));
    const library = directLibrary(host);
    assert.equal(host.sfxRequests.length, 1);
    assert.equal(library.state.sfxEnabled, true);
    assert.equal(library.sfxDone, false);
});

test("invalid consent fails clearly without launching either inventory", () => {
    const host = mockHost();
    enableSfxLauncher(host);
    host.put(aeWorkspace + "/.ae-codex/library/config.json", JSON.stringify({ schemaVersion: 1, sfx: { enabled: "false", roots: ["D:/SFX"] } }));
    const library = directLibrary(host);
    library.tick();
    assert.equal(host.sfxRequests.length, 0);
    assert.equal(library.state.state, "error");
    assert.equal(library.state.sfxEnabled, false);
    assert.equal(library.state.effectsState, "disabled");
    assert.equal(library.state.effectsCount, 0);
    assert.ok(library.state.errors.some(error => /sfx.enabled/.test(error)));
});

test("SFX consent changed before helper execution clears cached audio from inventory", () => {
    const host = mockHost();
    const library = directLibrary(host, true);
    putSfxStatus(host, library, successfulSfxStatus(host, library, { enabled: false, skipped: true, count: 0 }));
    library.tick();
    assert.equal(library.state.sfxState, "disabled");
    assert.equal(library.state.sfxEnabled, false);
    assert.equal(library.state.sfxCount, 0);
    assert.equal(library.state.sfxRelativePath, undefined);
    assert.equal(library.state.effectsState, "ready");
});

test("project scanning yields between chunks and never evaluates custom property data", () => {
    const host = mockHost();
    let layerReads = 0;
    let customReads = 0;
    const custom = {
        propertyType: 1, propertyValueType: 1, matchName: "Mock-Custom", name: "Private Data",
        hasMin: false, hasMax: false,
        get value() { customReads += 1; throw new Error("custom values must not be read"); }
    };
    const number = { propertyType: 1, propertyValueType: 2, matchName: "Mock-Radius", name: "Radius", hasMin: true, minValue: 0, hasMax: true, maxValue: 100, value: 42 };
    const effect = { matchName: "Mock Glow", name: "Mock Glow", numProperties: 2, property(n) { return [custom, number][n - 1]; } };
    const parade = { numProperties: 1, property() { return effect; } };
    const comp = new host.CompItem();
    comp.numLayers = 18;
    comp.layer = function () { layerReads += 1; return { property(name) { assert.equal(name, "ADBE Effect Parade"); return parade; } }; };
    host.app.project.numItems = 1;
    host.app.project.item = function () { return comp; };
    const library = directLibrary(host);
    for (let i = 0; !library.aeDone && i < 20; i++) {
        const before = layerReads;
        library.tick();
        assert.ok(layerReads - before <= 6, "each inventory tick must yield after its layer budget");
    }
    assert.equal(library.aeDone, true);
    assert.equal(layerReads, 18);
    assert.equal(customReads, 0);
    assert.equal(library.state.appliedSchemaCount, 1, "shared effect schema is collected once");
    const tsv = host.textAt(aeWorkspace + "/" + library.state.effectsRelativePath);
    assert.ok(tsv.includes("Mock-Radius\tRadius\t1\tmin=0 max=100\t42"));
});

test("one large applied effect yields within a fixed property budget and preserves every row", () => {
    const host = mockHost();
    let reads = 0;
    const total = 1024;
    const effect = {matchName: "Wide Effect", name: "Wide Effect", numProperties: total, property(index) {
        reads += 1;
        return {propertyType: 1, propertyValueType: 2, matchName: "P-" + index, name: "Parameter " + index, hasMin: false, hasMax: false, value: index};
    }};
    const comp = new host.CompItem();
    comp.numLayers = 2;
    comp.layer = () => ({property: () => ({numProperties: 1, property: () => effect})});
    host.app.project.numItems = 1;
    host.app.project.item = () => comp;
    const library = directLibrary(host);
    let ticks = 0;
    while (!library.aeDone && ticks < 100) {
        const before = reads;
        library.tick(); ticks += 1;
        assert.ok(reads - before <= 64, "one effect must never drain its property tree in one tick");
    }
    assert.equal(library.aeDone, true);
    assert.ok(ticks > 1);
    assert.equal(reads, total);
    assert.equal(library.state.appliedSchemaCount, 1, "the next layer's same effect stays deduplicated");
    const rows = host.textAt(aeWorkspace + "/" + library.state.effectsRelativePath).split("\n");
    const parameters = rows.filter(row => row.startsWith("PARAM\t"));
    assert.equal(parameters.length, total);
    assert.equal(parameters[0], "PARAM\tWide Effect\tP-1\tParameter 1\t1\t\t1");
    assert.equal(parameters[total - 1], "PARAM\tWide Effect\tP-1024\tParameter 1024\t1\t\t1024");
});

test("applied property scanning yields to an eight millisecond deadline", () => {
    const host = mockHost();
    let reads = 0;
    const effect = {matchName: "Slow Fixture", name: "Slow Fixture", numProperties: 20, property(index) {
        reads += 1; host.advanceTime(2);
        return {propertyType: 1, propertyValueType: 2, matchName: "Slow-" + index, name: "Slow " + index, value: index};
    }};
    const comp = new host.CompItem(); comp.numLayers = 1;
    comp.layer = () => ({property: () => ({numProperties: 1, property: () => effect})});
    host.app.project.numItems = 1; host.app.project.item = () => comp;
    const library = directLibrary(host);
    for (let tick = 0; !library.aeDone && tick < 30; tick++) {
        const before = reads; library.tick();
        assert.ok(reads - before <= 4, "yield after four two-millisecond native property reads");
    }
    assert.equal(library.aeDone, true);
    assert.equal(reads, 20);
});

test("resumable applied schemas keep depth first order and the depth eight boundary", () => {
    const host = mockHost();
    let tooDeepReads = 0;
    const leaf = name => ({propertyType: 1, propertyValueType: 2, matchName: name, name, value: 7});
    const group = (name, children) => ({propertyType: 3, matchName: name, name, numProperties: children.length, property: index => children[index - 1]});
    let nested = {propertyType: 3, matchName: "Boundary-8", name: "Boundary-8", numProperties: 1, property() {tooDeepReads += 1; return leaf("TooDeep");}};
    for (let depth = 7; depth >= 0; depth--) nested = group("Group-" + depth, [nested]);
    const effect = group("Ordered Effect", [leaf("First"), group("Branch", [leaf("Nested"), null]), nested, leaf("Last")]);
    const comp = new host.CompItem(); comp.numLayers = 1;
    comp.layer = () => ({property: () => ({numProperties: 1, property: () => effect})});
    host.app.project.numItems = 1; host.app.project.item = () => comp;
    const library = directLibrary(host);
    for (let tick = 0; !library.aeDone && tick < 20; tick++) library.tick();
    assert.equal(library.aeDone, true);
    const rows = host.textAt(aeWorkspace + "/" + library.state.effectsRelativePath).split("\n").filter(row => row.startsWith("PARAM\t"));
    assert.deepEqual(rows.slice(0, 3), ["PARAM\tOrdered Effect\tFirst\tFirst\t1\t\t7", "PARAM\tOrdered Effect\tBranch\tBranch\t3\t\t", "PARAM\tOrdered Effect/Branch\tNested\tNested\t1\t\t7"]);
    assert.ok(rows.some(row => row.includes("\tBoundary-8\tBoundary-8\t")));
    assert.equal(tooDeepReads, 0);
    assert.equal(rows[rows.length - 1], "PARAM\tOrdered Effect\tLast\tLast\t1\t\t7");
    assert.equal(library.state.appliedSchemaCount, 1);
});

test("a property failure keeps earlier rows skips that layer and continues the next", () => {
    const host = mockHost();
    let skippedReads = 0;
    const bad = {matchName: "Broken Effect", name: "Broken Effect", numProperties: 2, property(index) {
        if (index === 2) throw new Error("Fixture native property unavailable");
        return {propertyType: 1, propertyValueType: 2, matchName: "BeforeError", name: "BeforeError", value: 3};
    }};
    const good = {matchName: "Good Effect", name: "Good Effect", numProperties: 0, property() {throw new Error("No children");}};
    const comp = new host.CompItem(); comp.numLayers = 2;
    comp.layer = index => ({property: () => index === 1 ? {numProperties: 2, property(effectIndex) {if (effectIndex > 1) skippedReads += 1; return bad;}} : {numProperties: 1, property: () => good}});
    host.app.project.numItems = 1; host.app.project.item = () => comp;
    const library = directLibrary(host);
    for (let tick = 0; !library.aeDone && tick < 20; tick++) library.tick();
    assert.equal(library.aeDone, true);
    assert.equal(skippedReads, 0);
    assert.equal(library.layerErrors, 1);
    assert.equal(library.state.appliedSchemaCount, 1);
    const tsv = host.textAt(aeWorkspace + "/" + library.state.effectsRelativePath);
    assert.ok(tsv.includes("BeforeError"));
    assert.ok(tsv.includes("APPLIED\tGood Effect\tGood Effect"));
    assert.ok(library.state.errors.some(error => error === "Unavailable project layers/items: 1"));
});

test("Stop releases a partially scanned effect without reading further properties", () => {
    const host = mockHost(); let reads = 0;
    const effect = {matchName: "Stop Fixture", name: "Stop Fixture", numProperties: 500, property(index) {
        reads += 1; return {propertyType: 1, propertyValueType: 2, matchName: "P-" + index, name: "P", value: 1};
    }};
    const comp = new host.CompItem(); comp.numLayers = 1;
    comp.layer = () => ({property: () => ({numProperties: 1, property: () => effect})});
    host.app.project.numItems = 1; host.app.project.item = () => comp;
    const library = directLibrary(host); library.tick();
    assert.ok(reads > 0 && reads < 500);
    const before = reads; library.stop(); library.tick();
    assert.equal(reads, before);
    assert.equal(library.scanParade, null);
    assert.equal(library.propertyStack.length, 0);
});

test("audio inventory records existing footage without importing or changing media", () => {
    const host = mockHost();
    const footage = new host.FootageItem();
    Object.assign(footage, { id: 123, name: "Boing.wav", hasAudio: true, hasVideo: false, duration: 0.5, file: new host.File("D:/SFX/Boing.wav") });
    host.put("D:/SFX/Boing.wav", "mock audio metadata");
    host.app.project.numItems = 1;
    host.app.project.item = function () { return footage; };
    const library = directLibrary(host);
    library.tick();
    const audio = JSON.parse(host.textAt(aeWorkspace + "/" + library.state.projectAudioRelativePath));
    assert.equal(audio.items.length, 1);
    assert.equal(audio.items[0].filePath, "D:/SFX/Boing.wav");
    assert.equal(audio.items[0].available, true);
    assert.equal(audio.items[0].duration, 0.5);
    assert.ok(host.writes.every(file => file.toLowerCase().startsWith((aeWorkspace + "/.ae-codex/").toLowerCase())));
});

test("valid helper status connects only the current session catalog", () => {
    const host = mockHost();
    const library = directLibrary(host, true);
    assert.equal(host.sfxRequests.length, 1);
    assert.equal(host.launcherCalls.length, 0, "AE must not execute files");
    assert.equal(host.systemCalls.length, 0, "inventory must never call a console shell");
    putSfxStatus(host, library, successfulSfxStatus(host, library));
    library.tick();
    const manifest = JSON.parse(host.textAt(library.root + "/current.json"));
    assert.equal(manifest.state, "ready");
    assert.equal(manifest.sfxState, "ready");
    assert.equal(manifest.sfxCount, 12);
    assert.ok(manifest.sfxRelativePath.includes(library.requestId));
});

test("native Windows background launcher paths are accepted without shell escaping", () => {
    const host = mockHost();
    enableSfxLauncher(host);
    host.put(aeWorkspace + "/.ae-codex/library/runtime.json", JSON.stringify({ backgroundServiceVersion: 1, backgroundLauncherPath: (aeWorkspace + "/tools/Codex AE Background.exe").replace(/\//g, "\\") }));
    const library = directLibrary(host);
    assert.equal(library.sfxDone, false);
    assert.equal(library.state.sfxState, "scanning");
    assert.equal(host.sfxRequests.length, 1);
    assert.equal(host.launcherCalls.length, 0, "AE must not execute files");
    assert.equal(host.systemCalls.length, 0);
});

test("launch acknowledgement is read asynchronously without waiting in AE", () => {
    const host = mockHost({ launchAck: false });
    const library = directLibrary(host, true);
    assert.equal(library.sfxDone, false);
    assert.equal(library.sfxLaunched, false);
    library.tick();
    assert.equal(library.state.effectsState, "ready", "AE inventory must progress while the helper is starting");
    assert.equal(library.state.sfxState, "scanning");
    assert.deepEqual(Array.from(library.state.errors), []);
    host.advanceTime(1500);
    host.put(library.root + "/requests/launch-sfx-" + library.requestId + ".json", JSON.stringify({schemaVersion: 1, requestId: library.requestId, sessionId: host.bridge.sessionNonce, state: "launched", processId: 1234}));
    library.tick();
    assert.equal(library.sfxLaunched, true);
    assert.equal(library.sfxDone, false, "a launched process is not a completed scan");
    const acknowledgement = JSON.parse(host.textAt(library.root + "/requests/launch-sfx-" + library.requestId + ".json"));
    assert.equal(acknowledgement.requestId, library.requestId);
    assert.equal(acknowledgement.state, "launched");
    assert.equal(host.launcherCalls.length, 0, "only the resident helper receives the JSON pointer");
});

test("a missing launcher acknowledgement times out once without shell fallback or re-execution", () => {
    const host = mockHost({ launchAck: false });
    const library = directLibrary(host, true);
    library.tick();
    assert.equal(library.state.sfxState, "scanning");
    host.advanceTime(30000);
    library.tick();
    assert.equal(library.state.sfxState, "scanning", "delayed Windows sign-in startup must not be reported as a failure");
    host.advanceTime(30001);
    library.tick();
    assert.equal(library.state.sfxState, "error");
    assert.equal(library.state.state, "partial");
    assert.ok(library.state.errors.some(message => /did not acknowledge/.test(message)));
    library.tick();
    assert.equal(library.state.errors.length, 1);
    assert.equal(host.sfxRequests.length, 1);
    assert.equal(host.systemCalls.length, 0);
    assert.match(host.textAt(host.bridge.bridgeRoot + "/logs/events.log"), /did not acknowledge/);
});

test("a terminal result before the acknowledgement remains authoritative", () => {
    const host = mockHost({launchAck: false});
    const library = directLibrary(host, true);
    putSfxStatus(host, library, successfulSfxStatus(host, library));
    host.advanceTime(10001);
    library.tick();
    assert.equal(library.state.state, "ready");
    assert.equal(library.state.sfxCount, 12);
    assert.deepEqual(Array.from(library.state.errors), []);
});

test("missing or incompatible service installations report errors without executing files", () => {
    for (const condition of ["missing", "redirected", "unconfigured", "oldRuntime"]) {
        const host = mockHost();
        enableSfxLauncher(host);
        if (condition === "missing") new host.File(aeWorkspace + "/tools/Codex AE Background.exe").remove();
        if (condition === "redirected") host.put(aeWorkspace + "/.ae-codex/library/runtime.json", JSON.stringify({backgroundLauncherPath: "D:/other/worker.exe"}));
        if (condition === "oldRuntime") host.put(aeWorkspace + "/.ae-codex/library/runtime.json", JSON.stringify({backgroundLauncherPath: aeWorkspace + "/tools/Codex AE Background.exe"}));
        if (condition === "unconfigured") host.put(aeWorkspace + "/.ae-codex/library/runtime.json", JSON.stringify({powerShellPath: "C:/old/pwsh.exe"}));
        const library = directLibrary(host);
        library.tick();
        assert.equal(library.state.state, "partial", condition);
        assert.equal(library.state.effectsState, "ready");
        assert.equal(library.state.sfxState, "error");
        assert.equal(host.sfxRequests.length, 0);
        assert.equal(host.launcherCalls.length, 0);
        assert.equal(host.systemCalls.length, 0);
        assert.match(host.textAt(host.bridge.bridgeRoot + "/logs/events.log"), /SFX launcher/);
    }
});

test("mismatched, malformed, or invalid launcher acknowledgements are rejected as data", () => {
    const invalid = [
        { schemaVersion: 2 },
        { requestId: "another-library-request-0001" },
        { sessionId: "another-library-session-0001" },
        { state: "error" },
        { processId: 0 },
        { processId: -1 },
        { processId: 1.5 },
        { processId: "1234" },
        '{"schemaVersion":1}; app.project.save()'
    ];
    for (const launchAck of invalid) {
        const host = mockHost({ launchAck });
        const library = directLibrary(host, true);
        library.tick();
        assert.equal(library.sfxDone, true);
        assert.equal(library.state.sfxState, "error");
        assert.equal(library.state.state, "partial");
        assert.equal(host.executionCount, 0);
    }
});

test("foreign helper status cannot advertise another bridge catalog", () => {
    const host = mockHost();
    const library = directLibrary(host, true);
    putSfxStatus(host, library, successfulSfxStatus(host, library, { sessionId: "another-session-0001" }));
    library.tick();
    assert.equal(library.state.sfxState, "error");
    assert.equal(library.state.sfxCount, 0);
    assert.equal(library.state.sfxRelativePath, undefined);
    assert.equal(library.state.state, "partial");
});

test("JSON status rejects code, duplicate keys, and prototype keys without eval", () => {
    const rejected = [
        '{"state":"success"}; app.project.save()',
        '{"state":"success","state":"error"}',
        '{"__proto__":{"polluted":true}}',
        '{"hasOwnProperty":false,"state":"success"}',
        '{"state":"success","count":NaN}',
        '{"state":"success",}'
    ];
    for (const input of rejected) {
        const host = mockHost();
        const library = directLibrary(host, true);
        putSfxStatus(host, library, input);
        library.tick();
        assert.equal(library.state.sfxState, "error", input);
        assert.equal(library.state.state, "partial", input);
        assert.equal(host.executionCount, 0);
        assert.equal({}.polluted, undefined);
    }
});

test("Stop discards late helper results and generation changes prevent old publication", () => {
    const host = mockHost();
    const oldLibrary = directLibrary(host, true);
    oldLibrary.stop();
    assert.equal(new host.File(oldLibrary.root + "/requests/pending-launch.json").exists, false, "Stop withdraws its unclaimed request");
    const stoppedManifest = host.textAt(oldLibrary.root + "/current.json");
    putSfxStatus(host, oldLibrary, successfulSfxStatus(host, oldLibrary));
    oldLibrary.tick();
    assert.equal(host.textAt(oldLibrary.root + "/current.json"), stoppedManifest);
    assert.equal(oldLibrary.state.sfxCount, 0);
    host.advanceTime(500);
    const newLibrary = directLibrary(host, true);
    assert.notEqual(newLibrary.requestId, oldLibrary.requestId);
    const newManifest = host.textAt(newLibrary.root + "/current.json");
    oldLibrary.active = true;
    oldLibrary.tick();
    assert.equal(host.textAt(newLibrary.root + "/current.json"), newManifest);
});

test("Stop preserves a pending request owned by a newer session", () => {
    const host = mockHost();
    const library = directLibrary(host, true);
    const pointerPath = library.root + "/requests/pending-launch.json";
    const other = JSON.stringify({schemaVersion: 1, sessionId: "another-session-0001", requestId: "another-request-0001"});
    host.put(pointerPath, other);
    library.stop();
    assert.equal(host.textAt(pointerPath), other);
    assert.equal(host.launcherCalls.length, 0);
    assert.equal(host.systemCalls.length, 0);
});

test("changing the open project during a scan yields a partial inventory", () => {
    const host = mockHost();
    const library = directLibrary(host);
    host.app.project = null;
    library.tick();
    assert.equal(library.aeDone, true);
    assert.equal(library.state.state, "partial");
    assert.ok(library.state.errors.some(message => /Project changed/.test(message)));
});

test("Start publishes cached-only library metadata without requesting scans", () => {
    const host = mockHost(); enableSfxLauncher(host);
    const bridge = host.connect(), library = bridge.library;
    assert.ok(library);
    assert.equal(library.generation, bridge.generation);
    assert.equal(library.requestId, undefined);
    assert.equal(host.sfxRequests.length, 0);
    const heartbeat = JSON.parse(host.textAt(bridge.heartbeatPath));
    assert.equal(heartbeat.library.requestId, "");
    assert.equal(heartbeat.library.manifestRelativePath, ".ae-codex/library/current.json");
    assert.equal(heartbeat.library.effectsCount, 0);
    assert.equal(heartbeat.library.manualRefresh, true);
    assert.equal(host.scheduled.size, 1);
});

test("manual library refresh waits behind queued jobs and preserves old snapshots", () => {
    const host = mockHost(); enableSfxLauncher(host);
    const bridge = host.connect(), library = bridge.library;
    assert.equal(library.requestRefresh(), true); host.fireNext();
    putSfxStatus(host, library, successfulSfxStatus(host, library)); host.fireNext();
    assert.equal(library.state.state, "ready");
    const previousRequest = library.requestId;
    const previousSnapshotPath = aeWorkspace + "/" + library.state.effectsRelativePath;
    const previousSnapshot = host.textAt(previousSnapshotPath);
    host.advanceTime(120001); host.fireNext();
    assert.equal(library.requestId, previousRequest, "elapsed time must never trigger a refresh");
    assert.equal(library.requestRefresh(), true);
    host.job("queued-run-0001"); host.fireNext();
    assert.equal(host.executionCount, 1);
    assert.equal(library.requestId, previousRequest, "queued JSX gets the next scheduler tick before inventory refresh");
    assert.equal(host.sfxRequests.length, 1);
    host.fireNext();
    assert.notEqual(library.requestId, previousRequest);
    assert.equal(host.sfxRequests.length, 2);
    assert.equal(host.textAt(previousSnapshotPath), previousSnapshot);
    assert.equal(host.scheduled.size, 1);
});

test("pending result publication holds library work until the job is settled", () => {
    const host = mockHost();
    enableSfxLauncher(host);
    const bridge = host.connect();
    const library = bridge.library;
    let libraryTicks = 0;
    const inventoryTick = library.tick;
    library.tick = function () { libraryTicks += 1; return inventoryTick.call(this); };
    host.failPublication(8);
    bridge.processJob(host.job("held-run-0001"));
    assert.ok(bridge.pendingReport);
    host.fireNext();
    assert.ok(bridge.pendingReport);
    assert.equal(libraryTicks, 0, "inventory cannot advance while terminal result publication is pending");
    host.fireNext();
    assert.equal(bridge.pendingReport, null);
    assert.equal(libraryTicks, 1);
    assert.equal(host.executionCount, 1);
});

test("reconnect ignores old helper results until a fresh manual request", () => {
    const host = mockHost(); enableSfxLauncher(host);
    const bridge = host.connect(), previousLibrary = bridge.library;
    previousLibrary.requestRefresh(); host.fireNext();
    const priorRequest = previousLibrary.requestId;
    bridge.stop(); host.connect();
    const currentLibrary = bridge.library;
    assert.notEqual(currentLibrary, previousLibrary);
    assert.equal(previousLibrary.active, false);
    assert.equal(currentLibrary.requestId, undefined);
    assert.equal(host.sfxRequests.length, 1);
    putSfxStatus(host, previousLibrary, successfulSfxStatus(host, previousLibrary, { count: 999 })); host.fireNext();
    assert.equal(currentLibrary.state.sfxCount, 0);
    assert.equal(currentLibrary.state.sfxState, "not-indexed");
    assert.equal(currentLibrary.requestRefresh(), true); host.fireNext();
    assert.notEqual(currentLibrary.requestId, priorRequest);
    putSfxStatus(host, currentLibrary, successfulSfxStatus(host, currentLibrary, { count: 7 })); host.fireNext();
    assert.equal(currentLibrary.state.sfxCount, 7);
    assert.equal(currentLibrary.state.state, "ready");
});

test("deduplicated helper status can reuse a validated catalog from another session", () => {
    const host = mockHost();
    const library = directLibrary(host, true);
    const priorSession = "previous-session-0001";
    const priorRequest = "previous-request-0001";
    const catalogPath = ".ae-codex/library/sessions/" + priorSession + "/sfx-" + priorRequest + ".jsonl";
    host.put(aeWorkspace + "/" + catalogPath, '{"path":"D:/SFX/Boing.wav"}\n');
    putSfxStatus(host, library, successfulSfxStatus(host, library, {
        catalogSessionId: priorSession, catalogRequestId: priorRequest,
        catalogRelativePath: catalogPath, reusedCatalog: true, pendingArchiveCount: 3
    }));
    library.tick();
    const manifest = JSON.parse(host.textAt(library.root + "/current.json"));
    assert.equal(manifest.state, "ready");
    assert.equal(manifest.sfxRelativePath, catalogPath);
    assert.equal(manifest.sfxCatalogReused, true);
    assert.equal(manifest.sfxCatalogCached, false);
    assert.equal(manifest.pendingArchiveCount, 3);
    assert.ok(manifest.sfxSummaryRelativePath.includes(host.bridge.sessionNonce), "summary must belong to the current inventory request");
});

test("valid last SFX catalog remains discoverable when a fresh helper launch fails", () => {
    const host = mockHost();
    host.put(aeWorkspace + "/.ae-codex/library/config.json", JSON.stringify({ schemaVersion: 1, sfx: { roots: ["D:/SFX"] } }));
    const priorSession = "cached-session-0001";
    const priorRequest = "cached-request-0001";
    const catalogPath = ".ae-codex/library/sessions/" + priorSession + "/sfx-" + priorRequest + ".jsonl";
    host.put(aeWorkspace + "/" + catalogPath, '{"path":"D:/SFX/Boing.wav"}\n');
    host.put(aeWorkspace + "/.ae-codex/library/latest-sfx.json", JSON.stringify({
        schemaVersion: 1, kind: "disk-sfx", sessionId: priorSession, requestId: priorRequest,
        count: 31, catalogRelativePath: catalogPath
    }));
    const library = directLibrary(host);
    library.tick();
    const manifest = JSON.parse(host.textAt(library.root + "/current.json"));
    assert.equal(manifest.state, "partial");
    assert.equal(manifest.sfxState, "error");
    assert.equal(manifest.sfxCount, 31);
    assert.equal(manifest.sfxRelativePath, catalogPath);
    assert.equal(manifest.sfxCatalogCached, true);
    assert.equal(host.textAt(aeWorkspace + "/" + catalogPath), '{"path":"D:/SFX/Boing.wav"}\n');
});

test("status schema and reused catalog paths must be valid before advertising SFX", () => {
    const invalid = [
        { schemaVersion: 2 },
        { kind: "other-inventory" },
        { catalogSessionId: "../outside", catalogRequestId: "prior-request-0001" },
        { catalogSessionId: "prior-session-0001", catalogRequestId: "prior-request-0001", catalogRelativePath: "D:/outside.jsonl" }
    ];
    for (const metadata of invalid) {
        const host = mockHost();
        const library = directLibrary(host, true);
        putSfxStatus(host, library, successfulSfxStatus(host, library, metadata));
        library.tick();
        assert.equal(library.state.state, "partial");
        assert.equal(library.state.sfxState, "error");
        assert.equal(library.state.sfxRelativePath, undefined);
        assert.equal(library.state.sfxCount, 0, "rejected catalog metadata must not change the advertised SFX count");
    }
});

test("bundle contains every inventoried branch and validates without executing edits", () => {
    const host = mockHost();
    const bundle = host.dollar.global.__codexAeBundleV1;
    const inventory = JSON.parse(fs.readFileSync(path.join(workspace, "source/script-inventory.json"), "utf8"));
    assert.deepEqual(Array.from(bundle.names), inventory.names);
    assert.equal(bundle.checked, 0);
    while (bundle.checked < bundle.names.length) { bundle.tick(); }
    assert.equal(bundle.status().state, "ready", bundle.describe());
    assert.equal(bundle.errors.length, 0);
    assert.equal(host.executionCount, 0);
    assert.equal(host.scheduled.size, 0, "checking cannot connect a stopped panel");
});

test("installation validation certificate is reused only for the current bundle", () => {
    const host = mockHost(), bundle = host.bridge.bundle;
    const certificatePath = aeWorkspace + "/.ae-codex/bundle/installed-validation.tsv";
    const fields = ["codex-ae-install/v1", bundle.revision, new host.File(bridgePath).length,
        bundle.names.length, bundle.moduleCount, "a".repeat(64)];
    host.put(certificatePath, fields.join("\t") + "\n");
    bundle.loadInstallation();
    assert.equal(bundle.installation.state, "verified");
    assert.equal(bundle.checked, 0, "reusing installation validation cannot rebuild every branch");
    for (const fieldIndex of [1, 2, 3, 4]) {
        const changed = fields.slice();
        changed[fieldIndex] = fieldIndex === 1 ? "b".repeat(64) : Number(changed[fieldIndex]) + 1;
        host.put(certificatePath, changed.join("\t") + "\n");
        bundle.loadInstallation();
        assert.notEqual(bundle.installation.state, "verified", "certificate field " + fieldIndex + " must match");
    }
    host.put(certificatePath, "malformed certificate\n");
    bundle.loadInstallation();
    assert.notEqual(bundle.installation.state, "verified");
    host.files.delete(certificatePath.toLowerCase());
    bundle.loadInstallation();
    assert.equal(bundle.installation.state, "missing");
    assert.equal(host.executionCount, 0);
});

test("merged runtime reconstructs all original branches exactly without executing them", () => {
    const { expandSource } = require("../tools/AeScriptSource.js");
    const source = JSON.parse(fs.readFileSync(path.join(workspace, "source/scripts.json"), "utf8"));
    const expanded = expandSource(source), originals = expanded.branches || expanded;
    const host = mockHost(), bundle = host.bridge.bundle;
    assert.equal(bundle.names.length, Object.keys(source.branches).length, "all historical entry names must survive consolidation");
    assert.deepEqual(Array.from(bundle.names), Object.keys(originals).sort());
    for (const name of bundle.names) {
        assert.equal(bundle.source(name), originals[name], "source changed while merging " + name);
    }
    const status = bundle.status();
    assert.equal(status.modules, Object.keys(bundle.modules).length);
    assert.ok(status.modules > 0, "the bundle must expose its merged modules");
    assert.ok(status.sharedModules > 0, "at least one source module must serve multiple branch names");
    assert.match(bundle.describe(), /script|branch/i, "panel description must identify the available script library");
    assert.equal(host.executionCount, 0);
    assert.equal(host.scheduled.size, 0);
});

test("merged recipes reject missing modules and slices outside decoded UTF-16 source", () => {
    const host = mockHost(), bundle = host.bridge.bundle;
    const name = "hello.jsx", originalRecipe = bundle.recipe;
    const id = originalRecipe.call(bundle, name).split("|")[0].split(":")[0];
    const text = bundle.moduleSource(id);
    let missing = id.replace(/\d/g, "9");
    while (Object.hasOwn(bundle.modules, missing)) { missing += "9"; }
    try {
        bundle.recipe = function () { return missing + ":0:1"; };
        assert.throws(() => bundle.source(name), /Bundle module missing/i);
        for (const slice of [id + ":" + text.length + ":1", id + ":0:" + (text.length + 1),
            id + ":-1:1", id + ":0:1:extra"]) {
            bundle.recipe = function () { return slice; };
            assert.throws(() => bundle.source(name), /Invalid module slice/i, slice);
        }
    } finally { bundle.recipe = originalRecipe; }
    assert.equal(host.executionCount, 0);
});

test("module slice offsets address decoded UTF-16 text including surrogate pairs", () => {
    const { checksum } = require("../tools/Build-AeScriptBundle.js");
    const host = mockHost(), bundle = host.bridge.bundle, name = "hello.jsx";
    const id = bundle.recipe(name).split("|")[0].split(":")[0];
    const expected = "\ud83c\udfac\u00e9", raw = "A" + expected + "Z";
    bundle.recipe = function () { return id + ":1:3"; };
    bundle.moduleSource = function () { return raw; };
    bundle.entries[name].sourceChecksum = checksum(encodeURIComponent(expected));
    assert.equal(bundle.source(name), expected);
    assert.equal(host.executionCount, 0);
});

test("ASCII JSON module records decode Unicode, control escapes and escaped comment endings", () => {
    const host = mockHost();
    const expected = "Ti\u1ebfng Vi\u1ec7t \ud83c\udfac\r\n\u0000\b\f\t\\\"*/";
    const record = JSON.stringify(expected).replace(/[\u007f-\uffff]/g,
        character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")).replace(/\*\//g, "*\\/");
    assert.match(record, /^[\x00-\x7f]*$/, "physical module records must remain ASCII");
    assert.equal(record.includes("*/"), false, "module contents cannot terminate the enclosing bundle comment");
    assert.equal(decodeInjectedModule(host, record), expected);
    assert.equal(decodeInjectedModule(host, '"\\u00e9\\uD83C\\uDFAC"'), "\u00e9\ud83c\udfac");
    assert.equal(decodeInjectedModule(host, '""'), "");
    assert.equal(host.executionCount, 0);
});

test("malformed JSON module strings fail strictly without evaluating injected code", () => {
    const host = mockHost();
    host.dollar.global.__MODULE_DECODER_EVAL__ = 0;
    const invalid = [
        '"raw\ncontrol"', '"raw\u0000control"', '"\\x41"', '"\\q"',
        'missing opening quote"', '"missing closing quote', '"ok"junk', '"ok" ',
        '"\\u123"', '"\\u12xz"', '"unfinished\\"',
        '"ok";$.global.__MODULE_DECODER_EVAL__=1;""'
    ];
    for (const record of invalid) {
        assert.throws(() => decodeInjectedModule(host, record), /Invalid module|Truncated module/i,
            "malformed physical module record was accepted: " + JSON.stringify(record));
        assert.equal(host.dollar.global.__MODULE_DECODER_EVAL__, 0, "record data must never be evaluated");
    }
    assert.equal(host.executionCount, 0);
});

test("changed reconstructed source cannot bypass the original branch checksum", () => {
    const host = mockHost(), bundle = host.bridge.bundle;
    const originalModuleSource = bundle.moduleSource;
    bundle.moduleSource = function (id) {
        const source = originalModuleSource.call(this, id);
        return source.replace(/[^\r\n]/g, "X");
    };
    assert.throws(() => bundle.source("hello.jsx"), /Branch source checksum mismatch/i);
    assert.throws(() => bundle.run("hello.jsx"), /Branch source checksum mismatch/i);
    assert.equal(host.executionCount, 0);
});

test("a recovered branch clears its previous validation error without duplicate stale reports", () => {
    const host = mockHost(), bundle = host.bridge.bundle, originalRead = bundle.readRecord;
    let failure = "temporary first branch read failure";
    bundle.readRecord = function (entry, name, isModule) {
        if (name === "hello.jsx" && failure) { throw new Error(failure); }
        return originalRead.call(this, entry, name, isModule);
    };
    assert.throws(() => bundle.run("hello.jsx"), /temporary first branch read failure/);
    assert.equal(bundle.entries["hello.jsx"].state, "error");
    assert.equal(bundle.status().state, "error");
    assert.equal(bundle.errors.length, 1);
    failure = "temporary second branch read failure";
    assert.throws(() => bundle.run("hello.jsx"), /temporary second branch read failure/);
    assert.equal(bundle.errors.length, 1, "repeated failures must update the branch's existing report");
    assert.match(bundle.errors[0], /temporary second branch read failure/);
    failure = "";
    assert.equal(bundle.run("hello.jsx"), "After Effects 26.5-test; unsaved project");
    assert.equal(bundle.entries["hello.jsx"].state, "ok");
    assert.equal(bundle.entries["hello.jsx"].error, "");
    assert.equal(bundle.errors.length, 0, "a recovered branch cannot remain in the panel error list");
    assert.equal(bundle.status().errors, 0);
    assert.notEqual(bundle.status().state, "error");
    assert.doesNotMatch(bundle.describe(), /Scripts ERROR/);
});

test("transient bundle read failure recovers even when the file stamp is unchanged", () => {
    const host = mockHost(), bundle = host.bridge.bundle, originalOpen = host.File.prototype.open;
    const stamp = bundle.fileStamp;
    host.File.prototype.open = function (mode) {
        if (this.fsName === bridgePath && mode === "r") { throw new Error("temporary bundle read failure"); }
        return originalOpen.call(this, mode);
    };
    assert.throws(() => bundle.refresh(true), /temporary bundle read failure/);
    assert.equal(bundle.status().state, "error");
    assert.equal(bundle.fileStamp, stamp);
    host.File.prototype.open = originalOpen;
    assert.equal(bundle.refresh(false), true, "the unchanged-stamp shortcut must not preserve a transient read error");
    assert.equal(bundle.fileStamp, stamp);
    assert.equal(bundle.error, "");
    assert.equal(bundle.status().errors, 0);
    assert.notEqual(bundle.status().state, "error");
    assert.equal(bundle.run("hello.jsx"), "After Effects 26.5-test; unsaved project");
});

test("bundled job executes once and preserves its return value when publication retries", () => {
    const host = mockHost(), bridge = host.connect(), bundle = bridge.bundle;
    let calls = 0;
    const run = bundle.run;
    bundle.run = function (name) { calls++; return run.call(this, name); };
    const job = host.job("bundle-job-0001");
    host.put(job.fsName, host.textAt(job.fsName).replace("test-job.jsx", "hello.jsx"));
    host.failPublication(3);
    bridge.processJob(job);
    while (bridge.pendingReport) { bridge.publishPendingReport(); }
    const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-bundle-job-0001.json"));
    assert.equal(status.state, "success");
    assert.equal(status.result, "After Effects 26.5-test; unsaved project");
    assert.equal(calls, 1);
});

test("nested legacy evalFile calls route to bundled branches", () => {
    const host = mockHost(), bundle = host.bridge.bundle;
    assert.equal(bundle.evalFile(new host.File(aeWorkspace + "/jsx/hello.jsx")), "After Effects 26.5-test; unsaved project");
    assert.equal(vm.runInContext(bundle.prepare("$.evalFile(new File('" + aeWorkspace + "/jsx/hello.jsx'));"), host.context),
        "After Effects 26.5-test; unsaved project");
    assert.throws(() => bundle.evalFile(new host.File(aeWorkspace + "/jsx/missing.jsx")), /missing/);
    assert.throws(() => bundle.evalFile(new host.File(aeWorkspace + "/jsx/../hello.jsx")), /Invalid/);
});

test("live validation detects corrupt payload and selected branches refuse execution", () => {
    const host = mockHost(), bundle = host.bridge.bundle;
    const entry = bundle.entries["hello.jsx"], position = bundle.payloadOffset + entry.offset;
    const original = fs.readFileSync(path.join(workspace, "jsx/Codex Bridge.jsx"), "utf8");
    host.put(bridgePath, damageBundleByte(original, position));
    bundle.refresh(true);
    assert.throws(() => bundle.run("hello.jsx"), /checksum/);
    while (bundle.checked < bundle.names.length) { bundle.tick(); }
    assert.equal(bundle.status().state, "error");
    assert.match(bundle.errors.join("\n"), /hello\.jsx.*checksum/);
});

test("corrupt shared modules block every dependent branch and appear in live checks", () => {
    const host = mockHost(), bundle = host.bridge.bundle;
    const shared = Array.from(moduleUsers(bundle)).find(([, names]) => names.length >= 2);
    assert.ok(shared, "the merged bundle must physically share source across branch names");
    const [id, names] = shared, entry = bundle.modules[id];
    const original = fs.readFileSync(path.join(workspace, "jsx/Codex Bridge.jsx"), "utf8");
    host.put(bridgePath, damageBundleByte(original, bundle.payloadOffset + entry.offset));
    bundle.refresh(true);
    for (const name of names) {
        assert.throws(() => bundle.source(name), /checksum/i, name + " must detect damage in " + id);
    }
    assert.throws(() => bundle.run(names[0]), /checksum/i, "source must be verified before branch evaluation");
    while (bundle.checked < bundle.names.length) { bundle.tick(); }
    assert.equal(bundle.status().state, "error");
    for (const name of names) {
        assert.equal(bundle.entries[name].state, "error", name + " must fail live validation");
        assert.match(bundle.entries[name].error, /checksum/i);
    }
    assert.equal(host.executionCount, 0);
});

test("live validation rejects a truncated bundle and a damaged index", () => {
    for (const truncate of [true, false]) {
        const host = mockHost(), bundle = host.bridge.bundle;
        const original = fs.readFileSync(path.join(workspace, "jsx/Codex Bridge.jsx"), "utf8");
        const indexOffset = Number(original.split("\n", 3)[2].split("\t")[3]);
        host.put(bridgePath, truncate ? original.slice(0, -10) : original.slice(0, indexOffset) + "X" + original.slice(indexOffset + 1));
        assert.throws(() => bundle.refresh(true), /size|checksum/);
        assert.equal(bundle.status().state, "error");
        assert.throws(() => bundle.run("hello.jsx"));
    }
});

test("disposed script-status controls cannot interrupt the idle listener or inventory", () => {
    const host = mockHost(), bridge = host.connect(), bundle = bridge.bundle, library = bridge.library;
    let sourceReads = 0, libraryTicks = 0;
    bundle.source = function () { sourceReads++; throw new Error("idle source reconstruction is forbidden"); };
    const normalLibraryTick = library.tick;
    library.tick = function () { libraryTicks++; return normalLibraryTick.call(this); };
    Object.defineProperty(bridge.scriptsText, "text", {
        configurable: true, get() { throw new Error("mock disposed script status"); },
        set() { throw new Error("mock disposed script status"); }
    });
    for (let index = 0; index < 3; index++) { host.advanceTime(2200); host.fireNext(); }
    assert.equal(bridge.scriptsText, null);
    assert.equal(bridge.running, true);
    assert.equal(bridge.ready, true);
    assert.equal(bridge.connectionConnected, true);
    assert.equal(host.scheduled.size, 1);
    assert.equal(JSON.parse(host.textAt(bridge.heartbeatPath)).state, "running");
    assert.equal(bridge.library, library);
    assert.equal(libraryTicks, 3, "inventory must keep advancing after ScriptUI disposal");
    assert.equal(sourceReads, 0);
    assert.equal(host.executionCount, 0);
});

test("connected idle polling never decodes or compiles the full script library", () => {
    const host = mockHost(), bridge = host.connect(), bundle = bridge.bundle;
    let scanCalls = 0, sourceCalls = 0, compilationCalls = 0;
    bundle.tick = function () { scanCalls++; throw new Error("automatic branch scans are forbidden"); };
    bundle.source = function () { sourceCalls++; throw new Error("idle source reconstruction is forbidden"); };
    host.context.Function = function () { compilationCalls++; throw new Error("idle compilation is forbidden"); };
    host.job();
    host.fireNext();
    assert.equal(host.executionCount, 1);
    for (let index = 0; index < 12; index++) { host.fireNext(); }
    assert.equal(scanCalls, 0);
    assert.equal(sourceCalls, 0);
    assert.equal(compilationCalls, 0);
    assert.equal(bundle.checked, 0, "installation checks must not turn into recurring branch scans");
    bridge.stop(); host.advanceTime(300000);
    assert.equal(host.scheduled.size, 0);
});

test("source-only bootstrap initializes bundle without opening or stopping the live bridge", () => {
    const host = mockHost(), bridge = host.connect(), generation = bridge.generation;
    host.dollar.global.__CODEX_AE_BUNDLE_ONLY__ = true;
    host.dollar.evalFile(new host.File(bridgePath));
    delete host.dollar.global.__CODEX_AE_BUNDLE_ONLY__;
    assert.equal(host.bridge, bridge);
    assert.equal(bridge.generation, generation);
    assert.equal(bridge.running, true);
    assert.equal(host.dollar.global.__codexAeBundleV1.run("hello.jsx"), "After Effects 26.5-test; unsaved project");
});

let failures = 0;
test("function jobs call installed tools from data and never create JSX", () => {
    const host = mockHost(), bridge = host.connect(), runId = "function-read-0001";
    const request = { schema: "codex-ae-functions/v1", steps: [{ function: "system.info", args: {} }] };
    const jobPath = bridge.inboxPath + "/job-" + runId + ".job";
    host.put(jobPath, "schema=codex-ae-job/v2\nrunId=" + runId + "\nsessionNonce=" + bridge.sessionNonce + "\nrequest=" + encodeURIComponent(JSON.stringify(request)) + "\n");
    bridge.processJob(new host.File(jobPath));
    const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-" + runId + ".json"));
    assert.equal(status.state, "success");
    const result = JSON.parse(status.result);
    assert.equal(result.results[0].function, "system.info");
    assert.equal(result.results[0].value.version, "26.5-test");
    assert.equal(host.executionCount, 0);
    assert.ok(host.writes.every(file => !/\.jsx$/i.test(file)), "tool requests cannot generate JSX files");
    assert.equal(host.dollar.global.__CODEX_AE_RUN_CONTEXT__, undefined);
});
test("function jobs execute once when terminal report publication fails", () => {
    const host = mockHost(), bridge = host.connect(), runId = "function-once-0001";
    let calls = 0;
    const normalRun = bridge.functions.run;
    bridge.functions.run = function (request, context) { calls++; return normalRun(request, context); };
    const jobPath = bridge.inboxPath + "/job-" + runId + ".job";
    host.put(jobPath, "schema=codex-ae-job/v2\nrunId=" + runId + "\nsessionNonce=" + bridge.sessionNonce + "\nrequest=" + encodeURIComponent(JSON.stringify({ schema: "codex-ae-functions/v1", steps: [{ function: "system.info", args: {} }] })) + "\n");
    host.failPublication(4);
    bridge.processJob(new host.File(jobPath));
    assert.equal(calls, 1); assert.ok(bridge.pendingReport);
    host.fireNext();
    assert.equal(calls, 1); assert.equal(bridge.pendingReport, null);
    assert.equal(JSON.parse(host.textAt(bridge.resultsPath + "/status-" + runId + ".json")).state, "success");
});
test("invalid function plans are rejected before execution without evaluating JSON code", () => {
    const invalid = [
        '{"schema":"codex-ae-functions/v1","steps":[{"function":"eval","args":{"code":"app.project.save()"}}]}',
        '{"schema":"codex-ae-functions/v1","steps":[],"steps":[]}',
        '{"schema":"codex-ae-functions/v1","steps":[{"function":"system.info","args":{"__proto__":{}}}]}',
        'app.project.save()',
        JSON.stringify({ schema: "codex-ae-functions/v1", steps: [{ function: "system.info", args: {} }, { function: "unknown.tool", args: {} }] })
    ];
    invalid.forEach((requestText, index) => {
        const host = mockHost(), bridge = host.connect(), runId = "invalid-function-000" + index;
        const jobPath = bridge.inboxPath + "/job-" + runId + ".job";
        host.put(jobPath, "schema=codex-ae-job/v2\nrunId=" + runId + "\nsessionNonce=" + bridge.sessionNonce + "\nrequest=" + encodeURIComponent(requestText) + "\n");
        bridge.functions.run = function () { throw new Error("invalid request must not execute"); };
        bridge.processJob(new host.File(jobPath));
        const status = JSON.parse(host.textAt(bridge.resultsPath + "/status-" + runId + ".json"));
        assert.equal(status.errorCode, "JOB_REJECTED");
        assert.equal(new host.File(bridge.resultsPath + "/started-" + runId + ".json").exists, false);
        assert.equal(host.executionCount, 0);
    });
});
test("function registry exposes every preserved branch without decoding source", () => {
    const host = mockHost(), bridge = host.connect();
    bridge.bundle.source = function () { throw new Error("listing must not decode source"); };
    assert.ok(bridge.functions.list().every(entry => !entry.legacy && entry.name !== "script.run"));
    const entries = bridge.functions.list(true);
    const legacy = entries.filter(entry => entry.legacy);
    assert.equal(legacy.length, bridge.bundle.names.length);
    assert.deepEqual(Array.from(legacy, entry => entry.branch), Array.from(bridge.bundle.names));
    assert.ok(entries.some(entry => entry.name === "layer.text.create" && !entry.legacy));
    assert.equal(JSON.parse(host.textAt(bridge.heartbeatPath)).functions.catalogRelativePath, ".ae-codex/functions/catalog.json");
});
for (const { name, run } of tests) {
    try { run(); console.log("PASS " + name); }
    catch (error) { failures += 1; console.error("FAIL " + name + "\n" + error.stack); }
}
console.log(`${tests.length - failures}/${tests.length} bridge tests passed`);
process.exitCode = failures ? 1 : 0;
