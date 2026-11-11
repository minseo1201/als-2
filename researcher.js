let key='';
const records=document.querySelector('#records'),status=document.querySelector('#status');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function request(path){const response=await fetch(new URL(`./api/admin/runs${path}`,import.meta.url),{headers:{Authorization:`Bearer ${key}`},cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'수신 서버 연결 실패');return result;}
document.querySelector('#login').addEventListener('submit',async e=>{
  e.preventDefault();key=document.querySelector('#key').value.trim();
  try{const runs=await request('');status.textContent=`${runs.length}개의 실험 기록 · 새 기록은 ‘기록 확인’을 다시 누르면 갱신됩니다.`;
    records.innerHTML=runs.length?`<div class="table-wrap"><table><thead><tr><th>실험</th><th>영상</th><th>상태</th><th>수신 Lux</th><th>원본</th></tr></thead><tbody>${runs.map(r=>`<tr><td>${escape(r.id)}</td><td>${escape(r.video_title)}</td><td>${escape(r.remote_saved?'저장 완료':'수신 중 / 중단 가능')}</td><td>${r.received_samples}</td><td><button data-id="${escape(r.id)}">다운로드</button></td></tr>`).join('')}</tbody></table></div>`:'아직 수신한 기록이 없습니다.';
  }catch(e){records.textContent='';status.textContent=e.message;}
});
records.addEventListener('click',async e=>{const id=e.target.closest('button')?.dataset.id;if(!id)return;try{const data=await request(`/${id}`);const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(e){status.textContent=e.message;}});
document.querySelector('#logout').addEventListener('click',()=>{key='';document.querySelector('#key').value='';records.textContent='';status.textContent='접근 키를 지웠습니다.';});
