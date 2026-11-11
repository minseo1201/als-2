export async function receiverConfig() {
  const response=await fetch(new URL('./api/config',import.meta.url),{cache:'no-store'});
  if(response.status===404)return {mode:'local',label:'이 컴퓨터의 지정 폴더'};
  if(!response.ok)throw new Error('연구자 수신 서버 설정을 확인할 수 없습니다.');
  const config=await response.json();
  if(config.mode!=='remote'||typeof config.label!=='string')throw new Error('수신 서버 설정이 올바르지 않습니다.');
  return config;
}
export class RemoteRun {
  constructor(){this.id=null;this.token=null;this.offsets={samples:0,frames:0,events:0};this.seq=0;this.pending=null;}
  async request(path,data){
    const response=await fetch(new URL(`./api/runs${path}`,import.meta.url),{method:'POST',headers:{'Content-Type':'application/json',...(this.token?{Authorization:`Bearer ${this.token}`}:{})},body:JSON.stringify(data),signal:AbortSignal.timeout(12000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||`수신 서버 오류 ${response.status}`);return result;
  }
  async begin(meta){const result=await this.request('',{meta});this.id=result.id;this.token=result.token;}
  async flush(run){
    const desired=Object.fromEntries(['samples','frames','events'].map(key=>[key,run[key].length]));
    const send=async()=>{await this.request(`/${this.id}/batch`,this.pending.batch);this.offsets=this.pending.lengths;this.seq++;this.pending=null;};
    if(this.pending)await send();
    const batch={seq:this.seq};
    for(const key of ['samples','frames','events'])batch[key]=run[key].slice(this.offsets[key],desired[key]);
    if(!batch.samples.length&&!batch.frames.length&&!batch.events.length)return;
    this.pending={batch,lengths:desired};await send();
  }
  async finish(run){await this.flush(run);return this.request(`/${this.id}/finish`,{meta:run.meta,batches:this.seq});}
}
