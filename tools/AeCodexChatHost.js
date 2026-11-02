/* Local Codex app-server client for the AE panel. No API keys or JSX evaluation. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const {spawn} = require("node:child_process");
const EventEmitter = require("node:events");
const {extractMedia,mergeMedia,MediaViewer} = require("./AeCodexChatMedia");
const SAFE = /^[A-Za-z0-9_-]{8,100}$/;
const THREAD = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_JSON = 131072, MAX_STATE = 98304, FRESH_MS = 60000;
const MAX_MODEL_BYTES = 24576;
const STREAM_PUBLISH_MS = 150, IDLE_POLL_MS = 750, ACTIVE_POLL_MS = 200, POINTER_RECHECK_MS = 2000;
const HISTORY_SYNC_MS = 5000, MAX_SKILLS = 256, MAX_SKILL_BYTES = 32768;
const PUBLICATION_RETRY_MS = 10000;
const SKILLS = ["iw-imagegen","kling-cli"];
const INSTRUCTIONS = "You are Codex inside the user's After Effects panel. Respond in Vietnamese unless requested otherwise. For AE work first search ae_functions reusable capabilities, inspect their parameters, then call named tools or JSON plans. Do not create job-specific JSX, arbitrary eval tools, or duplicate scripts. Respect the AE Bridge Stop state and never retry a dispatched or timed-out editing operation automatically. Do not save, close, overwrite, import, render or delete project data unless the user requested it. Use the installed runtime at the current cwd; do not copy credentials or configuration from another machine. For image requests default to the current machine's installed iw-imagegen skill; use its local scripts and configured image model/endpoint, never hard-coded example paths belonging to another user. For video generation or explicit Kling requests read the current machine's kling-cli skill and use only its canonical kling CLI; respect its who_am_i capability checks, explicit model selection, local login and retry requirements. Always read the discovered skill document before invoking it, resolve all relative scripts from that actual local skill folder, and ignore stale absolute example paths in its text. If the needed skill is unavailable, explain the local blocker; do not silently switch provider. Skill discovery does not prove configured credentials, CLI availability, account access or generation success. Do not read or display Kling credentials, copy skill configuration, install/update/login or perform paid generation just to test a connection. After authorized generation show images with Markdown absolute local paths or returned image URLs, and videos with returned works URLs or absolute local paths plus a clickable result link. Preserve returned media URLs and do not automatically resubmit failed, timed-out or uncertain generation. Ask the user through supported approval/input requests when an action requires their decision.";
function fail(code, message) { const e = new Error(message || code); e.code = code; throw e; }
function obj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function isTrustedAeToolApproval(params, state) {
    // Recognize native tool approval metadata, never the human-readable message.
    if(!obj(params) || !state || state.connectionState!=="connected" || state.busy!==true || state.externalBusy ||
        typeof state.activeThreadId!=="string" || !THREAD.test(state.activeThreadId) ||
        typeof state.turnId!=="string" || !THREAD.test(state.turnId) || params.threadId!==state.activeThreadId ||
        params.turnId!=null && params.turnId!==state.turnId || params.serverName!=="ae_functions" || params.mode!=="form")return false;
    const meta=params._meta,schema=params.requestedSchema;
    if(!obj(meta) || meta.codex_approval_kind!=="mcp_tool_call" ||
        ["codex_strict_auto_review","codex_requires_user_input","codex_sensitive_action"].some(k=>meta[k]!==undefined && meta[k]!==false))return false;
    try{if(Buffer.byteLength(JSON.stringify(meta))>16384)return false;}catch(_){return false;}
    if(!obj(schema) || schema.type!=="object" || !obj(schema.properties) || Object.keys(schema.properties).length ||
        schema.required!==undefined && (!Array.isArray(schema.required) || schema.required.length) ||
        Object.keys(schema).some(k=>!["type","properties","required","additionalProperties","$schema","title","description"].includes(k)))return false;
    return true;
}
function fields(v, allowed) { if (!obj(v) || Object.keys(v).some(k => !allowed.includes(k))) fail("INVALID_ARGUMENTS", "Tham số không hợp lệ."); }
function text(v, max, optional) { if (optional && v === undefined) return undefined; if (typeof v !== "string" || v.length > max || v.includes("\0")) fail("INVALID_TEXT", "Nội dung không hợp lệ hoặc quá dài."); return v; }
function id(v) { if (typeof v !== "string" || !THREAD.test(v)) fail("INVALID_THREAD", "Mã cuộc chat không hợp lệ."); return v; }
function assertNoLinks(target, root) {
    const absolute = path.resolve(target), base = path.parse(absolute).root;
    if (root && absolute !== root && !absolute.startsWith(root + path.sep)) fail("PATH_ESCAPE");
    let current = base;
    for (const part of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { if (fs.lstatSync(current).isSymbolicLink()) fail("LINK_PATH", "Không dùng liên kết thư mục cho chat."); }
        catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return absolute;
}
function readJson(file, max = MAX_JSON) {
    assertNoLinks(file);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > max) fail("FILE_LIMIT");
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}
function fileRevision(file,max) {
    const stat=fs.lstatSync(file,{bigint:true});
    if(stat.isSymbolicLink())fail("LINK_PATH");
    if(!stat.isFile() || stat.size>BigInt(max))fail("FILE_LIMIT");
    return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(":");
}
function atomic(file, data, immutable = false) {
    assertNoLinks(file);
    const tmp = file + ".tmp-" + crypto.randomBytes(6).toString("hex"),encoded=JSON.stringify(data)+"\n";let descriptor,owned=false;
    try {
        descriptor=fs.openSync(tmp,"wx");owned=true;fs.writeFileSync(descriptor,encoded);fs.closeSync(descriptor);descriptor=undefined;
        if (immutable) {try{fs.linkSync(tmp, file);}catch(error){if(error.code!=="EEXIST")throw error;}}
        else fs.renameSync(tmp, file);
    } finally {if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch(_){}if(owned)try { fs.unlinkSync(tmp); } catch (_) {}}
}
function transientPublicationError(error) {return error && ["EPERM","EACCES","EBUSY"].includes(error.code);}
function compact(v, max) { return String(v == null ? "" : v).slice(0, max); }
function unavailableSkills(error) {return SKILLS.map(name=>({id:name,name,available:false,...(error?{error}:{})}));}
function modelValue(value,max=200) {return typeof value==="string" && value.length>0 && value.length<=max && !/[\x00-\x1f\x7f]/.test(value)?value:null;}
function modelEntries(data) {
    if(!Array.isArray(data) || data.length>128 || data.some(entry=>!obj(entry)))fail("MODEL_DISCOVERY_FAILED");
    return data.filter(entry=>entry.hidden!==true).map(entry=>{
        const model=modelValue(entry.model),entryId=modelValue(entry.id);
        if(!model || !entryId || !Array.isArray(entry.supportedReasoningEfforts) || entry.supportedReasoningEfforts.length>16)fail("MODEL_DISCOVERY_FAILED");
        const efforts=[];
        for(const option of entry.supportedReasoningEfforts){const value=obj(option) && modelValue(option.reasoningEffort,64);if(!value)fail("MODEL_DISCOVERY_FAILED");if(!efforts.some(e=>e.reasoningEffort===value))efforts.push({reasoningEffort:value,description:compact(option.description,120)});}
        const defaultEffort=modelValue(entry.defaultReasoningEffort,64);
        if(!defaultEffort)fail("MODEL_DISCOVERY_FAILED");
        return {id:entryId,model,displayName:compact(entry.displayName || model,120),description:compact(entry.description,240),supportedReasoningEfforts:efforts,defaultReasoningEffort:defaultEffort,isDefault:entry.isDefault===true,...(Array.isArray(entry.inputModalities)?{inputModalities:[...new Set(entry.inputModalities.map(v=>modelValue(v,32)).filter(Boolean))].slice(0,8)}:{})};
    });
}
function localSkills(result, workspace) {
    // The server owns discovery. Panel requests may only select these IDs, never a path.
    const entries=result && Array.isArray(result.data)?result.data:[];
    const entry=entries.find(v=>obj(v) && typeof v.cwd==="string" && path.resolve(v.cwd)===workspace);
    if(!entry || !Array.isArray(entry.skills))fail("SKILL_DISCOVERY_FAILED");
    if(entry.skills.length>4096)fail("SKILL_CATALOG_LIMIT");
    const catalog=[],seen=new Set();
    for(const skill of entry.skills){
        if(!obj(skill) || skill.enabled!==true || typeof skill.name!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(skill.name) || seen.has(skill.name))continue;
        if(typeof skill.path!=="string" || skill.path.length>4096 || /[\x00-\x1f]/.test(skill.path) || !path.isAbsolute(skill.path) || path.basename(skill.path).toLowerCase()!=="skill.md")continue;
        try {const stat=fs.statSync(skill.path);if(!stat.isFile() || stat.size>1024*1024)continue;}catch(_){continue;}
        seen.add(skill.name);catalog.push({id:skill.name,name:skill.name,available:true,path:path.resolve(skill.path),description:compact(skill.interface && skill.interface.shortDescription || skill.shortDescription || skill.description,120)});
        if(catalog.length>MAX_SKILLS)fail("SKILL_CATALOG_LIMIT");
    }
    // Keep useful setup diagnostics for the two media defaults without hiding other installed skills.
    for(const name of SKILLS)if(!seen.has(name) && catalog.length<MAX_SKILLS){
        const matches=entry.skills.filter(s=>obj(s) && s.name===name);
        catalog.push({id:name,name,available:false,error:matches.some(s=>s.enabled===false)?"Skill đang tắt trong Codex trên máy này.":matches.length?"Không tìm thấy tệp SKILL.md hợp lệ trên máy này.":"Chưa cài skill này trong Codex trên máy này."});
    }
    if(catalog.length>MAX_SKILLS)fail("SKILL_CATALOG_LIMIT");
    return catalog;
}
function publicSkills(catalog) {
    // Paths stay in the trusted host. The picker needs only names and short descriptions.
    const result=catalog.map(({path:_,...entry})=>entry);
    for(const limit of [120,64,0]){
        for(const entry of result)if(entry.description!==undefined)entry.description=compact(entry.description,limit);
        if(Buffer.byteLength(JSON.stringify(result))<=MAX_SKILL_BYTES)return result;
    }
    fail("SKILL_CATALOG_LIMIT");
}
function publicError(e) {
    const messages = {AUTH_REQUIRED:"Hãy đăng nhập Codex trên máy này rồi kết nối lại.", CODEX_NOT_FOUND:"Chưa tìm thấy Codex trên máy này. Hãy cài và đăng nhập Codex trước.", THREAD_BUSY:"Cuộc chat đang chạy. Hãy chờ hoàn tất ở cửa sổ Codex trước khi tiếp tục.", CHAT_BUSY:"Chat đang xử lý. Hãy chờ hoặc bấm Dừng chat.", SESSION_MISMATCH:"Phiên chat đã đổi. Hãy kết nối lại.", STALE_REQUEST:"Yêu cầu đã hết hạn; chưa tự gửi lại.", ALREADY_DISPATCHED:"Yêu cầu đã được tiếp nhận trước đó; không gửi lại để tránh chạy trùng.", RPC_TIMEOUT:"Codex chưa trả lời đúng hạn. Không tự gửi lại; kiểm tra cuộc chat trước khi tiếp tục.", RPC_CLOSED:"Kết nối Codex đã đóng. Không tự gửi lại yêu cầu.", IMAGE_INVALID:"Ảnh không hợp lệ. Chọn PNG, JPEG, GIF hoặc WebP tối đa20MB mỗi ảnh.", INVALID_ARGUMENTS:"Tham số chat không hợp lệ.", INVALID_TEXT:"Nội dung quá dài hoặc không hợp lệ.", UNSUPPORTED_APPROVAL:"Yêu cầu này chưa được hỗ trợ trong panel. Hãy từ chối hoặc mở Codex để xử lý.", RPC_ERROR:"Codex trả về lỗi. Kiểm tra phiên đăng nhập và cuộc chat trong Codex.", EMPTY_INPUT:"Nhập yêu cầu hoặc chọn ảnh trước khi gửi.", THREAD_REQUIRED:"Hãy chọn hoặc tạo một cuộc chat trước.", IMAGE_LIMIT:"Mỗi yêu cầu hỗ trợ tối đa8 ảnh và40MB.", HOST_STOPPED:"Chat đã dừng.", THREAD_NOT_SELECTED:"Hãy mở cuộc chat này trước khi gửi."};
    Object.assign(messages,{SKILL_INVALID:"Chọn tối đa 8 skill trong danh sách Codex trên máy này.",SKILL_UNAVAILABLE:"Skill đã chọn chưa sẵn sàng trên máy này. Mở mục Skill để xem và làm mới.",SKILL_DISCOVERY_FAILED:"Chưa đọc được danh sách skill từ Codex trên máy này. Hãy làm mới mục Skill.",SKILL_CATALOG_LIMIT:"Danh sách skill vượt giới hạn 256 mục hoặc dung lượng hiển thị. Hãy tắt bớt skill trong Codex rồi làm mới; danh sách chưa được cắt bớt để sử dụng.",MEDIA_INVALID:"Kết quả ảnh/video không còn trong cuộc chat đang mở.",MEDIA_EMPTY:"Cuộc chat chưa có ảnh hoặc video có thể xem.",MEDIA_LAUNCH:"Chưa mở được cửa sổ xem ảnh/video. Hãy thử lại nút xem kết quả."});
    Object.assign(messages,{MODEL_DISCOVERY_FAILED:"Chưa đọc được danh sách model từ Codex trên máy này. Hãy làm mới mục Model.",MODEL_CATALOG_UNAVAILABLE:"Danh sách model chưa sẵn sàng. Hãy làm mới hoặc giữ thiết lập của cuộc chat.",MODEL_UNAVAILABLE:"Model đã chọn không có trong danh sách Codex trên máy này. Hãy làm mới và chọn lại.",EFFORT_UNSUPPORTED:"Mức nỗ lực này không được model hỗ trợ. Hãy chọn mức khác.",MODEL_REQUIRED:"Hãy chọn model trước khi chọn mức nỗ lực.",MODEL_IMAGE_UNSUPPORTED:"Model đã chọn không hỗ trợ ảnh. Hãy chọn model khác hoặc bỏ ảnh đính kèm."});
    Object.assign(messages,{STEER_UNAVAILABLE:"Chỉ có thể chuyển hướng lượt đang chạy từ khung chat AE. Lượt chạy trong Codex đang được đồng bộ lịch sử.",STEER_STALE:"Lượt chạy đã thay đổi hoặc kết thúc. Nội dung chưa được gửi sang lượt khác."});
    messages.MEDIA_PREVIEW_DISABLED="Đã tắt ảnh thu nhỏ để giảm RAM. Bấm Mở ảnh/video để xem kết quả khi cần.";
    messages.STALE_SERVER_REQUEST="Câu hỏi hoặc yêu cầu này đã hết hiệu lực. Nội dung chưa được gửi sang lượt chạy khác.";
    return {code:compact(e.code || "CHAT_ERROR",64),message:messages[e.code] || (e.code && /^(INVALID|PATH|LINK|FILE)_/.test(e.code) ? "Dữ liệu chat không hợp lệ." : "Không thể xử lý chat. Hãy kiểm tra Codex trên máy này và kết nối lại.")};
}
function validateImage(file) {
    if (typeof file !== "string" || !path.isAbsolute(file) || file.length > 4096) fail("IMAGE_INVALID");
    assertNoLinks(file);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 8 || stat.size > 20*1024*1024) fail("IMAGE_INVALID");
    const ext = path.extname(file).toLowerCase(), head = Buffer.alloc(16), fd = fs.openSync(file,"r");
    try { fs.readSync(fd,head,0,16,0); } finally { fs.closeSync(fd); }
    const valid = (ext === ".png" && head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
        ([".jpg",".jpeg"].includes(ext) && head[0]===255 && head[1]===216 && head[2]===255) ||
        (ext === ".gif" && /^GIF8[79]a/.test(head.toString("ascii"))) ||
        (ext === ".webp" && head.toString("ascii",0,4)==="RIFF" && head.toString("ascii",8,12)==="WEBP");
    if (!valid) fail("IMAGE_INVALID");
    return {path:path.resolve(file),size:stat.size};
}
function findCodex(env = process.env) {
    const candidates = [];
    for (const dir of String(env.PATH || env.Path || "").split(path.delimiter)) if (dir) candidates.push(path.join(dir,process.platform === "win32" ? "codex.exe" : "codex"));
    if (process.platform === "win32" && env.LOCALAPPDATA) {
        const bins = path.join(env.LOCALAPPDATA,"OpenAI","Codex","bin");
        try { for (const d of fs.readdirSync(bins)) candidates.push(path.join(bins,d,"codex.exe")); } catch (_) {}
    }
    const found = candidates.filter(p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
    // Prefer the user's PATH; otherwise the newest installed Desktop runtime.
    const fromPath = found.find(p => candidates.slice(0,String(env.PATH || env.Path || "").split(path.delimiter).length).includes(p));
    if (fromPath) return assertNoLinks(fromPath);
    found.sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (!found.length) fail("CODEX_NOT_FOUND");
    return assertNoLinks(found[0]);
}
function appServerArgs(workspace) {
    const server = path.join(workspace,"tools","AeFunctionsMcp.js");
    if (!fs.existsSync(server)) fail("INVALID_RUNTIME");
    const q = v => JSON.stringify(v);
    return ["app-server","--listen","stdio://", "-c","mcp_servers.ae_functions.command="+q(process.execPath),
        "-c","mcp_servers.ae_functions.args="+q([server]),"-c","mcp_servers.ae_functions.cwd="+q(workspace),
        "-c","mcp_servers.ae_functions.enabled=true","-c","mcp_servers.ae_functions.required=true",
        "-c",'approval_policy="never"',"-c",'sandbox_mode="danger-full-access"',
        "-c",'mcp_servers.ae_functions.default_tools_approval_mode="approve"'];
}
class Rpc extends EventEmitter {
    constructor(workspace, options={}) { super(); this.workspace=workspace; this.options=options; this.pending=new Map(); this.sequence=0; this.closed=false; }
    async open() {
        const exe=this.options.executable || findCodex();
        this.child=(this.options.spawn || spawn)(exe,appServerArgs(this.workspace),{cwd:this.workspace,windowsHide:true,stdio:["pipe","pipe","pipe"]});
        const child=this.child;
        child.stderr.on("data",()=>{}); // Never persist raw account/server diagnostics.
        let bytes=0;
        child.stdout.on("data",chunk=>{bytes+=chunk.length;if(bytes>16*1024*1024 && !String(chunk).includes("\n"))this.close(); if(String(chunk).includes("\n"))bytes=0;});
        const lines=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
        lines.on("line",line=>{if(Buffer.byteLength(line)>16*1024*1024){this.close();return;}try{this.receive(JSON.parse(line));}catch(_){}});
        child.on("error",()=>this.end()); child.on("close",()=>{this.processExited=true;this.end();this.emit("exited");});
        await this.call("initialize",{clientInfo:{name:"codex_ae",title:"Codex AE",version:"1.1.0"},capabilities:{experimentalApi:true}});
        this.notify("initialized",{});
    }
    receive(message) {
        if (Object.prototype.hasOwnProperty.call(message,"id") && !message.method) {
            const entry=this.pending.get(String(message.id)); if(!entry)return;
            clearTimeout(entry.timer);this.pending.delete(String(message.id));
            if(message.error){const e=new Error("Codex RPC error");e.code=message.error.code===-32600 && /^thread [A-Za-z0-9_-]+ is not materialized yet; thread\/(?:turns|items)\/list is unavailable before first user message$/.test(String(message.error.message || ""))?"THREAD_UNMATERIALIZED":"RPC_ERROR";e.rpcCode=message.error.code;entry.reject(e);}else entry.resolve(message.result);
        } else if(message.method && Object.prototype.hasOwnProperty.call(message,"id")) this.emit("request",message);
        else if(message.method) this.emit("notification",message);
    }
    write(message) { if(this.closed || !this.child || this.child.stdin.destroyed) fail("RPC_CLOSED"); this.child.stdin.write(JSON.stringify(message)+"\n"); }
    notify(method,params) { this.write({method,params}); }
    reply(requestId,result) { this.write({id:requestId,result}); }
    reject(requestId) { this.write({id:requestId,error:{code:-32601,message:"Unsupported client request; not approved."}}); }
    call(method,params,timeout=30000) {
        return new Promise((resolve,reject)=>{const requestId=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(String(requestId));const e=new Error("RPC timeout");e.code="RPC_TIMEOUT";reject(e);},timeout);this.pending.set(String(requestId),{resolve,reject,timer});try{this.write({id:requestId,method,params});}catch(e){clearTimeout(timer);this.pending.delete(String(requestId));reject(e);}});
    }
    end() {if(this.closed)return;this.closed=true;for(const e of this.pending.values()){clearTimeout(e.timer);const err=new Error("RPC closed");err.code="RPC_CLOSED";e.reject(err);}this.pending.clear();this.emit("closed");}
    close() {
        if(this.child && !this.child.stdin.destroyed)this.child.stdin.end();this.end();
        if(this.processExited || !this.child)return Promise.resolve(true);
        return new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.removeListener("exited",done);resolve(true);};const timer=setTimeout(()=>{this.removeListener("exited",done);resolve(false);},5000);this.once("exited",done);});
    }
}
function threadSummary(t) { return {id:id(t.id),title:compact(t.name || t.preview || "Cuộc chat",180),preview:compact(t.preview,300),cwd:compact(t.cwd,4096),status:compact(t.status && t.status.type || "notLoaded",40)}; }
function isBusy(t) {return t && (t.status === "inProgress" || t.status && (t.status.type === "active" || t.status.type === "inProgress"));}
function itemMessage(item, turnId) {
    if (!item || !item.id) return null;
    const value={id:compact(item.id,180),type:compact(item.type,80),turnId:compact(turnId,180),role:"tool",text:"",...(typeof item.phase==="string"?{phase:compact(item.phase,40)}:{}),...(typeof item.status==="string"?{status:compact(item.status,40)}:{})};
    if(item.type === "userMessage") {value.role="user";value.images=[];for(const input of item.content || []){if(input.type === "text")value.text+=String(input.text || "")+"\n";if(input.type === "localImage")value.images.push(compact(input.path,4096));if(input.type === "image")value.text+="[Ảnh đính kèm]\n";}if(!value.images.length)delete value.images;}
    else if(item.type === "agentMessage") {value.role="assistant";value.text=compact(item.text,24000);}
    else if(["mcpToolCall","dynamicToolCall"].includes(item.type)) value.text=[item.server,item.tool,item.status].filter(Boolean).join(" · ");
    else if(item.type === "commandExecution") value.text="Chạy lệnh · "+compact(item.status,40);
    else if(item.type === "fileChange") value.text="Thay đổi tệp · "+compact(item.status,40);
    else if(item.type === "plan") {value.role="assistant";value.text=compact(item.text,12000);}
    else if(item.type === "error") value.text="Codex báo lỗi.";
    else if(item.type==="imageGeneration")value.text="Công cụ tạo ảnh · "+compact(item.status,40);
    else if(item.type==="imageView")value.text="Đã xem ảnh tham chiếu";
    else return null;
    value.text=compact(value.text.trim(),24000); return value;
}
class ChatHost {
    constructor(workspace, options={}) {
        this.workspace=assertNoLinks(path.resolve(workspace));this.dir=path.join(this.workspace,".ae-codex","chat");this.options=options;
        this.rpc=null;this.viewer=null;this.resumed=new Set();this.pending=new Map();this.itemDetails=new Map();this.startedAt=Date.now();this.processing=false;this.stopping=false;this.interrupted=new Set();this.terminalWaiters=new Set();this.autoApprovalReplies=new Set();
        this.agentCandidates=new Map();this.agentSequence=0;this.localTurn=null;this.steerInFlight=false;this.knownTurnStates=new Map();this.knownTurnThread=null;
        this.publishTimer=null;this.dirtyMedia=new Set();this.consumedPointer=null;this.stopCache=null;
        this.localSkillCatalog=[];this.historyEpoch=0;this.historySyncAt=0;this.historySyncing=false;this.historyRevision=null;this.historyCursor=null;this.historyItemCache=new Map();this.historyItemCacheThread=null;this.historyPageRevision=null;
        this.lastTranscript=null;this.lastModels=null;this.lastActivity=null;
        this.publications=new Map();this.publicationTimer=null;this.publicationClosing=false;this.publicationClosed=false;
        this.metrics={notifications:0,streamUpdates:0,coalescedUpdates:0,statePublishes:0,stateDiskWrites:0,statePublishErrors:0,publicationRetries:0,publicationDeferrals:0,publicationSuperseded:0,mediaExtractions:0,itemFormats:0,historyItemCacheHits:0,historyItemCacheMisses:0,pointerStatChecks:0,pointerReads:0,pointerCacheHits:0,requestReads:0,stopStatChecks:0,stopReads:0,stopCacheHits:0,heartbeatWrites:0,loopTicks:0};
        this.state={schema:"codex-ae-chat-state/v1",hostInstanceId:crypto.randomBytes(12).toString("hex"),sessionNonce:"",connectionState:"disconnected",status:"Chưa kết nối",threads:[],nextCursor:null,historyNextCursor:null,activeThreadId:null,activeModel:null,activeEffort:null,turnId:null,busy:false,externalBusy:false,canSteer:false,syncScope:"selected-local-thread",thumbnailsEnabled:false,messages:[],activity:[],media:[],skills:unavailableSkills(),skillsStatus:"stale",models:[],modelsStatus:"stale",transcriptRevision:0,activityRevision:0,modelsRevision:0,pendingRequests:[],events:[],updatedAtEpochMs:Date.now()};
    }
    setup() {assertNoLinks(this.dir,this.workspace);fs.mkdirSync(this.dir,{recursive:true});for(const d of ["requests","results","started"])fs.mkdirSync(path.join(this.dir,d),{recursive:true});}
    recordHostError(error,stage) {
        // No exception messages, paths, stdout, tool content or account details in diagnostics.
        try {
            assertNoLinks(this.dir,this.workspace);fs.mkdirSync(this.dir,{recursive:true});const file=path.join(this.dir,"host-errors.jsonl");assertNoLinks(file,this.workspace);
            try{if(fs.statSync(file).size>65536){const prior=file+".1";assertNoLinks(prior,this.workspace);try{fs.unlinkSync(prior);}catch(_){}fs.renameSync(file,prior);}}catch(_){}
            const safe=value=>typeof value==="string" && /^[A-Za-z0-9_/-]{1,80}$/.test(value)?value:"unknown";
            fs.appendFileSync(file,JSON.stringify({schema:"codex-ae-chat-host-error/v1",timestampEpochMs:Date.now(),pid:process.pid,hostInstanceId:this.state.hostInstanceId,stage:safe(stage),code:safe(error && error.code),syscall:safe(error && error.syscall)})+"\n");
        }catch(_){}
    }
    schedulePublicationRetry() {
        if(this.publicationTimer || this.publicationClosing || !this.publications.size)return;
        const due=Array.from(this.publications.values()).map(entry=>entry.nextAt-Date.now()).filter(Number.isFinite);if(!due.length)return;
        const delay=Math.max(10,Math.min(...due));
        this.publicationTimer=setTimeout(()=>{this.publicationTimer=null;this.retryPublications();},delay);this.publicationTimer.unref();
    }
    attemptPublication(entry) {
        if(this.publicationClosed)return false;
        try {
            atomic(entry.file,entry.data,entry.immutable===true);this.publications.delete(entry.kind);
            if(entry.kind==="state")this.metrics.stateDiskWrites++;else if(entry.kind==="heartbeat")this.metrics.heartbeatWrites++;
            return true;
        }catch(error){
            this.metrics.statePublishErrors++;
            if(entry.attempts===0)this.recordHostError(error,"publish-"+entry.label);
            entry.attempts++;
            if(!transientPublicationError(error)){this.recordHostError(error,"publish-exhausted-"+entry.label);entry.nextAt=Infinity;this.publications.set(entry.kind,entry);return false;}
            const exhausted=Date.now()-entry.firstAt>=PUBLICATION_RETRY_MS;if(exhausted && !entry.exhausted){this.recordHostError(error,"publish-slow-"+entry.label);entry.exhausted=true;}
            entry.nextAt=Date.now()+(exhausted?1000:Math.min(500,20*Math.pow(2,Math.min(entry.attempts-1,5))));this.publications.set(entry.kind,entry);this.metrics.publicationDeferrals++;this.schedulePublicationRetry();return false;
        }
    }
    publishSnapshot(kind,file,data) {
        if(this.publicationClosed || this.publicationClosing)return false;
        const pending=this.publications.get(kind);
        if(pending){pending.data=data;this.metrics.publicationSuperseded++;if(!Number.isFinite(pending.nextAt)){pending.firstAt=Date.now();pending.attempts=0;pending.nextAt=Date.now();return this.attemptPublication(pending);}this.schedulePublicationRetry();return false;}
        return this.attemptPublication({kind,label:kind,file,data,firstAt:Date.now(),attempts:0,nextAt:Date.now()});
    }
    publishTerminal(requestId,file,data) {
        if(this.publicationClosed){this.recordHostError({code:"PUBLICATION_CLOSED"},"unpublished-result");return false;}
        const kind="terminal-"+requestId;if(this.publications.has(kind))return false;
        if(Array.from(this.publications.values()).filter(entry=>entry.immutable).length>=8){this.recordHostError({code:"PUBLICATION_QUEUE_FULL"},"unpublished-result");return false;}
        return this.attemptPublication({kind,label:"result",file,data,immutable:true,firstAt:Date.now(),attempts:0,nextAt:Date.now()});
    }
    retryPublications() {
        if(this.publicationClosed)return;
        for(const entry of Array.from(this.publications.values()))if(entry.nextAt<=Date.now()){this.metrics.publicationRetries++;this.attemptPublication(entry);}
        this.schedulePublicationRetry();
    }
    async drainPublications(timeout=1500) {
        const deadline=Date.now()+timeout;
        while(this.publications.size && Date.now()<deadline){this.retryPublications();if(this.publications.size)await new Promise(resolve=>setTimeout(resolve,20));}
        return this.publications.size===0;
    }
    closePublications() {
        if(this.publicationClosed)return;
        this.publicationClosing=true;this.publicationClosed=true;
        if(this.publicationTimer){clearTimeout(this.publicationTimer);this.publicationTimer=null;}
        for(const entry of this.publications.values())this.recordHostError({code:"PUBLICATION_UNCONFIRMED"},"unpublished-"+entry.label);
        this.publications.clear();
    }
    async publishImmutable(file,data,stage) {
        const deadline=Date.now()+1500;let attempts=0;
        for(;;){
            if(this.stopping || this.publicationClosing || this.publicationClosed)fail("HOST_STOPPED");
            try{atomic(file,data,true);return;}
            catch(error){if(attempts===0)this.recordHostError(error,stage);if(!transientPublicationError(error) || Date.now()>=deadline){this.recordHostError(error,stage+"-exhausted");throw error;}this.metrics.publicationRetries++;await new Promise(resolve=>setTimeout(resolve,Math.min(200,20*Math.pow(2,Math.min(attempts++,4)))));}
        }
    }
    event(message) {this.state.events.push(compact(message,300));this.state.events=this.state.events.slice(-30);this.save();}
    queueSave() {
        if(this.publicationClosed || this.publicationClosing)return;
        this.metrics.streamUpdates++;
        if(this.publishTimer){this.metrics.coalescedUpdates++;return;}
        // A fixed window, rather than a resettable debounce, keeps long streams visible.
        this.publishTimer=setTimeout(()=>{this.publishTimer=null;try{this.save();}catch(_){this.metrics.statePublishErrors++;}},STREAM_PUBLISH_MS);
        this.publishTimer.unref();
    }
    messageFromItem(item,turnId) {this.metrics.itemFormats++;return itemMessage(item,turnId);}
    finalMessage(value) {
        const final={...value};this.metrics.mediaExtractions++;
        const media=extractMedia({type:"agentMessage",text:final.text});if(media.length)final.media=media;
        return final;
    }
    activityValue(value) {const {media:_,images:__,...activity}=value;activity.text=compact(activity.text,1200);return activity;}
    appendActivity(value) {
        const activity=this.activityValue(value),at=this.state.activity.findIndex(item=>item.id===activity.id && item.turnId===activity.turnId);
        if(at>=0)this.state.activity[at]=activity;else this.state.activity.push(activity);
        this.state.activity=this.state.activity.slice(-30);
    }
    rememberAgent(value) {
        const key=value.turnId+"/"+value.id,previous=this.agentCandidates.get(key);
        if(previous && value.phase===undefined && previous.value.phase!==undefined)value.phase=previous.value.phase;
        this.agentCandidates.set(key,{value,sequence:previous?previous.sequence:++this.agentSequence});
        while(this.agentCandidates.size>32){const removable=Array.from(this.agentCandidates).find(([,entry])=>entry.value.phase!=="final_answer");this.agentCandidates.delete(removable?removable[0]:this.agentCandidates.keys().next().value);}
        this.appendActivity(value);
    }
    promoteFinal(turnId) {
        const agents=Array.from(this.agentCandidates.values()).filter(entry=>entry.value.turnId===turnId).sort((a,b)=>a.sequence-b.sequence);
        const explicit=agents.filter(entry=>entry.value.phase==="final_answer"),legacy=agents.filter(entry=>entry.value.phase===undefined),chosen=(explicit.length?explicit:legacy).at(-1);
        if(chosen){this.state.messages=this.state.messages.filter(item=>!(item.type==="agentMessage" && item.turnId===turnId));this.appendMessage(this.finalMessage(chosen.value));this.state.activity=this.state.activity.filter(item=>!(item.id===chosen.value.id && item.turnId===turnId));}
        for(const [key,entry] of this.agentCandidates)if(entry.value.turnId===turnId)this.agentCandidates.delete(key);
    }
    rememberTurns(threadId,turns) {if(this.knownTurnThread!==threadId){this.knownTurnStates.clear();this.knownTurnThread=threadId;}for(const turn of turns || [])if(turn && typeof turn.id==="string" && THREAD.test(turn.id)){this.knownTurnStates.set(turn.id,typeof turn.status==="string"?turn.status:turn.status && turn.status.type);while(this.knownTurnStates.size>1000)this.knownTurnStates.delete(this.knownTurnStates.keys().next().value);}}
    historyMessages(history,threadId,activeTurns=new Set()) {
        // Cache only one bounded page of already-discovered display data, never tool arguments.
        const previous=this.historyItemCacheThread===threadId?this.historyItemCache:new Map(),next=new Map(),entries=[],page=crypto.createHash("sha256");
        for(const entry of (history.data || []).slice(0,320)){
            const key=compact(entry.turnId,180)+"/"+compact(entry.item && entry.item.id,180),fingerprint=crypto.createHash("sha256").update(JSON.stringify({turnId:entry.turnId,item:entry.item})).digest("hex"),cached=previous.get(key);
            page.update(key+"\0"+fingerprint+"\0");let value;
            let record;
            if(cached && cached.fingerprint===fingerprint){this.metrics.historyItemCacheHits++;value=cached.value;record=cached;}
            else {this.metrics.historyItemCacheMisses++;value=this.messageFromItem(entry.item,entry.turnId);}
            record=record || {fingerprint,value};if(next.size<40)next.set(key,record);if(value)entries.push(record);
        }
        this.historyItemCache=next;this.historyItemCacheThread=threadId;
        const ordered=entries.reverse(),chosen=new Map();
        for(const entry of ordered){const value=entry.value;if(value.type!=="agentMessage" || activeTurns.has(value.turnId))continue;const terminal=["completed","interrupted","failed"].includes(this.knownTurnStates.get(value.turnId)),key=value.turnId || "legacy-history",prior=chosen.get(key);if(value.phase==="final_answer" || value.phase===undefined && terminal && (!prior || prior.value.phase!=="final_answer"))chosen.set(key,entry);}
        const selected=new Set(Array.from(chosen.values())),messages=[],activity=[];
        for(const entry of ordered){const value=entry.value;if(value.role==="user")messages.push(value);else if(selected.has(entry)){if(!entry.finalValue)entry.finalValue=this.finalMessage(value);messages.push(entry.finalValue);}else activity.push(this.activityValue(value));}
        page.update(JSON.stringify(Array.from(activeTurns).sort())+JSON.stringify(ordered.map(entry=>[entry.value.turnId,this.knownTurnStates.get(entry.value.turnId)])));
        return {messages,activity:activity.slice(-30),revision:page.digest("hex")};
    }
    appendMessage(value) {
        const at=this.state.messages.findIndex(item=>item.id===value.id && item.turnId===value.turnId);if(at>=0){this.state.messages[at]=value;return;}
        if(this.state.messages.length>=100){const removed=this.state.messages.shift();this.dirtyMedia.delete(removed.id);this.state.messagesTruncated=true;}
        this.state.messages.push(value);
    }
    canSteer() {return !this.stopping && !this.steerInFlight && this.state.connectionState==="connected" && this.rpc && !this.rpc.closed && this.state.busy && !this.state.externalBusy && this.localTurn && this.localTurn.threadId===this.state.activeThreadId && this.localTurn.turnId===this.state.turnId && !!this.state.turnId;}
    normalizedMedia(messages) {return mergeMedia(messages.filter(message=>message.role==="assistant" && message.type!=="codexQuestion"));}
    save() {
        if(this.publicationClosed || this.publicationClosing)return;
        if(this.publishTimer){clearTimeout(this.publishTimer);this.publishTimer=null;}
        this.dirtyMedia.clear();
        this.state.canSteer=!!this.canSteer();
        this.state.updatedAtEpochMs=Date.now();this.state.pendingRequests=Array.from(this.pending.values()).map(p=>p.display).slice(0,8);
        // Strip any thumbnail metadata retained by an older panel or cached item.
        this.state.thumbnailsEnabled=false;
        for(const message of this.state.messages)if(message.media)message.media=mergeMedia([{media:message.media}]);
        let bytes=0, truncated=false; const kept=[],encodedMessages=[];
        for(let n=this.state.messages.length-1;n>=0;n--){const m=this.state.messages[n];m.text=compact(m.text,24000);const encoded=JSON.stringify(m),size=Buffer.byteLength(encoded);if(bytes+size>49152){truncated=true;continue;}bytes+=size;kept.unshift(m);encodedMessages.unshift(encoded);if(kept.length>=100){truncated=n>0;break;}}
        this.state.messages=kept;this.state.activity=this.state.activity.slice(-30).map(value=>this.activityValue(value));this.state.media=this.normalizedMedia(kept);this.state.messagesTruncated=truncated || !!this.state.messagesTruncated;
        let output=JSON.parse(JSON.stringify(this.state));
        // Reserve room for both revision counters to grow before the final atomic publication.
        const snapshotLimit=MAX_STATE-64;
        while(Buffer.byteLength(JSON.stringify(output))>snapshotLimit && output.activity.length)output.activity.shift();
        while(Buffer.byteLength(JSON.stringify(output))>snapshotLimit && output.messages.length){output.messages.shift();output.media=this.normalizedMedia(output.messages);output.messagesTruncated=true;}
        while(Buffer.byteLength(JSON.stringify(output))>snapshotLimit && output.threads.length)output.threads.pop();
        if(Buffer.byteLength(JSON.stringify(output))>snapshotLimit) {output.pendingRequests=output.pendingRequests.map(p=>({id:p.id,kind:p.kind==="question"?"unsupported":p.kind,prompt:compact(p.prompt,400),...(p.kind==="approval"?{decisions:p.decisions}:{}),details:"Nội dung dài; mở Codex để xem đầy đủ."}));output.events=output.events.slice(-5);}
        this.state.messages=output.messages;this.state.media=output.media;this.state.activity=output.activity;
        const transcript=encodedMessages.slice(kept.length-output.messages.length).join(",")+"|"+JSON.stringify(output.media)+"|"+output.messagesTruncated,models=JSON.stringify(output.models),activity=JSON.stringify(output.activity);
        if(transcript!==this.lastTranscript){this.lastTranscript=transcript;this.state.transcriptRevision++;}output.transcriptRevision=this.state.transcriptRevision;
        if(models!==this.lastModels){this.lastModels=models;this.state.modelsRevision++;}output.modelsRevision=this.state.modelsRevision;
        if(activity!==this.lastActivity){this.lastActivity=activity;this.state.activityRevision++;}output.activityRevision=this.state.activityRevision;
        this.metrics.statePublishes++;
        if(this.options.onState)this.options.onState(output);
        if(!this.options.memoryOnly)this.publishSnapshot("state",path.join(this.dir,"state.json"),output);
    }
    async connect(sessionNonce) {
        if(this.state.busy && !this.state.externalBusy && sessionNonce!==this.state.sessionNonce)fail("CHAT_BUSY");
        this.state.sessionNonce=sessionNonce;
        if(this.rpc && !this.rpc.closed){this.state.connectionState="connected";try{await this.refreshSkills({});}catch(_){}try{await this.refreshModels({});}catch(_){}this.save();return;}
        this.state.connectionState="connecting";this.state.status="Đang kết nối Codex trên máy này…";delete this.state.error;this.save();
        const rpc=this.options.rpcFactory?this.options.rpcFactory():new Rpc(this.workspace);
        this.autoApprovalReplies.clear();
        this.rpc=rpc;rpc.on("notification",m=>this.notification(m));rpc.on("request",m=>this.serverRequest(m));rpc.on("closed",()=>{this.state.connectionState="disconnected";this.localSkillCatalog=[];this.state.skills=unavailableSkills("Hãy kết nối lại Codex để kiểm tra skill.");this.state.skillsStatus="stale";this.state.models=[];this.state.modelsStatus="stale";delete this.state.modelsError;this.state.activeModel=null;this.state.activeEffort=null;this.state.status="Kết nối Codex đã đóng";if(this.state.busy)this.state.error={code:"TURN_STATE_UNKNOWN",message:"Kết nối đã đóng khi đang chạy. Kiểm tra cuộc chat trước khi gửi tiếp."};this.pending.clear();this.resumed.clear();this.save();});
        try {await rpc.open();const account=await rpc.call("account/read",{refreshToken:false});if(!account || !account.account)fail("AUTH_REQUIRED");this.state.connectionState="connected";this.state.status="Đã kết nối Codex trên máy này";await this.listThreads({});try{await this.refreshSkills({});}catch(_){}try{await this.refreshModels({});}catch(_){}this.save();}
        catch(e){rpc.close();this.state.error=publicError(e);this.state.connectionState=e.code==="AUTH_REQUIRED"?"authRequired":"error";this.state.status=this.state.error.message;this.save();throw e;}
    }
    requireConnected(){if(!this.rpc || this.rpc.closed || this.state.connectionState!=="connected")fail("RPC_CLOSED");}
    async refreshModels(args={}) {
        fields(args,[]);this.requireConnected();this.state.modelsStatus="loading";delete this.state.modelsError;this.save();
        const rpc=this.rpc,models=[],seen=new Set(),cursors=new Set();let cursor;
        try{
            for(let page=0;page<16;page++){
                const result=await rpc.call("model/list",{limit:20,includeHidden:false,...(cursor?{cursor}:{})});this.requireConnected();if(this.rpc!==rpc)fail("RPC_CLOSED");
                if(!obj(result))fail("MODEL_DISCOVERY_FAILED");
                for(const entry of modelEntries(result.data))if(!seen.has(entry.model)){seen.add(entry.model);models.push(entry);}
                if(models.length>128 || Buffer.byteLength(JSON.stringify(models))>MAX_MODEL_BYTES)fail("MODEL_DISCOVERY_FAILED");
                if(result.nextCursor===undefined || result.nextCursor===null){if(!models.length)fail("MODEL_DISCOVERY_FAILED");this.state.models=models;this.state.modelsStatus="ready";this.save();return models;}
                if(!modelValue(result.nextCursor,4096) || cursors.has(result.nextCursor))fail("MODEL_DISCOVERY_FAILED");cursors.add(result.nextCursor);cursor=result.nextCursor;
            }
            fail("MODEL_DISCOVERY_FAILED");
        }catch(_){this.state.models=[];this.state.modelsStatus=this.rpc && !this.rpc.closed && this.state.connectionState==="connected"?"error":"stale";this.state.modelsError=publicError({code:"MODEL_DISCOVERY_FAILED"});this.save();fail("MODEL_DISCOVERY_FAILED");}
    }
    modelSelection(args) {
        if(args.model===undefined && args.effort===undefined)return {};
        if(args.model===undefined)fail("MODEL_REQUIRED");
        if(!modelValue(args.model) || args.effort!==undefined && !modelValue(args.effort,64))fail("INVALID_ARGUMENTS");
        if(this.state.modelsStatus!=="ready")fail("MODEL_CATALOG_UNAVAILABLE");
        const model=this.state.models.find(m=>m.model===args.model);if(!model)fail("MODEL_UNAVAILABLE");
        if(args.effort!==undefined && !model.supportedReasoningEfforts.some(e=>e.reasoningEffort===args.effort))fail("EFFORT_UNSUPPORTED");
        return {model:model.model,...(args.effort!==undefined?{effort:args.effort}:{})};
    }
    syncModelSettings(result,reset=false) {
        // These are the server's configured settings, not per-turn execution telemetry.
        if(reset){this.state.activeModel=null;this.state.activeEffort=null;}
        const thread=obj(result && result.thread)?result.thread:{};
        const model=Object.prototype.hasOwnProperty.call(result || {},"model")?result.model:thread.model;
        const effort=Object.prototype.hasOwnProperty.call(result || {},"reasoningEffort")?result.reasoningEffort:thread.reasoningEffort;
        if(model!==undefined){const next=modelValue(model);if(next!==this.state.activeModel && effort===undefined)this.state.activeEffort=null;this.state.activeModel=next;}
        if(effort!==undefined)this.state.activeEffort=modelValue(effort,64);
    }
    async refreshSkills(args={}) {
        fields(args,[]);this.requireConnected();this.state.skillsStatus="loading";delete this.state.skillsError;this.save();
        try{const result=await this.rpc.call("skills/list",{cwds:[this.workspace],forceReload:true});const skills=localSkills(result,this.workspace),display=publicSkills(skills);if(JSON.stringify(skills)!==JSON.stringify(this.localSkillCatalog))this.resumed.clear();this.localSkillCatalog=skills;this.state.skills=display;this.state.skillsStatus="ready";this.save();return this.state.skills;}
        catch(e){const code=e.code==="SKILL_CATALOG_LIMIT"?e.code:"SKILL_DISCOVERY_FAILED";this.localSkillCatalog=[];this.state.skills=unavailableSkills("Không đọc được danh sách skill; hãy làm mới sau.");this.state.skillsStatus="error";this.state.skillsError=publicError({code});this.resumed.clear();this.save();fail(code);}
    }
    async openMedia(args={}) {
        fields(args,["mediaId"]);text(args.mediaId,180,true);
        if(this.publishTimer || this.dirtyMedia.size)this.save();
        this.state.media=this.normalizedMedia(this.state.messages);
        if(args.mediaId!==undefined && !this.state.media.some(m=>m.id===args.mediaId))fail("MEDIA_INVALID");
        if(!this.state.media.length)fail("MEDIA_EMPTY");
        if(!this.viewer)this.viewer=this.options.mediaViewerFactory?this.options.mediaViewerFactory():new MediaViewer({workspace:this.workspace});
        const result=await this.viewer.open(this.state.media,args.mediaId);this.state.status="Đã mở cửa sổ xem ảnh/video";this.save();return result;
    }
    async prepareMedia(args={}) {
        fields(args,["mediaId"]);text(args.mediaId,180);
        const selected=this.normalizedMedia(this.state.messages).find(item=>item.id===args.mediaId);
        if(!selected || selected.kind!=="image")fail("MEDIA_INVALID");
        // Compatibility response for older panels: no download, file copy,
        // bitmap decoding, worker process, or implicit media viewer launch.
        fail("MEDIA_PREVIEW_DISABLED");
    }
    async listThreads(args) {fields(args,["cursor","search"]);text(args.cursor,4096,true);text(args.search,200,true);this.requireConnected();const r=await this.rpc.call("thread/list",{limit:30,sortKey:"updated_at",sortDirection:"desc",sourceKinds:["cli","vscode","appServer"],archived:false,...(args.cursor?{cursor:args.cursor}:{}),...(args.search?{searchTerm:args.search}:{})});this.state.threads=(r.data || []).slice(0,30).map(threadSummary);this.state.nextCursor=r.nextCursor || null;this.save();}
    async conversationPage(threadId,cursor) {
        const data=[],seenItems=new Set(),seenCursors=new Set();let nextCursor=cursor,result,limited=false;
        for(let page=0;page<8;page++){
            try{result=await this.rpc.call("thread/items/list",{threadId,limit:40,sortDirection:"desc",...(nextCursor?{cursor:nextCursor}:{})});}catch(error){if(error.code!=="THREAD_UNMATERIALIZED")throw error;result={data:[],nextCursor:null};}
            for(const entry of (result.data || []).slice(0,40)){const key=compact(entry.turnId,180)+"/"+compact(entry.item && entry.item.id,180);if(!seenItems.has(key)){seenItems.add(key);data.push(entry);}}
            nextCursor=result.nextCursor || null;
            const userCount=data.filter(entry=>entry.item && entry.item.type==="userMessage").length,answerTurns=new Set(data.filter(entry=>entry.item && entry.item.type==="agentMessage" && (entry.item.phase===undefined || entry.item.phase==="final_answer")).map(entry=>entry.turnId));
            if(nextCursor && (page===7 || seenCursors.has(nextCursor)) && (!userCount || userCount+answerTurns.size<12))limited=true;
            if(!nextCursor || (result.data || []).length<40 || userCount>0 && userCount+answerTurns.size>=12 || seenCursors.has(nextCursor))break;
            seenCursors.add(nextCursor);
        }
        return {data,nextCursor,limited};
    }
    mergeConversation(messages) {
        const result=this.state.messages.slice();
        for(const message of messages){const at=result.findIndex(existing=>existing.id===message.id && existing.turnId===message.turnId);if(at>=0)result[at]=message;else {if(message.type==="agentMessage")for(let index=result.length-1;index>=0;index--)if(result[index].type==="agentMessage" && result[index].turnId===message.turnId)result.splice(index,1);result.push(message);}}
        return result.slice(-100);
    }
    async readThread(args) {
        fields(args,["threadId","cursor"]);id(args.threadId);text(args.cursor,4096,true);this.requireConnected();
        if(this.state.busy && !this.state.externalBusy)fail("CHAT_BUSY");
        this.historyEpoch++;
        const r=await this.rpc.call("thread/read",{threadId:args.threadId,includeTurns:false});
        let latest;try{latest=await this.rpc.call("thread/turns/list",{threadId:args.threadId,limit:40,sortDirection:"desc",itemsView:"summary"});}catch(e){if(e.code!=="THREAD_UNMATERIALIZED")throw e;latest={data:[]};}
        const history=await this.conversationPage(args.threadId,args.cursor);
        this.rememberTurns(args.threadId,latest.data);
        // An older page may contain legacy items without phase metadata. Resolve only its missing turn statuses.
        const needed=new Set((history.data || []).filter(entry=>entry.item && entry.item.type==="agentMessage" && entry.item.phase===undefined && !this.knownTurnStates.has(entry.turnId)).map(entry=>entry.turnId));let turnCursor=latest.nextCursor;const seenCursors=new Set();
        for(let page=0;needed.size && turnCursor && page<8 && !seenCursors.has(turnCursor);page++){seenCursors.add(turnCursor);const result=await this.rpc.call("thread/turns/list",{threadId:args.threadId,limit:100,sortDirection:"desc",itemsView:"summary",cursor:turnCursor});this.rememberTurns(args.threadId,result.data);for(const turnId of needed)if(this.knownTurnStates.has(turnId))needed.delete(turnId);turnCursor=result.nextCursor;}
        if(needed.size)this.state.historyPhaseWarning="Một số câu trả lời cũ chưa đủ dữ liệu lượt chạy để xác nhận câu trả lời cuối. Hãy mở lịch sử đó trong Codex để xem đầy đủ.";else delete this.state.historyPhaseWarning;
        if(history.limited)this.state.historyPhaseWarning=(this.state.historyPhaseWarning?this.state.historyPhaseWarning+" ":"")+"Lịch sử có nhiều hoạt động công cụ; mới tải tối đa 320 mục. Dùng Trang trước hoặc mở Codex để xem phần còn lại.";
        this.syncModelSettings(r,args.threadId!==this.state.activeThreadId);this.state.activeThreadId=args.threadId;this.state.activeThreadTitle=threadSummary(r.thread).title;
        const activeTurns=new Set((latest.data || []).filter(isBusy).map(turn=>turn.id)),page=this.historyMessages(history,args.threadId,activeTurns),messages=page.messages;
        // Replace the visible bounded page. Prepending would immediately evict old history at the size cap.
        this.state.messages=messages;this.state.activity=page.activity;this.agentCandidates.clear();this.localTurn=null;this.dirtyMedia.clear();this.state.messagesTruncated=false;this.state.historyNextCursor=history.nextCursor || null;
        this.resumed.delete(args.threadId);this.historyPageRevision=page.revision;this.historyCursor=args.cursor || null;this.historyExplicitPage=true;this.historyRevision=null;this.historySyncAt=Date.now();this.state.externalBusy=isBusy(r.thread) || activeTurns.size>0;this.state.busy=this.state.externalBusy;this.state.turnId=null;
        this.state.status=this.state.externalBusy?"Cuộc chat đang chạy trong Codex; chờ hoàn tất để tiếp tục":"Đã mở lịch sử; gửi để tiếp tục";this.save();
    }
    threadParams() {const local=SKILLS.map(name=>this.localSkillCatalog.find(s=>s.name===name) || {name,available:false}).map(s=>({name:s.name,available:this.state.skillsStatus==="ready" && s.available,...(this.state.skillsStatus==="ready" && s.available?{path:s.path}:{})}));return {cwd:this.workspace,approvalPolicy:"never",sandbox:"danger-full-access",developerInstructions:INSTRUCTIONS+" Current machine-local media skills (use these discovered paths, never an example user path): "+JSON.stringify(local)};}
    async newThread(args) {fields(args,[]);this.requireConnected();if(this.state.busy && !this.state.externalBusy)fail("CHAT_BUSY");this.historyEpoch++;const r=await this.rpc.call("thread/start",this.threadParams());const t=r.thread;this.syncModelSettings(r,true);this.resumed.add(t.id);this.state.activeThreadId=t.id;this.state.activeThreadTitle=threadSummary(t).title;this.state.messages=[];this.state.activity=[];this.agentCandidates.clear();this.localTurn=null;this.state.historyNextCursor=null;this.state.messagesTruncated=false;this.state.turnId=null;this.state.externalBusy=false;this.state.busy=false;this.historyCursor=null;this.historyExplicitPage=false;delete this.state.historyPhaseWarning;this.historyRevision=null;this.historyPageRevision=null;this.historyItemCache.clear();this.historyItemCacheThread=null;this.historySyncAt=Date.now();this.state.status="Cuộc chat mới đã sẵn sàng";this.save();}
    async syncSharedThread() {
        // Read shared local history only. Never resume, steer, interrupt or start a remote client's turn.
        if(this.historySyncing || this.processing || this.stopping || this.state.connectionState!=="connected" || !this.state.activeThreadId || this.pending.size || this.state.busy && !this.state.externalBusy || Date.now()-this.historySyncAt<HISTORY_SYNC_MS)return;
        const rpc=this.rpc,threadId=this.state.activeThreadId,epoch=this.historyEpoch;
        const current=()=>this.rpc===rpc && !rpc.closed && !this.processing && !this.stopping && this.historyEpoch===epoch && this.state.activeThreadId===threadId && !this.pending.size && !(this.state.busy && !this.state.externalBusy);
        this.historySyncing=true;this.historySyncAt=Date.now();
        try {
            const read=await rpc.call("thread/read",{threadId,includeTurns:false});if(!current())return;
            let latest;try{latest=await rpc.call("thread/turns/list",{threadId,limit:1,sortDirection:"desc",itemsView:"summary"});}catch(e){if(e.code!=="THREAD_UNMATERIALIZED")throw e;latest={data:[]};}if(!current())return;
            const turns=(latest.data || []).slice(0,1),externalBusy=isBusy(read.thread) || turns.some(isBusy);
            this.rememberTurns(threadId,turns);
            const metadata={...(read.thread || {})};delete metadata.turns;
            const revision=crypto.createHash("sha256").update(JSON.stringify({metadata,turns:turns.map(t=>({id:t.id,status:t.status,startedAt:t.startedAt,completedAt:t.completedAt,durationMs:t.durationMs}))})).digest("hex");
            let history;
            // Keep an explicitly opened older page stable. Live updates resume when the newest page is opened.
            if(!this.historyCursor && (revision!==this.historyRevision || externalBusy || this.state.externalBusy)){
                try{history=await rpc.call("thread/items/list",{threadId,limit:40,sortDirection:"desc"});}catch(e){if(e.code!=="THREAD_UNMATERIALIZED")throw e;history={data:[],nextCursor:null};}if(!current())return;
            }
            const before=JSON.stringify({title:this.state.activeThreadTitle,model:this.state.activeModel,effort:this.state.activeEffort,busy:this.state.busy,externalBusy:this.state.externalBusy,cursor:this.state.historyNextCursor,status:this.state.status,syncError:this.state.historySyncError});
            this.syncModelSettings(read);this.state.activeThreadTitle=threadSummary(read.thread).title;
            let messagesChanged=false;
            if(history){const page=this.historyMessages(history,threadId,new Set(turns.filter(isBusy).map(turn=>turn.id)));if(page.revision!==this.historyPageRevision){const merged=this.mergeConversation(page.messages);messagesChanged=JSON.stringify(merged)!==JSON.stringify(this.state.messages) || JSON.stringify(page.activity)!==JSON.stringify(this.state.activity);this.state.messages=merged;this.state.activity=page.activity;this.dirtyMedia.clear();this.state.messagesTruncated=false;this.historyPageRevision=page.revision;}if(!this.historyExplicitPage)this.state.historyNextCursor=history.nextCursor || null;this.resumed.delete(threadId);}
            const wasExternal=this.state.externalBusy;this.state.externalBusy=externalBusy;this.state.busy=externalBusy;this.state.turnId=null;this.historyRevision=revision;delete this.state.historySyncError;
            if(externalBusy)this.state.status="Cuộc chat đang chạy trong Codex; chờ hoàn tất để tiếp tục";
            else if(wasExternal || history)this.state.status="Đã đồng bộ lịch sử Codex; gửi để tiếp tục";
            const after=JSON.stringify({title:this.state.activeThreadTitle,model:this.state.activeModel,effort:this.state.activeEffort,busy:this.state.busy,externalBusy:this.state.externalBusy,cursor:this.state.historyNextCursor,status:this.state.status,syncError:this.state.historySyncError});
            if(messagesChanged || before!==after)this.save();
        } catch(_){if(current() && !this.state.historySyncError){this.state.historySyncError="Chưa đồng bộ được lịch sử Codex. Sẽ kiểm tra lại khi rảnh; không tự gửi lại yêu cầu.";this.save();}}
        finally {this.historySyncing=false;}
    }
    async ensureIdle(threadId) {
        const r=await this.rpc.call("thread/read",{threadId,includeTurns:false});if(threadId===this.state.activeThreadId)this.syncModelSettings(r);if(isBusy(r.thread))fail("THREAD_BUSY");
        let latest;
        try{latest=await this.rpc.call("thread/turns/list",{threadId,limit:1,sortDirection:"desc",itemsView:"summary"});}
        catch(e){if(e.code!=="THREAD_UNMATERIALIZED")throw e;latest={data:[]};}
        if((latest.data || []).some(isBusy))fail("THREAD_BUSY");
    }
    async nativeInput(args) {
        text(args.text,24000,true);if(args.images!==undefined && !Array.isArray(args.images))fail("IMAGE_INVALID");
        const selected=args.skills===undefined?[]:args.skills;if(!Array.isArray(selected) || selected.length>8 || selected.some(s=>typeof s!=="string" || !this.state.skills.some(skill=>skill.id===s)) || new Set(selected).size!==selected.length)fail("SKILL_INVALID");
        const paths=args.images || [];if(paths.length>8)fail("IMAGE_LIMIT");let total=0;const images=paths.map(p=>{const image=validateImage(p);total+=image.size;return image;});if(total>40*1024*1024)fail("IMAGE_LIMIT");
        if(!(args.text || "").trim() && !images.length)fail("EMPTY_INPUT");
        let skills=[];if(selected.length || this.state.skillsStatus==="stale"){try{await this.refreshSkills({});}catch(e){if(selected.length)throw e;}}
        if(selected.length)skills=selected.map(name=>{const skill=this.localSkillCatalog.find(s=>s.id===name && s.available);if(!skill)fail("SKILL_UNAVAILABLE");return {type:"skill",name:skill.name,path:skill.path};});
        const input=[];if((args.text || "").trim())input.push({type:"text",text:args.text});for(const image of images)input.push({type:"localImage",path:image.path});input.push(...skills);
        return {input,images};
    }
    async send(args) {
        fields(args,["threadId","text","images","skills","model","effort"]);id(args.threadId);this.requireConnected();if(this.state.busy)fail(this.state.externalBusy?"THREAD_BUSY":"CHAT_BUSY");if(args.threadId!==this.state.activeThreadId)fail("THREAD_NOT_SELECTED");const selection=this.modelSelection(args);this.historyEpoch++;
        const {input,images}=await this.nativeInput(args);
        if(images.length && selection.model!==undefined){const model=this.state.models.find(m=>m.model===selection.model);if(model.inputModalities && !model.inputModalities.includes("image"))fail("MODEL_IMAGE_UNSUPPORTED");}
        await this.ensureIdle(args.threadId);
        if(this.stopping || this.publicationClosing || this.publicationClosed)fail("HOST_STOPPED");this.requireConnected();if(args.threadId!==this.state.activeThreadId)fail("THREAD_NOT_SELECTED");
        if(!this.resumed.has(args.threadId)){const r=await this.rpc.call("thread/resume",{threadId:args.threadId,excludeTurns:true});if(isBusy(r.thread))fail("THREAD_BUSY");this.syncModelSettings(r);this.resumed.add(args.threadId);}
        // A last check catches work that began in another client during resume. Never steer implicitly.
        await this.ensureIdle(args.threadId);
        if(this.stopping || this.publicationClosing || this.publicationClosed)fail("HOST_STOPPED");this.requireConnected();if(args.threadId!==this.state.activeThreadId)fail("THREAD_NOT_SELECTED");
        // Omitting effort preserves the thread's configured value; changing model does not reset it.
        if(selection.model!==undefined && selection.effort===undefined && this.state.activeEffort!==null && !this.state.models.find(m=>m.model===selection.model).supportedReasoningEfforts.some(e=>e.reasoningEffort===this.state.activeEffort))fail("EFFORT_UNSUPPORTED");
        const owned={threadId:args.threadId,turnId:null,earlyTerminals:new Map()};this.localTurn=owned;this.state.turnId=null;this.state.busy=true;this.state.externalBusy=false;this.state.status="Codex đang xử lý…";delete this.state.error;this.save();
        try {const r=await this.rpc.call("turn/start",{threadId:args.threadId,input,...selection,approvalPolicy:"never",sandboxPolicy:{type:"dangerFullAccess"}},60000);if(this.localTurn===owned && this.state.busy){owned.turnId=id(r.turn.id);this.state.turnId=r.turn.id;for(const [requestId,pending] of this.pending)if(!this.requestTurnAllowed(pending.params)){this.rpc.reject(pending.rpcId);this.pending.delete(requestId);this.state.messages=this.state.messages.filter(item=>item.id!=="question-"+compact(requestId,160));}const terminal=owned.earlyTerminals.get(r.turn.id);if(terminal)this.notification({method:"turn/completed",params:{threadId:args.threadId,turn:terminal}});}if(selection.model!==undefined)this.state.activeModel=selection.model;if(selection.effort!==undefined)this.state.activeEffort=selection.effort;this.save();}
        catch(e){if(selection.model!==undefined){this.state.activeModel=null;this.state.activeEffort=null;}this.state.error=publicError(e);this.state.status="Chưa xác nhận được lượt chạy. Không tự gửi lại.";this.save();throw e;}
    }
    async steer(args) {
        fields(args,["threadId","expectedTurnId","text","images","skills"]);id(args.threadId);id(args.expectedTurnId);this.requireConnected();
        if(args.threadId!==this.state.activeThreadId)fail("THREAD_NOT_SELECTED");if(!this.canSteer())fail("STEER_UNAVAILABLE");if(args.expectedTurnId!==this.state.turnId)fail("STEER_STALE");
        const owned=this.localTurn,{input,images}=await this.nativeInput(args);
        if(!this.canSteer() || this.localTurn!==owned || args.expectedTurnId!==this.state.turnId)fail("STEER_STALE");
        const model=this.state.models.find(entry=>entry.model===this.state.activeModel);if(images.length && model && model.inputModalities && !model.inputModalities.includes("image"))fail("MODEL_IMAGE_UNSUPPORTED");
        this.historyEpoch++;this.steerInFlight=true;this.state.status="Đang gửi yêu cầu chuyển hướng…";delete this.state.error;this.save();
        try{await this.rpc.call("turn/steer",{threadId:args.threadId,expectedTurnId:args.expectedTurnId,input},60000);if(this.localTurn===owned && this.state.busy)this.state.status="Đã gửi yêu cầu chuyển hướng cho Codex";}
        catch(error){this.state.error=publicError(error);this.state.status="Chưa xác nhận yêu cầu chuyển hướng. Không tự gửi lại.";throw error;}
        finally{this.steerInFlight=false;this.save();}
    }
    async interrupt(args={}) {fields(args,["threadId","turnId"]);this.requireConnected();if(this.state.externalBusy)fail("THREAD_BUSY");const threadId=args.threadId || this.state.activeThreadId,turnId=args.turnId || this.state.turnId;if(!threadId || !turnId)return;if(threadId!==this.state.activeThreadId || turnId!==this.state.turnId)fail("INVALID_ARGUMENTS");const key=threadId+"/"+turnId;if(this.interrupted.has(key))return;this.interrupted.add(key);await this.rpc.call("turn/interrupt",{threadId,turnId});this.state.status="Đã yêu cầu dừng; đang chờ Codex xác nhận";this.save();}
    requestTurnAllowed(params) {
        if(params.threadId && params.threadId!==this.state.activeThreadId)return false;
        if(params.turnId===undefined || params.turnId===null)return true;
        if(typeof params.turnId!=="string" || !THREAD.test(params.turnId) || ["completed","interrupted","failed"].includes(this.knownTurnStates.get(params.turnId)))return false;
        return !this.localTurn || !this.localTurn.turnId || params.turnId===this.localTurn.turnId;
    }
    serverRequest(message) {
        const p=message.params || {},key=String(message.id);if(this.stopping || this.publicationClosing || this.publicationClosed || !this.requestTurnAllowed(p)){if(this.rpc && !this.rpc.closed)this.rpc.reject(message.id);return;}
        if(this.autoApprovalReplies.has(key))return;
        if(!this.stopping && this.rpc && !this.rpc.closed && message.method==="mcpServer/elicitation/request" && isTrustedAeToolApproval(p,this.state)){
            // Never evict IDs within this RPC: a duplicate cannot trigger another reply.
            if(this.autoApprovalReplies.size>=2048){this.rpc.reject(message.id);return;}
            this.autoApprovalReplies.add(key);
            this.rpc.reply(message.id,{action:"accept",content:{}});
            this.event("Đã tự cho phép công cụ AE");return;
        }
        if(this.pending.size>=8){this.rpc.reject(message.id);return;}
        let kind="unsupported",prompt="Yêu cầu chưa được hỗ trợ trong panel",details="",questions,decisions;
        if(["item/commandExecution/requestApproval","item/fileChange/requestApproval"].includes(message.method)){
            kind="approval";prompt=message.method.includes("commandExecution")?"Codex cần bạn cho phép chạy lệnh":"Codex cần bạn cho phép thay đổi tệp";
            const item=this.itemDetails.get(p.itemId) || {};
            const lines=[p.reason,p.command || item.command,p.cwd || item.cwd,p.grantRoot?"Quyền thư mục: "+p.grantRoot:null];
            if(p.networkApprovalContext){prompt="Codex cần quyền truy cập mạng";lines.push("Máy chủ: "+compact(p.networkApprovalContext.host,500)+" · "+compact(p.networkApprovalContext.protocol,40));}
            if(Array.isArray(item.changes))for(const change of item.changes.slice(0,12))lines.push(compact(change.path,1500)+" ("+compact(change.kind && change.kind.type || change.kind,80)+")\n"+compact(change.diff,3500));
            const full=lines.filter(Boolean).join("\n");details=compact(full,6500)+(full.length>6500?"\n[Nội dung đã rút gọn; mở Codex để xem toàn bộ thay đổi.]":"");
            decisions=Array.isArray(p.availableDecisions)?p.availableDecisions.filter(d=>["accept","decline","cancel"].includes(d)):["accept","decline","cancel"];
            if(!decisions.length)kind="unsupported";
        }
        if(message.method==="item/tool/requestUserInput" && Array.isArray(p.questions) && !p.questions.some(q=>q.isSecret)){kind="question";prompt="Codex cần câu trả lời của bạn";questions=p.questions.slice(0,3).map(q=>({id:compact(q.id,100),question:compact(q.question,2000),options:(q.options || []).slice(0,12).map(o=>({label:compact(o.label,300),description:compact(o.description,500)}))}));this.appendMessage({id:"question-"+compact(key,160),type:"codexQuestion",turnId:compact(p.turnId || this.state.turnId,180),role:"assistant",text:questions.map(question=>question.question).join("\n\n")});}
        if(message.method==="mcpServer/elicitation/request"){prompt="Yêu cầu từ công cụ cần xử lý trong Codex";details=compact(p.message,3000);}
        const display={id:key,kind,prompt,details,...(questions?{questions}:{}),...(decisions?{decisions}:{})};this.pending.set(key,{rpcId:message.id,method:message.method,params:p,display});this.state.status="Đang chờ bạn phản hồi";this.save();
    }
    async respond(args) {
        fields(args,["requestId","decision","answers"]);text(args.requestId,180);this.requireConnected();const pending=this.pending.get(args.requestId);if(!pending)fail("INVALID_ARGUMENTS");
        if(this.stopping || !this.requestTurnAllowed(pending.params)){this.rpc.reject(pending.rpcId);this.pending.delete(args.requestId);this.save();fail("STALE_SERVER_REQUEST");}
        if(pending.display.kind==="approval"){if(!pending.display.decisions.includes(args.decision) || args.answers!==undefined)fail("INVALID_ARGUMENTS");this.rpc.reply(pending.rpcId,{decision:args.decision});}
        else if(pending.display.kind==="question"){
            if(["decline","cancel"].includes(args.decision) && args.answers===undefined){this.rpc.reply(pending.rpcId,{answers:{}});if(args.decision==="cancel")await this.interrupt({});}
            else {if(!obj(args.answers) || args.decision!==undefined)fail("INVALID_ARGUMENTS");const answers={};for(const q of pending.display.questions){const a=args.answers[q.id];if(!Array.isArray(a) || a.length<1 || a.length>3)fail("INVALID_ARGUMENTS");answers[q.id]={answers:a.map(v=>text(v,4000))};}if(Object.keys(args.answers).some(k=>!pending.display.questions.some(q=>q.id===k)))fail("INVALID_ARGUMENTS");this.rpc.reply(pending.rpcId,{answers});this.appendMessage({id:"answer-"+compact(args.requestId,160),type:"userAnswer",turnId:compact(pending.params.turnId || this.state.turnId,180),role:"user",text:pending.display.questions.map(q=>q.question+"\n"+answers[q.id].answers.join(", ")).join("\n\n")});}
        }
        else {if(!["decline","cancel"].includes(args.decision))fail("UNSUPPORTED_APPROVAL");if(pending.method==="mcpServer/elicitation/request")this.rpc.reply(pending.rpcId,{action:"decline",content:null});else if(pending.method==="item/permissions/requestApproval")this.rpc.reply(pending.rpcId,{permissions:{},scope:"turn"});else this.rpc.reject(pending.rpcId);}
        this.pending.delete(args.requestId);this.state.status="Đã gửi phản hồi cho Codex";this.save();
    }
    notification(message) {
        if(this.publicationClosed || this.publicationClosing)return;
        const p=message.params || {},m=message.method;if(p.threadId && p.threadId!==this.state.activeThreadId)return;
        if(this.state.externalBusy && /^(turn\/|item\/)/.test(m))return;
        if(!["turn/started","turn/completed","item/agentMessage/delta","item/started","item/completed","serverRequest/resolved","error","item/mcpToolCall/progress","thread/name/updated","skills/changed"].includes(m))return;
        const eventTurnId=p.turnId || p.turn && p.turn.id;
        if(eventTurnId && !THREAD.test(eventTurnId))return;
        const knownTerminal=eventTurnId && ["completed","interrupted","failed"].includes(this.knownTurnStates.get(eventTurnId));
        if(knownTerminal && (m==="turn/started" || m==="turn/completed" || this.state.busy && eventTurnId!==this.state.turnId))return;
        if(eventTurnId && this.state.turnId && eventTurnId!==this.state.turnId && m!=="turn/started")return;
        if(m==="turn/started" && this.state.busy && this.state.turnId && eventTurnId!==this.state.turnId)return;
        this.historyEpoch++;
        this.metrics.notifications++;
        if(m.startsWith("item/") && this.historyItemCache.size){this.historyItemCache.clear();this.historyPageRevision=null;}
        if(m==="turn/started"){this.state.busy=true;this.state.turnId=p.turn.id;this.state.status="Codex đang xử lý…";}
        else if(m==="turn/completed"){if(this.localTurn && this.localTurn.turnId===null){this.localTurn.earlyTerminals.set(p.turn.id,{id:p.turn.id,status:compact(p.turn.status,40),...(p.turn.error?{error:true}:{})});while(this.localTurn.earlyTerminals.size>4)this.localTurn.earlyTerminals.delete(this.localTurn.earlyTerminals.keys().next().value);return;}this.promoteFinal(p.turn.id);this.rememberTurns(this.state.activeThreadId,[p.turn]);this.localTurn=null;this.historyRevision=null;this.historySyncAt=Date.now();this.state.busy=false;this.state.turnId=p.turn.id;this.pending.clear();this.state.status=p.turn.status==="completed"?"Codex đã hoàn tất":p.turn.status==="interrupted"?"Đã dừng chat":"Lượt chạy kết thúc với lỗi";if(p.turn.error)this.state.error={code:"TURN_ERROR",message:"Codex báo lỗi trong lượt chạy. Hãy mở lịch sử để kiểm tra."};for(const done of this.terminalWaiters)done();this.terminalWaiters.clear();}
        else if(m==="item/agentMessage/delta"){const turnId=compact(eventTurnId || this.state.turnId,180),key=turnId+"/"+compact(p.itemId,180),existing=this.agentCandidates.get(key),item=existing?{...existing.value}:{id:compact(p.itemId,180),type:"agentMessage",turnId,role:"assistant",text:"",...(typeof p.phase==="string"?{phase:compact(p.phase,40)}:{})};const delta=String(p.delta || "").slice(0,Math.max(0,24000-item.text.length));if(!delta)return;item.text+=delta;this.rememberAgent(item);this.queueSave();return;}
        else if(m==="item/started" || m==="item/completed"){
            if(p.item && ["commandExecution","fileChange"].includes(p.item.type)){this.itemDetails.set(p.item.id,{command:compact(p.item.command,6000),cwd:compact(p.item.cwd,4096),changes:(p.item.changes || []).slice(0,12).map(c=>({path:compact(c.path,1500),kind:c.kind,diff:compact(c.diff,3500)}))});while(this.itemDetails.size>20)this.itemDetails.delete(this.itemDetails.keys().next().value);}
            const value=this.messageFromItem(p.item,eventTurnId || this.state.turnId);if(value){if(value.type==="agentMessage")this.rememberAgent(value);else if(value.role==="user")this.appendMessage(value);else this.appendActivity(value);}
            if(p.item && !["agentMessage","userMessage"].includes(p.item.type))this.state.status="Công cụ: "+compact(p.item.tool || p.item.type,80)+" · "+(m==="item/completed"?"xong":"đang chạy");
            if(!p.item || !p.item.error && !p.item.failure && !["failed","declined","interrupted"].includes(p.item.status) && !(typeof p.item.exitCode==="number" && p.item.exitCode!==0)){this.queueSave();return;}
        }
        else if(m==="serverRequest/resolved"){this.pending.delete(String(p.requestId));}
        else if(m==="error"){this.state.error={code:"CODEX_EVENT_ERROR",message:"Codex thông báo lỗi. Lượt chạy chưa được tự gửi lại."};}
        else if(m==="item/mcpToolCall/progress"){this.state.status="Công cụ: "+compact(p.message,180);this.appendActivity({id:"progress-"+compact(eventTurnId || this.state.turnId,160),type:"mcpProgress",turnId:compact(eventTurnId || this.state.turnId,180),role:"tool",text:compact(p.message,1200)});this.queueSave();return;}
        else if(m==="thread/name/updated" && p.threadName)this.state.activeThreadTitle=compact(p.threadName,180);
        else if(m==="skills/changed")this.state.skillsStatus="stale";
        else return;
        this.save();
    }
    async action(request) {
        fields(request,["schema","id","sessionNonce","action","args","createdAtEpochMs"]);
        if(request.schema!=="codex-ae-chat-request/v1" || !SAFE.test(request.id || "") || !SAFE.test(request.sessionNonce || ""))fail("INVALID_ARGUMENTS");
        if(!Number.isFinite(request.createdAtEpochMs) || Date.now()-request.createdAtEpochMs>FRESH_MS || request.createdAtEpochMs>Date.now()+5000)fail("STALE_REQUEST");
        const a=request.args || {};if(request.action!=="connect" && request.sessionNonce!==this.state.sessionNonce)fail("SESSION_MISMATCH");
        if(request.action==="connect"){fields(a,[]);return this.connect(request.sessionNonce);}
        if(request.action==="listThreads")return this.listThreads(a);if(request.action==="readThread")return this.readThread(a);if(request.action==="newThread")return this.newThread(a);if(request.action==="send")return this.send(a);if(request.action==="steer")return this.steer(a);if(request.action==="interrupt")return this.interrupt(a);if(request.action==="respond")return this.respond(a);if(request.action==="refreshSkills")return this.refreshSkills(a);if(request.action==="refreshModels")return this.refreshModels(a);if(request.action==="openMedia")return this.openMedia(a);if(request.action==="prepareMedia")return this.prepareMedia(a);
        if(request.action==="disconnect"){fields(a,[]);await this.stop();return;}fail("INVALID_ARGUMENTS");
    }
    pendingRequest() {
        this.metrics.pointerReads++;const p=readJson(path.join(this.dir,"pending.json"),8192);let requestId,sessionNonce,timestamp;
        if(p.schema==="codex-ae-chat-pending/v1"){fields(p,["schema","requestId","sessionNonce","workspaceRoot","timestampEpochMs"]);if(path.resolve(p.workspaceRoot)!==this.workspace)fail("PATH_ESCAPE");requestId=p.requestId;sessionNonce=p.sessionNonce;timestamp=p.timestampEpochMs;}
        else if(p.schema==="codex-ae-chat-request/v1"){requestId=p.id;sessionNonce=p.sessionNonce;timestamp=p.createdAtEpochMs;}else fail("INVALID_ARGUMENTS");
        if(!SAFE.test(requestId || "") || !SAFE.test(sessionNonce || ""))fail("INVALID_ARGUMENTS");
        if(!Number.isFinite(timestamp) || Date.now()-timestamp>FRESH_MS || timestamp>Date.now()+5000)fail("STALE_REQUEST");
        this.metrics.requestReads++;const request=readJson(path.join(this.dir,"requests",requestId+".json"));if(request.id!==requestId || request.sessionNonce!==sessionNonce || request.createdAtEpochMs!==timestamp)fail("INVALID_ARGUMENTS");return request;
    }
    async poll() {
        if(this.processing || this.stopping)return;
        let request,revision;try {
            this.metrics.pointerStatChecks++;revision=fileRevision(path.join(this.dir,"pending.json"),8192);
            if(this.consumedPointer && revision===this.consumedPointer.revision && Date.now()-this.consumedPointer.checkedAt<POINTER_RECHECK_MS){this.metrics.pointerCacheHits++;return;}
            request=this.pendingRequest();
        }catch(e){if(revision)this.consumedPointer={revision,checkedAt:Date.now()};if(e.code!=="ENOENT" && !["STALE_REQUEST","INVALID_ARGUMENTS"].includes(e.code))this.event("Yêu cầu chat không hợp lệ.");return;}
        const resultPath=path.join(this.dir,"results",request.id+".json"),startedPath=path.join(this.dir,"started",request.id+".json");
        if(fs.existsSync(resultPath)){this.consumedPointer={revision,checkedAt:Date.now()};return;}
        if(this.publications.has("terminal-"+request.id)){this.consumedPointer={revision,checkedAt:Date.now()};return;}
        if(Array.from(this.publications.values()).filter(entry=>entry.immutable).length>=8)return;
        if(fs.existsSync(startedPath)){this.publishTerminal(request.id,resultPath,{schema:"codex-ae-chat-result/v1",id:request.id,sessionNonce:request.sessionNonce,state:"error",error:publicError({code:"ALREADY_DISPATCHED"})});this.consumedPointer={revision,checkedAt:Date.now()};return;}
        this.processing=true;
        try {
            let outcome;
            try {await this.publishImmutable(startedPath,{schema:"codex-ae-chat-started/v1",id:request.id,sessionNonce:request.sessionNonce,startedAtEpochMs:Date.now(),action:request.action},"publish-started");if(this.stopping || this.publicationClosing || this.publicationClosed)fail("HOST_STOPPED");if(request.action==="disconnect")this.disconnectPublicationPending=request.id;await this.action(request);outcome={schema:"codex-ae-chat-result/v1",id:request.id,sessionNonce:request.sessionNonce,state:"success"};}
            catch(e){const error=publicError(e);this.state.error=error;this.state.status=error.message;this.save();outcome={schema:"codex-ae-chat-result/v1",id:request.id,sessionNonce:request.sessionNonce,state:"error",error};}
            // Publishing cannot change the known action outcome or cause action evaluation again.
            this.publishTerminal(request.id,resultPath,outcome);
        }finally{if(this.disconnectPublicationPending===request.id){await this.drainPublications(1500);this.closePublications();this.disconnectPublicationPending=null;}this.processing=false;this.consumedPointer={revision,checkedAt:Date.now()};}
    }
    stop() {
        if(!this.stopPromise)this.stopPromise=this.shutdown();
        return this.stopPromise;
    }
    async shutdown() {
        this.stopping=true;
        // turn/start may still be awaiting its acknowledgement; never submit it again.
        if(this.state.busy && !this.state.turnId && this.processing){const deadline=Date.now()+1500;while(this.state.busy && !this.state.turnId && this.processing && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));}
        if(this.rpc && !this.rpc.closed && this.state.busy && !this.state.externalBusy && this.state.turnId){
            let terminal;
            const terminalPromise=new Promise(resolve=>{terminal=resolve;this.terminalWaiters.add(resolve);});
            try{await Promise.race([this.interrupt({}),new Promise(resolve=>setTimeout(resolve,1500))]);if(this.state.busy)await Promise.race([terminalPromise,new Promise(resolve=>setTimeout(resolve,3000))]);}catch(_){}finally{this.terminalWaiters.delete(terminal);}
        }
        if(this.viewer){try{await this.viewer.close();}catch(_){}this.viewer=null;}
        try{this.serverExited=this.rpc ? await this.rpc.close() : true;}catch(error){this.recordHostError(error,"rpc-close");this.serverExited=false;}this.pending.clear();this.state.connectionState="disconnected";this.state.models=[];this.state.modelsStatus="stale";delete this.state.modelsError;this.state.activeModel=null;this.state.activeEffort=null;
        if(this.state.busy || this.serverExited===false){this.state.status="Đã ngắt kết nối; cần kiểm tra lượt chạy trong Codex";this.state.error={code:"TURN_STATE_UNKNOWN",message:"Chưa xác nhận lượt chạy đã kết thúc. Không tự gửi lại hoặc gỡ cài đặt; kiểm tra trong Codex trước."};}
        else this.state.status="Chat đã dừng";
        this.save();
        if(this.lock)this.heartbeat(this.state.busy || this.serverExited===false?"unknown":"stopped");
        this.publicationClosing=true;await this.drainPublications(1500);
        if(!this.disconnectPublicationPending)this.closePublications();
    }
    stopRequested() {try{this.metrics.stopStatChecks++;const revision=fileRevision(path.join(this.dir,"stop"),2048)+"|"+this.state.sessionNonce;if(this.stopCache && revision===this.stopCache.revision && Date.now()-this.stopCache.checkedAt<POINTER_RECHECK_MS){this.metrics.stopCacheHits++;return this.stopCache.value;}this.metrics.stopReads++;const s=readJson(path.join(this.dir,"stop"),2048),value=s.schema==="codex-ae-chat-stop/v1" && Number.isFinite(s.createdAtEpochMs) && s.createdAtEpochMs>=this.startedAt && s.createdAtEpochMs<=Date.now()+5000 && (s.service===true || s.sessionNonce===this.state.sessionNonce);this.stopCache={revision,checkedAt:Date.now(),value};return value;}catch(_){return false;}}
    acquire() {
        this.setup();const lock=path.join(this.dir,"host.lock");assertNoLinks(lock,this.workspace);
        try{fs.mkdirSync(lock);}catch(e){if(e.code!=="EEXIST")throw e;let owner;try{owner=readJson(path.join(lock,"owner.json"),4096);}catch(_){fail("HOST_LOCKED");}if(!Number.isInteger(owner.pid) || owner.pid<1)fail("HOST_LOCKED");let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==="ESRCH")alive=false;}if(alive)fail("HOST_LOCKED");fs.unlinkSync(path.join(lock,"owner.json"));fs.rmdirSync(lock);fs.mkdirSync(lock);}
        atomic(path.join(lock,"owner.json"),{pid:process.pid,workspaceRoot:this.workspace,processStartEpochMs:this.startedAt},true);this.lock=lock;
    }
    heartbeat(state="running") {return this.publishSnapshot("heartbeat",path.join(this.dir,"host.json"),{schema:"codex-ae-chat-host/v1",pid:process.pid,workspaceRoot:this.workspace,processStartEpochMs:this.startedAt,timestampEpochMs:Date.now(),state,sessionNonce:this.state.sessionNonce});}
    async serve() {
        this.acquire();this.save();this.heartbeat();let tick;
        let signal;
        try {await new Promise(resolve=>{
            let stopping=false,polling=false,lastBeat=Date.now();
            const finish=()=>this.stop().then(resolve,error=>{this.recordHostError(error,"shutdown");resolve();});
            const loop=()=>{
                this.metrics.loopTicks++;
                if(this.stopRequested() && !stopping){stopping=true;finish();return;}
                if(this.stopping){resolve();return;}
                const active=this.state.busy && !this.state.externalBusy || this.pending.size>0 || this.processing;
                if(Date.now()-lastBeat>=(active?2000:5000)){this.heartbeat();lastBeat=Date.now();}
                if(!polling){polling=true;this.poll().then(()=>this.syncSharedThread()).catch(error=>{this.recordHostError(error,"poll");this.state.error=publicError(error);try{this.save();}catch(writeError){this.recordHostError(writeError,"poll-state");}}).finally(()=>{polling=false;});}
                tick=setTimeout(loop,this.state.busy && !this.state.externalBusy || this.pending.size>0 || this.processing?ACTIVE_POLL_MS:IDLE_POLL_MS);
            };
            signal=finish;process.once("SIGTERM",signal);process.once("SIGINT",signal);loop();
        });}
        finally {clearTimeout(tick);if(signal){process.removeListener("SIGTERM",signal);process.removeListener("SIGINT",signal);}try{await this.stop();}finally{try{fs.unlinkSync(path.join(this.lock,"owner.json"));fs.rmdirSync(this.lock);}catch(_){}}}
    }
}
module.exports={ChatHost,Rpc,validateImage,findCodex,appServerArgs,publicError,itemMessage,localSkills,isTrustedAeToolApproval,assertNoLinks,atomic,readJson,MAX_STATE,STREAM_PUBLISH_MS,IDLE_POLL_MS,ACTIVE_POLL_MS,POINTER_RECHECK_MS,HISTORY_SYNC_MS,MAX_SKILLS,MAX_SKILL_BYTES};
if(require.main===module){const argv=process.argv.slice(2);if(argv.length!==3 || argv[0]!=="--workspace" || !path.isAbsolute(argv[1]) || argv[2]!=="--serve"){process.stderr.write("Usage: node AeCodexChatHost.js --workspace <absolute-runtime-root> --serve\n");process.exitCode=2;}else {const host=new ChatHost(argv[1]);process.on("uncaughtExceptionMonitor",error=>host.recordHostError(error,"fatal"));host.serve().catch(error=>{host.recordHostError(error,"serve");process.stderr.write("Codex AE chat host unavailable.\n");process.exitCode=1;});}}
