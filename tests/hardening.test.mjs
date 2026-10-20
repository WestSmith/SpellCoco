import test from 'node:test';import assert from 'node:assert/strict';import {client,state,room,plain} from './helpers.mjs';
const online=seat=>`NET.async=true;NET.mode="host";UI_MODE="host";NET.code=NET.gameCode="ROOM1";NET.myName=ONLINE_SIDE.type="${seat?'Shawn':'Keith'}";NET.seat=NET.myIndex=${seat};NET.rev=0;NET.caps={livesel:true};CONFIG.rounds=1;`;
const deliver=(c,m)=>{c.ctx.reply=plain(m);c.run('asyncOnMessage(reply)')};
const initial=()=>{const s={...state(),id:'match00002',turnIndex:1};[...'CAT'].forEach((ch,i)=>s.tiles[i].char=ch);return s};
for(const route of ['accepted-ledger','lost-ack-ledger','accepted-pending'])test(`a second tab's rematch must preserve the first tab's recoverable result: ${route}`,async()=>{
 const st=initial(),a=client(),b=client(),h=room(st);
 b.ctx.get=k=>a.saved.get(k)??null;b.ctx.put=(k,v)=>a.saved.set(k,v);b.ctx.del=k=>a.saved.delete(k);b.run('localStorage={getItem:get,setItem:put,removeItem:del}');
 a.load(st,online(1)+'buildTrie(["CAT"]);');b.load(st,online(0));
 for(const c of [a,b]){c.ctx.failLedger=route==='accepted-pending';c.run('console={...console,warn:()=>{}};originalSet=localStorage.setItem;localStorage.setItem=(k,v)=>{if(k==="spellcoco.stats"||(failLedger&&k.startsWith("spellcoco.endings.")))throw Error("quota");return originalSet(k,v)}')}
 a.run('game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()');const close=a.sent.find(m=>m.op==='move'&&m.state.over);
 await h.r.onMessage(h.sockets[1],JSON.stringify(close));if(route!=='lost-ack-ledger')deliver(a,h.sockets[1].messages.at(-1));deliver(b,h.sockets[0].messages.at(-1));
 assert.ok(a.saved.has(route==='accepted-pending'?'spellcoco.pending.ROOM1':'spellcoco.endings.ROOM1'));
 b.run('Math.random=()=>0.9;startRematch()');await h.r.onMessage(h.sockets[0],JSON.stringify(b.sent.find(m=>m.op==='newgame')));deliver(b,h.sockets[0].messages.at(-1));
 const f=client();for(const[k,v]of a.saved)f.saved.set(k,v);f.run(online(1)+'STATS=lsGet("spellcoco.stats",STATS);NET.ws={readyState:1,send:s=>sent.push(JSON.parse(s))}');await h.r.onHello(h.sockets[1],{name:'Shawn',dev:'b'});deliver(f,h.sockets[1].messages.at(-1));
 for(const m of f.sent.filter(m=>m.type==='__a')){await h.r.onMessage(h.sockets[1],JSON.stringify(m));deliver(f,h.sockets[1].messages.at(-1))}
 assert.equal(f.run('game.over'),false);assert.equal(f.run('STATS.games'),1);assert.equal(f.run('STATS.wins.Shawn'),1);
});
for(const replacement of [false,true])for(const method of ['tap','Escape'])test(`untagged dismissal survives interleaved personality speech, replacement=${replacement}, dismissal=${method}`,()=>{
 const c=client(),st=initial();c.load(st,online(0));
 c.run('clock=6700;Date.now=()=>clock;FX.overlayUntil=FX.loungeUntil=0;document.getElementById("coco-lounge").offsetParent={};document.getElementById("grid").childElementCount=25;asyncFx({type:"fx",bubble:"Independent speech",bubbleDelay:3400});clock=10000;asyncFx({type:"fx",toast:"CAT → +8 pts"});_cocoPump()');
 if(method==='tap')c.run('dismissCocoBubble()');else for(const f of c.events['document:keydown'])f({key:'Escape',preventDefault(){},stopPropagation(){}});
 assert.equal(c.run('COCO_SAY.showing'),false);
 c.run('clock+=100');c.fireDelay(3400); // an already-scheduled, independent personality line fires
 c.run('_cocoPump()');assert.equal(c.run('COCO_SAY.showing'),true);assert.match(c.els.get('coco-bubble').innerHTML,/Independent speech/);
 if(replacement){c.ctx.next=st;c.run('game=Game.fromState(next);game.activate()')}
 c.run('clock+=100;FX.overlayUntil=FX.loungeUntil=0;asyncFx({type:"fx",toast:"Best possible: 20 pts"})');
 assert.equal(c.run('COCO_SAY.q.some(b=>b.lines.some(l=>l.includes("Best possible")))'),false);
});

test('retiring one ending merges the other tab’s ledger and removes only the resolved pending copy',()=>{
 const c=client();c.load(initial(),online(1));
 c.run('first={type:"__a",op:"move",q:10,state:{...game.serialize(),over:true}};second={q:20,receipt:statsReceipt({...first.state,id:"othermatch"})};NET.endingMoves.set(10,first);lsSet("spellcoco.endings.ROOM1",[second]);lsSet(NET.pendKey(),{m:first,q:10});NET.retireEnding(10);NET.saveEndings()');
 assert.deepEqual(plain(c.run('[...NET.endingMoves.keys()]')),[20]);
 assert.deepEqual(JSON.parse(c.saved.get('spellcoco.endings.ROOM1')).map(m=>m.q),[20]);assert.equal(c.saved.has('spellcoco.pending.ROOM1'),false);
});

test('unreadable shared recovery records are preserved until they can be reconciled',()=>{
 const c=client();c.load(initial(),online(1));
 c.run('second={q:20,receipt:statsReceipt({...game.serialize(),over:true})};lsSet("spellcoco.endings.ROOM1",[second]);lsSet(NET.pendKey(),second);NET.pendingMove={m:{type:"__a",op:"move",q:30,state:game.serialize()},q:30}');
 const ledger=c.saved.get('spellcoco.endings.ROOM1'),pending=c.saved.get('spellcoco.pending.ROOM1');
 c.run('originalGet=localStorage.getItem;localStorage.getItem=()=>{throw Error("unavailable")};NET.clearPending();NET.savePending();NET.saveEndings();localStorage.getItem=originalGet');
 assert.equal(c.saved.get('spellcoco.endings.ROOM1'),ledger);assert.equal(c.saved.get('spellcoco.pending.ROOM1'),pending);
 c.run('NET.clearPending()');assert.equal(c.saved.has('spellcoco.pending.ROOM1'),false);assert.equal(JSON.parse(c.saved.get('spellcoco.endings.ROOM1'))[0].q,20);
});

test('legacy dismissal survives dismissing independent and tagged speech, then expires at 900ms',()=>{
 const c=client();c.load(initial());
 c.run('clock=10000;Date.now=()=>clock;FX.overlayUntil=FX.loungeUntil=0;cocoSay("Score");_cocoPump();dismissCocoBubble();clock+=100;cocoSpeak("Personality");_cocoPump()');
 assert.equal(c.run('COCO_SAY.showing'),true);c.run('dismissCocoBubble();clock+=100;cocoSay("Tagged score",false,"other:event");_cocoPump()');
 assert.equal(c.run('COCO_SAY.showing'),true);c.run('dismissCocoBubble();clock+=100;cocoSay("Legacy continuation");_cocoPump()');
 assert.equal(c.run('COCO_SAY.showing'),false);assert.equal(c.run('COCO_SAY.q.length'),0);
 c.run('clock=10900;cocoSay("Next score");_cocoPump()');assert.equal(c.run('COCO_SAY.showing'),true);
});
