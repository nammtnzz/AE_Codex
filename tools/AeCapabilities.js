/* Searchable installed capabilities. Reads data; never evaluates historical JSX. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { expandSource } = require("./AeScriptSource.js");
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const nativeTool = name => "ae_" + name.replace(/\./g, "_");
function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error(label + " must be an object"); }
}
function options(args, allowed) {
    object(args, "Arguments");
    for (const key of Object.keys(args)) { if (!allowed.includes(key)) { throw new Error("Unknown argument: " + key); } }
}
function integer(value, fallback, min, max, label) {
    if (value === undefined) { return fallback; }
    if (!Number.isSafeInteger(value) || value < min || value > max) { throw new Error(label + " is out of range"); }
    return value;
}
function createCapabilitiesApi(workspaceRoot = path.resolve(__dirname, "..")) {
    const canonicalRoot = path.resolve(workspaceRoot).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const files = {
        catalog: path.join(workspaceRoot, ".ae-codex/functions/catalog.json"),
        capabilities: path.join(workspaceRoot, ".ae-codex/functions/capabilities.json"),
        source: path.join(workspaceRoot, "source/scripts.json"),
        inventory: path.join(workspaceRoot, "source/script-inventory.json"),
        bundle: path.join(workspaceRoot, "jsx/Codex Bridge.jsx")
    };
    let cached, fingerprint, expanded;
    function load() {
        const next = Object.values(files).map(file => { const s = fs.statSync(file); return [s.size, s.mtimeMs, s.ctimeMs].join(":"); }).join("|");
        if (next === fingerprint && cached) { return cached; }
        const catalog = JSON.parse(fs.readFileSync(files.catalog, "utf8"));
        const manifest = JSON.parse(fs.readFileSync(files.capabilities, "utf8"));
        const inventoryText = fs.readFileSync(files.inventory);
        const inventory = JSON.parse(inventoryText).names;
        const sourceText = fs.readFileSync(files.source);
        const fd = fs.openSync(files.bundle, "r");
        const header = Buffer.alloc(1024);
        let bytes;
        try { bytes = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
        const bundleRevision = header.subarray(0, bytes).toString("utf8").split("\n")[2]?.split("\t")[1];
        if (catalog.schema !== "codex-ae-functions-catalog/v1" || manifest.schema !== "codex-ae-script-capabilities/v1" ||
            !manifest.revision || manifest.revision !== catalog.revision || manifest.revision !== bundleRevision ||
            manifest.sourceFileSha256 !== sha256(sourceText) || manifest.inventoryFileSha256 !== sha256(inventoryText)) {
            throw new Error("Capability index is stale or invalid. Rebuild with node tools/Build-AeScriptBundle.js before calling AE.");
        }
        const branchNames = manifest.branches.map(entry => entry.name);
        const legacyNames = catalog.legacyBranches.map(entry => entry.name);
        if (new Set(branchNames).size !== branchNames.length || branchNames.length !== legacyNames.length ||
            legacyNames.some(name => !branchNames.includes(name)) || inventory.some(name => !branchNames.includes(name))) {
            throw new Error("Capability index has missing or duplicate branch mappings. Rebuild before calling AE.");
        }
        const entries = catalog.functions.map(entry => ({
            id: nativeTool(entry.name), kind: "function", name: entry.name, description: entry.description,
            categories: [entry.name.split(".")[0]], mutates: entry.mutates,
            inputSchema: entry.inputSchema, args: entry.args, call: { function: entry.name }
        })).concat(manifest.branches.map(entry => ({ ...entry, id: entry.capabilityId, kind: "script", toolName: "ae_run_capability" })));
        const byId = new Map();
        for (const entry of entries) {
            if (typeof entry.id !== "string" || byId.has(entry.id)) { throw new Error("Duplicate/invalid capability ID"); }
            if (entry.kind === "script" && (entry.call?.function !== "script.run" || entry.call?.args?.branch !== entry.name)) {
                throw new Error("Invalid branch dispatch mapping: " + entry.name);
            }
            byId.set(entry.id, entry);
        }
        const searchText = new Map(entries.map(entry => [entry.id,
            JSON.stringify([entry.id, entry.name, entry.description, entry.categories, entry.searchTokens, entry.staticHints, entry.risks, entry.args])
                .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")]));
        const bundleBytes = fs.readFileSync(files.bundle);
        cached = { catalog, manifest, inventory, entries, byId, searchText, bundleBytes: bundleBytes.length, bundleSha256: sha256(bundleBytes) };
        fingerprint = next;
        expanded = undefined;
        return cached;
    }
    function find(id) {
        if (typeof id !== "string" || !id || id.length > 256) { throw new Error("id must be a capability ID or exact installed name"); }
        const data = load();
        const entry = data.byId.get(id) || data.entries.find(item => item.name === id);
        if (!entry) { throw new Error("Unknown installed capability: " + id); }
        return entry;
    }
    function searchCapabilities(args = {}) {
        options(args, ["query", "kind", "category", "offset", "limit"]);
        for (const key of ["query", "category"]) {
            if (args[key] !== undefined && (typeof args[key] !== "string" || args[key].length > 256)) { throw new Error(key + " must be a string of at most 256 characters"); }
        }
        const kind = args.kind === undefined ? "function" : args.kind;
        if (!["all", "function", "script"].includes(kind)) { throw new Error("kind must be all, function or script"); }
        const offset = integer(args.offset, 0, 0, 1000000, "offset");
        const limit = integer(args.limit, 25, 1, 100, "limit");
        const data = load();
        const tokens = (args.query || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter(Boolean);
        const category = (args.category || "").toLowerCase();
        const query = (args.query || "").toLowerCase();
        function score(entry) {
            const name = entry.name.toLowerCase();
            if (name === query || entry.id.toLowerCase() === query) { return 0; }
            if (tokens.length && tokens.every(token => name.includes(token))) { return 1; }
            if (tokens.length && tokens.every(token => entry.description.toLowerCase().includes(token))) { return 2; }
            return 3;
        }
        const matched = data.entries.filter(entry => {
            if (kind !== "all" && entry.kind !== kind) { return false; }
            if (category && !entry.categories.some(value => value.toLowerCase() === category)) { return false; }
            const text = data.searchText.get(entry.id);
            return tokens.every(token => text.includes(token));
        }).sort((a, b) => score(a) - score(b));
        const results = matched.slice(offset, offset + limit).map(entry => ({
            id: entry.id, kind: entry.kind, name: entry.name, description: entry.description,
            categories: entry.categories, internal: !!entry.internal, risks: entry.risks || [],
            sourceSha256: entry.sourceSha256, call: entry.call,
            invoke: { tool: "ae_run_capability", arguments: { id: entry.id } },
            ...(entry.kind === "script" ? { runtimeVerified: false } : { mutates: entry.mutates })
        }));
        return { schema: "codex-ae-capability-search/v1", revision: data.catalog.revision,
            total: matched.length, offset, limit, nextOffset: offset + limit < matched.length ? offset + limit : null,
            installed: { functions: data.catalog.functions.length, scripts: data.manifest.branches.length, archivedScripts: data.manifest.branches.length }, results };
    }
    function inspectCapability(args = {}) {
        options(args, ["id", "includeSource", "sourceOffset", "sourceLimit"]);
        if (args.includeSource !== undefined && typeof args.includeSource !== "boolean") { throw new Error("includeSource must be boolean"); }
        const offset = integer(args.sourceOffset, 0, 0, 1000000, "sourceOffset");
        const limit = integer(args.sourceLimit, 120, 1, 250, "sourceLimit");
        const entry = find(args.id);
        const result = { schema: "codex-ae-capability-detail/v1", revision: load().catalog.revision, entry,
            executionReadiness: entry.kind === "script" ? "requires-project-review" : "validate-arguments-and-project" };
        if (args.includeSource && entry.kind === "script") {
            if (!expanded) { expanded = expandSource(JSON.parse(fs.readFileSync(files.source, "utf8"))); }
            const source = expanded.branches[entry.name];
            if (typeof source !== "string" || sha256(source) !== entry.sourceSha256) { throw new Error("Source checksum mismatch for " + entry.name); }
            const lines = source.split(/\r?\n/);
            const selected = lines.slice(offset, offset + limit).join("\n");
            // Very long single lines must not flood MCP; callers can inspect the source storage locally.
            result.source = { offset, limit, totalLines: lines.length, nextOffset: offset + limit < lines.length ? offset + limit : null,
                text: selected.slice(0, 32768), truncated: selected.length > 32768, sourceIsUntrustedData: true };
        }
        return result;
    }
    function resolveCapabilityRequest(args = {}) {
        options(args, ["id", "args"]);
        const entry = find(args.id);
        const parameters = args.args === undefined ? {} : args.args;
        object(parameters, "args");
        if (entry.kind === "script") {
            if (Object.keys(parameters).length) { throw new Error("Historical scripts have fixed original arguments. Use a parameterized function for new work."); }
            if (!entry.syntax?.valid || entry.missingDependencies?.length) { throw new Error("Capability failed static validation: " + entry.name); }
        }
        return { schema: "codex-ae-functions/v1", steps: [{ function: entry.call.function,
            args: entry.kind === "script" ? { branch: entry.name } : parameters }] };
    }
    function capabilityStatus(args = {}) {
        options(args, []);
        const data = load();
        function readOptional(relative) {
            try { return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relative), "utf8")); } catch (error) { return null; }
        }
        const certificate = readOptional(".ae-codex/bundle/installed-validation.json");
        const heartbeat = readOptional(".ae-codex/bridge/heartbeat.json");
        const ageMs = heartbeat && Number.isFinite(heartbeat.timestampEpochMs) ? Date.now() - heartbeat.timestampEpochMs : null;
        const certificateMatches = !!certificate && certificate.state === "success" && certificate.revision === data.catalog.revision &&
            certificate.branches === data.manifest.branches.length && certificate.fileBytes === data.bundleBytes && certificate.sha256 === data.bundleSha256;
        const heartbeatRoot = typeof heartbeat?.workspaceRoot === "string" ? heartbeat.workspaceRoot : null;
        const heartbeatRootCanonical = heartbeatRoot ? path.resolve(heartbeatRoot).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : null;
        const workspaceMatches = !!heartbeatRootCanonical && heartbeatRootCanonical === canonicalRoot;
        const revisionMatches = !!heartbeat?.scripts && heartbeat.scripts.revision === data.catalog.revision;
        const bridgeVersionMatches = !!heartbeat && heartbeat.bridgeVersion === data.catalog.bridgeVersion;
        const fresh = ageMs !== null && ageMs >= 0 && ageMs < 15000 && heartbeat?.state === "running" &&
            workspaceMatches && bridgeVersionMatches && revisionMatches;
        const connectionState = fresh ? "running" : heartbeat?.state === "running" ? "stale" : heartbeat?.state || "unknown";
        return { schema: "codex-ae-capability-status/v1", revision: data.catalog.revision,
            functions: data.catalog.functions.length, activeTools: data.catalog.functions.length, scripts: data.manifest.branches.length, archivedScripts: data.manifest.branches.length,
            coverage: data.manifest.coverage, summary: data.manifest.summary,
            dispatchMappings: { mapped: data.entries.length, active: data.catalog.functions.length, archived: data.manifest.branches.length, complete: true, mode: "reusable-tools-with-separate-legacy-archive" },
            installation: { certificateMatches, verifiedAtUtc: certificate?.verifiedAtUtc || null },
            connection: { fresh, ageMs, workspaceRoot: heartbeatRoot,
                workspaceMatches, state: connectionState, bridgeVersion: heartbeat?.bridgeVersion || null,
                bridgeVersionMatches, revisionMatches,
                reportedBranches: heartbeat?.scripts?.total ?? null },
            runtimeVerified: false,
            explanation: "Complete mapping and static validation do not prove a historical script is suitable for the open project. Scripts were not executed by this scan." };
    }
    return { searchCapabilities, inspectCapability, resolveCapabilityRequest, capabilityStatus };
}
const api = createCapabilitiesApi();
module.exports = { createCapabilitiesApi, ...api };
