/* Stable MCP entry for Codex. Installed once at <InstallRoot>/AeFunctionsMcp.js so
   config.toml never points into versions/<id>. Each request is routed to the
   runtime named by installation.json; an upgrade or a deleted runtime is picked
   up without editing Codex settings or reloading MCP. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const installRoot = process.env.CODEX_AE_INSTALL_ROOT ? path.resolve(process.env.CODEX_AE_INSTALL_ROOT) : __dirname;
const metadataPath = path.join(installRoot, "installation.json");
const replayId = "__codex_ae_launcher_init__";
let child = null, childRoot = null, childLines = null;
let initializeParams = null, initialized = false;
const pending = new Map();

function write(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
function fail(id, text) { if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, error: { code: -32603, message: text } }); }

const LIVE_MS = 30000;
// The panel in AE may still run an older runtime until it reconnects. Jobs must go to the
// bridge AE is actually polling, so a live heartbeat wins over installation.json.
function liveSince(runtimeRoot) {
    try {
        const heartbeat = JSON.parse(fs.readFileSync(path.join(runtimeRoot, ".ae-codex", "bridge", "heartbeat.json"), "utf8"));
        const age = Date.now() - heartbeat.timestampEpochMs;
        return heartbeat.state !== "stopped" && Number.isFinite(age) && age >= -LIVE_MS && age < LIVE_MS ? heartbeat.timestampEpochMs : 0;
    } catch (_) { return 0; }
}
function activeRuntime() {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (!metadata || metadata.schema !== "codex-ae-installation/v1" || typeof metadata.runtimeRoot !== "string") throw new Error("installation.json is invalid; run the Codex AE installer again.");
    const versions = path.join(installRoot, "versions");
    let runtimeRoot = path.resolve(metadata.runtimeRoot);
    const relative = path.relative(versions, runtimeRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Active runtime is outside the installation versions folder.");
    if (!liveSince(runtimeRoot)) {
        let newest = 0;
        for (const name of fs.readdirSync(versions)) {
            if (!/^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(name)) continue;
            const candidate = path.join(versions, name), since = liveSince(candidate);
            if (since > newest && fs.existsSync(path.join(candidate, "tools", "AeFunctionsMcp.js"))) { newest = since; runtimeRoot = candidate; }
        }
    }
    const server = path.join(runtimeRoot, "tools", "AeFunctionsMcp.js");
    if (!fs.existsSync(server)) throw new Error("Active runtime is missing its MCP server: " + server);
    return { runtimeRoot, server };
}

function stopChild() {
    if (!child) return;
    const old = child;
    child = null; childRoot = null;
    if (childLines) { childLines.close(); childLines = null; }
    old.removeAllListeners("exit");
    try { old.stdin.end(); old.kill(); } catch (_) {}
}

function startChild(runtime) {
    stopChild();
    const started = spawn(process.execPath, [runtime.server], { cwd: installRoot, env: process.env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    child = started; childRoot = runtime.runtimeRoot;
    childLines = readline.createInterface({ input: started.stdout, crlfDelay: Infinity });
    childLines.on("line", line => {
        let message;
        try { message = JSON.parse(line); } catch (_) { process.stdout.write(line + "\n"); return; }
        if (message && message.id === replayId) return;
        if (message && message.id !== undefined && (message.result !== undefined || message.error !== undefined)) pending.delete(message.id);
        write(message);
    });
    started.stdin.on("error", () => {});
    started.on("exit", () => {
        if (child !== started) return;
        child = null; childRoot = null;
        // Never leave Codex waiting on a request the dead runtime will not answer.
        for (const id of pending.keys()) fail(id, "AE runtime stopped; the request was not completed. Do not retry automatically.");
        pending.clear();
    });
    if (initializeParams) {
        started.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: replayId, method: "initialize", params: initializeParams }) + "\n");
        if (initialized) started.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    }
}

function route(message) {
    let runtime;
    try { runtime = activeRuntime(); }
    catch (error) {
        if (message.id !== undefined) fail(message.id, error.message);
        return;
    }
    const switched = child && childRoot !== runtime.runtimeRoot;
    if (!child || switched) startChild(runtime);
    if (switched && initialized) write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    if (message.id !== undefined && message.method) pending.set(message.id, true);
    child.stdin.write(JSON.stringify(message) + "\n");
    // Recorded after forwarding so the first runtime is not initialized twice.
    if (message.method === "initialize") initializeParams = message.params;
    if (message.method === "notifications/initialized") initialized = true;
}

if (require.main === module) {
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", line => {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); } catch (_) { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
        route(message);
    });
    // Let the runtime finish answering queued requests before exiting.
    input.on("close", () => {
        if (!child) process.exit(0);
        child.on("exit", () => process.exit(0));
        child.stdin.end();
    });
}
module.exports = { activeRuntime };
