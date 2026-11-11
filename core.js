export function csv(columns, rows) {
  const quote = value => { const s = value == null ? '' : String(value); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  return '\uFEFF' + [columns, ...rows].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}
export function validateMp4Header(bytes) {
  const text = new TextDecoder().decode(bytes.slice(0,160));
  if (text.startsWith('version https://git-lfs.github.com/spec/')) throw new Error('영상 대신 Git LFS 포인터 파일이 내려왔습니다. 실제 MP4 파일을 배포해 주세요.');
  if (bytes.length < 12 || new TextDecoder().decode(bytes.slice(4,8)) !== 'ftyp') throw new Error('내려받은 파일이 MP4 영상이 아닙니다. 영상 경로와 배포 파일을 확인해 주세요.');
}
export function mediaErrorMessage(error) {
  const hints = {1:'영상 불러오기가 취소되었습니다.',2:'영상 데이터를 불러오는 중 연결 오류가 발생했습니다.',3:'영상 디코딩에 실패했습니다. 브라우저 호환 코덱과 파일 손상을 확인해 주세요.',4:'영상 형식을 지원하지 않습니다. H.264 MP4 웹용 파일이 배포됐는지 확인해 주세요.'};
  return `${hints[error?.code] || '영상 준비 중 오류가 발생했습니다.'} [코드 ${error?.code ?? '없음'}]${error?.message ? ` ${error.message}` : ''}`;
}
export function summarize(samples) {
  const times = samples.map(s => s[0]).sort((a,b) => a-b);
  const gaps = times.slice(1).map((t,i) => t-times[i]).sort((a,b) => a-b);
  return {count: times.length, observed_event_rate_hz: times.length > 1 && times.at(-1) > times[0] ? (times.length-1)*1000/(times.at(-1)-times[0]) : null, median_interval_ms: gaps.length ? (gaps[Math.floor((gaps.length-1)/2)]+gaps[Math.floor(gaps.length/2)])/2 : null, max_interval_ms: gaps.at(-1) ?? null};
}
export function filesFor(run) {
  const anchor = run.frames[0]?.[3] ?? null;
  return {
    'als_raw.csv': csv(['sensor_timestamp_ms','callback_timestamp_ms','delivery_delay_ms','relative_to_first_frame_ms','lux'],run.samples.map(([t,c,l]) => [t,c,c-t,anchor === null ? null : t-anchor,l])),
    'video_frames.csv': csv(['callback_timestamp_ms','media_time_s','presentation_time_ms','expected_display_time_ms','presented_frames'],run.frames),
    'events.csv': csv(['event','timestamp_ms','video_time_s'],run.events),
    'session.json': JSON.stringify({...run.meta, first_frame_expected_display_ms:anchor, first_frame_media_time_s:run.frames[0]?.[1] ?? null, summary:summarize(run.samples)},null,2)
  };
}
export async function writeRun(root, run) {
  const dir = await root.getDirectoryHandle(run.meta.id,{create:true});
  for (const [name,contents] of Object.entries(filesFor(run))) {
    const file = await dir.getFileHandle(name,{create:true});
    const writer = await file.createWritable();
    const exported = name === 'session.json' ? JSON.stringify({...JSON.parse(contents),disk_saved:true,saved_folder:root.name},null,2) : contents;
    try { await writer.write(exported); await writer.close(); }
    catch(error) { try { await writer.abort(); } catch {} throw error; }
  }
  return `${root.name}/${run.meta.id}`;
}
