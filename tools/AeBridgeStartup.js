#target aftereffects
#targetengine "codexAeBridge"
/* Installed only in the user's After Effects Scripts/Startup folder. */
(function () {
    var bundle;
    function resolveBundle(path) {
        var file = new File(path), uriPath, uriFile, posixFile;
        /* See the panel loader: probe readable handles and a file URI once. */
        if (file.exists) { return file; }
        try {
            if (typeof file.open === "function" && file.open("r")) {
                file.close();
                return file;
            }
        } catch (ignoredOpenError) {
            try { if (typeof file.close === "function") { file.close(); } } catch (ignoredCloseError) {}
        }
        uriPath = String(path).replace(/\\/g, "/");
        if (/^[A-Za-z]:\//.test(uriPath)) {
            uriFile = new File("file:///" + uriPath);
            if (uriFile.exists) { return uriFile; }
            try {
                if (typeof uriFile.open === "function" && uriFile.open("r")) {
                    uriFile.close();
                    return uriFile;
                }
            } catch (ignoredUriOpenError) {
                try { if (typeof uriFile.close === "function") { uriFile.close(); } } catch (ignoredUriCloseError) {}
            }
            posixFile = new File("/" + uriPath.charAt(0).toLowerCase() + uriPath.substr(2));
            if (posixFile.exists) { return posixFile; }
            try {
                if (typeof posixFile.open === "function" && posixFile.open("r")) {
                    posixFile.close();
                    return posixFile;
                }
            } catch (ignoredPosixOpenError) {
                try { if (typeof posixFile.close === "function") { posixFile.close(); } } catch (ignoredPosixCloseError) {}
            }
        }
        return file;
    }
    function evaluateBundle(file) {
        var directError, source, opened = false;
        try {
            $.evalFile(file);
            return;
        } catch (error) {
            directError = error;
        }
        /* Match the panel loader's one-shot LocalAppData fallback. */
        try {
            file.encoding = "UTF-8";
            opened = file.open("r");
            if (!opened) { throw directError; }
            source = file.read();
            file.close();
            opened = false;
            source = String(source).replace(/^\uFEFF/, "").replace(/^#target[^\r\n]*/gm, "");
            if (source.indexOf("CODEX_AE_BUNDLE_V2") < 0) { throw directError; }
            eval(source);
        } catch (fallbackError) {
            if (opened) { try { file.close(); } catch (ignoredCloseError) {} }
            throw directError;
        }
    }
    var hadFlag = Object.prototype.hasOwnProperty.call($.global, "__CODEX_AE_AUTOSTART_ONLY__");
    var previousFlag = $.global.__CODEX_AE_AUTOSTART_ONLY__;
    var hadRoot = Object.prototype.hasOwnProperty.call($.global, "__CODEX_AE_WORKSPACE_ROOT__");
    var previousRoot = $.global.__CODEX_AE_WORKSPACE_ROOT__;
    try {
        bundle = resolveBundle(__CODEX_AE_WORKSPACE_BUNDLE__);
        if (bundle.alias || bundle.parent.alias) { throw new Error("Workspace bundle is aliased: " + bundle.fsName); }
        $.global.__CODEX_AE_AUTOSTART_ONLY__ = true;
        $.global.__CODEX_AE_WORKSPACE_ROOT__ = bundle.parent.parent.fsName;
        evaluateBundle(bundle);
    } catch (error) {
        try { $.writeln("Codex Bridge startup: " + error.toString()); } catch (ignoredLogError) {}
    } finally {
        if (hadFlag) { $.global.__CODEX_AE_AUTOSTART_ONLY__ = previousFlag; }
        else { delete $.global.__CODEX_AE_AUTOSTART_ONLY__; }
        if (hadRoot) { $.global.__CODEX_AE_WORKSPACE_ROOT__ = previousRoot; }
        else { delete $.global.__CODEX_AE_WORKSPACE_ROOT__; }
    }
}());
