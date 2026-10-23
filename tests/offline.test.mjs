import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
function worker() {
  const stores=new Map(), listeners={}, timers=new Map(); let next=0, mode='ok';
  const response=body=>({ok:true,status:200,type:'basic',body,clone(){return this},async arrayBuffer(){return new TextEncoder().encode(body).buffer}});
  const cache=name=>{
    if(!stores.has(name))stores.set(name,new Map()); const m=stores.get(name);
    const key=k=>typeof k==='string'?k:k.url;
    return {keys:async()=>[...m.keys()].map(url=>({url})),match:async k=>m.get(key(k)),put:async(k,v)=>m.set(key(k),v),delete:async k=>m.delete(key(k)),
      addAll:async urls=>{for(const u of urls)m.set(u,response(u))}};
  };
  const caches={open:async name=>cache(name),keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name),
    match:async k=>{for(const name of stores.keys()){const hit=await cache(name).match(k);if(hit)return hit}}};
  const self={location:{origin:'https://x.test',href:'https://x.test/SpellCoco/sw.js'},addEventListener:(k,f)=>listeners[k]=f,
    skipWaiting:async()=>{},clients:{claim:async()=>{}}};
  vm.runInNewContext(source,{self,caches,URL,Response:{error:()=>({error:true})},setTimeout:(f,ms)=>{const id=++next;timers.set(id,{f,ms});return id},clearTimeout:id=>timers.delete(id),
    fetch:async req=>{if(mode==='offline')throw Error('offline');if(mode==='hang')return new Promise(()=>{});return mode==='5xx'?{...response('SERVICE UNAVAILABLE'),status:503,ok:false}:response(req.url)}});
  async function event(name){const waits=[];listeners[name]({waitUntil:p=>waits.push(p)});await Promise.all(waits)}
  function get(path,nav=false){let reply;const waits=[];listeners.fetch({request:{url:'https://x.test/SpellCoco/'+path,method:'GET',mode:nav?'navigate':'cors',headers:{has:()=>false}},respondWith:p=>reply=p,waitUntil:p=>waits.push(p)});return reply}
  return {cache,stores,event,get,timers,setMode:m=>mode=m};
}
test('install alone precaches every local dependency and dictionary for first offline launch',async()=>{
  const w=worker();await w.event('install');w.setMode('offline');
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const engine=html.match(/src="(engine.js\?v=[^"]+)"/)[1];
  for(const path of ['', 'index.html',engine,'dictionary.txt','custom_words.txt','manifest.json','icon-192.png','icon-512.png','icon-512-maskable.png','apple-touch-icon-180.png','coco-mark.svg'])
    assert.ok((await w.get(path,path==='')).ok,path);
});
test('activation preserves older engine URLs before deleting old caches',async()=>{
  const w=worker();await w.cache('spellcoco-rt-1').put('https://x.test/SpellCoco/engine.js?v=v78',{ok:true,body:'old engine'});
  await w.event('install');await w.event('activate');w.setMode('offline');
  assert.equal(w.stores.has('spellcoco-rt-1'),false);
  assert.equal((await w.get('engine.js?v=v78')).body,'old engine');
});
test('shell falls back on HTTP 5xx and a bounded network timeout',async()=>{
  const w=worker();await w.event('install');w.setMode('5xx');
  const fallback=await w.get('index.html',true);assert.equal(fallback.ok,true);assert.match(fallback.body,/index\.html$/);
  w.setMode('hang'); const reply=w.get('index.html',true);
  const timeout=[...w.timers.values()].find(t=>t.ms===3000);assert.ok(timeout);timeout.f();
  assert.equal((await reply).ok,true);
});
