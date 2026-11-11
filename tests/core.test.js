import test from 'node:test';
import assert from 'node:assert/strict';
import {csv,filesFor,summarize,writeRun,validateMp4Header,mediaErrorMessage} from '../core.js';

const fixture = () => ({meta:{id:'EXP_test',status:'completed'},samples:[[1000,1007,12],[1010,1040,13],[1040,1042,14]],frames:[[1001,0.083,998,1005,1]],events:[['CAPTURE_START',900,0]]});
test('HTML and Git LFS responses are rejected before the decoder',()=>{
  const encode=s=>new TextEncoder().encode(s);
  assert.throws(()=>validateMp4Header(encode('<!doctype html><html>fallback</html>')),/MP4 영상이 아닙니다/);
  assert.throws(()=>validateMp4Header(encode('version https://git-lfs.github.com/spec/v1\noid sha256:abc')),/LFS/);
  assert.doesNotThrow(()=>validateMp4Header(new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109])));
});
test('unsupported format and decode failures retain distinct browser error details',()=>{
  assert.match(mediaErrorMessage({code:4,message:'DEMUXER_ERROR'}),/H.264.*코드 4.*DEMUXER_ERROR/);
  assert.match(mediaErrorMessage({code:3,message:'DECODE_ERROR'}),/디코딩.*코드 3.*DECODE_ERROR/);
});
test('sensor timestamp, not callback timestamp, anchors relative time; countdown remains negative',()=>{
  const files=filesFor(fixture());
  assert.match(files['als_raw.csv'],/1000,1007,7,-5,12/);
  assert.match(files['als_raw.csv'],/1010,1040,30,5,13/);
  assert.equal(JSON.parse(files['session.json']).first_frame_media_time_s,0.083);
});
test('missing video frames do not invent a timing origin',()=>{
  const r=fixture();r.frames=[];
  assert.match(filesFor(r)['als_raw.csv'],/1000,1007,7,,12/);
  assert.equal(JSON.parse(filesFor(r)['session.json']).first_frame_expected_display_ms,null);
});
test('actual event rate uses sensor time span and handles sparse measurements',()=>{
  assert.deepEqual(summarize(fixture().samples),{count:3,observed_event_rate_hz:50,median_interval_ms:20,max_interval_ms:30});
  assert.equal(summarize([]).observed_event_rate_hz,null);
  assert.equal(summarize([[5,6,2]]).median_interval_ms,null);
});
test('CSV quotes commas, newlines, quotes and preserves zero',()=>{
  assert.equal(csv(['a','b'],[['x,"y"','line\n2'],[0,null]]),'\uFEFFa,b\r\n"x,""y""","line\n2"\r\n0,\r\n');
});
function disk(failName) {
  const written=new Map();
  return {name:'Records',written,async getDirectoryHandle(name){assert.equal(name,'EXP_test');return {async getFileHandle(file){return {async createWritable(){let content;return {async write(text){if(file===failName)throw new Error('disk full');content=text;},async close(){written.set(file,content);},async abort(){}};}};}};}};
}
test('successful folder export closes all four files',async()=>{
  const root=disk();assert.equal(await writeRun(root,fixture()),'Records/EXP_test');
  assert.deepEqual([...root.written.keys()],['als_raw.csv','video_frames.csv','events.csv','session.json']);
});
test('partial disk failure rejects; same session can be retried without a false success',async()=>{
  const r=fixture();await assert.rejects(writeRun(disk('video_frames.csv'),r),/disk full/);
  const root=disk();await writeRun(root,r);assert.equal(root.written.size,4);
});
