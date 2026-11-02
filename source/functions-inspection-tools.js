/* ES3 fragment inserted inside the reusable-function registry. No CEP or AI code. */
    function inspectionShort(value, maximum) {
        return String(value === null || typeof value === "undefined" ? "" : value).substr(0, maximum || 1024);
    }
    function inspectionEffects(layer) {
        var group = layer && typeof layer.property === "function" ? layer.property("ADBE Effect Parade") : null;
        if (!group || typeof group.property !== "function") { fail("Selected layer has no effect group"); }
        return group;
    }
    function inspectionEffect(group, selection) {
        var count = Number(group.numProperties || 0), found = null, i, item;
        if (has(selection, "index")) {
            if (selection.index > count) { fail("Effect index does not exist: " + selection.index); }
            found = group.property(selection.index);
        } else {
            for (i = 1; i <= count; i += 1) {
                item = group.property(i);
                if (item && item.name === selection.name) {
                    if (found) { fail("Effect name is ambiguous; use its index: " + selection.name); }
                    found = item;
                }
            }
        }
        if (!found) { fail("Effect not found: " + stringify(selection)); }
        return found;
    }
    function inspectionValue(value, depth) {
        var out = [], i;
        depth = depth || 0;
        if (value === null || typeof value === "boolean" || finite(value)) { return value; }
        if (typeof value === "string") { return value.length > 2048 ? { text: value.substr(0, 2048), truncated: true } : value; }
        if (array(value) && depth < 3 && value.length <= 32) {
            for (i = 0; i < value.length; i += 1) { out.push(inspectionValue(value[i], depth + 1)); }
            return out;
        }
        return { unsupported: true };
    }
    register("effects.list", "Read registered AE effects directly without creating test layers; registration does not prove licensing", false,
        { search: "optional case-insensitive display name/matchName search", category: "optional exact case-insensitive category", maxItems: "optional integer 1..5000; default 200" }, function (a) {
            optional(a, "search", function (v, p) { text(v, p, 256, true); });
            optional(a, "category", function (v, p) { text(v, p, 256, true); });
            optional(a, "maxItems", function (v, p) { whole(v, p, 1, 5000); });
        }, function (a) {
            var registered, out = [], matched = 0, i, effect, item, search = String(a.search || "").toLowerCase(), category = String(a.category || "").toLowerCase(), limit = a.maxItems || 200;
            if (typeof app === "undefined" || !app.effects) { fail("After Effects does not expose registered effect metadata"); }
            registered = app.effects;
            for (i = 0; i < registered.length; i += 1) {
                effect = registered[i]; if (!effect) { continue; }
                item = { displayName: inspectionShort(effect.displayName), matchName: inspectionShort(effect.matchName), category: inspectionShort(effect.category), version: inspectionShort(effect.version, 128) };
                if (search && (item.displayName + " " + item.matchName).toLowerCase().indexOf(search) < 0) { continue; }
                if (category && item.category.toLowerCase() !== category) { continue; }
                matched += 1; if (out.length < limit) { out.push(item); }
            }
            return { registeredCount: registered.length, matchedCount: matched, effects: out, truncated: matched > out.length, runtimeLicenseVerified: false };
        });
    register("effect.inspect", "Read applied effects and bounded nested property values without changing layers", false,
        { comp: "optional comp selector", layer: "layer selector", maxProperties: "optional integer 1..5000 total effect/property nodes; default 200" }, function (a, refs) {
            selectors(a, refs, true); optional(a, "maxProperties", function (v, p) { whole(v, p, 1, 5000); });
        }, function (a, refs, entry) {
            var target = resolved(a, refs, entry, true), group = inspectionEffects(target.layer), count = Number(group.numProperties || 0), out = [], i, effect, item, used = 0, truncated = false, limit = a.maxProperties || 200;
            function children(parent, path, depth) {
                var values = [], total = Number(parent.numProperties || 0), j, property, result, nextPath;
                if (depth > 8) { if (total) { truncated = true; } return values; }
                for (j = 1; j <= total; j += 1) {
                    if (used >= limit) { truncated = true; break; }
                    property = parent.property(j); if (!property) { continue; }
                    used += 1; nextPath = path.concat([j]);
                    result = { index: j, path: nextPath, name: inspectionShort(property.name), matchName: inspectionShort(property.matchName), numProperties: Number(property.numProperties || 0), numKeys: Number(property.numKeys || 0) };
                    if (result.numProperties > 0 && typeof property.property === "function") { result.properties = children(property, nextPath, depth + 1); }
                    else {
                        try { result.value = inspectionValue(property.value); }
                        catch (valueError) { result.valueUnavailable = true; result.error = inspectionShort(valueError.message || valueError, 240); }
                        if (property.canSetExpression) {
                            result.expressionEnabled = !!property.expressionEnabled;
                            result.expression = inspectionShort(property.expression, 2048);
                            result.expressionError = inspectionShort(property.expressionError, 240);
                        }
                    }
                    values.push(result);
                }
                return values;
            }
            for (i = 1; i <= count; i += 1) {
                if (used >= limit) { truncated = true; break; }
                effect = group.property(i); if (!effect) { continue; }
                used += 1;
                item = { index: i, name: inspectionShort(effect.name), matchName: inspectionShort(effect.matchName), enabled: typeof effect.enabled === "boolean" ? effect.enabled : null, numProperties: Number(effect.numProperties || 0), properties: children(effect, ["ADBE Effect Parade", i], 0) };
                out.push(item);
            }
            return { compId: target.comp.id, layerIndex: target.layer.index, effectCount: count, returnedNodes: used, effects: out, truncated: truncated };
        });
    register("effect.remove", "Remove exactly one applied effect selected by unambiguous instance name or index", true,
        { comp: "optional comp selector", layer: "layer selector", effect: "exact selector: {index:positive integer} or {name:exact instance name}" }, function (a, refs) {
            var names;
            selectors(a, refs, true); exact(a.effect, "index|name", "args.effect"); names = keys(a.effect);
            if (names.length !== 1) { fail("args.effect must select by exactly one field"); }
            if (has(a.effect, "index")) { whole(a.effect.index, "args.effect.index", 1); }
            if (has(a.effect, "name")) { text(a.effect.name, "args.effect.name", 1024); }
        }, function (a, refs, entry) {
            var target = resolved(a, refs, entry, true), group, effect, result;
            if (target.layer.locked) { fail("Layer is locked; unlock it explicitly before removing an effect"); }
            group = inspectionEffects(target.layer); effect = inspectionEffect(group, a.effect);
            if (typeof effect.remove !== "function") { fail("Selected effect cannot be removed"); }
            result = { compId: target.comp.id, layerIndex: target.layer.index, index: effect.propertyIndex, name: inspectionShort(effect.name), matchName: inspectionShort(effect.matchName), removed: true };
            effect.remove(); return result;
        });

    function inspectionFolder(path, create) {
        var folder = new Folder(path);
        if (folder.alias) { fail("Inspection folders must not be aliases: " + path); }
        if (!folder.exists && (!create || !folder.create())) { fail("Inspection folder is unavailable: " + path + "; " + folder.error); }
        return folder;
    }
    function inspectionPng(path) {
        var file = new File(path), bytes, width, height;
        if (!file.exists || file.length < 33 || file.length > 104857600) { fail("Inspection PNG is missing, incomplete or exceeds 100 MiB"); }
        if (file.alias) { fail("Inspection output must not be an alias"); }
        file.encoding = "BINARY";
        if (!file.open("r")) { fail("Cannot read inspection PNG: " + file.error); }
        try { bytes = file.read(33); } finally { file.close(); }
        if (bytes.length !== 33 || bytes.substr(0, 8) !== "\x89PNG\r\n\x1a\n" || bytes.substr(12, 4) !== "IHDR") { fail("Inspection PNG has an invalid signature or IHDR header"); }
        width = bytes.charCodeAt(16) * 16777216 + bytes.charCodeAt(17) * 65536 + bytes.charCodeAt(18) * 256 + bytes.charCodeAt(19);
        height = bytes.charCodeAt(20) * 16777216 + bytes.charCodeAt(21) * 65536 + bytes.charCodeAt(22) * 256 + bytes.charCodeAt(23);
        if (!width || !height || width > 16384 || height > 16384 || width * height > 100000000) { fail("Inspection PNG dimensions exceed technical-review limits"); }
        return { width: width, height: height, bitDepth: bytes.charCodeAt(24), colorType: bytes.charCodeAt(25), byteLength: file.length, pngSignatureValid: true };
    }
    function inspectionAwaitPng(path) {
        var started = new Date().getTime(), file;
        while (new Date().getTime() - started < 5000) {
            file = new File(path);
            if (file.exists && file.length >= 33) { return inspectionPng(path); }
            if (typeof $.sleep !== "function") { break; }
            $.sleep(50);
        }
        fail("After Effects did not publish an inspection PNG within 5000 ms");
    }
    register("inspection.capture", "Export the current frame by default, or up to 3 sampled frames; at most one capture call per request to limit preview rendering; does not save or import project data", false,
        { comp: "optional comp selector", times: "optional 1..3 explicit seconds in valid frame range; cannot combine with numFrames", numFrames: "optional integer 1..3 evenly sampled frames; default captures only the current time" }, function (a, refs) {
            var i;
            selectors(a, refs, false);
            if (has(a, "times") && has(a, "numFrames")) { fail("Use args.times or args.numFrames, not both"); }
            if (has(a, "times")) {
                if (!array(a.times) || !a.times.length || a.times.length > 3) { fail("args.times must contain 1 to 3 numeric times"); }
                for (i = 0; i < a.times.length; i += 1) { number(a.times[i], "args.times[" + i + "]", 0, 10800); }
            }
            optional(a, "numFrames", function (v, p) { whole(v, p, 1, 3); });
        }, function (a, refs, entry) {
            var comp = resolved(a, refs, entry, false).comp, context = entry && entry.context, root, runFolder, relativeRoot, maximumTime, frameDuration, times = [], count, i, time, filename, file, metadata, frames = [], manifest, temporary, destination, published;
            if (!context || context.schema !== "codex-ae-context/v1" || !/^[A-Za-z0-9-]{8,80}$/.test(context.runId || "")) { fail("inspection.capture requires a valid Codex AE Bridge run context"); }
            root = String(context.workspaceRoot || "").replace(/\\/g, "/").replace(/\/$/, "");
            if (!/^(?:[A-Za-z]:\/|\/)/.test(root) || /(?:^|\/)\.{1,2}(?:\/|$)|\x00/.test(root)) { fail("Bridge inspection workspace root must be an absolute path without traversal"); }
            inspectionFolder(root, false);
            if (typeof comp.saveFrameToPng !== "function") { fail("This AE version does not expose CompItem.saveFrameToPng"); }
            number(comp.duration, "composition duration", 0.000001);
            frameDuration = finite(comp.frameDuration) && comp.frameDuration > 0 ? comp.frameDuration : 1 / comp.frameRate;
            number(frameDuration, "composition frame duration", 0.000001);
            maximumTime = Math.max(0, comp.duration - frameDuration);
            if (has(a, "times")) { for (i = 0; i < a.times.length; i += 1) { time = a.times[i]; number(time, "args.times[" + i + "]", 0, maximumTime); times.push(time); } }
            else if (has(a, "numFrames")) {
                count = a.numFrames;
                for (i = 0; i < count; i += 1) { times.push(count === 1 ? 0 : maximumTime * i / (count - 1)); }
            } else { number(comp.time, "composition viewer time"); times.push(Math.max(0, Math.min(comp.time, maximumTime))); }
            if (comp.width > 16384 || comp.height > 16384 || comp.width * comp.height > 100000000) { fail("Composition dimensions exceed inspection technical-review limits"); }
            inspectionFolder(root + "/.ae-codex", true); inspectionFolder(root + "/.ae-codex/inspection", true);
            relativeRoot = ".ae-codex/inspection/" + context.runId;
            runFolder = new Folder(root + "/" + relativeRoot);
            if (runFolder.exists || runFolder.alias) { fail("Inspection output already exists for this run ID; refusing to overwrite"); }
            runFolder = inspectionFolder(root + "/" + relativeRoot, true);
            for (i = 0; i < times.length; i += 1) {
                filename = i === 0 ? "frame.png" : "frame-" + ("00" + (i + 1)).slice(-3) + ".png";
                file = new File(runFolder.fsName + "/" + filename);
                if (file.exists || file.alias) { fail("Inspection frame already exists; refusing to overwrite"); }
                comp.saveFrameToPng(times[i], file); metadata = inspectionAwaitPng(file.fsName);
                metadata.frameRelativePath = relativeRoot + "/" + filename; metadata.timeSeconds = times[i];
                metadata.visualVerified = false; metadata.visualReviewState = "pending"; frames.push(metadata);
                safeNotify(context, "log", ["Captured inspection frame " + (i + 1) + "/" + times.length]);
            }
            manifest = { schema: "codex-ae-inspection/v1", state: "captured", runId: context.runId, frameRelativePath: frames[0].frameRelativePath,
                manifestRelativePath: relativeRoot + "/manifest.json", compositionName: inspectionShort(comp.name), compositionWidth: comp.width, compositionHeight: comp.height,
                frameWidth: frames[0].width, frameHeight: frames[0].height, bitDepth: frames[0].bitDepth, colorType: frames[0].colorType,
                timeSeconds: frames[0].timeSeconds, byteLength: frames[0].byteLength, pngSignatureValid: true, visualVerified: false,
                visualReviewState: "pending", fallbackErrorCode: "", retention: "manual", createdAtEpochMs: new Date().getTime(), frames: frames,
                nextAction: "open_frame_with_view_image" };
            destination = new File(runFolder.fsName + "/manifest.json"); temporary = new File(runFolder.fsName + "/manifest.json.tmp");
            if (destination.exists || temporary.exists || destination.alias || temporary.alias) { fail("Inspection manifest already exists; refusing to overwrite"); }
            temporary.encoding = "UTF-8";
            if (!temporary.open("w")) { fail("Cannot create inspection manifest: " + temporary.error); }
            try { published = temporary.write(stringify(manifest)); if (published === false) { fail("Cannot write inspection manifest: " + temporary.error); } }
            finally { temporary.close(); }
            if (!temporary.rename(destination.name)) { fail("Cannot publish inspection manifest: " + temporary.error); }
            return manifest;
        });
