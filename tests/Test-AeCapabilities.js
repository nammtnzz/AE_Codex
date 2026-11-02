"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createCapabilitiesApi } = require("../tools/AeCapabilities.js");
const { analyzeCapabilities } = require("../tools/AeScriptCapabilities.js");
const { expandSource } = require("../tools/AeScriptSource.js");
const root = path.resolve(__dirname, "..");
const fixture = path.join(root, ".ae-codex/tests/capabilities-" + process.pid + "-" + Date.now());
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const source = { schema: "codex-ae-scripts/v1", branches: {
    "hello.jsx": "/* Tiếng Việt: inspect a composition */\r\n(function () {\r\n    var message = '🎬 xin chào';\r\n    if (false) { throw new Error(message); }\r\n    return message;\r\n}());\r\n",
    "long.jsx": '/* long source */\nvar text = "' + "x".repeat(40000) + '";\n',
    "broken.jsx": "function broken( {",
    "missing-dependency.jsx": "$.evalFile(new File('C:/Users/nguye/AE_Codex/jsx/not-installed.jsx'));"
} };
const names = Object.keys(source.branches).sort();
const revision = "a".repeat(64);
const fixturePaths = {
    source: path.join(fixture, "source/scripts.json"),
    inventory: path.join(fixture, "source/script-inventory.json"),
    bundle: path.join(fixture, "jsx/Codex Bridge.jsx"),
    catalog: path.join(fixture, ".ae-codex/functions/catalog.json"),
    capabilities: path.join(fixture, ".ae-codex/functions/capabilities.json")
};
let groups = 0;
function makeFixture() {
    for (const file of Object.values(fixturePaths)) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
    const sourceText = json(source), inventoryText = json({ names });
    fs.writeFileSync(fixturePaths.source, sourceText);
    fs.writeFileSync(fixturePaths.inventory, inventoryText);
    fs.writeFileSync(fixturePaths.bundle, '#target aftereffects\n#targetengine "fixture"\n// CODEX_AE_BUNDLE_V2\t' + revision + "\t0\t0\t0\t0\t4\n// fixture payload A\n");
    const manifest = analyzeCapabilities(source, { inventoryNames: names });
    Object.assign(manifest, { revision, sourceFileSha256: hash(sourceText), inventoryFileSha256: hash(inventoryText) });
    fs.writeFileSync(fixturePaths.capabilities, json(manifest));
    fs.writeFileSync(fixturePaths.catalog, json({ schema: "codex-ae-functions-catalog/v1", bridgeVersion: "1.8.0", revision,
        functions: [
            { name: "project.inspect", description: "Read project", args: {}, mutates: false },
            { name: "comp.create", description: "Create composition", args: { name: "string" }, mutates: true },
            { name: "script.run", description: "Run installed branch", args: { branch: "string" }, mutates: true }
        ], legacyBranches: names.map(name => ({ name, function: "script.run", args: { branch: name } })) }));
    return createCapabilitiesApi(fixture);
}
function rewrite(file, change) {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    change(value);
    fs.writeFileSync(file, json(value));
}
function allPages(api, args) {
    const results = [];
    let offset = 0, total;
    do {
        const page = api.searchCapabilities({ ...args, offset, limit: 37 });
        assert.equal(page.offset, offset);
        assert.ok(page.results.length <= 37);
        if (total === undefined) { total = page.total; } else { assert.equal(page.total, total); }
        results.push(...page.results);
        if (page.nextOffset === null) { break; }
        assert.ok(page.nextOffset > offset);
        offset = page.nextOffset;
    } while (results.length <= total);
    assert.equal(results.length, total);
    return results;
}
try {
    let api = makeFixture();
    const first = api.searchCapabilities();
    assert.equal(first.installed.scripts, 4);
    assert.equal(first.installed.functions, 3);
    assert.equal(first.results.length, 3);
    assert.ok(first.results.every(item => item.kind === "function"));
    assert.equal(api.searchCapabilities({ kind: "all" }).total, 7);
    assert.equal(api.searchCapabilities({ kind: "script", query: "tieng viet" }).results[0].name, "hello.jsx");
    assert.equal(api.searchCapabilities({ kind: "function", category: "project" }).results[0].id, "ae_project_inspect");
    assert.equal(api.searchCapabilities({ kind: "script", query: "nothing-matches-fixture" }).total, 0);
    assert.equal(api.searchCapabilities({ offset: 100 }).nextOffset, null);
    assert.equal(new Set(allPages(api, { kind: "all" }).map(item => item.id)).size, 7);
    groups++;

    const detail = api.inspectCapability({ id: "hello.jsx", includeSource: true, sourceOffset: 1, sourceLimit: 3 });
    assert.equal(detail.entry.name, "hello.jsx");
    assert.equal(detail.entry.sourceSha256, hash(source.branches["hello.jsx"]));
    assert.equal(detail.source.text, source.branches["hello.jsx"].split(/\r?\n/).slice(1, 4).join("\n"));
    assert.equal(detail.source.offset, 1);
    assert.equal(detail.source.nextOffset, 4);
    assert.equal(detail.source.totalLines, 7);
    assert.equal(detail.source.sourceIsUntrustedData, true);
    assert.equal(detail.executionReadiness, "requires-project-review");
    const long = api.inspectCapability({ id: "long.jsx", includeSource: true });
    assert.equal(long.source.text.length, 32768);
    assert.equal(long.source.truncated, true);
    assert.equal(api.inspectCapability({ id: "ae_project_inspect", includeSource: true }).source, undefined);
    groups++;

    assert.deepEqual(api.resolveCapabilityRequest({ id: "hello.jsx" }), {
        schema: "codex-ae-functions/v1", steps: [{ function: "script.run", args: { branch: "hello.jsx" } }]
    });
    assert.deepEqual(api.resolveCapabilityRequest({ id: detail.entry.id }), api.resolveCapabilityRequest({ id: "hello.jsx" }));
    assert.deepEqual(api.resolveCapabilityRequest({ id: "ae_comp_create", args: { name: "fixture" } }).steps,
        [{ function: "comp.create", args: { name: "fixture" } }]);
    assert.throws(() => api.resolveCapabilityRequest({ id: "hello.jsx", args: { branch: "long.jsx" } }), /fixed original arguments/);
    assert.throws(() => api.resolveCapabilityRequest({ id: "broken.jsx" }), /static validation/);
    assert.throws(() => api.resolveCapabilityRequest({ id: "missing-dependency.jsx" }), /static validation/);
    groups++;

    for (const invalid of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }, { kind: "unknown" },
        { query: 1 }, { category: false }, { unknown: true }]) {
        assert.throws(() => api.searchCapabilities(invalid));
    }
    for (const invalid of [{ id: "not-installed" }, { id: "hello.jsx", includeSource: "yes" },
        { id: "hello.jsx", sourceLimit: 251 }, { id: "hello.jsx", sourceOffset: -1 }]) {
        assert.throws(() => api.inspectCapability(invalid));
    }
    assert.throws(() => api.resolveCapabilityRequest({ id: "hello.jsx", args: [] }));
    assert.throws(() => api.capabilityStatus({ unexpected: true }));
    groups++;

    for (const [key, mutate] of [
        ["source", () => fs.appendFileSync(fixturePaths.source, "\n")],
        ["inventory", () => fs.appendFileSync(fixturePaths.inventory, "\n")],
        ["catalog", () => rewrite(fixturePaths.catalog, value => { value.revision = "b".repeat(64); })],
        ["capabilities", () => rewrite(fixturePaths.capabilities, value => { value.revision = "b".repeat(64); })],
        ["bundle", () => fs.writeFileSync(fixturePaths.bundle, fs.readFileSync(fixturePaths.bundle, "utf8").replace(revision, "b".repeat(64)))]
    ]) {
        api = makeFixture();
        api.searchCapabilities();
        mutate();
        assert.throws(() => createCapabilitiesApi(fixture).searchCapabilities(), /stale or invalid/, key + " drift must fail closed");
        if (key === "source") { assert.throws(() => api.searchCapabilities(), /stale or invalid/, "A warmed API cache must notice source changes"); }
    }
    groups++;

    for (const mutate of [
        value => { value.branches.pop(); },
        value => { value.branches.push(value.branches[0]); },
        value => { value.branches[0].capabilityId = value.branches[1].capabilityId; },
        value => { value.branches[0].call.args.branch = "different.jsx"; }
    ]) {
        makeFixture();
        rewrite(fixturePaths.capabilities, mutate);
        assert.throws(() => createCapabilitiesApi(fixture).capabilityStatus(), /missing|duplicate|Invalid branch|Duplicate/);
    }
    api = makeFixture();
    rewrite(fixturePaths.capabilities, value => { value.branches.find(item => item.name === "hello.jsx").sourceSha256 = "0".repeat(64); });
    assert.throws(() => createCapabilitiesApi(fixture).inspectCapability({ id: "hello.jsx", includeSource: true }), /checksum mismatch/);
    groups++;

    api = makeFixture();
    const certificatePath = path.join(fixture, ".ae-codex/bundle/installed-validation.json");
    fs.mkdirSync(path.dirname(certificatePath), { recursive: true });
    fs.writeFileSync(certificatePath, json({ state: "success", revision, branches: names.length,
        sha256: hash(fs.readFileSync(fixturePaths.bundle)), fileBytes: fs.statSync(fixturePaths.bundle).size,
        verifiedAtUtc: "2026-10-20T00:00:00.000Z" }));
    assert.equal(api.capabilityStatus().installation.certificateMatches, true);
    const previousBundle = fs.readFileSync(fixturePaths.bundle, "utf8");
    fs.writeFileSync(fixturePaths.bundle, previousBundle.replace("fixture payload A", "fixture payload B"));
    fs.utimesSync(fixturePaths.bundle, new Date(), new Date(Date.now() + 1000));
    assert.equal(fs.statSync(fixturePaths.bundle).size, Buffer.byteLength(previousBundle));
    assert.equal(fs.readFileSync(fixturePaths.bundle, "utf8").split("\n")[2], previousBundle.split("\n")[2]);
    assert.equal(api.capabilityStatus().installation.certificateMatches, false,
        "Same-header, same-size payload corruption must invalidate installation verification, including a warmed cache");
    groups++;

    // A running marker is not a live connection unless its timestamp, workspace,
    // bridge version and catalog revision all match the installed runtime.
    api = makeFixture();
    const heartbeatPath = path.join(fixture, ".ae-codex/bridge/heartbeat.json");
    fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
    const heartbeat = {
        schema: "codex-ae-heartbeat/v1", state: "running", bridgeVersion: "1.8.0",
        workspaceRoot: fixture, timestampEpochMs: Date.now(), sessionNonce: "fixture-session-0001",
        scripts: { revision, total: names.length }
    };
    fs.writeFileSync(heartbeatPath, json(heartbeat));
    assert.equal(api.capabilityStatus().connection.fresh, true);
    assert.equal(api.capabilityStatus().connection.state, "running");
    heartbeat.timestampEpochMs = Date.now() - 60000;
    fs.writeFileSync(heartbeatPath, json(heartbeat));
    assert.equal(api.capabilityStatus().connection.fresh, false);
    assert.equal(api.capabilityStatus().connection.state, "stale");
    heartbeat.timestampEpochMs = Date.now(); heartbeat.workspaceRoot = path.join(fixture, "other");
    fs.writeFileSync(heartbeatPath, json(heartbeat));
    const mismatched = api.capabilityStatus().connection;
    assert.equal(mismatched.fresh, false);
    assert.equal(mismatched.workspaceMatches, false);
    groups++;

    // Real installed inventory coverage. Read manifests/source only; never dispatch to AE.
    const inventory = JSON.parse(fs.readFileSync(path.join(root, "source/script-inventory.json"), "utf8")).names;
    const actualSource = expandSource(JSON.parse(fs.readFileSync(path.join(root, "source/scripts.json"), "utf8"))).branches;
    const actualManifest = JSON.parse(fs.readFileSync(path.join(root, ".ae-codex/functions/capabilities.json"), "utf8"));
    const actualCatalog = JSON.parse(fs.readFileSync(path.join(root, ".ae-codex/functions/catalog.json"), "utf8"));
    const actual = createCapabilitiesApi(root);
    assert.ok(inventory.length >= 805, "The complete historical inventory must stay available");
    const scripts = allPages(actual, { kind: "script" });
    assert.deepEqual(scripts.map(item => item.name).sort(), [...inventory].sort());
    assert.deepEqual(scripts.map(item => item.name).sort(), actualCatalog.legacyBranches.map(item => item.name).sort());
    assert.deepEqual(scripts.map(item => item.name).sort(), actualManifest.branches.map(item => item.name).sort());
    assert.equal(new Set(scripts.map(item => item.id)).size, inventory.length);
    const everyEntry = allPages(actual, { kind: "all" });
    assert.equal(everyEntry.length, inventory.length + actualCatalog.functions.length);
    groups++;

    for (const script of scripts) {
        const inspected = actual.inspectCapability({ id: script.id, includeSource: true, sourceOffset: 0, sourceLimit: 2 });
        assert.equal(inspected.entry.name, script.name);
        assert.equal(inspected.entry.sourceSha256, hash(actualSource[script.name]), script.name + " source SHA must match");
        assert.equal(inspected.source.text, actualSource[script.name].split(/\r?\n/).slice(0, 2).join("\n").slice(0, 32768));
        assert.equal(inspected.entry.runtimeVerified, false);
        assert.deepEqual(actual.resolveCapabilityRequest({ id: script.id }), {
            schema: "codex-ae-functions/v1", steps: [{ function: "script.run", args: { branch: script.name } }]
        }, script.name + " must map to its exact original branch");
        assert.equal(actual.searchCapabilities({ kind: "script", query: script.name, limit: 1 }).results[0]?.id, script.id,
            script.name + " must rank first for its exact name, ahead of branches referencing it");
    }
    groups++;

    const status = actual.capabilityStatus();
    assert.equal(status.scripts, inventory.length);
    assert.equal(status.functions, actualCatalog.functions.length);
    assert.equal(status.coverage.complete, true);
    assert.deepEqual(status.coverage.missing, []);
    assert.equal(status.dispatchMappings.complete, true);
    assert.equal(status.dispatchMappings.mapped, everyEntry.length);
    assert.equal(status.runtimeVerified, false);
    // Other chats may stage files in the shared workspace. Only this test-owned fixture is asserted here.
    assert.deepEqual(fs.readdirSync(path.join(fixture, "jsx")), ["Codex Bridge.jsx"]);
    groups++;
    console.log("AE capabilities tests passed: " + groups + " groups; " + inventory.length + " complete branch mappings/source checksums; no AE calls.");
} finally {
    const allowed = path.join(root, ".ae-codex/tests") + path.sep;
    if (!path.resolve(fixture).startsWith(allowed)) { throw new Error("Unsafe fixture cleanup path"); }
    fs.rmSync(fixture, { recursive: true, force: true });
}
