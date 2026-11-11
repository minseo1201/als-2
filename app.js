import {summarize, writeRun, validateMp4Header, mediaErrorMessage} from './core.js';
import {getSetting, setSetting, saveRun, listRuns} from './db.js';
import {CONSENT_VERSION, consentMarkup, catalogMarkup, filmCards} from './ui.js';
import {receiverConfig, RemoteRun} from './remote.js';

const main = document.querySelector('#main'), stage = document.querySelector('#stage');
const video = document.querySelector('#video'), countdown = document.querySelector('#countdown');
const VIDEOS = [
  {id:'long',title:'영화1',description:'3분',file:'ALS_30_patterns_3s_pattern_3s_black.mp4'},
  {id:'paper',title:'영화2',description:'15초',file:'ALS_30_patterns_paper_style.mp4'}
];
let folder = null, route = 'home', sensor = null, liveLux = null, sensorCount = 0;
let run = null, busy = false, ending = false, target = 0, timer, checkpointTimer, frameHandle, wakeLock;
let checkpointQueue = Promise.resolve(), lastResult = null, diagnosticTimer;
let prepared = new Map(), lastCheckpointError = '';
let unsecuredResult = false, watchdogTimer, lastProgress = 0, lastPosition = 0;
let consent=null, receiver={mode:'local',label:'이 컴퓨터의 지정 폴더'}, receiverError='';
let remoteRun=null, uploadQueue=Promise.resolve(), uploadError='',uploadInFlight=false;

const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now = () => performance.now();
const notice = message => {document.querySelector('#notice').textContent = message;};
const event = name => { if (run && !ending) run.events.push([name,now(),video.currentTime]); };
const back = '<button class="back" data-action="home">← 처음 화면으로</button>';
function badge() { document.querySelector('#folder-badge').textContent = consent ? '연구 참여 중' : '참여 안내'; }
function header(title,subtitle) { return `${back}<div class="eyebrow">FRAME / STUDY</div><h1>${title}</h1><p>${subtitle}</p>`; }
function acceptConsent() {
  if(receiverError)throw new Error(receiverError);
  if(!document.querySelector('#consent-check')?.checked)throw new Error('안내를 확인한 뒤 동의 항목을 선택해 주세요.');
  consent={version:CONSENT_VERSION,accepted:true,accepted_at:new Date().toISOString(),storage_mode:receiver.mode,receiver_label:receiver.label};
  badge();return navigate('home');
}
async function withdrawConsent() {
  stopSensor();
  if(run)await finish('consent_withdrawn');
  consent=null;badge();await navigate('consent');
}

async function navigate(next) {
  if (busy) return;
  if (unsecuredResult) {notice('결과가 아직 저장되지 않았습니다. 폴더에 저장하거나 원본 JSON을 먼저 다운로드하세요.');return;}
  if(!consent && !['consent','declined'].includes(next))next='consent';
  clearInterval(diagnosticTimer); diagnosticTimer = null;
  route = next; notice('');
  if (sensor && next !== 'diagnostic') { sensor.stop(); sensor = null; }
  if(next==='consent') {main.innerHTML=consentMarkup(receiver,receiverError);return;}
  if(next==='declined') {main.innerHTML='<div class="consent-wrap"><div class="eyebrow">PARTICIPATION CLOSED</div><h1>참여하지 않았습니다.</h1><p>센서 측정과 데이터 전송을 시작하지 않았습니다. 이 창을 닫아도 됩니다.</p><button data-action="consent">참여 안내 다시 보기</button></div>';return;}
  if (next === 'home') {
    main.innerHTML=catalogMarkup(VIDEOS,receiver.mode==='remote');
    VIDEOS.forEach(v=>prepareAsset(v).catch(()=>{}));
  } else if (next === 'diagnostic') {
    main.innerHTML = header('센서 연결 확인','실제 센서 이벤트가 수신되는지 확인합니다. 화면 밝기와 주변 조명을 바꿔 값의 변화를 살펴보세요.') + `<div class="panel"><div class="eyebrow">LIVE ILLUMINANCE</div><div class="metric" id="lux">— <small>lux</small></div><p id="sensor-status">확인 전</p><button data-action="check">센서 확인 시작</button><p class="subtle">요청 빈도: 100Hz · 실제 보고 빈도와 조도 정밀도는 기기·브라우저에 따라 다릅니다.</p></div>`;
  } else if (next === 'select') {
    main.innerHTML=header('국내 영화','시청할 영화를 선택하세요.')+filmCards(VIDEOS);

    VIDEOS.forEach(v => prepareAsset(v).catch(() => {}));
  } else if (next === 'storage') {
    const locationPanel=receiver.mode==='remote'?`<div class="panel"><div class="eyebrow">RECEIVER</div><h2>${escape(receiver.label)}</h2><p>연구자 수신 서버에 저장합니다. 참가자 컴퓨터의 폴더 선택은 필요하지 않습니다.</p><a href="./researcher.html">연구자 수신 기록</a></div>`:`<div class="panel"><div class="eyebrow">SAVE LOCATION</div><h2>${escape(folder?.name || '저장 폴더를 선택해 주세요.')}</h2><p class="subtle">선택한 폴더 이름을 표시합니다.</p><button data-action="folder">저장 폴더 선택 / 변경</button></div>`;
    main.innerHTML=header('연구 설정','저장 위치와 이 브라우저의 복구 기록을 확인합니다.')+locationPanel+`<div class="panel"><label for="subject">실험 코드 / 대상 (선택)</label><input id="subject" maxlength="200" value="${escape(sessionStorage.getItem('als-subject')||'')}" placeholder="실험 진행자가 지정한 코드"><label for="notes">실험 조건 메모 (선택)</label><textarea id="notes" maxlength="2000">${escape(sessionStorage.getItem('als-notes')||'')}</textarea></div><div class="panel" id="records">기록을 읽는 중…</div><p class="subtle">아래는 이 브라우저에 보관된 복구 기록입니다. 연구자 서버에 있는 전체 기록은 연구자 화면에서 확인합니다.</p>`;
    try {
      const records = (await listRuns()).sort((a,b) => b.meta.started_utc.localeCompare(a.meta.started_utc));
      if (route !== 'storage') return;
      document.querySelector('#records').innerHTML = records.length ? `<div class="table-wrap"><table><thead><tr><th>실험 / 대상</th><th>영상</th><th>상태</th><th>결과</th></tr></thead><tbody>${records.map(r => `<tr><td>${escape(r.meta.id)}<br>${escape(r.meta.subject)}</td><td>${escape(r.meta.video_title)}</td><td>${escape(r.meta.status === 'in_progress' ? '진행 중 복구본 / 비정상 종료 가능' : r.meta.remote_saved ? '연구자 서버 저장 완료' : r.meta.disk_saved ? '폴더 저장 완료' : '미저장 복구본')}</td><td><button class="secondary" data-export="${escape(r.meta.id)}">JSON 다운로드</button> <button data-retry="${escape(r.meta.id)}">${receiver.mode==='remote'?'서버에 재전송':'폴더에 저장'}</button></td></tr>`).join('')}</tbody></table></div>` : '<h2>아직 측정 기록이 없습니다.</h2><p>첫 실험을 진행하면 이곳에 표시됩니다.</p>';
    } catch(e) { document.querySelector('#records').textContent = `기록을 읽지 못했습니다: ${e.message}`; }
  }
}

function stopSensor() { if(sensor) sensor.stop(); sensor = null; }
async function connectSensor() {
  if(!consent)throw new Error('먼저 연구 참여에 동의해 주세요.');
  stopSensor(); sensorCount = 0; liveLux = null;
  if (!isSecureContext) throw new Error('HTTPS 또는 localhost 주소로 열어 주세요.');
  if (!('AmbientLightSensor' in window)) throw new Error('이 브라우저는 ALS 접근을 제공하지 않습니다. 이 사이트는 가짜 Lux 값으로 대체하지 않습니다.');
  const instance = new AmbientLightSensor({frequency:100}); sensor = instance;
  return new Promise((resolve,reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('8초 동안 센서 값을 받지 못했습니다. 기기 센서와 브라우저 권한을 확인해 주세요.')),8000);
    function fail(error) {
      clearTimeout(timeout);
      if (!settled) {settled=true; instance.stop(); if(sensor===instance) sensor=null; reject(error);}
      else if (busy && !ending) finish('sensor_error',error.message);
      else { notice(`센서 오류: ${error.message}`); stopSensor(); }
    }
    instance.addEventListener('reading', () => {
      const receipt = now(), timestamp = instance.timestamp, lux = instance.illuminance;
      if (!Number.isFinite(timestamp) || !Number.isFinite(lux)) return;
      liveLux = lux; sensorCount++;
      if (run && !ending && timestamp >= run.meta.capture_start_ms) run.samples.push([timestamp,receipt,lux]);
      if (!settled) {clearTimeout(timeout);settled=true;resolve();}
    });
    instance.addEventListener('error', e => fail(e.error || new Error('센서 오류')));
    try {instance.start();} catch(e) {fail(e);}
  });
}
async function checkSensor() {
  notice('센서에서 첫 측정값을 기다리는 중입니다…');
  try {
    await connectSensor();
    if(route !== 'diagnostic') {stopSensor();return;}
    notice('센서 값이 수신되었습니다.');
    const update = () => {
      document.querySelector('#lux').textContent = `${liveLux ?? '—'} lux`;
      document.querySelector('#sensor-status').textContent = `수신 이벤트 ${sensorCount}개 · 연결됨 (100Hz 요청은 보장값이 아닙니다)`;
    }; update(); diagnosticTimer = setInterval(update,250);
  } catch(e) {notice(e.message);}
}
async function chooseFolder() {
  if (!window.showDirectoryPicker) throw new Error('폴더 자동 저장을 지원하는 데스크톱 Chrome 또는 Edge를 사용해 주세요.');
  const selected = await window.showDirectoryPicker({mode:'readwrite',id:'als-records'});
  folder = selected; badge();
  try {await setSetting('folder',folder);} catch {notice('폴더는 이번 접속 동안 사용됩니다. 브라우저에 폴더 설정을 보관하지 못했습니다.');}
}
async function requireFolder() {
  if (!folder) { await chooseFolder(); return; }
  if (await folder.queryPermission({mode:'readwrite'}) !== 'granted' && await folder.requestPermission({mode:'readwrite'}) !== 'granted') throw new Error('선택한 폴더에 저장할 권한이 필요합니다.');
}
async function prepareAsset(v) {
  if (!prepared.has(v.id)) prepared.set(v.id,(async () => {
    const response = await fetch(new URL(`./videos/${v.file}`,import.meta.url));
    if(!response.ok) throw new Error(`영상 파일을 읽을 수 없습니다 (${response.status}).`);
      const raw = await response.blob(); const bytes = new Uint8Array(await raw.arrayBuffer());
      validateMp4Header(bytes);
      const hash = await crypto.subtle.digest('SHA-256',bytes);
      const blob = raw.slice(0,raw.size,'video/mp4');
      return {url:URL.createObjectURL(blob),hash:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join(''),bytes:blob.size};
  })().catch(e => {prepared.delete(v.id);throw e;}));
  return prepared.get(v.id);
}
async function readyVideo(asset) {
    video.pause();
  await new Promise((resolve,reject) => {
    const clean = () => {clearTimeout(timeout);video.removeEventListener('loadeddata',loaded);video.removeEventListener('error',failed);};
      const loaded = () => {clean();resolve();}; const failed = () => {const message=mediaErrorMessage(video.error);clean();reject(new Error(message));};
    const timeout = setTimeout(() => {clean();reject(new Error('영상 준비 시간이 초과되었습니다.'));},15000);
      video.addEventListener('loadeddata',loaded); video.addEventListener('error',failed);video.src=asset.url;video.load();
  });
}
function queueUpload() {
  if(!run||!remoteRun||ending||uploadInFlight)return;
  const current=run, connection=remoteRun;
  uploadInFlight=true;
  uploadQueue=connection.flush(current).then(()=>{uploadError='';}).catch(e=>{uploadError=e.message;}).finally(()=>{uploadInFlight=false;});
}
function checkpoint() {
  if (!run) return;
  const snapshot = structuredClone(run);
  checkpointQueue = checkpointQueue.then(() => saveRun(snapshot)).catch(e => {lastCheckpointError = e.message;});
}
async function start(v) {
  if(!consent){await navigate('consent');return;}
  if (busy) return; busy=true; ending=false;lastCheckpointError='';
  document.querySelectorAll('button').forEach(b => b.disabled=true);
  const subject = sessionStorage.getItem('als-subject') || '', notes = sessionStorage.getItem('als-notes') || ''; 
  sessionStorage.setItem('als-subject',subject);
  try {
    // Permission prompts precede timing and keep user activation for folder permission.
    if(receiver.mode==='local')await requireFolder();
    if (!video.requestVideoFrameCallback) throw new Error('영상 프레임 시간 기록을 지원하는 최신 브라우저가 필요합니다.');
    notice('영상과 센서를 준비하고 있습니다…');
    const asset = await prepareAsset(v); await readyVideo(asset); await connectSensor();
    // Fail before starting if the recovery store cannot accept a write.
    await setSetting('last-preflight',Date.now());
    try {wakeLock = await navigator.wakeLock?.request('screen');} catch {}
    countdown.innerHTML='<small>준비 중</small>';stage.hidden=false;countdown.hidden=false;document.body.classList.add('running');
    const started = now();target=started+5000;
    run = {meta:{schema_version:1,id:`EXP_${new Date().toISOString().replace(/[-:.]/g,'')}_${crypto.randomUUID().slice(0,8)}`,started_utc:new Date().toISOString(),subject,notes,video_id:v.id,video_title:v.title,video_file:v.file,video_sha256:asset.hash,video_bytes:asset.bytes,video_duration_s:video.duration,requested_sensor_hz:100,time_origin_epoch_ms:performance.timeOrigin,capture_start_ms:started,target_play_ms:target,status:'in_progress',disk_saved:false,user_agent:navigator.userAgent,screen:{width:screen.width,height:screen.height,device_pixel_ratio:devicePixelRatio,viewport_width:innerWidth,viewport_height:innerHeight},timing_note:'Browser sensor and frame timestamps share the page time origin. Display timestamps are estimates, not optical emission. Sensor response delay is not calibrated. No synthetic or resampled Lux readings.'},samples:[],frames:[],events:[['CAPTURE_START',started,0]]};
    run.meta.consent=structuredClone(consent);run.meta.storage_mode=receiver.mode;
    if(receiver.mode==='remote'){
      // Establish the receiver before entering the timed capture interval.
      run.meta.capture_start_ms=Number.MAX_VALUE;
      remoteRun=new RemoteRun();await remoteRun.begin(run.meta);
      run.meta.capture_start_ms=now();target=run.meta.capture_start_ms+5000;run.meta.target_play_ms=target;
      run.events=[['CAPTURE_START',run.meta.capture_start_ms,0]];
    }
    uploadError='';uploadQueue=Promise.resolve();
    checkpoint();checkpointTimer=setInterval(()=>{checkpoint();queueUpload();},2000);notice('');
    const tick = () => {
      if(!run || ending)return;
      const remaining = target-now();
      if(remaining<=0) {play();return;}
      countdown.innerHTML=`<small>영상 시작까지</small>${Math.ceil(remaining/1000)}<small>센서 기록 중</small>`;
      timer=setTimeout(tick,Math.min(50,remaining));
    }; tick();
  } catch(e) {
    busy=false;run=null;remoteRun=null; stopSensor(); if(wakeLock) {await wakeLock.release().catch(()=>{});wakeLock=null;}
    stage.hidden=true;document.body.classList.remove('running');
    notice(e.name==='AbortError' ? '폴더 선택을 취소했습니다.' : e.message);
    document.querySelectorAll('button').forEach(b => b.disabled=false);
  }
}
function frameCallback(t,m) {
  if(!run || ending) return;
  run.frames.push([t,m.mediaTime,m.presentationTime,m.expectedDisplayTime,m.presentedFrames]);
  frameHandle=video.requestVideoFrameCallback(frameCallback);
}
async function play() {
  countdown.hidden=true;event('PLAY_CALL_BEFORE');
  frameHandle=video.requestVideoFrameCallback(frameCallback);
  lastProgress=now();lastPosition=video.currentTime;
  watchdogTimer=setInterval(()=>{
    if(!run || ending)return;
    if(video.currentTime>lastPosition){lastPosition=video.currentTime;lastProgress=now();}
    if(now()-lastProgress>10000) finish('video_stalled','10초 동안 영상 재생 위치가 진행되지 않았습니다.');
  },1000);
  try { await video.play(); event('PLAY_PROMISE_RESOLVED'); }
  catch(e) {finish('play_error',`재생을 시작할 수 없습니다: ${e.message}`);}
}
async function finish(reason,detail='') {
  if(!run || ending)return;
  const end=now();ending=true;
  clearTimeout(timer);clearInterval(checkpointTimer);clearInterval(watchdogTimer);
  if(frameHandle!=null) video.cancelVideoFrameCallback(frameHandle);
  run.events.push([`CAPTURE_END_${reason}`,end,video.currentTime]);
  stopSensor();video.pause();
  run.samples=run.samples.filter(s=>s[0]<end);
  run.meta.capture_end_ms=end;run.meta.stop_reason=reason;run.meta.detail=detail;
  run.meta.status=reason==='video_ended' ? 'completed' : 'interrupted';
  stage.hidden=true;document.body.classList.remove('running');
  if(wakeLock){await wakeLock.release().catch(()=>{});wakeLock=null;}
  main.innerHTML=header('측정 결과를 저장하고 있습니다.','파일 저장이 끝날 때까지 잠시 기다려 주세요.');
  await Promise.all([checkpointQueue,uploadQueue]);
  const result=run;run=null;result.meta.last_upload_error=uploadError||null;
  let recoverySaved=false, path='', failure='';
  try {await saveRun(result);recoverySaved=true;} catch(e){failure=`브라우저 복구본 저장 실패: ${e.message}`;}
  if(receiver.mode==='remote'){
    try {const response=await remoteRun.finish(result);result.meta.remote_saved=true;result.meta.remote_id=response.id;path=receiver.label;}
    catch(e){failure+=` 연구자 서버 저장 실패: ${e.message}`;}
    remoteRun=null;
    try{await saveRun(result);recoverySaved=true;}catch(e){failure+=` 복구본 갱신 실패: ${e.message}`;}
  }else{
    try {path=await writeRun(folder,result);result.meta.disk_saved=true;result.meta.saved_folder=folder.name;}
    catch(e){failure += ` 폴더 저장 실패: ${e.message}`;}
  }
  if(result.meta.disk_saved) {try {await saveRun(result);recoverySaved=true;}catch(e){failure+=` 복구 목록 갱신 실패: ${e.message}`;}}
  lastResult=result;unsecuredResult=!result.meta.disk_saved&&!result.meta.remote_saved&&!recoverySaved;busy=false;ending=false;route='result';
  const stats=summarize(result.samples);
  main.innerHTML=header(result.meta.remote_saved?'시청이 끝났습니다.':result.meta.disk_saved?'측정 결과가 저장되었습니다.':'결과 저장을 확인해 주세요.',reason==='video_ended'?'영상 재생과 센서 기록이 종료되었습니다.':`측정이 중단되었습니다: ${escape(reason)} ${escape(detail)}`)+`<div class="panel"><div class="eyebrow">${result.meta.disk_saved||result.meta.remote_saved?'SAVED':'RECOVERY REQUIRED'}</div><h2>${escape(result.meta.id)}</h2><p>${result.meta.remote_saved?`연구 데이터가 ${escape(receiver.label)}에 저장되었습니다.`:result.meta.disk_saved?`선택한 폴더의 <strong>${escape(path)}</strong> 안에 결과 파일 4개가 저장되었습니다.`:`${recoverySaved?'브라우저 복구본은 보관되었습니다.':'현재 화면에 원본을 보관하고 있습니다. 먼저 JSON을 다운로드하세요.'}`}</p><p>Lux ${stats.count.toLocaleString()}개 · 영상 프레임 로그 ${result.frames.length.toLocaleString()}개 · 수신 이벤트 평균 ${stats.observed_event_rate_hz?.toFixed(2) ?? '계산 불가'} Hz</p>${stats.count===0?'<p class="error">센서 샘플이 없습니다. 유효한 측정으로 사용할 수 없습니다.</p>':''}${result.frames.length===0?'<p class="error">영상 프레임 로그가 없습니다. 영상과의 시간 대응을 확인할 수 없습니다.</p>':''}<p class="error">${escape(failure)}</p><p class="subtle">${escape(lastCheckpointError ? `측정 중 복구본 저장 오류: ${lastCheckpointError}` : '')}</p><div class="row"><button data-action="retry-result">${receiver.mode==='remote'?'연구자 서버에 다시 전송':'저장 폴더 선택 후 다시 저장'}</button><button class="secondary" data-action="download-result">원본 JSON 다운로드</button></div></div><div class="row"><button data-action="select" ${!result.meta.disk_saved&&!result.meta.remote_saved&&!recoverySaved?'disabled':''}>다음 측정 진행하기 →</button><button class="secondary" data-action="home" ${!result.meta.disk_saved&&!result.meta.remote_saved&&!recoverySaved?'disabled':''}>처음 화면으로</button></div>`;
}
function download(run) {
  const payload={...run,meta:{...run.meta,export_note:'Contains raw arrays. CSV can be regenerated using core.js filesFor().'}};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`${run.meta.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function retry(result) {
  if(receiver.mode==='remote'){
    if(!consent)throw new Error('재전송하려면 연구 참여 안내에 다시 동의해 주세요.');
    const connection=new RemoteRun();const copy=structuredClone(result);
    copy.meta.id=`EXP_${crypto.randomUUID().replaceAll('-','')}`;copy.meta.consent=structuredClone(consent);copy.meta.recovered_from=result.meta.id;
    await connection.begin(copy.meta);await connection.finish(copy);
    result.meta.remote_saved=true;unsecuredResult=false;await saveRun(result);notice('연구자 서버에 복구본을 저장했습니다.');return;
  }
  await requireFolder();const path=await writeRun(folder,result);
  result.meta.disk_saved=true;result.meta.saved_folder=folder.name;
  unsecuredResult=false;
  try{await saveRun(result);}catch(e){notice(`폴더 저장 완료: ${path}. 목록 갱신 실패: ${e.message}`);return;}
  notice(`저장 완료: ${path}`);
  if(route==='storage') await navigate('storage');
  else { document.querySelectorAll('button').forEach(b=>b.disabled=false);notice(`저장 완료: ${path}`); }
}
main.addEventListener('click',async e => {
  const button=e.target.closest('button');if(!button || busy)return;
  try {
    if(button.dataset.video) {await start(VIDEOS.find(v=>v.id===button.dataset.video));return;}
    if(button.dataset.export || button.dataset.retry) {
      button.disabled=true;const id=button.dataset.export || button.dataset.retry;
      const result=(await listRuns()).find(r=>r.meta.id===id);if(!result)throw new Error('기록을 찾을 수 없습니다.');
      if(button.dataset.export)download(result);else await retry(result);
    } else {
      const action=button.dataset.action;
      if(action==='consent-accept')await acceptConsent();
      else if(action==='consent-decline'){consent=null;stopSensor();badge();await navigate('declined');}
      else if(action==='withdraw')await withdrawConsent();
      else if(action==='consent-info')await navigate('consent');
      else if(['home','select','storage','diagnostic','consent'].includes(action))await navigate(action);
      else if(action==='check') {button.disabled=true;await checkSensor();}
      else if(action==='folder') {await chooseFolder();await navigate(route);}
      else if(action==='download-result') {download(lastResult);unsecuredResult=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
      else if(action==='retry-result') {button.disabled=true;if(receiver.mode==='local')await chooseFolder();await retry(lastResult);}
    }
  } catch(e){notice(e.name==='AbortError'?'폴더 선택을 취소했습니다.':e.message);}
  finally {button.disabled=false;}
});
main.addEventListener('input',e=>{if(e.target.id==='subject')sessionStorage.setItem('als-subject',e.target.value.slice(0,200));if(e.target.id==='notes')sessionStorage.setItem('als-notes',e.target.value.slice(0,2000));});
document.querySelector('#stop-study').addEventListener('click',()=>finish('manual_stop'));
document.querySelector('#brand').addEventListener('click',e=>{e.preventDefault();navigate('home');});
video.addEventListener('ended',()=>finish('video_ended'));
video.addEventListener('error',()=>{if(run)finish('video_error',mediaErrorMessage(video.error));});
for(const name of ['playing','waiting','stalled','seeking','seeked','ratechange'])video.addEventListener(name,()=>{event(name.toUpperCase());if(run && !ending && (name==='seeking'||(name==='ratechange'&&video.playbackRate!==1)))finish('playback_modified');});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&run)finish('manual_stop');});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&run)finish('page_hidden','측정 중 탭이 숨겨졌습니다.');});
window.addEventListener('resize',()=>{if(run)finish('viewport_changed','영상 표시 크기가 변경되었습니다.');});
window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>{if(run)checkpoint();});
try {folder=await getSetting('folder') || null;} catch(e){notice(`브라우저 저장소를 열지 못했습니다: ${e.message}`);}
try{receiver=await receiverConfig();}catch(e){receiverError=e.message;}
badge();await navigate('consent');
