/* Explicit Codex result media only. The viewer never proxies remote URLs. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const {fileURLToPath} = require("node:url");
const {spawn} = require("node:child_process");

const ITEM_LIMIT = 8, PAGE_LIMIT = 32, TEXT_LIMIT = 131072, SOURCE_LIMIT = 4096;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const VIDEO = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const MIME = {".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp", ".mp4":"video/mp4", ".m4v":"video/mp4", ".mov":"video/quicktime", ".webm":"video/webm"};
const MEDIA_ID = /^media-[a-f0-9]{20}$/;
function error(code) { const e = new Error(code); e.code = code; return e; }
function label(value, fallback) { return String(value || fallback || "Kết quả").replace(/[\x00-\x1f\x7f]/g, " ").slice(0,160); }
function kindOf(value) { const ext = path.extname(String(value).split(/[?#]/,1)[0]).toLowerCase(); return IMAGE.has(ext) ? "image" : VIDEO.has(ext) ? "video" : null; }
function localPath(value) {
    if (typeof value !== "string" || !value || value.length > SOURCE_LIMIT || /[\x00-\x1f\x7f]/.test(value)) return null;
    try { if (/^file:/i.test(value)) value = fileURLToPath(value); } catch (_) { return null; }
    // Do not contact network shares, device paths or alternate data streams.
    if (/^(?:\\\\|\/\/|\\\?\\|\\\.\\)/.test(value) || !path.isAbsolute(value) || (process.platform === "win32" && value.slice(2).includes(":"))) return null;
    return path.resolve(value);
}
function remoteUrl(value) {
    if (typeof value !== "string" || !value || value.length > SOURCE_LIMIT || /[\x00-\x20\x7f]/.test(value)) return null;
    try {
        const u = new URL(value), hostname = u.hostname.replace(/\.+$/, "").toLowerCase();
        if (u.protocol !== "https:" || u.username || u.password || !hostname || /^(?:localhost|.+\.localhost|.+\.local)$/.test(hostname)) return null;
        // Public result hosts only. Never turn the viewer into a local-network client.
        if (/^\[/.test(hostname) || /^\d+(?:\.\d+){3}$/.test(hostname)) return null;
        return u.href;
    } catch (_) { return null; }
}
function markdownSource(value) {
    // Only a Markdown href uses URL escaping. Bare/structured local paths are
    // literal filenames, signed HTTPS URLs must be preserved, and file URLs
    // already receive exactly one decoding pass in fileURLToPath.
    if(remoteUrl(value) || /^file:/i.test(value))return value;
    if(!localPath(value))return null;
    try {const decoded=decodeURIComponent(value);return localPath(decoded)?decoded:null;}catch(_){return null;}
}
function descriptor(source, kind, name, poster) {
    if (typeof source !== "string") return null;
    const url = remoteUrl(source), file = url ? null : localPath(source);
    if (!url && !file) return null;
    const inferred = kindOf(url || file);
    if (url) {
        const ext = path.extname(new URL(url).pathname).toLowerCase();
        if (ext && !IMAGE.has(ext) && !VIDEO.has(ext)) return null;
    }
    kind = kind === "image" || kind === "video" ? kind : inferred;
    if (!kind || (inferred && inferred !== kind) || (!url && inferred !== kind)) return null;
    const normalized = url || file;
    const d = {id:"media-"+crypto.createHash("sha256").update(kind+"\0"+normalized).digest("hex").slice(0,20),kind,label:label(name,path.basename(url ? new URL(url).pathname : file))};
    if (url) d.url = url; else d.path = file;
    if (kind === "video" && poster) {
        const p = remoteUrl(poster) || localPath(poster);
        if (p && kindOf(p) === "image") d.poster = p;
    }
    return d;
}
function extractMedia(item) {
    if (!item || typeof item !== "object" || item.type === "userMessage") return [];
    const media = [], seen = new Set(); let nodes = 0, textBytes = 0;
    function add(source, kind, name, poster) {
        if (media.length >= ITEM_LIMIT) return;
        const d = descriptor(source,kind,name,poster);
        if (d && !seen.has(d.id)) { seen.add(d.id); media.push(d); }
    }
    function scanText(value) {
        if (typeof value !== "string" || media.length >= ITEM_LIMIT || textBytes >= TEXT_LIMIT) return;
        value = value.slice(0,TEXT_LIMIT-textBytes); textBytes += value.length;
        // Structured CLI responses define which URLs are works and which are covers.
        // Never rescan successfully parsed JSON as loose text and promote incidental URLs.
        if (value.trim().startsWith("{") || value.trim().startsWith("[")) { try { scanObject(JSON.parse(value),0); return; } catch (_) {} }
        const md = /!?\[([^\]\r\n]{0,200})\]\(/g;
        let m;
        while ((m = md.exec(value)) && media.length < ITEM_LIMIT) {
            let start=md.lastIndex, end=start, depth=0, angle=false, valid=false;
            while(/\s/.test(value[start] || "") && start<value.length)start++;
            if(value[start]==="<"){angle=true;start++;end=start;}
            for(end=start;end<value.length && end-start<=SOURCE_LIMIT;end++){
                const ch=value[end];if(ch==="\r" || ch==="\n")break;
                if(ch==="\\" && /[()]/.test(value[end+1] || "")){end++;continue;}
                if(angle){if(ch===">"){valid=/^\s*\)/.test(value.slice(end+1,end+20));break;}}
                else if(ch==="(")depth++;
                else if(ch===")"){if(depth===0){valid=true;break;}depth--;}
            }
            if(valid){const source=value.slice(start,end).trim().replace(/\s+["'][^"']*["']$/, "").replace(/\\([()])/g,"$1");add(markdownSource(source),null,m[1]);md.lastIndex=end+1;}
        }
        // Unstructured CLI output commonly contains an absolute saved path.
        const urls = /https:\/\/[^\s<>"'`\]\)]+/g;
        while ((m=urls.exec(value)) && media.length < ITEM_LIMIT) add(m[0].replace(/[.,;!]+$/,""));
        for (const line of value.split(/\r?\n/).slice(0,400)) {
            const clean = line.trim().replace(/^(?:saved(?:\s+to)?|output(?:\s+file)?|result|path|ảnh|video)\s*[:=]\s*/i, "").replace(/^["'`]|["'`]$/g, "");
            if (kindOf(clean)) add(clean);
        }
    }
    function scanObject(value, depth) {
        if (!value || typeof value !== "object" || depth > 7 || ++nodes > 350 || media.length >= ITEM_LIMIT) return;
        if (Array.isArray(value)) { for (const child of value.slice(0,40)) scanObject(child,depth+1); return; }
        const type = value.contentType === "image" || value.contentType === "video" ? value.contentType : value.type === "image" || value.type === "video" ? value.type : null;
        if (typeof value.url === "string") add(value.url,type,value.title || value.name,value.coverUrl);
        if (typeof value.image_url === "string") add(value.image_url,"image",value.title);
        if (value.type === "inputImage" && typeof value.imageUrl === "string") add(value.imageUrl,"image",value.title);
        if (type && typeof value.path === "string") add(value.path,type,value.title || value.name,value.coverUrl);
        // Traverse returned content only; never examine tool arguments, auth fields or arbitrary URLs.
        for (const key of ["works","data","result","structuredContent","content","contentItems","output","resource"]) {
            const child = value[key]; if (typeof child === "string") scanText(child); else scanObject(child,depth+1);
        }
        if (["text","outputText","inputText","input_text"].includes(value.type) && typeof value.text === "string") scanText(value.text);
        if (value.type === "resource_link" && typeof value.uri === "string") add(value.uri,null,value.name);
    }
    if (item.type === "agentMessage") scanText(item.text);
    else if (item.type === "commandExecution") scanText(item.aggregatedOutput);
    else if (item.type === "imageGeneration") { if (!item.failure) add(item.savedPath,"image","Ảnh tạo bởi Codex"); }
    else if (item.type === "imageView") add(item.path,"image","Ảnh trong cuộc chat");
    else if (["mcpToolCall","dynamicToolCall","functionCallOutput"].includes(item.type)) {
        for (const key of ["result","contentItems","output"]) { if (typeof item[key] === "string") scanText(item[key]); else scanObject(item[key],0); }
    }
    return media;
}
function mergeMedia(messages) {
    const result = [], seen = new Set();
    for (let i = (Array.isArray(messages) ? messages.length : 0)-1; i >= 0; i--) {
        const list = Array.isArray(messages[i].media) ? messages[i].media.slice(0,ITEM_LIMIT) : [];
        for (let n=list.length-1; n>=0; n--) {
            const m=list[n]; if (!m || typeof m !== "object") continue;
            const d=descriptor(m.url || m.path,m.kind,m.label,m.poster);
            if(d && !seen.has(d.id)){seen.add(d.id);result.unshift(d);if(result.length>=PAGE_LIMIT)return result;}
        }
    }
    return result;
}
function noLinks(file) {
    let current=path.parse(file).root;
    for(const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
        current=path.join(current,part);
        if(fs.lstatSync(current).isSymbolicLink())throw error("MEDIA_INVALID");
    }
}
function openLocal(file, kind) {
    const absolute=localPath(file), ext=absolute && path.extname(absolute).toLowerCase();
    if(!absolute || kindOf(absolute)!==kind)throw error("MEDIA_INVALID");
    noLinks(absolute);
    const fd=fs.openSync(absolute,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const stat=fs.fstatSync(fd), h=Buffer.alloc(64);
        if(!stat.isFile() || stat.size<8 || stat.size>(kind==="image" ? 50*1024*1024 : 2*1024*1024*1024))throw error("MEDIA_INVALID");
        fs.readSync(fd,h,0,h.length,0);
        const valid=(ext===".png" && h.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
            ([".jpg",".jpeg"].includes(ext) && h[0]===255 && h[1]===216 && h[2]===255) ||
            (ext===".gif" && /^GIF8[79]a/.test(h.toString("ascii",0,6))) ||
            (ext===".webp" && h.toString("ascii",0,4)==="RIFF" && h.toString("ascii",8,12)==="WEBP") ||
            ([".mp4",".m4v",".mov"].includes(ext) && h.toString("ascii",4,8)==="ftyp") ||
            (ext===".webm" && h.subarray(0,4).equals(Buffer.from([26,69,223,163])));
        if(!valid)throw error("MEDIA_INVALID");
        return {fd,size:stat.size,mime:MIME[ext]};
    } catch(e) {fs.closeSync(fd);throw e;}
}
function escape(value) { return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
const CSS="html{color-scheme:dark}body{margin:0;background:#171923;color:#edf1ff;font:15px/1.5 Segoe UI,sans-serif}header{padding:22px 5vw;border-bottom:2px solid #373e55;background:#202432}h1{font-size:24px;margin:0 0 5px}p{margin:5px 0;color:#b8c2db}main{max-width:1300px;margin:auto;padding:24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:22px}article{padding:16px;background:#232938;border:2px solid #404b69;border-radius:18px;box-shadow:4px 5px #10131c;min-width:0}article:target{grid-column:1/-1;border-color:#78d8b0}h2{font-size:16px;overflow-wrap:anywhere}img,video{display:block;width:100%;max-height:75vh;object-fit:contain;border-radius:10px;background:#0b0d13}a{color:#8fe1ff;overflow-wrap:anywhere}.note{font-size:13px}.error{padding:25px;border:1px dashed #66708b;border-radius:10px}footer{padding:15px 5vw;color:#9aa8c5}.badge{color:#b3a2ff;font-size:12px}";
function launchBrowser(url) {
    if(process.platform!=="win32")return Promise.reject(error("MEDIA_LAUNCH"));
    return new Promise((resolve,reject)=>{
        const child=spawn(path.join(process.env.SystemRoot || "C:\\Windows","explorer.exe"),[url],{shell:false,windowsHide:true,stdio:"ignore",detached:true});
        child.once("error",()=>reject(error("MEDIA_LAUNCH")));child.once("spawn",()=>{child.unref();resolve();});
    });
}
class MediaViewer {
    constructor(options={}) {this.options=options;this.server=null;this.entries=[];this.files=new Map();this.sockets=new Set();this.token="";}
    async open(media, mediaId) {
        const normalized=mergeMedia((Array.isArray(media)?media:[]).slice(-PAGE_LIMIT).map(m=>({media:[m]})));
        if(mediaId!==undefined && (typeof mediaId!=="string" || !MEDIA_ID.test(mediaId) || !normalized.some(m=>m.id===mediaId)))throw error("MEDIA_INVALID");
        const entries=[], files=new Map();
        function localRoute(file,kind) {
            const opened=openLocal(file,kind);fs.closeSync(opened.fd);
            const key=String(files.size);files.set(key,{path:file,kind});return key;
        }
        for(const m of normalized) {
            const entry={...m};
            if(m.path) {try{entry.file=localRoute(m.path,m.kind);}catch(_){entry.unavailable=true;}}
            if(m.poster && localPath(m.poster)) {try{entry.posterFile=localRoute(m.poster,"image");}catch(_){delete entry.poster;}}
            entries.push(entry);
        }
        if(!entries.length)throw error("MEDIA_EMPTY");
        if(!this.server) {
            this.server=http.createServer((req,res)=>this.handle(req,res));
            this.server.on("connection",s=>{this.sockets.add(s);s.once("close",()=>this.sockets.delete(s));});
            this.server.on("clientError",(_,s)=>s.destroy());
            this.server.requestTimeout=15000;this.server.headersTimeout=10000;
            await new Promise((resolve,reject)=>{this.server.once("error",reject);this.server.listen(0,"127.0.0.1",()=>{this.server.removeListener("error",reject);resolve();});});
        }
        this.token=crypto.randomBytes(24).toString("hex");this.entries=entries;this.files=files;
        const url=this.origin()+"/"+this.token+"/"+(mediaId?"#"+mediaId:"");
        await (this.options.launch || launchBrowser)(url);
        return {url,count:entries.length};
    }
    origin() {return "http://127.0.0.1:"+this.server.address().port;}
    headers() {
        return {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff", "Referrer-Policy":"same-origin", "Cross-Origin-Resource-Policy":"same-origin", "Content-Security-Policy":"default-src 'none'; img-src 'self' https:; media-src 'self' https:; style-src 'sha256-"+crypto.createHash("sha256").update(CSS).digest("base64")+"'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'", "X-Frame-Options":"DENY"};
    }
    handle(req,res) {
        const origin=this.origin(), headers=this.headers();
        const reject=(status=403)=>{res.writeHead(status,{...headers,"Content-Type":"text/plain; charset=utf-8"});res.end("Không thể mở nội dung này.");};
        if(!["GET","HEAD"].includes(req.method))return reject(405);
        if(req.headers.host!==origin.slice(7) || (req.headers.origin && req.headers.origin!==origin) || (req.headers["sec-fetch-site"] && !["none","same-origin"].includes(req.headers["sec-fetch-site"])))return reject();
        if(req.headers.referer && !req.headers.referer.startsWith(origin+"/"+this.token+"/"))return reject();
        if(req.url==="/"+this.token+"/") {
            const body=Buffer.from(this.html());res.writeHead(200,{...headers,"Content-Type":"text/html; charset=utf-8","Content-Length":body.length});return res.end(req.method==="HEAD"?undefined:body);
        }
        const prefix="/"+this.token+"/media/", key=req.url.startsWith(prefix)?req.url.slice(prefix.length):"";
        if(!/^\d{1,3}$/.test(key) || !this.files.has(key))return reject(404);
        const file=this.files.get(key);let opened;
        try{opened=openLocal(file.path,file.kind);}catch(_){return reject(404);}
        let start=0,end=opened.size-1,status=200;
        if(req.headers.range) {
            const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if(!match || (!match[1] && !match[2])){fs.closeSync(opened.fd);res.writeHead(416,{...headers,"Content-Range":"bytes */"+opened.size});return res.end();}
            if(!match[1])start=Math.max(0,opened.size-Number(match[2]));else start=Number(match[1]);
            if(match[1] && match[2])end=Math.min(end,Number(match[2]));
            if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start>=opened.size){fs.closeSync(opened.fd);res.writeHead(416,{...headers,"Content-Range":"bytes */"+opened.size});return res.end();}
            status=206;
        }
        const fileHeaders={...headers,"Content-Type":opened.mime,"Content-Length":end-start+1,"Accept-Ranges":"bytes"};
        if(status===206)fileHeaders["Content-Range"]="bytes "+start+"-"+end+"/"+opened.size;
        res.writeHead(status,fileHeaders);
        if(req.method==="HEAD"){fs.closeSync(opened.fd);return res.end();}
        const stream=fs.createReadStream(file.path,{fd:opened.fd,autoClose:true,start,end});
        stream.once("error",()=>res.destroy());res.once("close",()=>stream.destroy());stream.pipe(res);
    }
    html() {
        const root="/"+this.token+"/media/";
        const cards=this.entries.map(m=>{
            const source=m.file!==undefined?root+m.file:m.url;
            const poster=m.posterFile!==undefined?root+m.posterFile:m.poster;
            const content=m.unavailable?'<p class="error">Tệp đã di chuyển, không tồn tại hoặc định dạng không được hỗ trợ.</p>':m.kind==="video"?'<video controls preload="metadata" playsinline'+(poster?' poster="'+escape(poster)+'"':"")+' src="'+escape(source)+'"></video>':'<img loading="lazy" alt="'+escape(m.label)+'" src="'+escape(source)+'">';
            return '<article id="'+escape(m.id)+'"><span class="badge">'+(m.kind==="video"?"VIDEO":"ẢNH")+'</span><h2>'+escape(m.label)+'</h2>'+content+(m.url?'<p class="note"><a href="'+escape(m.url)+'" target="_blank" rel="noopener noreferrer">Mở liên kết gốc</a> · Liên kết có thể hết hạn.</p>':"")+'</article>';
        }).join("");
        return '<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex AE · Ảnh và video</title><style>'+CSS+'</style><header><h1>Codex AE · Ảnh và video</h1><p>Kết quả từ cuộc chat trên máy này. Video có thể phát bằng các nút bên dưới.</p><p class="note">Không tải xuống hoặc nhập vào After Effects tự động. Đóng trang khi xem xong.</p></header><main>'+cards+'</main><footer>Trình xem cục bộ · '+this.entries.length+' kết quả · Dừng chat sẽ đóng kết nối trình xem.</footer></html>';
    }
    async close() {
        const server=this.server;if(!server)return;
        this.server=null;this.token="";this.entries=[];this.files.clear();
        for(const socket of this.sockets)socket.destroy();this.sockets.clear();
        await new Promise(resolve=>server.close(resolve));
    }
}
// Result references and the explicitly opened media viewer do not decode
// bitmaps or create background thumbnail workers.
module.exports={extractMedia,mergeMedia,MediaViewer};
