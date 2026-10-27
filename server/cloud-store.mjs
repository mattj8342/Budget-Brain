import { UndoStore } from '@maro-org/ynab-mcp/build/undo/store.js';
export function createCloudStore(bucket,fetchImpl=fetch) {
  if(!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket ?? '')) throw new Error('WRITE_STATE_BUCKET is required for full writes');
  let cached;
  async function headers(){
    if(!cached || cached.until<Date.now()) {
      const r=await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000),redirect:'error'});
      if(!r.ok) throw new Error('Runtime credentials unavailable');
      const d=await r.json();cached={token:d.access_token,until:Date.now()+Math.max(0,d.expires_in-60)*1000};
    }
    return {Authorization:`Bearer ${cached.token}`};
  }
  return {
    async list(prefix){
      const names=[];let page;const seen=new Set();
      do {
        const url=new URL('https://storage.googleapis.com/storage/v1/b/'+bucket+'/o');
        url.searchParams.set('prefix',prefix);url.searchParams.set('maxResults','1000');url.searchParams.set('fields','items(name),nextPageToken');
        if(page)url.searchParams.set('pageToken',page);
        const r=await fetchImpl(url,{headers:await headers(),signal:AbortSignal.timeout(10000),redirect:'error'});
        if(!r.ok)throw new Error('Durable history listing failed');
        const d=await r.json();
        for(const item of d.items??[]){if(typeof item.name!=='string'||!item.name.startsWith(prefix))throw new Error('Invalid history object scope');names.push(item.name);}
        if(names.length>1000)throw new Error('History exceeds scan limit; no latest report inferred');
        page=d.nextPageToken;
        if(page&&seen.has(page))throw new Error('Repeated history page token');if(page)seen.add(page);
      }while(page);
      return names;
    },
    async get(name){const r=await fetchImpl(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`,{headers:await headers(),signal:AbortSignal.timeout(10000),redirect:'error'});if(r.status===404)return null;if(!r.ok)throw new Error('Durable state read failed');return r.json();},
    async put(name,data,createOnly=false){const r=await fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}${createOnly?'&ifGenerationMatch=0':''}`,{method:'POST',headers:{...await headers(),'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000),redirect:'error'});if(r.status===412)return false;if(!r.ok)throw new Error('Durable state write failed');return true;},
    async delete(name){const r=await fetchImpl(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`,{method:'DELETE',headers:await headers(),signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok && r.status!==404)throw new Error('Durable state unlock failed');}
  };
}
// Every mutating upstream tool is protected by one durable per-budget lock.
// Reads can run concurrently. Object writes are atomic; no local undo files are used.
export class CloudUndoStore extends UndoStore {
  constructor(store){super('/tmp/unused');this.cloud=store;}
  async readBudgetHistoryUnsafe(budgetId){return (await this.cloud.get(`budgets/${budgetId}/undo.json`)) ?? {entries:[],id_mappings:{},pending_operations:[]};}
  async writeBudgetHistoryUnsafe(budgetId,history){await this.cloud.put(`budgets/${budgetId}/undo.json`,history);}
}
