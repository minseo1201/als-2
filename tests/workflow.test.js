import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from '../core.js';
import * as ui from '../ui.js';

// Exercise the actual controller with device/DOM/storage boundaries replaced.
// No simulated sensor is shipped in the application.
async function harness({diskFailure=false,remote=false,remoteFailure=false}={}) {
  let clock=1000, nextTimer=1, activeSensor, frameCallback;
  const timers=new Map(), records=new Map(), writes=new Map();
  class Element extends EventTarget {
    constructor(){super();this.innerHTML='';this.textContent='';this.value='';this.hidden=true;this.disabled=false;this.currentTime=0;this.duration=15;this.playbackRate=1;}
    pause(){}
    load(){queueMicrotask(()=>this.dispatchEvent(new Event('loadeddata')));}
    async play(){this.plays=(this.plays||0)+1;this.dispatchEvent(new Event('playing'));}
    requestVideoFrameCallback(fn){frameCallback=fn;return 1;}
    cancelVideoFrameCallback(){frameCallback=null;}
  }
  const els=new Map();const el=key=>{if(!els.has(key))els.set(key,new Element());return els.get(key);};
  const buttons=[new Element(),new Element()];
  const document=new EventTarget();document.querySelector=el;document.querySelectorAll=()=>buttons;
  document.body={classList:{add(){},remove(){}}};document.hidden=false;
  document.createElement=()=>({click(){}});
  const folder={name:'Records',async queryPermission(){return 'granted';},async getDirectoryHandle(id){return {async getFileHandle(name){return {async createWritable(){if(diskFailure)throw new Error('disk full');return {async write(text){writes.set(`${id}/${name}`,text);},async close(){}};}};}};}};
  class Sensor extends EventTarget {
    constructor(){super();activeSensor=this;}
    start(){queueMicrotask(()=>this.sample(50));}
    stop(){this.stopped=true;}
    sample(lux, timestamp=clock){this.illuminance=lux;this.timestamp=timestamp;this.dispatchEvent(new Event('reading'));}
  }
  const uploads=[];
  class FakeRemoteRun {
    async begin(meta){uploads.push({type:'begin',meta:structuredClone(meta)});}
    async flush(value){uploads.push({type:'batch',samples:structuredClone(value.samples)});}
    async finish(value){if(remoteFailure)throw new Error('receiver offline');uploads.push({type:'finish',run:structuredClone(value)});return {id:value.meta.id,saved:true};}
  }
  const window=new EventTarget();window.showDirectoryPicker=async()=>folder;window.AmbientLightSensor=Sensor;
  const sandbox={__ui:ui,__remote:{receiverConfig:async()=>({mode:'local',label:'이 컴퓨터의 지정 폴더'}),RemoteRun:class{}},__core:core,__db:{getSetting:async()=>folder,setSetting:async()=>{},saveRun:async r=>records.set(r.meta.id,structuredClone(r)),listRuns:async()=>[...records.values()]},document,window,AmbientLightSensor:Sensor,isSecureContext:true,performance:{now:()=>clock,timeOrigin:123456},navigator:{userAgent:'test browser'},screen:{width:1280,height:720},innerWidth:1280,innerHeight:720,devicePixelRatio:1,sessionStorage:{getItem:()=>'',setItem(){}},setTimeout:(fn,ms)=>{const id=nextTimer++;timers.set(id,{fn,at:clock+ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>nextTimer++,clearInterval(){},structuredClone,crypto:{randomUUID:()=> 'a1234567-uuid',subtle:{digest:async()=>new Uint8Array([1,2]).buffer}},Blob,URL,fetch:async()=>({ok:true,blob:async()=>new Blob([new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109])])}),console};
  sandbox.__remote={receiverConfig:async()=>({mode:remote?'remote':'local',label:remote?'연구자 PC':'이 컴퓨터의 지정 폴더'}),RemoteRun:FakeRemoteRun};
  sandbox.window=sandbox.window;const context=vm.createContext(sandbox);
  const source=(await readFile(new URL('../app.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'').replaceAll('import.meta.url',JSON.stringify('http://localhost/app.js'));
  await vm.runInContext(`(async()=>{const {CONSENT_VERSION,consentMarkup,catalogMarkup,filmCards}=__ui;const {receiverConfig,RemoteRun}=__remote;const {summarize,writeRun,validateMp4Header,mediaErrorMessage}=__core;const {getSetting,setSetting,saveRun,listRuns}=__db;${source}\n globalThis.controller={start,finish,navigate,acceptConsent,withdrawConsent,get run(){return run},get busy(){return busy},get last(){return lastResult},videos:VIDEOS};})()`,context);
  async function advance(ms){const end=clock+ms;while(true){const entries=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at);if(!entries.length)break;const [id,t]=entries[0];timers.delete(id);clock=t.at;await t.fn();}clock=end;await Promise.resolve();}
  return {c:context.controller,el,records,writes,uploads,document,video:el('#video'),get sensor(){return activeSensor},agree:async()=>{el('#consent-check').checked=true;await context.controller.acceptConsent();},sample:(v,t)=>activeSensor.sample(v,t),advance,frame:()=>{frameCallback?.(clock,{mediaTime:0,presentationTime:clock-2,expectedDisplayTime:clock+1,presentedFrames:1});}};
}
test('countdown captures Lux before playback; end saves and next measurement returns to selection',async()=>{
  const h=await harness();await h.agree();await h.c.navigate('select');await h.c.start(h.c.videos[1]);
  assert.equal(h.video.plays,undefined);h.sample(52);assert.equal(h.c.run.samples.length,1);
  await h.advance(4999);assert.equal(h.video.plays,undefined);
  await h.advance(1);assert.equal(h.video.plays,1);h.frame();h.sample(55);
  await h.c.finish('video_ended');assert.equal(h.c.busy,false);assert.equal(h.c.last.meta.status,'completed');
  assert.equal(h.writes.size,4);assert.match(h.el('#main').innerHTML,/다음 측정 진행하기/);
  await h.c.navigate('select');assert.match(h.el('#main').innerHTML,/data-video="long"/);assert.match(h.el('#main').innerHTML,/data-video="paper"/);
  const oldId=h.c.last.meta.id;await h.c.start(h.c.videos[0]);assert.notEqual(h.c.run.meta.id,oldId);await h.c.finish('manual_stop');
});
test('disk failure reports unsaved output while retaining raw recovery data',async()=>{
  const h=await harness({diskFailure:true});await h.agree();await h.c.navigate('select');await h.c.start(h.c.videos[0]);h.sample(42);await h.advance(1);
  await h.c.finish('video_ended');assert.equal(h.c.last.meta.disk_saved,false);
  assert.equal([...h.records.values()].at(-1).samples.length,1);
  assert.match(h.el('#main').innerHTML,/브라우저 복구본은 보관되었습니다/);
  assert.doesNotMatch(h.el('#main').innerHTML,/측정 결과가 저장되었습니다/);
});
test('hidden tab interrupts the run and preserves termination reason',async()=>{
  const h=await harness();await h.agree();await h.c.navigate('select');await h.c.start(h.c.videos[0]);
  h.document.hidden=true;h.document.dispatchEvent(new Event('visibilitychange'));
  for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(h.c.last.meta.stop_reason,'page_hidden');assert.equal(h.c.last.meta.status,'interrupted');
});
test('consent cannot be bypassed through navigation or direct start',async()=>{
  const h=await harness();await h.c.navigate('home');assert.match(h.el('#main').innerHTML,/시청 전, 참여 안내/);
  assert.throws(()=>h.c.acceptConsent(),/동의 항목/);
  await h.c.start(h.c.videos[0]);assert.equal(h.sensor,undefined);assert.equal(h.c.run,null);assert.equal(h.writes.size,0);
  await h.c.navigate('declined');assert.equal(h.sensor,undefined);assert.match(h.el('#main').innerHTML,/참여하지 않았습니다/);
});
test('consent opens the movie catalog and withdrawal blocks new capture',async()=>{
  const h=await harness();await h.agree();assert.match(h.el('#main').innerHTML,/국내 영화/);assert.match(h.el('#main').innerHTML,/영화1/);assert.match(h.el('#main').innerHTML,/영화2/);
  await h.c.start(h.c.videos[0]);h.sample(20);await h.advance(1);await h.c.withdrawConsent();
  assert.equal(h.c.last.meta.stop_reason,'consent_withdrawn');assert.equal(h.sensor.stopped,true);
  await h.c.start(h.c.videos[1]);assert.equal(h.c.run,null);assert.match(h.el('#main').innerHTML,/시청 전, 참여 안내/);
});
test('remote mode sends consent and timestamps to researcher without writing participant folder',async()=>{
  const h=await harness({remote:true});assert.match(h.el('#main').innerHTML,/연구자 PC/);assert.equal(h.uploads.length,0);
  await h.agree();await h.c.start(h.c.videos[1]);h.sample(42);await h.advance(5000);h.frame();h.sample(43);await h.advance(1);await h.c.finish('video_ended');
  assert.equal(h.writes.size,0);assert.equal(h.c.last.meta.remote_saved,true);
  assert.equal(h.uploads[0].meta.consent.accepted,true);assert.equal(h.uploads[0].meta.consent.storage_mode,'remote');
  const final=h.uploads.at(-1).run;assert.equal(final.samples.length,2);assert.equal(final.frames.length,1);assert.equal(final.meta.capture_start_ms,1000);
});
test('remote failure keeps recovery data and does not claim server success',async()=>{
  const h=await harness({remote:true,remoteFailure:true});await h.agree();await h.c.start(h.c.videos[0]);h.sample(33);await h.advance(1);await h.c.finish('manual_stop');
  assert.notEqual(h.c.last.meta.remote_saved,true);assert.equal([...h.records.values()].at(-1).samples.length,1);assert.match(h.el('#main').innerHTML,/receiver offline/);
});

