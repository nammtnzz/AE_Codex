"use strict";

// Fault injection and Windows sharing tests use only isolated fixture files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawn} = require("node:child_process");
const api = require("../tools/AeCodexChatHost.js");
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function bounded(promise, timeout, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeout);
        promise.then(value => {clearTimeout(timer); resolve(value);}, error => {clearTimeout(timer); reject(error);});
    });
}
const fixture = path.resolve(__dirname, "..", ".ae-codex", "tests", "chat-publication-regression-" + crypto.randomUUID());
fs.mkdirSync(fixture, {recursive: true});
const passed = [], liveHosts = new Set();
function read(file) {return JSON.parse(fs.readFileSync(file, "utf8"));}
async function until(predicate, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {if (predicate()) return; await wait(20);}
    assert.ok(predicate(), "Fixture condition did not become true within " + timeout + " ms");
}
function fresh(name) {
    const runtime = path.join(fixture, name); fs.mkdirSync(runtime);
    const host = new api.ChatHost(runtime); host.setup(); liveHosts.add(host);
    host.state.sessionNonce = "session-publication-fixture";
    return host;
}
function submit(host, label, action = "fixtureOnly") {
    const request = {schema: "codex-ae-chat-request/v1", id: "request-" + label + "-" + crypto.randomUUID(),
        sessionNonce: host.state.sessionNonce, action, args: {}, createdAtEpochMs: Date.now()};
    api.atomic(path.join(host.dir, "requests", request.id + ".json"), request, true);
    api.atomic(path.join(host.dir, "pending.json"), {schema: "codex-ae-chat-pending/v1", requestId: request.id,
        sessionNonce: request.sessionNonce, workspaceRoot: host.workspace, timestampEpochMs: request.createdAtEpochMs});
    return {...request, resultPath: path.join(host.dir, "results", request.id + ".json"), startedPath: path.join(host.dir, "started", request.id + ".json")};
}
function shareError(syscall) {return Object.assign(new Error("PRIVATE-FIXTURE-PATH-AND-CONTENT"), {code: "EPERM", syscall});}
async function withPatch(name, replacement, run) {
    const original = fs[name]; fs[name] = (...args) => replacement(original, ...args);
    try {return await run();} finally {fs[name] = original;}
}
async function lockSharedRead(target, run) {
    const id = crypto.randomUUID(), ready = path.join(fixture, id + ".ready"), release = path.join(fixture, id + ".release");
    const script = path.join(fixture, "hold-shared-reader.ps1");
    if (!fs.existsSync(script)) fs.writeFileSync(script, [
        "param([string]$Target,[string]$Ready,[string]$Release)",
        "$reader=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
        "try {", "  [IO.File]::WriteAllText($Ready,'ready')", "  $deadline=[datetime]::UtcNow.AddSeconds(12)",
        "  while(-not [IO.File]::Exists($Release) -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 20}",
        "} finally {$reader.Dispose()}"
    ].join("\n") + "\n");
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-Target", target, "-Ready", ready, "-Release", release],
        {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    child.stdout.resume(); child.stderr.resume();
    let spawnError; child.on("error", error => {spawnError = error;});
    const exited = new Promise(resolve => child.once("exit", code => resolve(code)));
    try {
        await until(() => fs.existsSync(ready) || spawnError || child.exitCode !== null, 5000);
        if (spawnError) throw spawnError;
        assert.ok(fs.existsSync(ready), "The real Windows shared-read fixture could not acquire its own file");
        return await run();
    } finally {
        fs.writeFileSync(release, "release\n");
        const code = await bounded(exited, 13000, "Shared-read fixture did not release within its deadline");
        assert.equal(code, 0, "Shared-read fixture must release and exit without terminating any process");
    }
}
async function close(host) {await host.stop(); if (host.drainPublications) await host.drainPublications(250); liveHosts.delete(host);}
async function check(name, run) {await run(); passed.push(name);}

async function main() {
    await check("failed temporary-file write cleans partial data and preserves the prior target", async () => {
        const file = path.join(fixture, "atomic-cleanup.json"); api.atomic(file, {state: "before"});
        let temporaryFd;
        await withPatch("openSync", (original, destination, ...args) => {
            const fd = original(destination, ...args);
            if (typeof destination === "string" && destination.startsWith(file + ".tmp-")) temporaryFd = fd;
            return fd;
        }, async () => {
            await withPatch("writeFileSync", (original, destination, ...args) => {
                if (destination === temporaryFd || typeof destination === "string" && destination.startsWith(file + ".tmp-")) {
                    original(destination, "partial fixture bytes");
                    throw Object.assign(new Error("PRIVATE-FIXTURE-WRITE-FAILURE"), {code: "EIO", syscall: "write"});
                }
                return original(destination, ...args);
            }, async () => {assert.throws(() => api.atomic(file, {state: "after"}), {code: "EIO"});});
        });
        assert.deepEqual(read(file), {state: "before"});
        assert.equal(fs.readdirSync(fixture).filter(name => name.startsWith("atomic-cleanup.json.tmp-")).length, 0);
    });
    await check("mutable snapshots recover from transient sharing errors with latest state only", async () => {
        const host = fresh("latest-state"), stateFile = path.join(host.dir, "state.json"); host.state.status = "initial"; host.save();
        let blocked = true;
        await withPatch("renameSync", (original, source, destination) => {if (destination === stateFile && blocked) throw shareError("rename"); return original(source, destination);}, async () => {
            host.state.status = "intermediate"; assert.doesNotThrow(() => host.save());
            host.state.status = "latest"; host.save();
            assert.equal(read(stateFile).status, "initial");
            assert.ok(host.publications.size <= 2);
            await wait(70); blocked = false;
            await until(() => read(stateFile).status === "latest");
        });
        assert.equal(host.publications.size, 0);
        assert.ok(host.metrics.publicationSuperseded >= 1);
        assert.equal(fs.readdirSync(host.dir).filter(name => name.includes(".tmp-")).length, 0);
        await close(host);
    });
    if (process.platform === "win32") {
        await check("real Windows FileShare.Read cannot crash state publication or restore an older snapshot", async () => {
            const host = fresh("real-shared-state"), stateFile = path.join(host.dir, "state.json"); host.state.status = "before reader"; host.save();
            await lockSharedRead(stateFile, async () => {
                host.state.status = "first pending"; assert.doesNotThrow(() => host.save());
                host.state.status = "newest pending"; assert.doesNotThrow(() => host.save());
                await wait(90);
                assert.equal(read(stateFile).status, "before reader");
                assert.ok(host.publications.size <= 2);
            });
            await until(() => read(stateFile).status === "newest pending");
            assert.equal(host.publications.size, 0);
            await close(host);
        });
    }
    await check("mutable heartbeat and state queues remain bounded independently", async () => {
        const host = fresh("mutable-bound"), destinations = new Set([path.join(host.dir, "state.json"), path.join(host.dir, "host.json")]);
        let blocked = true;
        await withPatch("renameSync", (original, source, destination) => {if (destinations.has(destination) && blocked) throw shareError("rename"); return original(source, destination);}, async () => {
            for (let index = 0; index < 200; index++) {host.state.status = "snapshot-" + index; host.save(); host.heartbeat();}
            assert.equal(host.publications.size, 2);
            blocked = false; await host.drainPublications(1500);
            assert.equal(read(path.join(host.dir, "state.json")).status, "snapshot-199");
            assert.equal(read(path.join(host.dir, "host.json")).state, "running");
        });
        await close(host);
    });
    await check("terminal success publication retries preserve exact outcome without dispatch replay", async () => {
        const host = fresh("terminal-success"), request = submit(host, "success"); let actions = 0, blocked = true;
        host.action = async () => {actions += 1; host.state.status = "actual action complete"; host.save();};
        await withPatch("linkSync", (original, source, destination) => {if (destination === request.resultPath && blocked) throw shareError("link"); return original(source, destination);}, async () => {
            await host.poll();
            assert.equal(actions, 1); assert.ok(fs.existsSync(request.startedPath)); assert.ok(!fs.existsSync(request.resultPath));
            for (let index = 0; index < 3; index++) {host.consumedPointer = null; await host.poll();}
            assert.equal(actions, 1);
            await wait(70); blocked = false; await host.drainPublications(1500);
        });
        assert.deepEqual(read(request.resultPath), {schema: "codex-ae-chat-result/v1", id: request.id, sessionNonce: request.sessionNonce, state: "success"});
        host.consumedPointer = null; await host.poll(); assert.equal(actions, 1);
        await close(host);
    });
    await check("actual action error remains the same error through result publication retries", async () => {
        const host = fresh("terminal-error"), request = submit(host, "error"); let actions = 0, blocked = true;
        host.action = async () => {actions += 1; throw Object.assign(new Error("PRIVATE-FIXTURE-ACTION-DETAIL"), {code: "FIXTURE_ACTION_ERROR"});};
        await withPatch("linkSync", (original, source, destination) => {if (destination === request.resultPath && blocked) throw shareError("link"); return original(source, destination);}, async () => {
            await host.poll(); host.consumedPointer = null; await host.poll(); assert.equal(actions, 1);
            blocked = false; await host.drainPublications(1500);
        });
        const result = read(request.resultPath);
        assert.equal(result.state, "error"); assert.equal(result.error.code, "FIXTURE_ACTION_ERROR");
        assert.ok(!JSON.stringify(result).includes("PRIVATE-FIXTURE"));
        await close(host);
    });
    await check("started preflight failure never evaluates an action", async () => {
        const host = fresh("started-preflight"), request = submit(host, "preflight"); let actions = 0;
        host.action = async () => {actions += 1;};
        await withPatch("linkSync", (original, source, destination) => {if (destination === request.startedPath) throw shareError("link"); return original(source, destination);}, async () => {
            await host.poll();
        });
        assert.equal(actions, 0); assert.ok(!fs.existsSync(request.startedPath));
        assert.equal(read(request.resultPath).state, "error"); assert.equal(host.processing, false);
        await close(host);
    });
    await check("pending terminal capacity blocks new dispatch instead of dropping earlier outcomes", async () => {
        const host = fresh("terminal-bound"), requests = []; let actions = 0, blocked = true;
        host.action = async () => {actions += 1;};
        await withPatch("linkSync", (original, source, destination) => {if (path.dirname(destination) === path.join(host.dir, "results") && blocked) throw shareError("link"); return original(source, destination);}, async () => {
            for (let index = 0; index < 8; index++) {requests.push(submit(host, "bound-" + index)); await host.poll();}
            const next = submit(host, "blocked-next"); requests.push(next); await host.poll();
            assert.equal(actions, 8); assert.ok(!fs.existsSync(next.startedPath));
            assert.equal([...host.publications.values()].filter(entry => entry.immutable).length, 8);
            blocked = false; await host.drainPublications(1500); await host.poll();
            assert.equal(actions, 9);
        });
        for (const request of requests) assert.equal(read(request.resultPath).state, "success");
        await close(host);
    });
    await check("Stop during started preflight retry never begins the waiting action afterward", async () => {
        const host = fresh("stop-during-preflight"), request = submit(host, "stopped-preflight"); let actions = 0, blocked = true;
        host.action = async () => {actions += 1;};
        await withPatch("linkSync", (original, source, destination) => {if (destination === request.startedPath && blocked) throw shareError("link"); return original(source, destination);}, async () => {
            const polling = host.poll(); await wait(50);
            const stopping = host.stop(); blocked = false;
            await bounded(Promise.all([polling, stopping]), 4000, "Stopped preflight did not settle");
        });
        assert.equal(actions, 0, "a pending preflight is not permission to dispatch after Stop");
        assert.equal(host.publicationTimer, null);
        liveHosts.delete(host);
    });
    await check("old started markers cannot bypass the bounded terminal publication queue", async () => {
        const host = fresh("old-started-capacity"), requests = []; let actions = 0, blocked = true;
        host.action = async () => {actions += 1;};
        await withPatch("linkSync", (original, source, destination) => {if (path.dirname(destination) === path.join(host.dir, "results") && blocked) throw shareError("link"); return original(source, destination);}, async () => {
            for (let index = 0; index < 9; index++) {
                const request = submit(host, "old-started-" + index); requests.push(request);
                api.atomic(request.startedPath, {schema: "codex-ae-chat-started/v1", id: request.id, action: "fixtureOnly"}, true);
                await host.poll();
            }
            assert.ok([...host.publications.values()].filter(entry => entry.immutable).length <= 8);
            assert.equal(actions, 0);
            blocked = false; await host.drainPublications(1500); host.consumedPointer = null; await host.poll();
        });
        for (const request of requests) assert.equal(read(request.resultPath).error.code, "ALREADY_DISPATCHED");
        await close(host);
    });
    await check("one accepted approval is never repeated when its UI state cannot publish", async () => {
        const host = fresh("approval-with-locked-state"), stateFile = path.join(host.dir, "state.json"); host.save();
        let replies = 0, blocked = true;
        host.rpc = {closed: false, reply() {replies += 1;}, reject() {}, async close() {this.closed = true; return true;}};
        Object.assign(host.state, {connectionState: "connected", activeThreadId: "thread-publication", turnId: "turn-publication", busy: true});
        const request = {id: "approval-publication", method: "mcpServer/elicitation/request", params: {serverName: "ae_functions", threadId: host.state.activeThreadId,
            turnId: host.state.turnId, mode: "form", _meta: {codex_approval_kind: "mcp_tool_call"}, requestedSchema: {type: "object", properties: {}}}};
        await withPatch("renameSync", (original, source, destination) => {if (destination === stateFile && blocked) throw shareError("rename"); return original(source, destination);}, async () => {
            assert.doesNotThrow(() => host.serverRequest(request)); host.serverRequest(request); assert.equal(replies, 1);
            blocked = false; await host.drainPublications(1500);
        });
        assert.equal(host.pending.size, 0); host.state.busy = false; await close(host);
    });
    await check("sanitized publication diagnostics omit paths messages and action content", async () => {
        const host = fresh("diagnostic-privacy"), stateFile = path.join(host.dir, "state.json");
        await withPatch("renameSync", (original, source, destination) => {if (destination === stateFile) throw shareError("rename"); return original(source, destination);}, async () => {
            host.state.status = "PRIVATE-FIXTURE-CHAT-TEXT"; host.save();
        });
        await host.drainPublications(1000);
        const data = fs.readFileSync(path.join(host.dir, "host-errors.jsonl"), "utf8");
        assert.ok(!data.includes("PRIVATE-FIXTURE")); assert.ok(!data.includes(host.workspace));
        for (const line of data.trim().split("\n")) {
            const row = JSON.parse(line);
            assert.ok(Object.keys(row).every(key => ["schema", "timestampEpochMs", "pid", "hostInstanceId", "stage", "code", "syscall"].includes(key)));
        }
        await close(host);
    });
    await check("named disconnect publishes its terminal result once before final publication fence", async () => {
        const host = fresh("disconnect-result"), request = submit(host, "disconnect", "disconnect");
        await host.poll();
        assert.ok(fs.existsSync(request.resultPath), "the acknowledged disconnect action still needs its own immutable result");
        assert.deepEqual(read(request.resultPath), {schema: "codex-ae-chat-result/v1", id: request.id, sessionNonce: request.sessionNonce, state: "success"});
        const before = fs.readFileSync(request.resultPath, "utf8");
        host.consumedPointer = null; await host.poll();
        assert.equal(fs.readFileSync(request.resultPath, "utf8"), before);
        assert.equal(host.state.connectionState, "disconnected");
        host.queueSave();
        assert.equal(host.publishTimer, null, "late stream callbacks cannot schedule a timer after disconnect finalized");
        assert.equal(host.publicationTimer, null);
        liveHosts.delete(host);
    });
    if (process.platform === "win32") {
        await check("real locked heartbeat cannot prevent Stop or publish running after shutdown", async () => {
            const host = fresh("real-shared-heartbeat"), task = host.serve(), heartbeatFile = path.join(host.dir, "host.json");
            await until(() => fs.existsSync(heartbeatFile));
            await lockSharedRead(heartbeatFile, async () => {
                assert.doesNotThrow(() => host.heartbeat());
                api.atomic(path.join(host.dir, "stop"), {schema: "codex-ae-chat-stop/v1", service: true, createdAtEpochMs: Date.now()});
                await wait(900);
            });
            await bounded(task, 4000, "Stop blocked behind shared heartbeat file");
            assert.equal(read(heartbeatFile).state, "stopped");
            assert.equal(read(path.join(host.dir, "state.json")).connectionState, "disconnected");
            assert.equal(host.publicationTimer, null); assert.equal(host.publishTimer, null);
            const finalHeartbeat = fs.readFileSync(heartbeatFile, "utf8");
            host.heartbeat("running"); host.save(); await wait(60);
            assert.equal(fs.readFileSync(heartbeatFile, "utf8"), finalHeartbeat, "late callbacks cannot revive a finalized host");
            assert.equal(host.publicationTimer, null); liveHosts.delete(host);
        });
    }
    return {schema: "codex-ae-chat-publication-tests/v1", state: "success", count: passed.length, passed,
        fixture, realWindowsSharingTests: process.platform === "win32", liveCodexConnection: false, liveAeConnection: false, actionDispatchesAreFixtureCallbacksOnly: true};
}

main().then(result => {fs.writeFileSync(path.join(fixture, "report.json"), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));})
    .catch(async error => {
        for (const host of liveHosts) {try {await host.stop();} catch (_) {}}
        fs.writeFileSync(path.join(fixture, "report.json"), JSON.stringify({state: "error", count: passed.length, passed, error: {message: error.message, stack: error.stack}}, null, 2) + "\n");
        console.error(error); process.exitCode = 1;
    });
