"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,".."),source=fs.readFileSync(path.join(root,"source/bridge.js"),"utf8"),latest=source.replace(/^#.*$/gm,"");
const harness={require,process,__dirname,console,Buffer};vm.createContext(harness);
const hostSource=fs.readFileSync(path.join(__dirname,"Test-AeBridgeLibrary.js"),"utf8");
vm.runInContext(hostSource.slice(0,hostSource.indexOf("const tests = [];"))+"\nthis.makeHost=mockHost;",harness);
function flatten(node){const rows=[];for(const child of node.children||[]){rows.push(child,...flatten(child));}return rows;}
function fixture(){
    const host=harness.makeHost({keepAutoStart:true});
    // Exercise current source even before an edited same-version bundle is rebuilt.
    host.dollar.global.__codexAeBridgeV1.version="prior-fixture";vm.runInContext(latest,host.context);
    const bridge=host.dollar.global.__codexAeBridgeV1;host.bridge=bridge;
    bridge.window.size={width:440,height:310};bridge.ui.reflow(true);
    const controls=flatten(bridge.window),button=text=>controls.find(node=>node.type==="button"&&node.text===text);
    return{host,bridge,controls,button,resize(w,h){bridge.window.size={width:w,height:h};bridge.ui.reflow(true);}};
}
function manualLibrary(f,preferences={effectsEnabled:true,sfxEnabled:false,manualRefresh:true}){
    const calls=[],library={state:{state:"ready"},refreshPending:false,getPreferences(){return Object.assign({},preferences);},
        setEnabled(kind,value){calls.push(["setEnabled",kind,value]);preferences[kind+"Enabled"]=value;},
        requestRefresh(){calls.push(["requestRefresh"]);if(this.refreshPending||this.state.state==="scanning")return false;this.refreshPending=true;return true;},
        getSfxRoots(){return ["E:\\Audio\\SFX","C:\\Users\\nguye\\Downloads"];},setSfxRoots(roots){calls.push(["setSfxRoots",Array.from(roots)]);if(!roots.length)preferences.sfxEnabled=false;return roots;},
        describe(){return "Thư viện: cập nhật thủ công";},stop(){this.refreshPending=false;},tick(){calls.push(["tick"]);}};
    f.bridge.library=library;f.bridge.running=true;f.bridge.ready=true;f.bridge.busy=false;f.bridge.pendingReport=null;f.bridge.pendingCleanupFile=null;
    f.bridge.refreshLibraryDisplay();return{library,calls,preferences,controls:f.bridge.libraryControls};
}
function folderDialog(f,run,picks=[]){
    const dialogs=[];
    function control(type,text){const node={type,text:text||"",children:[],graphics:{},enabled:true,add(kind,bounds,value,properties){
        const child=control(kind,kind==="item"?bounds:value);child.parent=this;child.creationProperties=properties||{};
        if(kind==="item"){child.index=this.items.length;this.items.push(child);}else this.children.push(child);return child;
    },items:[],removeAll(){this.items=[];this.selection=null;}};
        let selection=null;Object.defineProperty(node,"selection",{get(){return selection;},set(value){selection=typeof value==="number"?this.items[value]||null:value;}});return node;}
    f.host.context.Window=function(type,title){const dialog=control(type,title);Object.assign(this,dialog);this.center=function(){};
        this.close=function(code){this.closed=code;};this.show=function(){dialogs.push(this);run(this,flatten(this));};};
    f.host.context.Folder.selectDialog=function(){return picks.length?picks.shift():null;};return dialogs;
}
const tests=[],test=(name,run)=>tests.push({name,run});
test("2.0.4 creates twenty four lightweight tools library connection progress and log controls",()=>{
    const f=fixture();assert.equal(f.bridge.version,"2.0.4");assert.equal(f.controls.length,24);
    assert.equal(f.bridge.chat,undefined);assert.equal(f.bridge.modelText,undefined);assert.equal(f.controls.filter(node=>node.type==="edittext").length,1);
    assert.ok(f.bridge.logView.creationProperties.readonly);assert.ok(f.bridge.logView.creationProperties.scrollable);
    for(const type of ["tabbedpanel","tab","dropdownlist","listbox","image"]){assert.equal(f.controls.some(node=>node.type===type),false,type);}
    assert.ok(f.controls.some(node=>node.text==="Codex AE · Công cụ & kết nối"));
    assert.equal(f.controls.filter(node=>node.type==="checkbox").length,2);
    assert.match(f.button("Cập nhật").helpTip,/Chưa tải|Chỉ lập chỉ mục/);
});
test("new controllers have no chat IPC model discovery thumbnail image viewer or approval implementation",()=>{
    for(const expression of [/function ChatPanel/,/new ChatPanel/,/this\.chat\.(tick|start|stop)/,/\.ae-codex\/chat/,/model-display/,/refreshModelDisplay/,/ScriptUI\.newImage/,/drawImage/,/prepareMedia/,/skills\/list/,/turn\/(start|steer)/])assert.equal(expression.test(source),false,String(expression));
    new vm.Script(latest);
});
test("library load failures retain bounded native line and file diagnostics without a scan retry",()=>{
    const f=fixture();let calls=0;f.bridge.bundle.run=function(){calls++;throw {toString(){return "SyntaxError: Expected )";},line:155,fileName:"Codex Library.jsx"};};
    f.bridge.beginLibrary();assert.equal(calls,1);assert.equal(f.bridge.library,null);
    assert.match(f.bridge.libraryDisplayValue,/Expected \).*line 155.*Codex Library\.jsx/);
    const message=f.bridge.logs[f.bridge.logs.length-1].message;assert.match(message,/line 155/);assert.ok(message.length<=1000);assert.equal(f.host.executionCount,0);
});
test("tools and archive buttons expose retained direct capability catalogs without an AI request",()=>{
    const f=fixture();let functions=0,archive=0;f.bridge.showFunctions=()=>functions++;f.bridge.showScripts=()=>archive++;
    const writes=f.host.writes.length;f.button("Công cụ").onClick();f.button("Kho script").onClick();
    assert.equal(functions,1);assert.equal(archive,1);assert.equal(f.host.writes.length,writes);assert.equal(f.host.executionCount,0);
    assert.equal(typeof f.bridge.functions.run,"function");assert.equal(typeof f.bridge.processJob,"function");
});
test("the tools panel connects automatically once and Stop prevents idle reconnection",()=>{
    const f=fixture();assert.equal(f.bridge.running,true);assert.equal(f.host.scheduled.size,1);
    f.host.connect();assert.equal(f.bridge.ready,true);f.button("Dừng").onClick();
    assert.equal(f.bridge.running,false);assert.equal(f.host.scheduled.size,0);f.host.advanceTime(60000);
    vm.runInContext(latest,f.host.context);assert.equal(f.bridge.running,false);assert.equal(f.host.scheduled.size,0);
    f.button("Kết nối lại").onClick();assert.equal(f.bridge.running,true);assert.equal(f.host.scheduled.size,1);
});
test("one hundred repeated loader calls reuse native controls without growing palettes or timers",()=>{
    const f=fixture(),count=f.host.createdWindows.length,window=f.bridge.window,ui=f.bridge.ui,roots=f.bridge.ownedUiRoots;
    for(let i=0;i<100;i++)vm.runInContext(latest,f.host.context);
    assert.equal(f.host.createdWindows.length,count);assert.equal(f.bridge.window,window);assert.equal(f.bridge.ui,ui);
    assert.equal(f.bridge.ownedUiRoots,roots);assert.equal(flatten(window).length,24);assert.equal(f.host.scheduled.size,1);
});
test("the work log starts collapsed expands locally and retains progress errors and bounded history",()=>{
    const f=fixture(),panel=f.controls.find(node=>node.type==="panel"),writes=f.host.writes.length;
    assert.equal(panel.visible,false);f.resize(440,430);f.button("Nhật ký ▸").onClick();assert.equal(panel.visible,true);
    for(let i=0;i<250;i++)f.bridge.log(i===249?"error":"info","Event "+i);
    assert.equal(f.bridge.logs.length,200);assert.match(f.bridge.logView.text,/Event 249/);assert.match(f.bridge.logSummary.text,/Lỗi: Event 249/);
    f.button("Nhật ký ▾").onClick();assert.equal(panel.visible,false);assert.equal(f.bridge.logs.length,200);
    assert.equal(f.host.writes.slice(writes).some(entry=>/chat|model-display/.test(entry.path||entry.file||"")),false);
});
test("compact resized layouts keep connection action buttons and footer inside the dock",()=>{
    const f=fixture();for(const [w,h] of [[340,220],[440,310],[800,430],[1280,800]]){
        for(const expanded of [false,true])for(const progress of [false,true]){
            f.bridge.ui.logExpanded=expanded;f.bridge.progressGroup.visible=progress;f.resize(w,h);
            for(const root of f.bridge.ownedUiRoots){if(root.visible===false)continue;const bounds=root.bounds;assert.ok(bounds.every(Number.isFinite));assert.ok(bounds[0]>=0&&bounds[1]>=0&&bounds[2]<=w&&bounds[3]<=h);assert.ok(bounds[2]>=bounds[0]&&bounds[3]>=bounds[1]);}
            const row=f.button("Công cụ").parent;assert.ok(row.bounds[1]>=63,"buttons do not cover the connection status");
            for(const label of ["Công cụ","Kho script","Kết nối lại","Dừng"]){const b=f.button(label).bounds;assert.ok(b[0]>=0&&b[2]<=w-18&&b[3]-b[1]===30);}
            const options=f.button("Cập nhật").parent;assert.ok(options.bounds[1]>=63);assert.ok(options.bounds[3]+6<=row.bounds[1]);
            for(const child of options.children){const b=child.bounds;assert.ok(b[0]>=0&&b[2]<=w-18&&b[3]-b[1]===24);}
        }
    }
});
test("an unchanged idle layout performs no native bounds writes or new controls",()=>{
    const f=fixture(),nodes=f.controls;let writes=0;
    for(const node of nodes){let bounds=node.bounds;Object.defineProperty(node,"bounds",{configurable:true,get(){return bounds;},set(value){writes++;bounds=value;}});}
    for(let i=0;i<1000;i++)f.bridge.ui.reflow(false);
    assert.equal(writes,0);assert.equal(flatten(f.bridge.window).length,24);
});
test("unchanged tool status and connection snapshots do not rewrite native text or graphics",()=>{
    const f=fixture();f.bridge.refreshScriptsDisplay();f.bridge.setConnectionStatus(true,"Sẵn sàng");let writes=0;
    for(const control of [f.bridge.scriptsText,f.bridge.connectionText]){
        for(const key of ["text","helpTip"]){let current=control[key];Object.defineProperty(control,key,{configurable:true,get(){return current;},set(value){writes++;current=value;}});}
    }
    const g=f.bridge.connectionText.graphics;let pen=g.foregroundColor;Object.defineProperty(g,"foregroundColor",{get(){return pen;},set(value){writes++;pen=value;}});
    for(let i=0;i<1000;i++){f.bridge.refreshScriptsDisplay();f.bridge.setConnectionStatus(true,"Sẵn sàng");}
    assert.equal(writes,0);
});
test("connected idle ticks never read model chat state media or history files",()=>{
    const f=fixture();f.host.connect();const reads=[],read=f.host.File.prototype.read;
    f.host.File.prototype.read=function(){reads.push(this.fsName);return read.apply(this,arguments);};
    for(let i=0;i<100;i++)f.host.fireNext();
    assert.equal(reads.some(file=>/\/chat\/|model-display|previews|history/i.test(file)),false);assert.equal(f.host.executionCount,0);
    assert.equal(f.host.scheduled.size,1);assert.equal(f.bridge.chat,undefined);
});
test("saved library switches are rendered without indexing and toggles only save their named preference",()=>{
    const f=fixture(),m=manualLibrary(f);
    assert.equal(m.controls.effects.value,true);assert.equal(m.controls.sfx.value,false);assert.equal(m.controls.refresh.enabled,true);assert.equal(m.calls.length,0);
    m.controls.sfx.value=true;m.controls.sfx.onClick();m.controls.effects.value=false;m.controls.effects.onClick();
    assert.deepEqual(m.calls,[["setEnabled","sfx",true],["setEnabled","effects",false]]);assert.equal(m.library.refreshPending,false);
    assert.equal(m.preferences.effectsEnabled,false);assert.equal(m.preferences.sfxEnabled,true);assert.equal(f.host.executionCount,0);
    assert.match(m.controls.effects.helpTip,/Không tắt effects hay layer/);assert.match(m.controls.sfx.helpTip,/Không tắt âm thanh/);
});
test("manual refresh queues one request and stays disabled until asynchronous indexing is done",()=>{
    const f=fixture(),m=manualLibrary(f);m.controls.refresh.onClick();
    assert.deepEqual(m.calls,[["requestRefresh"]]);assert.equal(m.library.refreshPending,true);assert.equal(m.controls.refresh.enabled,false);
    assert.match(f.bridge.logs[f.bridge.logs.length-1].message,/Đã nhận yêu cầu/);assert.equal(f.host.executionCount,0);
    m.library.refreshPending=false;m.library.state.state="scanning";f.bridge.refreshLibraryControls();assert.equal(m.controls.refresh.enabled,false);
    m.library.state.state="ready";f.bridge.refreshLibraryControls();assert.equal(m.controls.refresh.enabled,true);
    m.library.requestRefresh=function(){m.calls.push(["requestRefresh"]);return false;};m.controls.refresh.onClick();
    assert.match(f.bridge.logs[f.bridge.logs.length-1].message,/Chưa nhận yêu cầu/);assert.equal(m.controls.refresh.enabled,true);
});
test("library actions stay disabled while stopped busy or reporting and unavailable backends cannot dispatch",()=>{
    const f=fixture(),m=manualLibrary(f);for(const key of ["busy","pendingReport","pendingCleanupFile"]){
        f.bridge[key]=true;f.bridge.refreshLibraryControls();assert.equal(m.controls.refresh.enabled,false);assert.equal(m.controls.effects.enabled,false);
        assert.equal(f.bridge.requestLibraryRefresh(),false);assert.equal(f.bridge.setLibraryEnabled("sfx",true),false);f.bridge[key]=null;
    }
    f.bridge.running=false;f.bridge.refreshLibraryControls();assert.equal(m.controls.refresh.enabled,false);assert.equal(f.bridge.requestLibraryRefresh(),false);
    assert.equal(m.calls.length,0);f.bridge.running=true;f.bridge.library={describe(){return "Thư viện chưa tải";}};f.bridge.refreshLibraryDisplay();
    assert.equal(m.controls.refresh.enabled,false);assert.equal(m.controls.effects.enabled,false);assert.match(m.controls.refresh.helpTip,/Chưa tải/);
    assert.equal(f.bridge.requestLibraryRefresh(),false);assert.equal(f.host.executionCount,0);
});
test("failed preference writes restore saved switches and report the error without retry or scan",()=>{
    const f=fixture(),m=manualLibrary(f);let writes=0;m.library.setEnabled=function(){writes++;throw new Error("bad config");};
    m.controls.sfx.value=true;m.controls.sfx.onClick();assert.equal(writes,1);assert.equal(m.controls.sfx.value,false);assert.equal(m.calls.length,0);
    assert.match(f.bridge.logs[f.bridge.logs.length-1].message,/Không lưu được.*bad config/);
    m.library.requestRefresh=function(){throw new Error("bad refresh config");};assert.equal(f.bridge.requestLibraryRefresh(),false);
    assert.match(f.bridge.logs[f.bridge.logs.length-1].message,/Không cập nhật được.*bad refresh config/);assert.equal(m.library.refreshPending,false);
});
test("unchanged saved library preferences and availability do not rewrite native checkbox or button properties",()=>{
    const f=fixture(),m=manualLibrary(f);let writes=0;
    for(const control of [m.controls.effects,m.controls.sfx,m.controls.folders,m.controls.refresh])for(const key of ["value","enabled","helpTip"]){
        let current=control[key];Object.defineProperty(control,key,{configurable:true,get(){return current;},set(value){writes++;current=value;}});
    }
    for(let i=0;i<1000;i++)f.bridge.refreshLibraryControls();assert.equal(writes,0);assert.equal(m.calls.length,0);
    m.preferences.effectsEnabled=false;f.bridge.refreshLibraryControls();assert.equal(m.controls.effects.value,false);assert.equal(m.controls.refresh.enabled,false);
});
test("the SFX folders dialog preserves existing roots adds selected folders and removes only a configured path",()=>{
    const f=fixture(),m=manualLibrary(f);let initial=[];
    const dialogs=folderDialog(f,(dialog,nodes)=>{
        const list=nodes.find(node=>node.type==="listbox"),button=text=>nodes.find(node=>node.type==="button"&&node.text===text);
        initial=list.items.map(item=>item.text);button("Thêm thư mục…").onClick();assert.equal(list.selection.text,"F:\\New SFX");
        list.selection=0;list.onChange();button("Bỏ khỏi danh sách").onClick();assert.equal(list.selection.text,"C:\\Users\\nguye\\Downloads");button("Lưu").onClick();
        assert.match(button("Bỏ khỏi danh sách").helpTip,/không xóa thư mục/);
    },[{fsName:"F:\\New SFX"}]);
    assert.equal(m.controls.folders.enabled,true);m.controls.folders.onClick();
    assert.deepEqual(initial,["E:\\Audio\\SFX","C:\\Users\\nguye\\Downloads"]);
    assert.deepEqual(m.calls,[["setSfxRoots",["C:\\Users\\nguye\\Downloads","F:\\New SFX"]]]);
    assert.equal(dialogs[0].closed,1);assert.equal(m.preferences.sfxEnabled,false);assert.equal(m.library.refreshPending,false);assert.equal(f.host.executionCount,0);
});
test("opening SFX folders selects a visible first row and Remove works without an injected selection",()=>{
    const f=fixture(),m=manualLibrary(f);const dialogs=folderDialog(f,(dialog,nodes)=>{
        const list=nodes.find(node=>node.type==="listbox"),button=text=>nodes.find(node=>node.type==="button"&&node.text===text);
        assert.equal(list.creationProperties.multiselect,false);assert.equal(list.selection,list.items[0]);assert.equal(button("Bỏ khỏi danh sách").enabled,true);
        assert.ok(nodes.some(node=>/chọn dòng → Bỏ khỏi danh sách → Lưu/.test(node.text)));
        assert.equal(button("Bỏ khỏi danh sách").creationProperties.name,undefined);assert.equal(button("Lưu").creationProperties.name,"ok");
        button("Bỏ khỏi danh sách").onClick();assert.deepEqual(list.items.map(item=>item.text),["C:\\Users\\nguye\\Downloads"]);
        assert.equal(list.selection,list.items[0]);assert.ok(nodes.some(node=>/Đã bỏ.*Bấm Lưu/.test(node.text)));assert.deepEqual(m.calls,[]);
        button("Lưu").onClick();
    });m.controls.folders.onClick();assert.equal(dialogs[0].closed,1);
    assert.deepEqual(m.calls,[["setSfxRoots",["C:\\Users\\nguye\\Downloads"]]]);assert.equal(m.library.refreshPending,false);assert.equal(f.host.executionCount,0);
});
test("consecutive SFX folder removals retain selection and the last removal can be saved with SFX off",()=>{
    const f=fixture(),m=manualLibrary(f,{effectsEnabled:true,sfxEnabled:true,manualRefresh:true});
    const dialogs=folderDialog(f,(dialog,nodes)=>{
        const list=nodes.find(node=>node.type==="listbox"),button=text=>nodes.find(node=>node.type==="button"&&node.text===text);
        list.selection=1;list.onChange();button("Bỏ khỏi danh sách").onClick();assert.equal(list.selection,list.items[0]);assert.equal(button("Bỏ khỏi danh sách").enabled,true);
        button("Bỏ khỏi danh sách").onClick();assert.equal(list.items.length,0);assert.equal(list.selection,null);assert.equal(button("Bỏ khỏi danh sách").enabled,false);
        assert.equal(button("Lưu").enabled,true);assert.ok(nodes.some(node=>/0\/32.*Không xóa dữ liệu.*Lưu.*tắt kiểm kê SFX/.test(node.text)));
        assert.deepEqual(m.calls,[]);button("Lưu").onClick();
    });m.controls.folders.onClick();assert.equal(dialogs[0].closed,1);assert.deepEqual(m.calls,[["setSfxRoots",[]]]);
    assert.equal(m.preferences.sfxEnabled,false);assert.equal(m.controls.sfx.value,false);assert.equal(m.preferences.effectsEnabled,true);
    assert.equal(m.library.refreshPending,false);assert.equal(f.host.executionCount,0);assert.match(f.bridge.logs[f.bridge.logs.length-1].message,/danh sách thư mục trống.*tắt kiểm kê SFX/);
});
test("missing malformed and stale SFX list selections never remove a different row",()=>{
    const f=fixture(),m=manualLibrary(f);folderDialog(f,(dialog,nodes)=>{
        const list=nodes.find(node=>node.type==="listbox"),button=text=>nodes.find(node=>node.type==="button"&&node.text===text),original=list.items.map(item=>item.text),stale=list.items[0];
        for(const selection of [null,{index:0},{index:-1},{index:2},{index:0.5},{index:"0"},[stale]]){
            list.selection=selection;list.onChange();assert.equal(button("Bỏ khỏi danh sách").enabled,false);button("Bỏ khỏi danh sách").onClick();
            assert.deepEqual(list.items.map(item=>item.text),original);assert.ok(nodes.some(node=>/Chọn một dòng thư mục cần bỏ/.test(node.text)));
        }
        list.selection=list.items[0];list.onChange();assert.equal(button("Bỏ khỏi danh sách").enabled,true);button("Bỏ khỏi danh sách").onClick();
        list.selection=stale;list.onChange();assert.equal(button("Bỏ khỏi danh sách").enabled,false);button("Bỏ khỏi danh sách").onClick();
        assert.deepEqual(list.items.map(item=>item.text),["C:\\Users\\nguye\\Downloads"]);button("Hủy").onClick();
    });m.controls.folders.onClick();assert.deepEqual(m.calls,[]);assert.equal(m.library.refreshPending,false);assert.equal(f.host.executionCount,0);
});
test("canceling SFX folder removals preserves the saved roots when the dialog opens again",()=>{
    const f=fixture(),m=manualLibrary(f);let opened=0;const dialogs=folderDialog(f,(dialog,nodes)=>{
        const list=nodes.find(node=>node.type==="listbox"),button=text=>nodes.find(node=>node.type==="button"&&node.text===text);
        assert.deepEqual(list.items.map(item=>item.text),["E:\\Audio\\SFX","C:\\Users\\nguye\\Downloads"]);
        if(opened++===0){button("Bỏ khỏi danh sách").onClick();assert.equal(list.items.length,1);}button("Hủy").onClick();
    });m.controls.folders.onClick();m.controls.folders.onClick();assert.equal(opened,2);assert.equal(dialogs.every(dialog=>dialog.closed===0),true);
    assert.deepEqual(m.calls,[]);assert.equal(m.library.refreshPending,false);assert.equal(f.host.executionCount,0);
});
test("canceling the SFX folders dialog or native picker never changes roots or starts a scan",()=>{
    const f=fixture(),m=manualLibrary(f);const dialogs=folderDialog(f,(dialog,nodes)=>{
        const button=text=>nodes.find(node=>node.type==="button"&&node.text===text);button("Thêm thư mục…").onClick();button("Hủy").onClick();
    });m.controls.folders.onClick();assert.equal(dialogs[0].closed,0);assert.deepEqual(m.calls,[]);assert.equal(m.library.refreshPending,false);
});
test("a rejected SFX root save stays visible and logs the real error without scan retry or enabling SFX",()=>{
    const f=fixture(),m=manualLibrary(f);let saves=0;m.library.setSfxRoots=function(){saves++;throw new Error("Specific folder required");};
    const dialogs=folderDialog(f,(dialog,nodes)=>{nodes.find(node=>node.type==="button"&&node.text==="Lưu").onClick();
        assert.equal(dialog.closed,undefined);assert.ok(nodes.some(node=>/Không lưu được:.*Specific folder required/.test(node.text)));});
    m.controls.folders.onClick();assert.equal(dialogs.length,1);assert.equal(saves,1);assert.match(f.bridge.logs[f.bridge.logs.length-1].message,/Specific folder required/);
    assert.equal(m.preferences.sfxEnabled,false);assert.equal(m.library.refreshPending,false);assert.equal(f.host.executionCount,0);
});
test("a queued manual library update yields to AE jobs and unpublished results before its idle tick",()=>{
    const f=fixture(),m=manualLibrary(f);m.controls.refresh.onClick();f.host.job("manual-library-job-0001");f.host.fireNext();
    assert.equal(f.host.executionCount,1);assert.equal(m.calls.filter(call=>call[0]==="tick").length,0);
    f.bridge.pendingReport={};f.bridge.busy=false;f.bridge.publishPendingReport=function(){};f.host.fireNext();
    assert.equal(m.calls.filter(call=>call[0]==="tick").length,0,"even an inconsistent busy flag cannot bypass unpublished results");
    f.bridge.pendingReport=null;f.host.fireNext();assert.equal(m.calls.filter(call=>call[0]==="tick").length,1);
    assert.equal(m.calls.filter(call=>call[0]==="requestRefresh").length,1);assert.equal(f.host.executionCount,1);
});
test("button styling leaves painting and disabled labels to the native host without replacing actions",()=>{
    const styled=[],sandbox={cartoonSurface(){styled.push(Array.from(arguments));}};vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf("    function cartoonButton("),source.indexOf("    function cartoonDialog(")),sandbox);
    let actions=0,drawOverrides=0;const onClick=()=>actions++,color=[0.19,0.29,0.46,1],button={text:"Công cụ",enabled:false,onClick,helpTip:"Công cụ đã cài"};
    Object.defineProperty(button,"graphics",{get(){throw new Error("paint context must not be captured by button styling");}});
    Object.defineProperty(button,"onDraw",{get(){return undefined;},set(){drawOverrides++;throw new Error("host owns native button painting");}});
    assert.doesNotThrow(()=>sandbox.cartoonButton(button,color));assert.equal(drawOverrides,0);assert.equal(button.onDraw,undefined);
    assert.deepEqual(Array.from(button.preferredSize),[110,32]);assert.equal(styled.length,1);
    assert.deepEqual(styled[0],[button,color,"Segoe UI",12]);assert.equal(button.text,"Công cụ");assert.equal(button.enabled,false);
    assert.equal(button.helpTip,"Công cụ đã cài");assert.equal(button.onClick,onClick);
    button.enabled=true;button.text="Kết nối lại";button.onClick();assert.equal(actions,1);assert.equal(button.onDraw,undefined);
});
test("unavailable old graphics cannot leave a blank custom paint callback or disable a native button",()=>{
    const sandbox={ScriptUI:{newFont(){return{};}},cartoonInk:[]};vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf("    function cartoonSurface("),source.indexOf("    function cartoonDialog(")),sandbox);
    let actions=0,reads=0;const onClick=()=>actions++,button={text:"Thư mục…",enabled:true,onClick};
    Object.defineProperty(button,"graphics",{get(){reads++;throw new Error("native graphics context was invalidated");}});
    assert.doesNotThrow(()=>sandbox.cartoonButton(button,[]));assert.ok(reads>0,"exercise the optional theme failure");
    assert.equal(button.onDraw,undefined);assert.equal(button.text,"Thư mục…");assert.equal(button.enabled,true);assert.equal(button.onClick,onClick);
    button.onClick();assert.equal(actions,1);
});
test("connection transitions reuse cached native pens rather than allocating graphics per refresh",()=>{
    const f=fixture(),graphics=f.bridge.connectionText.graphics,original=graphics.newPen;let allocations=0;
    graphics.newPen=function(){allocations++;return original.apply(this,arguments);};
    for(let i=0;i<1000;i++)f.bridge.setConnectionStatus(i%2===0,"Trạng thái thử");
    assert.equal(allocations,0);assert.match(f.bridge.connectionText.text,/Trạng thái thử/);
});
test("closing the owned floating palette releases callbacks and the listener without touching project data",()=>{
    const f=fixture(),window=f.bridge.window,roots=Array.from(f.bridge.ownedUiRoots);window.close();
    assert.equal(f.host.dollar.global.__codexAeBridgeV1,null);assert.equal(f.host.scheduled.size,0);assert.equal(f.bridge.window,null);
    assert.equal(f.bridge.ui,null);assert.equal(f.bridge.ownedUiRoots.length,0);assert.equal(f.host.executionCount,0);
    assert.ok(flatten({children:roots}).filter(node=>node.type==="button").every(node=>node.onClick===null));
});
let failed=0;for(const {name,run}of tests){try{run();console.log("PASS "+name);}catch(error){failed++;console.error("FAIL "+name+"\n"+error.stack);}}
console.log((tests.length-failed)+"/"+tests.length+" tools-only panel tests passed");process.exitCode=failed?1:0;
