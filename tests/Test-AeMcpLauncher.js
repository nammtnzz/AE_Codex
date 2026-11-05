/* Stable launcher follows installation.json across upgrades without a Codex reload. */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const launcher = path.join(__dirname, "..", "tools", "AeFunctionsMcpLauncher.js");
const fixtureServer = `"use strict";
const rl = require("node:readline").createInterface({ input: process.stdin });
let inits = 0;
rl.on("line", line => { const m = JSON.parse(line); if (m.method === "initialize") inits++;
  if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { root: __dirname, inits } }) + "\\n"); });
`;

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ae-launcher-"));
    try {
        for (const id of ["1.0.0-a", "2.0.0-b"]) {
            fs.mkdirSync(path.join(root, "versions", id, "tools"), { recursive: true });
            fs.writeFileSync(path.join(root, "versions", id, "tools", "AeFunctionsMcp.js"), fixtureServer);
        }
        const select = id => fs.writeFileSync(path.join(root, "installation.json"), JSON.stringify({ schema: "codex-ae-installation/v1", runtimeRoot: path.join(root, "versions", id) }));
        select("1.0.0-a");
        const proc = spawn(process.execPath, [launcher], { env: { ...process.env, CODEX_AE_INSTALL_ROOT: root }, stdio: ["pipe", "pipe", "inherit"] });
        const lines = readline.createInterface({ input: proc.stdout });
        const queue = [];
        let waiter = null;
        lines.on("line", line => { const m = JSON.parse(line); if (waiter) { const w = waiter; waiter = null; w(m); } else queue.push(m); });
        const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { waiter = resolve; });
        const send = m => proc.stdin.write(JSON.stringify(m) + "\n");

        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        assert.strictEqual((await next()).result.inits, 1, "first runtime is initialized exactly once");
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        assert.ok((await next()).result.root.includes("1.0.0-a"));

        select("2.0.0-b");
        fs.rmSync(path.join(root, "versions", "1.0.0-a"), { recursive: true, force: true });
        send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
        assert.strictEqual((await next()).method, "notifications/tools/list_changed");
        const switched = await next();
        assert.strictEqual(switched.id, 3);
        assert.ok(switched.result.root.includes("2.0.0-b"), "upgrade is followed without a reload");
        assert.strictEqual(switched.result.inits, 1, "new runtime receives the replayed initialize");

        // AE panel still on an older runtime: jobs follow the live heartbeat, not installation.json.
        for (const id of ["3.0.0-aaaaaaaaaaaa", "4.0.0-bbbbbbbbbbbb"]) {
            fs.mkdirSync(path.join(root, "versions", id, "tools"), { recursive: true });
            fs.writeFileSync(path.join(root, "versions", id, "tools", "AeFunctionsMcp.js"), fixtureServer);
        }
        const heartbeat = (id, state, age) => {
            fs.mkdirSync(path.join(root, "versions", id, ".ae-codex", "bridge"), { recursive: true });
            fs.writeFileSync(path.join(root, "versions", id, ".ae-codex", "bridge", "heartbeat.json"), JSON.stringify({ state, timestampEpochMs: Date.now() - age }));
        };
        select("4.0.0-bbbbbbbbbbbb");
        heartbeat("3.0.0-aaaaaaaaaaaa", "running", 1000);
        send({ jsonrpc: "2.0", id: 10, method: "tools/list" });
        assert.strictEqual((await next()).method, "notifications/tools/list_changed");
        assert.ok((await next()).result.root.includes("3.0.0-aaaaaaaaaaaa"), "routes to the runtime the AE panel is polling");
        heartbeat("4.0.0-bbbbbbbbbbbb", "running", 500);
        send({ jsonrpc: "2.0", id: 11, method: "tools/list" });
        assert.strictEqual((await next()).method, "notifications/tools/list_changed");
        assert.ok((await next()).result.root.includes("4.0.0-bbbbbbbbbbbb"), "after the panel reconnects, the installed runtime wins");
        heartbeat("4.0.0-bbbbbbbbbbbb", "running", 120000);
        heartbeat("3.0.0-aaaaaaaaaaaa", "stopped", 0);
        send({ jsonrpc: "2.0", id: 12, method: "tools/list" });
        assert.ok((await next()).result.root.includes("4.0.0-bbbbbbbbbbbb"), "with no live panel, installation.json decides");

        fs.writeFileSync(path.join(root, "installation.json"), "{}");
        send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
        assert.ok((await next()).error.message.includes("installation.json"), "broken metadata answers with an error instead of hanging");

        proc.stdin.end();
        await new Promise(resolve => proc.on("exit", resolve));
        console.log("PASS Test-AeMcpLauncher");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
