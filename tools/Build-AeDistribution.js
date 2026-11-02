/* Create a sanitized, independent runtime release. Never alters developer inputs. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { expandSource, consolidateSource } = require("./AeScriptSource.js");
const { build, verify, functionCatalog } = require("./Build-AeScriptBundle.js");
const { readFunctionsRuntime } = require("./AeFunctionsSource.js");
const { createCapabilitiesApi } = require("./AeCapabilities.js");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const runtimeFiles = [
    "source/bridge.js", "source/bundle-runtime.js", "source/functions-runtime.js",
    "source/functions-layer-tools.js", "source/functions-project-tools.js", "source/functions-inspection-tools.js",
    "tools/AeScriptSource.js", "tools/AeScriptCapabilities.js", "tools/AeFunctionsSource.js",
    "tools/Build-AeScriptBundle.js", "tools/AeCapabilities.js", "tools/Get-AeCapabilities.js",
    "tools/AeFunctionsMcp.js", "tools/AeFunctionRequest.ps1", "tools/Invoke-AeFunction.ps1",
    "tools/Get-AeFunctions.ps1", "tools/Submit-AeJsx.ps1", "tools/Resolve-AeScriptTarget.ps1",
    "tools/Reset-AeBridgeLock.ps1", "tools/Get-AeInspectionReport.ps1", "tools/Sync-CodexModelDisplay.ps1",
    "tools/Install-AeFunctionsMcp.ps1", "tools/AeCodexConfig.js", "tools/Validate-AeBridgeInstallation.ps1",
    "tools/Initialize-AeLibrary.ps1", "tools/AeBackgroundLauncher.cs", "tools/AeBackgroundServiceLifecycle.ps1", "tools/Start-AeSfxCatalog.ps1", "tools/Update-AeSfxCatalog.ps1",
    "tools/AeBridgePanel.js", "tools/AeBridgeStartup.js",
    "tools/Install-AeDistribution.ps1", "tools/Uninstall-AeDistribution.ps1", "tools/Manage-AeInstallation.ps1", "tools/Remove-AeOldVersions.ps1"
];
function walk(root, prefix = "") {
    const result = [];
    for (const name of fs.readdirSync(path.join(root, prefix)).sort()) {
        const relative = prefix ? prefix + "/" + name : name;
        const stat = fs.lstatSync(path.join(root, relative));
        if (stat.isSymbolicLink()) throw new Error("Release cannot contain links: " + relative);
        if (stat.isDirectory()) result.push(...walk(root, relative));
        else if (stat.isFile()) result.push(relative);
        else throw new Error("Unexpected release file: " + relative);
    }
    return result;
}
function inside(root, target) {
    const relative = path.relative(root, target);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function write(root, relative, text) {
    const destination = path.join(root, relative);
    if (!inside(root, destination)) throw new Error("Invalid release path");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
}
function verifyDistribution(packageRoot) {
    const payload = path.join(packageRoot, "payload");
    const manifest = JSON.parse(fs.readFileSync(path.join(payload, "distribution.json"), "utf8"));
    if (manifest.schema !== "codex-ae-distribution/v1" || !Array.isArray(manifest.files)) throw new Error("Invalid release manifest");
    const expectedPayload = manifest.files.map(file => file.path).concat("distribution.json").sort();
    const actualPayload = walk(payload).sort();
    if (JSON.stringify(actualPayload) !== JSON.stringify(expectedPayload)) throw new Error("Existing release contains unexpected or missing payload files");
    for (const file of manifest.files) {
        const bytes = fs.readFileSync(path.join(payload, file.path));
        if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error("Existing release was changed: " + file.path);
    }
    const allowedRoot = new Set(["payload", "README.md", "Open Codex AE.cmd", "Codex AE.exe"]);
    for (const name of fs.readdirSync(packageRoot)) {
        const stat = fs.lstatSync(path.join(packageRoot, name));
        if (!allowedRoot.has(name) || stat.isSymbolicLink() || (name === "payload" ? !stat.isDirectory() : !stat.isFile())) {
            throw new Error("Existing release contains an unexpected root entry: " + name);
        }
    }
    for (const [name, digest] of [["README.md", manifest.readmeSha256], ["Open Codex AE.cmd", manifest.commandSha256]]) {
        if (!/^[0-9a-f]{64}$/.test(digest || "") || sha(fs.readFileSync(path.join(packageRoot, name))) !== digest) {
            throw new Error("Existing release root artifact was changed: " + name);
        }
    }
    return manifest;
}
function buildDistribution(workspace = path.resolve(__dirname, "..")) {
    const releases = path.join(workspace, ".ae-codex/releases");
    fs.mkdirSync(releases, { recursive: true });
    const stage = fs.mkdtempSync(path.join(releases, ".stage-"));
    const payload = path.join(stage, "payload");
    try {
        for (const relative of runtimeFiles) {
            const input = path.join(workspace, relative);
            if (!fs.lstatSync(input).isFile() || fs.lstatSync(input).isSymbolicLink()) throw new Error("Runtime input is not a regular file: " + relative);
            write(payload, relative, fs.readFileSync(input));
        }
        // The original inventory stays untouched. A release has its own explicit
        // inventory containing only the internal library, not personal procedures.
        const source = expandSource(JSON.parse(fs.readFileSync(path.join(workspace, "source/scripts.json"), "utf8")));
        const library = source.branches["Codex Library.jsx"];
        if (typeof library !== "string") throw new Error("Internal inventory library is missing");
        const releaseSource = consolidateSource({schema: "codex-ae-scripts/v1", branches: {"Codex Library.jsx": library}}).source;
        write(payload, "source/scripts.json", JSON.stringify(releaseSource) + "\n");
        write(payload, "source/script-inventory.json", JSON.stringify({schema: "codex-ae-script-inventory/v1", names: ["Codex Library.jsx"]}, null, 2) + "\n");
        write(payload, "AGENTS.md", fs.readFileSync(path.join(workspace, "docs/distribution/AGENTS.md")));
        write(payload, ".ae-codex/library/USAGE.md", fs.readFileSync(path.join(workspace, "docs/distribution/LIBRARY-USAGE.md")));
        write(payload, ".ae-codex/plugins/USAGE.md", fs.readFileSync(path.join(workspace, "docs/distribution/PLUGINS-USAGE.md")));
        const bundle = build(payload);
        verify(fs.readFileSync(bundle.file, "utf8"), releaseSource);
        const api = createCapabilitiesApi(payload);
        const status = api.capabilityStatus();
        const expectedCatalog = functionCatalog(readFunctionsRuntime(workspace), ["Codex Library.jsx"],
            fs.readFileSync(path.join(workspace, "source/bridge.js"), "utf8"), "source-coverage");
        const releaseCatalog = JSON.parse(fs.readFileSync(path.join(payload, ".ae-codex/functions/catalog.json"), "utf8"));
        const version = releaseCatalog.bridgeVersion;
        if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
            throw new Error("Release requires a valid bridge version (major.minor.patch)");
        }
        if (!status.coverage.complete || status.scripts !== 1 || !expectedCatalog.functions.length ||
                status.functions !== expectedCatalog.functions.length ||
                JSON.stringify(releaseCatalog.functions) !== JSON.stringify(expectedCatalog.functions)) {
            throw new Error("Release tool coverage is incomplete or differs from the source registry");
        }
        const files = walk(payload).map(relative => {
            const bytes = fs.readFileSync(path.join(payload, relative));
            // Personal Windows profile paths must never travel with runtime code.
            if (/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/i.test(bytes.toString("utf8"))) throw new Error("Personal profile path in release: " + relative);
            return {path: relative, sha256: sha(bytes), bytes: bytes.length};
        });
        const readme = fs.readFileSync(path.join(workspace, "docs/distribution/README.md"));
        const command = Buffer.from("@echo off\r\npowershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File \"%~dp0payload\\tools\\Manage-AeInstallation.ps1\"\r\n");
        const launcherSource = fs.readFileSync(path.join(workspace, "tools/AeLauncher.cs"));
        const readmeSha256 = sha(readme), commandSha256 = sha(command), launcherSourceSha256 = sha(launcherSource);
        const identity = sha(JSON.stringify({files, readmeSha256, commandSha256, launcherSourceSha256}));
        const packageId = version + "-" + identity.slice(0, 12);
        const manifest = {schema: "codex-ae-distribution/v1", version, packageId, bridgeVersion: releaseCatalog.bridgeVersion,
            toolCount: status.functions, archiveBranches: 0, internalBranches: ["Codex Library.jsx"],
            requirements: {os: "Windows", node: ">=20", powershell: ">=7", host: "Adobe After Effects"},
            readmeSha256, commandSha256, launcherSourceSha256, files};
        write(payload, "distribution.json", JSON.stringify(manifest, null, 2) + "\n");
        write(stage, "README.md", readme);
        // Fallback entry point still works if the optional native launcher was not built.
        write(stage, "Open Codex AE.cmd", command);
        const destination = path.join(releases, "CodexAE-" + packageId);
        if (fs.existsSync(destination)) {
            const previous = verifyDistribution(destination);
            if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error("Existing release identity conflict");
        } else {
            verifyDistribution(stage);
            fs.renameSync(stage, destination);
        }
        return {schema: "codex-ae-release-build/v1", state: "success", version, bridgeVersion: version, packageId, packagePath: destination,
            payloadPath: path.join(destination, "payload"), toolCount: status.functions, archiveBranches: 0,
            preservedDevelopmentBranches: Object.keys(source.branches).length, files: files.length,
            payloadBytes: files.reduce((sum, file) => sum + file.bytes, 0), bundleBytes: bundle.bytes, sha256: identity};
    } finally {
        if (fs.existsSync(stage)) {
            if (!inside(releases, stage) || !path.basename(stage).startsWith(".stage-")) throw new Error("Invalid stage cleanup path");
            fs.rmSync(stage, {recursive: true});
        }
    }
}
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length === 2 && args[0] === "--verify-package") {
            const manifest = verifyDistribution(path.resolve(args[1]));
            console.log(JSON.stringify({schema: "codex-ae-release-verification/v1", state: "success", packageId: manifest.packageId}));
        } else if (!args.length) console.log(JSON.stringify(buildDistribution()));
        else throw new Error("Usage: Build-AeDistribution.js [--verify-package <release-folder>]");
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {buildDistribution, verifyDistribution, runtimeFiles, walk};
