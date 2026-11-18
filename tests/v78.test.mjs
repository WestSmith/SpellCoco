import test from 'node:test';
import assert from 'node:assert/strict';
import { client, flush } from './helpers.mjs';

// v78: no sound backlog after an iOS audio interruption; one purr at a time.
// A Web Audio double whose clock and state the test drives, like iOS does:
// while suspended or interrupted, currentTime stands still.
function audio(c, initial = 'suspended') {
  const made = [];
  c.ctx.window.AudioContext = class {
    constructor() { this.state = initial; this.currentTime = 0; this.destination = {}; this.started = []; this.pending = []; made.push(this); }
    resume() { return new Promise((ok, fail) => this.pending.push({ ok, fail })); }
    land(state = 'running') { this.state = state; this.pending.splice(0).forEach(p => p.ok()); }
    refuse() { this.pending.splice(0).forEach(p => p.fail(new Error('InvalidStateError'))); }
    param() { return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }; }
    createOscillator() { const ac = this; return { frequency: this.param(), connect() {}, start(t) { ac.started.push(t ?? ac.currentTime); }, stop() {} }; }
    createGain() { return { gain: this.param(), connect() {} }; }
    createBiquadFilter() { return { frequency: this.param(), Q: this.param(), connect() {} }; }
  };
  let now = 1e6;
  c.ctx.clock = () => now;
  c.run('Date.now=()=>clock()');
  return { made, ac: () => made.at(-1), advance(ms) { now += ms; } };
}

test('sounds asked for during an interruption are dropped, not replayed in a burst', async () => {
  const c = client(), a = audio(c);
  c.run('soundEnabled=true;initAudio()');
  a.ac().state = 'interrupted';                          // a phone call starts
  for (let i = 0; i < 6; i++) { c.run('SFX.tileSelect()'); a.advance(2000); }
  c.run('SFX.invalid();SFX.swap()');
  a.advance(5000);
  a.ac().land();                                          // the call ends; iOS resumes the context
  await flush();
  assert.equal(a.ac().started.length, 0, 'nothing queued up during the call plays afterwards');
  c.run('SFX.tileSelect()');
  assert.equal(a.ac().started.length, 1, 'the next sound plays normally');
});

test('the tap that unlocks audio still plays its own sound', async () => {
  const c = client(), a = audio(c);
  c.run('soundEnabled=true;initAudio();SFX.tileSelect()');
  assert.equal(a.ac().started.length, 0);
  a.advance(40); a.ac().land(); await flush();
  assert.equal(a.ac().started.length, 1);
});

test('a refused resume (still interrupted) is silent and harmless', async () => {
  const c = client(), a = audio(c, 'interrupted');
  c.run('soundEnabled=true;initAudio();SFX.submit();playPurr()');
  a.ac().refuse(); await flush();
  assert.equal(a.ac().started.length, 0);
  assert.equal(a.made.length, 1, 'the same context is reused');
});

test('any tap re-wakes audio after a call, not only the board', () => {
  const c = client(), a = audio(c);
  c.run('soundEnabled=true;initAudio()');
  a.ac().land(); a.ac().state = 'suspended';
  const before = a.ac().pending.length;
  c.events['document:touchend'].forEach(f => f({}));
  assert.equal(a.ac().pending.length, before + 1, 'resume() is asked inside the gesture');
  c.run('soundEnabled=false;audioCtx=null');
  c.events['document:click'].forEach(f => f({}));
  assert.equal(a.made.length, 1, 'sound off and no context yet: a tap creates nothing');
});

test('tapping Coco quickly gives one purr, not a stack of them', () => {
  const c = client(), a = audio(c, 'running');
  const coco = c.els.get('coco-lounge');
  for (let i = 0; i < 12; i++) coco.listeners.click.forEach(f => f({}));
  const voice = a.ac().started.length;
  assert.equal(voice, 4, 'two carriers and their two tremolo oscillators');
  c.run('playPurr();playPurr()');
  assert.equal(a.ac().started.length, voice, 'even a direct call waits for the current purr');
  a.ac().currentTime = 1.6; c.fireDelay(1500);
  coco.listeners.click.forEach(f => f({}));
  assert.equal(a.ac().started.length, voice * 2, 'once it ends, the next pet purrs again');
});

test('Join unlocks the first opponent tap and scored word before any board input', async () => {
  const c = client(), a = audio(c);
  c.doc.getElementById('sound-toggle').checked = true;
  c.events['document:DOMContentLoaded'].forEach(f => f());
  assert.equal(a.made.length, 0);
  c.events['document:click'].forEach(f => f({}));
  assert.equal(a.ac().pending.length, 1, 'the lobby gesture requested resume');
  a.ac().land(); await flush();
  c.run('NET.async=true; NET.mode="host"; NET.seat=1; NET.code="ROOM1"; asyncOnMessage({op:"newgame",state:inputState})');
  c.run('asyncOnData({type:"livesel",ids:[0],t:0,r:1})');
  assert.equal(a.ac().started.length, 1);
  c.run('asyncOnData({type:"livesel",ids:[0],t:0,r:1}); asyncOnData({type:"livesel",ids:[0,1],t:0,r:2})');
  assert.equal(a.ac().started.length, 1, 'duplicates and stale turns stay quiet');
  c.run('asyncOnData({type:"livesel",ids:[],t:0,r:1})');
  assert.equal(a.ac().started.length, 2);
  c.run('asyncOnData({type:"livesel",ids:[0,1,2],t:0,r:1})'); // a resync mid-word
  c.run('asyncFx({type:"fx",sfx:"submit"}); asyncOnData({type:"livesel",ids:[],t:0,r:1})');
  c.fireDelay(80); c.fireDelay(160);
  assert.equal(a.ac().started.length, 5, 'all three notes of the normal word chime played');
  c.run('toggleMute(); asyncOnData({type:"livesel",ids:[1],t:0,r:1}); asyncFx({type:"fx",sfx:"submit"})');
  c.fireDelay(80); c.fireDelay(160);
  assert.equal(a.ac().started.length, 5);
});

test('an auto-joined room offers a sound gesture while its context is suspended', () => {
  const c = client(), a = audio(c);
  c.doc.getElementById('sound-toggle').checked = true;
  c.run('NET.async=true; NET.mode="host"; NET.seat=1; NET.code="ROOM1"; asyncLoadGame(inputState)');
  const prompt = c.doc.getElementById('unlock-audio');
  assert.equal(prompt.classList.contains('hidden'), false);
  c.events['document:touchend'].forEach(f => f({}));
  a.ac().land(); a.ac().onstatechange();
  assert.equal(prompt.classList.contains('hidden'), true);
});

test('classic guests hear live host tile changes and skip restored selections', () => {
  const c = client(), a = audio(c, 'running');
  c.load(undefined, 'NET.mode="join"; NET.myIndex=1; soundEnabled=true; initAudio()');
  c.run('inputState.sel=[0]; guestOnData({type:"state",state:inputState}); guestOnData({type:"state",state:inputState})');
  assert.equal(a.ac().started.length, 1);
  c.run('inputState.sel=[0,1]; game.applyState(inputState)');
  assert.equal(a.ac().started.length, 1, 'a state restored outside a live move stays quiet');
  c.run('inputState.turnIndex=1; inputState.sel=[]; guestOnData({type:"state",state:inputState})');
  assert.equal(a.ac().started.length, 1, 'changing turns is not a tile tap');
});

test('a saved sound-off preference keeps joining and the opening move quiet', () => {
  const c = client(), a = audio(c);
  c.doc.getElementById('sound-toggle').checked = true;
  c.saved.set('spellcoco.settings', JSON.stringify({ sound: false }));
  c.events['document:DOMContentLoaded'].forEach(f => f());
  c.events['document:click'].forEach(f => f({}));
  c.run('NET.async=true; NET.mode="host"; NET.seat=1; NET.code="ROOM1"; asyncLoadGame(inputState)');
  c.run('asyncOnData({type:"livesel",ids:[0],t:0,r:1}); asyncFx({type:"fx",sfx:"submit"})');
  assert.equal(a.made.length, 0);
  assert.ok(c.doc.getElementById('unlock-audio').classList.contains('hidden'));
});
