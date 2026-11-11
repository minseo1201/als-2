import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReceiver} from '../server.js';
import {RemoteRun} from '../remote.js';
import {CONSENT_VERSION,consentMarkup} from '../ui.js';

async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'als-receiver-'));
  t.after(async()=>{if(!dataDir.startsWith(join(tmpdir(),'als-receiver-')))throw new Error('Unexpected cleanup path');await rm(dataDir,{recursive:true,force:true});});
  const receiver=createReceiver({dataDir,adminToken:'researcher-test-key',label:'실험실 수신 컴퓨터'});
  async function request(path,{method='GET',body,secret,origin='http://localhost'}={}){
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    req.method=method;req.url=path;req.socket={encrypted:false};req.headers={host:'localhost',origin,'content-type':'application/json',...(secret?{authorization:`Bearer ${secret}`}:{})};
    const headers={};let status=200,content;
    const res={headersSent:false,setHeader(k,v){headers[k]=v;},writeHead(code,h){status=code;Object.assign(headers,h);this.headersSent=true;},end(value){content=value;}};
    await receiver.handle(req,res);
    return {status,headers,data:headers['Content-Type']?.includes('json')?JSON.parse(content):String(content)};
  }
  const meta={id:'EXP_receiver_test01',started_utc:'2026-11-11T00:00:00Z',video_id:'long',video_title:'영화1',consent:{version:CONSENT_VERSION,accepted:true,accepted_at:'2026-11-11T00:00:00Z',storage_mode:'remote',receiver_label:'실험실 수신 컴퓨터'}};
  const batch={seq:0,samples:[[1000,1002,30]],frames:[[1001,0,999,1003,1]],events:[['CAPTURE_START',990,0]]};
  return {request,meta,batch,dataDir};
}
test('receiver refuses missing consent and other-origin collection',async t=>{
  const f=await fixture(t);let result=await f.request('/api/runs',{method:'POST',body:{meta:{...f.meta,consent:null}}});assert.equal(result.status,400);
  result=await f.request('/api/runs',{method:'POST',body:{meta:f.meta},origin:'https://elsewhere.example'});assert.equal(result.status,403);
});
test('consented session reaches receiver disk; retries do not duplicate samples',async t=>{
  const f=await fixture(t);const start=await f.request('/api/runs',{method:'POST',body:{meta:f.meta}});assert.equal(start.status,201);
  const secret=start.data.token,base=`/api/runs/${start.data.id}`;
  assert.equal((await f.request(base+'/batch',{method:'POST',secret,body:f.batch})).status,200);
  const repeat=await f.request(base+'/batch',{method:'POST',secret,body:f.batch});assert.equal(repeat.data.duplicate,true);
  const invalid=await f.request(base+'/batch',{method:'POST',secret,body:{...f.batch,samples:[[1,2,99]]}});assert.equal(invalid.status,409);
  const finished=await f.request(base+'/finish',{method:'POST',secret,body:{meta:{...f.meta,status:'completed',capture_end_ms:2000},batches:1}});assert.equal(finished.status,200);
  const csv=await readFile(join(f.dataDir,f.meta.id,'als_raw.csv'),'utf8');assert.match(csv,/1000,1002,2,-3,30/);
  const admin=await f.request('/api/admin/runs',{secret:'researcher-test-key'});assert.equal(admin.data[0].received_samples,1);assert.equal(admin.data[0].remote_saved,true);
  const download=await f.request(`/api/admin/runs/${f.meta.id}`,{secret:'researcher-test-key'});assert.deepEqual(download.data.samples,[[1000,1002,30]]);
});
test('session keys cannot read researcher records or upload to another session',async t=>{
  const f=await fixture(t);const start=await f.request('/api/runs',{method:'POST',body:{meta:f.meta}});
  assert.equal((await f.request('/api/admin/runs')).status,401);
  assert.equal((await f.request('/api/admin/runs',{secret:start.data.token})).status,401);
  assert.equal((await f.request(`/api/runs/${f.meta.id}/batch`,{method:'POST',secret:'wrong-key',body:f.batch})).status,401);
  assert.equal((await f.request(`/server-data/${f.meta.id}/record.json`)).status,404);
  assert.equal((await f.request('/server.js')).status,404);
});
test('incomplete runs remain downloadable and malformed samples are rejected',async t=>{
  const f=await fixture(t);const start=await f.request('/api/runs',{method:'POST',body:{meta:f.meta}});const secret=start.data.token;
  assert.equal((await f.request(`/api/runs/${f.meta.id}/batch`,{method:'POST',secret,body:{...f.batch,samples:[[1,2,'bad']]}})).status,400);
  await f.request(`/api/runs/${f.meta.id}/batch`,{method:'POST',secret,body:f.batch});
  const data=await f.request(`/api/admin/runs/${f.meta.id}`,{secret:'researcher-test-key'});assert.equal(data.data.meta.status,'receiving');assert.equal(data.data.samples.length,1);
  assert.equal((await f.request(`/api/runs/${f.meta.id}/finish`,{method:'POST',secret,body:{meta:f.meta,batches:2}})).status,409);
});
test('remote uploader retries identical payload after a lost acknowledgment, then sends new data',async()=>{
  const uploader=new RemoteRun();uploader.id='EXP_example01';const received=[];let lost=true;
  uploader.request=async(path,body)=>{received.push(structuredClone(body));if(lost){lost=false;throw new Error('connection lost');}return {saved:true};};
  const run={samples:[[1,2,3]],frames:[],events:[]};await assert.rejects(uploader.flush(run),/connection lost/);
  run.samples.push([4,5,6]);await uploader.flush(run);
  assert.deepEqual(received[0],received[1]);assert.deepEqual(received[2].samples,[[4,5,6]]);assert.equal(uploader.offsets.samples,2);
});
test('consent copy names actual storage mode and does not preselect consent',()=>{
  assert.match(consentMarkup({mode:'remote',label:'연구자 PC'}),/연구자 PC/);
  assert.match(consentMarkup({mode:'local'}),/서버로 전송하지 않습니다/);
  assert.doesNotMatch(consentMarkup({mode:'remote',label:'PC'}),/type="checkbox"[^>]*\bchecked\b/);
});
