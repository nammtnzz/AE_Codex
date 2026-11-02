#target aftereffects
#targetengine "codexAeBridge"

/*
 * Codex AE Bridge
 *
 * Run this file once per After Effects session with:
 * File > Scripts > Run Script File...
 *
 * The bridge polls a local workspace inbox. It never evaluates request text;
 * it only loads reviewed bundle branches or direct .jsx files in jsx/.
 */
(function (thisObject) {
    // Direct-run fallback can load the dispatcher without creating/stopping a panel.
    if ($.global.__CODEX_AE_BUNDLE_ONLY__) { return; }
    if ($.global.__CODEX_AE_PANEL_HOST__ instanceof Panel) {
        thisObject = $.global.__CODEX_AE_PANEL_HOST__;
    }
    var GLOBAL_NAME = "__codexAeBridgeV1";
    var BRIDGE_VERSION = "2.0.4";
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
    var WORKSPACE_ROOT = workspaceRoot();
    var existingBridge = $.global[GLOBAL_NAME];
    var preserveReplacementStop = false;
    if (!existingBridge && thisObject instanceof Panel) {
        try {
            var anchoredBridge = thisObject.__codexAeBridgeOwnerV1;
            if (anchoredBridge) {
                if (anchoredBridge.window !== thisObject || !anchoredBridge.ui ||
                        normalizePath(anchoredBridge.workspaceRoot) !== normalizePath(WORKSPACE_ROOT)) {
                    refuseAnchoredPanel(anchoredBridge, "Panel này thuộc một cầu nối khác. Đóng panel cũ trước khi mở bản cài đặt này.");
                    return;
                }
                if (anchoredBridge.version !== BRIDGE_VERSION && (anchoredBridge.busy || anchoredBridge.pendingReport ||
                        anchoredBridge.pendingCleanupFile || anchoredBridge.scheduledCallbackActive || anchoredBridge.connectionActionActive)) {
                    refuseAnchoredPanel(anchoredBridge, "Chưa thể thay cầu nối cũ: còn thao tác hoặc kết quả chưa xác nhận. Không chạy lại lệnh.");
                    return;
                }
                existingBridge = anchoredBridge;
                if (anchoredBridge.version === BRIDGE_VERSION) { $.global[GLOBAL_NAME] = anchoredBridge; }
                else { preserveReplacementStop = anchoredBridge.manualStop === true ||
                    (!anchoredBridge.running && anchoredBridge.lastStatus === "Bridge stopped"); }
            }
        } catch (missingHostAnchorError) {
            try { $.writeln("Codex AE cannot read the existing panel owner; close and reopen the panel."); } catch (anchorLogError) {}
            return;
        }
    }
    var autoStartOnly = !!$.global.__CODEX_AE_AUTOSTART_ONLY__;
    var sameWorkspace = existingBridge && normalizePath(existingBridge.workspaceRoot) === normalizePath(WORKSPACE_ROOT);
    if (autoStartOnly && existingBridge && existingBridge.version === BRIDGE_VERSION && sameWorkspace) {
        // A Startup loader must not duplicate a listener or override manual Stop.
        return;
    }
    if (!autoStartOnly && existingBridge && existingBridge.version === BRIDGE_VERSION && sameWorkspace &&
            existingBridge.window && existingBridge.ui) {
        try {
            // Reusing a live view preserves Stop and never duplicates controls.
            if ((existingBridge.window === thisObject ||
                    (!(thisObject instanceof Panel) && existingBridge.window instanceof Window)) &&
                    typeof existingBridge.window.visible === "boolean" && typeof existingBridge.statusText.text === "string") {
                if (rewireUiActions(existingBridge)) {
                    existingBridge.showWindow();
                    if (existingBridge.window && existingBridge.ui) { return; }
                }
            }
        } catch (staleWindowError) { /* Disposed native controls are replaced below. */ }
    }

    function trim(value) {
        return String(value).replace(/^\s+|\s+$/g, "");
    }

    function normalizePath(value) {
        return String(value).replace(/\\/g, "/").toLowerCase();
    }

    function jsonEscape(value) {
        var input = String(value);
        var output = "";
        var index;

        for (index = 0; index < input.length; index += 1) {
            var character = input.charAt(index);
            var code = input.charCodeAt(index);
            var hex;

            if (character === "\\") {
                output += "\\\\";
            } else if (character === "\"") {
                output += "\\\"";
            } else if (character === "\b") {
                output += "\\b";
            } else if (character === "\f") {
                output += "\\f";
            } else if (character === "\n") {
                output += "\\n";
            } else if (character === "\r") {
                output += "\\r";
            } else if (character === "\t") {
                output += "\\t";
            } else if (code < 32) {
                hex = code.toString(16);
                while (hex.length < 4) {
                    hex = "0" + hex;
                }
                output += "\\u" + hex;
            } else {
                output += character;
            }
        }

        return output;
    }

    function Bridge(workspaceRoot) {
        this.version = BRIDGE_VERSION;
        this.workspaceRoot = workspaceRoot;
        this.bridgeRoot = workspaceRoot + "/.ae-codex/bridge";
        this.inboxPath = this.bridgeRoot + "/inbox";
        this.resultsPath = this.bridgeRoot + "/results";
        this.heartbeatPath = this.bridgeRoot + "/heartbeat.json";
        this.running = false;
        this.ready = false;
        this.busy = false;
        this.taskId = 0;
        this.taskToken = 0;
        this.taskDueAt = 0;
        this.scheduledCallbackActive = false;
        this.connectionActionActive = false;
        this.connectionRecoveryPending = false;
        this.manualStop = false;
        this.startupStep = 0;
        this.generation = 0;
        this.lastHeartbeat = 0;
        this.lastActivityAt = 0;
        this.lastHeartbeatCheckAt = 0;
        this.heartbeatPublicationVerified = false;
        this.lastStatus = "Đang khởi động cầu nối…";
        this.progressValue = 0;
        this.progressLabel = "Đang tải";
        this.hideProgressPending = false;
        this.pendingReport = null;
        this.pendingCleanupFile = null;
        this.sessionNonce = String(new Date().getTime()) + "-" +
            Math.floor(Math.random() * 2147483647).toString(16);
        this.window = null;
        this.statusText = null;
        this.connectionText = null;
        this.connectionConnected = false;
        this.progressGroup = null;
        this.progressText = null;
        this.progressBar = null;
        this.library = null;
        this.libraryText = null;
        this.libraryControls = null;
        this.libraryDisplayValue = "";
        this.bundle = $.global.__codexAeBundleV1;
        this.functions = $.global.__codexAeFunctionsV1;
        this.scriptsText = null;
        this.logs = [];
        this.logRevision = 0;
        this.logViewRevision = -1;
        this.logEntries = this.logs;
        this.logView = null;
        this.logNotices = {};
        this.logWriteError = "";
        this.ui = null;
        this.hadUi = false;
        this.ownedUiRoots = [];
        this.connectionPens = null;
        this.connectionUiColor = null;
    }

    function setControl(control, key, value) {
        if (control && control[key] !== value) { control[key] = value; }
    }
    function refuseAnchoredPanel(owner, message) {
        try {
            owner.lastStatus = String(message); owner.connectionConnected = false;
            if (owner.statusText) { setControl(owner.statusText, "text", message); }
            if (owner.connectionText) { setControl(owner.connectionText, "text", "Chưa kết nối · " + message); }
        } catch (anchorStatusError) {}
    }
    function rewireUiActions(owner) {
        var ui = owner && owner.ui, palette = owner && owner.window, records = ui && ui.actions, i;
        if (!ui || !palette || !records || !records.length || records.length > 16) { return false; }
        function bind(record) {
            record.handler = function actionHandler() {
                var action = record.action, selectedValue;
                if (record.handler !== actionHandler || owner.ui !== ui || owner.window !== palette) { return; }
                if (action === "effects" || action === "sfx") { selectedValue = !!record.control.value; }
                if (action === "start") { owner.start("Reconnect button"); return; }
                if (!owner.ensureListenerOwner("button " + action, true)) { return; }
                if (action === "stop") { owner.stop(); return; }
                owner.refreshConnectionHealth(); owner.recoverScheduled("button " + action);
                if (action === "effects" || action === "sfx") { owner.setLibraryEnabled(action, selectedValue); }
                else if (action === "folders") { owner.showSfxFolders(); }
                else if (action === "refresh") { owner.requestLibraryRefresh(); }
                else if (action === "functions") { owner.showFunctions(); }
                else if (action === "scripts") { owner.showScripts(); }
                else if (action === "clearLog") { owner.clearLog(); }
                else if (action === "toggleLog") { ui.logExpanded = !ui.logExpanded; owner.reflowUi(true); }
            };
            record.control.onClick = record.handler;
        }
        try {
            for (i = 0; i < records.length; i += 1) { bind(records[i]); }
            ui.activityHandler = function activityHandler() {
                if (ui.activityHandler === activityHandler && owner.ui === ui && owner.window === palette) { owner.reflowUi(true); }
            };
            palette.onActivate = palette.onResizing = palette.onResize = ui.activityHandler;
            if (ui.layoutManager) { ui.layoutManager.layout = ui.activityHandler; ui.layoutManager.resize = ui.activityHandler; }
            if (palette instanceof Window) {
                ui.closeHandler = function closeHandler() {
                    if (ui.closeHandler !== closeHandler || owner.ui !== ui || owner.window !== palette) { return true; }
                    if (!owner.ensureListenerOwner("panel close", false)) { releaseBridgeUi(owner); return true; }
                    owner.stop(); releaseBridgeUi(owner); $.global[GLOBAL_NAME] = null; return true;
                };
                palette.onClose = ui.closeHandler;
            }
            return true;
        } catch (disposedBindingError) { releaseBridgeUi(owner); return false; }
    }
    function releaseBridgeUi(owner) {
        var legacy = owner && owner.chat, previousUi = legacy && legacy.ui,
            window = owner && owner.window, roots = owner && owner.ownedUiRoots || [],
            stack = [], node, children, record, i, j, visited = 0,
            events = ["onDraw", "onClick", "onChange", "onChanging", "onActivate", "onDoubleClick"];
        if (!owner) { return; }
        if (owner.ui && owner.ui.actions) {
            for (i = 0; i < owner.ui.actions.length; i += 1) {
                record = owner.ui.actions[i];
                try { if (record.control && record.control.onClick === record.handler) { record.control.onClick = null; } } catch (disposedActionError) {}
                record.handler = null; record.control = null;
            }
            owner.ui.actions = []; owner.ui.activityHandler = owner.ui.closeHandler = null;
        }
        try {
            if (window && owner.ui && owner.ui.layoutManager && window.layout === owner.ui.layoutManager) {
                window.layout = owner.ui.nativeLayout;
            }
        } catch (disposedLayoutError) {}
        // Compatibility cleanup only. A new controller has no embedded chat.
        // The old controller's Stop runs before its idle resources are released.
        if (legacy) {
            for (i = 0; previousUi && previousUi.nativeListeners && i < previousUi.nativeListeners.length; i += 1) {
                record = previousUi.nativeListeners[i];
                try { record.control.removeEventListener(record.type, record.handler); } catch (listenerReleaseError) {}
            }
            legacy.ui = null; legacy.state = null; legacy.pending = null;
            legacy.chatPaint = null; legacy.chatTextWidths = null;
            legacy.previewWanted = null; legacy.previewCache = {}; legacy.previewOrder = [];
            legacy.transcriptMessages = []; legacy.transcriptMedia = [];
            legacy.transcriptRows = []; legacy.transcriptCommands = [];
            owner.chat = null;
        }
        for (i = 0; i < roots.length; i += 1) { stack.push(roots[i]); }
        while (stack.length && visited < 512) {
            node = stack.pop(); visited += 1;
            try {
                children = node.children || [];
                for (i = 0; i < children.length; i += 1) { stack.push(children[i]); }
                for (j = 0; j < events.length; j += 1) { if (typeof node[events[j]] === "function") { node[events[j]] = null; } }
            } catch (disposedControlError) {}
        }
        try {
            if (window) {
                try { if (window.__codexAeBridgeOwnerV1 === owner) { delete window.__codexAeBridgeOwnerV1; } } catch (anchorReleaseError) {}
                window.onClose = window.onResize = window.onResizing = window.onActivate = null;
                if (window instanceof Window) { window.close(); }
                else {
                    // AE owns the dock. Remove only this plugin's recorded roots.
                    for (i = 0; i < roots.length; i += 1) {
                        try { window.remove(roots[i]); } catch (disposedRootError) {}
                    }
                }
            }
        } catch (disposedWindowError) {}
        owner.ui = null; owner.ownedUiRoots = []; owner.connectionPens = null; owner.connectionUiColor = null;
        owner.window = owner.statusText = owner.connectionText = null;
        owner.progressGroup = owner.progressText = owner.progressBar = null;
        owner.libraryText = owner.scriptsText = owner.logView = owner.logSummary = null;
        owner.libraryControls = null;
    }

    Bridge.prototype.refreshLog = function () {
        var lines, i, entry;
        try {
            if (!this.logView) { return; }
            if (this.logSummary) {
                entry = this.logs.length ? this.logs[this.logs.length - 1] : null;
                setControl(this.logSummary, "text", entry ? (entry.level === "error" ? "Lỗi: " : "") + entry.message.substring(0, 180) : "Sẵn sàng");
                setControl(this.logSummary, "helpTip", entry ? entry.message : "Mở Nhật ký để xem tiến trình và lỗi.");
            }
            // Keep entries and the persistent log while collapsed, without
            // rebuilding an invisible 200-line native text buffer on each event.
            if (!this.ui || !this.ui.logVisible || this.logViewRevision === this.logRevision) { return; }
            lines = [];
            for (i = 0; i < this.logs.length; i += 1) {
                entry = this.logs[i];
                lines.push(entry.time + " [" + entry.level.toUpperCase() + "] " +
                    (entry.runId ? entry.runId + " | " : "") +
                    (typeof entry.percent === "number" ? entry.percent + "% | " : "") + entry.message);
            }
            setControl(this.logView, "text", lines.join("\n"));
            setControl(this.logView, "helpTip", this.logWriteError || "200 sự kiện gần nhất. Nhật ký: .ae-codex/bridge/logs/events.log");
            this.logViewRevision = this.logRevision;
            if (this.window && this.window.update) { this.window.update(); }
        } catch (logUiError) { releaseBridgeUi(this); }
    };

    Bridge.prototype.persistLog = function (entry) {
        var file = null, previous, opened = false;
        try {
            if (!(new Folder(this.workspaceRoot)).exists) { throw new Error("Workspace unavailable"); }
            this.ensureFolders();
            this.ensureFolder(this.bridgeRoot + "/logs");
            file = new File(this.bridgeRoot + "/logs/events.log");
            if (file.exists && file.length >= 262144) {
                previous = new File(this.bridgeRoot + "/logs/previous.log");
                if (previous.exists && !previous.remove()) { throw new Error(previous.error); }
                if (!file.rename("previous.log")) { throw new Error(file.error); }
                file = new File(this.bridgeRoot + "/logs/events.log");
            }
            file.encoding = "UTF-8";
            if (!file.open("a")) { throw new Error(file.error); }
            opened = true;
            if (!file.write("{\"time\":\"" + jsonEscape(entry.time) + "\",\"epochMs\":" + entry.epochMs +
                    ",\"level\":\"" + jsonEscape(entry.level) + "\",\"runId\":\"" + jsonEscape(entry.runId) +
                    "\",\"message\":\"" + jsonEscape(entry.message) + "\"" +
                    (typeof entry.percent === "number" ? ",\"percent\":" + entry.percent : "") + "}\n")) {
                throw new Error(file.error);
            }
            this.logWriteError = "";
        } catch (logFileError) {
            this.logWriteError = "Disk log unavailable: " + String(logFileError);
        } finally {
            if (opened) { try { file.close(); } catch (logCloseError) {} }
        }
    };

    Bridge.prototype.log = function (level, message, runId, percent) {
        // Logging must never affect script execution or result publication.
        try {
            var now = new Date(), pad = function (n) { return n < 10 ? "0" + n : String(n); };
            var entry = {
                time: pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()),
                epochMs: now.getTime(), level: String(level || "info").toLowerCase(),
                message: String(message || "").substring(0, 1000), runId: String(runId || "").substring(0, 80)
            };
            if (typeof percent === "number" && isFinite(percent)) { entry.percent = Math.max(0, Math.min(100, Math.round(percent))); }
            this.logs.push(entry);
            if (this.logs.length > 200) { this.logs.splice(0, this.logs.length - 200); }
            this.logRevision += 1;
            this.persistLog(entry);
            this.refreshLog();
        } catch (logError) {}
    };
    Bridge.prototype.appendLog = Bridge.prototype.log;
    Bridge.prototype.clearLog = function () { this.logs.splice(0, this.logs.length); this.logRevision += 1; this.refreshLog(); };
    Bridge.prototype.logOnce = function (key, level, message, runId) {
        if (this.logNotices[key] !== message) {
            this.logNotices[key] = message;
            this.log(level, message, runId);
        }
    };

    Bridge.prototype.getPublicFunctionCount = function () {
        var runtime = this.functions, cache = this.publicFunctionCountCache, count;
        if (!cache || cache.runtime !== runtime) {
            // A registry is immutable for its runtime. Do not allocate all descriptors
            // again on every idle tick, including when an unavailable registry fails.
            cache = { runtime: runtime, count: null, error: "" };
            this.publicFunctionCountCache = cache;
            try {
                count = runtime.list(false).length;
                if (typeof count !== "number" || !isFinite(count) || count < 0 || count !== Math.floor(count)) {
                    throw new Error("Danh mục công cụ không hợp lệ");
                }
                cache.count = count;
            } catch (functionCountError) {
                cache.error = String(functionCountError).slice(0, 500);
            }
        }
        return cache.count;
    };

    Bridge.prototype.refreshScriptsDisplay = function () {
        var count, countError;
        try {
            if (this.scriptsText) {
                count = this.getPublicFunctionCount();
                countError = this.publicFunctionCountCache.error;
                setControl(this.scriptsText, "text", (count === null ? "Công cụ: chưa đọc được danh mục" :
                    "Công cụ: " + count + " chức năng dùng lại") + "\n" + this.bundle.describe());
                setControl(this.scriptsText, "helpTip", countError || (this.bundle.errors.length ? this.bundle.errors.join("\n") :
                    "Bộ công cụ được kiểm tra khi cài đặt hoặc cập nhật. Mỗi nhánh được kiểm tra checksum khi cần; không quét toàn bộ script trong nền."));
            }
        } catch (disposedScriptsUiError) { releaseBridgeUi(this); }
    };

    Bridge.prototype.showScripts = function () {
        var dialog = new Window("dialog", "Kho script cũ · " + this.bundle.names.length + " nhánh lưu trữ");
        var bundle = this.bundle;
        var search = dialog.add("edittext", undefined, "");
        var list = dialog.add("listbox", undefined, []);
        var detail = dialog.add("statictext", undefined, "", { multiline: true });
        var close = dialog.add("button", undefined, "Đóng", { name: "ok" });
        dialog.orientation = "column"; dialog.alignChildren = ["fill", "top"];
        search.helpTip = "Tìm tên nhánh trong kho script cũ";
        list.preferredSize = [560, 320]; detail.preferredSize = [560, 64];
        function fill() {
            var i, name, entry, item, query = String(search.text).toLowerCase();
            list.removeAll();
            for (i = 0; i < bundle.names.length; i += 1) {
                name = bundle.names[i]; entry = bundle.entries[name];
                if (name.toLowerCase().indexOf(query) < 0) { continue; }
                item = list.add("item", "[" + (entry.state === "pending" && bundle.installation.state === "verified" ?
                    "installed OK" : entry.state) + "] " + name); item.branchName = name;
            }
        }
        search.onChanging = fill;
        list.onChange = function () {
            var entry = list.selection ? bundle.entries[list.selection.branchName] : null;
            if (!entry) { detail.text = ""; return; }
            try {
                detail.text = entry.error || "Shared source pieces: " + bridge.bundle.recipe(list.selection.branchName).split("|").length +
                    "\nDependencies: " + (entry.dependencies.join(", ") || "none");
            } catch (recipeError) { detail.text = String(recipeError); }
        };
        cartoonDialog(dialog, search, list, detail, close);
        fill(); dialog.center(); dialog.show();
    };

    Bridge.prototype.showFunctions = function () {
        var dialog = new Window("dialog", "Công cụ đã cài · " + this.functions.list(false).length);
        var search = dialog.add("edittext", undefined, "");
        var list = dialog.add("listbox", undefined, []);
        var detail = cartoonText(dialog, "", true);
        var descriptors = this.functions.list(false);
        dialog.orientation = "column"; dialog.alignChildren = ["fill", "top"];
        search.helpTip = "Tìm công cụ dùng lại và tham số. Các script dự án cũ được giữ trong Kho script.";
        list.preferredSize = [560, 280]; detail.preferredSize = [560, 180];
        var close = dialog.add("button", undefined, "Đóng", { name: "ok" });
        function fill() {
            var i, entry, item, query = String(search.text).toLowerCase(), label;
            list.removeAll();
            for (i = 0; i < descriptors.length; i += 1) {
                entry = descriptors[i]; label = entry.legacy ? "script.run / " + entry.branch : entry.name;
                if ((label + " " + entry.description).toLowerCase().indexOf(query) < 0) { continue; }
                item = list.add("item", label); item.descriptorIndex = i;
            }
        }
        search.onChanging = fill;
        list.onChange = function () {
            var entry = list.selection ? descriptors[list.selection.descriptorIndex] : null;
            detail.text = entry ? entry.description + "\n\n" + bridge.functions.stringify({
                "function": entry.name, args: entry.args || {}, legacy: !!entry.legacy
            }) : "";
        };
        cartoonDialog(dialog, search, list, detail, close);
        fill(); dialog.center(); dialog.show();
    };

    Bridge.prototype.beginLibrary = function () {
        try {
            this.bundle.run("Codex Library.jsx");
            if (typeof $.global.__codexAeLibraryFactoryV1 !== "function") {
                throw new Error("Library module did not load");
            }
            this.library = $.global.__codexAeLibraryFactoryV1(this);
            this.library.begin(this.generation);
        } catch (libraryError) {
            this.library = null;
            this.libraryDisplayValue = "Library unavailable: " + this.describeError(libraryError);
            if (this.libraryText) { this.libraryText.text = this.libraryDisplayValue; }
            this.log("error", this.libraryDisplayValue);
        }
        this.refreshLibraryDisplay();
    };

    Bridge.prototype.refreshLibraryDisplay = function () {
        var display = this.library ? this.library.describe() :
            (this.libraryDisplayValue || "Library: connect to scan effects and SFX");
        try {
            if (this.libraryText && this.libraryText.text !== display) {
                this.libraryText.text = display;
                if (this.window) { this.reflowUi(); }
            }
        } catch (libraryUiError) { releaseBridgeUi(this); }
        this.refreshLibraryControls();
    };

    Bridge.prototype.refreshLibraryControls = function () {
        var controls = this.libraryControls, library = this.library, preferences = null,
            available = !!(library && typeof library.getPreferences === "function" &&
                typeof library.setEnabled === "function" && typeof library.requestRefresh === "function"),
            scanning = available && (library.refreshPending === true || (library.state && library.state.state === "scanning")),
            idle = this.running && this.ready && !this.busy && !this.pendingReport && !this.pendingCleanupFile,
            tooltip = "Chỉ lập chỉ mục thư viện theo yêu cầu; không bật/tắt effects, layer hay âm thanh trong project.";
        if (!controls) { return; }
        try {
            if (available) {
                preferences = library.getPreferences();
                available = !!(preferences && typeof preferences.effectsEnabled === "boolean" &&
                    typeof preferences.sfxEnabled === "boolean" && preferences.manualRefresh === true);
            }
            if (available) {
                setControl(controls.effects, "value", preferences.effectsEnabled);
                setControl(controls.sfx, "value", preferences.sfxEnabled);
            }
            setControl(controls.effects, "enabled", !!(available && idle && !scanning));
            setControl(controls.sfx, "enabled", !!(available && idle && !scanning));
            setControl(controls.folders, "enabled", !!(available && idle && !scanning &&
                typeof library.getSfxRoots === "function" && typeof library.setSfxRoots === "function"));
            setControl(controls.refresh, "enabled", !!(available && idle && !scanning &&
                (preferences.effectsEnabled || preferences.sfxEnabled)));
            setControl(controls.refresh, "helpTip", !available ? "Chưa tải được bộ kiểm kê thủ công. Hãy kết nối lại hoặc cập nhật Codex AE." :
                (scanning ? "Đã có yêu cầu cập nhật thư viện. Chờ hoàn tất rồi cập nhật tiếp." : tooltip));
        } catch (libraryControlsError) {
            try { controls.effects.enabled = controls.sfx.enabled = controls.folders.enabled = controls.refresh.enabled = false; }
            catch (disposedLibraryControlsError) { releaseBridgeUi(this); }
        }
    };

    Bridge.prototype.setLibraryEnabled = function (kind, enabled) {
        try {
            if ((kind !== "effects" && kind !== "sfx") || typeof enabled !== "boolean") { throw new Error("Lựa chọn thư viện không hợp lệ."); }
            if (!this.running || !this.ready || this.busy || this.pendingReport || this.pendingCleanupFile ||
                    !this.library || typeof this.library.setEnabled !== "function") {
                throw new Error("Cầu nối chưa sẵn sàng để lưu lựa chọn thư viện.");
            }
            this.library.setEnabled(kind, enabled);
            this.log("info", (enabled ? "Đã bật" : "Đã tắt") + " kiểm kê " + (kind === "effects" ? "Effects" : "SFX") + ". Bấm Cập nhật thư viện để quét.");
            this.refreshLibraryDisplay();
            return true;
        } catch (preferenceError) {
            this.log("error", "Không lưu được lựa chọn thư viện: " + this.describeError(preferenceError));
            this.refreshLibraryControls();
            return false;
        }
    };

    Bridge.prototype.requestLibraryRefresh = function () {
        var accepted = false;
        try {
            if (!this.running || !this.ready || this.busy || this.pendingReport || this.pendingCleanupFile ||
                    !this.library || typeof this.library.requestRefresh !== "function") {
                throw new Error("Cầu nối chưa sẵn sàng. Chờ tác vụ hiện tại hoàn tất hoặc kết nối lại.");
            }
            accepted = this.library.requestRefresh() === true;
            this.log(accepted ? "info" : "warning", accepted ? "Đã nhận yêu cầu cập nhật thư viện; sẽ quét khi AE rảnh." : "Chưa nhận yêu cầu: thư viện đang cập nhật hoặc chưa bật mục kiểm kê.");
        } catch (refreshError) {
            this.log("error", "Không cập nhật được thư viện: " + this.describeError(refreshError));
        }
        this.refreshLibraryDisplay();
        return accepted;
    };

    Bridge.prototype.showSfxFolders = function () {
        var owner = this, library = this.library, roots, initial, i, dialog, instructions, list, actions,
            add, remove, status, footer, save, cancel, changed = false;
        try {
            if (!this.running || !this.ready || this.busy || this.pendingReport || this.pendingCleanupFile || !library ||
                    library.refreshPending || (library.state && library.state.state === "scanning") ||
                    typeof library.getSfxRoots !== "function" || typeof library.setSfxRoots !== "function") {
                throw new Error("Cầu nối chưa sẵn sàng để sửa thư mục SFX. Chờ cập nhật hoặc tác vụ hiện tại hoàn tất.");
            }
            initial = library.getSfxRoots(); roots = [];
            if (Object.prototype.toString.call(initial) !== "[object Array]" || initial.length > 32) { throw new Error("Danh sách thư mục SFX không hợp lệ."); }
            for (i = 0; i < initial.length; i += 1) {
                if (typeof initial[i] !== "string") { throw new Error("Đường dẫn thư mục SFX không hợp lệ."); }
                roots.push(initial[i]);
            }
            dialog = new Window("dialog", "Thư mục thư viện SFX");
            dialog.orientation = "column"; dialog.alignChildren = ["fill", "top"];
            instructions = dialog.add("statictext", undefined, "Để bỏ thư mục sai: chọn dòng → Bỏ khỏi danh sách → Lưu. Không xóa dữ liệu trên đĩa.\nChỉ thêm thư mục cụ thể, không chọn cả ổ đĩa. Lưu không quét; bấm Cập nhật khi cần.", { multiline: true });
            instructions.preferredSize = [560, 46];
            list = dialog.add("listbox", undefined, [], { multiselect: false }); list.preferredSize = [560, 180];
            actions = dialog.add("group"); add = actions.add("button", undefined, "Thêm thư mục…");
            remove = actions.add("button", undefined, "Bỏ khỏi danh sách");
            remove.helpTip = "Chỉ bỏ đường dẫn khỏi cấu hình; không xóa thư mục hoặc âm thanh trên đĩa.";
            status = dialog.add("statictext", undefined, "", { multiline: true }); status.preferredSize = [560, 38];
            footer = dialog.add("group"); save = footer.add("button", undefined, "Lưu", { name: "ok" });
            cancel = footer.add("button", undefined, "Hủy", { name: "cancel" });
            function selectedIndex() {
                var selected = list.selection, index = selected ? selected.index : -1;
                if (typeof index !== "number" || Math.floor(index) !== index || index < 0 || index >= roots.length ||
                        list.items[index] !== selected) { return -1; }
                return index;
            }
            function refreshSelection() {
                remove.enabled = selectedIndex() >= 0;
            }
            function fill(selectionIndex, message) {
                var index;
                list.removeAll();
                for (index = 0; index < roots.length; index += 1) { list.add("item", roots[index]); }
                if (roots.length > 0) { list.selection = Math.max(0, Math.min(selectionIndex, roots.length - 1)); }
                save.enabled = true; add.enabled = roots.length < 32; refreshSelection();
                status.text = roots.length + "/32 thư mục. " + (message || "Chọn dòng cần bỏ khỏi danh sách.") +
                    (roots.length === 0 ? " Bấm Lưu để xóa danh sách và tắt kiểm kê SFX." : (changed ? " Bấm Lưu để áp dụng." : ""));
            }
            list.onChange = refreshSelection;
            add.onClick = function () {
                var selected = Folder.selectDialog("Chọn thư mục chứa SFX cụ thể"), value, index;
                if (!selected) { return; }
                value = selected.fsName;
                for (index = 0; index < roots.length; index += 1) {
                    if (normalizePath(roots[index]) === normalizePath(value)) { status.text = "Thư mục này đã có trong danh sách."; return; }
                }
                if (roots.length >= 32) { status.text = "Chỉ lưu tối đa 32 thư mục SFX."; return; }
                roots.push(value); changed = true; fill(roots.length - 1, "Đã thêm thư mục vào danh sách.");
            };
            remove.onClick = function () {
                var index = selectedIndex();
                if (index < 0) { refreshSelection(); status.text = "Chọn một dòng thư mục cần bỏ, rồi bấm Bỏ khỏi danh sách. Chưa có thay đổi nào được lưu."; return; }
                roots.splice(index, 1); changed = true; fill(index, "Đã bỏ thư mục đã chọn. Không xóa dữ liệu trên đĩa.");
            };
            save.onClick = function () {
                try {
                    if (!owner.running || !owner.ready || owner.busy || owner.pendingReport || owner.pendingCleanupFile || owner.library !== library) {
                        throw new Error("Cầu nối đã đổi trạng thái. Hủy hộp thoại và chờ tác vụ hoàn tất.");
                    }
                    library.setSfxRoots(roots.slice(0));
                    owner.log("info", roots.length === 0 ? "Đã lưu danh sách thư mục trống và tắt kiểm kê SFX. Không xóa dữ liệu trên đĩa." :
                        "Đã lưu " + roots.length + " thư mục SFX. Chưa quét và không tự bật SFX; bấm Cập nhật khi cần.");
                    owner.refreshLibraryDisplay(); dialog.close(1);
                } catch (saveError) {
                    status.text = "Không lưu được: " + owner.describeError(saveError);
                    owner.log("error", "Không lưu được thư mục SFX: " + owner.describeError(saveError));
                }
            };
            cancel.onClick = function () { dialog.close(0); };
            cartoonSurface(dialog, cartoonPaper); cartoonSurface(instructions, cartoonPaper, "Segoe UI", 11);
            cartoonSurface(list, cartoonField, "Segoe UI", 11); cartoonSurface(status, cartoonPaper, "Segoe UI", 11);
            cartoonButton(add, [0.19, 0.29, 0.46, 1]); cartoonButton(remove, [0.43, 0.22, 0.23, 1]);
            cartoonButton(save, [0.16, 0.34, 0.27, 1]); cartoonButton(cancel, [0.29, 0.24, 0.44, 1]);
            remove.preferredSize = [160, 32]; fill(0); dialog.center(); dialog.show();
            return true;
        } catch (folderError) {
            this.log("error", "Không mở được thư mục SFX: " + this.describeError(folderError));
            return false;
        }
    };

    Bridge.prototype.ensureFolder = function (path) {
        var folder = new Folder(path);
        if (!folder.exists && !folder.create()) {
            throw new Error("Cannot create bridge folder: " + path + "; " + folder.error);
        }
        return folder;
    };

    Bridge.prototype.ensureFolders = function () {
        this.ensureFolder(this.workspaceRoot + "/.ae-codex");
        this.ensureFolder(this.bridgeRoot);
        this.ensureFolder(this.inboxPath);
        this.ensureFolder(this.resultsPath);
    };

    Bridge.prototype.writeAtomic = function (path, text) {
        var destination = new File(path);
        var temporary = new File(path + ".tmp");
        var attempt;
        var lastError = "unknown file error";

        for (attempt = 0; attempt < 4; attempt += 1) {
            try {
                if (temporary.exists && !temporary.remove()) {
                    throw new Error("Cannot clear temporary file: " + temporary.error);
                }

                temporary.encoding = "UTF-8";
                if (!temporary.open("w")) {
                    throw new Error("Cannot open temporary file: " + temporary.error);
                }
                try {
                    temporary.write(text);
                } finally {
                    temporary.close();
                }

                if (destination.exists && !destination.remove()) {
                    throw new Error("Cannot replace destination: " + destination.error);
                }
                if (!temporary.rename(destination.name)) {
                    throw new Error("Cannot publish temporary file: " + temporary.error);
                }
                return;
            } catch (writeError) {
                lastError = String(writeError);
                if (temporary.opened) {
                    temporary.close();
                }
                if (attempt < 3) {
                    $.sleep(35 * (attempt + 1));
                }
            }
        }

        throw new Error("Atomic write failed for " + destination.fsName + ": " + lastError);
    };

    Bridge.prototype.writeNewAtomic = function (path, text) {
        var destination = new File(path);
        var temporary = new File(path + ".tmp-" + this.sessionNonce);
        var attempt;
        var lastError = "unknown file error";

        if (destination.exists) {
            throw new Error("Refusing to replace immutable result: " + destination.fsName);
        }

        for (attempt = 0; attempt < 4; attempt += 1) {
            try {
                if (temporary.exists && !temporary.remove()) {
                    throw new Error("Cannot clear temporary result: " + temporary.error);
                }

                temporary.encoding = "UTF-8";
                if (!temporary.open("w")) {
                    throw new Error("Cannot open temporary result: " + temporary.error);
                }
                try {
                    temporary.write(text);
                } finally {
                    temporary.close();
                }

                if (destination.exists) {
                    throw new Error("Immutable result appeared while publishing");
                }
                if (!temporary.rename(destination.name)) {
                    throw new Error("Cannot publish immutable result: " + temporary.error);
                }
                return;
            } catch (writeError) {
                lastError = String(writeError);
                if (temporary.opened) {
                    temporary.close();
                }
                if (destination.exists) {
                    throw new Error("Refusing to replace immutable result: " + destination.fsName);
                }
                if (attempt < 3) {
                    $.sleep(35 * (attempt + 1));
                }
            }
        }

        throw new Error("Immutable result write failed for " + destination.fsName + ": " + lastError);
    };

    Bridge.prototype.setConnectionStatus = function (connected, detail) {
        this.connectionConnected = connected;
        try {
            if (this.connectionText) {
                setControl(this.connectionText, "text", (connected ? "Đã kết nối · " : "Chưa kết nối · ") + detail);
                if (this.connectionPens && this.connectionUiColor !== connected) {
                    this.connectionText.graphics.foregroundColor = connected ? this.connectionPens.connected : this.connectionPens.disconnected;
                    this.connectionUiColor = connected;
                }
            }
        } catch (disposedConnectionUiError) {
            releaseBridgeUi(this);
        }
        this.refreshLibraryControls();
    };

    Bridge.prototype.setUiStatus = function (text) {
        this.lastStatus = String(text);
        try {
            if (this.statusText) {
                setControl(this.statusText, "text", this.lastStatus);
                if (this.window) {
                    this.reflowUi();
                }
            }
        } catch (disposedUiError) {
            releaseBridgeUi(this);
        }
    };

    Bridge.prototype.reflowUi = function (force) {
        this.refreshConnectionHealth();
        this.recoverScheduled("panel layout");
        if (!this.window) { return; }
        try {
            if (this.ui && this.ui.reflow) { this.ui.reflow(!!force); }
            else { this.window.layout.layout(true); }
        } catch (disposedLayoutError) {
            // Home/project/workspace changes may dispose the native panel while
            // the session remains alive. UI failure must never block jobs or
            // restart/replay the controller's in-flight work.
            releaseBridgeUi(this);
            this.logOnce("ui-disposed", "info", "Panel AE đã được thay đổi; cầu nối tiếp tục nhận lệnh. Mở lại Codex Bridge để hiện bảng.");
        }
    };

    Bridge.prototype.setProgress = function (value, label) {
        var normalizedValue = Math.max(0, Math.min(100, Math.round(Number(value))));
        if (!isFinite(normalizedValue)) { normalizedValue = 0; }
        this.progressValue = normalizedValue;
        this.progressLabel = String(label || "Loading");

        try {
            if (this.progressBar) {
                this.progressBar.value = normalizedValue;
            }
            if (this.progressText) {
                this.progressText.text = this.progressLabel + " - " + normalizedValue + "%";
            }
            if (this.window) {
                this.reflowUi();
                if (this.window.update) {
                    this.window.update();
                }
            }
        } catch (disposedUiError) {
            releaseBridgeUi(this);
        }
    };

    Bridge.prototype.showProgress = function () {
        try {
            if (this.progressGroup) {
                this.progressGroup.visible = true;
            }
            if (this.progressText) {
                this.progressText.visible = true;
            }
            if (this.progressBar) {
                this.progressBar.visible = true;
            }
            if (this.window) {
                this.reflowUi();
                if (this.window.update) {
                    this.window.update();
                }
            }
        } catch (disposedUiError) {
            releaseBridgeUi(this);
        }
    };

    Bridge.prototype.hideProgress = function () {
        try {
            if (this.progressGroup) {
                this.progressGroup.visible = false;
            }
            if (this.progressText) {
                this.progressText.visible = false;
            }
            if (this.progressBar) {
                this.progressBar.visible = false;
            }
            if (this.window) {
                this.reflowUi();
                if (this.window.update) {
                    this.window.update();
                }
            }
        } catch (disposedUiError) {
            releaseBridgeUi(this);
        }
    };

    Bridge.prototype.writeHeartbeat = function (state, message) {
        var now = new Date().getTime();
        var payload = "{" +
            "\"schema\":\"codex-ae-heartbeat/v1\"," +
            "\"state\":\"" + jsonEscape(state) + "\"," +
            "\"bridgeVersion\":\"" + jsonEscape(BRIDGE_VERSION) + "\"," +
            "\"workspaceRoot\":\"" + jsonEscape(this.workspaceRoot) + "\"," +
            "\"startupPercent\":" + this.progressValue + "," +
            "\"startupStage\":\"" + jsonEscape(this.progressLabel) + "\"," +
            "\"sessionNonce\":\"" + jsonEscape(this.sessionNonce) + "\"," +
            "\"timestampEpochMs\":" + now + "," +
            "\"afterEffectsVersion\":\"" + jsonEscape(app.version) + "\"," +
            "\"functions\":{\"schema\":\"codex-ae-functions/v1\",\"catalogRelativePath\":\".ae-codex/functions/catalog.json\"}," +
            "\"message\":\"" + jsonEscape(message || "") + "\"" +
            (this.library && $.global.__codexAeLibraryJsonV1 ?
                ",\"library\":" + $.global.__codexAeLibraryJsonV1(this.library.heartbeat()) : "") +
            (this.bundle && $.global.__codexAeLibraryJsonV1 ?
                ",\"scripts\":" + $.global.__codexAeLibraryJsonV1(this.bundle.status()) : "") +
            "}";

        this.writeAtomic(this.heartbeatPath, payload);
        this.lastHeartbeat = now;
        this.lastHeartbeatCheckAt = now;
        this.heartbeatPublicationVerified = true;
        if (state === "running") {
            this.connectionRecoveryPending = false;
            if (this.running && this.ready && (this.lastStatus === "Đang khôi phục kết nối; chờ heartbeat mới…" ||
                    this.lastStatus === "Mất nhịp kết nối; đang kiểm tra listener AE…")) {
                this.setUiStatus("Bridge " + BRIDGE_VERSION + " connected successfully\nReady for Codex jobs");
            }
        }
        this.setConnectionStatus(state === "running" && this.running && this.ready,
            state === "running" ? "Connected / Ready for Codex" :
                (state === "starting" ? "Connecting..." :
                    (state === "stopped" ? "Disconnected" : "Connection error")));
    };

    Bridge.prototype.writeStarted = function (runId, operation, startedAt) {
        var now = new Date().getTime();
        var path = this.resultsPath + "/started-" + runId + ".json";
        var payload = "{" +
            "\"schema\":\"codex-ae-run-started/v1\"," +
            "\"mode\":\"file-bridge\"," +
            "\"runId\":\"" + jsonEscape(runId) + "\"," +
            "\"sessionNonce\":\"" + jsonEscape(this.sessionNonce) + "\"," +
            "\"state\":\"running\"," +
            "\"phase\":\"evaluating\"," +
            "\"operation\":\"" + jsonEscape(operation || "") + "\"," +
            "\"afterEffectsVersion\":\"" + jsonEscape(app.version) + "\"," +
            "\"startedAtEpochMs\":" + startedAt + "," +
            "\"timestampEpochMs\":" + now +
            "}";

        this.writeNewAtomic(path, payload);
    };

    Bridge.prototype.writeStatus = function (report) {
        var now = new Date().getTime();
        var path = this.resultsPath + "/status-" + report.runId + ".json";
        var payload = "{" +
            "\"schema\":\"codex-ae-run/v2\"," +
            "\"mode\":\"file-bridge\"," +
            "\"runId\":\"" + jsonEscape(report.runId) + "\"," +
            "\"sessionNonce\":\"" + jsonEscape(this.sessionNonce) + "\"," +
            "\"state\":\"" + jsonEscape(report.state) + "\"," +
            "\"phase\":\"" + jsonEscape(report.phase) + "\"," +
            "\"errorCode\":\"" + jsonEscape(report.errorCode || "") + "\"," +
            "\"retryable\":" + (report.retryable ? "true" : "false") + "," +
            "\"completionKnown\":" + (report.completionKnown ? "true" : "false") + "," +
            "\"operation\":\"" + jsonEscape(report.operation || "") + "\"," +
            "\"afterEffectsVersion\":\"" + jsonEscape(app.version) + "\"," +
            "\"startedAtEpochMs\":" + report.startedAt + "," +
            "\"timestampEpochMs\":" + now + "," +
            "\"message\":\"" + jsonEscape(report.message || "") + "\"," +
            "\"result\":\"" + jsonEscape(report.result || "") + "\"" +
            "}";

        this.writeNewAtomic(path, payload);
    };

    Bridge.prototype.describeError = function (error) {
        var description = error && error.toString ? error.toString() : String(error);
        if (error && error.line) {
            description += " (line " + error.line + ")";
        }
        if (error && error.fileName) {
            description += " in " + error.fileName;
        }
        return description;
    };

    Bridge.prototype.publishPendingReport = function () {
        var report = this.pendingReport;
        var cleanupWarning = "";

        if (!report) {
            return true;
        }

        try {
            this.writeStatus(report);
            this.pendingReport = null;
            this.logNotices.report = "";
            this.log("info", "Result report published: " + report.state, report.runId);

            if (report.runningFile && report.runningFile.exists && !report.runningFile.remove()) {
                cleanupWarning = "\nResult published; job cleanup failed: " + report.runningFile.error;
                this.pendingCleanupFile = report.runningFile;
                this.logOnce("cleanup", "error", cleanupWarning, report.runId);
            } else {
                this.pendingCleanupFile = null;
            }
            this.busy = this.pendingCleanupFile !== null;

            if (report.state === "success") {
                this.setUiStatus(
                    "Completed " + report.operation + "\nRun ID: " + report.runId + cleanupWarning
                );
            } else {
                this.setUiStatus(
                    "Failed " + report.operation + "\n" + report.message + cleanupWarning
                );
            }
            return true;
        } catch (statusError) {
            this.busy = true;
            this.logOnce("report", "error", "Result publication failed; retrying report only: " + this.describeError(statusError), report.runId);
            this.setUiStatus(
                "JSX finished; reporting result will retry\n" + String(statusError)
            );
            return false;
        }
    };

    Bridge.prototype.retryPendingCleanup = function () {
        var file = this.pendingCleanupFile;

        if (!file) {
            return true;
        }
        if (!file.exists || file.remove()) {
            this.pendingCleanupFile = null;
            this.busy = this.pendingReport !== null;
            this.setUiStatus("Result published and job cleanup completed");
            this.logNotices.cleanup = "";
            this.log("info", "Job marker cleanup completed");
            return true;
        }

        this.busy = true;
        this.logOnce("cleanup", "error", "Job marker cleanup failed; retrying: " + file.error);
        this.setUiStatus("Result published; waiting to clean job marker\n" + file.error);
        return false;
    };

    Bridge.prototype.readJob = function (jobFile) {
        var values = {};
        var fieldCount = 0;

        if (jobFile.length > 800 * 1024) {
            throw new Error("Job request is too large");
        }

        jobFile.encoding = "UTF-8";
        if (!jobFile.open("r")) {
            throw new Error("Cannot read job: " + jobFile.fsName + "; " + jobFile.error);
        }

        try {
            while (!jobFile.eof) {
                var line = jobFile.readln();
                if (trim(line) === "") {
                    continue;
                }

                var separator = line.indexOf("=");
                if (separator < 1) {
                    throw new Error("Invalid job line: " + line);
                }

                var key = trim(line.substring(0, separator));
                var value = trim(line.substring(separator + 1));
                if (key !== "schema" && key !== "runId" && key !== "sessionNonce" && key !== "script" && key !== "request") {
                    throw new Error("Unknown job field: " + key);
                }
                if (typeof values[key] !== "undefined") {
                    throw new Error("Duplicate job field: " + key);
                }
                values[key] = value;
                fieldCount += 1;
            }
        } finally {
            jobFile.close();
        }

        if (fieldCount !== 4) {
            throw new Error("Job must contain exactly schema, runId, sessionNonce, and script or request");
        }

        return values;
    };

    Bridge.prototype.validateJob = function (jobFile, job) {
        if (job.schema !== "codex-ae-job/v1" && job.schema !== "codex-ae-job/v2") {
            throw new Error("Unsupported job schema");
        }

        if (!/^[A-Za-z0-9-]{8,80}$/.test(job.runId || "")) {
            throw new Error("Invalid run ID");
        }

        if (jobFile.name !== "job-" + job.runId + ".job") {
            throw new Error("Job filename does not match run ID");
        }

        if (job.schema === "codex-ae-job/v2") {
            if (typeof job.request !== "string" || typeof job.script !== "undefined") {
                throw new Error("Function jobs require request data and cannot contain a script path");
            }
            var requestText = decodeURIComponent(job.request), request, names = [], stepIndex;
            if (requestText.length > 131072 || encodeURIComponent(requestText).replace(/%[A-Fa-f0-9]{2}|./g, "x").length > 131072) {
                throw new Error("Function request exceeds 128 KiB");
            }
            request = this.functions.parse(requestText);
            this.bundle.refresh(false);
            this.functions.validate(request);
            for (stepIndex = 0; stepIndex < request.steps.length; stepIndex += 1) { names.push(request.steps[stepIndex]["function"]); }
            return { name: "functions: " + names.join(", "), functionRequest: request };
        }
        if (typeof job.script !== "string" || typeof job.request !== "undefined" || jobFile.length > 4096) {
            throw new Error("Legacy jobs require a script path only, up to 4096 bytes");
        }

        var relativePath = String(job.script || "").replace(/\\/g, "/");
        if (!/^jsx\/[^\/]+\.jsx$/i.test(relativePath)) {
            throw new Error("Only direct .jsx files inside jsx/ are allowed");
        }

        if (/[:*?\"<>|\x00-\x1F]/.test(relativePath)) {
            throw new Error("Script path contains invalid characters");
        }

        var segments = relativePath.split("/");
        var index;
        for (index = 0; index < segments.length; index += 1) {
            if (segments[index] === "" || segments[index] === "." || segments[index] === "..") {
                throw new Error("Script path traversal is not allowed");
            }
        }

        var jsxFolder = new Folder(this.workspaceRoot + "/jsx");
        var jsxRoot = normalizePath(jsxFolder.fsName);
        var targetFile = new File(this.workspaceRoot + "/" + relativePath);
        var targetPath = normalizePath(targetFile.fsName);

        if (jsxFolder.alias || targetFile.alias) {
            throw new Error("Aliases, shortcuts, and symbolic links are not allowed");
        }

        if (normalizePath(targetFile.parent.fsName) !== jsxRoot ||
                targetPath.indexOf(jsxRoot + "/") !== 0) {
            throw new Error("Script resolves outside the jsx folder");
        }

        this.bundle.refresh(false);
        if (this.bundle.has(targetFile.name)) { return { name: targetFile.name, bundleBranch: true }; }
        if (!targetFile.exists) {
            throw new Error("Script does not exist: " + relativePath);
        }

        return targetFile;
    };

    Bridge.prototype.rejectJob = function (jobFile, error, job) {
        var rejectedName = jobFile.name + ".rejected-" + new Date().getTime();
        jobFile.rename(rejectedName);
        this.setUiStatus("Rejected job: " + String(error));
        this.log("error", "Rejected job: " + this.describeError(error), job ? job.runId : "");

        if (job && job.sessionNonce === this.sessionNonce &&
                /^[A-Za-z0-9-]{8,80}$/.test(job.runId || "")) {
            this.pendingReport = {
                runId: job.runId,
                state: "error",
                phase: "validation",
                errorCode: "JOB_REJECTED",
                retryable: false,
                completionKnown: true,
                operation: job.schema === "codex-ae-job/v2" ? "function plan" : (job.script || "unknown JSX"),
                startedAt: new Date().getTime(),
                message: this.describeError(error),
                result: "",
                runningFile: null
            };
            this.busy = true;
            this.publishPendingReport();
        }
    };

    Bridge.prototype.processJob = function (jobFile) {
        var job;
        var targetFile;

        try {
            job = this.readJob(jobFile);
            if (job.sessionNonce !== this.sessionNonce) {
                // Another AE instance owns this job. Leave it untouched so the
                // matching bridge can claim it.
                return;
            }
            targetFile = this.validateJob(jobFile, job);
        } catch (validationError) {
            this.rejectJob(jobFile, validationError, job);
            return;
        }

        var runningName = "job-" + job.runId + ".running";
        if (!jobFile.rename(runningName)) {
            this.setUiStatus("Could not claim job " + job.runId + ": " + jobFile.error);
            this.logOnce("claim", "error", "Could not claim job " + job.runId + ": " + jobFile.error, job.runId);
            return;
        }
        this.logNotices.claim = "";

        var runningFile = new File(this.inboxPath + "/" + runningName);
        var startedAt = new Date().getTime();
        var report;
        var evaluationResult;
        var executionDescription = "";
        var executionSucceeded = false;
        var controller = this, contextActive = true;
        this.busy = true;
        this.hideProgressPending = false;
        this.showProgress();
        this.setProgress(0, "Running " + targetFile.name);
        this.log("info", "Started " + targetFile.name, job.runId);
        this.setUiStatus("Running " + targetFile.name + "\nRun ID: " + job.runId);

        try {
            // If this preflight write fails, the target is not executed.
            this.writeStarted(job.runId, targetFile.name, startedAt);
        } catch (preflightError) {
            this.log("error", "Job preflight failed: " + this.describeError(preflightError), job.runId);
            this.setProgress(0, "Preflight failed");
            this.pendingReport = {
                runId: job.runId,
                state: "error",
                phase: "preflight",
                errorCode: "START_STATUS_FAILED",
                retryable: true,
                completionKnown: true,
                operation: targetFile.name,
                startedAt: startedAt,
                message: this.describeError(preflightError),
                result: "",
                runningFile: runningFile
            };
            this.publishPendingReport();
            return;
        }

        try {
            $.global.__CODEX_AE_RUN_CONTEXT__ = {
                schema: "codex-ae-context/v1",
                runId: job.runId,
                workspaceRoot: this.workspaceRoot,
                progress: function (percent, message) {
                    if (!contextActive || !isFinite(Number(percent))) { return; }
                    controller.setProgress(percent, message || targetFile.name);
                    controller.log("progress", message || targetFile.name, job.runId, Number(percent));
                },
                log: function (message, level) {
                    if (contextActive) { controller.log(level === "error" || level === "warning" ? level : "info", message, job.runId); }
                }
            };

            if (targetFile.functionRequest) {
                evaluationResult = this.functions.stringify(this.functions.run(targetFile.functionRequest, $.global.__CODEX_AE_RUN_CONTEXT__));
            } else {
                evaluationResult = targetFile.bundleBranch ? this.bundle.run(targetFile.name) : $.evalFile(targetFile);
            }
            executionSucceeded = true;
        } catch (executionError) {
            executionDescription = this.describeError(executionError);
        } finally {
            contextActive = false;
            try {
                delete $.global.__CODEX_AE_RUN_CONTEXT__;
            } catch (contextError) {
                $.global.__CODEX_AE_RUN_CONTEXT__ = null;
            }
        }

        if (executionSucceeded) {
            this.setProgress(100, "Completed " + targetFile.name);
            this.log("info", "Completed successfully: " + targetFile.name, job.runId, 100);
            this.hideProgressPending = true;
        } else {
            this.setProgress(this.progressValue, "Failed " + targetFile.name);
            this.log("error", executionDescription, job.runId);
        }

        report = {
            runId: job.runId,
            state: executionSucceeded ? "success" : "error",
            phase: executionSucceeded ? "completed" : "evaluating",
            errorCode: executionSucceeded ? "" : (targetFile.functionRequest ? "FUNCTION_EXECUTION_FAILED" : "JSX_EXECUTION_FAILED"),
            retryable: false,
            completionKnown: true,
            operation: targetFile.name,
            startedAt: startedAt,
            message: executionSucceeded ? (targetFile.functionRequest ? "Function plan completed" : "JSX completed") : executionDescription,
            result: executionSucceeded && typeof evaluationResult !== "undefined" ?
                String(evaluationResult) : "",
            runningFile: runningFile
        };
        this.pendingReport = report;
        this.publishPendingReport();
    };

    Bridge.prototype.markConnectionUnavailable = function (message, preserveStatus) {
        this.setConnectionStatus(false, message);
        if (preserveStatus) { return; }
        this.lastStatus = String(message);
        try { if (this.statusText) { setControl(this.statusText, "text", this.lastStatus); } }
        catch (disposedStatusError) { releaseBridgeUi(this); }
    };

    Bridge.prototype.verifyHeartbeatPublication = function () {
        var heartbeat = new File(this.heartbeatPath), text, expectedSession, expectedTimestamp, expectedWorkspace;
        if (!heartbeat.exists || !heartbeat.open("r")) { return false; }
        try { text = heartbeat.read(); }
        finally { heartbeat.close(); }
        expectedSession = "\"sessionNonce\":\"" + jsonEscape(this.sessionNonce) + "\"";
        expectedTimestamp = "\"timestampEpochMs\":" + String(this.lastHeartbeat);
        expectedWorkspace = "\"workspaceRoot\":\"" + jsonEscape(this.workspaceRoot) + "\"";
        return text.indexOf("\"schema\":\"codex-ae-heartbeat/v1\"") >= 0 &&
            text.indexOf("\"bridgeVersion\":\"" + jsonEscape(BRIDGE_VERSION) + "\"") >= 0 &&
            text.indexOf(expectedWorkspace) >= 0 &&
            text.indexOf("\"state\":\"running\"") >= 0 &&
            text.indexOf(expectedSession) >= 0 && text.indexOf(expectedTimestamp) >= 0;
    };

    Bridge.prototype.ensureListenerOwner = function (reason, reclaimMissing) {
        var registered = $.global[GLOBAL_NAME], message;
        if (registered === this) { return true; }
        if (!registered && reclaimMissing) {
            $.global[GLOBAL_NAME] = this;
            this.log("warning", "Restored missing bridge binding; session=" + this.sessionNonce +
                "; generation=" + this.generation + "; reason=" + String(reason || "panel").substring(0, 80));
            return true;
        }
        message = "Panel này không còn giữ kết nối. Đóng và mở lại Codex Bridge để dùng phiên hiện tại.";
        this.markConnectionUnavailable(message);
        this.logOnce("ownership-conflict", "warning", "Refused stale panel listener; session=" + this.sessionNonce +
            "; generation=" + this.generation + "; reason=" + String(reason || "panel").substring(0, 80));
        return false;
    };

    Bridge.prototype.refreshConnectionHealth = function () {
        var age, now;
        if (!this.running || !this.ready || this.connectionActionActive) { return; }
        now = new Date().getTime();
        age = now - this.lastHeartbeat;
        if (this.lastHeartbeat && now - this.lastHeartbeatCheckAt >= 2000) {
            this.lastHeartbeatCheckAt = now;
            try { this.heartbeatPublicationVerified = this.verifyHeartbeatPublication(); }
            catch (heartbeatReadError) { this.heartbeatPublicationVerified = false; }
        }
        if ($.global[GLOBAL_NAME] !== this || !this.lastHeartbeat || age < -5000 || age > 10000 ||
                !this.heartbeatPublicationVerified || this.connectionRecoveryPending) {
            this.markConnectionUnavailable(this.connectionRecoveryPending ? "Đang khôi phục kết nối; chờ heartbeat mới…" :
                "Mất nhịp kết nối; đang kiểm tra listener AE…", /^Bridge (error|listener stopped):/.test(this.lastStatus));
        }
    };

    Bridge.prototype.scheduleNext = function (delay) {
        if (this.running && !this.taskId) {
            if ($.global[GLOBAL_NAME] !== this) { throw new Error("Bridge listener ownership changed before scheduling"); }
            this.taskToken += 1;
            this.taskDueAt = new Date().getTime() + delay;
            this.taskId = app.scheduleTask(
                "if ($.global.__codexAeBridgeV1 && typeof $.global.__codexAeBridgeV1.runScheduled === \"function\") { " +
                    "$.global.__codexAeBridgeV1.runScheduled(" + this.generation + "," + this.taskToken + ",\"" +
                    jsonEscape(this.sessionNonce) + "\"); }",
                delay,
                false
            );
            if (!this.taskId) {
                throw new Error("After Effects could not schedule the next bridge task");
            }
        }
    };

    Bridge.prototype.runScheduled = function (generation, taskToken, sessionNonce) {
        if ($.global[GLOBAL_NAME] !== this || !this.running || generation !== this.generation || taskToken !== this.taskToken ||
                sessionNonce !== this.sessionNonce || this.scheduledCallbackActive) {
            return;
        }

        this.taskId = 0;
        this.taskDueAt = 0;
        this.scheduledCallbackActive = true;
        try {
            if (!this.ready) { this.advanceStartup(generation); }
            else { this.tick(generation); }
        } finally {
            this.scheduledCallbackActive = false;
        }
    };

    Bridge.prototype.recoverScheduled = function (reason) {
        var now, staleTask;
        // AE can discard a one-shot task while restoring Home/workspaces. Native
        // panel activity may rearm only that listener, never restart a session or
        // replay a job. Healthy layout events allocate no additional timer.
        if (!this.running || this.connectionActionActive || this.scheduledCallbackActive ||
                (this.busy && !this.pendingReport && !this.pendingCleanupFile)) { return false; }
        now = new Date().getTime();
        if (this.taskId && (!this.taskDueAt || now - this.taskDueAt < 10000)) { return false; }
        if (!this.ensureListenerOwner(reason, true)) { return false; }
        staleTask = this.taskId;
        this.taskToken += 1;
        this.taskId = 0;
        this.taskDueAt = 0;
        if (staleTask) { try { app.cancelTask(staleTask); } catch (expiredTaskError) {} }
        try {
            this.connectionRecoveryPending = true;
            this.markConnectionUnavailable("Đang khôi phục kết nối; chờ heartbeat mới…");
            this.scheduleNext(60);
            this.log("warning", "Khôi phục nhịp kết nối AE; session=" + this.sessionNonce + "; generation=" +
                this.generation + "; reason=" + String(reason || "panel hoạt động").substring(0, 80) + ". Không chạy lại lệnh cũ.");
            return true;
        } catch (recoveryError) {
            this.running = false; this.ready = false;
            this.log("error", "Không khôi phục được nhịp kết nối: " + this.describeError(recoveryError));
            this.setConnectionStatus(false, "Listener stopped");
            this.setUiStatus("Bridge listener stopped:\n" + String(recoveryError));
            try { this.writeHeartbeat("error", String(recoveryError)); } catch (heartbeatError) {}
            return false;
        }
    };

    Bridge.prototype.failStartup = function (error) {
        this.log("error", "Connection failed: " + this.describeError(error));
        this.setConnectionStatus(false, "Connection error");
        var failedAt = this.progressValue;
        this.ready = false;
        this.running = false;
        this.taskId = 0;
        this.showProgress();
        this.setProgress(failedAt, "Failed at " + failedAt + "%");
        this.setUiStatus("Could not start bridge:\n" + String(error));
        try {
            this.writeHeartbeat("error", String(error));
        } catch (heartbeatError) {
            // The inline status remains available when file access failed.
        }
    };

    Bridge.prototype.advanceStartup = function (generation) {
        if (!this.running || generation !== this.generation) {
            return;
        }

        try {
            switch (this.startupStep) {
            case 0:
                this.setProgress(10, "Checking workspace");
                if (!(new Folder(this.workspaceRoot)).exists) {
                    throw new Error("Workspace folder does not exist: " + this.workspaceRoot);
                }
                break;
            case 1:
                this.setProgress(25, "Preparing runtime folder");
                this.ensureFolder(this.workspaceRoot + "/.ae-codex");
                break;
            case 2:
                this.setProgress(45, "Preparing bridge storage");
                this.ensureFolder(this.bridgeRoot);
                break;
            case 3:
                this.setProgress(65, "Preparing job inbox");
                this.ensureFolder(this.inboxPath);
                break;
            case 4:
                this.setProgress(80, "Preparing result storage");
                this.ensureFolder(this.resultsPath);
                break;
            case 5:
                this.setProgress(92, "Testing heartbeat");
                this.writeHeartbeat("starting", "Bridge startup in progress");
                break;
            case 6:
                this.setProgress(97, "Starting library and job listener");
                this.bundle.refresh(false);
                this.bundle.loadInstallation();
                this.refreshScriptsDisplay();
                this.beginLibrary();
                break;
            default:
                this.ready = true;
                this.setProgress(100, "Success");
                this.writeHeartbeat("running", "Waiting for jobs");
                var connectedAt = new Date();
                this.lastActivityAt = connectedAt.getTime();
                // Time stamp makes every successful (re)connect visible in the panel.
                this.setUiStatus(
                    "Bridge " + BRIDGE_VERSION + " connected successfully · " +
                    (connectedAt.getHours() < 10 ? "0" : "") + connectedAt.getHours() + ":" +
                    (connectedAt.getMinutes() < 10 ? "0" : "") + connectedAt.getMinutes() + ":" +
                    (connectedAt.getSeconds() < 10 ? "0" : "") + connectedAt.getSeconds() + "\n" +
                    "Ready for Codex jobs"
                );
                this.hideProgressPending = true;
                this.log("info", "Bridge " + BRIDGE_VERSION + " connected; ready for jobs");
                break;
            }

            if (!this.ready) { this.log("info", this.progressLabel, "", this.progressValue); }
            this.startupStep += 1;
            if (this.running && generation === this.generation) {
                this.scheduleNext(this.ready ? 700 : 80);
            }
        } catch (startupError) {
            this.failStartup(startupError);
        }
    };

    Bridge.prototype.tick = function (generation) {
        if (!this.running || !this.ready || generation !== this.generation) {
            return;
        }

        try {
            if (this.hideProgressPending) {
                this.hideProgressPending = false;
                this.hideProgress();
            }

            if (this.pendingReport) {
                this.publishPendingReport();
            }
            if (!this.pendingReport && this.pendingCleanupFile) {
                this.retryPendingCleanup();
            }

            var now = new Date().getTime();
            this.reflowUi();
            if (now - this.lastHeartbeat >= 2000) {
                this.writeHeartbeat(
                    "running",
                    this.pendingReport ? "Reporting JSX result" :
                        (this.pendingCleanupFile ? "Cleaning completed job" :
                            (this.busy ? "Executing JSX" : "Waiting for jobs"))
                );
            }

            if (!this.busy && !this.pendingReport && !this.pendingCleanupFile) {
                var inbox = new Folder(this.inboxPath);
                var jobs = inbox.getFiles(function (candidate) {
                    return candidate instanceof File && /\.job$/i.test(candidate.name);
                });

                if (jobs.length > 0) {
                    jobs.sort(function (left, right) {
                        return left.name < right.name ? -1 : (left.name > right.name ? 1 : 0);
                    });
                    this.lastActivityAt = now;
                    this.processJob(jobs[0]);
                } else {
                    if (now - this.bundle.lastPoll >= (now - this.lastActivityAt < 20000 ? 2000 : 5000)) { this.bundle.refresh(false); }
                    this.refreshScriptsDisplay();
                    if (this.library) {
                        this.library.tick();
                        this.refreshLibraryDisplay();
                    }
                }
            }
        } catch (tickError) {
            this.logOnce("listener", "error", "Bridge listener error: " + this.describeError(tickError));
            this.setConnectionStatus(false, "Connection error");
            this.setUiStatus("Bridge error: " + String(tickError));
            try {
                this.writeHeartbeat("error", String(tickError));
            } catch (heartbeatError) {
                // The palette remains visible so the user can see the failure.
            }
        } finally {
            if (this.running && this.ready && generation === this.generation) {
                try {
                    // Idle backoff: scan the inbox every 0.5 s right after activity, every 1 s when idle.
                    // Heartbeat cadence (2 s) and the 10 s freshness limit are unchanged.
                    this.scheduleNext(this.busy || this.pendingReport || this.pendingCleanupFile ||
                        new Date().getTime() - this.lastActivityAt < 20000 ? 500 : 1000);
                } catch (scheduleError) {
                    this.log("error", "Bridge listener stopped: " + this.describeError(scheduleError));
                    this.ready = false;
                    this.running = false;
                    this.setConnectionStatus(false, "Listener stopped");
                    this.showProgress();
                    this.setProgress(100, "Listener stopped");
                    this.setUiStatus("Bridge listener stopped:\n" + String(scheduleError));
                    try {
                        this.writeHeartbeat("error", String(scheduleError));
                    } catch (heartbeatError) {
                        // The inline status remains available.
                    }
                }
            }
        }
    };

    // Reconnect picks up a newer installed version without restarting AE: installation.json in
    // the install root points at the active runtime. If it differs from this bridge's runtime,
    // load that bundle into the same panel; it stops and replaces this bridge (no job is replayed).
    Bridge.prototype.loadNewerInstallation = function () {
        var root = new Folder(this.workspaceRoot), installRoot = root.parent && root.parent.parent, file, text, match,
            target, bundle, keys = ["__CODEX_AE_WORKSPACE_ROOT__", "__CODEX_AE_PANEL_HOST__", "__CODEX_AE_AUTOSTART_ONLY__"],
            present = [], previous = [], i;
        try {
            if (!installRoot || String(root.parent.name).toLowerCase() !== "versions") { return false; }
            file = new File(installRoot.fsName + "/installation.json");
            if (!file.exists) { return false; }
            file.encoding = "UTF-8";
            if (!file.open("r")) { return false; }
            try { text = file.read(); } finally { file.close(); }
            if (/"state"\s*:\s*"uninstall/.test(text)) { return false; }
            match = /"runtimeRoot"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
            if (!match) { return false; }
            target = match[1].replace(/\\\\/g, "\\").replace(/\\\//g, "/");
            if (normalizePath(new Folder(target).fsName) === normalizePath(root.fsName)) { return false; }
            bundle = new File(target + "/jsx/Codex Bridge.jsx");
            if (!bundle.exists) { return false; }
        } catch (probeError) {
            this.log("warning", "Không đọc được bản cài mới: " + this.describeError(probeError));
            return false;
        }
        this.log("info", "Tìm thấy bản cài mới tại " + bundle.parent.parent.fsName + "; đang nạp vào panel này. Không chạy lại lệnh cũ.");
        this.setUiStatus("Đang nạp bản mới…");
        for (i = 0; i < keys.length; i += 1) { present[i] = $.global.hasOwnProperty(keys[i]); previous[i] = $.global[keys[i]]; }
        try {
            $.global.__CODEX_AE_WORKSPACE_ROOT__ = bundle.parent.parent.fsName;
            $.global.__CODEX_AE_PANEL_HOST__ = this.window instanceof Panel ? this.window : undefined;
            $.global.__CODEX_AE_AUTOSTART_ONLY__ = false;
            $.evalFile(bundle);
            return true;
        } catch (loadError) {
            this.log("error", "Không nạp được bản mới, giữ bản hiện tại: " + this.describeError(loadError));
            return false;
        } finally {
            for (i = 0; i < keys.length; i += 1) {
                if (present[i]) { $.global[keys[i]] = previous[i]; } else { delete $.global[keys[i]]; }
            }
        }
    };

    Bridge.prototype.start = function (reason) {
        if (this.connectionActionActive || this.scheduledCallbackActive ||
                (this.busy && !this.pendingReport && !this.pendingCleanupFile)) {
            this.logOnce("reconnect-busy", "warning", "Reconnect deferred: a bridge operation is still active; session=" + this.sessionNonce);
            return false;
        }
        if (!this.ensureListenerOwner(reason || "start", true)) { return false; }
        if (String(reason || "").indexOf("Reconnect") === 0 && !this.pendingReport && !this.pendingCleanupFile &&
                this.loadNewerInstallation()) { return true; }
        this.connectionActionActive = true;
        try {
            // A ScriptUI panel can be closed while its named engine survives.
            // Always replace the old task instead of trusting a stale running
            // flag or task ID when the panel is opened again.
            if (this.taskId) {
                try {
                    app.cancelTask(this.taskId);
                } catch (cancelError) {
                    // The previous task may already have expired.
                }
            }
            this.generation += 1;
            this.taskToken += 1;
            if (this.library) { this.library.stop(); }
            this.taskId = 0;
            this.taskDueAt = 0;
            this.running = true;
            this.manualStop = false;
            this.ready = false;
            this.busy = this.pendingReport !== null || this.pendingCleanupFile !== null;
            this.setConnectionStatus(false, "Connecting...");
            this.startupStep = 0;
            this.hideProgressPending = false;
            this.lastHeartbeat = 0;
            this.lastHeartbeatCheckAt = 0;
            this.heartbeatPublicationVerified = false;
            this.connectionRecoveryPending = true;
            this.showProgress();
            this.setProgress(0, "Initializing");
            this.setUiStatus(String(reason || "").indexOf("Reconnect") === 0 ? "Đang kết nối lại…" : "Bridge " + BRIDGE_VERSION + " starting...");
            this.log("info", "Connecting automatically to workspace bridge; session=" + this.sessionNonce +
                "; generation=" + this.generation + "; reason=" + String(reason || "auto start").substring(0, 80));
            this.scheduleNext(60);
            return true;
        } catch (startError) {
            this.failStartup(startError);
            return false;
        } finally {
            this.connectionActionActive = false;
        }
    };

    Bridge.prototype.stop = function () {
        this.manualStop = true;
        this.log("info", "Bridge stopped by user");
        this.generation += 1;
        this.taskToken += 1;
        if (this.library) { this.library.stop(); }
        this.refreshLibraryDisplay();
        if (this.taskId) {
            try {
                app.cancelTask(this.taskId);
            } catch (cancelError) {
                // Continue stopping even if the task already ended.
            }
        }

        this.taskId = 0;
        this.taskDueAt = 0;
        this.running = false;
        this.ready = false;
        this.setConnectionStatus(false, "Disconnected");
        this.startupStep = 0;
        this.hideProgressPending = false;
        this.setProgress(0, "Stopped");
        this.hideProgress();
        try {
            this.writeHeartbeat("stopped", "Bridge stopped by user");
        } catch (heartbeatError) {
            // There may be no file permission while stopping.
        }
        this.setUiStatus("Bridge stopped");
    };

    Bridge.prototype.showWindow = function () {
        this.recoverScheduled("panel shown");
        if (this.window) {
            if (this.window instanceof Window) {
                this.window.show();
            } else {
                this.reflowUi();
            }
        }
    };

    var bridge, preserveConnection = false;
    if (existingBridge && existingBridge.version === BRIDGE_VERSION && sameWorkspace) {
        bridge = existingBridge; preserveConnection = !!bridge.hadUi;
    }
    else {
        if (existingBridge && existingBridge.stop) { try { existingBridge.stop(); } catch (oldBridgeError) {} }
        if (existingBridge) { releaseBridgeUi(existingBridge); }
        bridge = new Bridge(WORKSPACE_ROOT);
    }
    $.global[GLOBAL_NAME] = bridge;
    if (autoStartOnly) { bridge.start(); return; }
    if (bridge.window || bridge.ui) { releaseBridgeUi(bridge); }
    var palette = (thisObject instanceof Panel) ? thisObject : new Window("palette", "Codex AE", undefined, { resizeable: true });
    palette.orientation = "column"; palette.alignChildren = ["fill", "top"];
    palette.margins = 9; palette.spacing = 6;
    palette.preferredSize = [440, 310]; palette.minimumSize = [340, 220];
    if (palette instanceof Window) { palette.size = [440, 310]; }

    // ScriptUI keeps its native controls/keyboard behavior. Styling is optional
    // so an AE host without custom graphics can still connect and display errors.
    var cartoonInk = [0.92, 0.94, 0.98, 1];
    var cartoonPaper = [0.105, 0.12, 0.15, 1];
    var cartoonCard = [0.14, 0.16, 0.20, 1];
    var cartoonField = [0.075, 0.09, 0.12, 1];
    function cartoonSurface(control, color, fontName, fontSize) {
        try {
            if (fontName) { control.graphics.font = ScriptUI.newFont(fontName, "REGULAR", fontSize); }
        } catch (fontThemeError) { /* Use the host font if unavailable. */ }
        try {
            var graphics = control.graphics;
            graphics.backgroundColor = graphics.newBrush(graphics.BrushType.SOLID_COLOR, color);
            graphics.foregroundColor = graphics.newPen(graphics.PenType.SOLID_COLOR, cartoonInk, 1);
            graphics.disabledBackgroundColor = graphics.newBrush(graphics.BrushType.SOLID_COLOR, color);
            graphics.disabledForegroundColor = graphics.newPen(graphics.PenType.SOLID_COLOR, [0.62, 0.66, 0.74, 1], 1);
        } catch (themeError) { /* Native host styling remains usable. */ }
    }
    // EditText owns selection, keyboard and wheel scrolling. ScriptUI calls this
    // option "scrollable"; "scrolling" is ignored. Keep one native vertical rail
    // per pane, without extra frames or a second custom scroll state. Its OS rail
    // color is not exposed by ScriptUI graphics.
    function cartoonText(parent, text, readonly) {
        var control = parent.add("edittext", undefined, text || "", {
            multiline: true, readonly: !!readonly, scrollable: true, borderless: true
        });
        cartoonSurface(control, cartoonField, "Segoe UI", 12);
        return control;
    }
    function cartoonButton(control, color) {
        control.preferredSize = [110, 32];
        cartoonSurface(control, color, "Segoe UI", 12);
        // Leave painting to AE. Custom onDraw can lose the entire button after
        // docking or a native graphics reset, including its fallback drawing.
        // Native controls retain disabled, keyboard and focus behavior without
        // cached paint handles or a redraw timer.
    }
    function cartoonDialog(dialog, search, list, detail, close) {
        cartoonSurface(dialog, cartoonPaper);
        cartoonSurface(search, cartoonField, "Segoe UI", 12);
        cartoonSurface(list, cartoonField, "Segoe UI", 12);
        cartoonSurface(detail, cartoonCard, "Segoe UI", 12);
        cartoonButton(close, [0.27, 0.24, 0.43, 1]);
    }
    cartoonSurface(palette, cartoonPaper);
    var title = palette.add("statictext", undefined, "Codex AE · Công cụ & kết nối");
    var connectionText = palette.add("statictext", undefined, "Đang kết nối After Effects…");
    connectionText.helpTip = "Trạng thái cầu nối AE trên máy này. Dùng Codex để gọi công cụ qua MCP.";
    var statusText = palette.add("statictext", undefined, "Đang khởi động cầu nối…", { multiline: true });
    var scriptsText = palette.add("statictext", undefined, "Đang tải danh mục công cụ…", { multiline: true });
    var libraryText = palette.add("statictext", undefined, "Thư viện chỉ cập nhật khi bạn bấm nút.", { multiline: true });
    var libraryOptions = palette.add("group");
    var effectsToggle = libraryOptions.add("checkbox", undefined, "Effects");
    var sfxToggle = libraryOptions.add("checkbox", undefined, "SFX");
    var sfxFoldersButton = libraryOptions.add("button", undefined, "Thư mục…");
    var refreshLibraryButton = libraryOptions.add("button", undefined, "Cập nhật");
    effectsToggle.value = false; sfxToggle.value = false;
    effectsToggle.enabled = sfxToggle.enabled = sfxFoldersButton.enabled = refreshLibraryButton.enabled = false;
    effectsToggle.helpTip = "Chọn kiểm kê effects. Không tắt effects hay layer trong project; không tự quét khi đổi lựa chọn.";
    sfxToggle.helpTip = "Chọn kiểm kê SFX đã cho phép. Không tắt âm thanh trong project; không tự quét khi đổi lựa chọn.";
    refreshLibraryButton.helpTip = "Chỉ lập chỉ mục thư viện theo yêu cầu; không bật/tắt effects, layer hay âm thanh trong project.";
    sfxFoldersButton.helpTip = "Thêm hoặc đổi thư mục SFX trên ổ đĩa. Chỉ lưu lựa chọn; không tự quét, tự bật SFX hay xóa dữ liệu.";
    effectsToggle.onClick = function () { bridge.setLibraryEnabled("effects", !!effectsToggle.value); };
    sfxToggle.onClick = function () { bridge.setLibraryEnabled("sfx", !!sfxToggle.value); };
    refreshLibraryButton.onClick = function () { bridge.requestLibraryRefresh(); };
    sfxFoldersButton.onClick = function () { bridge.showSfxFolders(); };
    var buttons = palette.add("group");
    var viewFunctionsButton = buttons.add("button", undefined, "Công cụ");
    var viewScriptsButton = buttons.add("button", undefined, "Kho script");
    var startButton = buttons.add("button", undefined, "Kết nối lại");
    var stopButton = buttons.add("button", undefined, "Dừng");
    viewFunctionsButton.onClick = function () { bridge.showFunctions(); };
    viewScriptsButton.onClick = function () { bridge.showScripts(); };
    startButton.onClick = function () {
        if (bridge.ui !== attachedUi || bridge.window !== palette) { return; }
        bridge.start("Reconnect button");
    };
    stopButton.onClick = function () { bridge.stop(); };
    var progressGroup = palette.add("group");
    var progressText = progressGroup.add("statictext", undefined, "Đang tải · 0%");
    var progressBar = progressGroup.add("progressbar", undefined, 0, 100);
    var logPanel = palette.add("panel", undefined, "Nhật ký làm việc");
    var logView = cartoonText(logPanel, "", true);
    var clearLogButton = logPanel.add("button", undefined, "Xóa nhật ký hiển thị");
    clearLogButton.onClick = function () { bridge.clearLog(); };
    var footer = palette.add("group");
    var logToggle = footer.add("button", undefined, "Nhật ký ▸");
    var logSummary = footer.add("statictext", undefined, "Đang kết nối…");
    logToggle.onClick = function () {
        if (bridge.ui !== attachedUi || bridge.window !== palette) { return; }
        bridge.ui.logExpanded = !bridge.ui.logExpanded; bridge.reflowUi(true);
    };
    cartoonSurface(palette, cartoonPaper); cartoonSurface(title, cartoonPaper, "Segoe UI", 14);
    cartoonSurface(connectionText, cartoonPaper, "Segoe UI", 12); cartoonSurface(statusText, cartoonCard, "Segoe UI", 11);
    cartoonSurface(scriptsText, cartoonPaper, "Segoe UI", 11); cartoonSurface(libraryText, cartoonPaper, "Segoe UI", 11);
    cartoonSurface(effectsToggle, cartoonPaper, "Segoe UI", 11); cartoonSurface(sfxToggle, cartoonPaper, "Segoe UI", 11);
    cartoonSurface(progressText, cartoonPaper, "Segoe UI", 11); cartoonSurface(logPanel, cartoonCard);
    cartoonSurface(logSummary, cartoonPaper, "Segoe UI", 10);
    cartoonButton(viewFunctionsButton, [0.19, 0.29, 0.46, 1]); cartoonButton(viewScriptsButton, [0.29, 0.24, 0.44, 1]);
    cartoonButton(startButton, [0.16, 0.34, 0.27, 1]); cartoonButton(stopButton, [0.43, 0.22, 0.23, 1]);
    cartoonButton(clearLogButton, [0.35, 0.29, 0.17, 1]); cartoonButton(logToggle, [0.22, 0.25, 0.31, 1]);
    cartoonButton(refreshLibraryButton, [0.19, 0.29, 0.46, 1]);
    cartoonButton(sfxFoldersButton, [0.29, 0.24, 0.44, 1]);
    try {
        bridge.connectionPens = {
            connected: connectionText.graphics.newPen(connectionText.graphics.PenType.SOLID_COLOR, [0.47, 0.88, 0.66, 1], 1),
            disconnected: connectionText.graphics.newPen(connectionText.graphics.PenType.SOLID_COLOR, [1, 0.55, 0.52, 1], 1)
        };
    } catch (connectionThemeError) { bridge.connectionPens = null; }
    bridge.window = palette; bridge.statusText = statusText; bridge.connectionText = connectionText;
    try { palette.__codexAeBridgeOwnerV1 = bridge; } catch (hostAnchorError) {}
    bridge.scriptsText = scriptsText; bridge.libraryText = libraryText;
    bridge.progressGroup = progressGroup; bridge.progressText = progressText; bridge.progressBar = progressBar;
    bridge.logView = logView; bridge.logSummary = logSummary;
    bridge.libraryControls = { effects: effectsToggle, sfx: sfxToggle, folders: sfxFoldersButton, refresh: refreshLibraryButton };
    bridge.ui = { logExpanded: false, logVisible: false, layoutSignature: "" };
    bridge.logViewRevision = -1;
    bridge.hadUi = true;
    var attachedUi = bridge.ui;
    bridge.ui.actions = [
        { control: effectsToggle, action: "effects" }, { control: sfxToggle, action: "sfx" },
        { control: sfxFoldersButton, action: "folders" }, { control: refreshLibraryButton, action: "refresh" },
        { control: viewFunctionsButton, action: "functions" }, { control: viewScriptsButton, action: "scripts" },
        { control: startButton, action: "start" }, { control: stopButton, action: "stop" },
        { control: clearLogButton, action: "clearLog" }, { control: logToggle, action: "toggleLog" }
    ];
    bridge.ownedUiRoots = [title, connectionText, statusText, scriptsText, libraryText, libraryOptions, buttons, progressGroup, logPanel, footer];
    // TOOLS_LAYOUT_BEGIN: idle ticks reuse bounds and never rebuild controls.
    function setToolsBounds(control, bounds) {
        var actual = control.bounds, i, same = !!actual;
        for (i = 0; same && i < 4; i += 1) { if (Number(actual[i]) !== bounds[i]) { same = false; } }
        if (same) { return; }
        control.minimumSize = [0, 0]; control.maximumSize = [100000, 100000]; control.bounds = bounds;
    }
    bridge.ui.reflow = function (force) {
        if (bridge.ui !== attachedUi || bridge.window !== palette) { return; }
        var size = palette.size, w = size && Number(typeof size.width === "number" ? size.width : size[0]),
            h = size && Number(typeof size.height === "number" ? size.height : size[1]),
            ui = bridge.ui, m = 9, gap = 6, width, signature, footerY, logHeight, logY, buttonY, libraryY, progressY, infoBottom, buttonWidth, i, controls;
        if (!isFinite(w) || !isFinite(h) || w < 340 || h < 220) { return; }
        signature = w + "|" + h + "|" + ui.logExpanded + "|" + progressGroup.visible;
        if (!force && signature === ui.layoutSignature) { return; }
        controls = [viewFunctionsButton, viewScriptsButton, startButton, stopButton];
        width = w - m * 2; footerY = h - m - 26;
        logHeight = ui.logExpanded && h >= 300 ? Math.min(140, Math.max(80, h - 252)) : 0;
        logY = footerY - gap - logHeight;
        progressY = logY - (progressGroup.visible ? 34 : 0) - gap;
        buttonY = progressY - 30 - gap; libraryY = buttonY - 24 - gap; infoBottom = libraryY - gap;
        setToolsBounds(title, [m, m, w - m, m + 23]); setToolsBounds(connectionText, [m, 37, w - m, 57]);
        setToolsBounds(statusText, [m, 63, w - m, Math.max(63, Math.min(94, infoBottom))]);
        setToolsBounds(scriptsText, [m, Math.min(99, infoBottom), w - m, Math.min(132, infoBottom)]);
        setToolsBounds(libraryText, [m, Math.min(136, infoBottom), w - m, Math.max(Math.min(136, infoBottom), infoBottom)]);
        setToolsBounds(libraryOptions, [m, libraryY, w - m, libraryY + 24]);
        setToolsBounds(effectsToggle, [0, 0, 64, 24]); setToolsBounds(sfxToggle, [68, 0, 112, 24]);
        setToolsBounds(sfxFoldersButton, [118, 0, 198, 24]); setToolsBounds(refreshLibraryButton, [204, 0, width, 24]);
        setToolsBounds(buttons, [m, buttonY, w - m, buttonY + 30]);
        buttonWidth = Math.floor((width - gap * 3) / 4);
        for (i = 0; i < controls.length; i += 1) { setToolsBounds(controls[i], [i * (buttonWidth + gap), 0, i === 3 ? width : i * (buttonWidth + gap) + buttonWidth, 30]); }
        setToolsBounds(progressGroup, [m, progressY, w - m, progressY + (progressGroup.visible ? 28 : 0)]);
        setToolsBounds(progressText, [0, 0, width, 15]); setToolsBounds(progressBar, [0, 18, width, 27]);
        setControl(logPanel, "visible", logHeight > 0); setToolsBounds(logPanel, [m, logY, w - m, logY + logHeight]);
        setToolsBounds(logView, [6, 17, width - 6, Math.max(17, logHeight - 29)]);
        setToolsBounds(clearLogButton, [6, Math.max(17, logHeight - 26), Math.min(width - 6, 184), Math.max(17, logHeight - 3)]);
        setToolsBounds(footer, [m, footerY, w - m, footerY + 26]); setToolsBounds(logToggle, [0, 0, 96, 26]);
        setToolsBounds(logSummary, [103, 3, width, 24]); setControl(logToggle, "text", logHeight > 0 ? "Nhật ký ▾" : "Nhật ký ▸");
        setControl(logToggle, "helpTip", ui.logExpanded && !logHeight ? "Kéo panel cao hơn để mở nhật ký." : "Mở / thu gọn nhật ký công việc và lỗi.");
        ui.layoutSignature = signature;
        if (ui.logVisible !== (logHeight > 0)) {
            ui.logVisible = logHeight > 0;
            if (!ui.logVisible) { setControl(logView, "text", ""); bridge.logViewRevision = -1; }
            else { bridge.refreshLog(); }
        }
    };
    // TOOLS_LAYOUT_END
    // AE can request layout again after docking without changing panel size.
    // Keep one owner of bounds instead of letting the default auto-layout
    // overwrite the manual layout behind its unchanged-size cache.
    bridge.ui.nativeLayout = palette.layout;
    bridge.ui.layoutManager = {
        layout: function () { if (bridge.ui === attachedUi && bridge.window === palette) { bridge.reflowUi(true); } },
        resize: function () { if (bridge.ui === attachedUi && bridge.window === palette) { bridge.reflowUi(true); } }
    };
    palette.layout = bridge.ui.layoutManager;
    if (palette instanceof Window) {
        palette.onClose = function () {
            if (bridge.ui !== attachedUi || bridge.window !== palette) { return true; }
            bridge.stop(); releaseBridgeUi(bridge); $.global[GLOBAL_NAME] = null; return true;
        };
    }
    palette.onActivate = palette.onResizing = palette.onResize = function () {
        if (bridge.ui === attachedUi && bridge.window === palette) { bridge.reflowUi(true); }
    };
    rewireUiActions(bridge);
    bridge.refreshLog();
    try { bridge.bundle.refresh(false); bridge.bundle.loadInstallation(); }
    catch (bundleError) { bridge.bundle.error = String(bundleError); bridge.log("error", "Không tải được bộ công cụ: " + String(bundleError)); }
    bridge.refreshScriptsDisplay(); statusText.text = bridge.lastStatus || "Đang khởi động cầu nối…";
    progressText.text = bridge.progressLabel + " · " + bridge.progressValue + "%"; progressBar.value = bridge.progressValue;
    if (palette instanceof Window) { palette.center(); palette.show(); } else { palette.layout.layout(true); }
    bridge.reflowUi(true);
    if (preserveConnection) {
        bridge.setConnectionStatus(bridge.running && bridge.ready && !bridge.connectionRecoveryPending && bridge.lastHeartbeat > 0 &&
            new Date().getTime() - bridge.lastHeartbeat <= 10000, bridge.running ?
            (bridge.ready ? "Connected / Ready for Codex" : "Connecting...") : "Disconnected");
        bridge.refreshConnectionHealth();
        bridge.refreshLibraryDisplay();
        if (!bridge.running || (bridge.ready && !bridge.busy && !bridge.pendingReport)) { bridge.hideProgress(); }
    } else if (preserveReplacementStop) { bridge.stop(); }
    else { bridge.start(); }
}(this));
