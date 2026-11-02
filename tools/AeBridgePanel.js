#target aftereffects
#targetengine "codexAeBridge"
/* Thin user-profile panel: the reviewed runtime stays in the installation. */
(function (thisObject) {
    var bundle, errorText;
    function resolveBundle(path) {
        var file = new File(path), uriPath, uriFile, posixFile;
        /*
         * ExtendScript on some AE 2026 Windows builds reports File.exists as
         * false for a normal drive path under AppData\Local even though the
         * file is readable.  Probe the handle once, then retry the equivalent
         * file URI.  This is bounded to two candidates and never polls.
         */
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
            /* AE's own fileName values use /c/...; try that spelling too. */
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
        /* Some AE hosts reject all existence/read probes but still accept
         * $.evalFile; let the evaluator report a real open error instead of
         * producing a false "missing" diagnostic. */
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
        /*
         * A few AE 2026 builds can read a file under LocalAppData but reject
         * that File object when it is passed to $.evalFile.  Read the already
         * verified bundle once and evaluate it in memory as a bounded fallback.
         * This path is reached only after the direct evaluation fails; it does
         * not add a timer, retry a job, or scan the bundle in the background.
         */
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
    var keys = ["__CODEX_AE_WORKSPACE_ROOT__", "__CODEX_AE_PANEL_HOST__", "__CODEX_AE_AUTOSTART_ONLY__"];
    var previous = [], present = [], index;
    for (index = 0; index < keys.length; index += 1) {
        present[index] = Object.prototype.hasOwnProperty.call($.global, keys[index]);
        previous[index] = $.global[keys[index]];
    }
    try {
        bundle = resolveBundle(__CODEX_AE_WORKSPACE_BUNDLE__);
        if (bundle.alias || bundle.parent.alias) { throw new Error("Workspace bundle is aliased: " + bundle.fsName); }
        $.global.__CODEX_AE_WORKSPACE_ROOT__ = bundle.parent.parent.fsName;
        $.global.__CODEX_AE_PANEL_HOST__ = thisObject;
        $.global.__CODEX_AE_AUTOSTART_ONLY__ = false;
        evaluateBundle(bundle);
    } catch (error) {
        errorText = "Codex AE: " + error.toString() +
            (error.line ? "\nDòng: " + error.line : "") +
            (error.fileName ? "\nTệp: " + error.fileName : "") +
            "\nMở Codex AE để sửa bản cài đặt.";
        try { $.writeln(errorText); } catch (ignoredLogError) {}
        try {
            if (thisObject instanceof Panel) {
                thisObject.add("statictext", undefined, errorText, { multiline: true });
                thisObject.layout.layout(true);
            }
        } catch (ignoredUiError) {}
    } finally {
        for (index = 0; index < keys.length; index += 1) {
            if (present[index]) { $.global[keys[index]] = previous[index]; }
            else { delete $.global[keys[index]]; }
        }
    }
}(this));
