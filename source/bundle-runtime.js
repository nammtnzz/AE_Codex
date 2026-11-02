/* ES3 runtime. Branch bodies remain inert in the indexed comment at EOF. */
(function () {
    function workspaceRoot() {
        var configured = $.global.__CODEX_AE_WORKSPACE_ROOT__, script;
        if (typeof configured === "string" && configured.replace(/^\s+|\s+$/g, "")) {
            return (new Folder(configured)).fsName.replace(/\\/g, "/").replace(/\/$/, "");
        }
        script = new File($.fileName);
        if (String(script.parent.name).toLowerCase() !== "jsx") {
            throw new Error("Open Codex Bridge through its installed loader or the workspace jsx folder.");
        }
        return script.parent.parent.fsName.replace(/\\/g, "/").replace(/\/$/, "");
    }
    var ROOT = workspaceRoot();
    var PATH = ROOT + "/jsx/Codex Bridge.jsx";
    var nativeEvalFile = $.evalFile;
    function checksum(text) {
        var a = 1, b = 0, i;
        for (i = 0; i < text.length; i += 1) {
            a = (a + text.charCodeAt(i)) % 65521;
            b = (b + a) % 65521;
        }
        return String(b * 65536 + a);
    }
    function readRange(file, offset, length) {
        var text;
        if (!file.seek(offset, 0)) { throw new Error("Bundle seek failed: " + offset); }
        text = file.read(length);
        if (text.length !== length) { throw new Error("Bundle is truncated at " + offset); }
        return text;
    }
    function validName(name) {
        return /^[A-Za-z0-9 _.-]+\.jsx$/.test(name) && name.indexOf("..") < 0;
    }
    function decodeModule(record) {
        var out = [], i = 1, character, hex;
        if (record.charAt(0) !== '"' || record.charAt(record.length - 1) !== '"') { throw new Error("Invalid module string"); }
        while (i < record.length - 1) {
            character = record.charAt(i++);
            if (character === '"' || character.charCodeAt(0) < 32) { throw new Error("Invalid module string character"); }
            if (character === "\\") {
                character = record.charAt(i++);
                if (character === "u") {
                    hex = record.substr(i, 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex) || i + 4 > record.length - 1) { throw new Error("Invalid module Unicode escape"); }
                    out.push(String.fromCharCode(parseInt(hex, 16))); i += 4;
                } else if (character === "n") { out.push("\n"); }
                else if (character === "r") { out.push("\r"); }
                else if (character === "t") { out.push("\t"); }
                else if (character === "b") { out.push("\b"); }
                else if (character === "f") { out.push("\f"); }
                else if (character === '"' || character === "/" || character === "\\") { out.push(character); }
                else { throw new Error("Invalid module escape"); }
            } else { out.push(character); }
        }
        if (i !== record.length - 1) { throw new Error("Truncated module string"); }
        return out.join("");
    }
    function Bundle() {
        this.revision = "";
        this.names = [];
        this.entries = {};
        this.modules = {};
        this.moduleCache = {};
        this.cacheOrder = [];
        this.cacheSize = 0;
        this.sharedModules = 0;
        this.checked = 0;
        this.errors = [];
        this.error = "";
        this.lastPoll = 0;
        this.lastCycle = 0;
        this.fileStamp = "";
        this.depth = 0;
        this.installation = { state: "missing", message: "Installation validation has not been recorded" };
    }
    Bundle.prototype.refresh = function (force) {
        var file = new File(PATH), stamp, fields, index, rows, row, i, j, end = 0, entries = {}, foldedNames = {}, names = [], modules = {}, moduleCount = 0;
        try {
            if (!file.exists || file.alias || file.parent.alias) { throw new Error("Workspace bundle missing or aliased"); }
            stamp = String(file.length) + ":" + (file.modified ? file.modified.getTime() : "");
            this.lastPoll = new Date().getTime();
            if (!force && stamp === this.fileStamp && !this.error) { return false; }
            file.encoding = "BINARY";
            if (!file.open("r")) { throw new Error("Cannot open workspace bundle: " + file.error); }
            try {
                file.readln(); file.readln(); fields = file.readln().split("\t");
                if (fields.length !== 7 || fields[0] !== "// CODEX_AE_BUNDLE_V2" ||
                        !/^[a-f0-9]{64}$/.test(fields[1])) { throw new Error("Invalid bundle header"); }
                for (i = 2; i < fields.length; i += 1) {
                    if (!/^\d+$/.test(fields[i])) { throw new Error("Invalid bundle header number"); }
                }
                if (Number(fields[2]) !== file.length || Number(fields[4]) > 1048576 ||
                        Number(fields[5]) > 4294967295 || Number(fields[6]) < 1) { throw new Error("Bundle size/count mismatch"); }
                index = readRange(file, Number(fields[3]), Number(fields[4]));
                if (checksum(index) !== fields[5]) { throw new Error("Bundle index checksum mismatch"); }
                rows = index.replace(/\n$/, "").split("\n");
                this.payloadOffset = Number(fields[3]) + Number(fields[4]);
                for (i = 0; i < rows.length; i += 1) {
                    row = rows[i].split("\t");
                    if (!/^\d+$/.test(row[2]) || !/^\d+$/.test(row[3]) || !/^\d+$/.test(row[4]) ||
                            Number(row[2]) !== end) { throw new Error("Invalid bundle record: " + row[1]); }
                    if (row[0] === "B" && row.length === 7 && validName(row[1]) && !foldedNames.hasOwnProperty(row[1].toLowerCase()) && /^\d+$/.test(row[6])) {
                        entries[row[1]] = { offset: Number(row[2]), length: Number(row[3]), checksum: row[4], sourceChecksum: row[6],
                            dependencies: row[5] ? row[5].split("|") : [], state: "pending", error: "" };
                        names.push(row[1]);
                        foldedNames[row[1].toLowerCase()] = true;
                    } else if (row[0] === "M" && row.length === 5 && /^m[0-9]+$/.test(row[1]) && !modules.hasOwnProperty(row[1])) {
                        modules[row[1]] = { offset: Number(row[2]), length: Number(row[3]), checksum: row[4], users: 0 };
                        moduleCount += 1;
                    } else { throw new Error("Invalid/duplicate bundle branch or module: " + row[1]); }
                    end = Number(row[2]) + Number(row[3]) + 1;
                }
                if (names.length !== Number(fields[6])) { throw new Error("Missing bundle index rows"); }
                if (this.payloadOffset + end + 3 !== file.length) { throw new Error("Bundle payload size mismatch"); }
                for (i = 0; i < names.length; i += 1) {
                    row = entries[names[i]];
                    for (j = 0; j < row.dependencies.length; j += 1) {
                        if (!entries.hasOwnProperty(row.dependencies[j]) && row.dependencies[j] !== "Codex Bridge.jsx") {
                            throw new Error("Missing dependency " + row.dependencies[j] + " for " + names[i]);
                        }
                    }
                }
                this.entries = entries; this.names = names; this.modules = modules; this.moduleCount = moduleCount;
                this.moduleCache = {}; this.cacheOrder = []; this.cacheSize = 0; this.sharedModules = 0;
                this.revision = fields[1];
                this.fileStamp = stamp; this.checked = 0; this.errors = []; this.error = "";
                this.lastCycle = new Date().getTime();
                this.loadInstallation();
            } finally { file.close(); }
            return true;
        } catch (error) {
            this.error = String(error);
            throw error;
        }
    };
    Bundle.prototype.has = function (name) { return validName(name) && this.entries.hasOwnProperty(name); };
    Bundle.prototype.recordValidation = function (name, error) {
        var entry = this.entries[name], prefix = name + ": ", errors = [], i;
        if (!entry) { return; }
        entry.state = error ? "error" : "ok";
        entry.error = error ? String(error) : "";
        for (i = 0; i < this.errors.length; i += 1) {
            if (this.errors[i].indexOf(prefix) !== 0) { errors.push(this.errors[i]); }
        }
        if (error) { errors.push(prefix + entry.error); }
        this.errors = errors;
    };
    Bundle.prototype.loadInstallation = function () {
        var file = new File(ROOT + "/.ae-codex/bundle/installed-validation.tsv"), fields, text;
        this.installation = { state: "missing", message: "Run the panel installer/update once to validate scripts" };
        if (!file.exists) { return false; }
        try {
            if (file.length > 4096) { throw new Error("Installation certificate is too large"); }
            file.encoding = "UTF-8";
            if (!file.open("r")) { throw new Error("Cannot read installation certificate"); }
            try { text = file.read().replace(/^\uFEFF/, "").replace(/\r?\n$/, ""); } finally { file.close(); }
            fields = text.split("\t");
            if (fields.length !== 6 || fields[0] !== "codex-ae-install/v1" ||
                    !/^[a-f0-9]{64}$/.test(fields[1]) || !/^[a-f0-9]{64}$/.test(fields[5]) ||
                    !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3]) || !/^\d+$/.test(fields[4])) {
                throw new Error("Invalid installation certificate");
            }
            if (fields[1] !== this.revision || Number(fields[2]) !== (new File(PATH)).length ||
                    Number(fields[3]) !== this.names.length || Number(fields[4]) !== this.moduleCount) {
                this.installation = { state: "stale", message: "Bundle updated; validate once with the panel updater" };
                return false;
            }
            this.installation = { state: "verified", message: "Verified at installation", sha256: fields[5] };
            return true;
        } catch (error) {
            this.installation = { state: "error", message: String(error) };
            return false;
        }
    };
    Bundle.prototype.readRecord = function (entry, name, isModule) {
        var file = new File(PATH), record;
        file.encoding = "BINARY";
        if (!file.open("r")) { throw new Error("Cannot read bundle: " + file.error); }
        try { record = readRange(file, this.payloadOffset + entry.offset, entry.length); }
        finally { file.close(); }
        if (checksum(record) !== entry.checksum) { throw new Error("Branch checksum mismatch: " + name); }
        return isModule ? decodeModule(record) : decodeURIComponent(record);
    };
    Bundle.prototype.recipe = function (name) {
        if (!this.has(name)) { throw new Error("Bundle branch missing: " + name); }
        return this.readRecord(this.entries[name], name);
    };
    Bundle.prototype.moduleSource = function (name) {
        var text, oldest;
        if (!this.modules.hasOwnProperty(name)) { throw new Error("Bundle module missing: " + name); }
        if (this.moduleCache.hasOwnProperty(name)) { return this.moduleCache[name]; }
        text = this.readRecord(this.modules[name], name, true);
        // Bound decoded-source memory independently of how many branches exist.
        if (text.length <= 131072) {
            while (this.cacheSize + text.length > 131072 && this.cacheOrder.length) {
                oldest = this.cacheOrder.shift(); this.cacheSize -= this.moduleCache[oldest].length;
                delete this.moduleCache[oldest];
            }
            this.moduleCache[name] = text; this.cacheOrder.push(name); this.cacheSize += text.length;
        }
        return text;
    };
    Bundle.prototype.source = function (name) {
        var recipe = this.recipe(name), parts = recipe ? recipe.split("|") : [], out = [], seen = {}, i, slice, text, module;
        for (i = 0; i < parts.length; i += 1) {
            slice = parts[i].split(":");
            if (slice.length !== 3 || !/^m[0-9]+$/.test(slice[0]) || !/^\d+$/.test(slice[1]) || !/^\d+$/.test(slice[2])) {
                throw new Error("Invalid module slice: " + name);
            }
            module = this.modules[slice[0]];
            text = this.moduleSource(slice[0]);
            if (Number(slice[1]) + Number(slice[2]) > text.length) { throw new Error("Invalid module slice: " + name); }
            out.push(text.substr(Number(slice[1]), Number(slice[2])));
            if (!seen.hasOwnProperty(slice[0])) {
                if (!module.branches) { module.branches = {}; }
                if (!module.branches.hasOwnProperty(name)) {
                    module.branches[name] = true; module.users += 1;
                    if (module.users === 2) { this.sharedModules += 1; }
                }
                seen[slice[0]] = true;
            }
        }
        text = out.join("");
        if (checksum(encodeURIComponent(text)) !== this.entries[name].sourceChecksum) { throw new Error("Branch source checksum mismatch: " + name); }
        return text;
    };
    Bundle.prototype.prepare = function (source) {
        return source.replace(/^\uFEFF/, "").replace(/^#target[^\r\n]*/gm, "").replace(/\$\.evalFile\s*\(/g,
            "$.global.__codexAeBundleV1.evalFile(");
    };
    Bundle.prototype.run = function (name) {
        var code;
        this.refresh(false);
        if (this.error) { throw new Error(this.error); }
        if (this.depth >= 32) { throw new Error("Bundle dependency recursion limit"); }
        try {
            code = this.prepare(this.source(name));
            this.recordValidation(name, null);
        } catch (validationError) {
            this.recordValidation(name, validationError);
            throw validationError;
        }
        this.depth += 1;
        try {
            // Only reviewed bundle code is evaluated; request data never becomes code.
            return (function (source) { return eval(source); }(code));
        } finally { this.depth -= 1; }
    };
    Bundle.prototype.evalFile = function (file) {
        var path = String(file.fsName || file).replace(/\\/g, "/"), prefix = (ROOT + "/jsx/").toLowerCase(), name;
        if (path.toLowerCase().indexOf(prefix) === 0) {
            name = path.substring(prefix.length);
            if (name !== "Codex Bridge.jsx") {
                if (!validName(name)) { throw new Error("Invalid bundle branch path"); }
                return this.run(name);
            }
        }
        return nativeEvalFile(file);
    };
    Bundle.prototype.tick = function () {
        var now = new Date().getTime(), started = now, count = 0, name, entry;
        try {
            if (now - this.lastPoll >= 2000) { this.refresh(false); }
            if (this.error) { return; }
            // Explicit diagnostic only. The panel never schedules full-script scans.
            while (this.checked < this.names.length && count < 8) {
                name = this.names[this.checked]; entry = this.entries[name];
                try {
                    // Parse without running any project edits, imports, saves or renders.
                    new Function(this.prepare(this.source(name)));
                    this.recordValidation(name, null);
                } catch (error) {
                    this.recordValidation(name, error);
                }
                this.checked += 1; count += 1;
                if (new Date().getTime() - started >= 8) { break; }
            }
        } catch (error) { this.error = String(error); }
    };
    Bundle.prototype.describe = function () {
        if (this.error) { return "Scripts ERROR: " + this.error; }
        if (this.errors.length) { return "Scripts ERROR: " + this.errors.length + " branch(es) - " + this.errors[0]; }
        return "Archive: " + this.names.length + " historical scripts | " +
            (this.installation.state === "verified" ? "verified at installation" : this.installation.message) +
            " | on demand";
    };
    Bundle.prototype.status = function () {
        return { revision: this.revision, total: this.names.length, checked: this.checked, modules: this.moduleCount,
            sharedModules: this.sharedModules, cachedSourceCharacters: this.cacheSize,
            validationMode: "installation-only", installationState: this.installation.state,
            errors: this.errors.length + (this.error ? 1 : 0), state: this.error || this.errors.length ? "error" :
                (this.installation.state === "verified" || this.checked === this.names.length ? "ready" : "unverified") };
    };
    $.global.__codexAeBundleV1 = new Bundle();
}());
