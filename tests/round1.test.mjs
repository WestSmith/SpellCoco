import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { client, state, plain, room, socket } from './helpers.mjs';

const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Keith";NET.seat=0;NET.myIndex=0;NET.rev=0;';
const initial=()=>({...state(),id:'match00002'});
const push=(r,ws,m)=>r.onMessage(ws,JSON.stringify(m));
const moves=c=>c.sent.filter(m=>m.op==='move');
function swap(c,ch){c.run(`game.swapTargetId=0;game.performSwap("${ch}")`)}
function bubble(){const c=client();c.load();c.run('FX.overlayUntil=0;FX.loungeUntil=0');return c}

test('replaying the first of two durable Swaps cannot refund treats or roll back the tile',async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');swap(c,'B');
  const [first,second]=moves(c),{r,db,sockets:[a]}=room(initial());
  for(const m of [first,second,first])await push(r,a,m);
  assert.equal(a.messages.at(-1).op,'reject');assert.equal(a.messages.at(-1).reason,'stale');
  assert.equal(await r.rev(),2);assert.equal(db.get('game').tiles[0].char,'B');assert.equal(db.get('game').players[0].gems,2);
});

for(const failure of ['write','remove'])test(`obsolete durable record after failed storage ${failure} refreshes to the room's latest board`,async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');
  const first=moves(c).at(-1),{r,db,sockets:[a]}=room(initial());await push(r,a,first);
  if(failure==='write'){
    c.run('localStorage.setItem=()=>{throw Error("quota")};console={...console,warn:()=>{}}');swap(c,'B');
    await push(r,a,moves(c).at(-1));
  }else{
    c.run('console={...console,warn:()=>{}};localStorage.removeItem=()=>{throw Error("denied")}');
    c.ctx.ack=a.messages.at(-1);c.run('asyncOnMessage(ack)');
    const other=client();other.load(db.get('game'),online+'NET.rev=1;');swap(other,'B');
    await push(r,a,moves(other).at(-1));
  }
  const fresh=client();for(const [k,v]of c.saved)fresh.saved.set(k,v);
  fresh.ctx.welcome={seat:0,names:['Keith','Shawn'],state:db.get('game'),rev:2};
  fresh.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))};asyncWelcome(welcome)');
  await push(r,a,moves(fresh).at(-1));fresh.ctx.reply=a.messages.at(-1);fresh.run('asyncOnMessage(reply)');
  assert.equal(db.get('game').tiles[0].char,'B');assert.equal(db.get('game').players[0].gems,2);
  assert.equal(fresh.run('game.tiles[0].char'),'B');assert.equal(fresh.run('game.players[0].gems'),2);
  assert.equal(fresh.run('NET.pendingMove'),null);
});

test('an older same-seat tab cannot overwrite a newer accepted snapshot even with a larger q',async()=>{
  const {r,db,sockets:[a]}=room(initial()),other=socket(0,'Keith');
  const c=client(),d=client();c.load(initial(),online);d.load(initial(),online+'NET.moveSeq=40;');
  swap(c,'A');await push(r,a,moves(c).at(-1));swap(d,'B');await push(r,other,moves(d).at(-1));
  assert.equal(other.messages.at(-1).reason,'stale');assert.equal(db.get('game').tiles[0].char,'A');
});

test('legacy q replay and stale refreshed snapshots are refused while rapid legacy pushes still work',async()=>{
  const {r,db,sockets:[a]}=room(initial());
  const first={type:'__a',op:'move',state:initial(),q:1,base:0};first.state.tiles[0].char='A';
  const second=structuredClone(first);second.q=2;second.state.tiles[0].char='B';
  await push(r,a,first);await push(r,a,second);assert.equal(a.messages.at(-1).op,'moveok');
  await push(r,a,first);assert.equal(a.messages.at(-1).reason,'stale');
  const fresh=socket(0,'Keith');await push(r,fresh,{...first,q:99});assert.equal(fresh.messages.at(-1).reason,'stale');
  assert.equal(db.get('game').tiles[0].char,'B');
});

test('normal async hosting uses rejection-sampled crypto with the existing fourteen-character format',()=>{
  const c=client();
  c.run('calls=0;Math.random=()=>0;crypto={getRandomValues:a=>{a[0]=calls++===0?255:(calls-2);return a}};asyncEnter=code=>{entered=code};hostGameAsync()');
  assert.equal(c.run('NET.code'),'ABCDEFGHJKMNPQ');assert.equal(c.run('entered'),c.run('NET.code'));
  assert.equal(c.doc.getElementById('room-code').innerText,c.run('NET.code'));assert.equal(c.run('calls'),15);
});

test('an id-less compatibility move retains match identity and later wrong-match checks',async()=>{
  const {r,db,sockets:[a]}=room(initial());const legacy=state();
  await push(r,a,{type:'__a',op:'move',state:legacy,q:1,base:0});
  assert.equal(db.get('game').id,'match00002');
  await push(r,a,{type:'__a',op:'move',state:{...state(),id:'match00001'},q:2,base:0});
  assert.equal(a.messages.at(-1).reason,'wrong-match');assert.equal(db.get('game').id,'match00002');
});

test('replaying a start after completion keeps the finished match and returns its authoritative state',async()=>{
  const {r,db,sockets:[a]}=room({...state(),id:'match00001',over:true});
  const start={type:'__a',op:'newgame',state:initial(),q:1,base:0};await push(r,a,start);
  await push(r,a,{type:'__a',op:'gameover',gid:'match00002',players:state().players,base:1});
  const finished=structuredClone(db.get('game'));await push(r,a,start);
  assert.deepEqual(db.get('game'),finished);assert.equal(await r.rev(),2);
  assert.equal(a.messages.at(-1).op,'moveok');assert.deepEqual(a.messages.at(-1).state,finished);
  const c=client();c.load(initial(),online);c.run('NET.sendStart()');
  c.ctx.reply=a.messages.at(-1);c.run('asyncOnMessage(reply)');
  assert.equal(c.run('game.over'),true);assert.equal(c.run('NET.pendingStart'),null);
});

test('dismissal removes event continuations queued before dismissal, including four-line overflow',()=>{
  const c=bubble();c.run('cocoSay("Score +10");_cocoPump();cocoSay("Best possible 20");cocoSay("Swap ceiling");dismissCocoBubble()');
  c.fireDelay(280);assert.equal(c.run('COCO_SAY.showing'),false);assert.equal(c.run('COCO_SAY.q.length'),0);
  c.run('cocoSayReset();for(let i=0;i<6;i++)cocoSay("Line "+i);_cocoPump();dismissCocoBubble()');
  c.fireDelay(280);assert.equal(c.run('COCO_SAY.showing'),false);assert.equal(c.run('COCO_SAY.q.length'),0);
});

test('dismissal retains a queued later event and standalone speech',()=>{
  const c=bubble();c.run('clock=10000;Date.now=()=>clock;cocoSay("Score");_cocoPump();cocoSay("Old continuation");clock+=901;cocoSay("Next event");cocoSpeak("Personality");dismissCocoBubble()');
  assert.deepEqual(plain(c.run('COCO_SAY.q.map(b=>b.lines[0])')),['Next event','Personality']);
  c.fireDelay(280);assert.match(c.doc.getElementById('coco-bubble').innerHTML,/Next event/);
});

for(const modal of ['swap','replay'])test(`Escape belongs to the active ${modal} dialog while Coco is showing`,()=>{
  const c=bubble();c.run('cocoSpeak("Hello");_cocoPump()');
  c.run('document.querySelector=selector=>selector===".modal:not(.hidden)"?{}:null'); // model a visible modal
  if(modal==='swap')c.run('game.openSwapModal(0);game._swapModalAt=0');
  else c.run('document.getElementById("modal-replay").classList.remove("hidden")');
  let stopped=false;const e={key:'Escape',preventDefault(){},stopPropagation(){stopped=true}};
  for(const f of c.events['document:keydown'])f(e);
  if(!stopped){c.ctx.e=e;c.run(modal==='swap'?'handleSwapKey(e)':'handleReplayKey(e)')}
  assert.equal(c.doc.getElementById('modal-'+modal).classList.contains('hidden'),true);
  assert.equal(c.run('COCO_SAY.showing'),true);
});

// Structural protection only: these assertions cannot measure browser layout,
// safe areas, keyboard occlusion, hit targets or screen-reader announcements.
function assertBubbleLayout(html){
  const css=html.match(/\.coco-bubble\{([^}]+)\}/)[1];
  assert.match(css,/position:absolute/);assert.match(css,/display:block/);assert.match(css,/margin:0/);
  assert.match(css,/top:calc\(100% \+ 58px\);left:8px/);assert.match(css,/z-index:3;/);
  assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/transition:none/);
  assert.doesNotMatch(css,/(?:^|;)\s*(?:min-)?height:|position:(?:relative|static)|margin-top:/);
  assert.match(html,/\.modal\{[^}]*z-index:100/);assert.match(html,/#modal-replay\{z-index:150\}/);
  assert.match(html,/\.coco-bubble.hidden\{display:none !important;pointer-events:none\}/);
  assert.match(html,/\.player-bar-stage\{position:relative\}/);
  assert.match(html,/id="player-list"[^]*?id="coco-lounge"[^>]*><\/span>\s*<button[^>]*id="coco-bubble"[^>]*><\/button>\s*<\/div>/);
  assert.match(html,/\.coco-bubble::after\{\s*content:'';position:absolute;top:-34px;width:36px;height:36px;[^}]*data:image\/svg\+xml/);
  assert.match(css,/width:fit-content;min-width:176px;max-width:min\(34ch,calc\(100% - 16px\)\)/);
  assert.match(html,/\.coco-bubble.from-right\{left:auto;right:8px\}/);
  assert.match(html,/@media\(max-width:839px\)\{\s*\.coco-bubble\{top:calc\(100% \+ 62px\)\}/);
  assert.match(html,/\.coco-bubble.from-right::after\{right:106px;transform:scaleX\(-1\)\}/);
  assert.match(html,/\.coco-bubble.from-left::after\{left:106px\}/);
  assert.match(html,/@media\(prefers-reduced-motion:reduce\)\{\s*\.coco-lounge\{transition:none\}\s*\.coco-lounge.purring svg\{animation:none !important\}/);
}
test('bubble overlays its unchanged stage below the scoreboard, with mirrored tails and reduced motion',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');assertBubbleLayout(html);
  for(const [before,after] of [
    ['position:absolute;top:calc(100% + 58px)','position:relative;top:calc(100% + 58px)'],
    ['top:calc(100% + 58px)','top:0'],['calc(100% - 16px));margin:0;','calc(100% - 16px));margin:58px 8px 0;'],
    ['z-index:3;','z-index:300;'],['display:none !important;pointer-events:none','opacity:0'],
    ['right:106px;transform:scaleX(-1)','right:106px'],
    ['id="coco-lounge" aria-hidden="true"></span>','id="coco-lounge" aria-hidden="true"></span></div>']
  ]){assert.notEqual(html.replace(before,after),html);assert.throws(()=>assertBubbleLayout(html.replace(before,after)))}
});

test('a Swap made before the start ack can follow the accepted start, without rolling back on start retry',async()=>{
  const c=client();c.load(initial(),online);c.run('NET.sendStart()');const start=c.sent.find(m=>m.op==='newgame');
  const {r,db,sockets:[a]}=room({...state(),id:'match00001',over:true});await push(r,a,start);
  swap(c,'A');const move=moves(c).at(-1);
  await push(r,a,start);c.ctx.ack=a.messages.at(-1);c.run('asyncOnMessage(ack)');
  assert.equal(c.run('game.tiles[0].char'),'A','retry ack must not erase a newer pending local action');
  await push(r,a,move);assert.equal(a.messages.at(-1).op,'moveok');
  c.ctx.ack=a.messages.at(-1);c.run('asyncOnMessage(ack)');
  assert.equal(db.get('game').tiles[0].char,'A');assert.equal(c.run('game.tiles[0].char'),'A');
});

test('stream retries survive reconnect and worker recreation, and out-of-order older operations stay rejected',async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');swap(c,'B');
  const [first,second]=moves(c),h=room(initial());
  await push(h.r,h.sockets[0],second); // latest complete snapshot arrives first
  const restarted=new h.r.constructor(h.r.state,{}),reconnected=socket(0,'Keith');
  await push(restarted,reconnected,first);assert.equal(reconnected.messages.at(-1).reason,'stale');
  await push(restarted,reconnected,second);assert.equal(reconnected.messages.at(-1).reason,'stale');
  c.run('game.applyUndoSwap()');const undo=moves(c).at(-1);
  assert.equal(undo.stream,second.stream);assert.equal(undo.state.id,second.state.id);
  await push(restarted,reconnected,undo);assert.equal(reconnected.messages.at(-1).op,'moveok');
  assert.equal(h.db.get('game').tiles[0].char,'A');assert.equal(h.db.get('game').players[0].gems,5);
});

test('a refreshed unaccepted modern operation lands once and displays its restored state',async()=>{
  const c=client();c.load(initial(),online);swap(c,'A');
  const fresh=client();for(const [k,v]of c.saved)fresh.saved.set(k,v);
  fresh.ctx.welcome={seat:0,names:['Keith','Shawn'],state:initial(),rev:0};
  fresh.run(online+'NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))};asyncWelcome(welcome)');
  const m=moves(fresh).at(-1),{r,db,sockets:[a]}=room(initial());
  assert.equal(m.stream,moves(c).at(-1).stream);
  await push(r,a,m);fresh.ctx.ack=a.messages.at(-1);fresh.run('asyncOnMessage(ack)');
  assert.equal(fresh.run('game.tiles[0].char'),'A');assert.equal(fresh.run('NET.pendingMove'),null);
  await push(r,a,m);assert.equal(await r.rev(),1);assert.equal(db.get('game').players[0].gems,5);
});

for(const ending of ['word','timeout'])test(`client-generated ${ending} final turn and distinct-id rematch survive stream validation`,async()=>{
  const st={...initial(),turnIndex:1,round:1};st.tiles[0].char='C';st.tiles[1].char='A';st.tiles[2].char='T';
  if(ending==='timeout'){st.cocoTimerActive=true;st.timeLeft=1}
  const c=client();c.load(st,online+'NET.seat=1;NET.myIndex=1;NET.myName="Shawn";CONFIG.rounds=1;buildTrie(["CAT"]);');
  const {r,db,sockets:[,b]}=room(st);
  if(ending==='word')c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
  else {c.fire(c.run('game.timerInterval'));c.fireDelay(800)}
  for(const m of c.sent.filter(m=>m.type==='__a'))await push(r,b,m);
  assert.equal(db.get('game').over,true);assert.deepEqual(db.get('game').players,plain(c.run('game.serialize().players')));
  const finished=structuredClone(db.get('game')),rev=await r.rev();
  c.ctx.welcome={seat:1,names:['Keith','Shawn'],state:finished,rev};c.run('asyncWelcome(welcome)');
  assert.equal(c.run('game.over'),true);
  c.run('game=new Game({names:["Keith","Shawn"]});NET.sendStart()');
  const start=c.sent.filter(m=>m.op==='newgame').at(-1);await push(r,b,start);
  assert.equal(b.messages.at(-1).op,'moveok');assert.notEqual(db.get('game').id,finished.id);assert.equal(db.get('game').over,false);
  await push(r,b,{type:'__a',op:'move',state:finished,q:999,base:rev});
  assert.equal(b.messages.at(-1).reason,'wrong-match');assert.equal(db.get('game').id,start.state.id);
});

test('modern stream cannot bypass a Coco Attack revision, and legacy field omissions remain supported',async()=>{
  const {r,db,sockets:[a,b]}=room(initial()),c=client();c.load(initial(),online);swap(c,'A');
  await push(r,a,moves(c).at(-1));await push(r,b,{type:'__a',op:'coco'});
  c.run('game.applyUndoSwap()');await push(r,a,moves(c).at(-1));assert.equal(a.messages.at(-1).reason,'stale');
  const attacked=db.get('game');assert.equal(attacked.cocoPendingFor,0);assert.equal(attacked.players[1].gems,4);
  // pre-v71: no base, stream, q or match id. Preserve its accepted semantics.
  const legacy=structuredClone(attacked);delete legacy.id;
  await push(r,a,{type:'__a',op:'move',state:legacy});assert.equal(a.messages.at(-1).op,'moveok');assert.equal(db.get('game').id,initial().id);
});

test('storage entirely unavailable still allows in-memory online retries and Solo Swap/undo uses no operation stream',async()=>{
  const c=client();c.load(initial(),online);
  c.run('console={...console,warn:()=>{}};localStorage.setItem=localStorage.getItem=localStorage.removeItem=()=>{throw Error("unavailable")}');
  swap(c,'A');assert.ok(c.run('NET.pendingMove'));const {r,db,sockets:[a]}=room(initial());
  await push(r,a,moves(c).at(-1));c.ctx.ack=a.messages.at(-1);c.run('asyncOnMessage(ack)');assert.equal(c.run('NET.pendingMove'),null);
  assert.equal(db.get('game').players[0].gems,5);
  const solo=client();solo.load(state(),'NET.mode="local";CONFIG.solo={active:true,mood:"sleepy"}');
  swap(solo,'A');solo.run('game.applyUndoSwap()');assert.equal(solo.run('game.players[0].gems'),8);assert.equal(solo.run('game.tiles[0].char'),'E');
  assert.equal(solo.run('NET.moveStream'),null);assert.equal(moves(solo).length,0);
});

test('queued merges retain event identity even when their original event window elapsed',()=>{
  const c=bubble();c.run('clock=10000;Date.now=()=>clock;cocoSay("Score");_cocoPump();clock+=800;cocoSay("Best");clock+=200;cocoSay("Ceiling");dismissCocoBubble();cocoSay("Late continuation")');
  assert.equal(c.run('COCO_SAY.q.length'),0);c.fireDelay(280);assert.equal(c.run('COCO_SAY.showing'),false);
});

test('v97 build label, page engine and service-worker engine agree',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
  assert.match(html,/const APP_VERSION='v97'/);assert.match(html,/<script src="engine.js\?v=v97">/);assert.match(sw,/'engine.js\?v=v97'/);
  const changelog=readFileSync(new URL('../CHANGELOG.md',import.meta.url),'utf8');
  assert.equal(changelog.match(/SPELLCOCO v\d+/)[0],'SPELLCOCO v97');
});

test('a rejected rematch adopts the winning match even when a local action is pending',()=>{
  const c=client();c.load(initial(),online);c.run('NET.sendStart()');swap(c,'A');
  c.ctx.winner={...state(),id:'winner0001'};
  c.run('asyncOnMessage({op:"reject",q:NET.pendingStart.q,reason:"match-active",state:winner,rev:5})');
  assert.equal(c.run('NET.pendingStart'),null);assert.equal(c.run('game.id'),'winner0001');
});

test('an old start cannot return after a newer distinct match also finishes',async()=>{
  const {r,db,sockets:[a]}=room({...state(),id:'match00000',over:true});
  const stream='a'.repeat(24),start={type:'__a',op:'newgame',state:{...state(),id:'match00001'},stream,q:1,base:0};
  await push(r,a,start);
  await push(r,a,{type:'__a',op:'gameover',gid:'match00001',players:state().players});
  await push(r,a,{...start,state:{...state(),id:'match00002'},q:2,base:2});
  await push(r,a,{type:'__a',op:'gameover',gid:'match00002',players:state().players});
  await push(r,a,start);
  assert.equal(a.messages.at(-1).reason,'stale');assert.equal(db.get('game').id,'match00002');assert.equal(db.get('game').over,true);assert.equal(await r.rev(),4);
});

test('a distinct rematch can follow the final move before its ack arrives',async()=>{
  const c=client();c.load(initial(),online);const {r,db,sockets:[a]}=room(initial());
  c.run('game.over=true;NET.sendMove(game.serialize());game=new Game({names:["Keith","Shawn"]});NET.sendStart()');
  const final=moves(c).find(m=>m.state.over),start=c.sent.find(m=>m.op==='newgame');
  await push(r,a,final);await push(r,a,start);
  assert.equal(a.messages.at(-1).op,'moveok');assert.equal(db.get('game').id,start.state.id);assert.equal(db.get('game').over,false);
});
