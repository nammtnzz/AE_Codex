"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {scanTomlStatements, upsertMcpConfig, readInstalledMcpSettings, registerFile, removeMcpConfig, removeFile} = require("../tools/AeCodexConfig");
const root = path.resolve(__dirname, "../.ae-codex/tests/codex-config-" + crypto.randomUUID());
const settings = {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    serverPath: "D:\\Người mới\\Codex AE\\tools\\AeFunctionsMcp.js",
    powershellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    workspaceRoot: "D:\\Người mới\\Codex AE"
};
let passed = 0;
function test(name, run) { run(); passed++; }
try {
    fs.mkdirSync(root, {recursive: true});
    test("fresh desktop registration is independent of a CLI", () => {
        const text = upsertMcpConfig("", settings), installed = readInstalledMcpSettings(text);
        assert.equal(installed.command, settings.nodePath.replace(/\\/g, "/"));
        assert.deepEqual(installed.args, [settings.serverPath.replace(/\\/g, "/")]);
        assert.equal(installed.cwd, settings.workspaceRoot.replace(/\\/g, "/"));
        assert.equal(installed.env.CODEX_AE_PWSH, settings.powershellPath.replace(/\\/g, "/"));
        assert.equal(installed.enabled, true);
        assert.match(text, /^startup_timeout_sec = 10$/m);
        assert.match(text, /^tool_timeout_sec = 210$/m);
        assert.equal(upsertMcpConfig(text, settings), text);
    });
    test("model, policies, other servers and prompt literals are byte-preserved", () => {
        const prefix = '# user preferences\r\nmodel = "fixture-model"\r\napproval_policy = "never"\r\nprompt = """\r\n[mcp_servers.ae_functions]\r\ncommand = "inside-prompt"\r\n"""\r\n';
        const suffix = '\r\n[mcp_servers.other]\r\ncommand = "other-server"\r\nsecret = "fixture-secret"\r\n[projects."D:/personal"]\r\ntrust_level = "trusted"\r\n';
        const original = prefix + '[mcp_servers."ae_functions"] # owned\r\ncommand = "old-path"\r\nargs = [\r\n "old-server"\r\n]\r\ncwd = "old-cwd"\r\nstartup_timeout_sec = 1\r\ntool_timeout_sec = 2\r\n[mcp_servers.ae_functions.env]\r\nCODEX_AE_PWSH = "old-shell"\r\nTOKEN = "keep-fixture-token"\r\n' + suffix;
        const updated = upsertMcpConfig(original, settings);
        assert.ok(updated.startsWith(prefix));
        assert.ok(updated.endsWith(suffix));
        assert.ok(updated.includes('TOKEN = "keep-fixture-token"\r\n'));
        assert.ok(!updated.includes('"old-path"') && !updated.includes('"old-server"') && !updated.includes('"old-shell"'));
        assert.equal(upsertMcpConfig(updated, settings), updated);
    });
    test("literal multiline prompt and multiline arrays cannot impersonate owned tables", () => {
        const prefix = "prompt = '''\n[mcp_servers.ae_functions]\ncommand = 'inside prompt'\n'''\narray = [\n '[mcp_servers.ae_functions]', # comment\n \"false-header\",\n]\n";
        const updated = upsertMcpConfig(prefix, settings);
        assert.ok(updated.startsWith(prefix));
        assert.equal(readInstalledMcpSettings(updated).cwd, settings.workspaceRoot.replace(/\\/g, "/"));
    });
    test("explicit disabled preference is preserved", () => {
        const updated = upsertMcpConfig('[mcp_servers.ae_functions]\nenabled = false # user disabled\ncommand = "old"\n', settings);
        assert.ok(updated.includes("enabled = false # user disabled\n"));
        assert.equal(readInstalledMcpSettings(updated).enabled, false);
    });
    test("header without terminal newline and implicit parent table", () => {
        for (const original of ['[mcp_servers.ae_functions]', '[mcp_servers.ae_functions.env]\nKEEP = "fixture"']) {
            const updated = upsertMcpConfig(original, settings);
            assert.equal(readInstalledMcpSettings(updated).command, settings.nodePath.replace(/\\/g, "/"));
            assert.equal(upsertMcpConfig(updated, settings), updated);
        }
    });
    test("malformed or ambiguous configuration is rejected before any rewrite", () => {
        const invalid = [
            '[mcp_servers.ae_functions]\n[mcp_servers."ae_functions"]',
            '[mcp_servers.ae_functions]\ncommand = "a"\ncommand = "b"',
            '[mcp_servers.ae_functions]\nenabled = "false"',
            'prompt = """\nunfinished',
            '[mcp_servers.ae_functions',
            '[mcp_servers.ae_functions]\nargs = ["unfinished"',
            '[mcp_servers.ae_functions]\nnot an assignment',
            '[mcp_servers.ae_functions]\ncommand = ???',
            'model = "one"\nmodel = "two"',
            '[[mcp_servers.ae_functions]]\ncommand = "a"',
            '[mcp_servers]\nae_functions = { command = "inline" }',
            'mcp_servers.ae_functions.command = "dotted"',
            'mcp_servers = { other = { command = "fixture" } }',
            '[mcp_servers.ae_functions.command]\ninvalid = "fixture"',
            '[mcp_servers.ae_functions]\nenv = { CODEX_AE_PWSH = "inline" }',
            '[mcp_servers.ae_functions]\nurl = "https://fixture.invalid"'
        ];
        for (const text of invalid) assert.throws(() => upsertMcpConfig(text, settings), /Cannot safely update/);
    });
    test("new config is created only under the requested fixture and no account data appears", () => {
        const configPath = path.join(root, "new user", ".codex", "config.toml");
        const result = registerFile(configPath, settings);
        assert.equal(result.changed, true);
        assert.equal(result.backupPath, null);
        assert.equal(result.enabled, true);
        assert.ok(fs.existsSync(configPath));
        assert.equal(fs.readdirSync(path.dirname(configPath)).join(""), "config.toml");
        const again = registerFile(configPath, settings);
        assert.deepEqual(again, {changed: false, backupPath: null, enabled: true});
    });
    test("existing config backup remains adjacent and unchanged; idempotent update creates no extra copy", () => {
        const configPath = path.join(root, "backup", "config.toml");
        fs.mkdirSync(path.dirname(configPath));
        const original = 'model = "fixture-model"\n[mcp_servers.ae_functions]\ncommand = "old"\n';
        fs.writeFileSync(configPath, original);
        const result = registerFile(configPath, settings);
        assert.equal(path.dirname(result.backupPath), path.dirname(configPath));
        assert.equal(fs.readFileSync(result.backupPath, "utf8"), original);
        assert.equal(registerFile(configPath, settings).changed, false);
        assert.equal(fs.readdirSync(path.dirname(configPath)).length, 2);
    });
    test("invalid config creates neither backup nor new content", () => {
        const configPath = path.join(root, "invalid.toml");
        const original = '[mcp_servers.ae_functions]\ncommand = "unterminated';
        fs.writeFileSync(configPath, original);
        assert.throws(() => registerFile(configPath, settings));
        assert.equal(fs.readFileSync(configPath, "utf8"), original);
        assert.ok(!fs.readdirSync(root).some(name => name.startsWith("invalid.toml.")));
    });
    test("concurrent registration lock is respected and never automatically removed", () => {
        const configPath = path.join(root, "locked.toml");
        const lockPath = configPath + ".ae-functions.lock";
        fs.writeFileSync(lockPath, "fixture-lock");
        assert.throws(() => registerFile(configPath, settings), /another AE registration/);
        assert.ok(!fs.existsSync(configPath));
        assert.equal(fs.readFileSync(lockPath, "utf8"), "fixture-lock");
    });
    test("owned removal preserves unrelated bytes, comments, BOM and prompt headers", () => {
        const prefix = '\uFEFFmodel = "fixture"\r\nprompt = """\r\n[mcp_servers.ae_functions]\r\ncommand = "inside-prompt"\r\n"""\r\n';
        const comment = '# keep standalone comment\r\n';
        const suffix = '\r\n[mcp_servers.ae_functions_other]\r\ncommand = "other"\r\n[mcp_servers.other.env]\r\nTOKEN = "fixture-secret"\r\n';
        const body = upsertMcpConfig("", settings).replace(/\n/g, "\r\n")
            .replace('[mcp_servers.ae_functions]', '["mcp_servers".\'ae_functions\'] # owned header')
            .replace('enabled = true', 'enabled = false # disabled by user')
            .replace('[mcp_servers.ae_functions.env]', comment + '[mcp_servers.ae_functions.env]') + 'EXTRA_ENV = "fixture-owned-env"\r\n';
        const result = removeMcpConfig(prefix + body + suffix, {runtimeRoot: settings.workspaceRoot, nodePath: settings.nodePath});
        assert.equal(result.owned, true);
        assert.equal(result.text, prefix + comment + suffix);
        scanTomlStatements(result.text);
        const bomOnly = removeMcpConfig('\uFEFF' + upsertMcpConfig("", settings), {runtimeRoot: settings.workspaceRoot, nodePath: settings.nodePath});
        assert.equal(bomOnly.text, '\uFEFF');
    });
    test("runtime, command, argument and cwd ownership must all match", () => {
        const owned = upsertMcpConfig("", settings);
        const foreign = [
            owned.replace('command = ' + JSON.stringify(settings.nodePath.replace(/\\/g, "/")), 'command = "C:/foreign/node.exe"'),
            owned.replace('command = ' + JSON.stringify(settings.nodePath.replace(/\\/g, "/")), 'command = "node.exe"'),
            owned.replace('args = ' + JSON.stringify([settings.serverPath.replace(/\\/g, "/")]), 'args = ["D:/foreign/tools/AeFunctionsMcp.js"]'),
            owned.replace('args = ' + JSON.stringify([settings.serverPath.replace(/\\/g, "/")]), 'args = ' + JSON.stringify([settings.serverPath.replace(/\\/g, "/"), "--other"])),
            owned.replace('cwd = ' + JSON.stringify(settings.workspaceRoot.replace(/\\/g, "/")), 'cwd = "D:/foreign"'),
            owned.replace(/^command = .*\n/m, "")
        ];
        for (const text of foreign) {
            const result = removeMcpConfig(text, {runtimeRoot: settings.workspaceRoot, nodePath: settings.nodePath});
            assert.equal(result.owned, false);
            assert.equal(result.text, text);
            assert.ok(result.warning);
        }
        if (process.platform === "win32") {
            const result = removeMcpConfig(owned, {runtimeRoot: settings.workspaceRoot.toUpperCase() + "\\.\\", nodePath: settings.nodePath.toUpperCase()});
            assert.equal(result.owned, true);
        }
    });
    test("unsupported or incomplete AE representations are preserved in full", () => {
        const unsupported = [
            '[mcp_servers]\nae_functions = { command = "inline" }\n',
            'mcp_servers.ae_functions.command = "dotted"\n',
            'mcp_servers = { ae_functions = { command = "inline" } }\n',
            '[mcp_servers.ae_functions.env]\nCODEX_AE_PWSH = "fixture"\n',
            upsertMcpConfig("", settings) + '[mcp_servers.ae_functions.extra]\nKEY = "keep"\n',
            upsertMcpConfig("", settings).replace('enabled = true', 'env = { TOKEN = "keep" }\nenabled = true'),
            upsertMcpConfig("", settings).replace('enabled = true', 'url = "https://fixture.invalid"\nenabled = true')
        ];
        for (const text of unsupported) {
            const result = removeMcpConfig(text, {runtimeRoot: settings.workspaceRoot, nodePath: settings.nodePath});
            assert.equal(result.owned, false);
            assert.equal(result.text, text);
            assert.ok(result.warning);
        }
    });
    test("missing and unrelated files remain absent or unchanged without backups", () => {
        const missing = path.join(root, "missing-parent", "config.toml");
        assert.deepEqual(removeFile(missing, settings.workspaceRoot, settings.nodePath), {state: "success", changed: false, owned: false, backupPath: null});
        assert.ok(!fs.existsSync(path.dirname(missing)));
        const configPath = path.join(root, "unrelated.toml");
        const original = 'model = "fixture-model"\n[mcp_servers.other]\ncommand = "keep"\n';
        fs.writeFileSync(configPath, original);
        const result = removeFile(configPath, settings.workspaceRoot, settings.nodePath);
        assert.equal(result.changed, false);
        assert.equal(result.owned, false);
        assert.equal(fs.readFileSync(configPath, "utf8"), original);
        assert.ok(!fs.readdirSync(root).some(name => name.startsWith("unrelated.toml.")));
    });
    test("owned file removal makes one exact backup and is idempotent", () => {
        const configPath = path.join(root, "remove-owned.toml");
        const prefix = 'model = "fixture-model"\n';
        const original = prefix + upsertMcpConfig("", settings);
        fs.writeFileSync(configPath, original);
        const result = removeFile(configPath, settings.workspaceRoot, settings.nodePath);
        assert.equal(result.state, "success");
        assert.equal(result.changed, true);
        assert.equal(result.owned, true);
        assert.equal(path.dirname(result.backupPath), root);
        assert.equal(fs.readFileSync(result.backupPath, "utf8"), original);
        assert.equal(fs.readFileSync(configPath, "utf8"), prefix);
        assert.deepEqual(removeFile(configPath, settings.workspaceRoot, settings.nodePath), {state: "success", changed: false, owned: false, backupPath: null});
        assert.equal(fs.readdirSync(root).filter(name => name.startsWith("remove-owned.toml.")).length, 1);
    });
    test("foreign and malformed files never publish removal or create backups", () => {
        for (const [name, original, invalid] of [
            ["foreign-remove.toml", upsertMcpConfig("", {...settings, workspaceRoot: "D:/foreign"}), false],
            ["malformed-remove.toml", 'secret = "fixture-secret"\n[mcp_servers.ae_functions]\nargs = ["unfinished"', true]
        ]) {
            const configPath = path.join(root, name);
            fs.writeFileSync(configPath, original);
            if (invalid) assert.throws(() => removeFile(configPath, settings.workspaceRoot, settings.nodePath), /Cannot safely update/);
            else {
                const result = removeFile(configPath, settings.workspaceRoot, settings.nodePath);
                assert.equal(result.changed, false);
                assert.equal(result.owned, false);
                assert.ok(result.warning);
            }
            assert.equal(fs.readFileSync(configPath, "utf8"), original);
            assert.ok(!fs.readdirSync(root).some(entry => entry.startsWith(name + ".")));
        }
    });
    test("concurrent edits and existing locks are preserved during removal", () => {
        const configPath = path.join(root, "remove-concurrent.toml");
        const original = upsertMcpConfig("", settings), external = original + '# external change\n';
        fs.writeFileSync(configPath, original);
        const writeFileSync = fs.writeFileSync;
        fs.writeFileSync = function (target, ...args) {
            const result = writeFileSync.call(fs, target, ...args);
            if (String(target).startsWith(configPath + ".ae-functions-") && String(target).endsWith(".tmp")) writeFileSync.call(fs, configPath, external);
            return result;
        };
        try { assert.throws(() => removeFile(configPath, settings.workspaceRoot, settings.nodePath), /changed concurrently/); }
        finally { fs.writeFileSync = writeFileSync; }
        assert.equal(fs.readFileSync(configPath, "utf8"), external);
        assert.ok(!fs.readdirSync(root).some(name => name.startsWith("remove-concurrent.toml.")));
        const lockPath = configPath + ".ae-functions.lock";
        fs.writeFileSync(lockPath, "fixture-owned-by-other");
        assert.throws(() => removeFile(configPath, settings.workspaceRoot, settings.nodePath), /another AE configuration update/);
        assert.equal(fs.readFileSync(lockPath, "utf8"), "fixture-owned-by-other");
        assert.equal(fs.readFileSync(configPath, "utf8"), external);
    });
    test("publication failure leaves original, backup and no temporary or lock files", () => {
        const configPath = path.join(root, "remove-failure.toml");
        const original = upsertMcpConfig("", settings);
        fs.writeFileSync(configPath, original);
        const renameSync = fs.renameSync;
        fs.renameSync = function (source, target) {
            if (target === configPath) throw new Error("fixture rename failure");
            return renameSync.call(fs, source, target);
        };
        try { assert.throws(() => removeFile(configPath, settings.workspaceRoot, settings.nodePath), /fixture rename failure/); }
        finally { fs.renameSync = renameSync; }
        assert.equal(fs.readFileSync(configPath, "utf8"), original);
        const artifacts = fs.readdirSync(root).filter(name => name.startsWith("remove-failure.toml."));
        assert.equal(artifacts.length, 1);
        assert.ok(artifacts[0].includes(".ae-functions-backup-"));
        assert.equal(fs.readFileSync(path.join(root, artifacts[0]), "utf8"), original);
    });
    test("symbolic link or junction ancestors cannot redirect config removal", () => {
        const target = path.join(root, "junction-target"), junction = path.join(root, "junction-parent");
        fs.mkdirSync(target);
        const original = upsertMcpConfig("", settings);
        fs.writeFileSync(path.join(target, "config.toml"), original);
        fs.symlinkSync(target, junction, process.platform === "win32" ? "junction" : "dir");
        assert.throws(() => removeFile(path.join(junction, "config.toml"), settings.workspaceRoot, settings.nodePath), /symbolic links or junctions/);
        assert.equal(fs.readFileSync(path.join(target, "config.toml"), "utf8"), original);
        assert.deepEqual(fs.readdirSync(target), ["config.toml"]);
        fs.unlinkSync(junction);
        assert.throws(() => removeFile(target, settings.workspaceRoot, settings.nodePath), /must be a regular file/);
    });
    test("remove CLI uses current Node and emits only safe JSON or generic errors", () => {
        const runtimeRoot = path.join(root, "CLI runtime"), configPath = path.join(root, "cli-remove.toml");
        fs.writeFileSync(configPath, upsertMcpConfig('model = "fixture"\n', {...settings, nodePath: process.execPath, serverPath: path.join(runtimeRoot, "tools", "AeFunctionsMcp.js"), workspaceRoot: runtimeRoot}));
        const cli = spawnSync(process.execPath, [path.resolve(__dirname, "../tools/AeCodexConfig.js"), "--remove", configPath, runtimeRoot], {encoding: "utf8"});
        assert.equal(cli.status, 0, cli.stderr);
        const result = JSON.parse(cli.stdout);
        assert.equal(result.state, "success");
        assert.equal(result.changed, true);
        assert.equal(result.owned, true);
        assert.equal(fs.readFileSync(configPath, "utf8"), 'model = "fixture"\n');
        fs.writeFileSync(configPath, 'secret = "fixture-secret"\n[mcp_servers.ae_functions]\nargs = ["unfinished"');
        const invalid = spawnSync(process.execPath, [path.resolve(__dirname, "../tools/AeCodexConfig.js"), "--remove", configPath, runtimeRoot], {encoding: "utf8"});
        assert.equal(invalid.status, 1);
        assert.equal(invalid.stdout, "");
        assert.match(invalid.stderr, /Cannot safely update Codex configuration/);
        assert.ok(!invalid.stderr.includes("fixture-secret"));
    });
    console.log(`Codex desktop configuration tests passed: ${passed} groups (isolated fixtures; no real config touched).`);
} finally {
    const allowed = path.resolve(__dirname, "../.ae-codex/tests") + path.sep;
    if (!root.startsWith(allowed)) throw new Error("Unexpected fixture cleanup path.");
    fs.rmSync(root, {recursive: true, force: true});
}
