"use strict";

// Lossless, narrowly scoped Codex MCP configuration editing. This scanner is not
// a general TOML serializer: it keeps every unrelated statement exactly as read.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function fail(message) { throw new Error("Cannot safely update Codex configuration: " + message); }
function tomlString(value) { return JSON.stringify(String(value)); }
function parseString(value) {
    if (value.startsWith("'") && value.endsWith("'") && !value.startsWith("'''")) return value.slice(1, -1);
    try {
        return JSON.parse(value.replace(/\\U([0-9a-fA-F]{8})/g, (_, digits) => {
            const point = parseInt(digits, 16);
            if (point > 0x10ffff) fail("invalid Unicode escape.");
            return String.fromCodePoint(point);
        }));
    } catch (_) { fail("unsupported quoted key or owned string value."); }
}
function keyPath(source) {
    let offset = 0;
    const keys = [];
    while (offset < source.length) {
        while (/\s/.test(source[offset] || "") && offset < source.length) offset++;
        const start = offset;
        if (source[offset] === '"' || source[offset] === "'") {
            const quote = source[offset++];
            let closed = false;
            while (offset < source.length) {
                if (quote === '"' && source[offset] === "\\") { offset += 2; continue; }
                if (source[offset++] === quote) { closed = true; break; }
            }
            if (!closed) fail("unterminated quoted key.");
            keys.push(parseString(source.slice(start, offset)));
        } else {
            while (/[A-Za-z0-9_-]/.test(source[offset] || "") && offset < source.length) offset++;
            if (offset === start) fail("malformed table or key.");
            keys.push(source.slice(start, offset));
        }
        while (/\s/.test(source[offset] || "") && offset < source.length) offset++;
        if (offset === source.length) break;
        if (source[offset++] !== "." || offset === source.length) fail("malformed dotted key.");
    }
    if (!keys.length) fail("empty table or key.");
    return keys;
}

function scanTomlStatements(text) {
    const statements = [];
    let begin = 0, code = "", quote = "", multiline = false, comment = false;
    const brackets = [];
    function emit(end, after) {
        const significant = code.replace(/^\uFEFF/, "").trim();
        if (significant) statements.push({start: begin, end, after, code: significant});
        code = "";
        begin = after;
    }
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (comment) {
            if (ch !== "\n" && ch !== "\r") continue;
            comment = false;
        }
        if (quote) {
            if (!multiline && (ch === "\n" || ch === "\r")) fail("unterminated TOML string.");
            if (quote === '"' && ch === "\\") {
                if (i + 1 >= text.length) fail("unterminated TOML escape.");
                if (!multiline && /[\r\n]/.test(text[i + 1])) fail("unterminated TOML string.");
                code += ch + text[++i];
                continue;
            }
            if (multiline && text.slice(i, i + 3) === quote.repeat(3)) {
                let count = 3;
                while (text[i + count] === quote && count < 5) count++;
                code += quote.repeat(count); i += count - 1; quote = ""; multiline = false;
            } else { code += ch; if (!multiline && ch === quote) quote = ""; }
            continue;
        }
        if (ch === "#") { comment = true; continue; }
        if (ch === '"' || ch === "'") {
            quote = ch;
            multiline = text.slice(i, i + 3) === ch.repeat(3);
            code += multiline ? ch.repeat(3) : ch;
            if (multiline) i += 2;
            continue;
        }
        if (ch === "[" || ch === "{") brackets.push(ch);
        if (ch === "]" || ch === "}") {
            if (brackets.pop() !== (ch === "]" ? "[" : "{")) fail("unbalanced TOML delimiters.");
        }
        if ((ch === "\n" || ch === "\r") && !brackets.length) {
            const end = i;
            if (ch === "\r" && text[i + 1] === "\n") i++;
            emit(end, i + 1);
        } else code += ch;
    }
    if (quote || brackets.length) fail("unterminated TOML string, array or table.");
    emit(text.length, text.length);
    let currentTable = [], arrayContext = false;
    const seenTables = new Set(), seenAssignments = new Set();
    for (const statement of statements) {
        if (statement.code[0] === "[") {
            const array = statement.code.startsWith("[[");
            const ending = array ? "]]" : "]";
            if (!statement.code.endsWith(ending)) fail("malformed TOML table.");
            currentTable = keyPath(statement.code.slice(array ? 2 : 1, -ending.length));
            statement.type = "table"; statement.keys = currentTable; statement.array = array;
            const identity = JSON.stringify(currentTable);
            if (array) arrayContext = true;
            // Repeated child tables can be valid inside array-of-table entries.
            if ((!arrayContext || ownedPath(currentTable)) && !array) {
                if (seenTables.has(identity)) fail("duplicate TOML table.");
                seenTables.add(identity);
            }
            if (array && ownedPath(currentTable)) fail("the AE MCP entry must be a regular table.");
            continue;
        }
        // Locate an equals sign outside quoted key segments.
        let keyQuote = "", equals = -1;
        for (let i = 0; i < statement.code.length; i++) {
            const ch = statement.code[i];
            if (keyQuote) { if (keyQuote === '"' && ch === "\\") { i++; continue; } if (ch === keyQuote) keyQuote = ""; }
            else if (ch === '"' || ch === "'") keyQuote = ch;
            else if (ch === "=") { equals = i; break; }
        }
        if (equals < 0) fail("malformed TOML assignment.");
        statement.type = "assignment";
        statement.table = currentTable.slice(); statement.keys = keyPath(statement.code.slice(0, equals).trim());
        statement.value = statement.code.slice(equals + 1).trim();
        if (!statement.value || !/^(?:["'\[{]|true\s*$|false\s*$|[+-]?(?:inf|nan)\s*$|[+-]?\d[\dA-Fa-f_xXoObB.:+TeE Zz-]*\s*$)/.test(statement.value)) fail("malformed TOML value.");
        const fullPath = currentTable.concat(statement.keys);
        const identity = JSON.stringify(fullPath);
        if (!arrayContext || ownedPath(fullPath)) {
            if (seenAssignments.has(identity)) fail("duplicate TOML key.");
            seenAssignments.add(identity);
        }
    }
    return statements;
}
function ownedPath(keys) { return keys[0] === "mcp_servers" && keys[1] === "ae_functions"; }
function samePath(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function upsertMcpConfig(original, settings) {
    settings = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, String(value).replace(/\\/g, "/")]));
    const statements = scanTomlStatements(original);
    const mainPath = ["mcp_servers", "ae_functions"], envPath = mainPath.concat("env");
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const desired = {
        command: tomlString(settings.nodePath),
        args: JSON.stringify([settings.serverPath]),
        cwd: tomlString(settings.workspaceRoot),
        enabled: "true", startup_timeout_sec: "10", tool_timeout_sec: "210"
    };
    const edits = [], main = [], env = [];
    for (const statement of statements) {
        if (statement.type === "table" && ownedPath(statement.keys)) {
            if (samePath(statement.keys, mainPath)) main.push(statement);
            else if (samePath(statement.keys, envPath)) env.push(statement);
            else fail("the AE MCP entry supports only its regular server and environment tables.");
        }
        if (statement.type !== "assignment") continue;
        const full = statement.table.concat(statement.keys);
        if (samePath(full, ["mcp_servers"])) fail("an inline MCP server collection cannot be extended safely.");
        if (!ownedPath(full)) continue;
        if (!samePath(statement.table, mainPath) && !samePath(statement.table, envPath)) fail("dotted or inline AE MCP entries require a normal table before registration.");
        if (statement.keys.length !== 1) fail("dotted AE MCP settings are unsupported.");
        const key = statement.keys[0];
        if (samePath(statement.table, mainPath)) {
            if (["env", "url", "http_headers", "env_http_headers", "bearer_token_env_var"].includes(key)) fail("the existing AE MCP entry uses an inline environment or HTTP transport; convert it to stdio tables first.");
            if (Object.prototype.hasOwnProperty.call(desired, key)) {
                if (key === "enabled") {
                    if (!["true", "false"].includes(statement.value)) fail("AE enabled must be a boolean.");
                } else edits.push({start: statement.start, end: statement.end, text: key + " = " + desired[key]});
                delete desired[key];
            }
        } else if (key === "CODEX_AE_PWSH") {
            edits.push({start: statement.start, end: statement.end, text: "CODEX_AE_PWSH = " + tomlString(settings.powershellPath)});
        }
    }
    if (main.length > 1 || env.length > 1) fail("duplicate AE MCP tables.");
    function addToTable(table, header, text) {
        if (!text) return;
        if (table.length) {
            const position = table[0].after;
            const prefix = table[0].after === table[0].end ? newline : "";
            edits.push({start: position, end: position, text: prefix + text});
        } else {
            const prefix = original && !original.endsWith("\n") && !original.endsWith("\r") ? newline : "";
            edits.push({start: original.length, end: original.length, text: prefix + header + newline + text});
        }
    }
    addToTable(main, "[mcp_servers.ae_functions]", Object.keys(desired).map(key => key + " = " + desired[key] + newline).join(""));
    const envExists = statements.some(statement => statement.type === "assignment" && samePath(statement.table, envPath) && statement.keys[0] === "CODEX_AE_PWSH");
    if (!envExists) addToTable(env, "[mcp_servers.ae_functions.env]", "CODEX_AE_PWSH = " + tomlString(settings.powershellPath) + newline);
    // Stable insertion order also handles an initially empty config.
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let updated = original;
    for (let i = edits.length - 1; i >= 0; i--) {
        // Merge insertions at the same offset in their intended main/env order.
        if (i > 0 && edits[i].start === edits[i - 1].start && edits[i].end === edits[i].start && edits[i - 1].end === edits[i - 1].start) {
            edits[i - 1].text += edits[i].text;
            edits.splice(i, 1);
        }
    }
    for (const edit of edits) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
    scanTomlStatements(updated);
    return updated;
}

function readInstalledMcpSettings(text) {
    const result = {env: {}};
    for (const statement of scanTomlStatements(text)) {
        if (statement.type !== "assignment" || statement.keys.length !== 1) continue;
        if (samePath(statement.table, ["mcp_servers", "ae_functions"])) {
            const key = statement.keys[0];
            if (["command", "cwd"].includes(key)) result[key] = parseString(statement.value);
            if (key === "args") result.args = JSON.parse(statement.value);
            if (key === "enabled") result.enabled = statement.value === "true";
        }
        if (samePath(statement.table, ["mcp_servers", "ae_functions", "env"]) && statement.keys[0] === "CODEX_AE_PWSH") result.env.CODEX_AE_PWSH = parseString(statement.value);
    }
    return result;
}

function registerFile(configPath, settings) {
    const directory = path.dirname(configPath);
    fs.mkdirSync(directory, {recursive: true});
    if (fs.existsSync(configPath) && (!fs.lstatSync(configPath).isFile() || fs.lstatSync(configPath).isSymbolicLink())) fail("config.toml must be a regular file.");
    const lockPath = configPath + ".ae-functions.lock";
    let lock;
    try { lock = fs.openSync(lockPath, "wx", 0o600); }
    catch (_) { fail("another AE registration is in progress; retry after it finishes."); }
    let temporaryPath;
    try {
        const existed = fs.existsSync(configPath);
        const original = existed ? fs.readFileSync(configPath, "utf8") : "";
        const updated = upsertMcpConfig(original, settings);
        if (updated === original) return {changed: false, backupPath: null, enabled: readInstalledMcpSettings(updated).enabled};
        temporaryPath = configPath + ".ae-functions-" + crypto.randomUUID() + ".tmp";
        fs.writeFileSync(temporaryPath, updated, {encoding: "utf8", flag: "wx", mode: 0o600});
        if (fs.existsSync(configPath) !== existed || (existed && fs.readFileSync(configPath, "utf8") !== original)) fail("config.toml changed concurrently; registration was not published. Retry the installation.");
        let backupPath = null;
        if (existed) {
            backupPath = configPath + ".ae-functions-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomUUID() + ".toml";
            fs.writeFileSync(backupPath, original, {encoding: "utf8", flag: "wx", mode: 0o600});
        }
        fs.renameSync(temporaryPath, configPath);
        temporaryPath = null;
        return {changed: true, backupPath, enabled: readInstalledMcpSettings(updated).enabled};
    } finally {
        if (temporaryPath && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        fs.closeSync(lock);
        fs.unlinkSync(lockPath);
    }
}

function canonicalPath(value) {
    if (typeof value !== "string" || !value || !path.isAbsolute(value)) return null;
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Removal is deliberately narrower than registration: a similarly named server
// is not ours unless all three execution paths still match this installation.
function removeMcpConfig(original, settings) {
    const statements = scanTomlStatements(original);
    const mainPath = ["mcp_servers", "ae_functions"], envPath = mainPath.concat("env");
    const owned = [];
    let mainTable = false, unsupported = false;
    const values = {};
    for (const statement of statements) {
        if (statement.type === "table") {
            if (!ownedPath(statement.keys)) continue;
            owned.push(statement);
            if (samePath(statement.keys, mainPath)) mainTable = true;
            else if (!samePath(statement.keys, envPath)) unsupported = true;
            continue;
        }
        const full = statement.table.concat(statement.keys);
        if (samePath(full, ["mcp_servers"])) unsupported = true;
        if (!ownedPath(full)) continue;
        owned.push(statement);
        if ((!samePath(statement.table, mainPath) && !samePath(statement.table, envPath)) || statement.keys.length !== 1) {
            unsupported = true;
            continue;
        }
        if (samePath(statement.table, mainPath)) {
            const key = statement.keys[0];
            if (["env", "url", "http_headers", "env_http_headers", "bearer_token_env_var"].includes(key)) unsupported = true;
            values[key] = statement.value;
        }
    }
    const preserved = warning => ({text: original, owned: false, ...(warning ? {warning} : {})});
    if (unsupported) return preserved("The AE MCP configuration uses an unsupported representation and was preserved.");
    if (!owned.length) return preserved();
    if (!mainTable) return preserved("The AE MCP configuration is incomplete and was preserved.");
    let command, args, cwd;
    try {
        command = canonicalPath(parseString(values.command || ""));
        args = JSON.parse(values.args || "null");
        cwd = canonicalPath(parseString(values.cwd || ""));
    } catch (_) { return preserved("The AE MCP execution settings could not be verified and were preserved."); }
    const runtimeRoot = canonicalPath(settings.runtimeRoot);
    const nodePath = canonicalPath(settings.nodePath);
    if (!runtimeRoot || !nodePath) fail("absolute runtime and Node paths are required for removal.");
    const serverPath = canonicalPath(path.join(settings.runtimeRoot, "tools", "AeFunctionsMcp.js"));
    if (command !== nodePath || cwd !== runtimeRoot || !Array.isArray(args) || args.length !== 1 || canonicalPath(args[0]) !== serverPath) {
        return preserved("The AE MCP entry belongs to a different installation or command and was preserved.");
    }
    let updated = original;
    for (let index = owned.length - 1; index >= 0; index--) {
        const statement = owned[index];
        // Keep an initial UTF-8 BOM even when the first table is removed.
        const start = statement.start === 0 && original[0] === "\uFEFF" ? 1 : statement.start;
        updated = updated.slice(0, start) + updated.slice(statement.after);
    }
    scanTomlStatements(updated);
    return {text: updated, owned: true};
}

function safeConfigPath(configPath) {
    const resolved = path.resolve(configPath);
    let current = resolved, target = null;
    while (true) {
        let stat;
        try { stat = fs.lstatSync(current); }
        catch (error) {
            if (error.code !== "ENOENT") fail("the configuration path could not be inspected.");
        }
        if (stat) {
            if (stat.isSymbolicLink()) fail("the configuration path must not contain symbolic links or junctions.");
            if (current === resolved) {
                if (!stat.isFile()) fail("config.toml must be a regular file.");
                target = stat;
            } else if (!stat.isDirectory()) fail("the configuration parent must be a regular directory.");
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return target;
}

function removeFile(configPath, runtimeRoot, nodePath = process.execPath) {
    configPath = path.resolve(configPath);
    if (!safeConfigPath(configPath)) return {state: "success", changed: false, owned: false, backupPath: null};
    const lockPath = configPath + ".ae-functions.lock";
    let lock;
    try { lock = fs.openSync(lockPath, "wx", 0o600); }
    catch (_) { fail("another AE configuration update is in progress; retry after it finishes."); }
    const lockStat = fs.fstatSync(lock);
    let temporaryPath;
    try {
        const originalStat = safeConfigPath(configPath);
        if (!originalStat) fail("config.toml changed concurrently; removal was not published.");
        const original = fs.readFileSync(configPath, "utf8");
        const result = removeMcpConfig(original, {runtimeRoot, nodePath});
        if (!result.owned) return {state: "success", changed: false, owned: false, backupPath: null, ...(result.warning ? {warning: result.warning} : {})};
        function verifyUnchanged() {
            const current = safeConfigPath(configPath);
            if (!current || current.dev !== originalStat.dev || current.ino !== originalStat.ino || fs.readFileSync(configPath, "utf8") !== original) {
                fail("config.toml changed concurrently; removal was not published. Retry the uninstall.");
            }
        }
        verifyUnchanged();
        temporaryPath = configPath + ".ae-functions-" + crypto.randomUUID() + ".tmp";
        fs.writeFileSync(temporaryPath, result.text, {encoding: "utf8", flag: "wx", mode: 0o600});
        verifyUnchanged();
        const backupPath = configPath + ".ae-functions-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomUUID() + ".toml";
        fs.writeFileSync(backupPath, original, {encoding: "utf8", flag: "wx", mode: 0o600});
        verifyUnchanged();
        fs.renameSync(temporaryPath, configPath);
        temporaryPath = null;
        return {state: "success", changed: true, owned: true, backupPath};
    } finally {
        if (temporaryPath && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        fs.closeSync(lock);
        // Do not delete somebody else's replacement lock during cleanup.
        let currentLock;
        try { currentLock = fs.lstatSync(lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (currentLock && !currentLock.isSymbolicLink() && currentLock.dev === lockStat.dev && currentLock.ino === lockStat.ino) fs.unlinkSync(lockPath);
    }
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        let result;
        if (args[0] === "--remove") {
            if (args.length !== 3) throw new Error("Expected --remove, config and runtime paths.");
            result = removeFile(args[1], args[2]);
        } else {
            if (args.length !== 5) throw new Error("Expected config, Node, MCP server, PowerShell and runtime paths.");
            const [configPath, nodePath, serverPath, powershellPath, workspaceRoot] = args;
            result = registerFile(path.resolve(configPath), {nodePath, serverPath, powershellPath, workspaceRoot});
        }
        process.stdout.write(JSON.stringify(result));
    } catch (error) {
        // Never include configuration contents or unrelated credentials in errors.
        process.stderr.write(error.message + "\n");
        process.exitCode = 1;
    }
}
module.exports = {scanTomlStatements, upsertMcpConfig, readInstalledMcpSettings, registerFile, removeMcpConfig, removeFile};
