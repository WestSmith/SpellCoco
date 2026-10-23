import test from 'node:test';
import assert from 'node:assert/strict';
import {client,state,room,plain,socket} from './helpers.mjs';

const online='NET.async=true;NET.mode="host";UI_MODE="host";NET.code="ROOM1";NET.myName="Shawn";NET.seat=1;NET.myIndex=1;NET.rev=0;NET.gameCode="ROOM1";NET.caps={livesel:true};';
const deliver=(c,m)=>{c.ctx.reply=plain(m);c.run('asyncOnMessage(reply)')};
const push=(h,m)=>h.r.onMessage(h.sockets[1],JSON.stringify(m));
function initial(kind='word',id='match00002'){
 const st={...state(),id,turnIndex:1};[...'CAT'].forEach((ch,i)=>st.tiles[i].char=ch);
 if(kind==='timeout'){st.cocoTimerActive=true;st.timeLeft=1}
 return st;
}
function closing(kind='word',id){
 const st=initial(kind,id),c=client();c.load(st,online+'CONFIG.rounds=1;buildTrie(["CAT"]);');return {st,c};
}
function finish(c,kind='word'){
 if(kind==='word')c.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');
 else{c.fire(c.run('game.timerInterval'));c.fireDelay(800)}
}
function quota(c,limit){
 c.ctx.entries=()=>[...c.saved];c.ctx.limit=limit;
 c.run(`console={...console,warn:()=>{}};const store=localStorage.setItem;localStorage.setItem=(k,v)=>{
 const total=entries().filter(([key])=>key!==k).reduce((n,[key,value])=>n+key.length+value.length,0)+k.length+v.length;
 if(total>limit)throw Error('QuotaExceededError');return store(k,v)}`);
}
function failStats(c,ledger=false){
 c.ctx.failLedger=ledger;c.run(`console={...console,warn:()=>{}};originalSet=localStorage.setItem;
 localStorage.setItem=(k,v)=>{if(k==='spellcoco.stats'||(failLedger&&k.startsWith('spellcoco.endings.')))throw Error('quota');return originalSet(k,v)}`);
}
function share(a,b){
 b.ctx.get=k=>a.saved.get(k)??null;b.ctx.put=(k,v)=>a.saved.set(k,v);b.ctx.del=k=>a.saved.delete(k);
 b.run('localStorage={getItem:get,setItem:put,removeItem:del};STATS=lsGet("spellcoco.stats",STATS)');
}
async function accept(c,h,offset=0){
 const n=h.sockets[1].messages.length;
 for(const m of c.sent.slice(offset).filter(m=>m.type==='__a'))await push(h,m);
 for(const m of h.sockets[1].messages.slice(n))deliver(c,m);
}
async function refresh(c,h,limit,fail=false){
 const f=client();for(const [k,v]of c.saved)f.saved.set(k,v);if(limit)quota(f,limit);if(fail)failStats(f,true);
 f.run(online+'STATS=lsGet("spellcoco.stats",STATS);NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');
 await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(f,h.sockets[1].messages.at(-1));
 await accept(f,h);return f;
}

for(const mode of ['old-client','new-stream','continued-stream'])test(`archived finished ID cannot restart via ${mode}`,async()=>{
 const st=initial(),h=room({...st,id:'previous00',over:true}),stream='a'.repeat(24);
 const ordered=mode==='old-client'?{}:{stream,base:0};
 const start={type:'__a',op:'newgame',state:st,q:1,...ordered};
 await push(h,start);await push(h,{type:'__a',op:'move',state:{...st,over:true},q:2,...ordered,base:1});
 const next={...st,id:'nextmatch1'};
 await push(h,{...start,state:next,q:3,base:2});
 await push(h,{type:'__a',op:'move',state:{...next,over:true},q:4,...ordered,base:3});
 assert.ok(h.db.has('finished.'+st.id));assert.equal(h.db.get('game').id,next.id);
 h.r=new h.r.constructor(h.r.state,{});const ws=socket(1,'Shawn');h.sockets.push(ws);
 const replay=mode==='old-client'?start:{...start,q:5,base:4,stream:mode==='new-stream'?'z'.repeat(24):stream};
 const before=plain([...h.db]),notifications=[];h.r.notifySeat=async(...args)=>notifications.push(args);
 await h.r.onMessage(ws,JSON.stringify(replay));
 assert.equal(ws.messages.at(-1).op,'reject');assert.deepEqual(plain([...h.db]),before);assert.equal(notifications.length,0);
 // A distinct rematch and its same-ID retry remain usable on this fresh socket.
 const fresh={...start,state:{...st,id:'freshmatch'},q:6,base:4};
 await h.r.onMessage(ws,JSON.stringify(fresh));await h.r.onMessage(ws,JSON.stringify(fresh));
 assert.equal(h.db.get('game').id,'freshmatch');assert.equal(h.db.get('game').over,false);assert.equal(await h.r.rev(),5);
});

for(const kind of ['word','timeout'])for(const limit of (kind==='word'?[2800,2825,2900,4306,5534]:[2700,2800,2900,4306,5534]))test(`accepted ${kind} survives quota ${limit} and paid rematch Swap`,async()=>{
 const {st,c}=closing(kind);quota(c,limit);finish(c,kind);assert.ok(c.saved.has('spellcoco.pending.ROOM1'));
 const h=room(st);await accept(c,h);assert.equal(c.run('STATS.games'),1);
 const offset=c.sent.length;c.run('Math.random=()=>0.9;startRematch();game.swapTargetId=0;game.performSwap("A")');
 await accept(c,h,offset);
 assert.equal(h.db.get('game').over,false);assert.equal(h.db.get('game').tiles[0].char,'A');
 const expected=plain(c.run('game.serialize()')),f=await refresh(c,h,limit);
 assert.equal(f.run('STATS.games'),1);assert.equal(f.run('game.over'),false);
 assert.deepEqual(plain(f.run('game.serialize()')).tiles,expected.tiles);
 assert.equal(f.run('game.players[1].gems'),expected.players[1].gems);
 assert.equal((await refresh(f,h)).run('STATS.games'),1);
});

test('compact accepted result remains durable when every ledger and stats write fails through refresh/rematch',async()=>{
 const {st,c}=closing();failStats(c,true);finish(c);const h=room(st);await accept(c,h);
 assert.ok(JSON.parse(c.saved.get('spellcoco.pending.ROOM1')).receipt);assert.equal(c.saved.has('spellcoco.endings.ROOM1'),false);
 const f=await refresh(c,h,0,true);assert.equal(f.run('STATS.games'),1);
 const offset=f.sent.length;f.run('Math.random=()=>0.9;startRematch();game.swapTargetId=0;game.performSwap("A")');
 const expected=plain(f.run('game.serialize()'));await accept(f,h,offset);
 assert.ok(JSON.parse(f.saved.get('spellcoco.pending.ROOM1')).receipt);
 const recovered=await refresh(f,h);assert.equal(recovered.run('STATS.games'),1);
 assert.equal(recovered.run('game.over'),false);assert.equal(recovered.run('game.tiles[0].char'),'A');
 assert.equal(recovered.run('game.players[1].gems'),expected.players[1].gems);assert.equal(recovered.run('NET.endingMoves.size'),0);
});

for(const outcomes of [['draw','draw'],['Keith','Keith'],['draw','Keith']])test(`sequential tabs add independent ${outcomes.join('/')} results after failed statistics write`,async()=>{
 const a=client(),b=client(),rooms=['ROOM1','ROOM2'].map((_,i)=>room(initial('timeout','match0000'+(i+2))));
 if(outcomes[0]==='Keith')rooms[0].db.get('game').players[0].score=10;
 if(outcomes[1]==='Keith')rooms[1].db.get('game').players[0].score=10;
 a.load(rooms[0].db.get('game'),online+'CONFIG.rounds=1;');finish(a,'timeout');failStats(a);await accept(a,rooms[0]);
 assert.equal(a.run('STATS.games'),1);share(a,b);
 b.load(rooms[1].db.get('game'),online+'NET.code=NET.gameCode="ROOM2";CONFIG.rounds=1;');finish(b,'timeout');await accept(b,rooms[1]);
 assert.equal(JSON.parse(a.saved.get('spellcoco.stats')).games,1);
 a.run('localStorage.setItem=originalSet');a.run('NET.resendPending();NET.resendPending()');
 const saved=JSON.parse(a.saved.get('spellcoco.stats'));
 assert.equal(saved.games,2);assert.equal(saved.draws,outcomes.filter(x=>x==='draw').length);
 assert.equal(saved.wins.Keith,outcomes.filter(x=>x==='Keith').length);
 assert.equal(saved.recordedGames.length,2);assert.equal(a.run('NET.endingMoves.size'),0);
 a.run('NET.resendPending()');assert.equal(a.run('STATS.games'),2);
});

test('another tab persisting the SAME result does not recount the failed local contribution',async()=>{
 const {st,c:a}=closing('timeout');finish(a,'timeout');failStats(a);const h=room(st);await accept(a,h);
 const b=client();share(a,b);b.run(online);b.ctx.ending=h.db.get('game');b.run('asyncShowEnding(ending)');
 a.run('localStorage.setItem=originalSet;NET.resendPending()');
 assert.equal(a.run('STATS.games'),1);assert.equal(JSON.parse(a.saved.get('spellcoco.stats')).games,1);
 assert.equal(a.run('NET.endingMoves.size'),0);
});

for(const via of ['mergeStats','recordGameStats'])test(`independent saved draw combines with unsaved local win before ${via}`,()=>{
 const c=client();c.run(online);failStats(c);
 c.run('recordStatsOnce([{name:"Keith",score:10},{name:"Shawn",score:0}],"firstmatch")');
 const other=client();share(c,other);other.run(online+'NET.code="ROOM2";recordStatsOnce([{name:"Keith",score:0},{name:"Shawn",score:0}],"othermatch")');
 c.run('localStorage.setItem=originalSet');
 if(via==='mergeStats')c.run('mergeStats({games:1,draws:1,wins:{Keith:0,Shawn:0}})');
 else c.run('recordGameStats([{name:"Coco",score:5,isCoco:true},{name:"Shawn",score:0}])');
 c.run('recordStatsOnce([{name:"Keith",score:10},{name:"Shawn",score:0}],"firstmatch")');
 assert.equal(c.run('STATS.games'),2);assert.equal(c.run('STATS.draws'),1);assert.equal(c.run('STATS.wins.Keith'),1);
 if(via==='recordGameStats')assert.equal(c.run('STATS.coco.games'),1);
});

for(const bad of [{},42,false,'bad',[null,{},1,'bad','spellcoco.gover.ROOM1.match00002']])for(const place of ['stored','memory','both'])test(`malformed receipts ${JSON.stringify(bad)} in ${place} allow start and accepted result`,()=>{
 const c=client();c.load(initial(),online);c.ctx.bad=bad;
 if(place!=='memory')c.run('lsSet("spellcoco.stats",{...STATS,recordedGames:bad})');
 if(place!=='stored')c.run('STATS.recordedGames=bad');
 assert.doesNotThrow(()=>c.run('NET.sendStart()'));assert.ok(c.sent.some(m=>m.op==='newgame'));
 c.run('recordStatsOnce([{name:"Keith",score:0},{name:"Shawn",score:0}],"newresult1");recordStatsOnce([{name:"Keith",score:0},{name:"Shawn",score:0}],"newresult1")');
 assert.equal(c.run('STATS.games'),1);
 const receipts=plain(c.run('STATS.recordedGames'));
 assert.ok(receipts.includes('spellcoco.gover.ROOM1.newresult1'));assert.ok(receipts.every(x=>typeof x==='string'&&x.startsWith('spellcoco.gover.')));
});

for(const longer of [false,true])test(`compact recovery preserves best/longest word ordering, longer=${longer}`,async()=>{
 const {st,c}=closing('timeout');st.players[0].wordsPlayed=[{word:'CAT',score:1},{word:'DOG',score:9},...(longer?[{word:'TREE',score:2},{word:'BIRD',score:3}]:[])];
 c.load(st,online+'CONFIG.rounds=1;');failStats(c,true);finish(c,'timeout');const h=room(st);await accept(c,h);
 const f=await refresh(c,h);
 assert.equal(f.run('STATS.bestWord.word'),'DOG');assert.equal(f.run('STATS.longestWord.word'),longer?'TREE':'CAT');
 assert.equal(f.run('STATS.games'),1);
});

test('id-less cached matches still count a rematch when the previous statistics write failed',()=>{
 const c=client();c.load(state(),online);failStats(c);
 c.run('recordStatsOnce(game.players,null)');assert.equal(c.run('STATS.games'),1);
 c.ctx.next=state();c.run('asyncLoadGame(next);recordStatsOnce(game.players,null)');
 assert.equal(c.run('STATS.games'),2);
 c.run('localStorage.setItem=originalSet;recordStatsOnce(game.players,null)');
 assert.equal(JSON.parse(c.saved.get('spellcoco.stats')).games,2);
});

test('retiring a compact result restores durability to a newer unacknowledged Swap',async()=>{
 const {st,c}=closing();failStats(c,true);finish(c);const h=room(st);await accept(c,h);
 const offset=c.sent.length;c.run('Math.random=()=>0.9;startRematch();game.swapTargetId=0;game.performSwap("A")');
 const start=c.sent.slice(offset).find(m=>m.op==='newgame'),swap=c.sent.slice(offset).find(m=>m.op==='move');
 await push(h,start);deliver(c,h.sockets[1].messages.at(-1));assert.equal(c.run('NET.pendingStart'),null);
 c.run('localStorage.setItem=(k,v)=>{if(k.startsWith("spellcoco.endings."))throw Error("quota");return originalSet(k,v)};NET.resendEndings()');
 assert.equal(JSON.parse(c.saved.get('spellcoco.pending.ROOM1')).q,swap.q);
 const f=await refresh(c,h);assert.equal(f.run('STATS.games'),1);assert.equal(f.run('game.tiles[0].char'),'A');
 assert.equal(h.db.get('game').tiles[0].char,'A');
});

test('a late ending acceptance frees quota for a rematch Swap before its acknowledgement',async()=>{
 const {st,c}=closing();quota(c,2800);finish(c);const ending=c.sent.find(m=>m.op==='move'&&m.state.over);
 const offset=c.sent.length;c.run('Math.random=()=>0.9;startRematch();game.swapTargetId=0;game.performSwap("A")');
 const start=c.sent.slice(offset).find(m=>m.op==='newgame'),swap=c.sent.slice(offset).find(m=>m.op==='move'),h=room(st);
 await push(h,ending);const ack=h.sockets[1].messages.at(-1);
 await push(h,start);deliver(c,h.sockets[1].messages.at(-1));deliver(c,ack);
 const pending=JSON.parse(c.saved.get('spellcoco.pending.ROOM1'));assert.equal(pending.q,swap.q);
 const f=await refresh(c,h,2800);assert.equal(f.run('STATS.games'),1);assert.equal(f.run('game.tiles[0].char'),'A');
 assert.equal(h.db.get('game').tiles[0].char,'A');
});

test('temporary read failures cannot hide the sole result from rematch pending-slot replacement',async()=>{
 const {st,c}=closing();failStats(c,true);finish(c);const h=room(st);await accept(c,h);
 c.run('originalGet=localStorage.getItem;localStorage.getItem=()=>{throw Error("storage unavailable")}');
 const offset=c.sent.length;c.run('Math.random=()=>0.9;startRematch();game.swapTargetId=0;game.performSwap("A")');await accept(c,h,offset);
 c.run('localStorage.getItem=originalGet');
 const f=await refresh(c,h);assert.equal(f.run('STATS.games'),1);assert.equal(f.run('game.tiles[0].char'),'A');
});
