"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { analyzeCapabilities } = require("../tools/AeScriptCapabilities.js");
const workspaceRoot = path.resolve(__dirname, "..");
const fixtureRoot = path.join(workspaceRoot, ".ae-codex/tests/mcp-" + process.pid + "-" + Date.now());
const fixtureTools = path.join(fixtureRoot, "tools");
const fixtureFunctions = path.join(fixtureRoot, ".ae-codex/functions");
fs.mkdirSync(fixtureTools, { recursive: true });
fs.mkdirSync(fixtureFunctions, { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, "jsx"));
fs.writeFileSync(path.join(fixtureRoot, "jsx/Codex Bridge.jsx"), "// fixture only\n");
fs.copyFileSync(path.join(workspaceRoot, "tools/AeFunctionsMcp.js"), path.join(fixtureTools, "AeFunctionsMcp.js"));
assert.match(fs.readFileSync(path.join(fixtureTools, "AeFunctionsMcp.js"), "utf8"),
    /"-ExecutionPolicy",\s*"Bypass",\s*"-File"/,
    "MCP must launch its unsigned local PowerShell client with process-scoped ExecutionPolicy Bypass");
for (const name of ["AeCapabilities.js", "AeScriptSource.js"]) {
    fs.copyFileSync(path.join(workspaceRoot, "tools", name), path.join(fixtureTools, name));
}
fs.writeFileSync(path.join(fixtureFunctions, "catalog.json"), JSON.stringify({
    schema: "codex-ae-functions-catalog/v1", bridgeVersion: "1.8.0",
    revision: "fixture-revision",
    functions: [
        { name: "project.inspect", description: "Read project items", args: { maxItems: "optional integer" }, mutates: false },
        { name: "layer.text.create", description: "Create text", args: { text: "string" }, mutates: true },
        { name: "script.run", description: "Preserved branch", args: { branch: "installed branch name" }, mutates: true }
    ],
    legacyBranches: [{ name: "hello.jsx", function: "script.run", args: { branch: "hello.jsx" }, description: "Legacy hello" }]
}));
const fixtureSource = { schema: "codex-ae-scripts/v1", branches: { "hello.jsx": "/* Fixture greeting */ (function () { return 'hello'; }());\n" } };
const fixtureInventory = { names: ["hello.jsx"] };
const sourceText = JSON.stringify(fixtureSource), inventoryText = JSON.stringify(fixtureInventory);
const hash = value => createHash("sha256").update(value).digest("hex");
fs.mkdirSync(path.join(fixtureRoot, "source"));
fs.writeFileSync(path.join(fixtureRoot, "source/scripts.json"), sourceText);
fs.writeFileSync(path.join(fixtureRoot, "source/script-inventory.json"), inventoryText);
fs.writeFileSync(path.join(fixtureRoot, "jsx/Codex Bridge.jsx"), '#target aftereffects\n#targetengine "fixture"\n// CODEX_AE_BUNDLE_V2\tfixture-revision\n');
const fixtureCapabilities = analyzeCapabilities(fixtureSource, { inventoryNames: fixtureInventory.names });
Object.assign(fixtureCapabilities, { revision: "fixture-revision", sourceFileSha256: hash(sourceText), inventoryFileSha256: hash(inventoryText) });
fs.writeFileSync(path.join(fixtureFunctions, "capabilities.json"), JSON.stringify(fixtureCapabilities));
// Only this isolated stub is ever launched by the positive dispatch test.
fs.writeFileSync(path.join(fixtureTools, "Invoke-AeFunction.ps1"),
    'param([string]$Plan,[switch]$AsToolOutput,[int]$TimeoutSeconds)\n' +
    '$request = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json -AsHashtable\n' +
    '[ordered]@{state="success";result=$request;fixtureOnly=$true} | ConvertTo-Json -Depth 32 -Compress\n');

function client(serverPath) {
    const child = spawn(process.execPath, [serverPath], { cwd: fixtureRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let sequence = 0, stderr = "";
    const pending = new Map();
    const unexpected = [];
    child.stderr.on("data", chunk => { stderr += chunk; });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
        let value;
        try { value = JSON.parse(line); }
        catch (error) { unexpected.push({ line, error }); return; }
        const task = pending.get(value.id);
        if (!task) { unexpected.push(value); return; }
        clearTimeout(task.timer);
        pending.delete(value.id);
        task.resolve(value);
    });
    child.on("exit", (code, signal) => {
        for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("MCP server exited: " + code + "/" + signal + "; " + stderr)); }
        pending.clear();
    });
    function sendLine(text, id) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP response timeout for " + id + "; " + stderr)); }, 4000);
            pending.set(id, { resolve, reject, timer });
            child.stdin.write(text + "\n");
        });
    }
    return {
        child, unexpected,
        send(method, params) { const id = ++sequence; return sendLine(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }), id); },
        raw(text) { return sendLine(text, null); },
        notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); },
        close() { child.stdin.end(); return new Promise(resolve => { if (child.exitCode !== null) { resolve(); } else { child.once("exit", resolve); } }); }
    };
}

(async function () {
    let transport;
    let groups = 0;
    try {
        const api = require(path.join(fixtureTools, "AeFunctionsMcp.js"));
        assert.equal(api.toolName("layer.text.create"), "ae_layer_text_create");
        const directList = await api.callTool("ae_list_functions");
        assert.equal(directList.functions.length, 3);
        const directLegacy = await api.callTool("ae_list_functions", { search: "HELLO", includeLegacy: true });
        assert.equal(directLegacy.functions.length, 1);
        assert.equal(directLegacy.functions[0].args.branch, "hello.jsx");
        assert.throws(() => api.assertData(JSON.parse('{"__proto__":{}}')), /Reserved request key/);
        groups++;

        transport = client(path.join(fixtureTools, "AeFunctionsMcp.js"));
        const initialized = await transport.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
        assert.equal(initialized.jsonrpc, "2.0");
        assert.equal(initialized.result.serverInfo.name, "ae-functions");
        assert.equal(initialized.result.serverInfo.version, "1.8.0");
        assert.ok(initialized.result.capabilities.tools);
        transport.notify("notifications/initialized");
        assert.deepEqual((await transport.send("ping")).result, {});
        groups++;

        const list = (await transport.send("tools/list")).result.tools;
        assert.equal(list.length, 9);
        assert.deepEqual(list.map(tool => tool.name), ["ae_search_capabilities", "ae_inspect_capability", "ae_run_capability", "ae_capability_status", "ae_list_functions", "ae_run_plan", "ae_project_inspect", "ae_layer_text_create", "ae_script_run"]);
        assert.equal(list.find(tool => tool.name === "ae_project_inspect").annotations.readOnlyHint, true);
        assert.equal(list.find(tool => tool.name === "ae_layer_text_create").annotations.readOnlyHint, false);
        assert.ok(list.find(tool => tool.name === "ae_run_plan").description.includes("Never automatically retry"));
        groups++;

        const readOnly = (await transport.send("tools/call", { name: "ae_list_functions", arguments: {} })).result;
        assert.equal(readOnly.isError, false);
        assert.equal(JSON.parse(readOnly.content[0].text).functions.length, 3);
        const searched = (await transport.send("tools/call", { name: "ae_list_functions", arguments: { search: "hello", includeLegacy: true } })).result;
        const result = JSON.parse(searched.content[0].text);
        assert.equal(result.functions.length, 1);
        assert.equal(result.functions[0].function, "script.run");
        groups++;

        const nativeSearch = (await transport.send("tools/call", { name: "ae_search_capabilities", arguments: {} })).result;
        assert.ok(JSON.parse(nativeSearch.content[0].text).results.every(item => item.kind === "function"));
        const capabilitySearch = (await transport.send("tools/call", { name: "ae_search_capabilities", arguments: { query: "hello", kind: "script" } })).result;
        const found = JSON.parse(capabilitySearch.content[0].text);
        assert.equal(found.total, 1);
        const capabilityId = found.results[0].id;
        const capabilityDetail = (await transport.send("tools/call", { name: "ae_inspect_capability", arguments: { id: capabilityId, includeSource: true } })).result;
        assert.equal(JSON.parse(capabilityDetail.content[0].text).source.text, fixtureSource.branches["hello.jsx"]);
        const capabilityHealth = (await transport.send("tools/call", { name: "ae_capability_status", arguments: {} })).result;
        assert.equal(JSON.parse(capabilityHealth.content[0].text).scripts, 1);
        for (const [name, argumentsValue] of [["ae_search_capabilities", { limit: 101 }], ["ae_inspect_capability", { id: "unknown" }],
            ["ae_run_capability", { id: capabilityId, args: { code: "alert(1)" } }], ["ae_capability_status", { extra: true }]]) {
            const invalid = (await transport.send("tools/call", { name, arguments: argumentsValue })).result;
            assert.equal(invalid.isError, true);
        }
        assert.equal(fs.existsSync(path.join(fixtureFunctions, "requests")), false, "Capability discovery and invalid calls never dispatch");
        groups++;

        const unknown = (await transport.send("tools/call", { name: "ae_missing_function", arguments: {} })).result;
        assert.equal(unknown.isError, true);
        assert.match(unknown.content[0].text, /Unknown installed tool/);
        const reserved = (await transport.send("tools/call", { name: "ae_project_inspect", arguments: JSON.parse('{"constructor":{}}') })).result;
        assert.equal(reserved.isError, true);
        assert.match(reserved.content[0].text, /Reserved request key/);
        for (const malformedArgs of [["not an object"], null, false, 0, ""]) {
            const malformedCall = (await transport.send("tools/call", { name: "ae_list_functions", arguments: malformedArgs })).result;
            assert.equal(malformedCall.isError, true, "Non-object tool arguments must fail without dispatch");
        }
        for (const malformedList of [{ includeLegacy: "false" }, { search: 1 }, { extra: true }]) {
            const malformedCall = (await transport.send("tools/call", { name: "ae_list_functions", arguments: malformedList })).result;
            assert.equal(malformedCall.isError, true, "Malformed catalog options must fail without dispatch");
        }
        for (const malformedPlan of [{}, { steps: [] }, { steps: [{ function: "unknown.call", args: {} }] },
            { steps: [{ function: "project.inspect", args: [], code: "alert(1)" }] },
            { steps: Array.from({ length: 101 }, () => ({ function: "project.inspect", args: {} })) }]) {
            const malformedCall = (await transport.send("tools/call", { name: "ae_run_plan", arguments: malformedPlan })).result;
            assert.equal(malformedCall.isError, true, "Malformed plans must fail without dispatch");
        }
        groups++;

        const parseFailure = await transport.raw("{broken-json");
        assert.equal(parseFailure.error.code, -32700);
        for (const malformed of ["null", '[]', '"not a request"']) {
            const response = await transport.raw(malformed);
            assert.equal(response.error.code, -32600, "Malformed JSON-RPC must not stop the server");
            assert.deepEqual((await transport.send("ping")).result, {});
        }
        const missingMethod = await transport.send("missing/method");
        assert.equal(missingMethod.error.code, -32601);
        groups++;

        assert.deepEqual(fs.readdirSync(path.join(fixtureRoot, "jsx")), ["Codex Bridge.jsx"]);
        assert.equal(fs.existsSync(path.join(fixtureFunctions, "requests")), false, "Read-only/invalid calls must not write a plan or call AE");
        const dispatched = (await transport.send("tools/call", { name: "ae_run_capability", arguments: { id: capabilityId } })).result;
        assert.equal(dispatched.isError, false);
        const dispatchValue = JSON.parse(dispatched.content[0].text);
        assert.equal(dispatchValue.fixtureOnly, true);
        assert.deepEqual(dispatchValue.result, { schema: "codex-ae-functions/v1", steps: [{ function: "script.run", args: { branch: "hello.jsx" } }] });
        assert.equal(fs.readdirSync(path.join(fixtureFunctions, "requests")).length, 1, "Named capability creates one data request only");
        assert.deepEqual(fs.readdirSync(path.join(fixtureRoot, "jsx")), ["Codex Bridge.jsx"]);
        assert.deepEqual(transport.unexpected, [], "MCP stdout must contain only matched JSON-RPC responses");
        groups++;
        await transport.close();
        transport = null;
        process.stdout.write("AE functions MCP tests passed: " + groups + " groups (isolated catalog; no AE calls).\n");
    } finally {
        if (transport) { await transport.close(); }
        const allowed = path.join(workspaceRoot, ".ae-codex/tests") + path.sep;
        if (!path.resolve(fixtureRoot).startsWith(allowed)) { throw new Error("Unsafe fixture cleanup path"); }
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
