import http from 'node:http';
import https from 'node:https';
import {readFile,writeFile,mkdir,readdir,rename} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {filesFor,summarize} from './core.js';
import {CONSENT_VERSION} from './ui.js';

const ROOT=dirname(fileURLToPath(import.meta.url));
const VALID_ID=/^EXP_[A-Za-z0-9_-]{8,100}$/;
const token=()=>randomBytes(32).toString('hex');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const failure=(status,message)=>Object.assign(new Error(message),{status});
async function atomic(path,data){await writeFile(path+'.tmp',data);await rename(path+'.tmp',path);}
async function jsonBody(req){
  if(!req.headers['content-type']?.startsWith('application/json'))throw failure(415,'JSON 요청이 필요합니다.');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw failure(413,'한 번에 전송할 데이터가 너무 큽니다.');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure(400,'JSON 형식 오류');}
}
function validateMeta(meta){
  if(!meta||!VALID_ID.test(meta.id||'')||typeof meta.started_utc!=='string')throw failure(400,'실험 정보가 올바르지 않습니다.');
  const c=meta.consent;
  if(c?.accepted!==true||c.version!==CONSENT_VERSION||c.storage_mode!=='remote'||!Number.isFinite(Date.parse(c.accepted_at)))throw failure(400,'현재 안내에 대한 명시적인 원격 수집 동의가 필요합니다.');
  if(!['long','paper'].includes(meta.video_id))throw failure(400,'알 수 없는 영상입니다.');
}
function validateRows(batch){
  if(!Number.isInteger(batch.seq)||batch.seq<0||batch.seq>2000)throw failure(400,'잘못된 전송 순서');
  for(const [key,width] of [['samples',3],['frames',5],['events',3]]){
    if(!Array.isArray(batch[key])||batch[key].length>10000)throw failure(400,'잘못된 기록 배열');
    for(const row of batch[key]){
      if(!Array.isArray(row)||row.length!==width)throw failure(400,'잘못된 기록 열');
      if(key==='events') {if(typeof row[0]!=='string'||row[0].length>100||!row.slice(1).every(Number.isFinite))throw failure(400,'잘못된 사건 기록');}
      else if(!row.every(Number.isFinite))throw failure(400,'숫자가 아닌 측정값');
      if(key==='samples'&&(row[0]<0||row[2]<0))throw failure(400,'잘못된 센서 측정값');
    }
  }
}
async function readRun(folder){
  const meta=JSON.parse(await readFile(join(folder,'record.json'),'utf8'));
  const run={meta,samples:[],frames:[],events:[]};
  const names=(await readdir(join(folder,'batches'))).filter(n=>/^\d{6}\.json$/.test(n)).sort();
  for(const name of names){const batch=JSON.parse(await readFile(join(folder,'batches',name),'utf8'));for(const key of ['samples','frames','events'])run[key].push(...batch[key]);}
  return run;
}
export function createReceiver({dataDir=join(ROOT,'server-data'),adminToken=token(),label='연구자 컴퓨터',publicOrigin='',tls}={}){
  dataDir=resolve(dataDir);
  const sessions=new Map();
  const publicFiles=new Set(['index.html','style.css','app.js','core.js','db.js','ui.js','remote.js','researcher.html','researcher.js']);
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  function admin(req){if(!equal(req.headers.authorization,`Bearer ${adminToken}`))throw failure(401,'연구자 접근 키를 확인해 주세요.');}
  async function handle(req,res){
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','ambient-light-sensor=(self)');
    try{
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/api/config'){json(res,200,{mode:'remote',label});return;}
      if(req.method==='GET'&&path==='/api/admin/runs'){
        admin(req);await mkdir(dataDir,{recursive:true});const records=[];
        for(const id of await readdir(dataDir)){if(!VALID_ID.test(id))continue;try{const run=await readRun(join(dataDir,id));records.push({...run.meta,received_samples:run.samples.length,received_frames:run.frames.length});}catch{}}
        json(res,200,records.sort((a,b)=>b.started_utc.localeCompare(a.started_utc)));return;
      }
      const download=path.match(/^\/api\/admin\/runs\/(EXP_[A-Za-z0-9_-]+)$/);
      if(req.method==='GET'&&download){admin(req);if(!VALID_ID.test(download[1]))throw failure(400,'잘못된 ID');const run=await readRun(join(dataDir,download[1]));res.setHeader('Content-Disposition',`attachment; filename="${download[1]}.json"`);json(res,200,run);return;}
      if(req.method==='POST'&&path.startsWith('/api/runs')){
        // Same-origin browser requests only. The Origin check is not an authentication substitute.
        const expected=publicOrigin||`${req.socket.encrypted?'https':'http'}://${req.headers.host}`;
        if(req.headers.origin!==expected)throw failure(403,'이 사이트에서 시작한 요청만 받을 수 있습니다.');
        const body=await jsonBody(req);
        if(path==='/api/runs'){
          validateMeta(body.meta);
          for(const[id,item]of sessions)if(!item.locked&&Date.now()-item.touched>30*60*1000)sessions.delete(id);
          if([...sessions.values()].filter(s=>!s.finished).length>=100)throw failure(429,'동시 실험 수를 초과했습니다.');
          const id=body.meta.id,folder=join(dataDir,id);await mkdir(dataDir,{recursive:true});
          try{await mkdir(folder);}catch(e){if(e.code==='EEXIST')throw failure(409,'이미 사용한 실험 ID입니다.');throw e;}
          await mkdir(join(folder,'batches'));
          const meta={...body.meta,status:'receiving',remote_saved:false,receiver_label:label};
          await atomic(join(folder,'record.json'),JSON.stringify(meta,null,2));
          const secret=token();sessions.set(id,{secret,seq:0,count:0,locked:false,touched:Date.now(),meta,folder});json(res,201,{id,token:secret});return;
        }
        const match=path.match(/^\/api\/runs\/(EXP_[A-Za-z0-9_-]+)\/(batch|finish)$/);
        if(!match)throw failure(404,'알 수 없는 API');
        const session=sessions.get(match[1]);
        if(!session||!equal(req.headers.authorization,`Bearer ${session.secret}`))throw failure(401,'실험 세션이 만료됐습니다. 복구본을 다시 전송해 주세요.');
        if(session.locked)throw failure(409,'이전 전송을 처리 중입니다.');session.locked=true;session.touched=Date.now();
        try{
          if(match[2]==='batch'){
            if(session.finished)throw failure(409,'이미 종료한 실험입니다.');
            validateRows(body);const batchPath=join(session.folder,'batches',String(body.seq).padStart(6,'0')+'.json');
            const encoded=JSON.stringify(body),digest=createHash('sha256').update(encoded).digest('hex');
            if(body.seq<session.seq){const existing=await readFile(batchPath);if(createHash('sha256').update(existing).digest('hex')!==digest)throw failure(409,'같은 순번의 내용이 다릅니다.');json(res,200,{accepted:true,duplicate:true});return;}
            if(body.seq!==session.seq)throw failure(409,'전송 순서가 맞지 않습니다.');
            const increment=body.samples.length+body.frames.length+body.events.length;
            if(session.count+increment>100000)throw failure(413,'한 실험의 기록 한도를 초과했습니다.');
            await atomic(batchPath,encoded);session.count+=increment;session.seq++;json(res,200,{accepted:true});return;
          }
          if(body.batches!==session.seq)throw failure(409,'아직 수신하지 못한 데이터가 있습니다.');
          validateMeta(body.meta);if(body.meta.id!==match[1]||JSON.stringify(body.meta.consent)!==JSON.stringify(session.meta.consent))throw failure(400,'실험 또는 동의 정보가 바뀌었습니다.');
          const run=await readRun(session.folder);
          run.meta={...body.meta,receiver_label:label,remote_saved:true,disk_saved:false,received_at:new Date().toISOString(),summary:summarize(run.samples)};
          for(const [name,contents]of Object.entries(filesFor(run)))await atomic(join(session.folder,name),contents);
          await atomic(join(session.folder,'record.json'),JSON.stringify(run.meta,null,2));
          session.finished=true;json(res,200,{id:match[1],saved:true});return;
        }finally{session.locked=false;}
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw failure(405,'지원하지 않는 요청 방식');
      const name=path==='/'?'index.html':decodeURIComponent(path.slice(1));
      const allowed=publicFiles.has(name)||/^videos\/[A-Za-z0-9_.-]+\.(mp4|json)$/.test(name);
      if(!allowed)throw failure(404,'파일을 찾을 수 없습니다.');
      const content=await readFile(join(ROOT,name));const ext=name.split('.').at(-1);
      const mime={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',mp4:'video/mp4',json:'application/json'}[ext];
      res.writeHead(200,{'Content-Type':mime,'Content-Length':content.length,'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){if(!res.headersSent)json(res,e.status||(e.code==='ENOENT'?404:500),{error:e.status?e.message:e.code==='ENOENT'?'기록을 찾을 수 없습니다.':'수신 서버의 파일 저장에 실패했습니다.'});else res.end();}
  }
  const server=tls?https.createServer(tls,handle):http.createServer(handle);
  return {server,handle,adminToken,dataDir};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const tls=process.env.TLS_KEY_FILE&&process.env.TLS_CERT_FILE?{key:await readFile(process.env.TLS_KEY_FILE),cert:await readFile(process.env.TLS_CERT_FILE)}:undefined;
  const receiver=createReceiver({dataDir:process.env.ALS_DATA_DIR,adminToken:process.env.ALS_ADMIN_TOKEN,label:process.env.ALS_RECEIVER_LABEL||'연구자 컴퓨터',publicOrigin:process.env.ALS_PUBLIC_ORIGIN||'',tls});
  receiver.server.listen(Number(process.env.PORT||8000),process.env.HOST||'127.0.0.1',()=>{
    console.log(`참가자 페이지: ${tls?'https':'http'}://localhost:${receiver.server.address().port}`);
    console.log(`연구자 페이지: /researcher.html\n저장 위치: ${receiver.dataDir}\n연구자 접근 키: ${receiver.adminToken}`);
    console.log('다른 컴퓨터에서 측정하려면 참가자가 접속할 수 있는 신뢰된 HTTPS 주소로 제공해야 합니다.');
  });
}
