"use strict";
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFunctionsRuntime} = require('../tools/AeFunctionsSource');
function fixture() {
  let serial=1, failCopy=false, removed=false, groups=0;
  class CompItem {
    constructor(name) {Object.assign(this,{name,id:serial++,width:1080,height:1920,pixelAspect:1,frameRate:24,duration:59,members:[]});}
    get numLayers(){return this.members.length;} layer(i){return this.members[i-1];}
    get usedIn(){return project.list.filter(c=>c.members.some(l=>l.source===this));}
    remove(){removed=true;project.list.splice(project.list.indexOf(this),1);}
  }
  class Layer {
    constructor(comp,name,source){Object.assign(this,{name,id:serial++,containingComp:comp,source,parent:null,locked:false,enabled:true,stretch:100,startTime:0,inPoint:0,outPoint:59,blendingMode:1,hasAudio:false});comp.members.push(this);}
    get index(){return this.containingComp.members.indexOf(this)+1;}
    property(name){if(name==='ADBE Transform Group')return {property:n=>({numKeys:0,expressionEnabled:false,value:({'ADBE Position':[540,960,0],'ADBE Anchor Point':[540,960,0],'ADBE Scale':[100,100,100],'ADBE Rotate Z':0,'ADBE Opacity':100})[n]})};return {numProperties:0};}
    copyToComp(dest){if(failCopy&&this.name==='Child')throw Error('copy failed');const l=new Layer(dest,this.name,this.source);l.keys=this.keys;l.locked=this.locked;dest.members.splice(dest.members.indexOf(l),1);dest.members.unshift(l);}
    moveBefore(other){const a=this.containingComp.members;a.splice(a.indexOf(this),1);a.splice(a.indexOf(other),0,this);}
    setParentWithJump(p){this.parent=p;}
    remove(){const a=this.containingComp.members;a.splice(a.indexOf(this),1);}
  }
  const project={list:[],get numItems(){return this.list.length;},item(i){return this.list[i-1];},renderQueue:{numItems:0}};
  const dest=new CompItem('Main'),src=new CompItem('Nested');project.list.push(dest,src);project.activeItem=dest;
  const wrapper=new Layer(dest,'Container',src),bg=new Layer(dest,'Background',{});
  const child=new Layer(src,'Child',{}),parent=new Layer(src,'Rig',{});child.parent=parent;child.keys=[{time:2,value:25}];parent.locked=true;
  const box={app:{project,beginUndoGroup(){groups++;},endUndoGroup(){groups--;}},CompItem,BlendingMode:{NORMAL:1},$:{global:{}}};vm.createContext(box);vm.runInContext(readFunctionsRuntime(),box);
  const run=(removeUnusedSource=true)=>box.$.global.__codexAeFunctionsV1.run({schema:'codex-ae-functions/v1',steps:[{function:'comp.unpack',args:{comp:{id:dest.id},layer:{name:'Container'},removeUnusedSource}}]});
  return {dest,src,wrapper,bg,child,parent,project,run,get removed(){return removed;},get groups(){return groups;},set failCopy(v){failCopy=v;}};
}
let f=fixture();const result=f.run();assert.equal(result.results[0].value.unpackedLayers,2);assert.deepEqual(f.dest.members.map(l=>l.name),['Child','Rig','Background']);assert.equal(f.dest.layer(1).parent,f.dest.layer(2));assert.deepEqual(f.dest.layer(1).keys,[{time:2,value:25}]);assert.equal(f.dest.layer(2).locked,true);assert.equal(f.removed,true);assert.equal(f.groups,0);
f=fixture();f.wrapper.startTime=1;assert.throws(()=>f.run(),/unshifted/);assert.equal(f.dest.numLayers,2);assert.equal(f.removed,false);
f=fixture();new f.dest.constructor('unused');const shared=new f.dest.constructor('Shared');f.project.list.push(shared);shared.members.push({source:f.src});assert.throws(()=>f.run(),/shared/);assert.equal(f.dest.numLayers,2);
f=fixture();f.failCopy=true;assert.throws(()=>f.run(),/copy failed/);assert.deepEqual(f.dest.members.map(l=>l.name),['Container','Background']);assert.equal(f.removed,false);assert.equal(f.groups,0);
console.log('comp.unpack: native layer order, parenting, keys, locks, deletion guards, rollback and undo verified in isolated fixtures.');
