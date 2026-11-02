/* Isolated MCP metadata cache tests. No AE dispatch, installation or live files. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../tools/AeFunctionsMcp.js"), "utf8");
function data(description = "Read current project") {
    return { schema: "codex-ae-functions-catalog/v1", bridgeVersion: "fixture",
        functions: [{ name: "project.inspect", description, args: { limit: "optional" }, mutates: false,
            inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1 } }, additionalProperties: false } }],
        legacyBranches: [{ name: "hello.jsx", description: "Archived fixture", source: { hash: "original" } }] };
}
function fixture() {
    const state = { body: JSON.stringify(data()), identity: { dev: 1, ino: 5, size: 100, mtimeMs: 20, ctimeMs: 30 }, reads: 0, stats: 0, missing: false, afterRead: null };
    const fakeFs = {
        statSync() {
            state.stats++;
            if (state.missing) { throw Object.assign(new Error("fixture missing"), { code: "ENOENT" }); }
            return { ...state.identity };
        },
        readFileSync() {
            state.reads++;
            const body = state.body;
            if (state.afterRead) { state.afterRead(); }
            return body;
        }
    };
    const sandbox = { module: { exports: {} }, __dirname: path.resolve(__dirname, "../tools"), Buffer, process,
        require(name) {
            if (name === "node:fs") { return fakeFs; }
            if (name === "./AeCapabilities.js") { return {}; }
            if (name === "node:child_process") { return { spawn() { throw new Error("AE dispatch is forbidden in this fixture"); } }; }
            return require(name);
        } };
    vm.runInNewContext(source, sandbox, { filename: "AeFunctionsMcp.js" });
    return { api: sandbox.module.exports, state,
        replace(value, field = "mtimeMs") { state.body = typeof value === "string" ? value : JSON.stringify(value); state.identity[field]++; } };
}
const tests = [], test = (name, run) => tests.push({ name, run });
test("unchanged discovery reads the catalog body once across 1000 requests", async () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) { assert.equal(f.api.toolsList().at(-1).name, "ae_project_inspect"); }
    assert.equal(f.state.reads, 1);
    const result = await f.api.callTool("ae_list_functions", { search: "project" });
    assert.equal(result.functions.length, 1); assert.equal(f.state.reads, 1);
    assert.equal((await f.api.handle({ method: "initialize" })).serverInfo.version, "fixture");
    assert.equal(f.state.reads, 1);
});
test("size mtime ctime device and inode changes each invalidate the single revision", () => {
    for (const field of ["size", "mtimeMs", "ctimeMs", "dev", "ino"]) {
        const f = fixture(); f.api.toolsList();
        f.replace(data("Changed " + field), field);
        assert.match(f.api.toolsList().at(-1).description, new RegExp("Changed " + field));
        assert.equal(f.state.reads, 2, field);
        f.api.toolsList(); assert.equal(f.state.reads, 2, "the new revision is cached");
    }
});
test("a missing replacement refuses stale tools and rechecks the body after recovery", () => {
    const f = fixture(); f.api.toolsList(); f.state.missing = true;
    assert.throws(() => f.api.toolsList(), /fixture missing/);
    f.state.missing = false;
    assert.equal(f.api.toolsList().at(-1).name, "ae_project_inspect");
    assert.equal(f.state.reads, 2, "even unchanged identity must be read after failure");
});
test("malformed JSON refuses stale tools and recovers without another metadata change", () => {
    const f = fixture(); f.api.toolsList(); f.replace("{");
    assert.throws(() => f.api.toolsList());
    f.state.body = JSON.stringify(data("Recovered JSON"));
    assert.match(f.api.toolsList().at(-1).description, /Recovered JSON/);
    assert.equal(f.state.reads, 3);
});
test("unsupported and null schemas refuse stale tools and recover", () => {
    for (const value of [{ schema: "unsupported" }, null]) {
        const f = fixture(); f.api.toolsList(); f.replace(JSON.stringify(value));
        assert.throws(() => f.api.toolsList(), /Rebuild the AE function catalog/);
        f.state.body = JSON.stringify(data("Recovered schema"));
        assert.match(f.api.toolsList().at(-1).description, /Recovered schema/);
        assert.equal(f.state.reads, 3);
    }
});
test("an atomic replacement during a body read publishes only the stable revision", () => {
    const f = fixture();
    f.state.afterRead = () => { f.state.afterRead = null; f.replace(data("Stable replacement"), "ino"); };
    assert.match(f.api.toolsList().at(-1).description, /Stable replacement/);
    assert.equal(f.state.reads, 2);
    f.api.toolsList(); assert.equal(f.state.reads, 2);
});
test("continuously changing catalogs fail within three reads and permit later recovery", () => {
    const f = fixture(); f.state.afterRead = () => { f.state.identity.ctimeMs++; };
    assert.throws(() => f.api.toolsList(), /changed while reading/); assert.equal(f.state.reads, 3);
    f.state.afterRead = null;
    assert.equal(f.api.toolsList().at(-1).name, "ae_project_inspect"); assert.equal(f.state.reads, 4);
});
test("returned tool schemas and selected entries cannot mutate cached definitions", async () => {
    const f = fixture(), first = f.api.toolsList();
    first.at(-1).inputSchema.properties.limit.minimum = 999;
    first.at(-1).inputSchema.properties.extra = { type: "string" };
    const listed = await f.api.callTool("ae_list_functions", { includeLegacy: true });
    listed.functions[0].name = "mutated"; listed.functions[0].args.limit = "changed";
    listed.functions[0].inputSchema.properties.limit.minimum = 777;
    listed.functions[1].source.hash = "changed";
    const again = await f.api.callTool("ae_list_functions", { includeLegacy: true });
    assert.equal(again.functions[0].name, "project.inspect"); assert.equal(again.functions[0].args.limit, "optional");
    assert.equal(again.functions[0].inputSchema.properties.limit.minimum, 1);
    assert.equal(again.functions[1].source.hash, "original");
    assert.equal(f.api.toolsList().at(-1).inputSchema.properties.limit.minimum, 1);
    assert.equal(f.api.toolsList().at(-1).inputSchema.properties.extra, undefined);
    assert.equal(f.state.reads, 1);
});
test("search arguments and rejected plans do not mutate a cached tool", async () => {
    const f = fixture(), args = { search: "PROJECT", includeLegacy: false };
    const before = JSON.stringify(args);
    assert.equal((await f.api.callTool("ae_list_functions", args)).functions.length, 1);
    assert.equal(JSON.stringify(args), before);
    await assert.rejects(f.api.callTool("ae_run_plan", { steps: [{ function: "missing", args: {} }] }), /Invalid installed function/);
    assert.equal((await f.api.callTool("ae_list_functions", { search: "project.inspect" })).functions[0].name, "project.inspect");
    assert.equal(f.state.reads, 1);
});
(async () => {
    let failed = 0;
    for (const { name, run } of tests) {
        try { await run(); console.log("PASS " + name); }
        catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); }
    }
    console.log((tests.length - failed) + "/" + tests.length + " MCP catalog cache tests passed");
    process.exitCode = failed ? 1 : 0;
})();
