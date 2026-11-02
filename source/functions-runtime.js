/* Reusable ES3 tools. Requests are JSON data, never evaluated as source code. */
(function () {
    var VERSION = "1.0.0", SCHEMA = "codex-ae-functions/v1";
    var own = Object.prototype.hasOwnProperty;
    var MAX_TEXT = 1048576, MAX_DEPTH = 32, MAX_NODES = 50000;
    var definitions = {}, order = [];
    function has(object, key) { return own.call(object, key); }
    function fail(message) { throw new Error(message); }
    function forbidden(key) { return key === "__proto__" || key === "prototype" || key === "constructor"; }
    function array(value) { return Object.prototype.toString.call(value) === "[object Array]"; }
    function object(value) { return value !== null && typeof value === "object" && !array(value); }
    function finite(value) { return typeof value === "number" && isFinite(value); }
    function integer(value) { return finite(value) && Math.floor(value) === value; }
    function keys(value) { var out = [], key; for (key in value) { if (has(value, key)) { out.push(key); } } return out; }
    function exact(value, allowed, path) {
        var i, names;
        if (!object(value)) { fail(path + " must be an object"); }
        names = keys(value);
        for (i = 0; i < names.length; i += 1) {
            if (forbidden(names[i]) || ("|" + allowed + "|").indexOf("|" + names[i] + "|") < 0) { fail(path + ": unsupported field " + names[i]); }
        }
    }
    function text(value, path, maximum, empty) {
        if (typeof value !== "string" || (!empty && !value.length) || value.length > (maximum || 1024)) { fail(path + " must be a " + (empty ? "" : "nonempty ") + "string of at most " + (maximum || 1024) + " characters"); }
    }
    function number(value, path, minimum, maximum) {
        if (!finite(value) || (typeof minimum === "number" && value < minimum) || (typeof maximum === "number" && value > maximum)) { fail(path + " must be a finite number" + (typeof minimum === "number" ? " >= " + minimum : "") + (typeof maximum === "number" ? " <= " + maximum : "")); }
    }
    function whole(value, path, minimum, maximum) { number(value, path, minimum, maximum); if (!integer(value)) { fail(path + " must be an integer"); } }
    function boolValue(value, path) { if (typeof value !== "boolean") { fail(path + " must be boolean"); } }
    function vector(value, path, minimumLength, maximumLength, minimum, maximum) {
        var i;
        if (!array(value) || value.length < minimumLength || value.length > maximumLength) { fail(path + " has invalid vector dimensions"); }
        for (i = 0; i < value.length; i += 1) { number(value[i], path + "[" + i + "]", minimum, maximum); }
    }
    function optional(args, name, check) { if (has(args, name)) { check(args[name], "args." + name); } }
    function valueData(value, path) {
        var i;
        if (typeof value === "string") { text(value, path, 262144, true); }
        else if (typeof value === "boolean") { return; }
        else if (finite(value)) { return; }
        else if (array(value) && value.length <= 16) { for (i = 0; i < value.length; i += 1) { number(value[i], path + "[" + i + "]"); } }
        else { fail(path + " must be a number, string, boolean or numeric vector"); }
    }

    function parse(input) {
        var cursor = 0, nodes = 0, length;
        if (typeof input !== "string" || input.length > MAX_TEXT) { fail("Request text must be at most " + MAX_TEXT + " characters"); }
        length = input.length;
        function whitespace() { while (cursor < length && /[\x20\t\r\n]/.test(input.charAt(cursor))) { cursor += 1; } }
        function string() {
            var out = [], character, code;
            cursor += 1;
            while (cursor < length) {
                character = input.charAt(cursor++);
                if (character === '"') { return out.join(""); }
                if (character === "\\") {
                    character = input.charAt(cursor++);
                    if (character === '"' || character === "/" || character === "\\") { out.push(character); }
                    else if (character === "b") { out.push("\b"); }
                    else if (character === "f") { out.push("\f"); }
                    else if (character === "n") { out.push("\n"); }
                    else if (character === "r") { out.push("\r"); }
                    else if (character === "t") { out.push("\t"); }
                    else if (character === "u") {
                        code = input.substr(cursor, 4);
                        if (!/^[a-fA-F0-9]{4}$/.test(code)) { fail("Invalid JSON Unicode escape at " + cursor); }
                        out.push(String.fromCharCode(parseInt(code, 16))); cursor += 4;
                    } else { fail("Invalid JSON escape at " + cursor); }
                } else {
                    if (character.charCodeAt(0) < 32) { fail("Invalid JSON string character at " + cursor); }
                    out.push(character);
                }
            }
            fail("Unterminated JSON string");
        }
        function read(depth) {
            var result, seen, key, character, match;
            nodes += 1;
            if (depth > MAX_DEPTH || nodes > MAX_NODES) { fail("JSON complexity limit exceeded"); }
            whitespace(); character = input.charAt(cursor);
            if (character === '"') { return string(); }
            if (character === "{") {
                result = {}; seen = {}; cursor += 1; whitespace();
                if (input.charAt(cursor) === "}") { cursor += 1; return result; }
                while (cursor < length) {
                    whitespace(); if (input.charAt(cursor) !== '"') { fail("Expected JSON object key at " + cursor); }
                    key = string();
                    if (forbidden(key) || has(seen, key)) { fail("Forbidden or duplicate JSON key: " + key); }
                    seen[key] = true; whitespace();
                    if (input.charAt(cursor++) !== ":") { fail("Expected JSON colon at " + cursor); }
                    result[key] = read(depth + 1); whitespace(); character = input.charAt(cursor++);
                    if (character === "}") { return result; }
                    if (character !== ",") { fail("Expected JSON comma at " + cursor); }
                }
                fail("Unterminated JSON object");
            }
            if (character === "[") {
                result = []; cursor += 1; whitespace();
                if (input.charAt(cursor) === "]") { cursor += 1; return result; }
                while (cursor < length) {
                    result.push(read(depth + 1)); whitespace(); character = input.charAt(cursor++);
                    if (character === "]") { return result; }
                    if (character !== ",") { fail("Expected JSON array comma at " + cursor); }
                }
                fail("Unterminated JSON array");
            }
            if (input.substr(cursor, 4) === "true") { cursor += 4; return true; }
            if (input.substr(cursor, 5) === "false") { cursor += 5; return false; }
            if (input.substr(cursor, 4) === "null") { cursor += 4; return null; }
            match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.substring(cursor));
            if (match) {
                cursor += match[0].length; result = Number(match[0]);
                if (!isFinite(result)) { fail("JSON number is not finite"); }
                return result;
            }
            fail("Invalid JSON value at " + cursor);
        }
        var result = read(0);
        whitespace(); if (cursor !== length) { fail("Unexpected JSON content at " + cursor); }
        return result;
    }
    function stringify(value) {
        var nodes = 0, stack = [];
        function quote(input) {
            return '"' + input.replace(/["\\\x00-\x1f\u2028\u2029]/g, function (character) {
                var code = character.charCodeAt(0).toString(16);
                if (character === '"') { return '\\"'; }
                if (character === "\\") { return "\\\\"; }
                return "\\u" + ("0000" + code).slice(-4);
            }) + '"';
        }
        function write(input, depth) {
            var i, names, out = [], result;
            nodes += 1;
            if (depth > MAX_DEPTH || nodes > MAX_NODES) { fail("JSON result complexity limit exceeded"); }
            if (input === null) { return "null"; }
            if (typeof input === "string") { return quote(input); }
            if (typeof input === "boolean") { return input ? "true" : "false"; }
            if (typeof input === "number") { if (!isFinite(input)) { fail("Cannot serialize a nonfinite number"); } return String(input); }
            if (typeof input !== "object") { fail("Cannot serialize a non-data value"); }
            for (i = 0; i < stack.length; i += 1) { if (stack[i] === input) { fail("Cannot serialize a circular value"); } }
            stack.push(input);
            if (array(input)) {
                for (i = 0; i < input.length; i += 1) { out.push(write(input[i], depth + 1)); }
                result = "[" + out.join(",") + "]";
            } else {
                names = keys(input);
                for (i = 0; i < names.length; i += 1) {
                    if (forbidden(names[i])) { fail("Cannot serialize prototype key: " + names[i]); }
                    out.push(quote(names[i]) + ":" + write(input[names[i]], depth + 1));
                }
                result = "{" + out.join(",") + "}";
            }
            stack.pop(); return result;
        }
        return write(value, 0);
    }
    function selector(value, path, kind, refs) {
        var names;
        exact(value, kind === "comp" || kind === "item" ? "id|name|ref" : "index|name|ref", path);
        names = keys(value);
        if (names.length !== 1) { fail(path + " must select by exactly one field"); }
        if (has(value, "name")) { text(value.name, path + ".name", 1024); }
        if (has(value, "id")) { whole(value.id, path + ".id", 1); }
        if (has(value, "index")) { whole(value.index, path + ".index", 1); }
        if (has(value, "ref")) {
            text(value.ref, path + ".ref", 64);
            if (!has(refs, value.ref) || (refs[value.ref] !== kind && !(kind === "item" && refs[value.ref] === "comp"))) { fail(path + ": ref must name an earlier " + kind + " result: " + value.ref); }
        }
    }
    function selectors(args, refs, needsLayer) {
        if (has(args, "comp")) { selector(args.comp, "args.comp", "comp", refs); }
        if (needsLayer) { selector(args.layer, "args.layer", "layer", refs); }
    }
    function propertyPath(value, path) {
        var i;
        if (!array(value) || !value.length || value.length > 32) { fail(path + " must contain 1 to 32 property names/indices"); }
        for (i = 0; i < value.length; i += 1) {
            if (typeof value[i] === "string") { text(value[i], path + "[" + i + "]", 1024); }
            else { whole(value[i], path + "[" + i + "]", 1); }
        }
    }
    function register(name, description, mutates, fields, validateArgs, execute, resultKind, options) {
        if (has(definitions, name)) { fail("Duplicate installed function: " + name); }
        definitions[name] = { name: name, description: description, mutates: mutates, args: fields, check: validateArgs, execute: execute, resultKind: resultKind || "", options: options || {} };
        order.push(name);
    }
    function project() { if (typeof app === "undefined" || !app.project) { fail("After Effects has no open project"); } return app.project; }
    function isComp(item) { return item && typeof CompItem !== "undefined" && item instanceof CompItem; }
    function resolveComp(args, refs) {
        var p = project(), selection = args.comp, item, found = null, i;
        if (!selection) { if (!isComp(p.activeItem)) { fail("The active item must be a composition, or supply args.comp"); } return p.activeItem; }
        if (has(selection, "ref")) { item = refs[selection.ref]; if (!isComp(item)) { fail("Composition reference is unavailable: " + selection.ref); } return item; }
        for (i = 1; i <= p.numItems; i += 1) {
            item = p.item(i);
            if (isComp(item) && (has(selection, "id") ? item.id === selection.id : item.name === selection.name)) {
                if (found) { fail("Composition name is ambiguous; use its id: " + selection.name); } found = item;
            }
        }
        if (!found) { fail("Composition not found: " + stringify(selection)); }
        return found;
    }
    function resolveLayer(comp, selection, refs) {
        var item, found = null, i;
        if (has(selection, "ref")) {
            item = refs[selection.ref];
            if (!item || item.containingComp !== comp) { fail("Layer reference does not belong to the selected composition: " + selection.ref); }
            return item;
        }
        if (has(selection, "index")) {
            if (selection.index > comp.numLayers) { fail("Layer index does not exist: " + selection.index); }
            item = comp.layer(selection.index); if (!item) { fail("Layer does not exist"); } return item;
        }
        for (i = 1; i <= comp.numLayers; i += 1) {
            item = comp.layer(i);
            if (item && item.name === selection.name) { if (found) { fail("Layer name is ambiguous; use its index: " + selection.name); } found = item; }
        }
        if (!found) { fail("Layer not found: " + selection.name); }
        return found;
    }
    function resolveProperty(layer, path) {
        var current = layer, i;
        for (i = 0; i < path.length; i += 1) {
            if (!current || typeof current.property !== "function") { fail("Property path cannot be traversed at " + path[i]); }
            current = current.property(path[i]);
            if (!current) { fail("Property not found: " + path.slice(0, i + 1).join(" / ")); }
        }
        return current;
    }
    function compSummary(comp) {
        var result = { id: comp.id, name: comp.name, width: comp.width, height: comp.height, pixelAspect: comp.pixelAspect, duration: comp.duration, frameRate: comp.frameRate, numLayers: comp.numLayers, time: comp.time };
        if (array(comp.bgColor)) { result.bgColor = dataValue(comp.bgColor); }
        return result;
    }
    function layerSummary(layer) {
        var result = { index: layer.index, name: layer.name, compId: layer.containingComp.id, enabled: !!layer.enabled, locked: !!layer.locked, startTime: layer.startTime, inPoint: layer.inPoint, outPoint: layer.outPoint, parent: layer.parent ? layer.parent.index : null };
        var flags = ["solo", "shy", "adjustmentLayer", "nullLayer", "guideLayer", "hasVideo", "hasAudio"], i;
        if (typeof layer.id === "number") { result.id = layer.id; }
        if (typeof layer.threeDLayer === "boolean") { result.threeDLayer = layer.threeDLayer; }
        for (i = 0; i < flags.length; i += 1) { if (typeof layer[flags[i]] === "boolean") { result[flags[i]] = layer[flags[i]]; } }
        if ((typeof TextLayer !== "undefined" && layer instanceof TextLayer) || layer.matchName === "ADBE Text Layer") { result.type = "text"; }
        else if ((typeof ShapeLayer !== "undefined" && layer instanceof ShapeLayer) || layer.matchName === "ADBE Vector Layer") { result.type = "shape"; }
        else if ((typeof CameraLayer !== "undefined" && layer instanceof CameraLayer) || layer.matchName === "ADBE Camera Layer") { result.type = "camera"; }
        else if ((typeof LightLayer !== "undefined" && layer instanceof LightLayer) || layer.matchName === "ADBE Light Layer") { result.type = "light"; }
        else if (layer.nullLayer) { result.type = "null"; }
        else if (layer.adjustmentLayer) { result.type = "adjustment"; }
        else { result.type = "av"; }
        try { if (typeof layer.blendingMode !== "undefined") { result.blendingMode = String(layer.blendingMode); } } catch (blendReadError) {}
        if (layer.source) { result.source = { id: layer.source.id, name: layer.source.name }; }
        return result;
    }
    function dataValue(value, depth) {
        var i, out;
        depth = depth || 0;
        if (depth > 16) { fail("Property value nesting limit exceeded"); }
        if (value === null || typeof value === "string" || typeof value === "boolean" || finite(value)) { return value; }
        if (array(value)) { out = []; for (i = 0; i < value.length; i += 1) { out.push(dataValue(value[i], depth + 1)); } return out; }
        if (value && typeof value.text === "string") {
            out = { text: value.text };
            if (typeof value.font === "string") { out.font = value.font; }
            if (finite(value.fontSize)) { out.fontSize = value.fontSize; }
            return out;
        }
        if (value && value.vertices && value.inTangents && value.outTangents) { return { vertices: dataValue(value.vertices, depth + 1), inTangents: dataValue(value.inTangents, depth + 1), outTangents: dataValue(value.outTangents, depth + 1), closed: !!value.closed }; }
        return { unsupported: true, description: String(value).substr(0, 1024) };
    }
    function writeValue(property, value, time) {
        if (!property || typeof property.setValue !== "function") { fail("Selected property cannot be assigned a value"); }
        if (typeof value === "string" && property.value && typeof property.value.text === "string") {
            var document = property.value; document.text = value; value = document;
        }
        if (typeof time === "number") {
            if (!property.canVaryOverTime || typeof property.setValueAtTime !== "function") { fail("Selected property cannot be keyframed"); }
            property.setValueAtTime(time, value);
        } else {
            if (property.numKeys > 0) { fail("Property has keyframes; supply args.time or use property.keyframes"); }
            property.setValue(value);
        }
    }
    function resolved(args, refs, entry, needsLayer) {
        var comp = entry && entry.comp ? entry.comp : resolveComp(args, refs);
        return { comp: comp, layer: needsLayer ? (entry && entry.layer ? entry.layer : resolveLayer(comp, args.layer, refs)) : null };
    }
    function checkLayerUpdate(layer, args) {
        var names, i, name, property, dimensions, threeD = has(args, "threeDLayer") ? args.threeDLayer : !!layer.threeDLayer;
        if (layer.locked && args.locked !== false) { fail("Layer is locked; explicitly set locked:false before editing it"); }
        if (!args.transform) { return; }
        names = keys(args.transform);
        for (i = 0; i < names.length; i += 1) {
            name = names[i];
            if (name === "xRotation" || name === "yRotation") { if (!threeD) { fail(name + " requires a 3D layer"); } if (args.threeDLayer === true) { continue; } }
            property = resolveProperty(layer, ["ADBE Transform Group", transformNames[name]]);
            if (property.numKeys > 0) { fail("Transform has keyframes; use property.set with time or property.keyframes"); }
            if (name === "position" || name === "anchorPoint" || name === "scale") {
                dimensions = has(args, "threeDLayer") ? (threeD ? 3 : 2) : (array(property.value) ? property.value.length : 0);
                if (dimensions && args.transform[name].length !== dimensions) { fail("Transform " + name + " requires " + dimensions + " dimensions for this layer"); }
            }
        }
    }
    function list(includeLegacy) {
        var out = [], i, definition, bundle = $.global.__codexAeBundleV1, names;
        for (i = 0; i < order.length; i += 1) {
            definition = definitions[order[i]];
            if (definition.name === "script.run" && includeLegacy !== true) { continue; }
            out.push({ name: definition.name, description: definition.description, mutates: definition.mutates, args: definition.args, inputSchema: inputSchema(definition), resultRef: definition.resultKind || null, internal: definition.name === "script.run", exclusive: !!definition.options.exclusive });
        }
        if (includeLegacy === true && bundle && bundle.names) {
            names = bundle.names;
            for (i = 0; i < names.length; i += 1) { out.push({ name: "script.run", branch: names[i], description: "Preserved installed branch; requires its original project and authorization prerequisites", mutates: true, legacy: true, args: { branch: names[i] }, inputSchema: { type: "object", properties: { branch: { type: "string", "enum": [names[i]] } }, required: ["branch"], additionalProperties: false } }); }
        }
        return out;
    }
    function selectorSchema(kind) {
        var byId = kind === "comp" || kind === "item";
        var options = [{ type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["name"], additionalProperties: false }, { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 } }, required: ["ref"], additionalProperties: false }], numeric = { type: "object", properties: {}, required: [byId ? "id" : "index"], additionalProperties: false };
        numeric.properties[byId ? "id" : "index"] = { type: "integer", minimum: 1 }; options.push(numeric); return { oneOf: options };
    }
    function inputSchema(definition) {
        if (definition.options.nativeInputSchema) { return parse(stringify(definition.options.nativeInputSchema)); }
        var requiredFields = { "comp.rebuildMedia": "name", "comp.create": "name", "comp.seek": "time", "layer.inspect": "layer", "layer.text.create": "text", "layer.solid.create": "color", "layer.duplicate": "layer", "layer.update": "layer", "layer.parent": "layer|parent", "property.list": "layer", "property.get": "layer|path", "property.set": "layer|path|value", "property.keyframes": "layer|path|keys", "property.expression": "layer|path|expression", "effect.add": "layer|matchName", "layer.shape.create": "shape", "script.run": "branch" };
        var result = { type: "object", properties: {}, required: requiredFields[definition.name] ? requiredFields[definition.name].split("|") : [], additionalProperties: false }, names = keys(definition.args), i, name, schema;
        var numeric = "|width|height|pixelAspect|duration|frameRate|sampleRate|resumeCompId|workAreaStart|workAreaDuration|displayStartTime|fontSize|startTime|inPoint|outPoint|label|time|roundness|strokeWidth|maxItems|maxLayers|maxProperties|";
        var bools = "|includeLegacy|includeLayers|applyFill|enabled|shy|locked|solo|threeDLayer|guideLayer|adjustmentLayer|preserveTransforms|closed|bold|italic|moveAttributes|replace|sequence|forceAlphabetical|overwrite|";
        var vectors = "|bgColor|color|fillColor|strokeColor|position|size|";
        function genericValue() { return { anyOf: [{ type: "number" }, { type: "string", maxLength: 262144 }, { type: "boolean" }, { type: "array", items: { type: "number" }, maxItems: 16 }] }; }
        for (i = 0; i < names.length; i += 1) {
            name = names[i]; schema = { type: "string", maxLength: 1024 };
            if (numeric.indexOf("|" + name + "|") >= 0) { schema = { type: "number" }; }
            if (bools.indexOf("|" + name + "|") >= 0) { schema = { type: "boolean" }; }
            if (vectors.indexOf("|" + name + "|") >= 0) { schema = { type: "array", items: { type: "number" }, minItems: name === "position" || name === "size" ? 2 : 3, maxItems: name === "position" || name === "size" ? 2 : 3 }; }
            if (name === "comp" || name === "layer") { schema = selectorSchema(name === "comp" ? "comp" : "layer"); }
            if (name === "parent") { schema = { anyOf: [selectorSchema("layer"), { type: "null" }] }; }
            if (name === "value") { schema = genericValue(); }
            if (name === "path") { schema = { type: "array", minItems: 1, maxItems: 32, items: { anyOf: [{ type: "string", minLength: 1, maxLength: 1024 }, { type: "integer", minimum: 1 }] } }; }
            if (name === "properties") { schema = { type: "array", maxItems: 100, items: { type: "array", minItems: 1, maxItems: 32, items: { anyOf: [{ type: "string", minLength: 1 }, { type: "integer", minimum: 1 }] } } }; }
            if (name === "vertices" || name === "inTangents" || name === "outTangents") { schema = { type: "array", minItems: 2, maxItems: 5000, items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } } }; }
            if (name === "keys") { schema = definition.name === "property.get" ? { type: "boolean" } : { type: "array", minItems: 1, maxItems: 5000, items: { type: "object", properties: { time: { type: "number" }, value: genericValue(), interpolation: { type: "string", "enum": ["linear", "bezier", "hold"] } }, required: ["time", "value"], additionalProperties: false } }; }
            if (name === "transform") { schema = { type: "object", properties: { position: { type: "array", minItems: 2, maxItems: 3, items: { type: "number" } }, anchorPoint: { type: "array", minItems: 2, maxItems: 3, items: { type: "number" } }, scale: { type: "array", minItems: 2, maxItems: 3, items: { type: "number" } }, rotation: { type: "number" }, xRotation: { type: "number" }, yRotation: { type: "number" }, zRotation: { type: "number" }, opacity: { type: "number", minimum: 0, maximum: 100 } }, additionalProperties: false }; }
            if (name === "shape") { schema = { type: "string", "enum": ["rect", "ellipse", "path"] }; }
            if (name === "justification") { schema = { type: "string", "enum": ["left", "center", "right"] }; }
            if (name === "expression" || name === "text") { schema.maxLength = name === "expression" ? 65536 : 262144; }
            if (name === "width" || name === "height") { schema = { type: "integer", minimum: 4, maximum: 30000 }; }
            if (name === "maxItems" || name === "maxLayers" || name === "maxProperties") { schema = { type: "integer", minimum: 1, maximum: 5000 }; }
            if (name === "label") { schema = { type: "integer", minimum: 0, maximum: 16 }; }
            if (name === "resumeCompId") { schema = { type: "integer", minimum: 1 }; }
            if (name === "item") { schema = selectorSchema("item"); }
            if (name === "layers") { schema = { type: "array", minItems: definition.name === "layer.select" ? 0 : 1, maxItems: 1000, items: selectorSchema("layer") }; }
            if (name === "effect") { schema = { oneOf: [{ type: "object", properties: { index: { type: "integer", minimum: 1 } }, required: ["index"], additionalProperties: false }, { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["name"], additionalProperties: false }] }; }
            if (name === "path" && (definition.name === "media.import" || definition.name === "project.save")) { schema = { type: "string", minLength: 1, maxLength: 4096 }; }
            if (name === "outputPath") { schema = { type: "string", minLength: 1, maxLength: 4096 }; }
            if (name === "zoom" || name === "intensity" || name === "points" || name === "outerRadius" || name === "innerRadius" || name === "shapeRotation") { schema = { type: "number" }; }
            if (name === "numFrames") { schema = { type: "integer", minimum: 1, maximum: 3 }; }
            if (name === "times") { schema = { type: "array", minItems: 1, maxItems: 3, items: { type: "number", minimum: 0 } }; }
            if (name === "type" && definition.name === "project.search") { schema = { type: "string", "enum": ["all", "composition", "footage", "solid", "folder"] }; }
            if (name === "type" && definition.name === "layer.camera.create") { schema = { type: "string", "enum": ["one-node", "two-node"] }; }
            if (name === "type" && definition.name === "layer.light.create") { schema = { type: "string", "enum": ["point", "spot", "parallel", "ambient"] }; }
            if (name === "mode" && definition.name === "layer.blendMode") { schema = { type: "string", "enum": ["Normal", "Add", "Multiply", "Screen", "Overlay", "SoftLight", "HardLight", "ColorDodge", "ColorBurn", "Difference", "Exclusion", "Hue", "Saturation", "Color", "Luminosity", "Darken", "Lighten"] }; }
            if (name === "shape") { schema = { type: "string", "enum": ["rect", "ellipse", "path", "star", "polygon"] }; }
            schema.description = definition.args[name]; result.properties[name] = schema;
        }
        var extraRequired = { "comp.precompose": ["layers", "name"], "layer.remove": ["layer"], "layer.select": ["layers"], "layer.blendMode": ["layer", "mode"], "project.search": ["query"], "media.import": ["path"], "layer.media.add": ["item"], "render.queue.add": ["outputPath"], "effect.inspect": ["layer"], "effect.remove": ["layer", "effect"] };
        if (has(extraRequired, definition.name)) { result.required = extraRequired[definition.name]; }
        if (definition.name === "property.keyframes") { result.properties.keys.items.properties.easing = { anyOf: [{ type: "string", "enum": ["ease", "ease-in", "ease-out", "ease-in-out"] }, { type: "object", properties: { inSpeed: { type: "number" }, outSpeed: { type: "number" }, inInfluence: { type: "number", minimum: 0.1, maximum: 100 }, outInfluence: { type: "number", minimum: 0.1, maximum: 100 } }, additionalProperties: false }] }; }
        return result;
    }

    register("system.info", "Read host version and connection context", false, {}, function () {}, function () {
        return { runtimeVersion: VERSION, host: "After Effects", version: String(app.version || ""), projectOpen: !!app.project, activeComp: app.project && isComp(app.project.activeItem) ? compSummary(app.project.activeItem) : null };
    });
    function memoryBytes() {
        if (typeof app === "undefined" || !app) { fail("After Effects memory information is unavailable"); }
        var value = app.memoryInUse;
        if (!finite(value) || value < 0) { fail("After Effects memoryInUse must report a nonnegative byte count"); }
        return value;
    }
    function memoryNativeMethod(type) { return type === "function" || type === "unknown"; }
    function memoryPreflight(a) {
        var operation = has(a, "operation") ? a.operation : "inspect", bytes = memoryBytes(), p, queue;
        if (operation !== "inspect") {
            p = app.project;
            if (p) {
                queue = p.renderQueue;
                if (!queue || typeof queue.rendering !== "boolean") { fail("Cannot verify the After Effects render queue is idle"); }
                if (queue.rendering) { fail("Memory configuration and cache release are unavailable while After Effects is rendering"); }
            }
            if (operation === "configure" && !memoryNativeMethod(typeof app.setMemoryUsageLimits)) { fail("After Effects setMemoryUsageLimits is unavailable"); }
            if (operation === "purgeImages" && (!memoryNativeMethod(typeof app.purge) || typeof PurgeTarget === "undefined" || typeof PurgeTarget.IMAGE_CACHES === "undefined" || PurgeTarget.IMAGE_CACHES === null)) { fail("After Effects IMAGE_CACHES purge is unavailable"); }
        }
        return bytes;
    }
    var memoryOperationSchema = { type: "string", "enum": ["inspect", "configure", "purgeImages"], "default": "inspect", description: "Inspect memory by default; configure application percentages or release only cached image data when explicitly requested" };
    var memoryPercentageSchema = { type: "number", minimum: 0, maximum: 100, description: "Native AE percentage; required only for configure, with no supported readback or hard byte-limit guarantee" };
    register("app.memory", "Inspect native AE memory use, configure its memory percentages, or release image cache without clearing Undo or disk cache; never changes project data", true, { operation: "optional inspect (default), configure or purgeImages", imageCachePercentage: "configure only: required finite percentage 0..100 for the image cache", maximumMemoryPercentage: "configure only: required finite percentage 0..100 for maximum usable memory; not a hard process byte cap" }, function (a) {
        var operation = has(a, "operation") ? a.operation : "inspect";
        if (operation !== "inspect" && operation !== "configure" && operation !== "purgeImages") { fail("args.operation must be inspect, configure or purgeImages"); }
        if (operation === "configure") {
            number(a.imageCachePercentage, "args.imageCachePercentage", 0, 100);
            number(a.maximumMemoryPercentage, "args.maximumMemoryPercentage", 0, 100);
        } else if (has(a, "imageCachePercentage") || has(a, "maximumMemoryPercentage")) { fail("Memory percentages are accepted only for args.operation configure"); }
    }, function (a) {
        var operation = has(a, "operation") ? a.operation : "inspect", before = memoryPreflight(a), result;
        if (operation === "configure") { app.setMemoryUsageLimits(a.imageCachePercentage, a.maximumMemoryPercentage); }
        else if (operation === "purgeImages") { app.purge(PurgeTarget.IMAGE_CACHES); }
        result = { operation: operation, beforeBytes: before, afterBytes: memoryBytes(), limitsReadbackAvailable: false, projectModified: false, preservesUndo: true, preservesDiskCache: true };
        if (operation === "configure") { result.requestedLimits = { imageCachePercentage: a.imageCachePercentage, maximumMemoryPercentage: a.maximumMemoryPercentage }; }
        if (operation === "purgeImages") { result.purgedTarget = "IMAGE_CACHES"; result.releasedBytes = Math.max(0, before - result.afterBytes); }
        return result;
    }, "", { undo: false, exclusive: true, nativeInputSchema: { type: "object", properties: { operation: memoryOperationSchema, imageCachePercentage: memoryPercentageSchema, maximumMemoryPercentage: memoryPercentageSchema }, required: [], additionalProperties: false, oneOf: [
        { type: "object", properties: { operation: { type: "string", "enum": ["inspect"] } }, additionalProperties: false },
        { type: "object", properties: { operation: { type: "string", "enum": ["configure"] }, imageCachePercentage: memoryPercentageSchema, maximumMemoryPercentage: memoryPercentageSchema }, required: ["operation", "imageCachePercentage", "maximumMemoryPercentage"], additionalProperties: false },
        { type: "object", properties: { operation: { type: "string", "enum": ["purgeImages"] } }, required: ["operation"], additionalProperties: false }
    ] } });
    register("tools.list", "List reusable installed tools; archived scripts require explicit includeLegacy:true", false, { includeLegacy: "optional boolean; default false, archive maintenance only" }, function (a) { optional(a, "includeLegacy", boolValue); }, function (a) { return list(a.includeLegacy); });
    register("project.inspect", "Read project items without changing the project", false, { maxItems: "optional integer 1..5000; default 100" }, function (a) { optional(a, "maxItems", function (v, p) { whole(v, p, 1, 5000); }); }, function (a) {
        var p = project(), out = [], limit = a.maxItems || 100, i, item, projectFile = p.file, summary, fields = ["width", "height", "duration", "frameRate", "numLayers", "numItems"], j, value, file, color;
        for (i = 1; i <= p.numItems && i <= limit; i += 1) {
            item = p.item(i);
            if (isComp(item)) { out.push({ type: "composition", item: compSummary(item) }); }
            else {
                summary = { type: "item", id: item.id, name: item.name, typeName: String(item.typeName || "") };
                for (j = 0; j < fields.length; j += 1) { try { value = item[fields[j]]; if (finite(value)) { summary[fields[j]] = value; } } catch (ignoreItemMetadata) {} }
                try { file = item.file; if (file) { summary.path = String(file.fsName || file.fullName); summary.file = summary.path; } } catch (ignoreItemFile) {}
                try {
                    if (typeof SolidSource !== "undefined" && item.mainSource instanceof SolidSource) {
                        summary.isSolid = true; color = item.mainSource.color;
                        if (array(color) && color.length === 3 && finite(color[0]) && finite(color[1]) && finite(color[2])) { summary.color = [color[0], color[1], color[2]]; }
                    }
                } catch (ignoreSolidMetadata) {}
                out.push(summary);
            }
        }
        return { name: projectFile ? String(projectFile.displayName || projectFile.name || "Untitled") : "Untitled",
            path: projectFile ? String(projectFile.fsName || projectFile.fullName) : null,
            bitsPerChannel: finite(p.bitsPerChannel) ? p.bitsPerChannel : null,
            saved: typeof p.dirty === "boolean" ? !p.dirty : null,
            numItems: p.numItems, items: out, truncated: p.numItems > limit, activeComp: isComp(p.activeItem) ? compSummary(p.activeItem) : null };
    });
    register("comp.inspect", "Read composition settings and layers", false, { comp: "optional comp selector", includeLayers: "optional boolean; default true", maxLayers: "optional integer 1..5000; default 200" }, function (a, refs) {
        selectors(a, refs, false); optional(a, "includeLayers", boolValue); optional(a, "maxLayers", function (v, p) { whole(v, p, 1, 5000); });
    }, function (a, refs, entry) {
        var comp = resolved(a, refs, entry, false).comp, result = compSummary(comp), i, limit = a.maxLayers || 200;
        if (a.includeLayers !== false) { result.layers = []; for (i = 1; i <= comp.numLayers && i <= limit; i += 1) { result.layers.push(layerSummary(comp.layer(i))); } result.truncated = comp.numLayers > limit; }
        return result;
    });
    function compSettings(a, refs, creating) {
        var fields = ["width", "height"], i;
        if (!creating) { selectors(a, refs, false); }
        if (creating || has(a, "name")) { text(a.name, "args.name", 1024); }
        for (i = 0; i < fields.length; i += 1) { if (has(a, fields[i])) { whole(a[fields[i]], "args." + fields[i], 4, 30000); } }
        optional(a, "pixelAspect", function (v, p) { number(v, p, 0.01, 100); });
        optional(a, "duration", function (v, p) { number(v, p, 0.001, 10800); });
        optional(a, "frameRate", function (v, p) { number(v, p, 1, 999); });
        optional(a, "bgColor", function (v, p) { vector(v, p, 3, 3, 0, 1); });
        optional(a, "workAreaStart", function (v, p) { number(v, p, 0, 10800); });
        optional(a, "workAreaDuration", function (v, p) { number(v, p, 0.001, 10800); });
        optional(a, "displayStartTime", function (v, p) { number(v, p, -10800, 86339); });
    }
    function assignComp(comp, a) {
        var names = ["name", "width", "height", "pixelAspect", "duration", "frameRate", "bgColor", "displayStartTime", "workAreaStart", "workAreaDuration"], i;
        for (i = 0; i < names.length; i += 1) { if (has(a, names[i])) { comp[names[i]] = a[names[i]]; } }
    }
    var compFields = { name: "composition name", width: "optional integer 4..30000; default 1920", height: "optional integer 4..30000; default 1080", pixelAspect: "optional number; default 1", duration: "optional seconds; default 10", frameRate: "optional frames/second; default 30", bgColor: "optional RGB [0..1,0..1,0..1]", workAreaStart: "optional seconds", workAreaDuration: "optional seconds", displayStartTime: "optional seconds" };
    register("comp.create", "Create a composition; optionally label it with step.as", true, compFields, function (a, refs) { compSettings(a, refs, true); }, function (a) {
        var comp = project().items.addComp(a.name, a.width || 1920, a.height || 1080, has(a, "pixelAspect") ? a.pixelAspect : 1, a.duration || 10, a.frameRate || 30);
        assignComp(comp, a); return { value: compSummary(comp), reference: comp };
    }, "comp");
    register("comp.update", "Update selected composition settings", true, { comp: "optional comp selector", name: "optional name", width: "optional integer 4..30000", height: "optional integer 4..30000", pixelAspect: "optional number", duration: "optional seconds", frameRate: "optional frames/second", bgColor: "optional RGB vector", workAreaStart: "optional seconds", workAreaDuration: "optional seconds", displayStartTime: "optional seconds" }, function (a, refs) { compSettings(a, refs, false); }, function (a, refs, entry) { var comp = resolved(a, refs, entry, false).comp; assignComp(comp, a); return compSummary(comp); });
    register("comp.activate", "Open selected composition in the viewer", true, { comp: "optional comp selector" }, function (a, refs) { selectors(a, refs, false); }, function (a, refs, entry) { var comp = resolved(a, refs, entry, false).comp; comp.openInViewer(); return compSummary(comp); });
    register("layer.inspect", "Read the selected layer and optional property paths", false, { comp: "optional comp selector", layer: "layer selector", properties: "optional list of property paths; max 100" }, function (a, refs) {
        var i; selectors(a, refs, true);
        if (has(a, "properties")) { if (!array(a.properties) || a.properties.length > 100) { fail("args.properties must contain at most 100 paths"); } for (i = 0; i < a.properties.length; i += 1) { propertyPath(a.properties[i], "args.properties[" + i + "]"); } }
    }, function (a, refs, entry) {
        var layer = resolved(a, refs, entry, true).layer, result = layerSummary(layer), i;
        if (a.properties) { result.properties = []; for (i = 0; i < a.properties.length; i += 1) { result.properties.push({ path: a.properties[i], value: dataValue(resolveProperty(layer, a.properties[i]).value) }); } }
        return result;
    });
    function createLayerCheck(a, refs) {
        selectors(a, refs, false); optional(a, "name", function (v, p) { text(v, p, 1024); }); optional(a, "duration", function (v, p) { number(v, p, 0.001, 10800); });
    }
    register("layer.text.create", "Create a text layer with optional text style", true, { comp: "optional comp selector", text: "text content", name: "optional layer name", font: "optional installed font PostScript name", fontSize: "optional positive number", fillColor: "optional RGB vector", applyFill: "optional boolean", justification: "optional left, center or right", bold: "optional faux bold", italic: "optional faux italic" }, function (a, refs) {
        selectors(a, refs, false); text(a.text, "args.text", 262144, true); optional(a, "name", function (v, p) { text(v, p, 1024); }); optional(a, "font", function (v, p) { text(v, p, 256); }); optional(a, "fontSize", function (v, p) { number(v, p, 0.1, 30000); }); optional(a, "fillColor", function (v, p) { vector(v, p, 3, 3, 0, 1); }); optional(a, "applyFill", boolValue);
        optional(a, "bold", boolValue); optional(a, "italic", boolValue);
        if (has(a, "justification") && a.justification !== "left" && a.justification !== "center" && a.justification !== "right") { fail("args.justification must be left, center or right"); }
    }, function (a, refs, entry) {
        var comp = resolved(a, refs, entry, false).comp, layer = comp.layers.addText(a.text), property = resolveProperty(layer, ["ADBE Text Properties", "ADBE Text Document"]), document = property.value;
        if (has(a, "name")) { layer.name = a.name; }
        if (has(a, "font")) { document.font = a.font; } if (has(a, "fontSize")) { document.fontSize = a.fontSize; }
        if (has(a, "bold")) { document.fauxBold = a.bold; } if (has(a, "italic")) { document.fauxItalic = a.italic; }
        if (has(a, "fillColor")) { document.fillColor = a.fillColor; document.applyFill = true; } if (has(a, "applyFill")) { document.applyFill = a.applyFill; }
        if (has(a, "justification")) { document.justification = a.justification === "left" ? ParagraphJustification.LEFT_JUSTIFY : (a.justification === "center" ? ParagraphJustification.CENTER_JUSTIFY : ParagraphJustification.RIGHT_JUSTIFY); }
        property.setValue(document); return { value: layerSummary(layer), reference: layer };
    }, "layer");
    register("layer.solid.create", "Create a solid in the selected composition", true, { comp: "optional comp selector", color: "RGB [0..1,0..1,0..1]", name: "optional layer name", width: "optional integer", height: "optional integer", pixelAspect: "optional number", duration: "optional seconds" }, function (a, refs) {
        createLayerCheck(a, refs); vector(a.color, "args.color", 3, 3, 0, 1); optional(a, "width", function (v, p) { whole(v, p, 4, 30000); }); optional(a, "height", function (v, p) { whole(v, p, 4, 30000); }); optional(a, "pixelAspect", function (v, p) { number(v, p, 0.01, 100); });
    }, function (a, refs, entry) { var comp = resolved(a, refs, entry, false).comp, layer = comp.layers.addSolid(a.color, a.name || "Solid", a.width || comp.width, a.height || comp.height, has(a, "pixelAspect") ? a.pixelAspect : comp.pixelAspect, a.duration || comp.duration); return { value: layerSummary(layer), reference: layer }; }, "layer");
    register("layer.null.create", "Create a null layer", true, { comp: "optional comp selector", name: "optional layer name", duration: "optional seconds" }, createLayerCheck, function (a, refs, entry) { var comp = resolved(a, refs, entry, false).comp, layer = comp.layers.addNull(a.duration || comp.duration); if (has(a, "name")) { layer.name = a.name; } return { value: layerSummary(layer), reference: layer }; }, "layer");
    register("layer.duplicate", "Duplicate the selected layer", true, { comp: "optional comp selector", layer: "layer selector", name: "optional new name" }, function (a, refs) { selectors(a, refs, true); optional(a, "name", function (v, p) { text(v, p, 1024); }); }, function (a, refs, entry) { var layer = resolved(a, refs, entry, true).layer.duplicate(); if (has(a, "name")) { layer.name = a.name; } return { value: layerSummary(layer), reference: layer }; }, "layer");
    var layerBooleanFields = ["enabled", "shy", "locked", "solo", "threeDLayer", "guideLayer", "adjustmentLayer"];
    var transformNames = { position: "ADBE Position", anchorPoint: "ADBE Anchor Point", scale: "ADBE Scale", rotation: "ADBE Rotate Z", xRotation: "ADBE Rotate X", yRotation: "ADBE Rotate Y", zRotation: "ADBE Rotate Z", opacity: "ADBE Opacity" };
    register("layer.update", "Update layer timing, flags and transform values", true, { comp: "optional comp selector", layer: "layer selector", name: "optional name", startTime: "optional seconds", inPoint: "optional seconds", outPoint: "optional seconds", label: "optional integer 0..16", enabled: "optional boolean", shy: "optional boolean", locked: "optional boolean", solo: "optional boolean", threeDLayer: "optional boolean", guideLayer: "optional boolean", adjustmentLayer: "optional boolean", transform: "optional {position,anchorPoint,scale,rotation,xRotation,yRotation,zRotation,opacity}" }, function (a, refs) {
        var i, names; selectors(a, refs, true); optional(a, "name", function (v, p) { text(v, p, 1024); });
        for (i = 0; i < layerBooleanFields.length; i += 1) { optional(a, layerBooleanFields[i], boolValue); }
        optional(a, "startTime", function (v, p) { number(v, p, -10800, 10800); }); optional(a, "inPoint", function (v, p) { number(v, p, -10800, 10800); }); optional(a, "outPoint", function (v, p) { number(v, p, -10800, 10800); }); optional(a, "label", function (v, p) { whole(v, p, 0, 16); });
        if (has(a, "inPoint") && has(a, "outPoint") && a.inPoint >= a.outPoint) { fail("args.inPoint must precede args.outPoint"); }
        if (has(a, "transform")) {
            exact(a.transform, "position|anchorPoint|scale|rotation|xRotation|yRotation|zRotation|opacity", "args.transform"); names = keys(a.transform);
            if (has(a.transform, "rotation") && has(a.transform, "zRotation")) { fail("Use rotation or zRotation, not both"); }
            for (i = 0; i < names.length; i += 1) {
                if (names[i] === "position" || names[i] === "anchorPoint" || names[i] === "scale") { vector(a.transform[names[i]], "args.transform." + names[i], 2, 3); }
                else { number(a.transform[names[i]], "args.transform." + names[i], names[i] === "opacity" ? 0 : undefined, names[i] === "opacity" ? 100 : undefined); }
            }
        }
    }, function (a, refs, entry) {
        var layer = resolved(a, refs, entry, true).layer, names = ["name", "startTime", "inPoint", "outPoint", "label", "enabled", "shy", "solo", "threeDLayer", "guideLayer", "adjustmentLayer"], i, property;
        checkLayerUpdate(layer, a);
        if (a.locked === false) { layer.locked = false; }
        for (i = 0; i < names.length; i += 1) { if (has(a, names[i])) { layer[names[i]] = a[names[i]]; } }
        if (a.transform) { names = keys(a.transform); for (i = 0; i < names.length; i += 1) { property = resolveProperty(layer, ["ADBE Transform Group", transformNames[names[i]]]); writeValue(property, a.transform[names[i]]); } }
        if (has(a, "locked")) { layer.locked = a.locked; }
        return layerSummary(layer);
    });
    register("layer.parent", "Parent or unparent a layer within its composition", true, { comp: "optional comp selector", layer: "layer selector", parent: "layer selector or null", preserveTransforms: "optional boolean; default true" }, function (a, refs) { selectors(a, refs, true); if (!has(a, "parent")) { fail("args.parent is required"); } if (a.parent !== null) { selector(a.parent, "args.parent", "layer", refs); } optional(a, "preserveTransforms", boolValue); }, function (a, refs, entry) {
        var target = resolved(a, refs, entry, true), parent = a.parent === null ? null : resolveLayer(target.comp, a.parent, refs), ancestor = parent, limit = 0;
        while (ancestor) { if (ancestor === target.layer) { fail("Parenting would create a layer cycle"); } ancestor = ancestor.parent; limit += 1; if (limit > target.comp.numLayers) { fail("Existing parent cycle detected"); } }
        if (a.preserveTransforms === false) { target.layer.setParentWithJump(parent); } else { target.layer.parent = parent; } return layerSummary(target.layer);
    });
    function propertyCheck(a, refs) { selectors(a, refs, true); propertyPath(a.path, "args.path"); }
    register("property.list", "Read child property names, matchNames and indices for discovering exact paths", false, { comp: "optional comp selector", layer: "layer selector", path: "optional property path; omit for top-level layer properties", maxProperties: "optional integer 1..5000; default 200" }, function (a, refs) {
        selectors(a, refs, true); if (has(a, "path")) { propertyPath(a.path, "args.path"); } optional(a, "maxProperties", function (v, p) { whole(v, p, 1, 5000); });
    }, function (a, refs, entry) {
        var layer = resolved(a, refs, entry, true).layer, group = a.path ? resolveProperty(layer, a.path) : layer, count = Number(group.numProperties || 0), out = [], limit = a.maxProperties || 200, i, property;
        for (i = 1; i <= count && i <= limit; i += 1) { property = group.property(i); if (property) { out.push({ index: i, name: String(property.name), matchName: String(property.matchName || ""), numProperties: Number(property.numProperties || 0), canSetExpression: !!property.canSetExpression, numKeys: Number(property.numKeys || 0) }); } }
        return { name: String(group.name), numProperties: count, properties: out, truncated: count > limit };
    });
    register("property.get", "Read a layer property and optional keyframes", false, { comp: "optional comp selector", layer: "layer selector", path: "array of exact matchNames/names or positive indices", keys: "optional boolean; default false" }, function (a, refs) { propertyCheck(a, refs); optional(a, "keys", boolValue); }, function (a, refs, entry) {
        var target = resolved(a, refs, entry, true), property = resolveProperty(target.layer, a.path), result = { name: property.name, matchName: property.matchName, value: dataValue(property.value), numKeys: property.numKeys || 0, canSetExpression: !!property.canSetExpression }, i;
        if (property.canSetExpression) { result.expression = String(property.expression || ""); result.expressionEnabled = !!property.expressionEnabled; result.expressionError = String(property.expressionError || ""); }
        if (a.keys) { if (property.numKeys > 5000) { fail("Property has more than 5000 keyframes; read without keys"); } result.keys = []; for (i = 1; i <= property.numKeys; i += 1) { result.keys.push({ time: property.keyTime(i), value: dataValue(property.keyValue(i)) }); } }
        return result;
    });
    register("property.set", "Set a static property or a value at a specified time", true, { comp: "optional comp selector", layer: "layer selector", path: "property path", value: "number, string, boolean or numeric vector", time: "optional keyframe time in seconds" }, function (a, refs) { propertyCheck(a, refs); if (!has(a, "value")) { fail("args.value is required"); } valueData(a.value, "args.value"); optional(a, "time", function (v, p) { number(v, p, -10800, 10800); }); }, function (a, refs, entry) { var property = resolveProperty(resolved(a, refs, entry, true).layer, a.path); writeValue(property, a.value, a.time); return { name: property.name, value: dataValue(property.value), numKeys: property.numKeys || 0 }; });
    function checkTemporalEase(value, path) {
        if (typeof value === "string") { if (value !== "ease" && value !== "ease-in" && value !== "ease-out" && value !== "ease-in-out") { fail(path + " must be ease, ease-in, ease-out or ease-in-out"); } return; }
        exact(value, "inSpeed|outSpeed|inInfluence|outInfluence", path);
        optional(value, "inSpeed", function (v) { number(v, path + ".inSpeed", -10000000, 10000000); });
        optional(value, "outSpeed", function (v) { number(v, path + ".outSpeed", -10000000, 10000000); });
        optional(value, "inInfluence", function (v) { number(v, path + ".inInfluence", 0.1, 100); });
        optional(value, "outInfluence", function (v) { number(v, path + ".outInfluence", 0.1, 100); });
    }
    function setTemporalEase(property, index, spec) {
        var incoming = 33.333, outgoing = 33.333, inSpeed = 0, outSpeed = 0, dimensions, a = [], b = [], i;
        if (typeof property.setTemporalEaseAtKey !== "function" || typeof KeyframeEase === "undefined") { fail("Temporal easing is unavailable for this property"); }
        if (typeof spec === "string") { if (spec === "ease" || spec === "ease-in-out") { incoming = 75; outgoing = 75; } if (spec === "ease-in") { incoming = 75; } if (spec === "ease-out") { outgoing = 75; } }
        else { if (has(spec, "inInfluence")) { incoming = spec.inInfluence; } if (has(spec, "outInfluence")) { outgoing = spec.outInfluence; } if (has(spec, "inSpeed")) { inSpeed = spec.inSpeed; } if (has(spec, "outSpeed")) { outSpeed = spec.outSpeed; } }
        dimensions = property.isSpatial ? 1 : (array(property.value) ? property.value.length : 1);
        if (dimensions < 1 || dimensions > 4) { fail("Unsupported temporal easing dimensions"); }
        for (i = 0; i < dimensions; i += 1) { a.push(new KeyframeEase(inSpeed, incoming)); b.push(new KeyframeEase(outSpeed, outgoing)); }
        property.setTemporalEaseAtKey(index, a, b);
    }
    register("property.keyframes", "Add or update keyframes with optional temporal easing; preserves other keys", true, { comp: "optional comp selector", layer: "layer selector", path: "property path", keys: "1..5000 {time,value,interpolation?:linear|bezier|hold,easing?:ease|ease-in|ease-out|ease-in-out or {inSpeed,outSpeed,inInfluence,outInfluence}}" }, function (a, refs) {
        var i, key, seen = {}; propertyCheck(a, refs);
        if (!array(a.keys) || !a.keys.length || a.keys.length > 5000) { fail("args.keys must contain 1 to 5000 keyframes"); }
        for (i = 0; i < a.keys.length; i += 1) {
            key = a.keys[i]; exact(key, "time|value|interpolation|easing", "args.keys[" + i + "]"); number(key.time, "args.keys[" + i + "].time", -10800, 10800); if (has(seen, String(key.time))) { fail("Duplicate keyframe time: " + key.time); } seen[String(key.time)] = true; valueData(key.value, "args.keys[" + i + "].value");
            if (has(key, "interpolation") && key.interpolation !== "linear" && key.interpolation !== "bezier" && key.interpolation !== "hold") { fail("Invalid keyframe interpolation"); }
            if (has(key, "easing")) { checkTemporalEase(key.easing, "args.keys[" + i + "].easing"); if (key.interpolation === "hold" || key.interpolation === "linear") { fail("Temporal easing requires bezier interpolation"); } }
        }
    }, function (a, refs, entry) {
        var property = resolveProperty(resolved(a, refs, entry, true).layer, a.path), i, key, interpolation, index;
        if (!property.canVaryOverTime || typeof property.setValueAtTime !== "function") { fail("Selected property cannot be keyframed"); }
        for (i = 0; i < a.keys.length; i += 1) {
            key = a.keys[i]; writeValue(property, key.value, key.time);
            if (key.interpolation) { interpolation = key.interpolation === "hold" ? KeyframeInterpolationType.HOLD : (key.interpolation === "bezier" ? KeyframeInterpolationType.BEZIER : KeyframeInterpolationType.LINEAR); index = property.nearestKeyIndex(key.time); property.setInterpolationTypeAtKey(index, interpolation, interpolation); }
            if (has(key, "easing")) { index = property.nearestKeyIndex(key.time); property.setInterpolationTypeAtKey(index, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); setTemporalEase(property, index, key.easing); }
        }
        return { name: property.name, numKeys: property.numKeys };
    });
    register("property.expression", "Set or clear an After Effects property expression", true, { comp: "optional comp selector", layer: "layer selector", path: "property path", expression: "expression string; empty clears", enabled: "optional boolean" }, function (a, refs) { propertyCheck(a, refs); text(a.expression, "args.expression", 65536, true); optional(a, "enabled", boolValue); }, function (a, refs, entry) {
        var property = resolveProperty(resolved(a, refs, entry, true).layer, a.path);
        if (!property.canSetExpression) { fail("Selected property does not support expressions"); }
        property.expression = a.expression; if (has(a, "enabled")) { property.expressionEnabled = a.enabled; }
        if (property.expressionError) { fail("After Effects expression error: " + property.expressionError); }
        return { name: property.name, expression: property.expression, enabled: !!property.expressionEnabled };
    });
    register("effect.add", "Add an installed effect using its exact matchName", true, { comp: "optional comp selector", layer: "layer selector", matchName: "registered effect matchName", name: "optional effect instance name" }, function (a, refs) { selectors(a, refs, true); text(a.matchName, "args.matchName", 256); optional(a, "name", function (v, p) { text(v, p, 1024); }); }, function (a, refs, entry) {
        var layer = resolved(a, refs, entry, true).layer, group = resolveProperty(layer, ["ADBE Effect Parade"]), effect;
        if (!group.canAddProperty(a.matchName)) { fail("Effect is unavailable for this layer: " + a.matchName); }
        effect = group.addProperty(a.matchName); if (!effect) { fail("After Effects did not add effect " + a.matchName); } if (has(a, "name")) { effect.name = a.name; }
        return { name: effect.name, matchName: effect.matchName, index: effect.propertyIndex, layer: layerSummary(layer) };
    });
    register("layer.shape.create", "Create a rectangle, ellipse, star, polygon or Bezier path shape layer", true, { comp: "optional comp selector", name: "optional layer name", shape: "rect, ellipse, star, polygon or path", size: "rect/ellipse [width,height]", position: "optional shape-local [x,y]", roundness: "optional rectangle corner radius", points: "optional star/polygon point count; default 5", outerRadius: "optional star/polygon radius; default 100", innerRadius: "optional star inner radius; default 50", shapeRotation: "optional star/polygon rotation degrees", vertices: "path [[x,y],...]", inTangents: "optional path tangent vectors", outTangents: "optional path tangent vectors", closed: "optional path boolean; default true", fillColor: "optional RGB vector", strokeColor: "optional RGB vector", strokeWidth: "optional nonnegative number; default 2" }, function (a, refs) {
        var i, names = ["vertices", "inTangents", "outTangents"];
        selectors(a, refs, false); optional(a, "name", function (v, p) { text(v, p, 1024); });
        if (a.shape !== "rect" && a.shape !== "ellipse" && a.shape !== "path" && a.shape !== "star" && a.shape !== "polygon") { fail("args.shape must be rect, ellipse, path, star or polygon"); }
        if (a.shape !== "star" && a.shape !== "polygon" && (has(a, "points") || has(a, "outerRadius") || has(a, "innerRadius") || has(a, "shapeRotation"))) { fail("Star/polygon parameters require a star or polygon shape"); }
        if (a.shape === "path") {
            if (has(a, "size") || has(a, "roundness") || has(a, "position")) { fail("Path shapes use vertices/tangents rather than size, roundness or position"); }
            if (!array(a.vertices) || a.vertices.length < 2 || a.vertices.length > 5000) { fail("Path requires 2 to 5000 vertices"); }
            for (i = 0; i < names.length; i += 1) { if (has(a, names[i])) { checkPoints(a[names[i]], names[i], a.vertices.length); } }
        } else if (a.shape === "star" || a.shape === "polygon") {
            if (has(a, "vertices") || has(a, "inTangents") || has(a, "outTangents") || has(a, "closed") || has(a, "size") || has(a, "roundness")) { fail("Star/polygon uses points and radii, not path or rectangle parameters"); }
            optional(a, "position", function (v, p) { vector(v, p, 2, 2); });
            optional(a, "points", function (v, p) { whole(v, p, 3, 1000); });
            optional(a, "outerRadius", function (v, p) { number(v, p, 0.001, 30000); });
            optional(a, "innerRadius", function (v, p) { number(v, p, 0.001, 30000); });
            optional(a, "shapeRotation", function (v, p) { number(v, p, -1000000, 1000000); });
            if (a.shape === "polygon" && has(a, "innerRadius")) { fail("Polygon has no inner radius"); }
        } else {
            if (has(a, "vertices") || has(a, "inTangents") || has(a, "outTangents") || has(a, "closed")) { fail("Only path shapes accept vertices, tangents and closed"); }
            vector(a.size, "args.size", 2, 2, 0.001); optional(a, "position", function (v, p) { vector(v, p, 2, 2); }); optional(a, "roundness", function (v, p) { number(v, p, 0); }); if (a.shape === "ellipse" && has(a, "roundness")) { fail("Ellipse has no roundness parameter"); }
        }
        optional(a, "closed", boolValue); optional(a, "fillColor", function (v, p) { vector(v, p, 3, 3, 0, 1); }); optional(a, "strokeColor", function (v, p) { vector(v, p, 3, 3, 0, 1); }); optional(a, "strokeWidth", function (v, p) { number(v, p, 0, 30000); });
        if (has(a, "strokeWidth") && !has(a, "strokeColor")) { fail("args.strokeWidth requires args.strokeColor"); }
    }, function (a, refs, entry) {
        var comp = resolved(a, refs, entry, false).comp, layer = comp.layers.addShape(), root = resolveProperty(layer, ["ADBE Root Vectors Group"]), group = root.addProperty("ADBE Vector Group"), contents = group.property("ADBE Vectors Group"), shape, path, fill, stroke, i;
        if (has(a, "name")) { layer.name = a.name; }
        if (a.shape === "path") {
            shape = contents.addProperty("ADBE Vector Shape - Group"); path = new Shape(); path.vertices = a.vertices; path.inTangents = []; path.outTangents = [];
            for (i = 0; i < a.vertices.length; i += 1) { path.inTangents.push(a.inTangents ? a.inTangents[i] : [0, 0]); path.outTangents.push(a.outTangents ? a.outTangents[i] : [0, 0]); }
            path.closed = a.closed !== false; shape.property("ADBE Vector Shape").setValue(path);
        } else if (a.shape === "star" || a.shape === "polygon") {
            shape = contents.addProperty("ADBE Vector Shape - Star");
            shape.property("ADBE Vector Star Type").setValue(a.shape === "star" ? 1 : 2);
            shape.property("ADBE Vector Star Points").setValue(has(a, "points") ? a.points : 5);
            shape.property("ADBE Vector Star Outer Radius").setValue(has(a, "outerRadius") ? a.outerRadius : 100);
            if (a.shape === "star") { shape.property("ADBE Vector Star Inner Radius").setValue(has(a, "innerRadius") ? a.innerRadius : 50); }
            if (a.position) { shape.property("ADBE Vector Star Position").setValue(a.position); }
            if (has(a, "shapeRotation")) { shape.property("ADBE Vector Star Rotation").setValue(a.shapeRotation); }
        } else {
            shape = contents.addProperty(a.shape === "rect" ? "ADBE Vector Shape - Rect" : "ADBE Vector Shape - Ellipse");
            shape.property(a.shape === "rect" ? "ADBE Vector Rect Size" : "ADBE Vector Ellipse Size").setValue(a.size);
            if (a.position) { shape.property(a.shape === "rect" ? "ADBE Vector Rect Position" : "ADBE Vector Ellipse Position").setValue(a.position); }
            if (has(a, "roundness")) { shape.property("ADBE Vector Rect Roundness").setValue(a.roundness); }
        }
        if (a.fillColor || !a.strokeColor) { fill = contents.addProperty("ADBE Vector Graphic - Fill"); fill.property("ADBE Vector Fill Color").setValue(a.fillColor || [1, 1, 1]); }
        if (a.strokeColor) { stroke = contents.addProperty("ADBE Vector Graphic - Stroke"); stroke.property("ADBE Vector Stroke Color").setValue(a.strokeColor); stroke.property("ADBE Vector Stroke Width").setValue(has(a, "strokeWidth") ? a.strokeWidth : 2); }
        return { value: layerSummary(layer), reference: layer };
    }, "layer");
    function checkPoints(points, path, expected) { var i; if (!array(points) || points.length !== expected) { fail("args." + path + " must match the vertices count"); } for (i = 0; i < points.length; i += 1) { vector(points[i], "args." + path + "[" + i + "]", 2, 2); } }
    register("comp.rebuildMedia", "Rebuild a 2D composition from original media, baking nested transforms without retaining precomps", true, { comp: "source comp selector", name: "new composition name", sampleRate: "optional samples per second; default source frameRate", resumeCompId: "optional existing partial rebuild composition id" }, function (a, refs) {
        selectors(a, refs, false); text(a.name, "args.name", 1024);
        optional(a, "sampleRate", function (v, p) { number(v, p, 1, 60); });
        optional(a, "resumeCompId", function (v, p) { whole(v, p, 1); });
    }, function (a, refs, entry) {
        var source = resolved(a, refs, entry, false).comp, rate = a.sampleRate || source.frameRate;
        var dest, leaves = [], warnings = [], count = 0, existingCount = 0, i;
        function val(l, n, t) { return l.property("ADBE Transform Group").property(n).valueAtTime(t, false); }
        function mul(x, y) { return [x[0]*y[0]+x[2]*y[1], x[1]*y[0]+x[3]*y[1], x[0]*y[2]+x[2]*y[3], x[1]*y[2]+x[3]*y[3], x[0]*y[4]+x[2]*y[5]+x[4], x[1]*y[4]+x[3]*y[5]+x[5]]; }
        function point(m, p) { return [m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5]]; }
        function matrix(l, t) {
            var an = val(l,"ADBE Anchor Point",t), po = val(l,"ADBE Position",t), sc = val(l,"ADBE Scale",t), r = val(l,"ADBE Rotate Z",t)*Math.PI/180, c = Math.cos(r), s = Math.sin(r);
            var m = [c*sc[0]/100,s*sc[0]/100,-s*sc[1]/100,c*sc[1]/100,0,0];
            m[4]=po[0]-m[0]*an[0]-m[2]*an[1]; m[5]=po[1]-m[1]*an[0]-m[3]*an[1];
            return l.parent ? mul(matrix(l.parent,t),m) : m;
        }
        function geometry(l, t) {
            var m=[1,0,0,1,0,0], fx=l.property("ADBE Effect Parade"), j,e,an,po,sc,sy,r,c,s,n;
            if(!fx)return m;
            for(j=1;j<=fx.numProperties;j++) { e=fx.property(j); if(!e.enabled)continue;
                if(e.matchName!=="ADBE Geometry2") { warnings.push("Container effect omitted: "+l.name+" / "+e.matchName); continue; }
                an=e.property(1).valueAtTime(t,false); po=e.property(2).valueAtTime(t,false);
                sc=e.property(4).valueAtTime(t,false)/100; sy=e.property(3).valueAtTime(t,false)?sc:e.property(5).valueAtTime(t,false)/100;
                r=e.property(8).valueAtTime(t,false)*Math.PI/180; c=Math.cos(r);s=Math.sin(r);
                n=[c*sc,s*sc,-s*sy,c*sy,0,0]; n[4]=po[0]-n[0]*an[0]-n[2]*an[1];n[5]=po[1]-n[1]*an[0]-n[3]*an[1]; m=mul(n,m);
            }return m;
        }
        function scan(c, offset, speed, lo, hi, chain, video, audio, depth) {
            var j,l,s,v,au,start,end,ch;
            if(depth>12)fail("Nested composition depth exceeds 12");
            for(j=1;j<=c.numLayers;j++) { l=c.layer(j);s=l.source;
                if(l.threeDLayer&&(Math.abs(val(l,"ADBE Rotate X",0))>0.001||Math.abs(val(l,"ADBE Rotate Y",0))>0.001))fail("Nonplanar 3D layers are not supported: "+l.name);
                if(l.timeRemapEnabled)fail("Time remapping is not supported: "+l.name);
                if(l.stretch<=0)fail("Reverse time is not supported: "+l.name);
                v=video&&l.enabled&&!l.guideLayer&&!l.nullLayer;au=audio&&l.hasAudio&&l.audioEnabled;
                if(!v&&!au)continue;
                start=Math.max(lo,offset+speed*l.inPoint);end=Math.min(hi,offset+speed*l.outPoint);
                if(end<=start)continue;
                if(isComp(s)) {ch=chain.concat([{layer:l,offset:offset,speed:speed}]);scan(s,offset+speed*l.startTime,speed*l.stretch/100,start,end,ch,v,au,depth+1);}
                else leaves.push({layer:l,offset:offset,speed:speed,lo:start,hi:end,chain:chain,video:v,audio:au});
            }
        }
        scan(source,0,1,0,source.duration,[],true,true,0);
        if(leaves.length>300)fail("Rebuild is limited to 300 media layers");
        if(a.resumeCompId){dest=resolveComp({comp:{id:a.resumeCompId}},{});if(dest.id===source.id||dest.name!==a.name||dest.numLayers>leaves.length)fail("Invalid partial rebuild destination");existingCount=dest.numLayers;
            for(i=0;i<existingCount;i++)if(dest.layer(existingCount-i).name!==leaves[leaves.length-1-i].layer.name)fail("Partial rebuild layer order does not match");
        } else dest=project().items.addComp(a.name,source.width,source.height,source.pixelAspect,source.duration,source.frameRate);
        dest.bgColor=source.bgColor;dest.workAreaStart=source.workAreaStart;dest.workAreaDuration=source.workAreaDuration;
        function times(lo, hi) { var ts=[],k;for(k=Math.floor(lo*rate);k<=Math.ceil(hi*rate);k++)if(k/rate>=lo&&k/rate<=hi)ts.push(k/rate);if(!ts.length||ts[0]>lo)ts.unshift(lo);return ts; }
        function transfer(sp, dp, rec) {
            var ts,vs=[],k,t;
            if(!dp||sp.propertyValueType===PropertyValueType.NO_VALUE||sp.propertyValueType===PropertyValueType.CUSTOM_VALUE)return;
            try {
                if(sp.canVaryOverTime&&(sp.numKeys>0||sp.expressionEnabled)) {ts=times(rec.lo,rec.hi);for(k=0;k<ts.length;k++){t=(ts[k]-rec.offset)/rec.speed;vs.push(sp.valueAtTime(t,false));}dp.setValuesAtTimes(ts,vs);}
                else dp.setValue(sp.valueAtTime((rec.lo-rec.offset)/rec.speed,false));
            }catch(e){warnings.push("Property omitted: "+sp.name+" / "+String(e));}
        }
        function group(sp,dp,rec) {var j,p,q,idx; if(!sp||!dp)return;for(j=1;j<=sp.numProperties;j++){p=sp.property(j);q=null;
            try {if(dp.propertyType===PropertyType.INDEXED_GROUP&&dp.canAddProperty(p.matchName)){q=dp.addProperty(p.matchName);idx=q.propertyIndex;q.name=p.name;}else q=dp.property(p.matchName)||dp.property(j);
                if(!q)continue;
                if(p.propertyType===PropertyType.PROPERTY)transfer(p,q,rec);else group(p,q,rec);
                try{q.enabled=p.enabled;}catch(ignore){}
            }catch(e){warnings.push("Group omitted: "+p.name+" / "+String(e));}
        }}
        function build(rec) {
            var l=rec.layer,s=l.source,n,tp,ts=times(rec.lo,rec.hi),ps=[],ss=[],rs=[],ops=[],k,j,t,m,an,po,op,c,det,scx,scy;
            if(count<existingCount)n=dest.layer(existingCount-count);
            else if(s&&s.mainSource&&s.mainSource.color) n=dest.layers.addSolid(s.mainSource.color,l.name,s.width,s.height,s.pixelAspect,source.duration);
            else if(s)n=dest.layers.add(s);
            else if(l.property("ADBE Text Properties")) {n=dest.layers.addText("");group(l.property("ADBE Text Properties"),n.property("ADBE Text Properties"),rec);}
            else if(l.property("ADBE Root Vectors Group")){n=dest.layers.addShape();group(l.property("ADBE Root Vectors Group"),n.property("ADBE Root Vectors Group"),rec);}
            else {warnings.push("Unsupported layer: "+l.name);return;}
            n.name=l.name;n.stretch=l.stretch*rec.speed;n.startTime=rec.offset+rec.speed*l.startTime;n.inPoint=rec.lo;n.outPoint=rec.hi;n.enabled=rec.video;
            if(n.hasAudio)n.audioEnabled=rec.audio;
            n.label=l.label;try{n.blendingMode=l.blendingMode;}catch(ignoreBlend){}
            if(s&&!s.hasVideo){if(n.hasAudio)group(l.property("ADBE Audio Group"),n.property("ADBE Audio Group"),rec);count++;return;}
            tp=n.property("ADBE Transform Group");an=val(l,"ADBE Anchor Point",(rec.lo-rec.offset)/rec.speed);tp.property("ADBE Anchor Point").setValue([an[0],an[1]]);
            for(k=0;k<ts.length;k++) {t=(ts[k]-rec.offset)/rec.speed;m=matrix(l,t);op=val(l,"ADBE Opacity",t);
                for(j=rec.chain.length-1;j>=0;j--){c=rec.chain[j];t=(ts[k]-c.offset)/c.speed;m=mul(mul(matrix(c.layer,t),geometry(c.layer,t)),m);op*=val(c.layer,"ADBE Opacity",t)/100;}
                po=point(m,an);scx=Math.sqrt(m[0]*m[0]+m[1]*m[1]);det=m[0]*m[3]-m[1]*m[2];scy=det/scx;
                ps.push(po);ss.push([scx*100,scy*100]);rs.push(Math.atan2(m[1],m[0])*180/Math.PI);ops.push(op);
            }
            tp.property("ADBE Position").setValuesAtTimes(ts,ps);tp.property("ADBE Scale").setValuesAtTimes(ts,ss);tp.property("ADBE Rotate Z").setValuesAtTimes(ts,rs);tp.property("ADBE Opacity").setValuesAtTimes(ts,ops);
            group(l.property("ADBE Mask Parade"),n.property("ADBE Mask Parade"),rec);
            group(l.property("ADBE Effect Parade"),n.property("ADBE Effect Parade"),rec);
            if(n.hasAudio)group(l.property("ADBE Audio Group"),n.property("ADBE Audio Group"),rec);
            count++;
        }
        for(i=leaves.length-1;i>=0;i--)build(leaves[i]);
        for(i=1;i<=dest.numLayers;i++)if(isComp(dest.layer(i).source))fail("Unexpected precomp dependency");
        var unique=[],seen={},w;for(i=0;i<warnings.length;i++){w=warnings[i];if(!seen[w]){seen[w]=true;unique.push(w);}}
        dest.comment="Rebuilt from original media with independent baked animation. No nested compositions.";dest.time=0;dest.openInViewer();
        return {value:{comp:compSummary(dest),mediaLayers:count,precompDependencies:0,warnings:unique},reference:dest};
    }, "comp");
    /* CODEX_AE_EXTRA_FUNCTIONS */
    register("script.run", "Maintenance only: call an archived project-specific JSX branch", true, { branch: "exact archived branch name, including .jsx" }, function (a) {
        var bundle = $.global.__codexAeBundleV1, i, found = false;
        text(a.branch, "args.branch", 256);
        if (!/^[A-Za-z0-9 _.-]+\.jsx$/.test(a.branch) || a.branch.indexOf("..") >= 0) { fail("Invalid installed branch name"); }
        if (!bundle || !bundle.names) { fail("Installed script bundle is unavailable"); }
        for (i = 0; i < bundle.names.length; i += 1) { if (bundle.names[i] === a.branch) { found = true; break; } }
        if (!found) { fail("Installed branch does not exist: " + a.branch); }
    }, function (a) { var result = $.global.__codexAeBundleV1.run(a.branch); return { branch: a.branch, result: typeof result === "undefined" ? null : (typeof result === "object" ? dataValue(result) : result) }; });

    register("comp.seek", "Set the composition viewer time for preview inspection", true, { comp: "optional comp selector", time: "composition time in seconds" }, function (a, refs) {
        selectors(a, refs, false); number(a.time,"args.time",0,10800);
    }, function (a, refs, entry) {
        var c=resolved(a,refs,entry,false).comp;
        if(a.time>=c.duration)fail("Preview time must be before composition end");
        c.time=a.time;c.openInViewer();return compSummary(c);
    });
    function validate(request) {
        var refs = {}, i, step, definition, allowed, captureCalls = 0;
        exact(request, "schema|steps", "request");
        if (request.schema !== SCHEMA) { fail("request.schema must be " + SCHEMA); }
        if (!array(request.steps) || !request.steps.length || request.steps.length > 100) { fail("request.steps must contain 1 to 100 calls"); }
        /* Also reject inherited/prototype data and unsupported values for direct API callers. */
        if (stringify(request).length > MAX_TEXT) { fail("Request data exceeds the text limit"); }
        for (i = 0; i < request.steps.length; i += 1) {
            step = request.steps[i]; exact(step, "function|args|as", "steps[" + i + "]");
            text(step["function"], "steps[" + i + "].function", 128);
            if (!has(definitions, step["function"])) { fail("Unknown installed function: " + step["function"]); }
            definition = definitions[step["function"]]; allowed = keys(definition.args).join("|");
            if (definition.options.exclusive && request.steps.length !== 1) { fail(definition.name + " must be called alone, outside an edit plan"); }
            exact(step.args, allowed, "steps[" + i + "].args"); definition.check(step.args, refs);
            if (definition.name === "inspection.capture") {
                captureCalls += 1;
                if (captureCalls > 1) { fail("Only one inspection.capture call is allowed per request; capture at most 3 frames in that call"); }
            }
            if (has(step, "as")) {
                if (!definition.resultKind) { fail("This function does not create a reference: " + definition.name); }
                text(step.as, "steps[" + i + "].as", 64);
                if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(step.as) || forbidden(step.as) || has(refs, step.as)) { fail("Invalid or duplicate step.as label: " + step.as); }
                refs[step.as] = definition.resultKind;
            }
        }
        return { valid: true, schema: SCHEMA, steps: request.steps.length };
    }
    function preflight(request) {
        var out = [], i, step, a, entry, definition, dynamicComp, dynamicLayer, property, j, priorMutation = false;
        for (i = 0; i < request.steps.length; i += 1) {
            step = request.steps[i]; a = step.args; definition = definitions[step["function"]]; entry = { step: step, definition: definition };
            if (definition.name === "app.memory") { memoryPreflight(a); }
            dynamicComp = a.comp && has(a.comp, "ref"); dynamicLayer = a.layer && has(a.layer, "ref");
            if (definition.name === "project.inspect" || definition.name === "comp.create") { project(); }
            if (has(definition.args, "comp") && !dynamicComp) {
                entry.comp = resolveComp(a, {});
                if (a.layers) {
                    entry.layers = [];
                    for (j = 0; j < a.layers.length; j += 1) { entry.layers.push(has(a.layers[j], "ref") ? null : resolveLayer(entry.comp, a.layers[j], {})); }
                }
                if (a.layer && !dynamicLayer) {
                    entry.layer = resolveLayer(entry.comp, a.layer, {});
                    if (a.path && !priorMutation) {
                        property = resolveProperty(entry.layer, a.path);
                        if ((definition.name === "property.set" || definition.name === "property.keyframes") && typeof property.setValue !== "function") { fail("Selected property cannot be assigned a value"); }
                        if (definition.name === "property.set" && !has(a, "time") && property.numKeys > 0) { fail("Property has keyframes; supply args.time or use property.keyframes"); }
                        if ((definition.name === "property.keyframes" || (definition.name === "property.set" && has(a, "time"))) && !property.canVaryOverTime) { fail("Selected property cannot be keyframed"); }
                        if (definition.name === "property.expression" && !property.canSetExpression) { fail("Selected property does not support expressions"); }
                    }
                    if (definition.name === "effect.add") { property = resolveProperty(entry.layer, ["ADBE Effect Parade"]); if (!property.canAddProperty(a.matchName)) { fail("Effect is unavailable for this layer: " + a.matchName); } }
                    if (definition.name === "layer.update" && !priorMutation) { checkLayerUpdate(entry.layer, a); }
                    if (definition.name === "layer.inspect" && a.properties && !priorMutation) { for (j = 0; j < a.properties.length; j += 1) { resolveProperty(entry.layer, a.properties[j]); } }
                }
            }
            out.push(entry); if (definition.mutates) { priorMutation = true; }
        }
        return out;
    }
    function safeNotify(context, method, args) {
        try { if (context && typeof context[method] === "function") { context[method].apply(context, args); } } catch (ignoreLogError) {}
    }
    function run(request, context) {
        var plan, refs = {}, out = [], i, entry, step, result, wrapped, mutates = false, undoOpen = false, error;
        if (typeof request === "string") { request = parse(request); }
        validate(request); plan = preflight(request);
        for (i = 0; i < plan.length; i += 1) { if (plan[i].definition.mutates && plan[i].definition.options.undo !== false) { mutates = true; } }
        try {
            if (mutates) { app.beginUndoGroup("Codex reusable functions"); undoOpen = true; }
            for (i = 0; i < plan.length; i += 1) {
                entry = plan[i]; step = entry.step;
                entry.context = context || $.global.__CODEX_AE_RUN_CONTEXT__ || null;
                safeNotify(context, "progress", [Math.floor(i * 100 / plan.length), "Step " + (i + 1) + "/" + plan.length + ": " + entry.definition.name]);
                try {
                    result = entry.definition.execute(step.args, refs, entry);
                    if (entry.definition.resultKind) { if (step.as) { refs[step.as] = result.reference; } result = result.value; }
                    wrapped = { "function": entry.definition.name, value: result }; if (step.as) { wrapped.as = step.as; } out.push(wrapped);
                } catch (stepError) {
                    error = new Error("Step " + (i + 1) + "/" + plan.length + " (" + entry.definition.name + ") failed after " + out.length + " completed step(s): " + String(stepError.message || stepError));
                    error.stepIndex = i; error.completedSteps = out.length; error.functionName = entry.definition.name;
                    safeNotify(context, "log", [error.message, "error"]); throw error;
                }
            }
            safeNotify(context, "progress", [100, "Completed " + plan.length + " reusable function(s)"]);
            return { schema: "codex-ae-functions-result/v1", count: out.length, results: out };
        } finally { if (undoOpen) { app.endUndoGroup(); } }
    }
    $.global.__codexAeFunctionsV1 = { version: VERSION, schema: SCHEMA, list: list, parse: parse, stringify: stringify, validate: validate, run: run };
}());
