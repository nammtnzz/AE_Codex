    /* Project/media/render tools. Injected into the reusable registry; ES3 only. */
    var projectToolsRenderApprovals = [];
    function projectToolsType(item) {
        if (isComp(item)) { return "composition"; }
        if (typeof FolderItem !== "undefined" && item instanceof FolderItem) { return "folder"; }
        if (typeof FootageItem !== "undefined" && item instanceof FootageItem) { return "footage"; }
        return "item";
    }
    function projectToolsIsSolid(item) {
        try { return projectToolsType(item) === "footage" && typeof SolidSource !== "undefined" && item.mainSource instanceof SolidSource; }
        catch (ignoreSourceRead) { return false; }
    }
    function projectToolsItemSummary(item) {
        var out = { id: item.id, name: item.name, type: projectToolsType(item) }, fields = ["width", "height", "duration", "frameRate", "numLayers", "numItems"], i, value, file, color;
        if (out.type === "footage") { out.isSolid = projectToolsIsSolid(item); }
        try { if (item.parentFolder && finite(item.parentFolder.id)) { out.parentFolderId = item.parentFolder.id; } } catch (ignoreFolderRead) {}
        for (i = 0; i < fields.length; i += 1) {
            try { value = item[fields[i]]; if (finite(value)) { out[fields[i]] = value; } } catch (ignoreMetadataRead) {}
        }
        try { file = item.file; if (file) { out.path = String(file.fsName || file.fullName); out.file = out.path; } } catch (ignoreFileRead) {}
        if (out.isSolid) {
            try { color = item.mainSource.color; if (array(color) && color.length === 3 && finite(color[0]) && finite(color[1]) && finite(color[2])) { out.color = [color[0], color[1], color[2]]; } } catch (ignoreColorRead) {}
        }
        return out;
    }
    function projectToolsResolveItem(selection, refs) {
        var p = project(), found = null, item, i;
        if (has(selection, "ref")) {
            item = refs[selection.ref];
            if (!item || !finite(item.id)) { fail("Project item reference is unavailable: " + selection.ref); }
            return item;
        }
        for (i = 1; i <= p.numItems; i += 1) {
            item = p.item(i);
            if (item && (has(selection, "id") ? item.id === selection.id : item.name === selection.name)) {
                if (found) { fail("Project item name is ambiguous; use its id: " + selection.name); }
                found = item;
            }
        }
        if (!found) { fail("Project item not found: " + stringify(selection)); }
        return found;
    }
    function projectToolsCheckPrecompCycle(target, source) {
        var queue = [source], seen = {}, cursor = 0, count = 0, current, layer, i;
        while (cursor < queue.length) {
            current = queue[cursor++];
            if (current === target) { fail("Adding this precomp would create an indirect composition cycle"); }
            if (has(seen, "$" + current.id)) { continue; }
            seen["$" + current.id] = true;
            if (cursor > 5000) { fail("Cannot validate a precomp graph larger than 5000 compositions"); }
            for (i = 1; i <= current.numLayers; i += 1) {
                count += 1; if (count > 50000) { fail("Cannot validate a precomp graph larger than 50000 layers"); }
                layer = current.layer(i); if (!layer) { fail("A precomp layer is unavailable while checking for composition cycles"); }
                if (isComp(layer.source)) { queue.push(layer.source); }
            }
        }
    }
    function projectToolsPath(value, label) {
        text(value, label, 4096);
        if (/[\x00-\x1f]/.test(value) || !/^(?:[A-Za-z]:[\\\/]|\\\\|\/)/.test(value)) { fail(label + " must be an absolute file path without control characters"); }
    }
    function projectToolsFile(value, label, needsParent) {
        projectToolsPath(value, label);
        if (typeof File === "undefined") { fail("After Effects File API is unavailable"); }
        var file = new File(value);
        if (needsParent && (!file.parent || !file.parent.exists)) { fail(label + ": destination folder does not exist"); }
        return file;
    }
    function projectToolsPathKey(file) { return String(file.fsName || file.fullName).replace(/\\/g, "/").toLowerCase(); }
    function projectToolsEscapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    function projectToolsOutputsConflict(first, second) {
        var left = projectToolsPathKey(first), right = projectToolsPathKey(second), a, b, prefixA, prefixB, suffixA, suffixB;
        if (left === right) { return true; }
        a = /\[#+\]/.exec(left); b = /\[#+\]/.exec(right);
        if (!a && !b) { return false; }
        if (a && b) {
            prefixA = left.substring(0, a.index); suffixA = left.substring(a.index + a[0].length);
            prefixB = right.substring(0, b.index); suffixB = right.substring(b.index + b[0].length);
            return (prefixA.indexOf(prefixB) === 0 || prefixB.indexOf(prefixA) === 0) &&
                (suffixA.slice(-suffixB.length) === suffixB || suffixB.slice(-suffixA.length) === suffixA);
        }
        if (!a) { a = b; b = left; left = right; right = b; }
        return new RegExp("^" + projectToolsEscapeRegex(left.substring(0, a.index)) + "[0-9]+" + projectToolsEscapeRegex(left.substring(a.index + a[0].length)) + "$").test(right);
    }
    function projectToolsOutputExists(file) {
        var match, prefix, suffix, pattern, candidates, i, expression;
        if (file.exists) { return true; }
        match = /\[#+\]/.exec(String(file.name || ""));
        if (!match) { return false; }
        prefix = file.name.substring(0, match.index); suffix = file.name.substring(match.index + match[0].length);
        pattern = prefix + "*" + suffix;
        if (!file.parent || typeof file.parent.getFiles !== "function") { fail("Cannot inspect existing output sequence files"); }
        candidates = file.parent.getFiles(pattern);
        expression = new RegExp("^" + projectToolsEscapeRegex(prefix) + "[0-9]+" + projectToolsEscapeRegex(suffix) + "$", "i");
        for (i = 0; i < candidates.length; i += 1) { if (expression.test(String(candidates[i].name || ""))) { return true; } }
        return false;
    }
    function projectToolsStatus(value) {
        var names = ["WILL_CONTINUE", "NEEDS_OUTPUT", "UNQUEUED", "QUEUED", "RENDERING", "USER_STOPPED", "ERR_STOPPED", "DONE"], i;
        if (typeof RQItemStatus !== "undefined") {
            for (i = 0; i < names.length; i += 1) { if (typeof RQItemStatus[names[i]] !== "undefined" && value === RQItemStatus[names[i]]) { return names[i]; } }
        }
        return "UNKNOWN:" + String(value);
    }
    function projectToolsQueue() {
        var queue = project().renderQueue;
        if (!queue || !queue.items || typeof queue.items.add !== "function") { fail("The After Effects render queue is unavailable"); }
        if (queue.rendering) { fail("The render queue is already rendering"); }
        return queue;
    }
    function projectToolsQueueIndex(queue, item) {
        var i;
        for (i = 1; i <= queue.numItems; i += 1) { if (queue.item(i) === item) { return i; } }
        fail("The render queue item is no longer present");
    }
    function projectToolsTemplate(templates, name, label) {
        var i;
        if (!templates || typeof templates.length !== "number") { fail(label + " template inventory is unavailable"); }
        for (i = 0; i < templates.length; i += 1) { if (templates[i] === name) { return; } }
        fail(label + " template is not installed: " + name);
    }
    function projectToolsCheckQueueDestination(queue, file) {
        var i, j, item, output;
        if (queue.numItems >= 1000) { fail("Render queue reached the supported 1000-item inspection bound"); }
        for (i = 1; i <= queue.numItems; i += 1) {
            item = queue.item(i);
            if (!item || !item.render || projectToolsStatus(item.status) !== "QUEUED") { continue; }
            if (!integer(item.numOutputModules) || item.numOutputModules > 100) { fail("Cannot inspect an invalid output-module count in queue item " + i); }
            for (j = 1; j <= item.numOutputModules; j += 1) {
                output = item.outputModule(j);
                if (output && output.file && projectToolsOutputsConflict(output.file, file)) { fail("Render destination conflicts with an enabled queued output at item " + i + ", module " + j); }
            }
        }
    }
    function projectToolsApproved(item, file) {
        var i;
        for (i = 0; i < projectToolsRenderApprovals.length; i += 1) {
            if (projectToolsRenderApprovals[i].item === item && projectToolsRenderApprovals[i].path === projectToolsPathKey(file)) { return projectToolsRenderApprovals[i].overwrite; }
        }
        return false;
    }

    register("project.search", "Find project items by name and type without changing the project", false,
        { query: "name substring; empty lists all", type: "optional all, composition, footage, solid or folder; footage includes solids", maxItems: "optional integer 1..5000; default 100" }, function (a) {
            text(a.query, "args.query", 1024, true);
            optional(a, "type", function (v, p) { if (v !== "all" && v !== "composition" && v !== "footage" && v !== "solid" && v !== "folder") { fail(p + " must be all, composition, footage, solid or folder"); } });
            optional(a, "maxItems", function (v, p) { whole(v, p, 1, 5000); });
        }, function (a) {
            var p = project(), query = a.query.toLowerCase(), kind = a.type || "all", limit = a.maxItems || 100, items = [], matched = 0, i, item;
            for (i = 1; i <= p.numItems; i += 1) {
                item = p.item(i);
                if (item && String(item.name).toLowerCase().indexOf(query) >= 0 && (kind === "all" || (kind === "solid" ? projectToolsIsSolid(item) : projectToolsType(item) === kind))) {
                    matched += 1; if (items.length < limit) { items.push(projectToolsItemSummary(item)); }
                }
            }
            return { numItems: p.numItems, totalMatches: matched, items: items, truncated: matched > items.length };
        });
    register("comp.hierarchy", "Read composition, layer parents and nested precomp links with bounded traversal", false,
        { comp: "optional composition selector", maxLayers: "optional total layer limit 1..5000; default 1000" }, function (a, refs) {
            selectors(a, refs, false); optional(a, "maxLayers", function (v, p) { whole(v, p, 1, 5000); });
        }, function (a, refs, entry) {
            var rootComp = resolved(a, refs, entry, false).comp, queue = [rootComp], seen = {}, compositions = [], limit = a.maxLayers || 1000;
            var cursor = 0, count = 0, truncated = false, comp, node, i, layer, info, source;
            seen["$" + rootComp.id] = true;
            while (cursor < queue.length && count < limit) {
                comp = queue[cursor++]; node = { id: comp.id, name: comp.name, numLayers: comp.numLayers, layers: [] };
                for (i = 1; i <= comp.numLayers; i += 1) {
                    if (count >= limit) { truncated = true; break; }
                    layer = comp.layer(i); if (!layer) { fail("Layer is unavailable in composition " + comp.id + " at index " + i); }
                    info = { index: layer.index, name: layer.name, parentIndex: layer.parent ? layer.parent.index : null };
                    if (finite(layer.id)) { info.id = layer.id; }
                    source = layer.source;
                    if (source && finite(source.id)) {
                        info.source = { id: source.id, name: source.name, precomp: !!isComp(source) };
                        if (isComp(source) && !has(seen, "$" + source.id)) { seen["$" + source.id] = true; queue.push(source); }
                    }
                    node.layers.push(info); count += 1;
                }
                compositions.push(node);
            }
            if (cursor < queue.length) { truncated = true; }
            return { rootCompId: rootComp.id, compositions: compositions, layersRead: count, truncated: truncated };
        });
    register("media.import", "Import existing media or an .aep/.aepx project as a folder into the open project", true,
        { path: "absolute source file path", sequence: "optional boolean; default false", forceAlphabetical: "optional boolean; requires sequence:true" }, function (a) {
            projectToolsPath(a.path, "args.path"); optional(a, "sequence", boolValue); optional(a, "forceAlphabetical", boolValue);
            if (a.forceAlphabetical && a.sequence !== true) { fail("forceAlphabetical requires sequence:true"); }
            if (/\.aepx?$/i.test(a.path) && (a.sequence || a.forceAlphabetical)) { fail("Project import does not support sequence flags"); }
        }, function (a) {
            var p = project(), file = projectToolsFile(a.path, "args.path", false), settings, item, importingProject = /\.aepx?$/i.test(a.path), importType;
            if (!file.exists) { fail("Media file does not exist: " + a.path); }
            if (typeof ImportOptions === "undefined" || typeof p.importFile !== "function") { fail("After Effects media import API is unavailable"); }
            if (importingProject && p.file && projectToolsPathKey(file) === projectToolsPathKey(p.file)) { fail("Cannot import the current project into itself"); }
            settings = new ImportOptions(file);
            if (importingProject && (typeof ImportAsType === "undefined" || typeof ImportAsType.PROJECT === "undefined" || typeof settings.canImportAs !== "function")) { fail("After Effects project import API is unavailable"); }
            if (typeof ImportAsType !== "undefined" && typeof settings.canImportAs === "function") {
                importType = importingProject ? ImportAsType.PROJECT : ImportAsType.FOOTAGE;
                if (!settings.canImportAs(importType)) { fail("The selected file cannot be imported as " + (importingProject ? "a project" : "footage")); }
                settings.importAs = importType;
            }
            settings.sequence = a.sequence === true;
            if (has(a, "forceAlphabetical")) { settings.forceAlphabetical = a.forceAlphabetical; }
            item = p.importFile(settings);
            if (!item || !finite(item.id)) { fail("After Effects did not return an imported project item"); }
            return { value: projectToolsItemSummary(item), reference: item };
        }, "item");
    register("layer.media.add", "Add an installed project footage item or precomp as a layer", true,
        { comp: "optional composition selector", item: "project item selector {id|name|ref}", name: "optional layer name", startTime: "optional seconds", inPoint: "optional seconds; supply with outPoint", outPoint: "optional seconds; supply with inPoint" }, function (a, refs) {
            selectors(a, refs, false); selector(a.item, "args.item", "item", refs);
            optional(a, "name", function (v, p) { text(v, p, 1024); });
            optional(a, "startTime", function (v, p) { number(v, p, -10800, 10800); });
            optional(a, "inPoint", function (v, p) { number(v, p, -10800, 10800); });
            optional(a, "outPoint", function (v, p) { number(v, p, -10800, 10800); });
            if (has(a, "inPoint") !== has(a, "outPoint") || (has(a, "inPoint") && a.inPoint >= a.outPoint)) { fail("Supply inPoint and outPoint together, with inPoint < outPoint"); }
        }, function (a, refs, entry) {
            var comp = resolved(a, refs, entry, false).comp, item = projectToolsResolveItem(a.item, refs), layer;
            if (projectToolsType(item) !== "footage" && !isComp(item)) { fail("Only footage or a composition can be added as a media layer"); }
            if (item === comp) { fail("A composition cannot contain itself"); }
            if (isComp(item)) { projectToolsCheckPrecompCycle(comp, item); }
            if (!comp.layers || typeof comp.layers.add !== "function") { fail("Composition media-layer API is unavailable"); }
            layer = comp.layers.add(item);
            if (has(a, "name")) { layer.name = a.name; }
            if (has(a, "startTime")) { layer.startTime = a.startTime; }
            if (has(a, "inPoint")) { layer.inPoint = a.inPoint; layer.outPoint = a.outPoint; }
            return { value: layerSummary(layer), reference: layer };
        }, "layer");
    register("project.save", "Save the current project or an explicit destination; replacing another file requires overwrite:true", true,
        { path: "optional absolute .aep or .aepx path; omit to save the current project file", overwrite: "optional boolean; default false for a different existing destination" }, function (a) {
            optional(a, "path", projectToolsPath); optional(a, "overwrite", boolValue);
            if (has(a, "path") && !/\.aepx?$/i.test(a.path)) { fail("Project destination must end in .aep or .aepx"); }
        }, function (a) {
            var p = project(), destination = has(a, "path") ? projectToolsFile(a.path, "args.path", true) : p.file, current = p.file;
            if (!destination) { fail("The unsaved project requires an explicit args.path; no save dialog was opened"); }
            if (!destination.parent || !destination.parent.exists) { fail("Project destination folder does not exist"); }
            if (destination.exists && (!current || projectToolsPathKey(destination) !== projectToolsPathKey(current)) && a.overwrite !== true) { fail("Project destination already exists; set overwrite:true to replace it"); }
            if (typeof p.save !== "function") { fail("After Effects project save API is unavailable"); }
            if (has(a, "path")) { p.save(destination); } else { p.save(); }
            if (!p.file || !p.file.exists || projectToolsPathKey(p.file) !== projectToolsPathKey(destination)) { fail("After Effects did not confirm the requested project destination"); }
            return { saved: true, path: String(p.file.fsName || p.file.fullName) };
        }, "", { undo: false, exclusive: true });
    register("project.undo", "Request one native After Effects Undo command; call this tool by itself", true, {}, function () {}, function () {
        project(); if (typeof app.executeCommand !== "function") { fail("The After Effects menu-command API is unavailable"); }
        app.executeCommand(16);
        return { undoRequested: true, commandId: 16, verification: "native-command-dispatched" };
    }, "", { undo: false, exclusive: true });
    register("render.queue.add", "Queue one composition at an explicit output path using exact installed template names", true,
        { comp: "optional composition selector", outputPath: "absolute output path; existing files require overwrite:true", renderTemplate: "optional exact render-settings template name", outputTemplate: "optional exact output-module template name", overwrite: "optional boolean; default false" }, function (a, refs) {
            selectors(a, refs, false); projectToolsPath(a.outputPath, "args.outputPath");
            optional(a, "renderTemplate", function (v, p) { text(v, p, 1024); }); optional(a, "outputTemplate", function (v, p) { text(v, p, 1024); }); optional(a, "overwrite", boolValue);
        }, function (a, refs, entry) {
            var queue = projectToolsQueue(), comp = resolved(a, refs, entry, false).comp;
            var file = projectToolsFile(a.outputPath, "args.outputPath", true), item = null, output, actual, errorText;
            if (projectToolsOutputExists(file) && a.overwrite !== true) { fail("Render output already exists; set overwrite:true to replace it"); }
            projectToolsCheckQueueDestination(queue, file);
            try {
                item = queue.items.add(comp); if (!item) { fail("After Effects did not create a render-queue item"); }
                if (has(a, "renderTemplate")) { projectToolsTemplate(item.templates, a.renderTemplate, "Render settings"); item.applyTemplate(a.renderTemplate); }
                output = item.outputModule(1); if (!output) { fail("Render queue item has no output module"); }
                if (has(a, "outputTemplate")) { projectToolsTemplate(output.templates, a.outputTemplate, "Output module"); output.applyTemplate(a.outputTemplate); }
                output.file = file; actual = output.file;
                if (!actual || projectToolsPathKey(actual) !== projectToolsPathKey(file)) { fail("The output template changed the requested destination; specify its exact output path"); }
                if (projectToolsOutputExists(actual) && a.overwrite !== true) { fail("Render output already exists; set overwrite:true to replace it"); }
                item.render = true;
                projectToolsRenderApprovals.push({ item: item, path: projectToolsPathKey(actual), overwrite: a.overwrite === true });
                if (projectToolsRenderApprovals.length > 1000) { projectToolsRenderApprovals.shift(); }
                return { queueIndex: projectToolsQueueIndex(queue, item), comp: { id: comp.id, name: comp.name }, outputPath: String(actual.fsName || actual.fullName), status: projectToolsStatus(item.status),
                    renderTemplate: has(a, "renderTemplate") ? a.renderTemplate : null, outputTemplate: has(a, "outputTemplate") ? a.outputTemplate : null, overwriteAuthorized: a.overwrite === true };
            } catch (error) {
                errorText = String(error.message || error);
                if (item && typeof item.remove === "function") { try { item.remove(); } catch (cleanupError) { errorText += "; failed to remove the newly created queue item: " + String(cleanupError.message || cleanupError); } }
                fail(errorText);
            }
        });
    register("render.start", "Render the enabled queued items once and report their native final states; call this tool by itself", true, {}, function () {}, function () {
        var queue = projectToolsQueue(), selected = [], destinations = [], i, j, k, item, output, file, started, states = [], complete = true, renderError = null;
        if (typeof queue.render !== "function" || typeof RQItemStatus === "undefined") { fail("The native render API/status enumeration is unavailable"); }
        if (queue.numItems > 1000) { fail("Render queue exceeds the supported 1000-item inspection bound"); }
        for (i = 1; i <= queue.numItems; i += 1) {
            item = queue.item(i); if (!item || !item.render) { continue; }
            if (projectToolsStatus(item.status) !== "QUEUED") { fail("Enabled queue item " + i + " is not ready: " + projectToolsStatus(item.status)); }
            if (!isComp(item.comp)) { fail("Queue item " + i + " has no valid composition"); }
            if (!integer(item.numOutputModules) || item.numOutputModules < 1 || item.numOutputModules > 100) { fail("Queue item " + i + " has an invalid output-module count"); }
            for (j = 1; j <= item.numOutputModules; j += 1) {
                output = item.outputModule(j); file = output && output.file;
                if (!file || !file.parent || !file.parent.exists) { fail("Queue item " + i + " output " + j + " needs an existing destination folder"); }
                if (projectToolsOutputExists(file) && !projectToolsApproved(item, file)) { fail("Queue item " + i + " output exists without overwrite authorization; queue it explicitly with overwrite:true"); }
                for (k = 0; k < destinations.length; k += 1) {
                    if (projectToolsOutputsConflict(destinations[k].file, file)) { fail("Render destinations conflict between queue item " + destinations[k].queueIndex + " output " + destinations[k].moduleIndex + " and item " + i + " output " + j); }
                }
                destinations.push({ file: file, queueIndex: i, moduleIndex: j });
            }
            selected.push(item);
        }
        if (!selected.length) { fail("There are no enabled queued items to render"); }
        started = new Date().getTime();
        try { queue.render(); } catch (error) { renderError = String(error.message || error); }
        for (i = 0; i < selected.length; i += 1) {
            item = selected[i]; states.push({ queueIndex: projectToolsQueueIndex(queue, item), compId: item.comp.id, status: projectToolsStatus(item.status) });
            if (projectToolsStatus(item.status) !== "DONE") { complete = false; }
        }
        if (renderError || queue.rendering || !complete) { fail("Render did not complete all selected queue items" + (renderError ? ": " + renderError : "") + "; native final states: " + stringify(states)); }
        return { completed: true, elapsedMilliseconds: new Date().getTime() - started, items: states };
    }, "", { undo: false, exclusive: true });
