const database = new Promise((resolve,reject) => {
  const req = indexedDB.open('als-lab-v1',1);
  req.onupgradeneeded = () => { req.result.createObjectStore('runs',{keyPath:'meta.id'}); req.result.createObjectStore('settings'); };
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
async function transaction(store,mode,action) {
  const db = await database;
  return new Promise((resolve,reject) => {
    const tx = db.transaction(store,mode); const req = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('저장이 취소되었습니다.'));
  });
}
export const saveRun = run => transaction('runs','readwrite',s => s.put(run));
export const listRuns = () => transaction('runs','readonly',s => s.getAll());
export const getSetting = key => transaction('settings','readonly',s => s.get(key));
export const setSetting = (key,value) => transaction('settings','readwrite',s => s.put(value,key));
