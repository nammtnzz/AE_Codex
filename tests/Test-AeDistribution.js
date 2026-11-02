"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {buildDistribution, verifyDistribution, runtimeFiles, walk} = require("../tools/Build-AeDistribution.js");
const root = path.resolve(__dirname, "..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const testsRoot = path.join(root, ".ae-codex/tests");
fs.mkdirSync(testsRoot, {recursive: true});
const fixture = fs.mkdtempSync(path.join(testsRoot, "distribution-"));
const inputs = [...runtimeFiles, "source/scripts.json", "source/script-inventory.json",
    "docs/distribution/README.md", "docs/distribution/AGENTS.md", "docs/distribution/LIBRARY-USAGE.md", "docs/distribution/PLUGINS-USAGE.md",
    "tools/AeLauncher.cs"];
const before = new Map(inputs.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
function copy(file) {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(root, file), target);
}
function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
try {
    inputs.forEach(copy);
    // Deliberately present local-only data: allowlist must never copy these files.
    const forbidden = [".env", ".codex/config.toml", ".ae-codex/library/current.json", ".ae-codex/library/config.json",
        ".ae-codex/bridge/heartbeat.json", ".ae-codex/chat/state.json", ".ae-codex/chat/requests/private.json",
        ".ae-codex/chat/host.lock", "auth.json", "assets/private.wav", "tools/private-project.ps1",
        "tools/AeCodexChatHost.js", "tools/AeCodexChatMedia.js", "tools/New-AeChatPreview.ps1"];
    for (const name of forbidden) {
        fs.mkdirSync(path.dirname(path.join(fixture, name)), {recursive: true});
        fs.writeFileSync(path.join(fixture, name), "PRIVATE-FIXTURE-MUST-NOT-SHIP");
    }
    const result = buildDistribution(fixture);
    assert.equal(result.toolCount, 43);
    assert.equal(result.archiveBranches, 0);
    assert.equal(result.preservedDevelopmentBranches, 805);
    const manifest = json(path.join(result.payloadPath, "distribution.json"));
    assert.equal(manifest.schema, "codex-ae-distribution/v1");
    assert.equal(result.version, manifest.bridgeVersion);
    assert.equal(manifest.version, manifest.bridgeVersion);
    assert.equal(result.bridgeVersion, manifest.bridgeVersion);
    assert.ok(result.packageId.startsWith(manifest.bridgeVersion + "-"));
    for (const excluded of ["tools/AeCodexChatHost.js", "tools/AeCodexChatMedia.js", "tools/New-AeChatPreview.ps1"]) {
        assert.ok(!manifest.files.some(file => file.path === excluded), excluded + " must not ship");
    }
    assert.equal(manifest.files.length, 43);
    assert.deepEqual(manifest.internalBranches, ["Codex Library.jsx"]);
    assert.equal(json(path.join(result.payloadPath, "source/script-inventory.json")).names.length, 1);
    const actual = walk(result.payloadPath).filter(file => file !== "distribution.json");
    assert.deepEqual(actual, manifest.files.map(file => file.path));
    for (const entry of manifest.files) {
        const bytes = fs.readFileSync(path.join(result.payloadPath, entry.path));
        assert.equal(hash(bytes), entry.sha256);
        assert.equal(bytes.length, entry.bytes);
        assert.ok(!bytes.includes(Buffer.from("PRIVATE-FIXTURE-MUST-NOT-SHIP")), entry.path);
        assert.ok(!/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/i.test(bytes.toString("utf8")), entry.path);
    }
    forbidden.forEach(name => assert.ok(!actual.includes(name), name));
    assert.equal(actual.filter(name => name.endsWith(".jsx")).length, 1);
    console.log("PASS allowlisted release: 43 tools, one internal branch, one JSX, no local state/media/credentials");
    const bridgeInput = path.join(fixture, "source/bridge.js"), originalBridge = fs.readFileSync(bridgeInput, "utf8");
    const nextVersion = manifest.bridgeVersion.split(".").map(Number);
    nextVersion[2]++;
    const nextVersionText = nextVersion.join(".");
    fs.writeFileSync(bridgeInput, originalBridge.replace(/BRIDGE_VERSION\s*=\s*"[^"]+"/, 'BRIDGE_VERSION = "' + nextVersionText + '"'));
    const versionUpdated = buildDistribution(fixture);
    const nextManifest = json(path.join(versionUpdated.payloadPath, "distribution.json"));
    assert.equal(versionUpdated.version, nextVersionText);
    assert.equal(nextManifest.version, nextVersionText);
    assert.equal(nextManifest.bridgeVersion, nextVersionText);
    assert.ok(versionUpdated.packageId.startsWith(nextVersionText + "-"));
    fs.writeFileSync(bridgeInput, originalBridge.replace(/BRIDGE_VERSION\s*=\s*"[^"]+"/, 'BRIDGE_VERSION = "invalid-version"'));
    assert.throws(() => buildDistribution(fixture), /valid bridge version/);
    fs.writeFileSync(bridgeInput, originalBridge);
    console.log("PASS installer and package versions follow bridge updates automatically; malformed versions cannot publish");
    const again = buildDistribution(fixture);
    assert.equal(again.packageId, result.packageId);
    assert.equal(again.sha256, result.sha256);
    assert.equal(verifyDistribution(result.packagePath).packageId, result.packageId);
    const extraPayload = path.join(result.payloadPath, "unlisted-private.wav");
    fs.writeFileSync(extraPayload, "PRIVATE-FIXTURE-MUST-NOT-SHIP");
    assert.throws(() => buildDistribution(fixture), /unexpected or missing payload files/);
    fs.unlinkSync(extraPayload);
    const extraRoot = path.join(result.packagePath, "unlisted-private.txt");
    fs.writeFileSync(extraRoot, "PRIVATE-FIXTURE-MUST-NOT-SHIP");
    assert.throws(() => buildDistribution(fixture), /unexpected root entry/);
    fs.unlinkSync(extraRoot);
    for (const artifact of ["README.md", "Open Codex AE.cmd"]) {
        const filename = path.join(result.packagePath, artifact), original = fs.readFileSync(filename);
        fs.appendFileSync(filename, "\nchanged fixture\n");
        assert.throws(() => buildDistribution(fixture), /root artifact was changed/);
        fs.writeFileSync(filename, original);
    }
    const readmeInput = path.join(fixture, "docs/distribution/README.md"), originalReadme = fs.readFileSync(readmeInput);
    fs.appendFileSync(readmeInput, "\nUpdated installation guide fixture.\n");
    const docsUpdated = buildDistribution(fixture);
    assert.notEqual(docsUpdated.packageId, result.packageId);
    assert.equal(fs.readFileSync(path.join(docsUpdated.packagePath, "README.md"), "utf8"), fs.readFileSync(readmeInput, "utf8"));
    fs.writeFileSync(readmeInput, originalReadme);
    const launcherInput = path.join(fixture, "tools/AeLauncher.cs"), originalLauncher = fs.readFileSync(launcherInput);
    fs.appendFileSync(launcherInput, "\n// Updated launcher fixture.\n");
    const launcherUpdated = buildDistribution(fixture);
    assert.notEqual(launcherUpdated.packageId, result.packageId);
    assert.equal(json(path.join(launcherUpdated.payloadPath, "distribution.json")).launcherSourceSha256, hash(fs.readFileSync(launcherInput)));
    fs.writeFileSync(launcherInput, originalLauncher);
    console.log("PASS package reuse rejects unlisted/tampered files; documentation and launcher changes get distinct identities");
    const functionsInput = path.join(fixture, "source/functions-inspection-tools.js"), originalFunctions = fs.readFileSync(functionsInput);
    fs.appendFileSync(functionsInput, '\nregister("fixture.portable", "Reusable release coverage fixture", false, {}, function () {}, function () { return {}; });\n');
    const extendedRegistry = buildDistribution(fixture);
    assert.equal(extendedRegistry.toolCount, result.toolCount + 1);
    const extendedCatalog = json(path.join(extendedRegistry.payloadPath, ".ae-codex/functions/catalog.json"));
    assert.ok(extendedCatalog.functions.some(tool => tool.name === "fixture.portable"));
    fs.writeFileSync(functionsInput, originalFunctions);
    console.log("PASS release coverage follows the source registry when a reusable tool is added");
    const relocated = path.join(fixture, "Máy mới khác đường dẫn", "plugin");
    fs.mkdirSync(path.dirname(relocated), {recursive: true});
    fs.cpSync(result.payloadPath, relocated, {recursive: true});
    for (const [command, args] of [["status", []], ["search", ['{"query":"effect","limit":10}']]]) {
        const run = spawnSync(process.execPath, [path.join(relocated, "tools/Get-AeCapabilities.js"), command, ...args], {encoding: "utf8"});
        assert.equal(run.status, 0, run.stderr || run.stdout);
        const output = JSON.parse(run.stdout);
        if (command === "status") { assert.equal(output.functions, 43); assert.equal(output.coverage.complete, true); }
        else assert.ok(output.total > 0);
    }
    const verify = spawnSync(process.execPath, [path.join(relocated, "tools/Build-AeScriptBundle.js"), "--verify"], {encoding: "utf8"});
    assert.equal(verify.status, 0, verify.stderr);
    console.log("PASS deterministic build and complete discovery/validation after Unicode relocation");
    const changed = path.join(result.payloadPath, "tools/AeFunctionsMcp.js");
    const original = fs.readFileSync(changed);
    fs.appendFileSync(changed, "\n// changed fixture\n");
    assert.throws(() => buildDistribution(fixture), /Existing release was changed/);
    fs.writeFileSync(changed, original);
    for (const [file, digest] of before) assert.equal(hash(fs.readFileSync(path.join(root, file))), digest, file);
    assert.equal(fs.readFileSync(path.join(fixture, ".ae-codex/library/config.json"), "utf8"), "PRIVATE-FIXTURE-MUST-NOT-SHIP");
    console.log("PASS changed release rejected; development source and user configuration remain byte-identical");
} finally {
    const relative = path.relative(testsRoot, fixture);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid fixture cleanup path");
    fs.rmSync(fixture, {recursive: true, force: true});
}
